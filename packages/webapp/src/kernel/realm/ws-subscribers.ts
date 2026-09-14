import { createLogger } from '../../base/logger.js';
import { normalizePath } from '../../fs/path-utils.js';
import type { WsObserveRequest, WsSelector, WsSubscriberInfo } from './realm-types.js';

const log = createLogger('ws-subscribers');

export interface WsPageBridge {
  installRouter(targetId: string): Promise<void>;
  registerSelector(
    targetId: string,
    subId: string,
    urlMatch: string | undefined,
    filter: WsSelector | undefined
  ): Promise<void>;

  updateSelector(
    targetId: string,
    subId: string,
    urlMatch: string | null | undefined,
    filter: WsSelector | null | undefined
  ): Promise<void>;
  unregisterSelector(targetId: string, subId: string): Promise<void>;

  onMatchedFrame(handler: (subId: string, payload: unknown) => void): () => void;
}

export interface WsSinkDispatcher {
  webhook(webhookId: string, payload: unknown): Promise<void> | void;
  scoop(scoopJid: string, payload: unknown): Promise<void> | void;
  vfs(path: string, payload: unknown): Promise<void> | void;
  log(payload: unknown): void;
}

export interface WsWebhookResolver {
  has(id: string): boolean;
}

export interface WsSubscriberRegistryOptions {
  bridge: WsPageBridge;
  webhooks: WsWebhookResolver;
  dispatcher: WsSinkDispatcher;
}

type Subscriber = WsSubscriberInfo;

export class WsSubscriberRegistry {
  private readonly subs = new Map<string, Subscriber>();

  private readonly tabRefs = new Map<string, number>();
  private readonly bridge: WsPageBridge;
  private readonly webhooks: WsWebhookResolver;
  private readonly dispatcher: WsSinkDispatcher;
  private readonly unsubscribeBridge: () => void;
  private seq = 1;

  constructor(opts: WsSubscriberRegistryOptions) {
    this.bridge = opts.bridge;
    this.webhooks = opts.webhooks;
    this.dispatcher = opts.dispatcher;
    this.unsubscribeBridge = this.bridge.onMatchedFrame((subId, payload) => {
      void this.handleFrame(subId, payload);
    });
  }

  async observe(req: WsObserveRequest): Promise<WsSubscriberInfo> {
    this.validateSink(req);
    const id = `wssub-${this.seq++}-${Date.now().toString(36)}`;
    const sub: Subscriber = {
      id,
      targetId: req.targetId,
      urlMatch: req.urlMatch,
      filter: req.filter,
      forward: req.forward,
      scoopJid: req.scoopJid,
      createdAt: new Date().toISOString(),
    };
    const refs = this.tabRefs.get(req.targetId) ?? 0;
    if (refs === 0) await this.bridge.installRouter(req.targetId);
    this.tabRefs.set(req.targetId, refs + 1);
    try {
      await this.bridge.registerSelector(req.targetId, id, req.urlMatch, req.filter);
    } catch (err) {
      this.releaseTab(req.targetId);
      throw err;
    }
    this.subs.set(id, sub);
    return this.toInfo(sub);
  }

  async update(
    id: string,
    patch: { urlMatch?: string | null; filter?: WsSelector | null }
  ): Promise<WsSubscriberInfo> {
    const sub = this.subs.get(id);
    if (!sub) throw new Error(`browser.websocket: subscriber not found: ${id}`);

    const urlMatchUpdate: string | null | undefined = patch.urlMatch;
    const filterUpdate: WsSelector | null | undefined = patch.filter;
    await this.bridge.updateSelector(sub.targetId, id, urlMatchUpdate, filterUpdate);
    if (patch.urlMatch === null) delete sub.urlMatch;
    else if (patch.urlMatch !== undefined) sub.urlMatch = patch.urlMatch;
    if (patch.filter === null) delete sub.filter;
    else if (patch.filter !== undefined) sub.filter = patch.filter;
    return this.toInfo(sub);
  }

