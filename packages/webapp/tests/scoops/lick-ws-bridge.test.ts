/**
 * Tests for the kernel-host /licks-ws bridge.
 *
 * Verifies wire-protocol fidelity with the legacy page-side handler
 * removed in commit 07cdce16: management requests (list/create/delete
 * webhooks + cron tasks + tray status), inbound events (webhook_event,
 * navigate_event), error envelope, URL construction (standalone vs
 * tray-leader), reconnection on socket close.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { LickManager, WebhookEntry } from '../../src/scoops/lick-manager.js';
import {
  setLeaderTrayRuntimeStatus,
  type LeaderTraySession,
} from '../../src/scoops/tray-leader.js';

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];

  url: string;
  onopen: ((ev?: Event) => void) | null = null;
  onclose: ((ev?: CloseEvent) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
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
    this.onclose?.();
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
      webSocketFactory: (url) => new FakeWebSocket(url) as unknown as WebSocket,
    });

    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakeWebSocket.instances[0].url).toBe('ws://localhost:5710/licks-ws');
    handle.stop();
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
      webSocketFactory: (url) => new FakeWebSocket(url) as unknown as WebSocket,
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
      webSocketFactory: (url) => new FakeWebSocket(url) as unknown as WebSocket,
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
      webSocketFactory: (url) => new FakeWebSocket(url) as unknown as WebSocket,
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
    const lm = buildLickManagerMock({ handleWebhookEvent } as Partial<LickManager>);

    const handle = startLickWsBridge(lm, {
      locationHref: LOCATION,
      webSocketFactory: (url) => new FakeWebSocket(url) as unknown as WebSocket,
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

  it('forwards navigate_event payloads as navigate licks when sliccHeader + url are present', async () => {
    const { startLickWsBridge } = await loadBridge();
    const emitEvent = vi.fn();
    const lm = buildLickManagerMock({ emitEvent } as Partial<LickManager>);

    const handle = startLickWsBridge(lm, {
      locationHref: LOCATION,
      webSocketFactory: (url) => new FakeWebSocket(url) as unknown as WebSocket,
    });
    const ws = FakeWebSocket.instances[0];

    ws.emit({
      type: 'navigate_event',
      sliccHeader: 'handoff:do-thing',
      url: 'about:handoff',
      title: 'Hand off',
      timestamp: '2026-05-21T00:00:00.000Z',
    });

    expect(emitEvent).toHaveBeenCalledWith({
      type: 'navigate',
      navigateUrl: 'about:handoff',
      targetScoop: undefined,
      timestamp: '2026-05-21T00:00:00.000Z',
      body: {
        url: 'about:handoff',
        sliccHeader: 'handoff:do-thing',
        title: 'Hand off',
      },
    });
    handle.stop();
  });

  it('ignores navigate_event without sliccHeader', async () => {
    const { startLickWsBridge } = await loadBridge();
    const emitEvent = vi.fn();
    const lm = buildLickManagerMock({ emitEvent } as Partial<LickManager>);

    const handle = startLickWsBridge(lm, {
      locationHref: LOCATION,
      webSocketFactory: (url) => new FakeWebSocket(url) as unknown as WebSocket,
    });
    const ws = FakeWebSocket.instances[0];

    ws.emit({ type: 'navigate_event', url: 'about:handoff' });
    expect(emitEvent).not.toHaveBeenCalled();
    handle.stop();
  });

  it('responds with unknown-type error for unrecognized requests', async () => {
    const { startLickWsBridge } = await loadBridge();
    const handle = startLickWsBridge(buildLickManagerMock(), {
      locationHref: LOCATION,
      webSocketFactory: (url) => new FakeWebSocket(url) as unknown as WebSocket,
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
      webSocketFactory: (url) => new FakeWebSocket(url) as unknown as WebSocket,
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

  it('reconnects after the socket closes', async () => {
    const { startLickWsBridge } = await loadBridge();
    const setTimeoutFn = vi.fn().mockImplementation((cb: () => void) => {
      cb();
      return 1 as unknown as ReturnType<typeof setTimeout>;
    });

    const handle = startLickWsBridge(buildLickManagerMock(), {
      locationHref: LOCATION,
      webSocketFactory: (url) => new FakeWebSocket(url) as unknown as WebSocket,
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
      webSocketFactory: (url) => new FakeWebSocket(url) as unknown as WebSocket,
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
});
