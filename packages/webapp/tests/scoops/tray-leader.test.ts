import { describe, expect, it, vi } from 'vitest';

import {
  LeaderTrayManager,
  createTrayFetch,
  getLeaderTrayRuntimeStatus,
  parseLeaderTraySession,
  type LeaderTraySession,
  type LeaderTraySessionStore,
  type LeaderTrayWebSocket,
} from '../../src/scoops/tray-leader.js';

class MemorySessionStore implements LeaderTraySessionStore {
  value: LeaderTraySession | null = null;

  async load(): Promise<LeaderTraySession | null> {
    return this.value;
  }

  async save(session: LeaderTraySession): Promise<void> {
    this.value = session;
  }

  async clear(): Promise<void> {
    this.value = null;
  }
}

class FakeWebSocket implements LeaderTrayWebSocket {
  readonly sent: string[] = [];
  closeCalls = 0;
  private readonly listeners = new Map<string, Array<(event: { data?: unknown }) => void>>();

  addEventListener(
    type: 'open' | 'message' | 'close' | 'error',
    listener: (event: { data?: unknown }) => void
  ): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closeCalls += 1;
    this.dispatch('close', {});
  }

  dispatch(type: 'open' | 'message' | 'close' | 'error', event: { data?: unknown }): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

describe('tray-leader', () => {
  it('parses persisted sessions and rejects malformed payloads', () => {
    expect(
      parseLeaderTraySession(
        JSON.stringify({
          workerBaseUrl: 'https://tray.example.com',
          trayId: 'tray-1',
          createdAt: '2026-01-01T00:00:00.000Z',
          controllerId: 'controller-1',
          controllerUrl: 'https://tray.example.com/controller/token',
          joinUrl: 'https://tray.example.com/join/token',
          webhookUrl: 'https://tray.example.com/webhook/token',
          runtime: 'slicc-standalone',
        })
      )?.trayId
    ).toBe('tray-1');
    expect(parseLeaderTraySession('{')).toBeNull();
    expect(parseLeaderTraySession(JSON.stringify({ trayId: 'missing-fields' }))).toBeNull();
  });

  it('creates a tray, claims the controller capability, and opens the leader websocket', async () => {
    const store = new MemorySessionStore();
    const socket = new FakeWebSocket();
    let resolveSocketReady!: () => void;
    const socketReady = new Promise<void>((resolve) => {
      resolveSocketReady = resolve;
    });
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            trayId: 'tray-1',
            createdAt: '2026-03-11T00:00:00.000Z',
            capabilities: {
              join: { url: 'https://tray.example.com/join/token' },
              controller: { url: 'https://tray.example.com/controller/token' },
              webhook: { url: 'https://tray.example.com/webhook/token' },
            },
          }),
          { status: 201, headers: { 'content-type': 'application/json' } }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            trayId: 'tray-1',
            controllerId: 'controller-1',
            role: 'leader',
            leaderKey: 'leader-key-1',
            websocket: {
              url: 'wss://tray.example.com/controller/token?controllerId=controller-1&leaderKey=leader-key-1',
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      );

    const manager = new LeaderTrayManager({
      workerBaseUrl: 'https://tray.example.com',
      runtime: 'slicc-standalone',
      store,
      fetchImpl,
      webSocketFactory: () => {
        resolveSocketReady();
        return socket;
      },
      pingIntervalMs: 60_000,
    });
    const startPromise = manager.start();

    await socketReady;
    socket.dispatch('message', {
      data: JSON.stringify({ type: 'leader.connected', trayId: 'tray-1' }),
    });
    const session = await startPromise;

    expect(session.trayId).toBe('tray-1');
    expect(session.leaderKey).toBe('leader-key-1');
    expect(store.value?.leaderWebSocketUrl).toContain('leaderKey=leader-key-1');
    expect(socket.sent[0]).toBe(JSON.stringify({ type: 'ping' }));
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(getLeaderTrayRuntimeStatus()).toMatchObject({
      state: 'leader',
      session: { trayId: 'tray-1', workerBaseUrl: 'https://tray.example.com' },
      error: null,
    });

    manager.stop();
    expect(getLeaderTrayRuntimeStatus()).toEqual({ state: 'inactive', session: null, error: null });
  });

  it('surfaces follower bootstrap control messages and can send bootstrap replies', async () => {
    const store = new MemorySessionStore();
    const socket = new FakeWebSocket();
    const received: Array<Record<string, unknown>> = [];
    let resolveSocketReady!: () => void;
    const socketReady = new Promise<void>((resolve) => {
      resolveSocketReady = resolve;
    });
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            trayId: 'tray-1',
            createdAt: '2026-03-11T00:00:00.000Z',
            capabilities: {
              join: { url: 'https://tray.example.com/join/token' },
              controller: { url: 'https://tray.example.com/controller/token' },
              webhook: { url: 'https://tray.example.com/webhook/token' },
            },
          }),
          { status: 201, headers: { 'content-type': 'application/json' } }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            trayId: 'tray-1',
            controllerId: 'controller-1',
            role: 'leader',
            leaderKey: 'leader-key-1',
            websocket: {
              url: 'wss://tray.example.com/controller/token?controllerId=controller-1&leaderKey=leader-key-1',
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      );

    const manager = new LeaderTrayManager({
      workerBaseUrl: 'https://tray.example.com',
      runtime: 'slicc-standalone',
      store,
      fetchImpl,
      onControlMessage: (message) => received.push(message as Record<string, unknown>),
      webSocketFactory: () => {
        resolveSocketReady();
        return socket;
      },
      pingIntervalMs: 60_000,
    });

    const startPromise = manager.start();
    await socketReady;
    socket.dispatch('message', {
      data: JSON.stringify({ type: 'leader.connected', trayId: 'tray-1' }),
    });
    await startPromise;

    socket.dispatch('message', {
      data: JSON.stringify({
        type: 'follower.join_requested',
        trayId: 'tray-1',
        controllerId: 'follower-1',
        bootstrapId: 'bootstrap-1',
        attempt: 1,
        expiresAt: '2026-03-11T00:00:20.000Z',
      }),
    });

    expect(received).toEqual([
      expect.objectContaining({
        type: 'follower.join_requested',
        controllerId: 'follower-1',
        bootstrapId: 'bootstrap-1',
      }),
    ]);

    manager.sendControlMessage({
      type: 'bootstrap.offer',
      controllerId: 'follower-1',
      bootstrapId: 'bootstrap-1',
      offer: { type: 'offer', sdp: 'v=0' },
    });

    expect(socket.sent).toContain(
      JSON.stringify({
        type: 'bootstrap.offer',
        controllerId: 'follower-1',
        bootstrapId: 'bootstrap-1',
        offer: { type: 'offer', sdp: 'v=0' },
      })
    );

    manager.stop();
  });

  it('recreates the tray when the persisted controller capability is stale', async () => {
    const store = new MemorySessionStore();
    store.value = {
      workerBaseUrl: 'https://tray.example.com',
      trayId: 'stale-tray',
      createdAt: '2026-03-11T00:00:00.000Z',
      controllerId: 'controller-1',
      controllerUrl: 'https://tray.example.com/controller/stale-token',
      joinUrl: 'https://tray.example.com/join/stale-token',
      webhookUrl: 'https://tray.example.com/webhook/stale-token',
      leaderKey: 'old-key',
      leaderWebSocketUrl:
        'wss://tray.example.com/controller/stale-token?controllerId=controller-1&leaderKey=old-key',
      runtime: 'slicc-standalone',
    };

    const socket = new FakeWebSocket();
    let resolveSocketReady!: () => void;
    const socketReady = new Promise<void>((resolve) => {
      resolveSocketReady = resolve;
    });
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'Tray expired', code: 'TRAY_EXPIRED' }), {
          status: 410,
          headers: { 'content-type': 'application/json' },
        })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            trayId: 'fresh-tray',
            createdAt: '2026-03-11T00:01:00.000Z',
            capabilities: {
              join: { url: 'https://tray.example.com/join/fresh-token' },
              controller: { url: 'https://tray.example.com/controller/fresh-token' },
              webhook: { url: 'https://tray.example.com/webhook/fresh-token' },
            },
          }),
          { status: 201, headers: { 'content-type': 'application/json' } }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            trayId: 'fresh-tray',
            controllerId: 'controller-2',
            role: 'leader',
            leaderKey: 'fresh-key',
            websocket: {
              url: 'wss://tray.example.com/controller/fresh-token?controllerId=controller-2&leaderKey=fresh-key',
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      );

    const manager = new LeaderTrayManager({
      workerBaseUrl: 'https://tray.example.com',
      runtime: 'slicc-standalone',
      store,
      fetchImpl,
      webSocketFactory: () => {
        resolveSocketReady();
        return socket;
      },
      pingIntervalMs: 60_000,
    });
    const startPromise = manager.start();

    await socketReady;
    socket.dispatch('message', {
      data: JSON.stringify({ type: 'leader.connected', trayId: 'fresh-tray' }),
    });
    const session = await startPromise;

    expect(session.trayId).toBe('fresh-tray');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(store.value?.controllerUrl).toBe('https://tray.example.com/controller/fresh-token');

    manager.stop();
  });

  it('fails leader startup when the websocket never confirms leader.connected', async () => {
    vi.useFakeTimers();
    try {
      const store = new MemorySessionStore();
      const socket = new FakeWebSocket();
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              trayId: 'tray-1',
              createdAt: '2026-03-11T00:00:00.000Z',
              capabilities: {
                join: { url: 'https://tray.example.com/join/token' },
                controller: { url: 'https://tray.example.com/controller/token' },
                webhook: { url: 'https://tray.example.com/webhook/token' },
              },
            }),
            { status: 201, headers: { 'content-type': 'application/json' } }
          )
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              trayId: 'tray-1',
              controllerId: 'controller-1',
              role: 'leader',
              leaderKey: 'leader-key-1',
              websocket: {
                url: 'wss://tray.example.com/controller/token?controllerId=controller-1&leaderKey=leader-key-1',
              },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          )
        );

      const manager = new LeaderTrayManager({
        workerBaseUrl: 'https://tray.example.com',
        runtime: 'slicc-standalone',
        store,
        fetchImpl,
        webSocketFactory: () => socket,
        pingIntervalMs: 60_000,
        connectTimeoutMs: 5_000,
      });

      const startPromise = manager.start();
      const startRejection = expect(startPromise).rejects.toThrow(
        'Tray leader WebSocket timed out after 5000ms waiting for leader.connected'
      );
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(5_000);

      await startRejection;
      expect(socket.closeCalls).toBe(1);
      expect(getLeaderTrayRuntimeStatus()).toMatchObject({
        state: 'error',
        session: { trayId: 'tray-1', workerBaseUrl: 'https://tray.example.com' },
        error: expect.stringContaining('timed out after 5000ms'),
      });

      manager.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('produces a different join URL after stop → clearSession → start (host reset)', async () => {
    const store = new MemorySessionStore();
    let socketIndex = 0;
    const sockets: FakeWebSocket[] = [];
    const socketReadyPromises: Array<{ promise: Promise<void>; resolve: () => void }> = [];
    for (let i = 0; i < 2; i++) {
      let resolve!: () => void;
      const promise = new Promise<void>((r) => {
        resolve = r;
      });
      socketReadyPromises.push({ promise, resolve });
    }

    const fetchImpl = vi
      .fn<typeof fetch>()
      // First start: create tray + attach
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            trayId: 'tray-1',
            createdAt: '2026-03-11T00:00:00.000Z',
            capabilities: {
              join: { url: 'https://tray.example.com/join/token-1' },
              controller: { url: 'https://tray.example.com/controller/token-1' },
              webhook: { url: 'https://tray.example.com/webhook/token-1' },
            },
          }),
          { status: 201, headers: { 'content-type': 'application/json' } }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            trayId: 'tray-1',
            controllerId: 'controller-1',
            role: 'leader',
            leaderKey: 'leader-key-1',
            websocket: { url: 'wss://tray.example.com/ws/1' },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      )
      // Second start (after reset): create tray + attach
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            trayId: 'tray-2',
            createdAt: '2026-03-11T00:01:00.000Z',
            capabilities: {
              join: { url: 'https://tray.example.com/join/token-2' },
              controller: { url: 'https://tray.example.com/controller/token-2' },
              webhook: { url: 'https://tray.example.com/webhook/token-2' },
            },
          }),
          { status: 201, headers: { 'content-type': 'application/json' } }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            trayId: 'tray-2',
            controllerId: 'controller-2',
            role: 'leader',
            leaderKey: 'leader-key-2',
            websocket: { url: 'wss://tray.example.com/ws/2' },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      );

    const manager = new LeaderTrayManager({
      workerBaseUrl: 'https://tray.example.com',
      runtime: 'slicc-standalone',
      store,
      fetchImpl,
      webSocketFactory: () => {
        const s = new FakeWebSocket();
        sockets.push(s);
        socketReadyPromises[socketIndex].resolve();
        socketIndex++;
        return s;
      },
      pingIntervalMs: 60_000,
    });

    // First start
    const startPromise1 = manager.start();
    await socketReadyPromises[0].promise;
    sockets[0].dispatch('message', {
      data: JSON.stringify({ type: 'leader.connected', trayId: 'tray-1' }),
    });
    const session1 = await startPromise1;
    expect(session1.joinUrl).toBe('https://tray.example.com/join/token-1');

    // Simulate host reset: stop → clearSession → start
    manager.stop();
    await manager.clearSession();
    expect(await store.load()).toBeNull();

    const startPromise2 = manager.start();
    await socketReadyPromises[1].promise;
    sockets[1].dispatch('message', {
      data: JSON.stringify({ type: 'leader.connected', trayId: 'tray-2' }),
    });
    const session2 = await startPromise2;

    expect(session2.joinUrl).toBe('https://tray.example.com/join/token-2');
    expect(session2.joinUrl).not.toBe(session1.joinUrl);
    expect(session2.trayId).toBe('tray-2');
    expect(fetchImpl).toHaveBeenCalledTimes(4);

    manager.stop();
  });

  it('auto-reconnects after the leader WebSocket closes unexpectedly', async () => {
    const store = new MemorySessionStore();
    const sockets: FakeWebSocket[] = [];
    const socketReadyPromises: Array<{ promise: Promise<void>; resolve: () => void }> = [];
    for (let i = 0; i < 2; i++) {
      let resolve!: () => void;
      const promise = new Promise<void>((r) => {
        resolve = r;
      });
      socketReadyPromises.push({ promise, resolve });
    }

    // Pre-seed the store so the manager re-attaches without recreating the tray.
    store.value = {
      workerBaseUrl: 'https://tray.example.com',
      trayId: 'tray-1',
      createdAt: '2026-03-11T00:00:00.000Z',
      controllerId: 'controller-1',
      controllerUrl: 'https://tray.example.com/controller/token',
      joinUrl: 'https://tray.example.com/join/token',
      webhookUrl: 'https://tray.example.com/webhook/token',
      leaderKey: 'leader-key-1',
      leaderWebSocketUrl: 'wss://tray.example.com/ws/1',
      runtime: 'slicc-standalone',
    };

    const fetchImpl = vi
      .fn<typeof fetch>()
      // Initial attach
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            trayId: 'tray-1',
            controllerId: 'controller-1',
            role: 'leader',
            leaderKey: 'leader-key-1',
            websocket: { url: 'wss://tray.example.com/ws/1' },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      )
      // Reconnect attach
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            trayId: 'tray-1',
            controllerId: 'controller-1',
            role: 'leader',
            leaderKey: 'leader-key-1',
            websocket: { url: 'wss://tray.example.com/ws/2' },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      );

    const onReconnecting = vi.fn();
    const onReconnected = vi.fn();
    let socketIndex = 0;

    const manager = new LeaderTrayManager({
      workerBaseUrl: 'https://tray.example.com',
      runtime: 'slicc-standalone',
      store,
      fetchImpl,
      webSocketFactory: () => {
        const s = new FakeWebSocket();
        sockets.push(s);
        socketReadyPromises[socketIndex].resolve();
        socketIndex++;
        return s;
      },
      pingIntervalMs: 60_000,
      reconnect: { sleep: () => Promise.resolve(), baseDelayMs: 1, maxDelayMs: 1 },
      onReconnecting,
      onReconnected,
    });

    const startPromise = manager.start();
    await socketReadyPromises[0].promise;
    sockets[0].dispatch('message', {
      data: JSON.stringify({ type: 'leader.connected', trayId: 'tray-1' }),
    });
    const session1 = await startPromise;
    expect(session1.trayId).toBe('tray-1');

    // Simulate the leader tab being woken back up: the WebSocket dies.
    sockets[0].dispatch('close', {});

    // Yield to the microtask queue so the reconnect loop can run.
    await socketReadyPromises[1].promise;
    sockets[1].dispatch('message', {
      data: JSON.stringify({ type: 'leader.connected', trayId: 'tray-1' }),
    });

    // Wait for the reconnect to complete (callback is invoked at end of connectOnce).
    await vi.waitFor(() => {
      expect(onReconnected).toHaveBeenCalledTimes(1);
    });

    expect(onReconnecting).toHaveBeenCalledWith(1, expect.any(String));
    expect(getLeaderTrayRuntimeStatus()).toMatchObject({ state: 'leader' });
    expect(sockets).toHaveLength(2);

    manager.stop();
  });

  it('gives up reconnect after maxAttempts and surfaces the error', async () => {
    const store = new MemorySessionStore();
    store.value = {
      workerBaseUrl: 'https://tray.example.com',
      trayId: 'tray-1',
      createdAt: '2026-03-11T00:00:00.000Z',
      controllerId: 'controller-1',
      controllerUrl: 'https://tray.example.com/controller/token',
      joinUrl: 'https://tray.example.com/join/token',
      webhookUrl: 'https://tray.example.com/webhook/token',
      leaderKey: 'leader-key-1',
      leaderWebSocketUrl: 'wss://tray.example.com/ws/1',
      runtime: 'slicc-standalone',
    };

    // First fetch: initial attach. Subsequent fetches: always reject (reconnect attempts fail).
    let callCount = 0;
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return new Response(
          JSON.stringify({
            trayId: 'tray-1',
            controllerId: 'controller-1',
            role: 'leader',
            leaderKey: 'leader-key-1',
            websocket: { url: 'wss://tray.example.com/ws/1' },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      throw new Error('network down');
    });

    const onReconnectGaveUp = vi.fn();
    const sockets: FakeWebSocket[] = [];
    let resolveFirstReady!: () => void;
    const firstReady = new Promise<void>((r) => {
      resolveFirstReady = r;
    });

    const manager = new LeaderTrayManager({
      workerBaseUrl: 'https://tray.example.com',
      runtime: 'slicc-standalone',
      store,
      fetchImpl,
      webSocketFactory: () => {
        const s = new FakeWebSocket();
        sockets.push(s);
        if (sockets.length === 1) resolveFirstReady();
        return s;
      },
      pingIntervalMs: 60_000,
      reconnect: {
        sleep: () => new Promise<void>((resolve) => setTimeout(resolve, 0)),
        maxAttempts: 3,
        baseDelayMs: 1,
        maxDelayMs: 1,
      },
      onReconnectGaveUp,
    });

    const startPromise = manager.start();
    await firstReady;
    sockets[0].dispatch('message', {
      data: JSON.stringify({ type: 'leader.connected', trayId: 'tray-1' }),
    });
    await startPromise;

    sockets[0].dispatch('close', {});

    await vi.waitFor(() => {
      expect(onReconnectGaveUp).toHaveBeenCalledTimes(1);
    });

    expect(onReconnectGaveUp).toHaveBeenCalledWith(expect.any(String), 3);
    expect(getLeaderTrayRuntimeStatus()).toMatchObject({
      state: 'error',
      error: expect.stringContaining('Leader reconnect failed after 3 attempts'),
    });

    manager.stop();
  });

  it('does not reconnect after stop() is called explicitly', async () => {
    const store = new MemorySessionStore();
    store.value = {
      workerBaseUrl: 'https://tray.example.com',
      trayId: 'tray-1',
      createdAt: '2026-03-11T00:00:00.000Z',
      controllerId: 'controller-1',
      controllerUrl: 'https://tray.example.com/controller/token',
      joinUrl: 'https://tray.example.com/join/token',
      webhookUrl: 'https://tray.example.com/webhook/token',
      leaderKey: 'leader-key-1',
      leaderWebSocketUrl: 'wss://tray.example.com/ws/1',
      runtime: 'slicc-standalone',
    };

    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          trayId: 'tray-1',
          controllerId: 'controller-1',
          role: 'leader',
          leaderKey: 'leader-key-1',
          websocket: { url: 'wss://tray.example.com/ws/1' },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );

    const onReconnecting = vi.fn();
    const sockets: FakeWebSocket[] = [];
    let resolveReady!: () => void;
    const ready = new Promise<void>((r) => {
      resolveReady = r;
    });

    const manager = new LeaderTrayManager({
      workerBaseUrl: 'https://tray.example.com',
      runtime: 'slicc-standalone',
      store,
      fetchImpl,
      webSocketFactory: () => {
        const s = new FakeWebSocket();
        sockets.push(s);
        if (sockets.length === 1) resolveReady();
        return s;
      },
      pingIntervalMs: 60_000,
      reconnect: { sleep: () => Promise.resolve(), baseDelayMs: 1, maxDelayMs: 1 },
      onReconnecting,
    });

    const startPromise = manager.start();
    await ready;
    sockets[0].dispatch('message', {
      data: JSON.stringify({ type: 'leader.connected', trayId: 'tray-1' }),
    });
    await startPromise;

    manager.stop();
    sockets[0].dispatch('close', {}); // would normally trigger reconnect

    // Wait a tick to give any errant reconnect a chance to fire.
    await Promise.resolve();
    await Promise.resolve();

    expect(onReconnecting).not.toHaveBeenCalled();
    expect(sockets).toHaveLength(1);
    expect(getLeaderTrayRuntimeStatus()).toEqual({
      state: 'inactive',
      session: null,
      error: null,
    });
  });

  it('respects reconnect: false to disable auto-reconnect', async () => {
    const store = new MemorySessionStore();
    store.value = {
      workerBaseUrl: 'https://tray.example.com',
      trayId: 'tray-1',
      createdAt: '2026-03-11T00:00:00.000Z',
      controllerId: 'controller-1',
      controllerUrl: 'https://tray.example.com/controller/token',
      joinUrl: 'https://tray.example.com/join/token',
      webhookUrl: 'https://tray.example.com/webhook/token',
      leaderKey: 'leader-key-1',
      leaderWebSocketUrl: 'wss://tray.example.com/ws/1',
      runtime: 'slicc-standalone',
    };

    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          trayId: 'tray-1',
          controllerId: 'controller-1',
          role: 'leader',
          leaderKey: 'leader-key-1',
          websocket: { url: 'wss://tray.example.com/ws/1' },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );

    const sockets: FakeWebSocket[] = [];
    let resolveReady!: () => void;
    const ready = new Promise<void>((r) => {
      resolveReady = r;
    });
    const onReconnecting = vi.fn();

    const manager = new LeaderTrayManager({
      workerBaseUrl: 'https://tray.example.com',
      runtime: 'slicc-standalone',
      store,
      fetchImpl,
      webSocketFactory: () => {
        const s = new FakeWebSocket();
        sockets.push(s);
        resolveReady();
        return s;
      },
      pingIntervalMs: 60_000,
      reconnect: false,
      onReconnecting,
    });

    const startPromise = manager.start();
    await ready;
    sockets[0].dispatch('message', {
      data: JSON.stringify({ type: 'leader.connected', trayId: 'tray-1' }),
    });
    await startPromise;

    sockets[0].dispatch('close', {});
    await Promise.resolve();

    expect(onReconnecting).not.toHaveBeenCalled();
    expect(sockets).toHaveLength(1);
    expect(getLeaderTrayRuntimeStatus()).toMatchObject({
      state: 'error',
      error: expect.stringContaining('Leader WebSocket dropped'),
    });
    // Regression: tearDownSocket calling socket.close() must NOT re-enter
    // the close handler in an unbounded loop (FakeWebSocket dispatches
    // 'close' synchronously from close()).
    expect(sockets[0].closeCalls).toBeLessThanOrEqual(2);

    manager.stop();
  });

  it('does not re-enter the close handler when teardown synchronously dispatches close', async () => {
    // Regression test for re-entrant close: when reconnect is disabled and
    // tearDownSocket() invokes socket.close(), some socket implementations
    // synchronously fire the close event. The ping-loop close listener must
    // not re-run handleUnexpectedDisconnect's branch and recurse.
    const store = new MemorySessionStore();
    store.value = {
      workerBaseUrl: 'https://tray.example.com',
      trayId: 'tray-1',
      createdAt: '2026-03-11T00:00:00.000Z',
      controllerId: 'controller-1',
      controllerUrl: 'https://tray.example.com/controller/token',
      joinUrl: 'https://tray.example.com/join/token',
      webhookUrl: 'https://tray.example.com/webhook/token',
      leaderKey: 'leader-key-1',
      leaderWebSocketUrl: 'wss://tray.example.com/ws/1',
      runtime: 'slicc-standalone',
    };

    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          trayId: 'tray-1',
          controllerId: 'controller-1',
          role: 'leader',
          leaderKey: 'leader-key-1',
          websocket: { url: 'wss://tray.example.com/ws/1' },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );

    const sockets: FakeWebSocket[] = [];
    let resolveReady!: () => void;
    const ready = new Promise<void>((r) => {
      resolveReady = r;
    });

    const manager = new LeaderTrayManager({
      workerBaseUrl: 'https://tray.example.com',
      runtime: 'slicc-standalone',
      store,
      fetchImpl,
      webSocketFactory: () => {
        const s = new FakeWebSocket();
        sockets.push(s);
        resolveReady();
        return s;
      },
      pingIntervalMs: 60_000,
      reconnect: false,
    });

    const startPromise = manager.start();
    await ready;
    sockets[0].dispatch('message', {
      data: JSON.stringify({ type: 'leader.connected', trayId: 'tray-1' }),
    });
    await startPromise;

    // Triggering close should run cleanup exactly once: the manual dispatch
    // here calls listeners (no extra closeCalls), and tearDownSocket nulls
    // this.socket BEFORE invoking socket.close() so the synchronous
    // re-dispatch is filtered by the listener's `this.socket !== socket`
    // guard (no recursion, no further closeCalls).
    sockets[0].dispatch('close', {});
    expect(sockets[0].closeCalls).toBe(1);

    manager.stop();
  });
});

