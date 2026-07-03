/**
 * Tests for `startPageLeaderTray` in `ui/page-leader-tray.ts`.
 *
 * Guards against regression of the multi-browser sync feature. The
 * underlying classes (`LeaderTrayManager`, `LeaderTrayPeerManager`,
 * `LeaderSyncManager`) have their own tests; this file specifically
 * covers the page-side boot wiring that connects them — the layer
 * that was deleted in commit 07cdce16 and is being restored here.
 *
 * Covers:
 *   1. Leader is constructed with the page-side runtime identifier and
 *      starts a session against the supplied workerBaseUrl.
 *   2. `webhook.event` control messages are relayed via the
 *      `sendWebhookEvent` bridge callback, not handled locally.
 *   3. Agent events from the subscription primitive are forwarded to
 *      `LeaderSyncManager.broadcastEvent`.
 *   4. `stop()` tears down sync, peers, leader, and the agent-event
 *      subscription.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  LeaderTraySession,
  LeaderTraySessionStore,
  LeaderTrayWebSocket,
} from '../../src/scoops/tray-leader.js';
import type { FollowerToLeaderMessage } from '../../src/scoops/tray-sync-protocol.js';
import type { TrayDataChannelLike } from '../../src/scoops/tray-webrtc.js';
import { startPageLeaderTray } from '../../src/ui/page-leader-tray.js';
import type { AgentEvent } from '../../src/ui/types.js';

// ---------------------------------------------------------------------------
// Shared fakes
// ---------------------------------------------------------------------------

class CapturingChannel implements TrayDataChannelLike {
  readyState = 'open';
  private messageListeners: Array<(event: { data: string }) => void> = [];
  addEventListener(type: string, listener: (...args: never[]) => void): void {
    if (type === 'message') {
      this.messageListeners.push(listener as (event: { data: string }) => void);
    }
  }
  send(): void {}
  close(): void {
    this.readyState = 'closed';
  }
  simulate(msg: FollowerToLeaderMessage): void {
    const data = JSON.stringify(msg);
    for (const l of this.messageListeners) l({ data });
  }
}

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

/**
 * Minimal `BrowserAPI`-shaped fake. The helper only calls
 * `setTrayTargetProvider` and `listPages`; everything else can throw
 * if accidentally touched.
 */
function makeFakeBrowserAPI() {
  return {
    setTrayTargetProvider: vi.fn(),
    listPages: vi.fn().mockResolvedValue([]),
  } as unknown as Parameters<typeof startPageLeaderTray>[0]['browserAPI'];
}

/**
 * Build the two HTTP responses LeaderTrayManager needs to reach 'leader':
 *   1. POST /tray              — creates the tray
 *   2. POST /tray/:id/controller — claims the controller / opens WS URL
 */
function makeLeaderFetch() {
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

  const webSocketFactory = (): FakeWebSocket => {
    const s = new FakeWebSocket();
    sockets.push(s);
    return s;
  };

  return { fetchImpl, webSocketFactory, sockets };
}

/**
 * Build a baseline options object with all required callbacks stubbed.
 * Individual tests override only what they need.
 */
