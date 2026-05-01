/**
 * Headers the `/api/fetch-proxy` route does NOT forward upstream.
 *
 * Includes hop-by-hop headers (`host`, `connection`, `transfer-encoding`,
 * `content-length`), proxy-internal markers (`x-target-url`,
 * `x-slicc-raw-body`), and forbidden-header transports the client uses
 * to smuggle reserved names through `fetch()` (`x-proxy-cookie`,
 * `x-proxy-origin`, `x-proxy-referer`).
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
]);
