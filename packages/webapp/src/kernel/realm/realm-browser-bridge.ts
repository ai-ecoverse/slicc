/**
 * `realm-browser-bridge.ts` — the realm `browser` global: tab lookup, page
 * eval, cookie/localStorage reads, `browser.fetch`, and the websocket
 * observer. Extracted from `js-realm-shared.ts`; no behavior change.
 */
import {
  type BrowserFetchOptions,
  type BrowserFetchResult,
  buildBrowserFetchScript,
} from './realm-browser-fetch.js';
import { type RealmRpcClient } from './realm-rpc.js';
import type { TabHandle } from './realm-types.js';
import { createWsObserverApi } from './realm-ws-observer.js';

export function serializeRequestInit(
  init: RequestInit | undefined,
  input: string | URL | Request
): RequestInit | undefined {
  if (!init && !(input instanceof Request)) return undefined;
  const fromRequest = input instanceof Request ? input : null;
  const method = (init?.method ?? fromRequest?.method ?? 'GET').toUpperCase();
  const headers: Record<string, string> = {};
  if (init?.headers) {
    if (init.headers instanceof Headers) {
      init.headers.forEach((v, k) => {
        headers[k] = v;
      });
    } else if (Array.isArray(init.headers)) {
      for (const [k, v] of init.headers) headers[k] = v;
    } else {
      Object.assign(headers, init.headers);
    }
  } else if (fromRequest) {
    fromRequest.headers.forEach((v, k) => {
      headers[k] = v;
    });
  }
  let body: string | undefined;
  if (init?.body !== undefined && init?.body !== null && init?.body !== '') {
    body = typeof init.body === 'string' ? init.body : String(init.body);
  }
  return { method, headers, body };
}

// ---------------------------------------------------------------------------
// `browser` global helpers
// ---------------------------------------------------------------------------

/** Accept either a `TabHandle` (from `findTab`/`ensureTab`) or a bare targetId. */
/**
 * Kernel-side CDP `browser` bridge — wraps the same BrowserAPI `playwright-cli`
 * uses so standalone and extension floats share one realm surface. Accepts a
 * `TabHandle` (from `findTab` / `ensureTab`) or a bare `targetId` string;
 * `eval` / `evalAsync` serialize functions to a string call expression so realm
 * code can pass a closure as ergonomically as a string.
 */
export function createBrowserBridge(rpc: RealmRpcClient) {
  return {
    findTab: (query: { domain?: string; urlMatch?: string | RegExp }): Promise<TabHandle | null> =>
      rpc.call('browser', 'findTab', [normalizeUrlMatchQuery(query)]),
    ensureTab: (url: string, options: { matchUrl?: string | RegExp } = {}): Promise<TabHandle> =>
      rpc.call('browser', 'ensureTab', [url, normalizeMatchUrl(options)]),
    eval: (tab: TabHandle | string, fnOrCode: ((..._args: unknown[]) => unknown) | string) =>
      rpc.call('browser', 'eval', [resolveTargetId(tab), serializeEvalSource(fnOrCode, false)]),
    evalAsync: (tab: TabHandle | string, fnOrCode: ((..._args: unknown[]) => unknown) | string) =>
      rpc.call('browser', 'evalAsync', [resolveTargetId(tab), serializeEvalSource(fnOrCode, true)]),
    cookie: (tab: TabHandle | string, name: string): Promise<string | null> =>
      rpc.call('browser', 'cookie', [resolveTargetId(tab), name]),
    localStorage: (tab: TabHandle | string, key: string): Promise<string | null> =>
      rpc.call('browser', 'localStorage', [resolveTargetId(tab), key]),
    fetch: (
      tab: TabHandle | string,
      url: string,
      opts: BrowserFetchOptions = {}
    ): Promise<BrowserFetchResult> =>
      buildBrowserFetchScript(url, opts).then((script) =>
        rpc.call('browser', 'evalAsync', [resolveTargetId(tab), script])
      ) as Promise<BrowserFetchResult>,
    websocket: createWsObserverApi(rpc),
  };
}

export function resolveTargetId(tab: TabHandle | string): string {
  if (typeof tab === 'string') return tab;
  if (tab && typeof tab === 'object' && typeof tab.targetId === 'string') return tab.targetId;
  throw new TypeError('browser: expected a tab handle or targetId string');
}

/**
 * Serialize a function or string into a self-calling expression
 * suitable for `Runtime.evaluate`. For functions we emit
 * `(<fn.toString()>)()` so the page sees an IIFE; for strings we
 * pass them through verbatim so user-authored snippets keep working.
 * `awaitPromise` is purely a CDP-side flag — the source string is
 * the same either way, but we keep the parameter explicit so a
 * future tweak to wrap async function bodies has a hook.
 */
function serializeEvalSource(
  source: ((..._args: unknown[]) => unknown) | string,
  _awaitPromise: boolean
): string {
  if (typeof source === 'function') {
    return `(${source.toString()})()`;
  }
  if (typeof source === 'string') return source;
  throw new TypeError('browser.eval/evalAsync: source must be a function or string');
}

/**
 * Coerce the realm-side `urlMatch` (RegExp or string) into the
 * pattern source the host expects. Allowing both lets realm code
 * write the natural literal-RegExp form without losing the
 * structured-clone safety of a string crossing the port.
 */
function normalizeUrlMatchQuery(query: { domain?: string; urlMatch?: string | RegExp }): {
  domain?: string;
  urlMatch?: string;
} {
  const out: { domain?: string; urlMatch?: string } = {};
  if (query.domain !== undefined) out.domain = query.domain;
  if (query.urlMatch !== undefined) {
    out.urlMatch = query.urlMatch instanceof RegExp ? query.urlMatch.source : query.urlMatch;
  }
  return out;
}

function normalizeMatchUrl(options: { matchUrl?: string | RegExp }): { matchUrl?: string } {
  if (options.matchUrl === undefined) return {};
  return {
    matchUrl: options.matchUrl instanceof RegExp ? options.matchUrl.source : options.matchUrl,
  };
}
