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
 *   - a page-client drop crosses the hop as `cdp-reset` (issue #2417): pending
 *     commands reject, `state` flips, `connect()` is re-callable, and event
 *     subscriptions survive the page client's reconnect
 */

import { describe, expect, it, vi } from 'vitest';
import type { CDPStateListener, CDPTransport } from '../../src/cdp/transport.js';
import type { CDPEventListener, ConnectionState } from '../../src/cdp/types.js';
import { startPageCdpForwarder, WorkerCdpProxy } from '../../src/kernel/cdp-worker-proxy.js';

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
  /** Move the stub's connection state and notify `onStateChange` subscribers. */
  setState: (state: ConnectionState, reason?: string) => void;
  /** Notify without changing state — mimics `CDPClient`'s cleanup+close pair. */
  notifyState: (state: ConnectionState, reason?: string) => void;
  /** Forget every registration, as a real client reconnect can. */
  dropListeners: () => void;
} {
  const listeners = new Map<string, Set<CDPEventListener>>();
  const stateListeners = new Set<CDPStateListener>();
  let state: ConnectionState = 'connected';
  const notifyState = (next: ConnectionState, reason?: string): void => {
    for (const listener of stateListeners) listener(next, reason);
  };
  const send = vi.fn(async (method: string, _params?: Record<string, unknown>) => {
    if (method === 'Boom') throw new Error('boom');
    // Stands in for a command the page client can never answer because its
    // socket died mid-flight.
    if (method === 'Hang') return new Promise<never>(() => {});
    return { ok: true, method };
  });
  const transport: CDPTransport = {
    get state(): ConnectionState {
      return state;
    },
    onStateChange(listener) {
      stateListeners.add(listener);
      return () => {
        stateListeners.delete(listener);
      };
    },
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
    setState: (next, reason) => {
      state = next;
      notifyState(next, reason);
    },
    notifyState,
    dropListeners: () => listeners.clear(),
  };
}

