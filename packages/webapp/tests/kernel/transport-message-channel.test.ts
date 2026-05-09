/**
 * Unit tests for the MessageChannel-based KernelTransport adapter.
 *
 * Pins:
 *  - bidirectional round-trip across a `MessageChannel` pair
 *  - structured-clone for object payloads
 *  - `start()` is called on first subscribe so queued pre-subscribe
 *    messages are delivered (via tightening the subscribe order)
 *  - unsubscribe stops further deliveries to that handler
 *  - multiple subscribers each get every message
 */

import { describe, it, expect } from 'vitest';
import { createMessageChannelTransport } from '../../src/kernel/transport-message-channel.js';

interface UpMsg {
  type: 'up';
  n: number;
  payload?: { nested: boolean };
}
interface DownMsg {
  type: 'down';
  n: number;
}

function tick(ms = 5): Promise<void> {
  // MessageChannel delivery in Node hops the event loop; setTimeout
  // gives it room to flush across both ports before assertions run.
  return new Promise((r) => setTimeout(r, ms));
}

describe('createMessageChannelTransport', () => {
  it('delivers messages in both directions across a MessageChannel pair', async () => {
    const channel = new MessageChannel();
    const a = createMessageChannelTransport<DownMsg, UpMsg>(channel.port1);
    const b = createMessageChannelTransport<UpMsg, DownMsg>(channel.port2);

    const aIn: DownMsg[] = [];
    const bIn: UpMsg[] = [];
    a.onMessage((m) => aIn.push(m));
    b.onMessage((m) => bIn.push(m));

    a.send({ type: 'up', n: 1 });
    a.send({ type: 'up', n: 2, payload: { nested: true } });
    b.send({ type: 'down', n: 99 });

    await tick();

    expect(bIn).toEqual([
      { type: 'up', n: 1 },
      { type: 'up', n: 2, payload: { nested: true } },
    ]);
    expect(aIn).toEqual([{ type: 'down', n: 99 }]);

    channel.port1.close();
    channel.port2.close();
  });

  it('unsubscribe stops further deliveries', async () => {
    const channel = new MessageChannel();
    const a = createMessageChannelTransport<UpMsg, UpMsg>(channel.port1);
    const b = createMessageChannelTransport<UpMsg, UpMsg>(channel.port2);

    const seen: UpMsg[] = [];
    const off = b.onMessage((m) => seen.push(m));

    a.send({ type: 'up', n: 1 });
    await tick();
    expect(seen).toHaveLength(1);

    off();
    a.send({ type: 'up', n: 2 });
    await tick();
    expect(seen).toHaveLength(1);

    channel.port1.close();
    channel.port2.close();
  });

  it('multiple subscribers each receive every message', async () => {
    const channel = new MessageChannel();
    const a = createMessageChannelTransport<UpMsg, UpMsg>(channel.port1);
    const b = createMessageChannelTransport<UpMsg, UpMsg>(channel.port2);

    const seenA: UpMsg[] = [];
    const seenB: UpMsg[] = [];
    b.onMessage((m) => seenA.push(m));
    b.onMessage((m) => seenB.push(m));

    a.send({ type: 'up', n: 7 });
    a.send({ type: 'up', n: 8 });
    await tick();

    expect(seenA).toEqual([
      { type: 'up', n: 7 },
      { type: 'up', n: 8 },
    ]);
    expect(seenB).toEqual([
      { type: 'up', n: 7 },
      { type: 'up', n: 8 },
    ]);

    channel.port1.close();
    channel.port2.close();
  });

  it('messages sent before any subscriber are queued and delivered after start()', async () => {
    const channel = new MessageChannel();
    const a = createMessageChannelTransport<UpMsg, UpMsg>(channel.port1);
    const b = createMessageChannelTransport<UpMsg, UpMsg>(channel.port2);

    a.send({ type: 'up', n: 100 });
    a.send({ type: 'up', n: 101 });

    // Subscriber attaches AFTER messages were sent. The transport calls
    // port.start() on first subscribe, which flushes the queue.
    const seen: UpMsg[] = [];
    b.onMessage((m) => seen.push(m));
    await tick();

    expect(seen).toEqual([
      { type: 'up', n: 100 },
      { type: 'up', n: 101 },
    ]);

    channel.port1.close();
    channel.port2.close();
  });
});
