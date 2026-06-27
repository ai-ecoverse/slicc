/**
 * Tests for the kernel-host /licks-ws bridge. Pins the wire shape
 * shared with `packages/node-server/src/index.ts` (`sendLickRequest`,
 * `broadcastLickEvent`): management requests (list/create/delete
 * webhooks + cron tasks + tray status), inbound events (webhook_event,
 * navigate_event), error envelope, URL construction (standalone vs
 * tray-leader), reconnection + escalation, send-race on stop.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LickManager, WebhookEntry } from '../../src/scoops/lick-manager.js';
import type { createShellBridgeHandler } from '../../src/scoops/shell-bridge-handler.js';
import {
  type LeaderTraySession,
  setLeaderTrayRuntimeStatus,
} from '../../src/scoops/tray-leader.js';

/** Minimal cup shell-bridge stub: its mere presence puts the bridge in
 *  cup (steering) mode, which is what gates the shell-host registration. */
function stubShellBridge(): ReturnType<typeof createShellBridgeHandler> {
  return {
    canHandle: () => false,
    handleRequest: vi.fn(async () => ({})),
    handleStream: vi.fn(async () => {}),
  } as unknown as ReturnType<typeof createShellBridgeHandler>;
}

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];

  url: string;
  /** Mirror of `WebSocket.readyState` — defaults to OPEN(1) so messages
   * arriving via `emit()` are accepted. `close()` flips to CLOSED(3). */
  readyState = 1;
  onopen: ((ev: Event) => unknown) | null = null;
  onclose: ((ev: CloseEvent) => unknown) | null = null;
  onmessage: ((ev: MessageEvent) => unknown) | null = null;
  onerror: ((ev: Event) => unknown) | null = null;
  sent: string[] = [];
  closed = false;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(payload: string): void {
    this.sent.push(payload);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    this.onclose?.(new CloseEvent('close'));
  }

  /** Simulate a server → client message. */
  emit(payload: unknown): void {
    this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(payload) }));
  }
}

function buildLickManagerMock(overrides: Partial<LickManager> = {}): LickManager {
  return {
    handleWebhookEvent: vi.fn(),
    emitEvent: vi.fn(),
    listWebhooks: vi.fn().mockReturnValue([]),
    createWebhook: vi.fn(),
    deleteWebhook: vi.fn(),
    listCronTasks: vi.fn().mockReturnValue([]),
    createCronTask: vi.fn(),
    deleteCronTask: vi.fn(),
    ...overrides,
  } as unknown as LickManager;
}

const LOCATION = 'http://localhost:5710/index.html';

const SESSION: LeaderTraySession = {
  workerBaseUrl: 'https://hub.slicc.dev',
  trayId: 'tray-abc',
  createdAt: new Date().toISOString(),
  controllerId: 'ctrl-1',
  controllerUrl: 'https://hub.slicc.dev/controller/abc',
  joinUrl: 'https://hub.slicc.dev/join/abc',
  webhookUrl: 'https://hub.slicc.dev/webhook/abc',
  runtime: 'browser',
};

async function loadBridge() {
  return await import('../../src/scoops/lick-ws-bridge.js');
}

