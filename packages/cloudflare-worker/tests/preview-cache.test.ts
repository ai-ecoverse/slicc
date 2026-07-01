import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cachedPreviewFetch } from '../src/preview-cache.js';

class FakeCache {
  private store = new Map<string, Response>();

  async match(req: Request): Promise<Response | undefined> {
    return this.store.get(req.url)?.clone();
  }

  async put(req: Request, res: Response): Promise<void> {
    this.store.set(req.url, res.clone());
  }
}

function installFakeCaches(): FakeCache {
  const cache = new FakeCache();
  (globalThis as Record<string, unknown>).caches = { default: cache };
  return cache;
}

function removeFakeCaches(): void {
  delete (globalThis as Record<string, unknown>).caches;
}

function makeRequest(
  url = 'https://abc.sliccy.dev/index.html',
  headers?: Record<string, string>
): Request {
  return new Request(url, { method: 'GET', headers });
}

function makeDoResponse(body = '<h1>hi</h1>', status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/html' },
  });
}

describe('cachedPreviewFetch', () => {
  beforeEach(() => {
    removeFakeCaches();
  });

  it('bypasses cache when allowLive is true', async () => {
    installFakeCaches();
    const fetchFromDO = vi.fn(() => Promise.resolve(makeDoResponse()));
    const res = await cachedPreviewFetch({
      request: makeRequest(),
      allowLive: true,
      cacheVersion: 1,
      fetchFromDO,
    });
    expect(fetchFromDO).toHaveBeenCalledOnce();
    expect(res.status).toBe(200);
  });

  it('bypasses cache for non-GET requests', async () => {
    installFakeCaches();
    const fetchFromDO = vi.fn(() => Promise.resolve(makeDoResponse()));
    const res = await cachedPreviewFetch({
      request: new Request('https://abc.sliccy.dev/', { method: 'POST' }),
      allowLive: false,
      cacheVersion: 1,
      fetchFromDO,
    });
    expect(fetchFromDO).toHaveBeenCalledOnce();
    expect(res.status).toBe(200);
  });

  it('falls back to fetchFromDO when caches global is unavailable', async () => {
    removeFakeCaches();
    const fetchFromDO = vi.fn(() => Promise.resolve(makeDoResponse()));
    const res = await cachedPreviewFetch({
      request: makeRequest(),
      allowLive: false,
      cacheVersion: 1,
      fetchFromDO,
    });
    expect(fetchFromDO).toHaveBeenCalledOnce();
    expect(res.status).toBe(200);
  });

  it('caches 200 responses and serves from cache on second call', async () => {
    installFakeCaches();
    const fetchFromDO = vi.fn(() => Promise.resolve(makeDoResponse()));

    const first = await cachedPreviewFetch({
      request: makeRequest(),
      allowLive: false,
      cacheVersion: 1,
      fetchFromDO,
    });
    expect(first.status).toBe(200);
    expect(first.headers.get('etag')).toBeTruthy();
    expect(first.headers.get('cache-control')).toBe('public, max-age=5');

    const second = await cachedPreviewFetch({
      request: makeRequest(),
      allowLive: false,
      cacheVersion: 1,
      fetchFromDO,
    });
    expect(second.status).toBe(200);
    expect(fetchFromDO).toHaveBeenCalledOnce();
  });

  it('does not cache non-200 responses', async () => {
    installFakeCaches();
    const fetchFromDO = vi.fn(() => Promise.resolve(new Response('not found', { status: 404 })));

    const first = await cachedPreviewFetch({
      request: makeRequest(),
      allowLive: false,
      cacheVersion: 1,
      fetchFromDO,
    });
    expect(first.status).toBe(404);

    await cachedPreviewFetch({
      request: makeRequest(),
      allowLive: false,
      cacheVersion: 1,
      fetchFromDO,
    });
    expect(fetchFromDO).toHaveBeenCalledTimes(2);
  });

  it('returns 304 on cache miss when If-None-Match matches fresh ETag', async () => {
    installFakeCaches();
    const body = '<h1>hi</h1>';
    const fetchFromDO = vi.fn(() => Promise.resolve(makeDoResponse(body)));

    const first = await cachedPreviewFetch({
      request: makeRequest(),
      allowLive: false,
      cacheVersion: 1,
      fetchFromDO,
    });
    const etag = first.headers.get('etag')!;

    // Bump version to force cache miss, but send matching ETag
    const second = await cachedPreviewFetch({
      request: makeRequest('https://abc.sliccy.dev/index.html', { 'if-none-match': etag }),
      allowLive: false,
      cacheVersion: 2,
      fetchFromDO,
    });
    expect(second.status).toBe(304);
    expect(second.headers.get('etag')).toBe(etag);
  });

  it('returns 304 on cache hit when If-None-Match matches cached ETag', async () => {
    installFakeCaches();
    const fetchFromDO = vi.fn(() => Promise.resolve(makeDoResponse()));

    const first = await cachedPreviewFetch({
      request: makeRequest(),
      allowLive: false,
      cacheVersion: 1,
      fetchFromDO,
    });
    const etag = first.headers.get('etag')!;

    const second = await cachedPreviewFetch({
      request: makeRequest('https://abc.sliccy.dev/index.html', { 'if-none-match': etag }),
      allowLive: false,
      cacheVersion: 1,
      fetchFromDO,
    });
    expect(second.status).toBe(304);
    expect(fetchFromDO).toHaveBeenCalledOnce();
  });

  it('cache key changes when cacheVersion bumps', async () => {
    installFakeCaches();
    let callCount = 0;
    const fetchFromDO = vi.fn(() => {
      callCount++;
      return Promise.resolve(makeDoResponse(`<p>v${callCount}</p>`));
    });

    await cachedPreviewFetch({
      request: makeRequest(),
      allowLive: false,
      cacheVersion: 1,
      fetchFromDO,
    });

    const second = await cachedPreviewFetch({
      request: makeRequest(),
      allowLive: false,
      cacheVersion: 2,
      fetchFromDO,
    });
    expect(fetchFromDO).toHaveBeenCalledTimes(2);
    expect(await second.text()).toBe('<p>v2</p>');
  });
});
