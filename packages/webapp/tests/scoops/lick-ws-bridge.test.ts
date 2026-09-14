import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LickManager, WebhookEntry } from '../../src/scoops/lick-manager.js';
import {
  type LeaderTraySession,
  setLeaderTrayRuntimeStatus,
} from '../../src/scoops/tray-leader.js';

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];

  url: string;

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

  it('prefers the lickWsUrl override over the locationHref-derived URL', async () => {
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
    const { startLickWsBridge } = await loadBridge();

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

      reconnectDelayMs: 60_000,
    });

    await new Promise((r) => setTimeout(r, 0));

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

  it('answers a webhook_event WITH requestId with the delivery disposition', async () => {
    const { startLickWsBridge } = await loadBridge();
    const handleWebhookEvent = vi.fn().mockReturnValue('unresolved-target');
    const lm = buildLickManagerMock({ handleWebhookEvent });

    const handle = startLickWsBridge(lm, {
      locationHref: LOCATION,
      webSocketFactory: (url) => new FakeWebSocket(url),
    });
    const ws = FakeWebSocket.instances[0];

    ws.emit({
      type: 'webhook_event',
      requestId: 'r-wh',
      webhookId: 'wh-1',
      headers: { 'x-test': '1' },
      body: { hello: 'world' },
    });

    await vi.waitFor(() => expect(ws.sent.length).toBeGreaterThan(0));
    expect(JSON.parse(ws.sent[0])).toEqual({
      type: 'response',
      requestId: 'r-wh',
      data: { disposition: 'unresolved-target' },
    });
    handle.stop();
  });

  it('reports `malformed` for a request-shaped webhook_event with no webhookId', async () => {
    const { startLickWsBridge } = await loadBridge();
    const lm = buildLickManagerMock({ handleWebhookEvent: vi.fn() });

    const handle = startLickWsBridge(lm, {
      locationHref: LOCATION,
      webSocketFactory: (url) => new FakeWebSocket(url),
    });
    const ws = FakeWebSocket.instances[0];

    ws.emit({ type: 'webhook_event', requestId: 'r-bad', headers: {}, body: {} });

    await vi.waitFor(() => expect(ws.sent.length).toBeGreaterThan(0));
    expect(JSON.parse(ws.sent[0]).data).toEqual({ disposition: 'malformed' });
    handle.stop();
  });

  it('reports `failed` when the LickManager throws on a request-shaped delivery', async () => {
    const { startLickWsBridge } = await loadBridge();
    const lm = buildLickManagerMock({
      handleWebhookEvent: vi.fn(() => {
        throw new Error('Filter compile failed');
      }),
    });

    const handle = startLickWsBridge(lm, {
      locationHref: LOCATION,
      webSocketFactory: (url) => new FakeWebSocket(url),
    });
    const ws = FakeWebSocket.instances[0];

    ws.emit({ type: 'webhook_event', requestId: 'r-throw', webhookId: 'wh-1', body: {} });

    await vi.waitFor(() => expect(ws.sent.length).toBeGreaterThan(0));
    expect(JSON.parse(ws.sent[0]).data).toEqual({ disposition: 'failed' });
    handle.stop();
  });

  it('forwards navigate_event payloads as navigate licks using the {verb, target, url} shape', async () => {
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

  it('forwards hostfs_invalidate to onHostfsInvalidate and drops bad payloads', async () => {
    const { startLickWsBridge } = await loadBridge();
    const onHostfsInvalidate = vi.fn();
    const lm = buildLickManagerMock();

    const handle = startLickWsBridge(lm, {
      locationHref: LOCATION,
      webSocketFactory: (url) => new FakeWebSocket(url),
      onHostfsInvalidate,
    });
    const ws = FakeWebSocket.instances[0];

    ws.emit({
      type: 'hostfs_invalidate',
      mount: '/mnt/kb',
      paths: ['notes.md', 'sub/a.txt'],
      timestamp: '2026-09-03T00:00:00.000Z',
    });
    expect(onHostfsInvalidate).toHaveBeenCalledWith({
      type: 'hostfs_invalidate',
      mount: '/mnt/kb',
      paths: ['notes.md', 'sub/a.txt'],
      timestamp: '2026-09-03T00:00:00.000Z',
    });

    onHostfsInvalidate.mockClear();
    ws.emit({ type: 'hostfs_invalidate', paths: ['x'] });
    expect(onHostfsInvalidate).not.toHaveBeenCalled();
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

    ws.emit({ type: 'navigate_event', target: 'x', url: 'about:handoff' });

    ws.emit({ type: 'navigate_event', verb: 'handoff', url: 'about:handoff' });

    ws.emit({ type: 'navigate_event', verb: 'handoff', target: 'x' });

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

    const setTimeoutFn = vi.fn().mockImplementation((cb: () => void, delay: number) => {
      delays.push(delay);

      if (delays.length <= 6) cb();
      return delays.length as unknown as ReturnType<typeof setTimeout>;
    });

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

    handle.stop();
    expect(ws.readyState).toBe(3);

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

    ws.onmessage?.(new MessageEvent('message', { data: '{not valid json' }));

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

    expect(emitEvent).toHaveBeenCalledTimes(1);

    expect(emitEvent).toHaveBeenCalledTimes(1);
    handle.stop();
  });

  it('onopen resets the failure counter so a fresh streak re-arms the cone signal', async () => {
    const { startLickWsBridge } = await loadBridge();
    const emitEvent = vi.fn();
    const lm = buildLickManagerMock({ emitEvent });

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

    for (let i = 0; i < 20; i++) {
      ws.onclose?.(new CloseEvent('close', { code: 1006 }));
      pendingTimers.shift()?.();
    }
    expect(emitEvent).toHaveBeenCalledTimes(1);

    ws.onopen?.(new Event('open'));

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

    ws.onclose?.(new CloseEvent('close', { code: 1006 }));
    expect(setTimeoutFn).toHaveBeenCalledTimes(1);

    ws.onclose?.(new CloseEvent('close', { code: 1006 }));
    expect(setTimeoutFn).toHaveBeenCalledTimes(1);
    handle.stop();
  });

  it('onclose threads CloseEvent.code and reason into the failure log', async () => {
    const { startLickWsBridge } = await loadBridge();
    const handle = startLickWsBridge(buildLickManagerMock(), {
      locationHref: LOCATION,
      webSocketFactory: (url) => new FakeWebSocket(url),
    });
    const ws = FakeWebSocket.instances[0];
    ws.onclose?.(new CloseEvent('close', { code: 1008, reason: 'unauthorized' }));

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

    expect(() =>
      ws.emit({ type: 'webhook_event', webhookId: 'wh-1', headers: {}, body: {} })
    ).not.toThrow();
    expect(handleWebhookEvent).toHaveBeenCalledOnce();
    handle.stop();
  });
});

