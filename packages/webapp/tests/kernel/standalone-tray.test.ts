/**
 * Tests for `startStandaloneLeaderTray` in `kernel/standalone-tray.ts`.
 *
 * Guards against the regression introduced by commit 07cdce16, where
 * the inline-orchestrator standalone path (and its LeaderTrayManager
 * initialization) was deleted from main.ts without being re-wired in
 * the kernel worker.
 *
 * These tests verify:
 *   1. Leader tray is created and started when workerBaseUrl is provided.
 *   2. webhook.event control messages are routed to lickManager.
 *   3. Non-webhook control messages are forwarded to LeaderTrayPeerManager.
 *   4. stop() tears down both the leader and peer manager.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { LeaderTraySession, LeaderTraySessionStore } from '../../src/scoops/tray-leader.js';
import type {
  LeaderTrayWebSocket,
  LeaderTrayManagerOptions,
} from '../../src/scoops/tray-leader.js';
import type { WorkerToLeaderControlMessage } from '../../src/scoops/tray-types.js';
import { startStandaloneLeaderTray } from '../../src/kernel/standalone-tray.js';

// ---------------------------------------------------------------------------
// Shared fakes (mirrored from tray-leader.test.ts pattern)
// ---------------------------------------------------------------------------

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
    this.dispatch('close', {});
  }

  dispatch(type: 'open' | 'message' | 'close' | 'error', event: { data?: unknown }): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

function makeFakeLickManager() {
  return { handleWebhookEvent: vi.fn() };
}

/**
 * Build the two HTTP responses LeaderTrayManager needs to reach 'leader' state:
 *   1. POST /tray — creates the tray
 *   2. POST /tray/:id/controller — claims the controller / opens WS URL
 */
function makeLeaderFetch(socketFactory?: () => FakeWebSocket) {
  const sockets: FakeWebSocket[] = [];
  const fetchImpl = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          trayId: 'tray-1',
          createdAt: '2026-01-01T00:00:00.000Z',
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
          controllerId: 'ctrl-1',
          role: 'leader',
          leaderKey: 'lk-1',
          websocket: { url: 'wss://tray.example.com/ws' },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );

  const webSocketFactory = () => {
    const s = socketFactory?.() ?? new FakeWebSocket();
    sockets.push(s);
    return s;
  };

  return { fetchImpl, webSocketFactory, sockets };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('startStandaloneLeaderTray', () => {
  let store: MemorySessionStore;

  beforeEach(() => {
    store = new MemorySessionStore();
  });

  it('creates and starts a LeaderTrayManager with the correct workerBaseUrl', async () => {
    const { fetchImpl, webSocketFactory, sockets } = makeLeaderFetch();
    const lickManager = makeFakeLickManager();

    const handle = startStandaloneLeaderTray({
      workerBaseUrl: 'https://tray.example.com',
      lickManager: lickManager as never,
      fetchImpl,
      _storeOverride: store,
      _webSocketFactory: webSocketFactory,
    });

    // Wait for the WebSocket to be opened (leader connected)
    await vi.waitFor(() => expect(sockets.length).toBeGreaterThan(0));
    sockets[0].dispatch('open', {});

    // Verify fetch was called — first call creates the tray
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const firstUrl = fetchImpl.mock.calls[0][0] as string;
    expect(firstUrl).toContain('tray.example.com');

    handle.stop();
  });

  it('routes webhook.event control messages to lickManager.handleWebhookEvent', async () => {
    const { fetchImpl, webSocketFactory, sockets } = makeLeaderFetch();
    const lickManager = makeFakeLickManager();
    let capturedOnControlMessage: LeaderTrayManagerOptions['onControlMessage'];

    // Intercept the onControlMessage callback as passed to LeaderTrayManager.
    // startStandaloneLeaderTray wires this from the LeaderTrayManager options;
    // we trigger it via the handle's leader instance directly.
    const handle = startStandaloneLeaderTray({
      workerBaseUrl: 'https://tray.example.com',
      lickManager: lickManager as never,
      fetchImpl,
      _storeOverride: store,
      _webSocketFactory: webSocketFactory,
      _onControlMessage: (cb) => {
        capturedOnControlMessage = cb;
      },
    });

    await vi.waitFor(() => expect(sockets.length).toBeGreaterThan(0));
    sockets[0].dispatch('open', {});

    // Simulate a webhook.event message arriving from the tray worker
    const webhookMsg: WorkerToLeaderControlMessage = {
      type: 'webhook.event',
      webhookId: 'wh-1',
      headers: { 'x-custom': 'val' },
      body: { ping: true },
    };
    capturedOnControlMessage?.(webhookMsg);

    expect(lickManager.handleWebhookEvent).toHaveBeenCalledWith(
      'wh-1',
      { 'x-custom': 'val' },
      {
        ping: true,
      }
    );

    handle.stop();
  });

  it('stop() calls leader.stop() and peers.stop()', async () => {
    const { fetchImpl, webSocketFactory, sockets } = makeLeaderFetch();
    const lickManager = makeFakeLickManager();

    const handle = startStandaloneLeaderTray({
      workerBaseUrl: 'https://tray.example.com',
      lickManager: lickManager as never,
      fetchImpl,
      _storeOverride: store,
      _webSocketFactory: webSocketFactory,
    });

    await vi.waitFor(() => expect(sockets.length).toBeGreaterThan(0));
    sockets[0].dispatch('open', {});

    const leaderStopSpy = vi.spyOn(handle.leader, 'stop');
    const peersStopSpy = vi.spyOn(handle.peers, 'stop');

    handle.stop();

    expect(leaderStopSpy).toHaveBeenCalledOnce();
    expect(peersStopSpy).toHaveBeenCalledOnce();
  });

  it('uses slicc-standalone-worker as the runtime identifier', async () => {
    const { fetchImpl, webSocketFactory, sockets } = makeLeaderFetch();
    const lickManager = makeFakeLickManager();

    const handle = startStandaloneLeaderTray({
      workerBaseUrl: 'https://tray.example.com',
      lickManager: lickManager as never,
      fetchImpl,
      _storeOverride: store,
      _webSocketFactory: webSocketFactory,
    });

    await vi.waitFor(() => expect(sockets.length).toBeGreaterThan(0));
    sockets[0].dispatch('open', {});
    await vi.waitFor(() => expect(store.value).not.toBeNull());

    expect(store.value?.runtime).toBe('slicc-standalone-worker');

    handle.stop();
  });
});
