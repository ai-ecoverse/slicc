/**
 * Integration smoke for the CDP page-bridge adapter.
 *
 * Drives `CdpWsPageBridge` against a fake `BrowserAPI` whose
 * transport records CDP traffic and replays binding-called events,
 * verifying:
 *  - `Page.addScriptToEvaluateOnNewDocument` is called with the
 *    static `WS_ROUTER_SOURCE`.
 *  - `Runtime.addBinding` registers the `__sliccWsRouterReport`
 *    callback.
 *  - `Runtime.bindingCalled` events are decoded into
 *    `(subId, payload)` and routed to the registry's matched-frame
 *    handler, which then dispatches to the resolved webhook sink
 *    end-to-end.
 *  - `register`/`update`/`unregister` map to in-page
 *    `__sliccWsRouter.*` calls via `Runtime.evaluate`.
 */
import { describe, expect, it } from 'vitest';
import type { BrowserAPI } from '../../src/cdp/browser-api.js';
import { CdpWsPageBridge } from '../../src/cdp/cdp-ws-page-bridge.js';
import type { CDPTransport } from '../../src/cdp/transport.js';
import type { CDPConnectOptions, CDPEventListener, ConnectionState } from '../../src/cdp/types.js';
import { WS_ROUTER_SOURCE } from '../../src/kernel/realm/ws-router-page.js';
import {
  type WsSinkDispatcher,
  WsSubscriberRegistry,
  type WsWebhookResolver,
} from '../../src/kernel/realm/ws-subscribers.js';

class FakeTransport implements CDPTransport {
  state: ConnectionState = 'connected';
  private listeners = new Map<string, Set<CDPEventListener>>();
  public sent: Array<{ method: string; params?: Record<string, unknown> }> = [];

  async connect(_o?: CDPConnectOptions): Promise<void> {}
  disconnect(): void {}
  async send(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.sent.push({ method, params });
    if (method === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: 'init-1' };
    return {};
  }
  on(event: string, listener: CDPEventListener): void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(listener);
  }
  off(event: string, listener: CDPEventListener): void {
    this.listeners.get(event)?.delete(listener);
  }
  async once(): Promise<Record<string, unknown>> {
    return {};
  }
  emit(event: string, params: Record<string, unknown>): void {
    this.listeners.get(event)?.forEach((l) => {
      l(params);
    });
  }
}

function makeFakeBrowser(transport: FakeTransport): BrowserAPI {
  return {
    getTransport: () => transport,
    async withTab<T>(_targetId: string, fn: (sessionId: string) => Promise<T>): Promise<T> {
      return fn('session-fake');
    },
    async sendCDP(method: string, params: Record<string, unknown> = {}) {
      return (
        transport.send as (m: string, p?: Record<string, unknown>, s?: string) => Promise<unknown>
      )(method, params, 'session-fake');
    },
  } as unknown as BrowserAPI;
}

function makeWebhooks(ids: string[]): WsWebhookResolver {
  return { has: (id) => ids.includes(id) };
}

function makeDispatcher(): WsSinkDispatcher & {
  webhookCalls: Array<{ id: string; payload: unknown }>;
} {
  const webhookCalls: Array<{ id: string; payload: unknown }> = [];
  return {
    webhookCalls,
    webhook(id, payload) {
      webhookCalls.push({ id, payload });
    },
    scoop() {},
    vfs() {},
    log() {},
  };
}

describe('CdpWsPageBridge', () => {
  it('installs the runtime-owned router via Page.addScriptToEvaluateOnNewDocument + Runtime.addBinding', async () => {
    const transport = new FakeTransport();
    const browser = makeFakeBrowser(transport);
    const bridge = new CdpWsPageBridge({ browser });

    await bridge.installRouter('target-1');
    await bridge.installRouter('target-1'); // idempotent: second call must not re-issue CDP traffic.

    const methods = transport.sent.map((c) => c.method);
    expect(methods).toEqual([
      'Runtime.enable',
      'Runtime.addBinding',
      'Page.addScriptToEvaluateOnNewDocument',
      'Runtime.evaluate',
    ]);
    const addBinding = transport.sent[1]!;
    expect(addBinding.params).toEqual({ name: '__sliccWsRouterReport' });
    const addInit = transport.sent[2]!;
    expect(addInit.params?.['source']).toBe(WS_ROUTER_SOURCE);
    bridge.dispose();
  });

  it('routes Runtime.bindingCalled into the matched-frame handler and out to the resolved webhook sink', async () => {
    const transport = new FakeTransport();
    const browser = makeFakeBrowser(transport);
    const bridge = new CdpWsPageBridge({ browser });
    const dispatcher = makeDispatcher();
    const reg = new WsSubscriberRegistry({
      bridge,
      webhooks: makeWebhooks(['wh-1']),
      dispatcher,
    });
    const sub = await reg.observe({
      targetId: 't1',
      forward: { sink: 'webhook', webhookId: 'wh-1' },
    });

    // The page-side router would call __sliccWsRouterReport(JSON.stringify({subId, payload})).
    transport.emit('Runtime.bindingCalled', {
      name: '__sliccWsRouterReport',
      payload: JSON.stringify({ subId: sub.id, payload: { type: 'message', text: 'hi' } }),
    });
    // Dispatch is async (registry calls await on the dispatcher); flush microtasks.
    await Promise.resolve();
    expect(dispatcher.webhookCalls).toEqual([
      { id: 'wh-1', payload: { type: 'message', text: 'hi' } },
    ]);
    // Bindings for unrelated names must be ignored.
    transport.emit('Runtime.bindingCalled', {
      name: 'someOtherBinding',
      payload: JSON.stringify({ subId: sub.id, payload: { x: 1 } }),
    });
    await Promise.resolve();
    expect(dispatcher.webhookCalls).toHaveLength(1);
    bridge.dispose();
  });

  it('maps register/update/unregister to in-page __sliccWsRouter calls via Runtime.evaluate', async () => {
    const transport = new FakeTransport();
    const browser = makeFakeBrowser(transport);
    const bridge = new CdpWsPageBridge({ browser });

    await bridge.installRouter('target-1');
    transport.sent.length = 0;
    await bridge.registerSelector('target-1', 'sub-1', 'wss://example/', { where: { a: 1 } });
    await bridge.updateSelector('target-1', 'sub-1', undefined, { where: { a: 2 } });
    await bridge.unregisterSelector('target-1', 'sub-1');
    const exprs = transport.sent
      .filter((c) => c.method === 'Runtime.evaluate')
      .map((c) => c.params?.['expression']);
    expect(exprs[0]).toContain('__sliccWsRouter');
    expect(exprs[0]).toContain('.register(');
    expect(exprs[0]).toContain('"sub-1"');
    expect(exprs[1]).toContain('.update(');
    expect(exprs[2]).toContain('.unregister(');
    bridge.dispose();
  });
});
