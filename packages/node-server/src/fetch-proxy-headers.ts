import type { IncomingMessage } from 'http';

import { isHostFsStableBodyRequest } from './hostfs.js';

/**
 * Headers the `/api/fetch-proxy` route does NOT forward upstream.
 *
 * Includes hop-by-hop headers (`host`, `connection`, `transfer-encoding`,
 * `content-length`), proxy-internal markers (`x-target-url`,
 * `x-slicc-raw-body`), forbidden-header transports the client uses
 * to smuggle reserved names through `fetch()` (`x-proxy-cookie`,
 * `x-proxy-origin`, `x-proxy-referer`), and the thin-bridge auth header
 * (`x-bridge-token`) which authenticates the browser->local hop only
 * and must not leak onward to `targetUrl`. The bridge-token middleware
 * (`createThinBridgeCorsMiddleware` in `index.ts`) is mounted ahead of
 * this route and reads `req.headers` directly, so token validation
 * still sees the header - this Set only filters what gets COPIED into
 * the forwarded request.
 *
 * Lives in its own module (rather than `index.ts`) so tests can import
 * it without triggering the server bootstrap that runs at `index.ts`
 * module load.
 */
export const FETCH_PROXY_SKIP_HEADERS: ReadonlySet<string> = new Set([
  'host',
  'connection',
  'x-target-url',
  'x-slicc-raw-body',
  'content-length',
  'transfer-encoding',
  'x-proxy-cookie',
  'x-proxy-origin',
  'x-proxy-referer',
  // Kept in sync with `BRIDGE_TOKEN_HEADER` in `bridge-security.ts`
  // (lowercased because Node lowercases incoming request header keys).
  'x-bridge-token',
  // Proxy-side HMAC body-signing directive (`HMAC_SIGN_HEADER` in
  // @slicc/shared-ts secrets-pipeline.ts) — consumed by the route handler
  // to compute and attach a real signature header; never forwarded as-is.
  'x-slicc-hmac-sign',
]);

/**
 * Response-side header names the proxy must NOT copy from the upstream
 * response onto the browser-facing response. The bridge's
 * `createThinBridgeCorsMiddleware` / `buildCorsHeaders` set the
 * authoritative CORS headers for the browser→bridge hop BEFORE this
 * route runs; an upstream that emits its own `access-control-*`
 * (e.g. `huggingface.co` → `*`, GitHub Pages → its own origin) would
 * otherwise `res.setHeader`-clobber the bridge's value, leaving the
 * browser with a CORS mismatch (`*` + `Allow-Credentials: true` is
 * forbidden; a foreign origin obviously doesn't match localhost) and
 * surfacing as an opaque `TypeError: Failed to fetch`. Stripping the
 * full `access-control-*` family keeps the bridge as the sole CORS
 * authority on the local hop. Names are lowercased to match
 * `upstream.headers.forEach` key casing.
 */
export const FETCH_PROXY_SKIP_RESPONSE_HEADERS: ReadonlySet<string> = new Set([
  'transfer-encoding',
  'content-encoding',
  'content-length',
  'www-authenticate',
  'set-cookie',
]);

/**
 * Lowercased prefixes whose upstream response headers are also skipped.
 * `access-control-` covers the entire CORS-response family (allow-origin,
 * allow-credentials, allow-methods, allow-headers, expose-headers,
 * max-age, allow-private-network, plus any future entries) so the bridge
 * middleware remains the sole CORS authority. `x-proxy-` is the proxy's
 * own response-marker namespace — never echo an upstream value.
 */
export const FETCH_PROXY_SKIP_RESPONSE_PREFIXES: readonly string[] = [
  'access-control-',
  'x-proxy-',
];

/**
 * Proxy-set response header carrying the upstream `content-length` when it is
 * exact (identity encoding). Read by the webapp's `proxied-fetch.ts` to drive
 * determinate download progress; never copied from upstream (the `x-proxy-`
 * prefix above guarantees that).
 */
export const FETCH_PROXY_CONTENT_LENGTH_HEADER = 'X-Proxy-Content-Length';

/**
 * Response headers the browser must always be allowed to read on the
 * `/api/fetch-proxy` hop, even when the upstream response carries none of
 * them. Kept in sync with `CORS_EXPOSE_HEADERS` in `bridge-security.ts` and
 * `BridgeSecurity.corsExposeHeaders` in the Swift server. The route appends
 * every forwarded upstream header name on top of this base so agents can
 * inspect CSP / HSTS / ETag / etc. — browsers only surface non-CORS-safelisted
 * response headers when they appear here (credentials mode forbids `*`).
 */
export const FETCH_PROXY_BASE_EXPOSE_HEADERS: readonly string[] = [
  'Link',
  'X-Proxy-Error',
  'X-Proxy-Set-Cookie',
  FETCH_PROXY_CONTENT_LENGTH_HEADER,
  'Mcp-Session-Id',
  'MCP-Protocol-Version',
  'Cache-Control',
];

/**
 * Build the `Access-Control-Expose-Headers` value for a proxied response:
 * the static proxy markers plus every header name we actually forwarded.
 * Dedupes case-insensitively while preserving the first-seen spelling.
 */
export function buildFetchProxyExposeHeaders(forwardedHeaderNames: Iterable<string>): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of [...FETCH_PROXY_BASE_EXPOSE_HEADERS, ...forwardedHeaderNames]) {
    const lower = name.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    out.push(name);
  }
  return out.join(', ');
}

/**
 * Which requests the global `express.json()` consumes. Two exclusions:
 *
 *   - `X-Slicc-Raw-Body: 1` — SigV4-signed bodies must reach the
 *     /api/fetch-proxy handler byte-for-byte (the parser would re-serialize
 *     them via JSON.stringify and break the signature);
 *   - the stable hostfs dispatcher — it owns a bounded 1 MiB parser and an
 *     errno error adapter, and this parser is mounted ahead of
 *     `registerHostFsRoutes`, so without the exclusion it would consume the
 *     body first and answer a malformed one with code-less HTML.
 */
export function shouldParseGlobalJson(req: IncomingMessage): boolean {
  if (req.headers['x-slicc-raw-body'] === '1') return false;
  if (isHostFsStableBodyRequest(req)) return false;
  return (req.headers['content-type'] ?? '').includes('application/json');
}