describe('mapDiscoveryPayloadToLickEvent', () => {
  it('maps a well-formed discovery payload to a discovery LickEvent', async () => {
    const { mapDiscoveryPayloadToLickEvent } = await loadBridge();
    const event = mapDiscoveryPayloadToLickEvent({
      discoveryOrigin: 'https://example.com',
      discoveryKind: 'ai-catalog',
      discoveryUrl: 'https://example.com/.well-known/ai-catalog.json',
      url: 'https://example.com/page',
    });
    expect(event).toMatchObject({
      type: 'discovery',
      discoveryOrigin: 'https://example.com',
      discoveryKind: 'ai-catalog',
      discoveryUrl: 'https://example.com/.well-known/ai-catalog.json',
      discoverySource: 'live-navigation',
      body: {
        origin: 'https://example.com',
        kind: 'ai-catalog',
        url: 'https://example.com/.well-known/ai-catalog.json',
        pageUrl: 'https://example.com/page',
      },
    });
    expect(typeof event?.timestamp).toBe('string');
  });

  it('accepts the llms-txt kind', async () => {
    const { mapDiscoveryPayloadToLickEvent } = await loadBridge();
    const event = mapDiscoveryPayloadToLickEvent({
      discoveryOrigin: 'https://example.com',
      discoveryKind: 'llms-txt',
      discoveryUrl: 'https://example.com/llms.txt',
      url: 'https://example.com/',
    });
    expect(event?.discoveryKind).toBe('llms-txt');
  });

  it('preserves a provided timestamp', async () => {
    const { mapDiscoveryPayloadToLickEvent } = await loadBridge();
    const event = mapDiscoveryPayloadToLickEvent({
      discoveryOrigin: 'https://example.com',
      discoveryKind: 'ai-catalog',
      discoveryUrl: 'https://example.com/.well-known/ai-catalog.json',
      url: 'https://example.com/',
      timestamp: '2020-01-01T00:00:00.000Z',
    });
    expect(event?.timestamp).toBe('2020-01-01T00:00:00.000Z');
  });

  it('returns null when required discovery fields are missing or invalid', async () => {
    const { mapDiscoveryPayloadToLickEvent } = await loadBridge();
    expect(mapDiscoveryPayloadToLickEvent({})).toBeNull();
    expect(
      mapDiscoveryPayloadToLickEvent({
        discoveryOrigin: 'https://example.com',
        discoveryKind: 'ai-catalog',

        url: 'https://example.com/',
      })
    ).toBeNull();
    expect(
      mapDiscoveryPayloadToLickEvent({
        discoveryOrigin: 'https://example.com',
        discoveryKind: 'not-a-kind',
        discoveryUrl: 'https://example.com/x',
        url: 'https://example.com/',
      })
    ).toBeNull();
  });
});
