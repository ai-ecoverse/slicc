/**
 * Lick-back additions to the /licks-ws bridge: an outbound `pushLickbackEvent`
 * (cup page → node-server) and inbound `lickback-reply` dispatch
 * (node-server → page via `onLickbackReply`). Standalone-only (spec §11).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LickManager } from '../../src/scoops/lick-manager.js';

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  url: string;
  readyState = 1;
  onopen: ((ev: Event) => unknown) | null = null;
  onclose: ((ev: CloseEvent) => unknown) | null = null;
  onmessage: ((ev: MessageEvent) => unknown) | null = null;
  onerror: ((ev: Event) => unknown) | null = null;
  sent: string[] = [];
  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }
  send(payload: string): void {
    this.sent.push(payload);
  }
  close(): void {
    this.readyState = 3;
    this.onclose?.(new CloseEvent('close'));
  }
  emit(payload: unknown): void {
    this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(payload) }));
  }
}

function buildLickManagerMock(): LickManager {
  return { emitEvent: vi.fn(), handleWebhookEvent: vi.fn() } as unknown as LickManager;
}

const LOCATION = 'http://localhost:5710/index.html';

async function loadBridge() {
  return await import('../../src/scoops/lick-ws-bridge.js');
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('lick-ws-bridge — lick-back', () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('pushLickbackEvent sends a lickback-event frame over the open socket', async () => {
    const { startLickWsBridge } = await loadBridge();
    const handle = startLickWsBridge(buildLickManagerMock(), {
      locationHref: LOCATION,
      webSocketFactory: (url) => new FakeWebSocket(url),
    });
    const ws = FakeWebSocket.instances[0];
    handle.pushLickbackEvent('chat', { kind: 'chat', text: 'hi', msgId: 'm1' });
    expect(ws.sent).toContain(
      JSON.stringify({
        type: 'lickback-event',
        channel: 'chat',
        event: { kind: 'chat', text: 'hi', msgId: 'm1' },
      })
    );
    handle.stop();
  });

  it('pushLickbackEvent is a no-op (no throw) when the socket is not open', async () => {
    const { startLickWsBridge } = await loadBridge();
    const handle = startLickWsBridge(buildLickManagerMock(), {
      locationHref: LOCATION,
      webSocketFactory: (url) => new FakeWebSocket(url),
    });
    const ws = FakeWebSocket.instances[0];
    ws.readyState = 3; // CLOSED
    expect(() => handle.pushLickbackEvent('chat', { kind: 'chat', text: 'x' })).not.toThrow();
    expect(ws.sent).toHaveLength(0);
    handle.stop();
  });

  it('dispatches an inbound lickback-reply to onLickbackReply', async () => {
    const { startLickWsBridge } = await loadBridge();
    const onLickbackReply = vi.fn();
    const handle = startLickWsBridge(buildLickManagerMock(), {
      locationHref: LOCATION,
      webSocketFactory: (url) => new FakeWebSocket(url),
      onLickbackReply,
    });
    const ws = FakeWebSocket.instances[0];
    ws.emit({
      type: 'lickback-reply',
      channel: 'chat',
      replyTo: 'm1',
      delta: 'Hello',
      done: false,
    });
    await flush();
    expect(onLickbackReply).toHaveBeenCalledWith({
      channel: 'chat',
      replyTo: 'm1',
      delta: 'Hello',
      text: undefined,
      done: undefined,
    });
    handle.stop();
  });

  it('carries the done flag through on a terminal reply frame', async () => {
    const { startLickWsBridge } = await loadBridge();
    const onLickbackReply = vi.fn();
    const handle = startLickWsBridge(buildLickManagerMock(), {
      locationHref: LOCATION,
      webSocketFactory: (url) => new FakeWebSocket(url),
      onLickbackReply,
    });
    FakeWebSocket.instances[0].emit({
      type: 'lickback-reply',
      channel: 'chat',
      replyTo: 'm1',
      done: true,
    });
    await flush();
    expect(onLickbackReply).toHaveBeenCalledWith({
      channel: 'chat',
      replyTo: 'm1',
      delta: undefined,
      text: undefined,
      done: true,
    });
    handle.stop();
  });

  it('does not call onLickbackReply for unrelated push events', async () => {
    const { startLickWsBridge } = await loadBridge();
    const onLickbackReply = vi.fn();
    const handle = startLickWsBridge(buildLickManagerMock(), {
      locationHref: LOCATION,
      webSocketFactory: (url) => new FakeWebSocket(url),
      onLickbackReply,
    });
    FakeWebSocket.instances[0].emit({ type: 'webhook_event', webhookId: 'w1', body: {} });
    await flush();
    expect(onLickbackReply).not.toHaveBeenCalled();
    handle.stop();
  });
});
