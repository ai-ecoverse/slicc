/**
 * Worker-level cache for preview responses using the Cloudflare Cache API.
 *
 * Sits in front of the DO relay so repeated requests for the same static
 * asset skip the full WebSocket round-trip to the leader. Cache keys
 * incorporate a `cacheVersion` counter that the DO bumps on
 * `preview.purge` messages, giving instant invalidation when the leader
 * detects VFS changes under the served root.
 */

// ponytail: 5s covers a page-load burst without stale-content frustration
const PREVIEW_CACHE_TTL_S = 5;

export interface CachedPreviewOpts {
  request: Request;
  allowLive: boolean;
  cacheVersion: number;
  /** Relay to the tray DO; `range` is the visitor's `Range` header to honour. */
  fetchFromDO: (range: string | undefined) => Promise<Response>;
}

/**
 * A throw from the tray DO (e.g. its isolate was reset mid-request) would
 * otherwise surface as Cloudflare's opaque 1101 page. Answer a plain 503.
 */
async function fetchFromDOSafely(
  fetchFromDO: CachedPreviewOpts['fetchFromDO'],
  range: string | undefined
): Promise<Response> {
  try {
    return await fetchFromDO(range);
  } catch (err) {
    console.error('preview fetch failed', err instanceof Error ? err.message : String(err));
    return new Response('Preview temporarily unavailable', {
      status: 503,
      headers: { 'cache-control': 'no-store', 'retry-after': '1' },
    });
  }
}

/**
 * The `Range` a live preview should honour. Live bytes have no stable
 * validator, so an `If-Range` can never be proven current: drop the range
 * and serve the whole body, which RFC 9110 always permits.
 */
function effectiveRange(request: Request): string | undefined {
  if (request.headers.has('if-range')) return undefined;
  return request.headers.get('range') ?? undefined;
}

export async function cachedPreviewFetch(opts: CachedPreviewOpts): Promise<Response> {
  const { request, allowLive, cacheVersion } = opts;
  const range = effectiveRange(request);
  const fetchFromDO = () => fetchFromDOSafely(opts.fetchFromDO, range);

  // A ranged request never reads or fills the cache: a 206 is not cacheable
  // here, and the cached 200 would ignore the range.
  if (allowLive || request.method !== 'GET' || range !== undefined) {
    return fetchFromDO();
  }

  // ponytail: caches.default is per-colo; no cross-colo coherence needed
  const cachesGlobal = (globalThis as { caches?: CacheStorage }).caches;
  if (!cachesGlobal) return fetchFromDO();
  const cache = cachesGlobal.default;
  const cacheKey = buildCacheKey(request, cacheVersion);

  const cached = await cache.match(cacheKey);
  if (cached) {
    const etag = cached.headers.get('etag');
    if (etag && request.headers.get('if-none-match') === etag) {
      return new Response(null, { status: 304, headers: { etag } });
    }
    return cached;
  }

  const fresh = await fetchFromDO();
  if (fresh.status !== 200) return fresh;

  const body = await fresh.arrayBuffer();

  const hash = await crypto.subtle.digest('SHA-1', body);
  const etag = `"${[...new Uint8Array(hash.slice(0, 8))].map((b) => b.toString(16).padStart(2, '0')).join('')}"`;

  const ifNoneMatch = request.headers.get('if-none-match');
  if (ifNoneMatch === etag) {
    return new Response(null, { status: 304, headers: { etag } });
  }

  const headers = new Headers(fresh.headers);
  headers.set('cache-control', `public, max-age=${PREVIEW_CACHE_TTL_S}`);
  headers.set('etag', etag);

  const response = new Response(body, { status: 200, headers });
  // Caching is an optimization; a rejected put must not fail the response.
  await cache.put(cacheKey, response.clone()).catch(() => {});
  return response;
}

function buildCacheKey(request: Request, cacheVersion: number): Request {
  const url = new URL(request.url);
  url.searchParams.set('_cv', String(cacheVersion));
  return new Request(url.toString(), { method: 'GET' });
}