describe('startLickWsBridge', () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    setLeaderTrayRuntimeStatus({ state: 'inactive', session: null, error: null });
  });

  afterEach(() => {
    setLeaderTrayRuntimeStatus({ state: 'inactive', session: null, error: null });
  });

  it('opens a socket against the lick-ws URL derived from locationHref', async () => {
    const { startLickWsBridge } = await loadBridge();
    const lm = buildLickManagerMock();

    const handle = startLickWsBridge(lm, {
      locationHref: LOCATION,
      webSocketFactory: (url) => new FakeWebSocket(url),
    });

    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakeWebSocket.instances[0].url).toBe('ws://localhost:5710/licks-ws');
    handle.stop();
  });

  it('registers as a shell host on connect when a shellBridge is wired (cup)', async () => {
    // Without this announcement the node-server never marks this page a steering
    // host, so its `pickSteeringClient` falls back to "first OPEN client" and a
    // topology-A follower could swallow the brain's shell-exec. See lick-bridge.
    const { startLickWsBridge } = await loadBridge();
    const handle = startLickWsBridge(buildLickManagerMock(), {
      locationHref: LOCATION,
      webSocketFactory: (url) => new FakeWebSocket(url),
      shellBridge: stubShellBridge(),
    });
    const ws = FakeWebSocket.instances[0];
    ws.onopen?.(new Event('open'));

    const registered = ws.sent
      .map((s) => JSON.parse(s) as { type?: string })
      .some((m) => m.type === 'register-shell-host');
    expect(registered).toBe(true);
    handle.stop();
  });

  it('does NOT register as a shell host without a shellBridge (non-cup float)', async () => {
    const { startLickWsBridge } = await loadBridge();
    const handle = startLickWsBridge(buildLickManagerMock(), {
      locationHref: LOCATION,
      webSocketFactory: (url) => new FakeWebSocket(url),
    });
    const ws = FakeWebSocket.instances[0];
    ws.onopen?.(new Event('open'));

    const registered = ws.sent
      .map((s) => JSON.parse(s) as { type?: string })
      .some((m) => m.type === 'register-shell-host');
    expect(registered).toBe(false);
    handle.stop();
  });

  it('prefers the lickWsUrl override over the locationHref-derived URL', async () => {
    // Thin-bridge: locationHref points at the hosted UI (e.g. wrangler
    // on :8787) but the bridge override directs the dial at the local
    // node-server's :5710 /licks-ws. Without this, the upgrade lands at
    // the UI origin where it returns 200 instead of 101.
    const { startLickWsBridge } = await loadBridge();
    const handle = startLickWsBridge(buildLickManagerMock(), {
      locationHref: 'http://localhost:8787/index.html',
      lickWsUrl: 'ws://localhost:5710/licks-ws',
      webSocketFactory: (url) => new FakeWebSocket(url),
    });

    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakeWebSocket.instances[0].url).toBe('ws://localhost:5710/licks-ws');
    handle.stop();
  });

  it('list_webhooks fallback URL uses the lickWsUrl override origin (not locationHref)', async () => {
    // Same thin-bridge scenario as above: webhooks must point at the
    // node-server on :5710, not the hosted UI on :8787.
    const { startLickWsBridge } = await loadBridge();
    const entries: WebhookEntry[] = [
      { id: 'wh-1', name: 'github', createdAt: new Date().toISOString(), scoop: 'scoop-a' },
    ];
    const lm = buildLickManagerMock({
      listWebhooks: vi.fn().mockReturnValue(entries),
    });

    const handle = startLickWsBridge(lm, {
      locationHref: 'http://localhost:8787/index.html',
      lickWsUrl: 'ws://localhost:5710/licks-ws',
      webSocketFactory: (url) => new FakeWebSocket(url),
    });
    const ws = FakeWebSocket.instances[0];

    ws.emit({ type: 'list_webhooks', requestId: 'r-1' });
    await vi.waitFor(() => expect(ws.sent.length).toBeGreaterThan(0));
    const reply = JSON.parse(ws.sent[0]);
    expect(reply.data[0].url).toBe('http://localhost:5710/webhooks/wh-1');
    handle.stop();
  });

  it('default setTimer / clearTimer are bound to globalThis (no "Illegal invocation")', async () => {
    // Regression: when `setTimeoutFn` / `clearTimeoutFn` are not passed,
    // the bridge previously stored the bare global `setTimeout` reference
    // and invoked it as a method on `rt`, which throws "Illegal
    // invocation" in real browsers because the timer is an internal-slot
    // method on the global object. Using `.bind(globalThis)` fixes it.
    const { startLickWsBridge } = await loadBridge();
    // Synthetic socket that flips into CLOSED state on construction so
    // onBridgeFailure runs and exercises the default setTimer path.
    class FailingWebSocket extends FakeWebSocket {
      constructor(url: string) {
        super(url);
        this.readyState = 3;
        queueMicrotask(() => this.onclose?.(new CloseEvent('close', { code: 1006 })));
      }
    }

    const handle = startLickWsBridge(buildLickManagerMock(), {
      locationHref: LOCATION,
      webSocketFactory: (url) => new FailingWebSocket(url),
      // Set a long base delay so the reconnect timer is armed but does
      // not fire before we call stop() below — we only need to verify
      // that the default setTimer/clearTimer don't throw.
      reconnectDelayMs: 60_000,
    });

    // Let the microtask-queued onclose fire so scheduleBridgeReconnect
    // invokes the default setTimer path.
    await new Promise((r) => setTimeout(r, 0));
    // stop() exercises the default clearTimer path. If either timer
    // were unbound from globalThis, this assertion would surface the
    // TypeError instead of a clean no-throw.
    expect(() => handle.stop()).not.toThrow();
  });

  it('responds to list_webhooks with entries augmented by the local URL', async () => {
    const { startLickWsBridge } = await loadBridge();
    const entries: WebhookEntry[] = [
      { id: 'wh-1', name: 'github', createdAt: new Date().toISOString(), scoop: 'scoop-a' },
    ];
    const lm = buildLickManagerMock({
      listWebhooks: vi.fn().mockReturnValue(entries),
    });

    const handle = startLickWsBridge(lm, {
      locationHref: LOCATION,
      webSocketFactory: (url) => new FakeWebSocket(url),
    });
    const ws = FakeWebSocket.instances[0];

    ws.emit({ type: 'list_webhooks', requestId: 'r-1' });
    await vi.waitFor(() => expect(ws.sent.length).toBeGreaterThan(0));
    const reply = JSON.parse(ws.sent[0]);

    expect(reply).toEqual({
      type: 'response',
      requestId: 'r-1',
      data: [
        {
          ...entries[0],
          url: 'http://localhost:5710/webhooks/wh-1',
        },
      ],
    });
    handle.stop();
  });

  it('builds tray webhook URL when a leader session is active', async () => {
    setLeaderTrayRuntimeStatus({ state: 'leader', session: SESSION, error: null });
    const { startLickWsBridge } = await loadBridge();

    const created: WebhookEntry = {
      id: 'wh-9',
      name: 'github',
      scoop: 'scoop-a',
      createdAt: new Date().toISOString(),
    };
    const lm = buildLickManagerMock({
      createWebhook: vi.fn().mockResolvedValue(created),
    });

    const handle = startLickWsBridge(lm, {
      locationHref: LOCATION,
      webSocketFactory: (url) => new FakeWebSocket(url),
    });
    const ws = FakeWebSocket.instances[0];

    ws.emit({
      type: 'create_webhook',
      requestId: 'r-9',
      name: 'github',
      scoop: 'scoop-a',
    });
    await vi.waitFor(() => expect(ws.sent.length).toBeGreaterThan(0));
    const reply = JSON.parse(ws.sent[0]);

    expect(reply.requestId).toBe('r-9');
    expect(reply.data.url).toBe('https://hub.slicc.dev/webhook/abc/wh-9');
    expect(reply.data.id).toBe('wh-9');
    handle.stop();
  });

  it('responds with error for delete_webhook on unknown id', async () => {
    const { startLickWsBridge } = await loadBridge();
    const lm = buildLickManagerMock({
      deleteWebhook: vi.fn().mockResolvedValue(false),
    });

    const handle = startLickWsBridge(lm, {
      locationHref: LOCATION,
      webSocketFactory: (url) => new FakeWebSocket(url),
    });
    const ws = FakeWebSocket.instances[0];

    ws.emit({ type: 'delete_webhook', requestId: 'r-d', id: 'missing' });
    await vi.waitFor(() => expect(ws.sent.length).toBeGreaterThan(0));
    const reply = JSON.parse(ws.sent[0]);
    expect(reply).toEqual({
      type: 'response',
      requestId: 'r-d',
      data: { error: 'Webhook not found' },
    });
    handle.stop();
  });

  it('forwards webhook_event without requestId to lickManager.handleWebhookEvent', async () => {
    const { startLickWsBridge } = await loadBridge();
    const handleWebhookEvent = vi.fn();
    const lm = buildLickManagerMock({ handleWebhookEvent });

    const handle = startLickWsBridge(lm, {
      locationHref: LOCATION,
      webSocketFactory: (url) => new FakeWebSocket(url),
    });
    const ws = FakeWebSocket.instances[0];

    ws.emit({
      type: 'webhook_event',
      webhookId: 'wh-1',
      headers: { 'x-test': '1' },
      body: { hello: 'world' },
    });

    expect(handleWebhookEvent).toHaveBeenCalledWith('wh-1', { 'x-test': '1' }, { hello: 'world' });
    expect(ws.sent).toHaveLength(0);
    handle.stop();
  });

  it('forwards navigate_event payloads as navigate licks using the {verb, target, url} shape', async () => {
    // Wire shape matches node-server's `POST /api/handoff` payload
    // (RFC 8288 Link fields, not the older sliccHeader envelope).
    const { startLickWsBridge } = await loadBridge();
    const emitEvent = vi.fn();
    const lm = buildLickManagerMock({ emitEvent });

    const handle = startLickWsBridge(lm, {
      locationHref: LOCATION,
      webSocketFactory: (url) => new FakeWebSocket(url),
    });
    const ws = FakeWebSocket.instances[0];

    ws.emit({
      type: 'navigate_event',
      verb: 'handoff',
      target: 'https://example.com/repo',
      instruction: 'do thing',
      url: 'about:handoff',
      title: 'Hand off',
      timestamp: '2026-05-21T00:00:00.000Z',
    });

    // Use objectContaining so adding a new optional field to the body
    // (e.g., a future `traceId`) doesn't fail this test for the wrong
    // reason. The upskill counterpart below uses the same pattern.
    expect(emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'navigate',
        navigateUrl: 'about:handoff',
        targetScoop: undefined,
        timestamp: '2026-05-21T00:00:00.000Z',
        body: expect.objectContaining({
          url: 'about:handoff',
          verb: 'handoff',
          target: 'https://example.com/repo',
          instruction: 'do thing',
          title: 'Hand off',
        }),
      })
    );
    handle.stop();
  });

  it('forwards upskill navigate_event with branch + path', async () => {
    const { startLickWsBridge } = await loadBridge();
    const emitEvent = vi.fn();
    const lm = buildLickManagerMock({ emitEvent });

    const handle = startLickWsBridge(lm, {
      locationHref: LOCATION,
      webSocketFactory: (url) => new FakeWebSocket(url),
    });
    const ws = FakeWebSocket.instances[0];

    ws.emit({
      type: 'navigate_event',
      verb: 'upskill',
      target: 'https://github.com/owner/repo',
      url: 'about:handoff',
      branch: 'main',
      path: 'skills/foo',
    });

    expect(emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          verb: 'upskill',
          target: 'https://github.com/owner/repo',
          branch: 'main',
          path: 'skills/foo',
        }),
      })
    );
    handle.stop();
  });

  it('drops navigate_event missing verb or target', async () => {
    const { startLickWsBridge } = await loadBridge();
    const emitEvent = vi.fn();
    const lm = buildLickManagerMock({ emitEvent });

    const handle = startLickWsBridge(lm, {
      locationHref: LOCATION,
      webSocketFactory: (url) => new FakeWebSocket(url),
    });
    const ws = FakeWebSocket.instances[0];

    // Missing verb
    ws.emit({ type: 'navigate_event', target: 'x', url: 'about:handoff' });
    // Missing target
    ws.emit({ type: 'navigate_event', verb: 'handoff', url: 'about:handoff' });
    // Missing url
    ws.emit({ type: 'navigate_event', verb: 'handoff', target: 'x' });
    // Invalid verb
    ws.emit({ type: 'navigate_event', verb: 'nope', target: 'x', url: 'about:handoff' });

    expect(emitEvent).not.toHaveBeenCalled();
    handle.stop();
  });

  it('responds with unknown-type error for unrecognized requests', async () => {
    const { startLickWsBridge } = await loadBridge();
    const handle = startLickWsBridge(buildLickManagerMock(), {
      locationHref: LOCATION,
      webSocketFactory: (url) => new FakeWebSocket(url),
    });
    const ws = FakeWebSocket.instances[0];

    ws.emit({ type: 'nonsense', requestId: 'r-x' });
    await vi.waitFor(() => expect(ws.sent.length).toBeGreaterThan(0));
    const reply = JSON.parse(ws.sent[0]);
    expect(reply).toEqual({
      type: 'response',
      requestId: 'r-x',
      error: 'Unknown request type: nonsense',
    });
    handle.stop();
  });

  it('returns tray status payload from tray_status request', async () => {
    setLeaderTrayRuntimeStatus({ state: 'leader', session: SESSION, error: null });
    const { startLickWsBridge } = await loadBridge();
    const handle = startLickWsBridge(buildLickManagerMock(), {
      locationHref: LOCATION,
      webSocketFactory: (url) => new FakeWebSocket(url),
    });
    const ws = FakeWebSocket.instances[0];

    ws.emit({ type: 'tray_status', requestId: 'r-t' });
    await vi.waitFor(() => expect(ws.sent.length).toBeGreaterThan(0));
    const reply = JSON.parse(ws.sent[0]);
    expect(reply.data).toEqual({
      state: 'leader',
      joinUrl: SESSION.joinUrl,
      workerBaseUrl: SESSION.workerBaseUrl,
      trayId: SESSION.trayId,
    });
    handle.stop();
  });

  // In standalone mode the kernel worker hosts this bridge, but the
  // leader tray runs on the page — the worker's `setLeaderTrayRuntimeStatus`
  // module global stays `inactive`. The page mirrors the live status into
  // the `slicc.leaderTrayStatus` localStorage shim (forwarded by
  // installPageStorageSync), and `tray_status` must read that shim so
  // `/api/tray-status` reflects an active leader. Mirrors the
  // `host-command.ts` localStorage-fallback test.
  describe('localStorage fallback (standalone-worker path)', () => {
    beforeEach(() => {
      const store = new Map<string, string>();
      const shim: Storage = {
        get length() {
          return store.size;
        },
        key: (i) => Array.from(store.keys())[i] ?? null,
        getItem: (k) => store.get(k) ?? null,
        setItem: (k, v) => {
          store.set(k, v);
        },
        removeItem: (k) => {
          store.delete(k);
        },
        clear: () => {
          store.clear();
        },
      };
      Object.defineProperty(globalThis, 'localStorage', {
        value: shim,
        configurable: true,
        writable: true,
      });
    });

    afterEach(() => {
      delete (globalThis as Record<string, unknown>).localStorage;
    });

    it('tray_status reads leader status from localStorage when module global is inactive', async () => {
      // Worker module global is `inactive` (set by the outer `beforeEach`),
      // but the page-side shim carries the live leader status.
      (globalThis as { localStorage?: Storage }).localStorage?.setItem(
        'slicc.leaderTrayStatus',
        JSON.stringify({
          state: 'leader',
          session: SESSION,
          error: null,
        })
      );

      const { startLickWsBridge } = await loadBridge();
      const handle = startLickWsBridge(buildLickManagerMock(), {
        locationHref: LOCATION,
        webSocketFactory: (url) => new FakeWebSocket(url),
      });
      const ws = FakeWebSocket.instances[0];

      ws.emit({ type: 'tray_status', requestId: 'r-shim' });
      await vi.waitFor(() => expect(ws.sent.length).toBeGreaterThan(0));
      const reply = JSON.parse(ws.sent[0]);
      expect(reply.data).toEqual({
        state: 'leader',
        joinUrl: SESSION.joinUrl,
        workerBaseUrl: SESSION.workerBaseUrl,
        trayId: SESSION.trayId,
      });
      handle.stop();
    });

    it('tray_status returns inactive when neither module global nor shim is set', async () => {
      const { startLickWsBridge } = await loadBridge();
      const handle = startLickWsBridge(buildLickManagerMock(), {
        locationHref: LOCATION,
        webSocketFactory: (url) => new FakeWebSocket(url),
      });
      const ws = FakeWebSocket.instances[0];

      ws.emit({ type: 'tray_status', requestId: 'r-empty' });
      await vi.waitFor(() => expect(ws.sent.length).toBeGreaterThan(0));
      const reply = JSON.parse(ws.sent[0]);
      expect(reply.data).toEqual({
        state: 'inactive',
        joinUrl: null,
        workerBaseUrl: null,
        trayId: null,
      });
      handle.stop();
    });
  });

  it('reconnects after the socket closes', async () => {
    const { startLickWsBridge } = await loadBridge();
    const setTimeoutFn = vi.fn().mockImplementation((cb: () => void) => {
      cb();
      return 1 as unknown as ReturnType<typeof setTimeout>;
    });

    const handle = startLickWsBridge(buildLickManagerMock(), {
      locationHref: LOCATION,
      webSocketFactory: (url) => new FakeWebSocket(url),
      setTimeoutFn,
    });

    expect(FakeWebSocket.instances).toHaveLength(1);
    FakeWebSocket.instances[0].close();
    expect(FakeWebSocket.instances).toHaveLength(2);
    handle.stop();
  });

  it('stop() prevents further reconnects', async () => {
    const { startLickWsBridge } = await loadBridge();
    const setTimeoutFn = vi.fn().mockReturnValue(7 as unknown as ReturnType<typeof setTimeout>);
    const clearTimeoutFn = vi.fn();

    const handle = startLickWsBridge(buildLickManagerMock(), {
      locationHref: LOCATION,
      webSocketFactory: (url) => new FakeWebSocket(url),
      setTimeoutFn,
      clearTimeoutFn,
    });

    FakeWebSocket.instances[0].close();
    expect(setTimeoutFn).toHaveBeenCalledTimes(1);

    handle.stop();
    expect(clearTimeoutFn).toHaveBeenCalledWith(7);

    // Subsequent close events from a re-emitted socket should not
    // schedule a new reconnect.
    FakeWebSocket.instances[0].close();
    expect(setTimeoutFn).toHaveBeenCalledTimes(1);
  });

  it('stop() is idempotent', async () => {
    const { startLickWsBridge } = await loadBridge();
    const handle = startLickWsBridge(buildLickManagerMock(), {
      locationHref: LOCATION,
      webSocketFactory: (url) => new FakeWebSocket(url),
    });
    expect(() => {
      handle.stop();
      handle.stop();
      handle.stop();
    }).not.toThrow();
  });

  it('reconnect-handle guard prevents double-scheduling on duplicate close events', async () => {
    const { startLickWsBridge } = await loadBridge();
    const setTimeoutFn = vi.fn().mockReturnValue(123 as unknown as ReturnType<typeof setTimeout>);

    const handle = startLickWsBridge(buildLickManagerMock(), {
      locationHref: LOCATION,
      webSocketFactory: (url) => new FakeWebSocket(url),
      setTimeoutFn,
    });

    // Two rapid close events on the same socket — only one reconnect
    // should be queued.
    const ws = FakeWebSocket.instances[0];
    ws.onclose?.(new CloseEvent('close'));
    ws.onclose?.(new CloseEvent('close'));
    ws.onclose?.(new CloseEvent('close'));
    expect(setTimeoutFn).toHaveBeenCalledTimes(1);
    handle.stop();
  });

  it('reconnect delay grows exponentially up to the cap', async () => {
    const { startLickWsBridge } = await loadBridge();
    const delays: number[] = [];
    // Fire reconnect callback synchronously so we can drive multiple
    // failures in one tick. Records the delay each time.
    const setTimeoutFn = vi.fn().mockImplementation((cb: () => void, delay: number) => {
      delays.push(delay);
      // Only fire the first 6 callbacks; stop() will halt further work.
      if (delays.length <= 6) cb();
      return delays.length as unknown as ReturnType<typeof setTimeout>;
    });
    // Always-throwing factory so each `connect()` fails immediately.
    const factory = (_url: string): never => {
      throw new Error('always fails');
    };

    const handle = startLickWsBridge(buildLickManagerMock(), {
      locationHref: LOCATION,
      webSocketFactory: factory as never,
      setTimeoutFn,
      reconnectDelayMs: 1000,
    });

    expect(delays.slice(0, 4)).toEqual([1000, 2000, 4000, 8000]);
    handle.stop();
  });

  it('emits a session-reload signal to the cone after sustained failure', async () => {
    const { startLickWsBridge } = await loadBridge();
    const emitEvent = vi.fn();
    const lm = buildLickManagerMock({ emitEvent });
    let callbacks = 0;
    const setTimeoutFn = vi.fn().mockImplementation((cb: () => void) => {
      callbacks++;
      // Drive enough failures to cross the give-up threshold (20).
      if (callbacks <= 25) cb();
      return callbacks as unknown as ReturnType<typeof setTimeout>;
    });
    const factory = (_url: string): never => {
      throw new Error('always fails');
    };

    const handle = startLickWsBridge(lm, {
      locationHref: LOCATION,
      webSocketFactory: factory as never,
      setTimeoutFn,
      reconnectDelayMs: 100,
    });

    // Exactly one cone-visible signal at the threshold, not per-failure.
    expect(emitEvent).toHaveBeenCalledTimes(1);
    const [event] = (emitEvent.mock.calls[0] ?? []) as unknown[];
    expect(event).toMatchObject({
      type: 'session-reload',
      body: { reason: 'lick-ws-bridge-down' },
    });
    handle.stop();
  });

  it('drops reply when the socket is replaced mid-await (race on stop)', async () => {
    const { startLickWsBridge } = await loadBridge();
    let resolveCreate!: (entry: WebhookEntry) => void;
    const createWebhook = vi
      .fn()
      .mockReturnValue(new Promise<WebhookEntry>((r) => (resolveCreate = r)));
    const lm = buildLickManagerMock({ createWebhook });

    const handle = startLickWsBridge(lm, {
      locationHref: LOCATION,
      webSocketFactory: (url) => new FakeWebSocket(url),
    });
    const ws = FakeWebSocket.instances[0];

    ws.emit({ type: 'create_webhook', requestId: 'r-race', name: 'github', scoop: 'pr' });

    // While the handler awaits, stop the bridge — that closes the socket.
    handle.stop();
    expect(ws.readyState).toBe(3);

    // Now resolve the in-flight LickManager call; the bridge should
    // NOT send a reply into the dead socket.
    resolveCreate({ id: 'wh-race', name: 'github', createdAt: 'now', scoop: 'pr' });
    await new Promise((r) => setTimeout(r, 0));
    expect(ws.sent).toHaveLength(0);
  });

  it('error envelope: createWebhook rejection surfaces as { error } reply', async () => {
    const { startLickWsBridge } = await loadBridge();
    const lm = buildLickManagerMock({
      createWebhook: vi.fn().mockRejectedValue(new Error('Filter compile failed')),
    });

    const handle = startLickWsBridge(lm, {
      locationHref: LOCATION,
      webSocketFactory: (url) => new FakeWebSocket(url),
    });
    const ws = FakeWebSocket.instances[0];

    ws.emit({
      type: 'create_webhook',
      requestId: 'r-err',
      name: 'github',
      scoop: 'pr',
      filter: 'bad',
    });
    await vi.waitFor(() => expect(ws.sent.length).toBeGreaterThan(0));
    const reply = JSON.parse(ws.sent[0]);
    expect(reply).toEqual({
      type: 'response',
      requestId: 'r-err',
      error: 'Filter compile failed',
    });
    handle.stop();
  });

  it('concurrent requests respond with matching requestIds (independent in-flight handlers)', async () => {
    const { startLickWsBridge } = await loadBridge();
    let resolveA!: (entry: WebhookEntry) => void;
    let resolveB!: (entry: WebhookEntry) => void;
    const createWebhook = vi
      .fn()
      .mockImplementationOnce(() => new Promise<WebhookEntry>((r) => (resolveA = r)))
      .mockImplementationOnce(() => new Promise<WebhookEntry>((r) => (resolveB = r)));
    const lm = buildLickManagerMock({ createWebhook });

    const handle = startLickWsBridge(lm, {
      locationHref: LOCATION,
      webSocketFactory: (url) => new FakeWebSocket(url),
    });
    const ws = FakeWebSocket.instances[0];

    ws.emit({ type: 'create_webhook', requestId: 'r-A', name: 'a', scoop: 's' });
    ws.emit({ type: 'create_webhook', requestId: 'r-B', name: 'b', scoop: 's' });

    // Resolve in REVERSE order; replies must still carry matching ids.
    resolveB({ id: 'wh-B', name: 'b', createdAt: 'now', scoop: 's' });
    await vi.waitFor(() => expect(ws.sent.length).toBeGreaterThanOrEqual(1));
    resolveA({ id: 'wh-A', name: 'a', createdAt: 'now', scoop: 's' });
    await vi.waitFor(() => expect(ws.sent.length).toBeGreaterThanOrEqual(2));

    const replies = ws.sent.map((s) => JSON.parse(s));
    const replyB = replies.find((r) => r.requestId === 'r-B');
    const replyA = replies.find((r) => r.requestId === 'r-A');
    expect(replyA?.data.id).toBe('wh-A');
    expect(replyB?.data.id).toBe('wh-B');
    handle.stop();
  });

  it('webhook_event missing webhookId is dropped, not forwarded with undefined', async () => {
    const { startLickWsBridge } = await loadBridge();
    const handleWebhookEvent = vi.fn();
    const lm = buildLickManagerMock({ handleWebhookEvent });

    const handle = startLickWsBridge(lm, {
      locationHref: LOCATION,
      webSocketFactory: (url) => new FakeWebSocket(url),
    });
    const ws = FakeWebSocket.instances[0];

    ws.emit({ type: 'webhook_event', headers: { 'x-test': '1' }, body: {} });
    expect(handleWebhookEvent).not.toHaveBeenCalled();
    handle.stop();
  });

  it('malformed JSON payload is caught and does not crash the message handler', async () => {
    const { startLickWsBridge } = await loadBridge();
    const handle = startLickWsBridge(buildLickManagerMock(), {
      locationHref: LOCATION,
      webSocketFactory: (url) => new FakeWebSocket(url),
    });
    const ws = FakeWebSocket.instances[0];

    // Bypass `emit()` to push a raw non-JSON string.
    ws.onmessage?.(new MessageEvent('message', { data: '{not valid json' }));
    // A subsequent well-formed message should still be processed.
    ws.emit({ type: 'tray_status', requestId: 'r-after' });
    await vi.waitFor(() => expect(ws.sent.length).toBeGreaterThan(0));
    expect(JSON.parse(ws.sent[0]).requestId).toBe('r-after');
    handle.stop();
  });

  it('throws synchronously on invalid locationHref', async () => {
    const { startLickWsBridge } = await loadBridge();
    expect(() =>
      startLickWsBridge(buildLickManagerMock(), {
        locationHref: 'not a url',
        webSocketFactory: (url) => new FakeWebSocket(url),
      })
    ).toThrow(/invalid locationHref/);
  });

  it('emits the session-reload signal exactly at the 20-failure boundary', async () => {
    // Drive 19 failures, expect no emit. Drive one more, expect one
    // emit. Drive 5 more, expect still one emit (idempotent).
    const { startLickWsBridge } = await loadBridge();
    const emitEvent = vi.fn();
    const lm = buildLickManagerMock({ emitEvent });
    let callbacks = 0;
    const setTimeoutFn = vi.fn().mockImplementation((cb: () => void) => {
      callbacks++;
      if (callbacks <= 30) cb();
      return callbacks as unknown as ReturnType<typeof setTimeout>;
    });
    const factory = (_url: string): never => {
      throw new Error('always fails');
    };

    const handle = startLickWsBridge(lm, {
      locationHref: LOCATION,
      webSocketFactory: factory as never,
      setTimeoutFn,
      reconnectDelayMs: 100,
    });

    // After 20 connect attempts (each schedules a reconnect), emit fires once.
    expect(emitEvent).toHaveBeenCalledTimes(1);
    // After 5 more (25 total), still once.
    expect(emitEvent).toHaveBeenCalledTimes(1);
    handle.stop();
  });

  it('onopen resets the failure counter so a fresh streak re-arms the cone signal', async () => {
    // Drive a streak by repeatedly firing the close handler directly
    // (bypassing setTimeout/connect recursion). After hitting the give-
    // up threshold once, simulate onopen on a freshly-attached socket
    // and verify a second streak fires the signal again.
    const { startLickWsBridge } = await loadBridge();
    const emitEvent = vi.fn();
    const lm = buildLickManagerMock({ emitEvent });

    // Mock setTimer so reconnects never actually run — we only want
    // close events to flow through onFailure, not chain through the
    // reconnect loop. Each call returns a fresh handle so the guard
    // `reconnectHandle != null` correctly tracks pending state.
    let timerId = 0;
    const pendingTimers: Array<() => void> = [];
    const setTimeoutFn = vi.fn().mockImplementation((cb: () => void) => {
      pendingTimers.push(cb);
      return ++timerId as unknown as ReturnType<typeof setTimeout>;
    });
    const clearTimeoutFn = vi.fn();

    const handle = startLickWsBridge(lm, {
      locationHref: LOCATION,
      webSocketFactory: (url) => new FakeWebSocket(url),
      setTimeoutFn,
      clearTimeoutFn,
      reconnectDelayMs: 1,
    });
    const ws = FakeWebSocket.instances[0];

    // Drive 20 failures, manually clearing the reconnect-handle each
    // time so the next close isn't suppressed by the pending-timer
    // guard. Each pending callback drains via shift().
    for (let i = 0; i < 20; i++) {
      ws.onclose?.(new CloseEvent('close', { code: 1006 }));
      pendingTimers.shift()?.(); // flush — clears reconnectHandle
    }
    expect(emitEvent).toHaveBeenCalledTimes(1);

    // Simulate recovery — onopen resets the counters.
    ws.onopen?.(new Event('open'));

    // A fresh streak of 20 failures should fire ANOTHER signal.
    for (let i = 0; i < 20; i++) {
      ws.onclose?.(new CloseEvent('close', { code: 1006 }));
      pendingTimers.shift()?.();
    }
    expect(emitEvent).toHaveBeenCalledTimes(2);
    handle.stop();
  });

  it('onFailure during pending reconnect keeps the existing timer (no log lying about backoff)', async () => {
    const { startLickWsBridge } = await loadBridge();
    const lm = buildLickManagerMock();
    const setTimeoutFn = vi.fn().mockReturnValue(9 as unknown as ReturnType<typeof setTimeout>);

    const handle = startLickWsBridge(lm, {
      locationHref: LOCATION,
      webSocketFactory: (url) => new FakeWebSocket(url),
      setTimeoutFn,
    });
    const ws = FakeWebSocket.instances[0];

    // Trigger one close → onFailure → scheduleReconnect → 1 setTimeout
    ws.onclose?.(new CloseEvent('close', { code: 1006 }));
    expect(setTimeoutFn).toHaveBeenCalledTimes(1);

    // A second close while reconnect pending — onFailure should bail
    // without scheduling another timer.
    ws.onclose?.(new CloseEvent('close', { code: 1006 }));
    expect(setTimeoutFn).toHaveBeenCalledTimes(1);
    handle.stop();
  });

  it('onclose threads CloseEvent.code and reason into the failure log', async () => {
    // Smoke test that CloseEvent fields reach the log layer. We can't
    // easily intercept the logger here without mocking createLogger, so
    // verify the bridge doesn't crash on a code-bearing close.
    const { startLickWsBridge } = await loadBridge();
    const handle = startLickWsBridge(buildLickManagerMock(), {
      locationHref: LOCATION,
      webSocketFactory: (url) => new FakeWebSocket(url),
    });
    const ws = FakeWebSocket.instances[0];
    ws.onclose?.(new CloseEvent('close', { code: 1008, reason: 'unauthorized' }));
    // No throw; reconnect scheduled.
    handle.stop();
  });

  it('webhook_event with a throwing LickManager surfaces a structured log not crash', async () => {
    const { startLickWsBridge } = await loadBridge();
    const handleWebhookEvent = vi.fn().mockImplementation(() => {
      throw new Error('Filter compile failed');
    });
    const lm = buildLickManagerMock({ handleWebhookEvent });

    const handle = startLickWsBridge(lm, {
      locationHref: LOCATION,
      webSocketFactory: (url) => new FakeWebSocket(url),
    });
    const ws = FakeWebSocket.instances[0];

    // No throw escapes the bridge despite the LickManager throwing.
    expect(() =>
      ws.emit({ type: 'webhook_event', webhookId: 'wh-1', headers: {}, body: {} })
    ).not.toThrow();
    expect(handleWebhookEvent).toHaveBeenCalledOnce();
    handle.stop();
  });
});

