const PREVIEW_CACHE_TTL_S = 5;

export interface CachedPreviewOpts {
  request: Request;
  allowLive: boolean;
  cacheVersion: number;

  fetchFromDO: (range: string | undefined) => Promise<Response>;
}

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

function effectiveRange(request: Request): string | undefined {
  if (request.headers.has('if-range')) return undefined;
  return request.headers.get('range') ?? undefined;
}

export async function cachedPreviewFetch(opts: CachedPreviewOpts): Promise<Response> {
  const { request, allowLive, cacheVersion } = opts;
  const range = effectiveRange(request);
  const fetchFromDO = () => fetchFromDOSafely(opts.fetchFromDO, range);

  if (allowLive || request.method !== 'GET' || range !== undefined) {
    return fetchFromDO();
  }

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

  await cache.put(cacheKey, response.clone()).catch(() => {});
  return response;
}

function buildCacheKey(request: Request, cacheVersion: number): Request {
  const url = new URL(request.url);
  url.searchParams.set('_cv', String(cacheVersion));
  return new Request(url.toString(), { method: 'GET' });
}
