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
]);
