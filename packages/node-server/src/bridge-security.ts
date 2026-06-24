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

import { randomUUID, timingSafeEqual } from 'node:crypto';

/**
 * Origin allowlist. Production + staging worker plus the dev-mode loopback
 * origins (parallel to chrome-extension's `BRIDGE_DEV_ORIGINS`). Add a new
 * origin here and in the extension allowlist together — they MUST stay in
 * sync, otherwise extension and standalone disagree on what's a leader.
 *
 * Dev-only extra origins can be added at process start via the
 * `BRIDGE_DEV_ALLOWED_ORIGINS` env var (comma-separated). Used by the
 * local two-service harness (wrangler dev UI on :8787 + node-server
 * bridge); see Wave 5c. When the env var is unset, the effective
 * allowlist is byte-identical to this frozen base — prod is unaffected.
 */
export const BRIDGE_ALLOWED_ORIGINS: readonly string[] = Object.freeze([
  'https://www.sliccy.ai',
  'https://slicc-tray-hub-staging.minivelos.workers.dev',
  'http://localhost:5710',
  'http://127.0.0.1:5710',
]);

/**
 * Normalize a single env-supplied origin: trim, lowercase, drop trailing
 * slash. Returns `null` for blank/whitespace entries or anything that
 * `URL` can't parse. Never throws.
 */
function normalizeDevOrigin(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let candidate = trimmed.toLowerCase();
  while (candidate.endsWith('/')) {
    candidate = candidate.slice(0, -1);
  }
  if (!candidate) return null;
  try {
    // Sanity check: must parse as an absolute URL with scheme + host.
    const parsed = new URL(candidate);
    if (!parsed.protocol || !parsed.hostname) return null;
  } catch {
    return null;
  }
  return candidate;
}

/**
 * Dev-only extra origins parsed once from `BRIDGE_DEV_ALLOWED_ORIGINS` at
 * module load. Comma-separated; blank entries ignored; malformed entries
 * dropped. Frozen prod base above is left intact; `isAllowedBridgeOrigin`
 * consults the union.
 */
const BRIDGE_DEV_ALLOWED_ORIGINS: ReadonlySet<string> = (() => {
  const raw = process.env.BRIDGE_DEV_ALLOWED_ORIGINS;
  if (!raw) return new Set<string>();
  const set = new Set<string>();
  for (const entry of raw.split(',')) {
    const normalized = normalizeDevOrigin(entry);
    if (normalized) set.add(normalized);
  }
  return set;
})();

/** Subprotocol prefix advertised by the leader; the per-process token is appended. */
export const BRIDGE_SUBPROTOCOL_PREFIX = 'slicc.bridge.v1.';

/** Query-param name the launch URL uses to forward the subprotocol token to the leader. */
export const BRIDGE_TOKEN_QUERY_PARAM = 'bridgeToken';

/** Query-param name the launch URL uses to forward the local /cdp WebSocket URL. */
export const BRIDGE_WS_QUERY_PARAM = 'bridge';

/**
 * Request header carrying the per-process bridge token on cross-origin
 * /api/* calls from a remote allowlisted leader (e.g. sliccy.ai). The
 * webapp's `proxied-fetch.ts` attaches it whenever a local API base
 * origin is set; the thin-bridge CORS middleware validates it. Header
 * is included in `CORS_BASE_ALLOW_HEADERS` so browsers don't strip it
 * on the preflight.
 */
export const BRIDGE_TOKEN_HEADER = 'X-Bridge-Token';

/**
 * Headers we allow on cross-origin /api requests from the hosted leader.
 * Includes the `/api/fetch-proxy` transport headers (`X-Target-URL`, the
 * forbidden-header `X-Proxy-*` bridges, `X-Slicc-Raw-Body`) so the
 * webapp's `createProxiedFetch` can route through the local node-server
 * cross-origin in thin-bridge mode. Custom upstream headers (any header
 * the agent's `curl -H …` would pass through) are reflected via
 * `Access-Control-Request-Headers` in `buildCorsHeaders` below.
 */
