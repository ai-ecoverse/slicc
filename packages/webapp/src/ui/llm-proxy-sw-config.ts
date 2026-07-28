/**
 * Bridge-mode forwarding config for `llm-proxy-sw.ts`.
 *
 * Extracted so tests can exercise the rewrite logic without standing
 * up a `ServiceWorkerGlobalScope`. The SW bundle stays an IIFE — this
 * module is imported by both the SW and its tests.
 *
 * Background: in thin-bridge mode the SLICC UI is served by the hosted
 * leader at `https://www.sliccy.ai`, which has no `/api/fetch-proxy`.
 * The local node-server provides `/api/fetch-proxy` on its own loopback
 * origin (`http://localhost:<port>`) and gates non-loopback callers on
 * an `X-Bridge-Token` header. The LLM-proxy SW must therefore rewrite
 * the same-origin `/api/fetch-proxy` target → the local node-server
 * origin and attach the bridge token in that mode. Outside bridge mode
 * (normal standalone/CLI) the SW continues to use the same-origin path.
 *
 * The page hands the SW its `{apiBaseUrl, token}` via a `postMessage`
 * (see `boot/setup-sw-registration.ts`); the SW caches it in a module
 * variable. On a cache miss (e.g. SW evicted then restarted by the
 * browser, message lost), the SW falls back to parsing `bridge` /
 * `bridgeToken` from the controlling client's URL.
 */

import type { RequestMsg } from '../../../chrome-extension/src/fetch-proxy-shared.js';
import {
  LEADER_EXT_ID_QUERY_NAME,
  LEADER_RUNTIME_QUERY_NAME,
  LEADER_RUNTIME_QUERY_VALUE,
} from '../kernel/messages.js';
import {
  BRIDGE_TOKEN_QUERY_PARAM,
  BRIDGE_WS_QUERY_PARAM,
  deriveBridgeApiBaseUrl,
} from './boot/bridge-launch-params.js';

/** `postMessage` type tag used by the page → SW config push. */
export const SW_BRIDGE_CONFIG_MESSAGE = 'slicc:bridge-config';

export interface BridgeConfigMessage {
  type: typeof SW_BRIDGE_CONFIG_MESSAGE;
  /** Absolute local node-server origin, e.g. `http://localhost:5710`. */
  apiBaseUrl: string | null;
  /** Per-process bridge token (same one the page sends as `X-Bridge-Token`). */
  token: string | null;
}

export interface ResolvedBridgeConfig {
  /** Absolute local node-server origin, never trailing-slashed. */
  apiBaseUrl: string;
  /** Per-process bridge token. */
  token: string;
}

/**
 * Resolve the bridge config to use for an inbound fetch. Prefers the
 * cached value posted by the page; falls back to parsing the controlling
 * client URL so the SW survives eviction/restart without losing thin-bridge
 * mode. Returns `null` when bridge mode is not in effect — the caller
 * should then target same-origin `/api/fetch-proxy` with no token header.
 */
export function resolveBridgeConfig(
  cached: { apiBaseUrl: string | null; token: string | null } | null,
  clientUrl: string | null
): ResolvedBridgeConfig | null {
  if (cached?.apiBaseUrl && cached.token) {
    return {
      apiBaseUrl: cached.apiBaseUrl.replace(/\/+$/, ''),
      token: cached.token,
    };
  }
  if (!clientUrl) return null;
  let parsed: URL;
  try {
    parsed = new URL(clientUrl);
  } catch {
    return null;
  }
  const wsUrl = parsed.searchParams.get(BRIDGE_WS_QUERY_PARAM);
  const token = parsed.searchParams.get(BRIDGE_TOKEN_QUERY_PARAM);
  if (!wsUrl || !token) return null;
  const apiBaseUrl = deriveBridgeApiBaseUrl(wsUrl);
  if (!apiBaseUrl) return null;
  return { apiBaseUrl: apiBaseUrl.replace(/\/+$/, ''), token };
}

/**
 * Resolve the bridge config from an ordered list of candidate client URLs.
 *
 * The single-client `resolveBridgeConfig` is insufficient when the
 * triggering fetch comes from the kernel DedicatedWorker (or an empty
 * client id), whose URL carries no `bridge` / `bridgeToken` params. The
 * SW recovers by also consulting the page window clients via
 * `self.clients.matchAll({ type: 'window' })`. The cached `postMessage`
 * config still wins (fast path); only on cache miss do we iterate the
 * candidate URLs in order, returning the first one that carries the
 * launch params.
 */
