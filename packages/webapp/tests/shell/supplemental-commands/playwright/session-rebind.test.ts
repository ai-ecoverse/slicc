/**
 * Tests for `bindTabCapture` — the re-binding wrapper the per-tab CDP event
 * captures (`console`, `requests`, `route`) share.
 *
 * The case that motivated it (issue #2417 review finding 4): the thin
 * extension's `ExtensionBridgeTransport` reconnects IN PLACE after an MV3
 * service-worker eviction. The transport object is unchanged but
 * `CdpTransportBridge.disconnect()` has emptied its listener registry, so an
 * identity check ("same transport, nothing to do") leaves the capture deaf for
 * the rest of the run.
 */

import { describe, expect, it, vi } from 'vitest';
import type { BrowserAPI } from '../../../../src/cdp/index.js';
import type { CDPTransport } from '../../../../src/cdp/transport.js';
import { bindTabCapture } from '../../../../src/shell/supplemental-commands/playwright/session-rebind.js';

type Listener = (params: Record<string, unknown>) => void;
type Replaced = (sessionId: string, transport: CDPTransport, targetId: string) => void;

/**
 * Transport whose listener registry can be emptied the way a bridge
 * reconnect empties it, while the object identity stays the same.
 */
function makeTransport(): {
  transport: CDPTransport;
  send: ReturnType<typeof vi.fn>;
  count: (event: string) => number;
  emit: (event: string, params: Record<string, unknown>) => void;
  clearListeners: () => void;
} {
  const listeners = new Map<string, Set<Listener>>();
  const send = vi.fn(async () => ({}));
  const transport = {
    send,
    on: (event: string, cb: Listener) => {
      let set = listeners.get(event);
      if (!set) {
        set = new Set();
        listeners.set(event, set);
      }
      set.add(cb);
    },
    off: (event: string, cb: Listener) => {
      listeners.get(event)?.delete(cb);
    },
  } as unknown as CDPTransport;
  return {
    transport,
    send,
    count: (event) => listeners.get(event)?.size ?? 0,
    emit: (event, params) => {
      for (const cb of [...(listeners.get(event) ?? [])]) cb(params);
    },
    clearListeners: () => listeners.clear(),
  };
}

/** Browser stub exposing only what the wrapper touches. */
function makeBrowser(opts: { withHook?: boolean } = {}): {
  browser: BrowserAPI;
  replace: Replaced;
  subscriberCount: () => number;
} {
  const subs = new Set<Replaced>();
  const base: Record<string, unknown> = {};
  if (opts.withHook !== false) {
    base.onSessionReplaced = (_targetId: string, cb: Replaced) => {
      subs.add(cb);
      return () => subs.delete(cb);
    };
  }
  return {
    browser: base as unknown as BrowserAPI,
    replace: (sessionId, transport, targetId) => {
      for (const cb of [...subs]) cb(sessionId, transport, targetId);
    },
    subscriberCount: () => subs.size,
  };
}

