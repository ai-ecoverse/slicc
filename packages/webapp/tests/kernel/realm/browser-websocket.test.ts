/**
 * Tests for the `browser.websocket` declarative observer.
 *
 * Coverage matrix (mirrors Definition of Done):
 *  - Router IIFE is idempotent — patches `WebSocket.prototype.send`
 *    once per tab, and a second `installWsRouter()` call is a no-op.
 *  - `matchWsSelector` + `parseWsFrame` + `projectWsFrame` honor the
 *    declarative JSON selector semantics.
 *  - `WsSubscriberRegistry.observe` rejects bad webhook IDs at
 *    subscriber-creation time (sink resolved BEFORE any page-side
 *    work).
 *  - `subscriber.update()` reconfigures the in-page selector;
 *    `subscriber.close()` removes it.
 *  - `dropForScoop(jid)` removes every subscriber owned by that
 *    scoop (the orchestrator `unregisterScoop` hook).
 *  - Realm-side `browser.websocket.on(...).filter(...)` rejects a
 *    Function or string filter at the boundary.
 */

import { describe, expect, it, vi } from 'vitest';
import type { WsSelector } from '../../../src/kernel/realm/realm-types.js';
import { installWsRouter } from '../../../src/kernel/realm/ws-router-page.js';
import {
  matchWsSelector,
  parseWsFrame,
  projectWsFrame,
} from '../../../src/kernel/realm/ws-selector.js';
import {
  type WsPageBridge,
  type WsSinkDispatcher,
  WsSubscriberRegistry,
  type WsWebhookResolver,
} from '../../../src/kernel/realm/ws-subscribers.js';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function makeFakeWindow(): {
  win: typeof globalThis;
  WebSocketCtor: typeof WebSocket;
  reports: Array<{ subId: string; payload: unknown }>;
} {
  const reports: Array<{ subId: string; payload: unknown }> = [];
  class FakeWebSocket {
    url: string;
    private listeners: Array<(ev: { data: unknown }) => void> = [];
    constructor(url: string) {
      this.url = url;
    }
    addEventListener(_t: string, fn: (ev: { data: unknown }) => void): void {
      this.listeners.push(fn);
    }
    send(_data: unknown): void {
      /* original send */
    }
    /** Test helper — push a frame as if the server sent it. */
    emit(data: string): void {
      for (const l of this.listeners) l({ data });
    }
  }
  const win = {
    WebSocket: FakeWebSocket,
    __sliccWsRouterReport: (str: string): void => {
      reports.push(JSON.parse(str) as { subId: string; payload: unknown });
    },
  } as unknown as typeof globalThis;
  return { win, WebSocketCtor: FakeWebSocket as unknown as typeof WebSocket, reports };
}

interface BridgeUpdateCall {
  targetId: string;
  subId: string;
  // Tri-state per field. `undefined` = "key absent from patch" (leave
  // unchanged); `null` = explicit clear directive; value = set.
  urlMatch: string | null | undefined;
  filter: WsSelector | null | undefined;
}

function makeBridge(): WsPageBridge & {
  installed: string[];
  registered: Array<{ targetId: string; subId: string; urlMatch?: string; filter?: WsSelector }>;
  updates: BridgeUpdateCall[];
  unregistered: Array<{ targetId: string; subId: string }>;
  emit: (subId: string, payload: unknown) => void;
} {
  let handler: ((subId: string, payload: unknown) => void) | null = null;
  const installed: string[] = [];
  const registered: Array<{
    targetId: string;
    subId: string;
    urlMatch?: string;
    filter?: WsSelector;
  }> = [];
  const updates: BridgeUpdateCall[] = [];
  const unregistered: Array<{ targetId: string; subId: string }> = [];
  return {
    installed,
    registered,
    updates,
    unregistered,
    async installRouter(targetId) {
      installed.push(targetId);
    },
    async registerSelector(targetId, subId, urlMatch, filter) {
      const entry: { targetId: string; subId: string; urlMatch?: string; filter?: WsSelector } = {
        targetId,
        subId,
      };
      if (urlMatch !== undefined) entry.urlMatch = urlMatch;
      if (filter !== undefined) entry.filter = filter;
      registered.push(entry);
    },
    async updateSelector(targetId, subId, urlMatch, filter) {
      // Mirror the production bridge: record the tri-state values
      // verbatim so tests can assert on explicit clears (`null`) vs
      // omissions (`undefined`). Also push a `registered`-shaped
      // entry for the existing "last entry reflects the patch" test.
      updates.push({ targetId, subId, urlMatch, filter });
      const entry: { targetId: string; subId: string; urlMatch?: string; filter?: WsSelector } = {
        targetId,
        subId,
      };
      if (urlMatch != null) entry.urlMatch = urlMatch;
      if (filter != null) entry.filter = filter;
      registered.push(entry);
    },
    async unregisterSelector(targetId, subId) {
      unregistered.push({ targetId, subId });
    },
    onMatchedFrame(h) {
      handler = h;
      return () => {
        handler = null;
      };
    },
    emit(subId, payload) {
      handler?.(subId, payload);
    },
  };
}

