/**
 * `realm-ws-observer.ts` — the realm-side `browser.websocket` chainable
 * observer API. Extracted from `js-realm-shared.ts`; no behavior change.
 */
import { resolveTargetId } from './realm-browser-bridge.js';
import type { RealmRpcClient } from './realm-rpc.js';
import type { TabHandle, WsSelector, WsSink, WsSubscriberInfo } from './realm-types.js';

/**
 * Builder for a `browser.websocket.on(tab, opts)` chain. The selector
 * (`.filter`) and sink (`.forward`) are collected on the builder; the
 * actual subscriber is created by the await on `.forward(...)`, which
 * resolves to a {@link WsSubscriberHandle}.
 */
export interface WsObserverBuilder {
  filter(selector: WsSelector): WsObserverBuilder;
  forward(sink: WsSink): Promise<WsSubscriberHandle>;
}

export interface WsSubscriberHandle extends WsSubscriberInfo {
  update(patch: {
    urlMatch?: string | RegExp | null;
    filter?: WsSelector | null;
  }): Promise<WsSubscriberInfo>;
  close(): Promise<boolean>;
}

export interface WsObserverApi {
  on(tab: TabHandle | string, opts?: { urlMatch?: string | RegExp }): WsObserverBuilder;
  list(): Promise<WsSubscriberInfo[]>;
}

/**
 * Construct the realm-side `browser.websocket` chainable API. All
 * actual work happens host-side; this file just shapes the builder
 * surface and forwards JSON-safe payloads over the `browser` RPC
 * channel.
 */
export function createWsObserverApi(rpc: RealmRpcClient): WsObserverApi {
  function makeHandle(info: WsSubscriberInfo): WsSubscriberHandle {
    return {
      ...info,
      async update(patch): Promise<WsSubscriberInfo> {
        const wire: { urlMatch?: string | null; filter?: WsSelector | null } = {};
        if (patch.urlMatch !== undefined) {
          wire.urlMatch =
            patch.urlMatch === null
              ? null
              : patch.urlMatch instanceof RegExp
                ? patch.urlMatch.source
                : patch.urlMatch;
        }
        if (patch.filter !== undefined) wire.filter = patch.filter;
        return rpc.call<WsSubscriberInfo>('browser', 'wsUpdate', [info.id, wire]);
      },
      async close(): Promise<boolean> {
        return rpc.call<boolean>('browser', 'wsClose', [info.id]);
      },
    };
  }

  return {
    on(tab, opts = {}) {
      const targetId = resolveTargetId(tab);
      const urlMatch =
        opts.urlMatch === undefined
          ? undefined
          : opts.urlMatch instanceof RegExp
            ? opts.urlMatch.source
            : opts.urlMatch;
      let selector: WsSelector | undefined;
      const builder: WsObserverBuilder = {
        filter(next) {
          if (typeof next === 'function' || typeof next === 'string') {
            throw new TypeError(
              'browser.websocket: filter must be a declarative JSON object, not a function or string'
            );
          }
          selector = next;
          return builder;
        },
        async forward(sink) {
          const info = await rpc.call<WsSubscriberInfo>('browser', 'wsObserve', [
            { targetId, urlMatch, filter: selector, forward: sink },
          ]);
          return makeHandle(info);
        },
      };
      return builder;
    },
    async list() {
      return rpc.call<WsSubscriberInfo[]>('browser', 'wsList', []);
    },
  };
}
