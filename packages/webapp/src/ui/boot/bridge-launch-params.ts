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
  };
}
