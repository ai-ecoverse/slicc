/**
 * `bridge-launch-params.ts` — parse the standalone-bridge launch query
 * params (`?bridge=<ws-url>&bridgeToken=<token>`) the node-server (and
 * later swift-server) Path A appends to the leader launch URL. When both
 * are present, the hosted leader's CDP connection is routed at
 * `bridge` (a `ws://localhost:<port>/cdp` URL) with the token sent via
 * `Sec-WebSocket-Protocol` (never on the query string).
 *
 * Server-side counterparts: `packages/node-server/src/bridge-security.ts`
 * (`BRIDGE_SUBPROTOCOL_PREFIX`, `BRIDGE_TOKEN_QUERY_PARAM`,
 * `BRIDGE_WS_QUERY_PARAM`) and `packages/node-server/src/launch-url.ts`
 * (`appendBridgeParams`). The constants below MUST stay in sync with that
 * module — the webapp bundle can't import from node-server.
 */

/** Query-param name carrying the local `/cdp` WebSocket URL. */
export const BRIDGE_WS_QUERY_PARAM = 'bridge';

/** Query-param name carrying the per-process bridge token. */
export const BRIDGE_TOKEN_QUERY_PARAM = 'bridgeToken';

/** Subprotocol prefix the leader sends; server validates `<prefix><token>`. */
export const BRIDGE_SUBPROTOCOL_PREFIX = 'slicc.bridge.v1.';

export interface BridgeLaunchParams {
  /** The fully-qualified `ws://localhost:<port>/cdp` URL the leader will dial. */
  url: string;
  /** The `Sec-WebSocket-Protocol` value to offer on the upgrade. */
  subprotocol: string;
  /**
   * HTTP origin of the local node-server, derived from the bridge WS URL
   * (ws→http, wss→https, same host:port, no path). The webapp uses this
   * to route proxied /api/* requests at the local node-server when the
   * hosted leader (sliccy.ai) is serving the UI but has no /api surface
   * of its own. `null` when the bridge URL can't be parsed as a URL —
   * callers should fall back to same-origin in that case.
   */
  apiBaseUrl: string | null;
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

  return {
    url,
    subprotocol: `${BRIDGE_SUBPROTOCOL_PREFIX}${token}`,
    apiBaseUrl: deriveBridgeApiBaseUrl(url),
  };
}