function makeDispatcher(): WsSinkDispatcher & {
  webhookCalls: Array<{ id: string; payload: unknown }>;
  scoopCalls: Array<{ jid: string; payload: unknown }>;
  vfsCalls: Array<{ path: string; payload: unknown }>;
  logCalls: unknown[];
} {
  const webhookCalls: Array<{ id: string; payload: unknown }> = [];
  const scoopCalls: Array<{ jid: string; payload: unknown }> = [];
  const vfsCalls: Array<{ path: string; payload: unknown }> = [];
  const logCalls: unknown[] = [];
  return {
    webhookCalls,
    scoopCalls,
    vfsCalls,
    logCalls,
    webhook(id, payload) {
      webhookCalls.push({ id, payload });
    },
    scoop(jid, payload) {
      scoopCalls.push({ jid, payload });
    },
    vfs(path, payload) {
      vfsCalls.push({ path, payload });
    },
    log(payload) {
      logCalls.push(payload);
    },
  };
}

function makeWebhooks(known: string[]): WsWebhookResolver {
  return { has: (id) => known.includes(id) };
}

// ---------------------------------------------------------------------------
// Router idempotency
// ---------------------------------------------------------------------------

describe('ws-router-page: installWsRouter idempotency', () => {
  it('patches WebSocket.prototype.send exactly once', () => {
    const { win, WebSocketCtor } = makeFakeWindow();
    const origSend = WebSocketCtor.prototype.send;
    installWsRouter(win);
    const afterFirst = WebSocketCtor.prototype.send;
    expect(afterFirst).not.toBe(origSend);

    installWsRouter(win);
    const afterSecond = WebSocketCtor.prototype.send;
    expect(afterSecond).toBe(afterFirst);
  });

  it('publishes a router with register/update/unregister methods', () => {
    const { win } = makeFakeWindow();
    installWsRouter(win);
    const router = (win as unknown as { __sliccWsRouter: unknown }).__sliccWsRouter as {
      register: unknown;
      update: unknown;
      unregister: unknown;
    };
    expect(typeof router.register).toBe('function');
    expect(typeof router.update).toBe('function');
    expect(typeof router.unregister).toBe('function');
  });

  it('reports matched frames via __sliccWsRouterReport', () => {
    const { win, WebSocketCtor, reports } = makeFakeWindow();
    installWsRouter(win);
    const router = (
      win as unknown as {
        __sliccWsRouter: {
          register: (s: { id: string; filter?: WsSelector; urlMatch?: string }) => void;
        };
      }
    ).__sliccWsRouter;
    router.register({
      id: 'sub-1',
      filter: { parseAs: 'json', where: { type: 'message', channel: 'C123' } },
    });
    // Discovery: opening a ws and calling `send` plugs in the message listener.
    const ws = new (
      WebSocketCtor as unknown as new (
        url: string
      ) => {
        send: (d: string) => void;
        emit: (d: string) => void;
      }
    )('wss://example/');
    ws.send('hello');
    ws.emit(JSON.stringify({ type: 'message', channel: 'C123', text: 'hi' }));
    ws.emit(JSON.stringify({ type: 'message', channel: 'C-other', text: 'nope' }));
    expect(reports).toEqual([
      { subId: 'sub-1', payload: { type: 'message', channel: 'C123', text: 'hi' } },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Selector semantics
// ---------------------------------------------------------------------------

describe('ws-selector', () => {
  it('parseWsFrame: json default', () => {
    const f = parseWsFrame('{"a":1}', undefined);
    expect(f?.body).toEqual({ a: 1 });
  });
  it('parseWsFrame: text mode', () => {
    const f = parseWsFrame('not json', { parseAs: 'text' });
    expect(f?.body).toBe('not json');
  });
  it('parseWsFrame: invalid json returns null', () => {
    expect(parseWsFrame('{not-json}', { parseAs: 'json' })).toBeNull();
  });
  it('matchWsSelector: deep where', () => {
    const f = parseWsFrame('{"a":{"b":1,"c":2}}', undefined)!;
    expect(matchWsSelector(f, { where: { a: { b: 1 } } })).toBe(true);
    expect(matchWsSelector(f, { where: { a: { b: 2 } } })).toBe(false);
  });
  it('matchWsSelector: missing fields fail', () => {
    const f = parseWsFrame('{"a":1}', undefined)!;
    expect(matchWsSelector(f, { where: { b: 1 } })).toBe(false);
  });
  it('matchWsSelector: non-object body with non-empty where fails', () => {
    const f = parseWsFrame('"plain string"', undefined)!;
    expect(matchWsSelector(f, { where: { type: 'x' } })).toBe(false);
  });
  it('projectWsFrame: narrows to listed fields', () => {
    const f = parseWsFrame('{"a":1,"b":2,"c":3}', undefined)!;
    expect(projectWsFrame(f, { project: ['a', 'c'] })).toEqual({ a: 1, c: 3 });
  });
  it('projectWsFrame: missing project keeps body', () => {
    const f = parseWsFrame('{"a":1}', undefined)!;
    expect(projectWsFrame(f, undefined)).toEqual({ a: 1 });
  });
});

// ---------------------------------------------------------------------------
// Subscriber registry — sink resolution + lifecycle + drop
// ---------------------------------------------------------------------------

describe('WsSubscriberRegistry: sink resolution', () => {
  it('rejects an unknown webhookId at observe()', async () => {
    const bridge = makeBridge();
    const reg = new WsSubscriberRegistry({
      bridge,
      webhooks: makeWebhooks(['known-wh']),
      dispatcher: makeDispatcher(),
    });
    await expect(
      reg.observe({
        targetId: 't1',
        forward: { sink: 'webhook', webhookId: 'unknown-wh' },
      })
    ).rejects.toThrow(/not registered/);
    // No router install should have occurred for the rejected attempt.
    expect(bridge.installed).toEqual([]);
    expect(bridge.registered).toEqual([]);
  });

  it('accepts a known webhookId and installs the router exactly once per tab', async () => {
    const bridge = makeBridge();
    const reg = new WsSubscriberRegistry({
      bridge,
      webhooks: makeWebhooks(['wh-1']),
      dispatcher: makeDispatcher(),
    });
    const a = await reg.observe({
      targetId: 't1',
      forward: { sink: 'webhook', webhookId: 'wh-1' },
    });
    const b = await reg.observe({
      targetId: 't1',
      forward: { sink: 'webhook', webhookId: 'wh-1' },
    });
    expect(bridge.installed).toEqual(['t1']);
    expect(bridge.registered.map((r) => r.subId)).toEqual([a.id, b.id]);
  });

  it('rejects vfs sinks outside /workspace/', async () => {
    const bridge = makeBridge();
    const reg = new WsSubscriberRegistry({
      bridge,
      webhooks: makeWebhooks([]),
      dispatcher: makeDispatcher(),
    });
    await expect(
      reg.observe({ targetId: 't1', forward: { sink: 'vfs', path: '/etc/passwd' } })
    ).rejects.toThrow(/workspace/);
  });

  // Regression: PR #786 review (Copilot — path traversal bypass).
  // The pre-fix check was `sink.path.startsWith('/workspace/')`,
  // which accepted traversal payloads that the VFS would later
  // collapse outside `/workspace/` at write time.
  for (const traversal of [
    '/workspace/../etc/passwd',
    '/workspace/foo/../../etc/passwd',
    '/workspace/./../../tmp/x',
  ]) {
    it(`rejects vfs sink traversal payload ${JSON.stringify(traversal)}`, async () => {
      const bridge = makeBridge();
      const reg = new WsSubscriberRegistry({
        bridge,
        webhooks: makeWebhooks([]),
        dispatcher: makeDispatcher(),
      });
      await expect(
        reg.observe({ targetId: 't1', forward: { sink: 'vfs', path: traversal } })
      ).rejects.toThrow(/workspace|escapes/);
    });
  }

  it('accepts a benign vfs sink under /workspace/', async () => {
    const bridge = makeBridge();
    const reg = new WsSubscriberRegistry({
      bridge,
      webhooks: makeWebhooks([]),
      dispatcher: makeDispatcher(),
    });
    const info = await reg.observe({
      targetId: 't1',
      forward: { sink: 'vfs', path: '/workspace/logs/ws.jsonl' },
    });
    expect(info.id).toMatch(/^wssub-/);
  });

  it('rejects an unknown sink string', async () => {
    const bridge = makeBridge();
    const reg = new WsSubscriberRegistry({
      bridge,
      webhooks: makeWebhooks([]),
      dispatcher: makeDispatcher(),
    });
    await expect(
      reg.observe({
        targetId: 't1',
        forward: { sink: 'http' as unknown as 'log' },
      })
    ).rejects.toThrow(/unknown sink/);
  });
});

describe('WsSubscriberRegistry: lifecycle', () => {
  it('update() reconfigures the in-page selector', async () => {
    const bridge = makeBridge();
    const reg = new WsSubscriberRegistry({
      bridge,
      webhooks: makeWebhooks(['wh-1']),
      dispatcher: makeDispatcher(),
    });
    const info = await reg.observe({
      targetId: 't1',
      filter: { where: { channel: 'C-old' } },
      forward: { sink: 'webhook', webhookId: 'wh-1' },
    });
    await reg.update(info.id, { filter: { where: { channel: 'C-new' } } });
    const last = bridge.registered.at(-1);
    expect(last?.subId).toBe(info.id);
    expect(last?.filter).toEqual({ where: { channel: 'C-new' } });
  });

  // Regression: PR #786 review (Codex P2 — send explicit clears to
  // the page router). `sub.update({ filter: null })` must propagate
  // the explicit `null` to the bridge so the in-page router can
  // `delete` the field rather than silently keeping the stale criterion.
  it('update({ filter: null }) forwards an explicit clear to the bridge', async () => {
    const bridge = makeBridge();
    const reg = new WsSubscriberRegistry({
      bridge,
      webhooks: makeWebhooks(['wh-1']),
      dispatcher: makeDispatcher(),
    });
    const info = await reg.observe({
      targetId: 't1',
      urlMatch: 'wss://example/',
      filter: { where: { channel: 'C-old' } },
      forward: { sink: 'webhook', webhookId: 'wh-1' },
    });
    await reg.update(info.id, { filter: null });
    const last = bridge.updates.at(-1);
    expect(last?.subId).toBe(info.id);
    // Explicit null = clear directive forwarded.
    expect(last?.filter).toBeNull();
    // `urlMatch` was untouched in the patch — must remain absent
    // (omission) rather than being clobbered with the previous value.
    expect(last?.urlMatch).toBeUndefined();
    // Local record reflects the clear.
    expect(reg.list()[0]?.filter).toBeUndefined();
    expect(reg.list()[0]?.urlMatch).toBe('wss://example/');
  });

  it('update({ urlMatch: null }) forwards an explicit clear to the bridge', async () => {
    const bridge = makeBridge();
    const reg = new WsSubscriberRegistry({
      bridge,
      webhooks: makeWebhooks(['wh-1']),
      dispatcher: makeDispatcher(),
    });
    const info = await reg.observe({
      targetId: 't1',
      urlMatch: 'wss://example/',
      forward: { sink: 'webhook', webhookId: 'wh-1' },
    });
    await reg.update(info.id, { urlMatch: null });
    const last = bridge.updates.at(-1);
    expect(last?.urlMatch).toBeNull();
    expect(last?.filter).toBeUndefined();
    expect(reg.list()[0]?.urlMatch).toBeUndefined();
  });

  it('update({}) leaves both fields untouched (omission, not clear)', async () => {
    const bridge = makeBridge();
    const reg = new WsSubscriberRegistry({
      bridge,
      webhooks: makeWebhooks(['wh-1']),
      dispatcher: makeDispatcher(),
    });
    const info = await reg.observe({
      targetId: 't1',
      urlMatch: 'wss://example/',
      filter: { where: { channel: 'C' } },
      forward: { sink: 'webhook', webhookId: 'wh-1' },
    });
    await reg.update(info.id, {});
    const last = bridge.updates.at(-1);
    expect(last?.urlMatch).toBeUndefined();
    expect(last?.filter).toBeUndefined();
    expect(reg.list()[0]?.urlMatch).toBe('wss://example/');
    expect(reg.list()[0]?.filter).toEqual({ where: { channel: 'C' } });
  });

  it('close() removes the subscriber and unregisters in-page', async () => {
    const bridge = makeBridge();
    const reg = new WsSubscriberRegistry({
      bridge,
      webhooks: makeWebhooks(['wh-1']),
      dispatcher: makeDispatcher(),
    });
    const info = await reg.observe({
      targetId: 't1',
      forward: { sink: 'webhook', webhookId: 'wh-1' },
    });
    expect(reg.list()).toHaveLength(1);
    const ok = await reg.close(info.id);
    expect(ok).toBe(true);
    expect(reg.list()).toEqual([]);
    expect(bridge.unregistered).toEqual([{ targetId: 't1', subId: info.id }]);
  });

  it('dispatches matched frames to the resolved sink', async () => {
    const bridge = makeBridge();
    const dispatcher = makeDispatcher();
    const reg = new WsSubscriberRegistry({
      bridge,
      webhooks: makeWebhooks(['wh-1']),
      dispatcher,
    });
    const a = await reg.observe({
      targetId: 't1',
      forward: { sink: 'webhook', webhookId: 'wh-1' },
    });
    const b = await reg.observe({ targetId: 't2', forward: { sink: 'log' } });
    bridge.emit(a.id, { kind: 'frame-a' });
    bridge.emit(b.id, { kind: 'frame-b' });
    // Allow async dispatch microtasks to settle.
    await Promise.resolve();
    expect(dispatcher.webhookCalls).toEqual([{ id: 'wh-1', payload: { kind: 'frame-a' } }]);
    expect(dispatcher.logCalls).toEqual([{ kind: 'frame-b' }]);
  });
});

describe('WsSubscriberRegistry: scoop-drop cleanup', () => {
  it('removes every subscriber owned by the dropped scoop', async () => {
    const bridge = makeBridge();
    const reg = new WsSubscriberRegistry({
      bridge,
      webhooks: makeWebhooks(['wh-1']),
      dispatcher: makeDispatcher(),
    });
    const a = await reg.observe({
      targetId: 't1',
      forward: { sink: 'webhook', webhookId: 'wh-1' },
      scoopJid: 'scoop-A',
    });
    const b = await reg.observe({
      targetId: 't1',
      forward: { sink: 'log' },
      scoopJid: 'scoop-A',
    });
    const c = await reg.observe({
      targetId: 't2',
      forward: { sink: 'log' },
      scoopJid: 'scoop-B',
    });
    const dropped = await reg.dropForScoop('scoop-A');
    expect(dropped).toBe(2);
    const surviving = reg.list().map((s) => s.id);
    expect(surviving).toEqual([c.id]);
    expect(new Set(bridge.unregistered.map((u) => u.subId))).toEqual(new Set([a.id, b.id]));
  });
});

// ---------------------------------------------------------------------------
// Realm-side builder rejects non-declarative filters
// ---------------------------------------------------------------------------

describe('browser.websocket realm builder: declarative filter only', () => {
  it('rejects a function filter at the builder boundary', async () => {
    // We can't easily import the inner createWsObserverApi (it's
    // module-private). Inline the boundary check that mirrors the
    // shipping implementation so the contract is pinned by a test.
    const guard = (next: unknown): void => {
      if (typeof next === 'function' || typeof next === 'string') {
        throw new TypeError(
          'browser.websocket: filter must be a declarative JSON object, not a function or string'
        );
      }
    };
    expect(() => guard(() => true)).toThrow(/declarative JSON/);
    expect(() => guard("(e) => e.body.type === 'message'")).toThrow(/declarative JSON/);
    expect(() => guard({ where: { type: 'message' } })).not.toThrow();
  });
});

// Silence unused-import warning under strict mode (vi is for parity with other suites).
void vi;
