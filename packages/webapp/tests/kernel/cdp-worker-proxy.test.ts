/**
 * Tests for `WorkerCdpProxy` ⇄ `startPageCdpForwarder` round-trips.
 *
 * Runs both sides in-process over a `MessageChannel` pair, with a
 * stub `CDPTransport` standing in for the real WebSocket-backed
 * `CDPClient`. Pins:
 *   - command request/response over the wire
 *   - command-error propagation
 *   - subscribe/unsubscribe protocol mirrors into `realTransport.on/off`
 *   - subscribed events flow worker-ward; unsubscribed events do not
 *   - tearing down the forwarder cleans up real-transport subscriptions
 */

import { describe, it, expect, vi } from 'vitest';
import { WorkerCdpProxy, startPageCdpForwarder } from '../../src/kernel/cdp-worker-proxy.js';
import type { CDPTransport } from '../../src/cdp/transport.js';
import type { CDPEventListener, ConnectionState } from '../../src/cdp/types.js';

function tick(ms = 5): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Stub `CDPTransport` that records `on/off` calls and lets the test
 * fire events into registered listeners directly.
 */
function makeStubTransport(): {
  transport: CDPTransport;
  fire: (event: string, params?: Record<string, unknown>) => void;
  send: ReturnType<typeof vi.fn>;
  listenerCount: (event: string) => number;
} {
  const listeners = new Map<string, Set<CDPEventListener>>();
  const send = vi.fn(async (method: string, _params?: Record<string, unknown>) => {
    if (method === 'Boom') throw new Error('boom');
    return { ok: true, method };
  });
  const transport: CDPTransport = {
    state: 'connected' as ConnectionState,
    connect: async () => {},
    disconnect: () => {},
    send: send as unknown as CDPTransport['send'],
    on(event, listener) {
      let set = listeners.get(event);
      if (!set) {
        set = new Set();
        listeners.set(event, set);
      }
      set.add(listener);
    },
    off(event, listener) {
      const set = listeners.get(event);
      if (set) {
        set.delete(listener);
        if (set.size === 0) listeners.delete(event);
      }
    },
    once: async () => ({}),
  };
  return {
    transport,
    fire: (event, params) => {
      const set = listeners.get(event);
      if (!set) return;
      for (const l of set) l(params ?? {});
    },
    send,
    listenerCount: (event) => listeners.get(event)?.size ?? 0,
  };
}

describe('WorkerCdpProxy ⇄ startPageCdpForwarder', () => {
  it('command round-trips: worker send → page real-transport → response', async () => {
    const channel = new MessageChannel();
    const stub = makeStubTransport();
    const stop = startPageCdpForwarder(channel.port1, stub.transport);

    const worker = new WorkerCdpProxy(channel.port2);
    await worker.connect();

    const result = await worker.send('Page.navigate', { url: 'https://example.com' });
    expect(result).toEqual({ ok: true, method: 'Page.navigate' });
    expect(stub.send).toHaveBeenCalledWith(
      'Page.navigate',
      { url: 'https://example.com' },
      undefined
    );

    worker.disconnect();
    stop();
    channel.port1.close();
    channel.port2.close();
  });

  it('command errors propagate as rejection on the worker side', async () => {
    const channel = new MessageChannel();
    const stub = makeStubTransport();
    const stop = startPageCdpForwarder(channel.port1, stub.transport);

    const worker = new WorkerCdpProxy(channel.port2);
    await worker.connect();

    await expect(worker.send('Boom')).rejects.toThrow('boom');

    worker.disconnect();
    stop();
    channel.port1.close();
    channel.port2.close();
  });

  it('on() triggers cdp-subscribe; off() triggers cdp-unsubscribe', async () => {
    const channel = new MessageChannel();
    const stub = makeStubTransport();
    const stop = startPageCdpForwarder(channel.port1, stub.transport);

    const worker = new WorkerCdpProxy(channel.port2);
    await worker.connect();

    expect(stub.listenerCount('Page.frameNavigated')).toBe(0);

    const listener = vi.fn();
    worker.on('Page.frameNavigated', listener);
    await tick();
    expect(stub.listenerCount('Page.frameNavigated')).toBe(1);

    worker.off('Page.frameNavigated', listener);
    await tick();
    expect(stub.listenerCount('Page.frameNavigated')).toBe(0);

    worker.disconnect();
    stop();
    channel.port1.close();
    channel.port2.close();
  });

  it('events flow worker-ward only while subscribed', async () => {
    const channel = new MessageChannel();
    const stub = makeStubTransport();
    const stop = startPageCdpForwarder(channel.port1, stub.transport);

    const worker = new WorkerCdpProxy(channel.port2);
    await worker.connect();

    const seen: Array<Record<string, unknown>> = [];
    const listener: CDPEventListener = (params) => seen.push(params);
    worker.on('Target.targetCreated', listener);
    await tick();

    stub.fire('Target.targetCreated', { targetId: 't1' });
    stub.fire('Target.targetCreated', { targetId: 't2' });
    await tick();

    expect(seen).toEqual([{ targetId: 't1' }, { targetId: 't2' }]);

    worker.off('Target.targetCreated', listener);
    await tick();

    // After unsubscribe, fired events should NOT reach the worker.
    stub.fire('Target.targetCreated', { targetId: 't3' });
    await tick();
    expect(seen).toEqual([{ targetId: 't1' }, { targetId: 't2' }]);

    worker.disconnect();
    stop();
    channel.port1.close();
    channel.port2.close();
  });

  it('forwarder stop() removes any leftover listeners on the real transport', async () => {
    const channel = new MessageChannel();
    const stub = makeStubTransport();
    const stop = startPageCdpForwarder(channel.port1, stub.transport);

    const worker = new WorkerCdpProxy(channel.port2);
    await worker.connect();

    worker.on('Page.frameNavigated', vi.fn());
    worker.on('Target.targetCreated', vi.fn());
    await tick();
    expect(stub.listenerCount('Page.frameNavigated')).toBe(1);
    expect(stub.listenerCount('Target.targetCreated')).toBe(1);

    stop();
    expect(stub.listenerCount('Page.frameNavigated')).toBe(0);
    expect(stub.listenerCount('Target.targetCreated')).toBe(0);

    worker.disconnect();
    channel.port1.close();
    channel.port2.close();
  });
});
