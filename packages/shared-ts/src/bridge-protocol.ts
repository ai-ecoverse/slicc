/**
 * Standalone/Electron thin-bridge launch contract — single source of truth.
 *
 * The node-server (and swift-server) appends `?bridge=<ws-url>&bridgeToken=…`
 * to the hosted leader launch URL; the leader dials the local `/cdp`
 * WebSocket offering `Sec-WebSocket-Protocol: slicc.bridge.v1.<token>` and
 * sends the raw token on cross-origin `/api/*` calls as `X-Bridge-Token`.
 *
 * Consumers: `packages/node-server/src/bridge-security.ts` (server gate),
 * `packages/webapp/src/ui/boot/bridge-launch-params.ts` (leader boot),
 * `packages/chrome-extension/src/bridge-sw.ts` (SW port allowlist),
 * `packages/webapp/src/ui/llm-proxy-sw.ts` (header pass-through).
 * Swift mirror: `packages/swift-server/Sources/Server/BridgeSecurity.swift`
 * — update it when these values change.
 */

/** Production hosted-UI origin every bridge allowlist starts from. */
export const SLICC_HOSTED_ORIGIN = 'https://www.sliccy.ai';

/** Staging tray-hub origin (allowlisted by the node-server bridge only). */
export const SLICC_STAGING_HUB_ORIGIN = 'https://slicc-tray-hub-staging.minivelos.workers.dev';

/** Subprotocol prefix the leader sends; servers validate `<prefix><token>`. */
export const BRIDGE_SUBPROTOCOL_PREFIX = 'slicc.bridge.v1.';

/** Query-param name carrying the per-process bridge token. */
export const BRIDGE_TOKEN_QUERY_PARAM = 'bridgeToken';

/** Query-param name carrying the local `/cdp` WebSocket URL. */
export const BRIDGE_WS_QUERY_PARAM = 'bridge';

/** Header carrying the raw bridge token on cross-origin `/api/*` calls. */
export const BRIDGE_TOKEN_HEADER = 'X-Bridge-Token';