export function resolveBridgeFromClientUrls(
  cached: { apiBaseUrl: string | null; token: string | null } | null,
  clientUrls: (string | null)[]
): ResolvedBridgeConfig | null {
  if (cached?.apiBaseUrl && cached.token) {
    return resolveBridgeConfig(cached, null);
  }
  for (const url of clientUrls) {
    const resolved = resolveBridgeConfig(null, url);
    if (resolved) return resolved;
  }
  return null;
}

/**
 * Build the absolute `/api/fetch-proxy` URL the SW should hit. In bridge
 * mode the local node-server origin is prepended; otherwise the legacy
 * same-origin path is returned unchanged.
 */
export function resolveFetchProxyTarget(
  fetchProxyPath: string,
  config: ResolvedBridgeConfig | null
): string {
  return config ? `${config.apiBaseUrl}${fetchProxyPath}` : fetchProxyPath;
}

/**
 * True when `requestUrl` targets any `/api/*` endpoint at the configured
 * `bridgeApiBaseUrl`. Used by the SW to recognize direct calls to the local
 * node-server's API surface — these should pass through with the caller's
 * original headers intact (including `X-Bridge-Token`) rather than being
 * re-routed through `/api/fetch-proxy`, which would strip the bridge token
 * and decode `X-Proxy-Origin` back onto the internal request, causing the
 * node-server's CORS middleware to reject with `bridge-token-required`.
 */
export function isBridgeLocalApiUrl(requestUrl: string, bridgeApiBaseUrl: string): boolean {
  let bridge: URL;
  let target: URL;
  try {
    bridge = new URL(bridgeApiBaseUrl);
    target = new URL(requestUrl);
  } catch {
    return false;
  }
  return target.origin === bridge.origin && target.pathname.startsWith('/api/');
}

/**
 * True when `requestUrl` already targets the bridge's own `/api/fetch-proxy`
 * endpoint at the configured `bridgeApiBaseUrl`. Used by the SW (cross-origin
 * analogue of the same-origin pass-through) and the kernel worker's
 * fetch-bypass wrapper to recognize "this is already our forward target, do
 * not re-proxy / preserve the caller's `X-Target-URL`".
 *
 * Comparison normalizes on `URL` parsing (origin compare + exact pathname
 * match) so trailing slashes and query strings don't affect the result.
 * Unparseable inputs return `false` — the caller falls through to the
 * default proxy path, which is no worse than today's behavior.
 */
export function isBridgeFetchProxyUrl(
  requestUrl: string,
  bridgeApiBaseUrl: string,
  fetchProxyPath = '/api/fetch-proxy'
): boolean {
  let bridge: URL;
  let target: URL;
  try {
    bridge = new URL(bridgeApiBaseUrl);
    target = new URL(requestUrl);
  } catch {
    return false;
  }
  return target.origin === bridge.origin && target.pathname === fetchProxyPath;
}

/**
 * Type guard for inbound `MessageEvent.data` — the SW only acts on
 * messages tagged with `SW_BRIDGE_CONFIG_MESSAGE` and ignores anything
 * else (other code may be using `postMessage` against the SW too).
 */
export function isBridgeConfigMessage(value: unknown): value is BridgeConfigMessage {
  if (!value || typeof value !== 'object') return false;
  const v = value as { type?: unknown };
  return v.type === SW_BRIDGE_CONFIG_MESSAGE;
}

/**
 * Per-client cache for thin-bridge config posted from the page → SW.
 *
 * Keyed by the posting client's id (`MessageEvent.source.id` on inbound
 * `postMessage`; `FetchEvent.clientId` on the consume side) so that two
 * leader tabs open at the same hosted origin don't clobber each other:
 * without this, the second tab's config overwrites the first tab's
 * entry in a module-level global, and the first tab's subsequent LLM /
 * curl requests are then sent to the wrong localhost bridge / token.
 *
 * Cleanup policy: entries are removed when an empty config (null
 * apiBaseUrl or token) is posted by the same client. We intentionally do
 * NOT actively reap entries against `clients.matchAll()` — service
 * worker lifetime is bounded by the browser session, the Map only ever
 * holds one entry per leader tab in scope, and the fallback path in the
 * SW (`resolveBridgeFromClientUrls`) gracefully handles a missing-cache
 * lookup by re-parsing the controlling client's URL.
 */
