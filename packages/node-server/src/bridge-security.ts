/**
 * Bridge security primitives for the standalone thin /cdp bridge.
 *
 * The standalone CLI runs a thin Express server that proxies CDP from a
 * sliccy.ai-hosted leader tab to the local Chrome over `/cdp`. Full CDP
 * pass-through = full control of the user's Chrome, so the WebSocket
 * upgrade is gated by two factors plus PNA:
 *   1. Origin allowlist (`isAllowedBridgeOrigin`).
 *   2. Per-process subprotocol token in `Sec-WebSocket-Protocol`
 *      (`SUBPROTOCOL_PREFIX` + token). Never appears in a query string,
 *      so it does not leak into Referer / logs.
 *   3. PNA preflight (`buildPnaPreflightHeaders`) — Chrome blocks
 *      public→private WS upgrades without `Access-Control-Allow-Private-Network`.
 *
 * Cross-origin /api calls from the hosted leader also need CORS; see
 * `buildCorsHeaders` for the per-request response set.
 *
 * Pure module (no node-only imports) so the WS gate is trivially unit
 * testable from `tests/bridge-security.test.ts`.
 */

import { randomUUID } from 'node:crypto';

/**
 * Origin allowlist. Production + staging worker plus the dev-mode loopback
 * origins (parallel to chrome-extension's `BRIDGE_DEV_ORIGINS`). Add a new
 * origin here and in the extension allowlist together — they MUST stay in
 * sync, otherwise extension and standalone disagree on what's a leader.
 */
export const BRIDGE_ALLOWED_ORIGINS: readonly string[] = Object.freeze([
  'https://www.sliccy.ai',
  'https://slicc-tray-hub-staging.minivelos.workers.dev',
  'http://localhost:5710',
  'http://127.0.0.1:5710',
]);

/** Subprotocol prefix advertised by the leader; the per-process token is appended. */
export const BRIDGE_SUBPROTOCOL_PREFIX = 'slicc.bridge.v1.';

/** Query-param name the launch URL uses to forward the subprotocol token to the leader. */
export const BRIDGE_TOKEN_QUERY_PARAM = 'bridgeToken';

/** Query-param name the launch URL uses to forward the local /cdp WebSocket URL. */
export const BRIDGE_WS_QUERY_PARAM = 'bridge';

/** Headers we allow on cross-origin /api requests from the hosted leader. */
const CORS_ALLOW_HEADERS =
  'Content-Type, X-Slicc-Raw-Body, X-Session-Id, X-Bridge-Token, Authorization';

/** Methods exposed to the hosted leader. */
const CORS_ALLOW_METHODS = 'GET, POST, PUT, DELETE, OPTIONS';

/** True iff `origin` is in the bridge allowlist. Case-sensitive (origins are normalized lowercase). */
export function isAllowedBridgeOrigin(origin: string | undefined | null): boolean {
  if (!origin) return false;
  return BRIDGE_ALLOWED_ORIGINS.includes(origin);
}

/**
 * Mint a per-process bridge token. Embedded in the leader launch URL and
 * required as the WebSocket subprotocol on /cdp. Use `crypto.randomUUID()`
 * — 122 bits of entropy is plenty for a session-scoped capability.
 */
export function mintBridgeToken(): string {
  return randomUUID();
}

/**
 * Parse the `Sec-WebSocket-Protocol` request header into a trimmed list. The
 * header is a comma-separated list per RFC 6455; `ws` exposes it raw.
 */
export function parseSubprotocolHeader(header: string | string[] | undefined): string[] {
  if (!header) return [];
  const flat = Array.isArray(header) ? header.join(',') : header;
  return flat
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Pick the bridge subprotocol matching `expectedToken`, or null if absent.
 * The matching protocol is what we MUST echo back in the upgrade response
 * (RFC 6455 §1.9) — otherwise the browser closes the socket.
 */
export function selectBridgeSubprotocol(
  protocols: readonly string[],
  expectedToken: string
): string | null {
  if (!expectedToken) return null;
  const expected = `${BRIDGE_SUBPROTOCOL_PREFIX}${expectedToken}`;
  return protocols.includes(expected) ? expected : null;
}

export interface BridgeUpgradeGateResult {
  ok: boolean;
  /**
   * The subprotocol to echo back in the 101 response when `ok === true`.
   * Always null when `ok === false`.
   */
  acceptedSubprotocol: string | null;
  /**
   * Reason exposed in logs for rejection. Intentionally coarse — does not
   * tell the caller WHICH check failed, mirroring `validateBridgePin` in
   * the chrome-extension bridge SW.
   */
  reason?: 'origin-not-allowed' | 'subprotocol-missing-or-mismatched';
}

/**
 * Combined origin + subprotocol gate for a `/cdp` upgrade request.
 *
 * Returns `{ ok: true, acceptedSubprotocol }` only when BOTH the origin is
 * in the allowlist AND a matching `slicc.bridge.v1.<expectedToken>`
 * subprotocol was offered. Closes-the-socket-before-emit semantics live at
 * the call site in `index.ts`.
 */
export function validateBridgeUpgrade(input: {
  origin: string | undefined | null;
  subprotocolHeader: string | string[] | undefined;
  expectedToken: string;
}): BridgeUpgradeGateResult {
  if (!isAllowedBridgeOrigin(input.origin)) {
    return { ok: false, acceptedSubprotocol: null, reason: 'origin-not-allowed' };
  }
  const protocols = parseSubprotocolHeader(input.subprotocolHeader);
  const accepted = selectBridgeSubprotocol(protocols, input.expectedToken);
  if (!accepted) {
    return {
      ok: false,
      acceptedSubprotocol: null,
      reason: 'subprotocol-missing-or-mismatched',
    };
  }
  return { ok: true, acceptedSubprotocol: accepted };
}

/**
 * CORS headers for an allowlisted `Origin`. Returns `null` when the origin
 * is not in the allowlist (caller should NOT set CORS headers).
 *
 * `Access-Control-Allow-Credentials: true` is included so the hosted leader
 * can carry cookies to /api/* (e.g. auth) when that's added later. Today
 * the bridge token is the auth factor, not cookies.
 */
export function buildCorsHeaders(origin: string | undefined | null): Record<string, string> | null {
  if (!isAllowedBridgeOrigin(origin)) return null;
  return {
    'Access-Control-Allow-Origin': origin!,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': CORS_ALLOW_METHODS,
    'Access-Control-Allow-Headers': CORS_ALLOW_HEADERS,
    'Access-Control-Expose-Headers': 'Link',
    Vary: 'Origin',
  };
}

/**
 * PNA preflight extras. Added on OPTIONS responses for allowlisted origins
 * when the request carries `Access-Control-Request-Private-Network: true`
 * — Chrome blocks public→private fetch / WS otherwise.
 */
export function buildPnaPreflightHeaders(): Record<string, string> {
  return { 'Access-Control-Allow-Private-Network': 'true' };
}
