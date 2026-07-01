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
  fetchFromDO: () => Promise<Response>;
}

export async function cachedPreviewFetch(opts: CachedPreviewOpts): Promise<Response> {
  const { request, allowLive, cacheVersion, fetchFromDO } = opts;

  if (allowLive || request.method !== 'GET') {
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
  await cache.put(cacheKey, response.clone());
  return response;
}

function buildCacheKey(request: Request, cacheVersion: number): Request {
  const url = new URL(request.url);
  url.searchParams.set('_cv', String(cacheVersion));
  return new Request(url.toString(), { method: 'GET' });
}