describe('createTrayFetch', () => {
  // Browsers reject `fetch` calls whose `this` is not the global Window /
  // WorkerGlobalScope, throwing "Illegal invocation". The leader stores the
  // returned function on `this.fetchImpl` and invokes it as a method, so
  // returning a bare reference to `fetch` would rebind `this` to the
  // LeaderTrayManager and break every request. The wrappers below assert that
  // the returned function tolerates an arbitrary `this` for both the
  // extension and standalone branches.
  const stubChromeRuntime = (mode: 'extension' | 'standalone') => {
    const original = (globalThis as { chrome?: unknown }).chrome;
    if (mode === 'extension') {
      (globalThis as { chrome?: unknown }).chrome = { runtime: { id: 'test' } };
    } else {
      delete (globalThis as { chrome?: unknown }).chrome;
    }
    return () => {
      if (original === undefined) {
        delete (globalThis as { chrome?: unknown }).chrome;
      } else {
        (globalThis as { chrome?: unknown }).chrome = original;
      }
    };
  };

  it('preserves the underlying fetch when invoked as a method (extension branch)', async () => {
    const restore = stubChromeRuntime('extension');
    try {
      const inner = vi.fn<typeof fetch>().mockResolvedValue(new Response('ok'));
      const wrapped = createTrayFetch(inner);
      const holder = { call: wrapped };
      await expect(holder.call('https://example.com/x')).resolves.toBeInstanceOf(Response);
      expect(inner).toHaveBeenCalledTimes(1);
      expect(inner.mock.calls[0]?.[0]).toBe('https://example.com/x');
    } finally {
      restore();
    }
  });

  it('routes cross-origin requests through the fetch proxy in non-extension mode', async () => {
    const restore = stubChromeRuntime('standalone');
    try {
      // Non-extension branch already wraps fetch in an arrow, so this case
      // existed pre-fix; included to lock in the existing behavior alongside
      // the new method-call invariant above.
      const inner = vi.fn<typeof fetch>().mockResolvedValue(new Response('ok'));
      const wrapped = createTrayFetch(inner);
      const holder = { call: wrapped };
      await expect(holder.call('https://tray.example.com/tray')).resolves.toBeInstanceOf(Response);
      expect(inner).toHaveBeenCalledTimes(1);
      // Standalone branch routes off-origin requests through /api/fetch-proxy.
      expect(inner.mock.calls[0]?.[0]).toBe('/api/fetch-proxy');
    } finally {
      restore();
    }
  });
});