  async close(id: string): Promise<boolean> {
    const sub = this.subs.get(id);
    if (!sub) return false;
    this.subs.delete(id);
    try {
      await this.bridge.unregisterSelector(sub.targetId, id);
    } catch (err) {
      log.warn('unregisterSelector failed during close', {
        id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    this.releaseTab(sub.targetId);
    return true;
  }

  list(): WsSubscriberInfo[] {
    return Array.from(this.subs.values(), (s) => this.toInfo(s));
  }

  async dropForScoop(scoopJid: string): Promise<number> {
    const victims = Array.from(this.subs.values()).filter((s) => s.scoopJid === scoopJid);
    for (const v of victims) {
      await this.close(v.id);
    }
    return victims.length;
  }

  dispose(): void {
    this.unsubscribeBridge();
    this.subs.clear();
    this.tabRefs.clear();
  }

  private validateSink(req: WsObserveRequest): void {
    const sink = req.forward;
    if (!sink || typeof sink !== 'object') {
      throw new Error('browser.websocket: forward.sink is required');
    }
    switch (sink.sink) {
      case 'webhook':
        if (typeof sink.webhookId !== 'string' || !sink.webhookId.trim()) {
          throw new Error('browser.websocket: webhook sink requires a webhookId');
        }
        if (!this.webhooks.has(sink.webhookId)) {
          throw new Error(
            `browser.websocket: webhookId "${sink.webhookId}" is not registered; create it with \`webhook create\` first`
          );
        }
        return;
      case 'scoop':
        if (typeof sink.scoopJid !== 'string' || !sink.scoopJid.trim()) {
          throw new Error('browser.websocket: scoop sink requires a scoopJid');
        }
        return;
      case 'vfs': {
        if (typeof sink.path !== 'string' || !sink.path.startsWith('/workspace/')) {
          throw new Error(
            'browser.websocket: vfs sink path must be an absolute /workspace/... path'
          );
        }

        const normalized = normalizePath(sink.path);
        if (!normalized.startsWith('/workspace/') && normalized !== '/workspace') {
          throw new Error(
            `browser.websocket: vfs sink path escapes /workspace/ after normalization (got "${sink.path}" → "${normalized}")`
          );
        }
        return;
      }
      case 'log':
        return;
      default:
        throw new Error(
          `browser.websocket: unknown sink "${(sink as { sink?: string }).sink ?? ''}"`
        );
    }
  }

  private releaseTab(targetId: string): void {
    const refs = (this.tabRefs.get(targetId) ?? 1) - 1;
    if (refs <= 0) this.tabRefs.delete(targetId);
    else this.tabRefs.set(targetId, refs);
  }

  private toInfo(s: Subscriber): WsSubscriberInfo {
    const info: WsSubscriberInfo = {
      id: s.id,
      targetId: s.targetId,
      forward: s.forward,
      createdAt: s.createdAt,
    };
    if (s.urlMatch !== undefined) info.urlMatch = s.urlMatch;
    if (s.filter !== undefined) info.filter = s.filter;
    if (s.scoopJid !== undefined) info.scoopJid = s.scoopJid;
    return info;
  }

  private async handleFrame(subId: string, payload: unknown): Promise<void> {
    const sub = this.subs.get(subId);
    if (!sub) return;
    const sink = sub.forward;
    try {
      switch (sink.sink) {
        case 'webhook':
          await this.dispatcher.webhook(sink.webhookId, payload);
          return;
        case 'scoop':
          await this.dispatcher.scoop(sink.scoopJid, payload);
          return;
        case 'vfs':
          await this.dispatcher.vfs(sink.path, payload);
          return;
        case 'log':
          this.dispatcher.log(payload);
          return;
      }
    } catch (err) {
      log.warn('sink dispatch failed', {
        subId,
        sink: sink.sink,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