describe('bindTabCapture', () => {
  it('arms the listeners on the starting transport and exposes the session', () => {
    const t = makeTransport();
    const { browser } = makeBrowser();
    const seen: unknown[] = [];

    const binding = bindTabCapture({
      browser,
      targetId: 'tab-1',
      transport: t.transport,
      sessionId: 'sess-1',
      listeners: [['Runtime.consoleAPICalled', (p) => seen.push(p)]],
    });

    expect(binding.sessionId).toBe('sess-1');
    expect(binding.transport).toBe(t.transport);
    expect(t.count('Runtime.consoleAPICalled')).toBe(1);

    t.emit('Runtime.consoleAPICalled', { sessionId: 'sess-1' });
    expect(seen).toHaveLength(1);
  });

  it('re-arms and re-enables on a replacement session on the SAME transport object', () => {
    const t = makeTransport();
    const { browser, replace } = makeBrowser();
    const seen: unknown[] = [];
    const enable = vi.fn(async () => ({}));

    const binding = bindTabCapture({
      browser,
      targetId: 'tab-1',
      transport: t.transport,
      sessionId: 'sess-1',
      listeners: [['Runtime.consoleAPICalled', (p) => seen.push(p)]],
      enable,
    });

    // What a bridge reconnect does to its own listener registry.
    t.clearListeners();
    expect(t.count('Runtime.consoleAPICalled')).toBe(0);

    replace('sess-2', t.transport, 'tab-1');

    expect(t.count('Runtime.consoleAPICalled')).toBe(1);
    expect(binding.sessionId).toBe('sess-2');
    expect(enable).toHaveBeenCalledWith(t.transport, 'sess-2');

    t.emit('Runtime.consoleAPICalled', { sessionId: 'sess-2' });
    expect(seen).toHaveLength(1);
  });

  it('does not double-register when the registry survived the replacement', () => {
    const t = makeTransport();
    const { browser, replace } = makeBrowser();
    const seen: unknown[] = [];

    bindTabCapture({
      browser,
      targetId: 'tab-1',
      transport: t.transport,
      sessionId: 'sess-1',
      listeners: [['Network.requestWillBeSent', (p) => seen.push(p)]],
    });

    replace('sess-2', t.transport, 'tab-1');
    replace('sess-3', t.transport, 'tab-1');

    expect(t.count('Network.requestWillBeSent')).toBe(1);
    t.emit('Network.requestWillBeSent', {});
    expect(seen).toHaveLength(1);
  });

  it('moves every listener to a replacement transport and disarms the old one', () => {
    const oldT = makeTransport();
    const newT = makeTransport();
    const { browser, replace } = makeBrowser();
    const events = ['Network.requestWillBeSent', 'Network.responseReceived'] as const;

    const binding = bindTabCapture({
      browser,
      targetId: 'tab-1',
      transport: oldT.transport,
      sessionId: 'sess-1',
      listeners: events.map((event) => [event, vi.fn()] as const),
    });

    replace('sess-2', newT.transport, 'tab-1');

    for (const event of events) {
      expect(oldT.count(event)).toBe(0);
      expect(newT.count(event)).toBe(1);
    }
    expect(binding.transport).toBe(newT.transport);
  });

  it('stop() unsubscribes from replacements and removes the listeners', () => {
    const t = makeTransport();
    const { browser, replace, subscriberCount } = makeBrowser();

    const binding = bindTabCapture({
      browser,
      targetId: 'tab-1',
      transport: t.transport,
      sessionId: 'sess-1',
      listeners: [['Fetch.requestPaused', vi.fn()]],
    });

    binding.stop();

    expect(t.count('Fetch.requestPaused')).toBe(0);
    expect(subscriberCount()).toBe(0);
    replace('sess-2', t.transport, 'tab-1');
    expect(t.count('Fetch.requestPaused')).toBe(0);
  });

  it('degrades to a plain bind when the browser has no onSessionReplaced hook', () => {
    const t = makeTransport();
    const { browser } = makeBrowser({ withHook: false });

    const binding = bindTabCapture({
      browser,
      targetId: 'tab-1',
      transport: t.transport,
      sessionId: 'sess-1',
      listeners: [['Runtime.consoleAPICalled', vi.fn()]],
    });

    expect(t.count('Runtime.consoleAPICalled')).toBe(1);
    expect(() => binding.stop()).not.toThrow();
    expect(t.count('Runtime.consoleAPICalled')).toBe(0);
  });

  it('keeps the listeners armed when re-enabling the domain fails', () => {
    const t = makeTransport();
    const { browser, replace } = makeBrowser();

    bindTabCapture({
      browser,
      targetId: 'tab-1',
      transport: t.transport,
      sessionId: 'sess-1',
      listeners: [['Runtime.consoleAPICalled', vi.fn()]],
      enable: () => Promise.reject(new Error('tab closed')),
    });

    expect(() => replace('sess-2', t.transport, 'tab-1')).not.toThrow();
    expect(t.count('Runtime.consoleAPICalled')).toBe(1);
  });

  it('survives an enable() that throws synchronously', () => {
    const t = makeTransport();
    const { browser, replace } = makeBrowser();

    const binding = bindTabCapture({
      browser,
      targetId: 'tab-1',
      transport: t.transport,
      sessionId: 'sess-1',
      listeners: [['Runtime.consoleAPICalled', vi.fn()]],
      enable: () => {
        throw new Error('transport gone');
      },
    });

    expect(() => replace('sess-2', t.transport, 'tab-1')).not.toThrow();
    expect(binding.sessionId).toBe('sess-2');
    expect(t.count('Runtime.consoleAPICalled')).toBe(1);
  });
});