function makeBaseOptions(overrides: {
  fetchImpl?: typeof fetch;
  webSocketFactory?: (url: string) => LeaderTrayWebSocket;
  store?: LeaderTraySessionStore;
  sendWebhookEvent?: (id: string, headers: Record<string, string>, body: unknown) => void;
  onAgentEvent?: (h: (e: AgentEvent) => void) => () => void;
}): Parameters<typeof startPageLeaderTray>[0] {
  return {
    workerBaseUrl: 'https://tray.example.com',
    getMessages: () => [],
    getMessagesForScoop: () => [],
    getScoopJid: () => 'cone',
    getScoops: () => [],
    getSprinkles: () => [],
    readSprinkleContent: () => null,
    onSprinkleLick: vi.fn(),
    onFollowerMessage: vi.fn(),
    onFollowerAbort: vi.fn(),
    onFollowerCountChanged: vi.fn(),
    sendWebhookEvent: overrides.sendWebhookEvent ?? vi.fn(),
    onAgentEvent: overrides.onAgentEvent ?? ((_h) => () => {}),
    browserAPI: makeFakeBrowserAPI(),
    _fetchImpl: overrides.fetchImpl,
    _webSocketFactory: overrides.webSocketFactory,
    _storeOverride: overrides.store,
    _refreshIntervalMs: 60_000, // long — tests don't want intervals firing mid-assertion
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('startPageLeaderTray', () => {
  let store: MemorySessionStore;

  beforeEach(() => {
    store = new MemorySessionStore();
  });

  it('creates and starts a LeaderTrayManager against the supplied workerBaseUrl', async () => {
    const { fetchImpl, webSocketFactory, sockets } = makeLeaderFetch();
    const handle = startPageLeaderTray(makeBaseOptions({ fetchImpl, webSocketFactory, store }));

    await vi.waitFor(() => expect(sockets.length).toBeGreaterThan(0));
    sockets[0].dispatch('open', {});

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const firstUrl = fetchImpl.mock.calls[0][0] as string;
    expect(firstUrl).toContain('tray.example.com');

    handle.stop();
  });

  it('uses slicc-standalone as the runtime identifier (matches pre-regression value)', async () => {
    const { fetchImpl, webSocketFactory, sockets } = makeLeaderFetch();
    const handle = startPageLeaderTray(makeBaseOptions({ fetchImpl, webSocketFactory, store }));

    await vi.waitFor(() => expect(sockets.length).toBeGreaterThan(0));
    sockets[0].dispatch('open', {});

    // store.value is populated after successful claim — verify runtime
    await vi.waitFor(() => expect(store.value).not.toBeNull());
    expect(store.value?.runtime).toBe('slicc-standalone');

    handle.stop();
  });

  it('pushes the leader joinUrl to the browserTransport SW bridge on leader-ready', async () => {
    const { fetchImpl, webSocketFactory, sockets } = makeLeaderFetch();
    const sendLeaderJoinUrl = vi.fn();
    const userOnLeaderReady = vi.fn();

    const handle = startPageLeaderTray({
      ...makeBaseOptions({ fetchImpl, webSocketFactory, store }),
      // The cherry side panel connects its follower using this joinUrl; the
      // extension bridge transport carries it to the SW.
      browserTransport: { sendLeaderJoinUrl } as never,
      onLeaderReady: userOnLeaderReady,
    });

    await vi.waitFor(() => expect(sockets.length).toBeGreaterThan(0));
    sockets[0].dispatch('open', {});
    // The leader reaches 'ready' (and fires onLeaderReady) only after the tray
    // sends `leader.connected` over the controller WS — not on socket open.
    sockets[0].dispatch('message', { data: JSON.stringify({ type: 'leader.connected' }) });

    await vi.waitFor(() => expect(sendLeaderJoinUrl).toHaveBeenCalled());
    expect(sendLeaderJoinUrl).toHaveBeenCalledWith('https://tray.example.com/join/token');
    // The caller's own onLeaderReady is still invoked (not clobbered by the push).
    expect(userOnLeaderReady).toHaveBeenCalledTimes(1);

    handle.stop();
  });

  it('leader-ready does not throw when the transport has no sendLeaderJoinUrl (standalone)', async () => {
    const { fetchImpl, webSocketFactory, sockets } = makeLeaderFetch();

    // A plain transport (no SW bridge) — the optional-chaining guard must hold.
    const handle = startPageLeaderTray({
      ...makeBaseOptions({ fetchImpl, webSocketFactory, store }),
      browserTransport: {} as never,
    });

    await vi.waitFor(() => expect(sockets.length).toBeGreaterThan(0));
    expect(() => sockets[0].dispatch('open', {})).not.toThrow();
    await vi.waitFor(() => expect(store.value).not.toBeNull());

    handle.stop();
  });

  it('relays webhook.event control messages via sendWebhookEvent (not handled locally)', async () => {
    const { fetchImpl, webSocketFactory, sockets } = makeLeaderFetch();
    const sendWebhookEvent = vi.fn();

    const handle = startPageLeaderTray(
      makeBaseOptions({ fetchImpl, webSocketFactory, store, sendWebhookEvent })
    );

    await vi.waitFor(() => expect(sockets.length).toBeGreaterThan(0));
    sockets[0].dispatch('open', {});

    // Wait for the leader to attach its message listener
    await vi.waitFor(() => expect(store.value).not.toBeNull());

    // Simulate a webhook.event arriving from the tray worker
    sockets[0].dispatch('message', {
      data: JSON.stringify({
        type: 'webhook.event',
        webhookId: 'wh-1',
        headers: { 'x-github-event': 'push' },
        body: { ping: true },
        timestamp: '2026-01-01T00:00:00.000Z',
      }),
    });

    await vi.waitFor(() => expect(sendWebhookEvent).toHaveBeenCalled());
    expect(sendWebhookEvent).toHaveBeenCalledWith(
      'wh-1',
      { 'x-github-event': 'push' },
      { ping: true }
    );

    handle.stop();
  });

  it('forwards agent events from onAgentEvent to LeaderSyncManager.broadcastEvent', async () => {
    const { fetchImpl, webSocketFactory } = makeLeaderFetch();
    let capturedHandler: ((event: AgentEvent) => void) | undefined;
    const onAgentEvent = (h: (e: AgentEvent) => void) => {
      capturedHandler = h;
      return () => {
        capturedHandler = undefined;
      };
    };

    const handle = startPageLeaderTray(
      makeBaseOptions({ fetchImpl, webSocketFactory, store, onAgentEvent })
    );

    // Verify the handler was captured (helper installed its tap)
    expect(capturedHandler).toBeDefined();

    // Spy on broadcastEvent and fire an event through the captured handler
    const spy = vi.spyOn(handle.sync, 'broadcastEvent');
    capturedHandler!({ type: 'turn_end', messageId: 'msg-1' });
    expect(spy).toHaveBeenCalledWith({ type: 'turn_end', messageId: 'msg-1' });

    handle.stop();
    // After stop(), the unsubscribe should have run
    expect(capturedHandler).toBeUndefined();
  });

  it('refreshLeaderTargets logs at error level (not warn) exactly once across many quick failures', async () => {
    // Covers `page-leader-tray.ts`'s integration with
    // `ThrottledErrorTracker`. Each rejection carries a UNIQUE error
    // string so the logger's DedupBuffer (60s window, fingerprint-
    // keyed) does NOT collapse identical messages — that way the
    // only thing suppressing duplicates is the
    // `ThrottledErrorTracker.reportFailure` throttle. If a future
    // cleanup bypasses the tracker, the suppression vanishes and
    // this test catches it via `errorCalls.length > 1`.
    //
    // Uses real timers + a small refresh interval — `vi.fakeTimers`
    // mixes badly with `vi.waitFor` and the async fetch harness.
    const { fetchImpl, webSocketFactory, sockets } = makeLeaderFetch();
    let rejectionCounter = 0;
    const listPages = vi.fn(() => {
      rejectionCounter++;
      return Promise.reject(new Error(`CDP closed attempt-${rejectionCounter}`));
    });
    const browserAPI = {
      setTrayTargetProvider: vi.fn(),
      listPages,
    } as unknown as Parameters<typeof startPageLeaderTray>[0]['browserAPI'];

    const baseOpts = makeBaseOptions({ fetchImpl, webSocketFactory, store });
    const opts = {
      ...baseOpts,
      browserAPI,
      _refreshIntervalMs: 25, // ~40 ticks per second, plenty within a sub-second test window
    };

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const handle = startPageLeaderTray(opts);

      // Wait until listPages has fired at least 5 times (5 intervals = ~125ms).
      await vi.waitFor(() => expect(listPages.mock.calls.length).toBeGreaterThanOrEqual(5), {
        timeout: 1000,
      });

      sockets[0]?.dispatch('open', {});

      // Each rejection had a distinct error message — DedupBuffer
      // doesn't collapse. So exactly ONE log.error means the
      // `ThrottledErrorTracker.reportFailure` throttle held against
      // 5+ rapid failures inside the same 60s window.
      const errorCalls = errorSpy.mock.calls.filter((args) =>
        String(args[1] ?? '').includes('Leader CDP target refresh failed')
      );
      const warnCalls = warnSpy.mock.calls.filter((args) =>
        String(args[1] ?? '').includes('Leader CDP target refresh failed')
      );
      expect(errorCalls.length).toBe(1);
      expect(warnCalls.length).toBe(0);

      handle.stop();
    } finally {
      errorSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it('stop() calls leader.stop(), peers.stop(), and sync.stop()', async () => {
    const { fetchImpl, webSocketFactory, sockets } = makeLeaderFetch();
    const handle = startPageLeaderTray(makeBaseOptions({ fetchImpl, webSocketFactory, store }));

    await vi.waitFor(() => expect(sockets.length).toBeGreaterThan(0));
    sockets[0].dispatch('open', {});

    const leaderStop = vi.spyOn(handle.leader, 'stop');
    const peersStop = vi.spyOn(handle.peers, 'stop');
    const syncStop = vi.spyOn(handle.sync, 'stop');

    handle.stop();

    expect(leaderStop).toHaveBeenCalledOnce();
    expect(peersStop).toHaveBeenCalledOnce();
    expect(syncStop).toHaveBeenCalledOnce();
  });

  it('threads onRemoteTransportsCleaned into the sync manager', () => {
    const { fetchImpl, webSocketFactory } = makeLeaderFetch();
    const onRemoteTransportsCleaned = vi.fn();
    const opts = {
      ...makeBaseOptions({ fetchImpl, webSocketFactory, store }),
      onRemoteTransportsCleaned,
    };
    const handle = startPageLeaderTray(opts);

    const channel = new CapturingChannel();
    handle.sync.addFollower('b1', channel);
    channel.simulate({
      type: 'targets.advertise',
      targets: [{ targetId: 'tab1', title: 'Tab', url: 'https://example.com' }],
      runtimeId: 'follower-b1',
    });
    handle.sync.removeFollower('b1');
    expect(onRemoteTransportsCleaned).toHaveBeenCalledWith('follower-b1');

    handle.stop();
  });
});
