/**
 * Lick-back outbound routing on the lick bridge. A cup page pushes a
 * no-`requestId` `{ type: 'lickback-event', channel, event }` over `/licks-ws`;
 * the bridge forwards it to the registered sink (the LickbackRegistry's
 * `enqueue`). Standalone-only: extension has no node-server (spec §11).
 */
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { createLickBridge } from '../../src/routes/lick-bridge.js';

class FakeClient extends EventEmitter {
  readyState = WebSocket.OPEN;
  sent: string[] = [];
  send(msg: string): void {
    this.sent.push(msg);
  }
}

function connect(bridge: ReturnType<typeof createLickBridge>): FakeClient {
  const c = new FakeClient();
  bridge.lickWss.emit('connection', c);
  return c;
}

function push(c: FakeClient, msg: unknown): void {
  c.emit('message', Buffer.from(JSON.stringify(msg)));
}

describe('lick bridge — lickback-event routing', () => {
  it('forwards a browser lickback-event push to the registered sink', () => {
    const bridge = createLickBridge();
    const sink = vi.fn();
    bridge.setLickbackSink(sink);
    const c = connect(bridge);
    push(c, {
      type: 'lickback-event',
      channel: 'chat',
      event: { kind: 'chat', text: 'hi', msgId: 'm1' },
    });
    expect(sink).toHaveBeenCalledWith('chat', { kind: 'chat', text: 'hi', msgId: 'm1' });
  });

  it('defaults the channel to "chat" when the push omits it', () => {
    const bridge = createLickBridge();
    const sink = vi.fn();
    bridge.setLickbackSink(sink);
    const c = connect(bridge);
    push(c, { type: 'lickback-event', event: { kind: 'chat', text: 'hi' } });
    expect(sink).toHaveBeenCalledWith('chat', { kind: 'chat', text: 'hi' });
  });

  it('drops a lickback-event when no sink is registered (does not throw)', () => {
    const bridge = createLickBridge();
    const c = connect(bridge);
    expect(() => push(c, { type: 'lickback-event', channel: 'chat', event: {} })).not.toThrow();
  });

  it('does not treat lickback-event as a steering request (no reply sent back)', () => {
    const bridge = createLickBridge();
    bridge.setLickbackSink(vi.fn());
    const c = connect(bridge);
    push(c, { type: 'lickback-event', channel: 'chat', event: { kind: 'chat', text: 'x' } });
    expect(c.sent).toHaveLength(0);
  });
});