const CORS_BASE_ALLOW_HEADERS = [
  'Content-Type',
  'X-Slicc-Raw-Body',
  'X-Session-Id',
  'X-Bridge-Token',
  'Authorization',
  'X-Target-URL',
  'X-Proxy-Cookie',
  'X-Proxy-Origin',
  'X-Proxy-Referer',
];

/**
 * Response headers the browser is allowed to read after a cross-origin
 * /api call — must include the proxy's infrastructure-error marker
 * (`isProxyError` reads `X-Proxy-Error`) and the forbidden-response
 * bridge (`decodeForbiddenResponseHeaders` reads `X-Proxy-Set-Cookie`).
 */
const CORS_EXPOSE_HEADERS = 'Link, X-Proxy-Error, X-Proxy-Set-Cookie';

/** Methods exposed to the hosted leader. */
const CORS_ALLOW_METHODS = 'GET, POST, PUT, DELETE, OPTIONS';

/**
 * True iff `origin` is in the bridge allowlist. The frozen prod base
 * (`BRIDGE_ALLOWED_ORIGINS`) is matched case-sensitively against the
 * raw origin; the dev-only env-supplied extras (normalized lowercase
 * + trailing-slash-stripped at load) are matched against a normalized
 * copy of the input, so a leader sending `Origin: HTTP://Localhost:8787`
 * (or with a stray trailing slash) still resolves correctly.
 */
export function isAllowedBridgeOrigin(origin: string | undefined | null): boolean {
  if (!origin) return false;
  if (BRIDGE_ALLOWED_ORIGINS.includes(origin)) return true;
  if (BRIDGE_DEV_ALLOWED_ORIGINS.size === 0) return false;
  const normalized = normalizeDevOrigin(origin);
  if (!normalized) return false;
  return BRIDGE_DEV_ALLOWED_ORIGINS.has(normalized);
}

/**
 * True iff `origin` is a loopback host (localhost / 127.0.0.1 / ::1).
 * Loopback allowlisted origins (e.g. the locally-served OAuth callback
 * page at `http://localhost:5710/auth/callback` posting to
 * `/api/oauth-result`) are exempt from the bridge-token requirement —
 * the token's threat model is "remote allowlisted origin (sliccy.ai)
 * with a hostile script", not "local server talking to itself".
 */
export function isLoopbackBridgeOrigin(origin: string | undefined | null): boolean {
  if (!origin) return false;
  try {
    const url = new URL(origin);
    // Node's WHATWG URL parser keeps the brackets on IPv6 hostnames
    // (`http://[::1]:5710` → `[::1]`); accept both bracketed and bare.
    return (
      url.hostname === 'localhost' ||
      url.hostname === '127.0.0.1' ||
      url.hostname === '::1' ||
      url.hostname === '[::1]'
    );
  } catch {
    return false;
  }
}

/**
 * Constant-time compare for the bridge token. `presented` may be missing
 * or shaped wrong (Express delivers headers as `string | string[] |
 * undefined`). Returns `false` for any non-string, length mismatch, or
 * empty expected — never throws.
 */
