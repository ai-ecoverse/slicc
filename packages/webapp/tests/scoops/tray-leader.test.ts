import { describe, expect, it, vi } from 'vitest';

import {
  LeaderTrayManager,
  getLeaderTrayRuntimeStatus,
  parseLeaderTraySession,
  type LeaderTraySession,
  type LeaderTraySessionStore,
  type LeaderTrayWebSocket,
} from './tray-leader.js';

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
});
