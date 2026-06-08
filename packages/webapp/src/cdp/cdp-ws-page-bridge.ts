/**
 * `cdp-ws-page-bridge.ts` — CDP adapter implementing `WsPageBridge`
 * for `WsSubscriberRegistry`.
 *
 * Installs the runtime-owned router (`ws-router-page.ts`) into the
 * target tab via `Page.addScriptToEvaluateOnNewDocument` (so it runs
 * before any in-page WebSocket constructor on future loads) and a
 * companion `Runtime.evaluate` (for the current document). Exposes a
 * single kernel-side callback via `Runtime.addBinding` — the page can
 * only call back with `JSON.stringify({ subId, payload })`, so a
 * compromised skill cannot smuggle a destination URL or arbitrary
 * fetch into the runtime.
 *
 * Works for both transports: the WebSocket-backed `CDPClient` (CLI /
 * Electron / kernel-worker) and the `chrome.debugger`-backed
 * `DebuggerClient` (extension offscreen). The bridge only consumes
 * the `CDPTransport` surface exposed by `BrowserAPI.getTransport()`
 * and serializes per-tab CDP traffic via `BrowserAPI.withTab(...)`.
 */

import { createLogger } from '../core/logger.js';
import type { WsSelector } from '../kernel/realm/realm-types.js';
import { WS_ROUTER_SOURCE } from '../kernel/realm/ws-router-page.js';
import type { WsPageBridge } from '../kernel/realm/ws-subscribers.js';
import type { BrowserAPI } from './browser-api.js';

const log = createLogger('cdp-ws-page-bridge');

/** Page-side binding name. Must match `__sliccWsRouterReport` in `ws-router-page.ts`. */
const BINDING_NAME = '__sliccWsRouterReport';

export interface CdpWsPageBridgeOptions {
  browser: BrowserAPI;
}

export class CdpWsPageBridge implements WsPageBridge {
  private readonly browser: BrowserAPI;
  /** Per-tab install state. The script identifier lets us call `Page.removeScriptToEvaluateOnNewDocument` on cleanup. */
  private readonly installs = new Map<string, { scriptIdentifier: string | null }>();
  private frameHandler: ((subId: string, payload: unknown) => void) | null = null;
  private bindingListenerAttached = false;

  private readonly onBindingCalled = (params: Record<string, unknown>): void => {
    if (params['name'] !== BINDING_NAME) return;
    const payload = params['payload'];
    if (typeof payload !== 'string') return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return;
    }
    if (typeof parsed !== 'object' || parsed === null) return;
    const subId = (parsed as { subId?: unknown }).subId;
    if (typeof subId !== 'string') return;
    const projection = (parsed as { payload?: unknown }).payload;
    try {
      this.frameHandler?.(subId, projection);
    } catch (err) {
      log.warn('frame handler threw', {
        subId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  constructor(opts: CdpWsPageBridgeOptions) {
    this.browser = opts.browser;
  }

  async installRouter(targetId: string): Promise<void> {
    if (this.installs.has(targetId)) return;
    // Attach the global binding listener lazily so a bridge with no
    // installs holds no transport subscriptions.
    this.ensureBindingListener();
    const result = await this.browser.withTab(targetId, async () => {
      await this.browser.sendCDP('Runtime.enable');
      await this.browser.sendCDP('Runtime.addBinding', { name: BINDING_NAME });
      const r = await this.browser.sendCDP('Page.addScriptToEvaluateOnNewDocument', {
        source: WS_ROUTER_SOURCE,
      });
      // Run the router in the current document too — the
      // `addScriptToEvaluateOnNewDocument` registration only fires
      // on subsequent navigations.
      await this.browser.sendCDP('Runtime.evaluate', {
        expression: WS_ROUTER_SOURCE,
        returnByValue: true,
      });
      return r;
    });
    const scriptIdentifier =
      typeof result['identifier'] === 'string' ? (result['identifier'] as string) : null;
    this.installs.set(targetId, { scriptIdentifier });
  }

  async registerSelector(
    targetId: string,
    subId: string,
    urlMatch: string | undefined,
    filter: WsSelector | undefined
  ): Promise<void> {
    await this.evalRouterCall(targetId, 'register', {
      id: subId,
      ...(urlMatch !== undefined ? { urlMatch } : {}),
      ...(filter !== undefined ? { filter } : {}),
    });
  }

  async updateSelector(
    targetId: string,
    subId: string,
    urlMatch: string | null | undefined,
    filter: WsSelector | null | undefined
  ): Promise<void> {
    await this.browser.withTab(targetId, async () => {
      // Tri-state: `undefined` is omitted from the patch (router keeps
      // the field), an explicit `null` is forwarded so the router can
      // `delete` the field, and any value sets it. Without the explicit
      // clear directive, `sub.update({ filter: null })` would leave the
      // page-side router matching with stale criteria.
      const patch: Record<string, unknown> = {};
      if (urlMatch === null) patch['urlMatch'] = null;
      else if (urlMatch !== undefined) patch['urlMatch'] = urlMatch;
      if (filter === null) patch['filter'] = null;
      else if (filter !== undefined) patch['filter'] = filter;
      const expr = `window.__sliccWsRouter && window.__sliccWsRouter.update(${JSON.stringify(subId)}, ${JSON.stringify(patch)})`;
      await this.browser.sendCDP('Runtime.evaluate', { expression: expr, returnByValue: true });
    });
  }

  async unregisterSelector(targetId: string, subId: string): Promise<void> {
    await this.browser.withTab(targetId, async () => {
      const expr = `window.__sliccWsRouter && window.__sliccWsRouter.unregister(${JSON.stringify(subId)})`;
      await this.browser.sendCDP('Runtime.evaluate', { expression: expr, returnByValue: true });
    });
  }

  onMatchedFrame(handler: (subId: string, payload: unknown) => void): () => void {
    this.frameHandler = handler;
    return () => {
      if (this.frameHandler === handler) this.frameHandler = null;
    };
  }

  /**
   * Tear down the binding-called subscription. Idempotent. Called by
   * `KernelHost.dispose`. Per-tab init-scripts are left registered —
   * the tab's own lifecycle owns the page-side state.
   */
  dispose(): void {
    if (this.bindingListenerAttached) {
      this.browser.getTransport().off('Runtime.bindingCalled', this.onBindingCalled);
      this.bindingListenerAttached = false;
    }
    this.installs.clear();
    this.frameHandler = null;
  }

  private ensureBindingListener(): void {
    if (this.bindingListenerAttached) return;
    this.browser.getTransport().on('Runtime.bindingCalled', this.onBindingCalled);
    this.bindingListenerAttached = true;
  }

  private async evalRouterCall(
    targetId: string,
    method: 'register' | 'update' | 'unregister',
    arg: unknown
  ): Promise<void> {
    await this.browser.withTab(targetId, async () => {
      const expr = `window.__sliccWsRouter && window.__sliccWsRouter.${method}(${JSON.stringify(arg)})`;
      await this.browser.sendCDP('Runtime.evaluate', { expression: expr, returnByValue: true });
    });
  }
}