export function validateBridgeToken(
  presented: string | string[] | undefined,
  expected: string | null
): boolean {
  if (!expected) return false;
  const value = Array.isArray(presented) ? presented[0] : presented;
  if (typeof value !== 'string' || value.length === 0) return false;
  const a = Buffer.from(value);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
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
 * Resolve the `/cdp` upgrade-gate token for this server process.
 *
 * Honors an inbound `SLICC_BRIDGE_TOKEN` env var (forwarded by
 * `electron-main.ts` to the `--serve-only`/`--electron` child) so the
 * gate is enforced even when `thinBridgeMode` is false. Falls back to
 * minting a fresh token in `thinBridgeMode`, and to `null` (gate off)
 * in the remaining legacy modes.
 */
export function resolveServerBridgeToken(
  env: Record<string, string | undefined>,
  opts: { thinBridgeMode: boolean }
): string | null {
  const fromEnv = env['SLICC_BRIDGE_TOKEN'];
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  return opts.thinBridgeMode ? mintBridgeToken() : null;
}

/**
 * Decide whether the thin-bridge CORS + PNA middleware should be mounted on
 * the `/api` surface.
 *
 * Mounted in canonical thin-bridge mode, and additionally whenever a
 * per-process bridge token is present even with `thinBridgeMode` false (e.g.
 * `--electron` with a forwarded `SLICC_BRIDGE_TOKEN`): the Electron overlay
 * loads cross-origin from the hosted leader, so its `/api/runtime-config`
 * fetch needs `access-control-*` headers. Mirrors the `/cdp` gate, which
 * already honors a present token regardless of mode. Legacy dev /
 * serve-only-without-token keep `bridgeToken === null` ⇒ CORS stays off ⇒
 * same-origin behavior preserved.
 */
export function shouldMountThinBridgeCors(
  thinBridgeMode: boolean,
  bridgeToken: string | null
): boolean {
  return thinBridgeMode || bridgeToken !== null;
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
 * Resolve the `Access-Control-Allow-Headers` value for a request. Starts
 * from `CORS_BASE_ALLOW_HEADERS` (the static set covering the documented
 * /api endpoints + the `/api/fetch-proxy` transport headers) and unions
 * in any header names from the request's `Access-Control-Request-Headers`
 * that aren't already listed. This is the reflect-headers pattern: the
 * agent's `bash curl -H X-Custom: …` can route through `/api/fetch-proxy`
 * cross-origin without us having to enumerate every possible upstream
 * header in advance. Comparison is case-insensitive; the static set's
 * canonical casing wins on duplicates.
 */
export function resolveCorsAllowHeaders(requestHeadersHeader: string | undefined | null): string {
  if (!requestHeadersHeader) return CORS_BASE_ALLOW_HEADERS.join(', ');
  const seen = new Set(CORS_BASE_ALLOW_HEADERS.map((h) => h.toLowerCase()));
  const extras: string[] = [];
  for (const raw of requestHeadersHeader.split(',')) {
    const name = raw.trim();
    if (!name) continue;
    const lower = name.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    extras.push(name);
  }
  if (extras.length === 0) return CORS_BASE_ALLOW_HEADERS.join(', ');
  return [...CORS_BASE_ALLOW_HEADERS, ...extras].join(', ');
}

/**
 * CORS headers for an allowlisted `Origin`. Returns `null` when the origin
 * is not in the allowlist (caller should NOT set CORS headers).
 *
 * `Access-Control-Allow-Credentials: true` is included so the hosted leader
 * can carry cookies to /api/* (e.g. auth) when that's added later. Today
 * the bridge token is the auth factor, not cookies.
 *
 * `requestHeadersHeader` should be the request's `Access-Control-Request-Headers`
 * value (preflight only); on a non-preflight request pass `null` and the
 * caller can omit it.
 */
export function buildCorsHeaders(
  origin: string | undefined | null,
  requestHeadersHeader?: string | string[] | null
): Record<string, string> | null {
  if (!isAllowedBridgeOrigin(origin)) return null;
  const reqHeaders = Array.isArray(requestHeadersHeader)
    ? requestHeadersHeader.join(', ')
    : (requestHeadersHeader ?? null);
  return {
    'Access-Control-Allow-Origin': origin!,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': CORS_ALLOW_METHODS,
    'Access-Control-Allow-Headers': resolveCorsAllowHeaders(reqHeaders),
    'Access-Control-Expose-Headers': CORS_EXPOSE_HEADERS,
    Vary: 'Origin, Access-Control-Request-Headers',
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
