import { describe, expect, it, vi } from 'vitest';

import { LeaderTrayManager, parseLeaderTraySession, type LeaderTraySession, type LeaderTraySessionStore, type LeaderTrayWebSocket } from './tray-leader.js';

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
  private readonly listeners = new Map<string, Array<(event: { data?: unknown }) => void>>();

  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (event: { data?: unknown }) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
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
    expect(parseLeaderTraySession(JSON.stringify({
      workerBaseUrl: 'https://tray.example.com',
      trayId: 'tray-1',
      createdAt: '2026-01-01T00:00:00.000Z',
      controllerId: 'controller-1',
      controllerUrl: 'https://tray.example.com/controller/token',
      joinUrl: 'https://tray.example.com/join/token',
      webhookUrl: 'https://tray.example.com/webhook/token',
      runtime: 'slicc-standalone',
    }))?.trayId).toBe('tray-1');
    expect(parseLeaderTraySession('{')).toBeNull();
    expect(parseLeaderTraySession(JSON.stringify({ trayId: 'missing-fields' }))).toBeNull();
  });

  it('creates a tray, claims the controller capability, and opens the leader websocket', async () => {
    const store = new MemorySessionStore();
    const socket = new FakeWebSocket();
    let resolveSocketReady!: () => void;
    const socketReady = new Promise<void>(resolve => {
      resolveSocketReady = resolve;
    });
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        trayId: 'tray-1',
        createdAt: '2026-03-11T00:00:00.000Z',
        capabilities: {
          join: { url: 'https://tray.example.com/join/token' },
          controller: { url: 'https://tray.example.com/controller/token' },
          webhook: { url: 'https://tray.example.com/webhook/token' },
        },
      }), { status: 201, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        trayId: 'tray-1',
        controllerId: 'controller-1',
        role: 'leader',
        leaderKey: 'leader-key-1',
        websocket: { url: 'wss://tray.example.com/controller/token?controllerId=controller-1&leaderKey=leader-key-1' },
      }), { status: 200, headers: { 'content-type': 'application/json' } }));

    const startPromise = new LeaderTrayManager({
      workerBaseUrl: 'https://tray.example.com',
      runtime: 'slicc-standalone',
      store,
      fetchImpl,
      webSocketFactory: () => {
        resolveSocketReady();
        return socket;
      },
      pingIntervalMs: 60_000,
    }).start();

    await socketReady;
    socket.dispatch('message', { data: JSON.stringify({ type: 'leader.connected', trayId: 'tray-1' }) });
    const session = await startPromise;

    expect(session.trayId).toBe('tray-1');
    expect(session.leaderKey).toBe('leader-key-1');
    expect(store.value?.leaderWebSocketUrl).toContain('leaderKey=leader-key-1');
    expect(socket.sent[0]).toBe(JSON.stringify({ type: 'ping' }));
    expect(fetchImpl).toHaveBeenCalledTimes(2);
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
      leaderWebSocketUrl: 'wss://tray.example.com/controller/stale-token?controllerId=controller-1&leaderKey=old-key',
      runtime: 'slicc-standalone',
    };

    const socket = new FakeWebSocket();
    let resolveSocketReady!: () => void;
    const socketReady = new Promise<void>(resolve => {
      resolveSocketReady = resolve;
    });
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Tray expired', code: 'TRAY_EXPIRED' }), {
        status: 410,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        trayId: 'fresh-tray',
        createdAt: '2026-03-11T00:01:00.000Z',
        capabilities: {
          join: { url: 'https://tray.example.com/join/fresh-token' },
          controller: { url: 'https://tray.example.com/controller/fresh-token' },
          webhook: { url: 'https://tray.example.com/webhook/fresh-token' },
        },
      }), { status: 201, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        trayId: 'fresh-tray',
        controllerId: 'controller-2',
        role: 'leader',
        leaderKey: 'fresh-key',
        websocket: { url: 'wss://tray.example.com/controller/fresh-token?controllerId=controller-2&leaderKey=fresh-key' },
      }), { status: 200, headers: { 'content-type': 'application/json' } }));

    const startPromise = new LeaderTrayManager({
      workerBaseUrl: 'https://tray.example.com',
      runtime: 'slicc-standalone',
      store,
      fetchImpl,
      webSocketFactory: () => {
        resolveSocketReady();
        return socket;
      },
      pingIntervalMs: 60_000,
    }).start();

    await socketReady;
    socket.dispatch('message', { data: JSON.stringify({ type: 'leader.connected', trayId: 'fresh-tray' }) });
    const session = await startPromise;

    expect(session.trayId).toBe('fresh-tray');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(store.value?.controllerUrl).toBe('https://tray.example.com/controller/fresh-token');
  });
});
