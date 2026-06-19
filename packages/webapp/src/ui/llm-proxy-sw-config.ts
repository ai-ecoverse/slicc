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