export class BridgeConfigCache {
  private readonly byClient = new Map<string, ResolvedBridgeConfig>();

  /**
   * Record (or clear) the bridge config for one client. A partial
   * payload (null apiBaseUrl or token) deletes the entry — symmetric
   * with the pre-existing "treat nulls as cache-miss" semantics used by
   * `resolveBridgeConfig`.
   */
  set(clientId: string, payload: { apiBaseUrl: string | null; token: string | null }): void {
    if (!clientId) return;
    if (!payload.apiBaseUrl || !payload.token) {
      this.byClient.delete(clientId);
      return;
    }
    this.byClient.set(clientId, {
      apiBaseUrl: payload.apiBaseUrl.replace(/\/+$/, ''),
      token: payload.token,
    });
  }

  /**
   * Look up the cached config for a client. Returns `null` for unknown
   * or empty client ids; the caller then falls back to URL parsing via
   * `resolveBridgeFromClientUrls`.
   */
  get(clientId: string | null | undefined): ResolvedBridgeConfig | null {
    if (!clientId) return null;
    return this.byClient.get(clientId) ?? null;
  }

  /** Drop one client's entry (used when a client explicitly clears config). */
  delete(clientId: string): void {
    this.byClient.delete(clientId);
  }

  /** Total entries — exposed for tests / diagnostics, not consumed by the SW. */
  size(): number {
    return this.byClient.size;
  }
}

// ---------------------------------------------------------------------------
// Extension-delegate mode (thin Chrome extension, pinned hosted leader tab)
// ---------------------------------------------------------------------------
//
// The thin Chrome extension pins a hosted leader tab at
// `https://www.sliccy.ai/?slicc=leader&ext=<id>`. That origin has no
// `/api/fetch-proxy`, and — unlike thin-bridge mode — there is no local
// node-server to rewrite the target onto. Cross-origin LLM fetches must
// instead route through the extension service worker's secret-aware fetch
// proxy. The LLM-proxy SW cannot reach `chrome.runtime` (service workers on a
// web origin have no extension API), so it delegates the fetch to a window
// client (the leader tab) that CAN open
// `chrome.runtime.connect(<id>, { name: 'fetch-proxy.fetch' })`. The page
// pipes the request to the extension and streams the response back over a
// transferred `MessagePort`. See `llm-proxy-extension-delegate.ts` (SW-side
// stream builder) and `boot/setup-extension-fetch-delegate.ts` (page side).
//
// Detection mirrors the thin-bridge config: a `postMessage` cache (fast path)
// with a fallback to parsing `slicc=leader` + `ext=<id>` from the window
// client URLs so the SW survives eviction without losing delegate mode.

/** `postMessage` type tag for the page → SW extension-delegate config push. */
export const SW_EXTENSION_DELEGATE_MESSAGE = 'slicc:extension-delegate-config';

/** `postMessage` type tag for the SW → page delegated-fetch envelope. */
export const SW_EXTENSION_FETCH_MESSAGE = 'slicc:ext-fetch';

export interface ExtensionDelegateConfigMessage {
  type: typeof SW_EXTENSION_DELEGATE_MESSAGE;
  /** Extension id the leader tab can `chrome.runtime.connect` to. `null` clears. */
  extensionId: string | null;
}

export interface ResolvedExtensionDelegate {
  /** Extension id the leader tab opens the fetch-proxy Port to. */
  extensionId: string;
}

/**
 * SW → page delegated-fetch envelope. Posted to a window client alongside a
 * transferred `MessagePort` (the response channel). The `request` field is the
 * extension fetch-proxy wire shape minus its `type` discriminator — the page
 * re-adds `type: 'request'` before posting it to the extension Port.
 */
export interface ExtensionFetchDelegateRequest {
  type: typeof SW_EXTENSION_FETCH_MESSAGE;
  /** Correlation id (one MessageChannel per request; carried for logging). */
  requestId: string;
  /** Extension id the page should `chrome.runtime.connect` to. */
  extensionId: string;
  /** Upstream request in the extension fetch-proxy wire shape. */
  request: Omit<RequestMsg, 'type'>;
}

