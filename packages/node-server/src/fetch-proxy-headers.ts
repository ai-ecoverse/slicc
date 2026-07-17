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