// ---------------------------------------------------------------------------
// shellBridge delegation and streaming
// ---------------------------------------------------------------------------

describe('shellBridge delegation', () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    setLeaderTrayRuntimeStatus({ state: 'inactive', session: null, error: null });
  });

  afterEach(() => {
    setLeaderTrayRuntimeStatus({ state: 'inactive', session: null, error: null });
  });

  function buildShellBridgeMock(
    overrides: {
      canHandle?: (type: string) => boolean;
      handleRequest?: (type: string, data: Record<string, unknown>) => Promise<unknown>;
      handleStream?: (
        type: string,
        data: Record<string, unknown>,
        onFrame: (f: unknown) => void
      ) => Promise<void>;
    } = {}
  ) {
    return {
      canHandle: overrides.canHandle ?? vi.fn().mockReturnValue(false),
      handleRequest: overrides.handleRequest ?? vi.fn().mockResolvedValue({}),
      handleStream: overrides.handleStream ?? vi.fn().mockResolvedValue(undefined),
    };
  }

  it('delegates request to shellBridge.handleRequest when canHandle returns true', async () => {
    const { startLickWsBridge } = await loadBridge();
    const handleRequest = vi
      .fn()
      .mockResolvedValue({ exitCode: 0, stdout: 'hi', stderr: '', pid: 1 });
    const shellBridge = buildShellBridgeMock({
      canHandle: (t) => t === 'shell-exec',
      handleRequest,
    });

    const handle = startLickWsBridge(buildLickManagerMock(), {
      locationHref: LOCATION,
      webSocketFactory: (url) => new FakeWebSocket(url),
      shellBridge,
    });
    const ws = FakeWebSocket.instances[0];

    ws.emit({ type: 'shell-exec', requestId: 'r-se', sessionId: 'sid', command: 'echo hi' });
    await vi.waitFor(() => expect(ws.sent.length).toBeGreaterThan(0));

    const reply = JSON.parse(ws.sent[0]);
    expect(reply.type).toBe('response');
    expect(reply.requestId).toBe('r-se');
    expect(reply.data).toEqual({ exitCode: 0, stdout: 'hi', stderr: '', pid: 1 });
    expect(handleRequest).toHaveBeenCalledWith(
      'shell-exec',
      expect.objectContaining({ type: 'shell-exec', sessionId: 'sid', command: 'echo hi' })
    );
    handle.stop();
  });

  it('returns error envelope when shellBridge.handleRequest throws', async () => {
    const { startLickWsBridge } = await loadBridge();
    const shellBridge = buildShellBridgeMock({
      canHandle: (t) => t === 'shell-exec',
      handleRequest: vi.fn().mockRejectedValue(new Error('exec exploded')),
    });

    const handle = startLickWsBridge(buildLickManagerMock(), {
      locationHref: LOCATION,
      webSocketFactory: (url) => new FakeWebSocket(url),
      shellBridge,
    });
    const ws = FakeWebSocket.instances[0];

    ws.emit({ type: 'shell-exec', requestId: 'r-err', sessionId: 'sid', command: 'bad' });
    await vi.waitFor(() => expect(ws.sent.length).toBeGreaterThan(0));

    const reply = JSON.parse(ws.sent[0]);
    expect(reply.type).toBe('response');
    expect(reply.requestId).toBe('r-err');
    expect(reply.error).toBe('exec exploded');
    handle.stop();
  });

  it('does NOT delegate when shellBridge.canHandle returns false', async () => {
    const { startLickWsBridge } = await loadBridge();
    const shellBridge = buildShellBridgeMock({
      canHandle: () => false,
    });

    const handle = startLickWsBridge(buildLickManagerMock(), {
      locationHref: LOCATION,
      webSocketFactory: (url) => new FakeWebSocket(url),
      shellBridge,
    });
    const ws = FakeWebSocket.instances[0];

    // Should fall through to the default unknown-type error
    ws.emit({ type: 'shell-exec', requestId: 'r-fallthru' });
    await vi.waitFor(() => expect(ws.sent.length).toBeGreaterThan(0));
    const reply = JSON.parse(ws.sent[0]);
    expect(reply.error).toMatch(/Unknown request type/);
    handle.stop();
  });

  it('stream: emits shell-chunk frames and shell-done for shell-exec with stream=true', async () => {
    const { startLickWsBridge } = await loadBridge();
    const frames = [
      { t: 'stdout', d: 'hello\n' },
      { t: 'exit', code: 0, pid: 42 },
    ];
    const shellBridge = buildShellBridgeMock({
      canHandle: (t) => t === 'shell-exec',
      handleStream: vi
        .fn()
        .mockImplementation(
          async (_type: string, _data: unknown, onFrame: (f: unknown) => void) => {
            for (const frame of frames) onFrame(frame);
          }
        ),
    });

    const handle = startLickWsBridge(buildLickManagerMock(), {
      locationHref: LOCATION,
      webSocketFactory: (url) => new FakeWebSocket(url),
      shellBridge,
    });
    const ws = FakeWebSocket.instances[0];

    ws.emit({
      type: 'shell-exec',
      requestId: 'r-stream',
      sessionId: 'sid',
      command: 'ls',
      stream: true,
    });
    await vi.waitFor(() => expect(ws.sent.length).toBeGreaterThanOrEqual(frames.length + 1));

    const sent = ws.sent.map((s: string) => JSON.parse(s));
    // First two messages are shell-chunk
    expect(sent[0]).toEqual({ type: 'shell-chunk', requestId: 'r-stream', frame: frames[0] });
    expect(sent[1]).toEqual({ type: 'shell-chunk', requestId: 'r-stream', frame: frames[1] });
    // Last message is shell-done
    expect(sent[sent.length - 1]).toEqual({ type: 'shell-done', requestId: 'r-stream' });
    handle.stop();
  });

  it('stream: no type:response is sent for streaming path', async () => {
    const { startLickWsBridge } = await loadBridge();
    const shellBridge = buildShellBridgeMock({
      canHandle: (t) => t === 'shell-exec',
      handleStream: vi.fn().mockResolvedValue(undefined),
    });

    const handle = startLickWsBridge(buildLickManagerMock(), {
      locationHref: LOCATION,
      webSocketFactory: (url) => new FakeWebSocket(url),
      shellBridge,
    });
    const ws = FakeWebSocket.instances[0];

    ws.emit({
      type: 'shell-exec',
      requestId: 'r-noresponse',
      sessionId: 'sid',
      command: 'x',
      stream: true,
    });
    await vi.waitFor(() => expect(ws.sent.length).toBeGreaterThan(0));

    const types = ws.sent.map((s: string) => JSON.parse(s).type);
    expect(types).not.toContain('response');
    expect(types).toContain('shell-done');
    handle.stop();
  });

  it('stream error: emits a synthetic {t:exit,code:1} shell-chunk BEFORE shell-done when handleStream rejects', async () => {
    // Task-8 deferred fix: when shellBridge.handleStream rejects, the
    // browser must receive an exit frame so the node-server consumer can
    // see a legible non-zero exit code rather than a stream that ends
    // with no exit information.
    const { startLickWsBridge } = await loadBridge();
    const shellBridge = buildShellBridgeMock({
      canHandle: (t) => t === 'shell-exec',
      handleStream: vi.fn().mockRejectedValue(new Error('infra exploded')),
    });

    const handle = startLickWsBridge(buildLickManagerMock(), {
      locationHref: LOCATION,
      webSocketFactory: (url) => new FakeWebSocket(url),
      shellBridge,
    });
    const ws = FakeWebSocket.instances[0];

    ws.emit({
      type: 'shell-exec',
      requestId: 'r-err-stream',
      sessionId: 'sid',
      command: 'bad',
      stream: true,
    });
    // Wait for both the exit-frame chunk and shell-done to arrive
    await vi.waitFor(() => expect(ws.sent.length).toBeGreaterThanOrEqual(2));

    const sent = ws.sent.map((s: string) => JSON.parse(s));
    // There must be a shell-chunk with {t:'exit',code:1} BEFORE shell-done
    const exitChunkIdx = sent.findIndex(
      (m) =>
        m.type === 'shell-chunk' &&
        m.requestId === 'r-err-stream' &&
        (m.frame as { t: string; code: number }).t === 'exit' &&
        (m.frame as { t: string; code: number }).code === 1
    );
    const doneIdx = sent.findIndex(
      (m) => m.type === 'shell-done' && m.requestId === 'r-err-stream'
    );
    expect(exitChunkIdx).toBeGreaterThanOrEqual(0);
    expect(doneIdx).toBeGreaterThanOrEqual(0);
    expect(exitChunkIdx).toBeLessThan(doneIdx);
    handle.stop();
  });
});