/** Type guard for the page → SW extension-delegate config message. */
export function isExtensionDelegateMessage(
  value: unknown
): value is ExtensionDelegateConfigMessage {
  if (!value || typeof value !== 'object') return false;
  return (value as { type?: unknown }).type === SW_EXTENSION_DELEGATE_MESSAGE;
}

/** Type guard for the SW → page delegated-fetch envelope. */
export function isExtensionFetchDelegateRequest(
  value: unknown
): value is ExtensionFetchDelegateRequest {
  if (!value || typeof value !== 'object') return false;
  const v = value as { type?: unknown; extensionId?: unknown; request?: unknown };
  return (
    v.type === SW_EXTENSION_FETCH_MESSAGE &&
    typeof v.extensionId === 'string' &&
    !!v.request &&
    typeof v.request === 'object'
  );
}

/**
 * Parse the extension id from a pinned-leader-tab client URL. Returns the id
 * only when the URL carries BOTH `slicc=leader` and a non-empty `ext=<id>`
 * (the pair the SW appends when it pins the leader tab). Returns `null` for
 * any other URL (the kernel worker, a non-leader page, an unparseable URL).
 */
export function parseExtensionDelegateFromClientUrl(
  clientUrl: string | null
): ResolvedExtensionDelegate | null {
  if (!clientUrl) return null;
  let parsed: URL;
  try {
    parsed = new URL(clientUrl);
  } catch {
    return null;
  }
  if (parsed.searchParams.get(LEADER_RUNTIME_QUERY_NAME) !== LEADER_RUNTIME_QUERY_VALUE) {
    return null;
  }
  const extensionId = parsed.searchParams.get(LEADER_EXT_ID_QUERY_NAME);
  if (!extensionId) return null;
  return { extensionId };
}

/**
 * Resolve the extension-delegate config for an inbound fetch. The cached value
 * posted by the page wins; on a cache miss we scan the candidate client URLs
 * (the triggering client + the page window clients) for the pinned-leader
 * params. Returns `null` when extension-delegate mode is not in effect.
 */
export function resolveExtensionDelegate(
  cached: ResolvedExtensionDelegate | null,
  clientUrls: (string | null)[]
): ResolvedExtensionDelegate | null {
  if (cached?.extensionId) return { extensionId: cached.extensionId };
  for (const url of clientUrls) {
    const resolved = parseExtensionDelegateFromClientUrl(url);
    if (resolved) return resolved;
  }
  return null;
}

/**
 * Per-client cache for the extension-delegate config posted from the page →
 * SW. Keyed by the posting client's id (same rationale as
 * {@link BridgeConfigCache}) so two leader tabs at the same hosted origin
 * don't clobber each other. A null/empty extensionId deletes the entry.
 */
export class ExtensionDelegateCache {
  private readonly byClient = new Map<string, ResolvedExtensionDelegate>();

  set(clientId: string, payload: { extensionId: string | null }): void {
    if (!clientId) return;
    if (!payload.extensionId) {
      this.byClient.delete(clientId);
      return;
    }
    this.byClient.set(clientId, { extensionId: payload.extensionId });
  }

  get(clientId: string | null | undefined): ResolvedExtensionDelegate | null {
    if (!clientId) return null;
    return this.byClient.get(clientId) ?? null;
  }

  delete(clientId: string): void {
    this.byClient.delete(clientId);
  }

  size(): number {
    return this.byClient.size;
  }
}

/**
 * Resource types that never need the proxy rewrite: they carry no secrets to
 * inject and aren't subject to CORS the way a script-initiated `fetch()`/XHR
 * is (a plain `<img src>`/`<link>`/`<video>` loads cross-origin natively).
 * Only `fetch()`/XHR calls — reported with an empty `destination` — need the
 * rewrite, for LLM provider SDKs that call `fetch()` directly against a
 * cross-origin API. Sweeping these resource types in too caused a real bug:
 * any sprinkle with a plain cross-origin `<img>` 404'd through
 * `/api/fetch-proxy`, which the worker deployment always dead-stubs (see
 * `packages/cloudflare-worker/src/index.ts`'s `/api/fetch-proxy` handler,
 * `'Fetch proxy not available in worker mode'`) — the image never needed
 * proxying at all.
 */