/** Record every raw envelope the page side puts on the wire. */
function tapWire(port: MessagePort): Array<{ type?: string; reason?: string }> {
  const seen: Array<{ type?: string; reason?: string }> = [];
  port.addEventListener('message', (event) => {
    seen.push((event as MessageEvent).data as { type?: string; reason?: string });
  });
  return seen;
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

  it('drops malformed cdp-response envelopes (id missing) without crashing', async () => {
    const channel = new MessageChannel();
    const stub = makeStubTransport();
    const stop = startPageCdpForwarder(channel.port1, stub.transport);

    const worker = new WorkerCdpProxy(channel.port2);
    await worker.connect();

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    // Pump a malformed response directly down the wire. The worker's
    // parseResponse should ignore it (warn-and-drop) instead of
    // routing to `pendingCommands.get(undefined)` and silently
    // wedging in-flight commands.
    channel.port1.postMessage({ type: 'cdp-response' /* no id */ });
    await tick();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('cdp-response with invalid id'),
      expect.anything()
    );
    // A real command issued after the malformed message must still
    // round-trip — i.e. the proxy isn't wedged.
    const result = await worker.send('Page.enable');
    expect(result).toEqual({ ok: true, method: 'Page.enable' });
    warn.mockRestore();
    stop();
    worker.disconnect();
    channel.port1.close();
    channel.port2.close();
  });

  it('drops malformed cdp-event envelopes (method missing) without crashing', async () => {
    const channel = new MessageChannel();
    const stub = makeStubTransport();
    const stop = startPageCdpForwarder(channel.port1, stub.transport);
    const worker = new WorkerCdpProxy(channel.port2);
    await worker.connect();

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const handler = vi.fn();
    worker.on('Page.frameNavigated', handler);
    await tick();

    channel.port1.postMessage({ type: 'cdp-event' /* no method */, params: {} });
    await tick();

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('cdp-event with invalid method'),
      expect.anything()
    );
    expect(handler).not.toHaveBeenCalled();
    warn.mockRestore();
    stop();
    worker.disconnect();
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

describe('page CDP connection resets across the worker hop', () => {
  /** Wire up both sides plus a wire tap and silence the reset/ready logs. */
  function setup(): {
    channel: MessageChannel;
    stub: ReturnType<typeof makeStubTransport>;
    worker: WorkerCdpProxy;
    wire: ReturnType<typeof tapWire>;
    teardown: () => void;
  } {
    const channel = new MessageChannel();
    const stub = makeStubTransport();
    const stop = startPageCdpForwarder(channel.port1, stub.transport);
    const wire = tapWire(channel.port2);
    const worker = new WorkerCdpProxy(channel.port2);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    return {
      channel,
      stub,
      worker,
      wire,
      teardown: () => {
        warn.mockRestore();
        info.mockRestore();
        worker.disconnect();
        stop();
        channel.port1.close();
        channel.port2.close();
      },
    };
  }

  it('forwards a page-client drop as cdp-reset; pending commands reject and state flips', async () => {
    const { stub, worker, wire, teardown } = setup();
    await worker.connect();

    // In flight when the socket dies — the page can never answer it.
    const rejected = expect(worker.send('Hang')).rejects.toThrow(
      /upstream CDP connection was reset/
    );
    await tick();

    stub.setState('disconnected', 'CDP connection closed');
    await tick();

    await rejected;
    expect(wire.filter((m) => m.type === 'cdp-reset')).toEqual([
      { type: 'cdp-reset', reason: 'CDP connection closed' },
    ]);
    // The flip is the whole point: it's what `BrowserAPI.ensureConnected()`
    // reads to drop its stale session instead of driving a dead one.
    expect(worker.state).toBe('disconnected');
    await expect(worker.send('Page.enable')).rejects.toThrow('WorkerCdpProxy is not connected');

    teardown();
  });

  it('collapses the close/cleanup notification pair into a single cdp-reset', async () => {
    const { stub, worker, wire, teardown } = setup();
    await worker.connect();

    // `CDPClient` announces the drop twice: once from cleanup() with a
    // generic reason, once from handleClose() with the close reason.
    stub.setState('disconnected', 'CDP client disconnected');
    stub.notifyState('disconnected', 'CDP connection closed');
    await tick();

    expect(wire.filter((m) => m.type === 'cdp-reset')).toHaveLength(1);

    teardown();
  });

  it('connect() is re-callable after a reset and commands round-trip again', async () => {
    const { stub, worker, teardown } = setup();
    await worker.connect();

    stub.setState('disconnected', 'CDP connection closed');
    await tick();
    expect(worker.state).toBe('disconnected');

    await worker.connect();
    expect(worker.state).toBe('connected');

    stub.setState('connected');
    await tick();

    const result = await worker.send('Page.enable');
    expect(result).toEqual({ ok: true, method: 'Page.enable' });

    teardown();
  });

  it('does not double-dispatch after a reset + reconnect', async () => {
    const { stub, worker, teardown } = setup();
    await worker.connect();

    const listener = vi.fn();
    worker.on('Target.targetCreated', listener);
    await tick();

    stub.setState('disconnected', 'CDP connection closed');
    await tick();
    await worker.connect();
    stub.setState('connected');
    await tick();

    stub.fire('Target.targetCreated', { targetId: 't1' });
    await tick();
    expect(listener).toHaveBeenCalledTimes(1);

    teardown();
  });

  it('re-registers event subscriptions and announces cdp-ready on page-client reconnect', async () => {
    const { stub, worker, wire, teardown } = setup();
    await worker.connect();

    const seen: Array<Record<string, unknown>> = [];
    worker.on('Page.frameNavigated', (params) => seen.push(params));
    await tick();
    expect(stub.listenerCount('Page.frameNavigated')).toBe(1);

    stub.setState('disconnected', 'CDP connection closed');
    await tick();
    // A real client reconnect can lose the registrations, and the worker
    // never re-sends cdp-subscribe for a listener it still holds.
    stub.dropListeners();
    expect(stub.listenerCount('Page.frameNavigated')).toBe(0);

    stub.setState('connected');
    await tick();

    expect(stub.listenerCount('Page.frameNavigated')).toBe(1);
    expect(wire.some((m) => m.type === 'cdp-ready')).toBe(true);

    stub.fire('Page.frameNavigated', { frameId: 'f1' });
    await tick();
    expect(seen).toEqual([{ frameId: 'f1' }]);

    teardown();
  });

  it('leaves the reset state for connect() to clear — cdp-ready alone does not reconnect', async () => {
    const { stub, worker, teardown } = setup();
    await worker.connect();

    stub.setState('disconnected', 'CDP connection closed');
    await tick();
    stub.setState('connected');
    await tick();

    // Still disconnected: `BrowserAPI.ensureConnected()` has to see the flip
    // and clear its session cache before the transport comes back.
    expect(worker.state).toBe('disconnected');

    teardown();
  });
});
