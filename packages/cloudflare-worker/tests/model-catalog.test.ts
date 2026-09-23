import { describe, expect, it, vi } from 'vitest';
import { handleWorkerRequest } from '../src/index.js';
import { MODEL_CATALOG_UPSTREAM_TIMEOUT_MS, modelCatalogProviderId } from '../src/model-catalog.js';
import { makeEnv } from './helpers/fake-env.js';

const CATALOG_BODY = JSON.stringify({
  'claude-opus-5-5': { id: 'claude-opus-5-5', name: 'Claude Opus 5.5' },
});

function upstream(status = 200, headers: Record<string, string> = {}): typeof fetch {
  return vi.fn(async () =>
    status === 200
      ? new Response(CATALOG_BODY, {
          status,
          headers: {
            'content-type': 'application/json; charset=utf-8',
            etag: '"abc"',
            'last-modified': 'Tue, 22 Sep 2026 16:47:50 GMT',
            'x-pi-model-catalog-minimum-version': '0.80.7',
            'set-cookie': 'tracking=1',
            ...headers,
          },
        })
      : new Response('nope', { status })
  ) as unknown as typeof fetch;
}

function request(path: string, init: RequestInit = {}): Request {
  return new Request(`https://www.sliccy.ai${path}`, init);
}

describe('modelCatalogProviderId', () => {
  it('extracts the provider id from the route', () => {
    expect(modelCatalogProviderId('/api/models/providers/anthropic')).toBe('anthropic');
    expect(modelCatalogProviderId('/api/flags')).toBeNull();
  });
});

describe('GET /api/models/providers/:id', () => {
  it("relays pi.dev's catalogue with its validators and CORS for SLICC origins", async () => {
    const fetchImpl = upstream();
    const res = await handleWorkerRequest(
      request('/api/models/providers/amazon-bedrock', {
        headers: { Origin: 'http://localhost:5710' },
      }),
      makeEnv(),
      fetchImpl
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(CATALOG_BODY);
    expect(res.headers.get('etag')).toBe('"abc"');
    expect(res.headers.get('last-modified')).toBe('Tue, 22 Sep 2026 16:47:50 GMT');
    expect(res.headers.get('x-pi-model-catalog-minimum-version')).toBe('0.80.7');
    expect(res.headers.get('cache-control')).toBe('public, max-age=300');
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:5710');
    expect(res.headers.get('access-control-expose-headers')).toContain('Last-Modified');
    const [url, init] = vi.mocked(fetchImpl).mock.calls[0];
    expect(url).toBe('https://pi.dev/api/models/providers/amazon-bedrock');
    expect((init as { cf?: unknown }).cf).toEqual({ cacheTtl: 300, cacheEverything: true });
  });

  it('does not reflect an unknown origin', async () => {
    const res = await handleWorkerRequest(
      request('/api/models/providers/anthropic', { headers: { Origin: 'https://evil.example' } }),
      makeEnv(),
      upstream()
    );
    expect(res.headers.get('access-control-allow-origin')).toBe('https://www.sliccy.ai');
  });

  it('answers 304 when the client already holds the current ETag', async () => {
    const res = await handleWorkerRequest(
      request('/api/models/providers/anthropic', { headers: { 'If-None-Match': 'W/"abc"' } }),
      makeEnv(),
      upstream()
    );
    expect(res.status).toBe(304);
    expect(res.headers.get('etag')).toBe('"abc"');
    expect(res.headers.get('content-type')).toBeNull();
  });

  it('rejects provider ids that are not plain slugs, without calling upstream', async () => {
    const fetchImpl = upstream();
    for (const id of ['..%2Fsecrets', 'Anthropic', 'a/b', '-x', 'a'.repeat(65)]) {
      const res = await handleWorkerRequest(
        request(`/api/models/providers/${id}`),
        makeEnv(),
        fetchImpl
      );
      expect(res.status, id).toBe(400);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('maps an upstream 404 or 501 to 404 and other failures to 502', async () => {
    for (const status of [404, 501]) {
      const missing = await handleWorkerRequest(
        request('/api/models/providers/nope'),
        makeEnv(),
        upstream(status)
      );
      expect(missing.status, String(status)).toBe(404);
    }
    const broken = await handleWorkerRequest(
      request('/api/models/providers/anthropic'),
      makeEnv(),
      upstream(503)
    );
    expect(broken.status).toBe(502);
    const unreachable = await handleWorkerRequest(
      request('/api/models/providers/anthropic'),
      makeEnv(),
      vi.fn(async () => {
        throw new Error('offline');
      }) as unknown as typeof fetch
    );
    expect(unreachable.status).toBe(502);
  });

  it('bounds the upstream fetch so a hung origin fails fast into a 502', async () => {
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    try {
      const fetchImpl = vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
          })
      ) as unknown as typeof fetch;
      const pending = handleWorkerRequest(
        request('/api/models/providers/anthropic'),
        makeEnv(),
        fetchImpl
      );
      await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalled());
      controller.abort();
      const res = await pending;
      expect(res.status).toBe(502);
      expect(timeout).toHaveBeenCalledWith(MODEL_CATALOG_UPSTREAM_TIMEOUT_MS);
    } finally {
      timeout.mockRestore();
    }
  });

  it('answers preflight and refuses writes', async () => {
    const preflight = await handleWorkerRequest(
      request('/api/models/providers/anthropic', {
        method: 'OPTIONS',
        headers: { Origin: 'https://www.sliccy.ai' },
      }),
      makeEnv(),
      upstream()
    );
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-headers')).toBe('If-None-Match');
    const post = await handleWorkerRequest(
      request('/api/models/providers/anthropic', { method: 'POST' }),
      makeEnv(),
      upstream()
    );
    expect(post.status).toBe(405);
  });
});
