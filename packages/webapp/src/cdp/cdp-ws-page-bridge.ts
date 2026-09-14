import { createLogger } from '../base/logger.js';
import type { WsSelector } from '../kernel/realm/realm-types.js';
import { WS_ROUTER_SOURCE } from '../kernel/realm/ws-router-page.js';
import type { WsPageBridge } from '../kernel/realm/ws-subscribers.js';
import type { BrowserAPI } from './browser-api.js';

const log = createLogger('cdp-ws-page-bridge');

const BINDING_NAME = '__sliccWsRouterReport';

interface RuntimeBindingCalledParams {
  name?: unknown;
  payload?: unknown;
}

interface WsRouterBindingReport {
  subId?: unknown;
  payload?: unknown;
}

interface WsRouterUpdatePatch {
  urlMatch?: string | null;
  filter?: WsSelector | null;
}

export interface CdpWsPageBridgeOptions {
  browser: BrowserAPI;
}

export class CdpWsPageBridge implements WsPageBridge {
  private readonly browser: BrowserAPI;

  private readonly installs = new Map<string, { scriptIdentifier: string | null }>();
  private frameHandler: ((subId: string, payload: unknown) => void) | null = null;
  private bindingListenerAttached = false;

  private readonly onBindingCalled = (params: RuntimeBindingCalledParams): void => {
    if (params.name !== BINDING_NAME) return;
    const payload = params.payload;
    if (typeof payload !== 'string') return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return;
    }
    if (typeof parsed !== 'object' || parsed === null) return;
    const report = parsed as WsRouterBindingReport;
    const subId = report.subId;
    if (typeof subId !== 'string') return;
    const projection = report.payload;
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

    this.ensureBindingListener();
    const result = await this.browser.withTab(targetId, async (page) => {
      await page.send('Runtime.enable');
      await page.send('Runtime.addBinding', { name: BINDING_NAME });
      const r = await page.send('Page.addScriptToEvaluateOnNewDocument', {
        source: WS_ROUTER_SOURCE,
      });

      await page.send('Runtime.evaluate', {
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
    await this.browser.withTab(targetId, async (page) => {
      const patch: WsRouterUpdatePatch = {};
      if (urlMatch === null) patch.urlMatch = null;
      else if (urlMatch !== undefined) patch.urlMatch = urlMatch;
      if (filter === null) patch.filter = null;
      else if (filter !== undefined) patch.filter = filter;
      const expr = `window.__sliccWsRouter && window.__sliccWsRouter.update(${JSON.stringify(subId)}, ${JSON.stringify(patch)})`;
      await page.send('Runtime.evaluate', { expression: expr, returnByValue: true });
    });
  }

  async unregisterSelector(targetId: string, subId: string): Promise<void> {
    await this.browser.withTab(targetId, async (page) => {
      const expr = `window.__sliccWsRouter && window.__sliccWsRouter.unregister(${JSON.stringify(subId)})`;
      await page.send('Runtime.evaluate', { expression: expr, returnByValue: true });
    });
  }

  onMatchedFrame(handler: (subId: string, payload: unknown) => void): () => void {
    this.frameHandler = handler;
    return () => {
      if (this.frameHandler === handler) this.frameHandler = null;
    };
  }

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
    await this.browser.withTab(targetId, async (page) => {
      const expr = `window.__sliccWsRouter && window.__sliccWsRouter.${method}(${JSON.stringify(arg)})`;
      await page.send('Runtime.evaluate', { expression: expr, returnByValue: true });
    });
  }
}