const PASSTHROUGH_DESTINATIONS = new Set([
  'image',
  'font',
  'style',
  'video',
  'audio',
  'track',
  'iframe',
  'object',
  'embed',
]);

/** Whether a fetch of `destination` should skip the proxy rewrite entirely. */
export function isPassthroughDestination(destination: string): boolean {
  return PASSTHROUGH_DESTINATIONS.has(destination);
}

/**
 * SECURITY GATE for the sync-fs channel nonce: whether `source` is allowed to
 * add an SW per-session channel nonce. Only a **top-level** same-origin window
 * qualifies — the leader page (`wc-live.ts`) is the sole publisher and always
 * runs top-level (a standalone tab, the extension's hosted-leader tab, or the
 * electron overlay; all `opener === null` / `frameType === 'top-level'`).
 * Everything else is rejected:
 *
 *  - a realm / kernel WORKER (`type === 'worker'`) — if it could set the nonce
 *    it would repoint the SW at a channel it controls and harvest every realm's
 *    capability token, reintroducing the exact escape the nonce closes;
 *  - a same-origin `allow-same-origin` srcdoc sprinkle/dip iframe — a `window`
 *    client but a NESTED browsing context (`frameType === 'nested'`);
 *  - a same-origin **`auxiliary`** window (`window.open`'d). This USED to be
 *    allowed, but a sprinkle iframe is rendered with `allow-popups` in the
 *    cherry/nested float (`sprinkle-renderer.ts` adds it only when
 *    `isNestedInAnotherFrame()`), so there agent/attacker-authored sprinkle
 *    content could `window.open` a same-origin scriptable auxiliary window, post
 *    an attacker-chosen nonce (passing an `auxiliary` gate), and — because the SW
 *    fans every request out to ALL registered channels — receive every realm's
 *    capability token on its own channel. More generally, ANY nested/auxiliary
 *    channel would receive those fanned-out tokens, so rejecting `auxiliary`
 *    closes the whole class without cost: no legitimate publisher is a popup (a
 *    manually `window.open`'d leader simply falls back to the bounded snapshot).
 *
 * Since a nested/auxiliary attacker channel would receive fanned-out tokens,
 * the gate MUST be the tightest that still admits the real leader: `top-level`.
 *
 * `source` is the SW `message` event's `event.source` (a `Client`, or a
 * `ServiceWorker`/`MessagePort`/`null` — none of which qualify).
 */
export function maySetSyncFsNonce(source: unknown): boolean {
  const c = source as { type?: string; frameType?: string } | null;
  return c?.type === 'window' && c.frameType === 'top-level';
}

/** A one-shot notifier the SW's cold-op path awaits until a nonce (re)arrives. */
export interface NonceWaiter {
  /** Resolve every pending `wait()` — called when a nonce is registered. */
  notify(): void;
  /** Resolve on the next `notify()` OR after `timeoutMs` (never rejects, never hangs). */
  wait(timeoutMs: number): Promise<void>;
}

/**
 * Backing for the cold-start fix (C): when the SW has no channel yet (fresh boot
 * or a post-eviction respawn), the fetch handler asks the page(s) to re-publish
 * the nonce and `await`s this waiter instead of failing immediately — so the
 * first op takes one extra round-trip and SUCCEEDS rather than returning a
 * spurious `EIO`. `addSyncFsNonce` calls `notify()`. Bounded by the caller's
 * timeout so it can never hang. Pure + injectable, so it is unit-testable
 * without a `ServiceWorkerGlobalScope`.
 */
export function createNonceWaiter(): NonceWaiter {
  let waiters: Array<() => void> = [];
  return {
    notify(): void {
      const pending = waiters;
      waiters = [];
      for (const w of pending) w();
    },
    wait(timeoutMs: number): Promise<void> {
      return new Promise<void>((resolve) => {
        let settled = false;
        const finish = (): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          waiters = waiters.filter((w) => w !== finish);
          resolve();
        };
        const timer = setTimeout(finish, timeoutMs);
        waiters.push(finish);
      });
    },
  };
}
