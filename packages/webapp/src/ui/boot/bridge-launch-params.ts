/**
 * `bridge-launch-params.ts` — parse the standalone-bridge launch query
 * params (`?bridge=<ws-url>&bridgeToken=<token>`) the node-server (and
 * later swift-server) Path A appends to the leader launch URL. When both
 * are present, the hosted leader's CDP connection is routed at
 * `bridge` (a `ws://localhost:<port>/cdp` URL) with the token sent via
 * `Sec-WebSocket-Protocol` (never on the query string).
 *
 * Server-side counterpart: `packages/node-server/src/bridge-security.ts`.
 * The bridge constants (`BRIDGE_SUBPROTOCOL_PREFIX`, `BRIDGE_TOKEN_QUERY_PARAM`,
 * `BRIDGE_WS_QUERY_PARAM`) and the shared overlay-role constants
 * (`BRIDGE_ROLE_QUERY_PARAM` and friends) live in `@slicc/shared-ts` and
 * are re-exported below so existing webapp callers keep their import.
 */

import {
  BRIDGE_ROLE_QUERY_PARAM,
  BRIDGE_SUBPROTOCOL_PREFIX,
  BRIDGE_TOKEN_QUERY_PARAM,
  BRIDGE_WS_QUERY_PARAM,
  type BridgeRole,
} from '@slicc/shared-ts';

export type { BridgeRole };
// Re-exported so existing webapp callers (and tests) keep their import
// from this module.
export {
  BRIDGE_ROLE_QUERY_PARAM,
  BRIDGE_SUBPROTOCOL_PREFIX,
  BRIDGE_TOKEN_QUERY_PARAM,
  BRIDGE_WS_QUERY_PARAM,
};

export interface BridgeLaunchParams {
  /** The fully-qualified `ws://localhost:<port>/cdp` URL the leader will dial. */
  url: string;
  /** The `Sec-WebSocket-Protocol` value to offer on the upgrade. */
  subprotocol: string;
  /**
   * Raw per-process bridge token (the value the node-server minted via
   * `mintBridgeToken`). Sent on cross-origin /api/* fetches as the
   * `X-Bridge-Token` header so the local node-server can gate access on
   * top of the origin allowlist — the allowlist alone is insufficient
   * because any script on `https://www.sliccy.ai` could otherwise reach
   * /api unchallenged. Treat as a session capability: never log it,
   * never put it on a query string or Referer.
   */
  token: string;
  /**
   * HTTP origin of the local node-server, derived from the bridge WS URL
   * (ws→http, wss→https, same host:port, no path). The webapp uses this
   * to route proxied /api/* requests at the local node-server when the
   * hosted leader (sliccy.ai) is serving the UI but has no /api surface
   * of its own. `null` when the bridge URL can't be parsed as a URL —
   * callers should fall back to same-origin in that case.
   */
  apiBaseUrl: string | null;
  /**
   * Lick management WebSocket URL on the local node-server, derived from
   * the bridge WS URL (same scheme + host:port, path swapped to
   * `/licks-ws`). The kernel host dials this from the worker float to
   * receive webhook/handoff events and serve management requests. `null`
   * when the bridge URL can't be parsed — callers should fall back to
   * same-origin in that case (which is wrong in thin-bridge mode but
   * matches the legacy bundled-UI assumption).
   */
  lickWsUrl: string | null;
  /**
   * Overlay role from the launch URL, or `null` when the launcher did
   * not stamp one (single-tab standalone bridge launches). Followers
   * MUST NOT dial `/cdp` — that capability belongs to the leader.
   */
  role: BridgeRole | null;
}

/**
 * Derive the local HTTP API origin from a bridge `ws://` / `wss://` URL.
 * `ws://localhost:5710/cdp` → `http://localhost:5710`. Returns `null`
 * when the URL can't be parsed.
 */
export function deriveBridgeApiBaseUrl(bridgeWsUrl: string): string | null {
  try {
    const u = new URL(bridgeWsUrl);
    const httpScheme = u.protocol === 'wss:' ? 'https:' : 'http:';
    return `${httpScheme}//${u.host}`;
  } catch {
    return null;
  }
}

/**
 * Derive the lick WebSocket URL on the local node-server from a bridge
 * `ws://` / `wss://` URL. `ws://localhost:5710/cdp` →
 * `ws://localhost:5710/licks-ws`. Same scheme + host:port; only the
 * path changes. Returns `null` when the URL can't be parsed.
 */
export function deriveBridgeLickWsUrl(bridgeWsUrl: string): string | null {
  try {
    const u = new URL(bridgeWsUrl);
    return `${u.protocol}//${u.host}/licks-ws`;
  } catch {
    return null;
  }
}

/**
 * Extract bridge coordinates from a launch URL's query string. Returns
 * `null` unless BOTH `bridge` and `bridgeToken` are present and the URL
 * uses a `ws://` or `wss://` scheme — partial / malformed inputs degrade
 * to the legacy bundled-UI path (no bridge) rather than throwing.
 */
export function parseBridgeLaunchParams(search: string): BridgeLaunchParams | null {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(search);
  } catch {
    return null;
  }

  const url = params.get(BRIDGE_WS_QUERY_PARAM);
  const token = params.get(BRIDGE_TOKEN_QUERY_PARAM);
  if (!url || !token) return null;
  if (!/^wss?:\/\//.test(url)) return null;

  const rawRole = params.get(BRIDGE_ROLE_QUERY_PARAM);
  const role: BridgeRole | null = rawRole === 'leader' || rawRole === 'follower' ? rawRole : null;

  return {
    url,
    subprotocol: `${BRIDGE_SUBPROTOCOL_PREFIX}${token}`,
    token,
    apiBaseUrl: deriveBridgeApiBaseUrl(url),
    lickWsUrl: deriveBridgeLickWsUrl(url),
    role,
  };
}
