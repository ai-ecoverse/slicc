/**
 * Tests for `createHttpGlobal` — the `http` realm global.
 *
 * Covers:
 *  - URL building (baseUrl + path, absolute path, query params)
 *  - Header merging (base + per-request)
 *  - Lazy token resolution (sync, async, re-resolved per request)
 *  - JSON unwrap on application/json responses, text otherwise
 *  - HttpError thrown on !ok responses (with body)
 *  - 429/503 retry honoring Retry-After (delta-seconds and HTTP-date)
 *  - Exponential backoff fallback when Retry-After absent
 *  - maxAttempts ceiling — final failure throws
 */

import { describe, expect, it, vi } from 'vitest';
import {
  createHttpGlobal,
  HttpError,
  type HttpGlobalDeps,
} from '../../../src/kernel/realm/http-global.js';

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

function textResponse(body: string, init?: ResponseInit): Response {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/plain' },
    ...init,
  });
}

function makeFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return handler(url, init);
  });
  return Object.assign(fn, { calls });
}

function makeSleep() {
  const waits: number[] = [];
  const sleep = vi.fn(async (ms: number) => {
    waits.push(ms);
  });
  return Object.assign(sleep, { waits });
}

function makeDeps(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>
): HttpGlobalDeps & {
  fetch: ReturnType<typeof makeFetch>;
  sleep: ReturnType<typeof makeSleep>;
} {
  return { fetch: makeFetch(handler), sleep: makeSleep() };
}

describe('http.client — URL building', () => {
  it('joins baseUrl + relative path', async () => {
    const deps = makeDeps(() => jsonResponse({ ok: true }));
    const client = createHttpGlobal(deps).client({ baseUrl: 'https://api.example.com' });
    await client.get('/users/1');
    expect(deps.fetch.calls[0].url).toBe('https://api.example.com/users/1');
  });

  it('trims trailing slash from baseUrl', async () => {
    const deps = makeDeps(() => jsonResponse({}));
    const client = createHttpGlobal(deps).client({ baseUrl: 'https://api.example.com/' });
    await client.get('/users');
    expect(deps.fetch.calls[0].url).toBe('https://api.example.com/users');
  });

  it('prepends / when path is missing one', async () => {
    const deps = makeDeps(() => jsonResponse({}));
    const client = createHttpGlobal(deps).client({ baseUrl: 'https://api.example.com' });
    await client.get('users/1');
    expect(deps.fetch.calls[0].url).toBe('https://api.example.com/users/1');
  });

  it('passes absolute URLs through untouched', async () => {
    const deps = makeDeps(() => jsonResponse({}));
    const client = createHttpGlobal(deps).client({ baseUrl: 'https://api.example.com' });
    await client.get('https://other.example.org/raw');
    expect(deps.fetch.calls[0].url).toBe('https://other.example.org/raw');
  });

  it('appends query params, encoding keys and values', async () => {
    const deps = makeDeps(() => jsonResponse({}));
    const client = createHttpGlobal(deps).client({ baseUrl: 'https://api.example.com' });
    await client.get('/search', { params: { q: 'hello world', page: 2 } });
    expect(deps.fetch.calls[0].url).toBe('https://api.example.com/search?q=hello%20world&page=2');
  });

  it('repeats query keys for array values, skipping null/undefined', async () => {
    const deps = makeDeps(() => jsonResponse({}));
    const client = createHttpGlobal(deps).client({ baseUrl: 'https://api.example.com' });
    await client.get('/list', { params: { tag: ['a', 'b'], skip: null, only: undefined } });
    expect(deps.fetch.calls[0].url).toBe('https://api.example.com/list?tag=a&tag=b');
  });

  it('merges params into a URL that already has a query string', async () => {
    const deps = makeDeps(() => jsonResponse({}));
    const client = createHttpGlobal(deps).client({ baseUrl: 'https://api.example.com' });
    await client.get('/search?source=feed', { params: { q: 'x' } });
    expect(deps.fetch.calls[0].url).toBe('https://api.example.com/search?source=feed&q=x');
  });
});

describe('http.client — header merging + auth', () => {
  it('merges base headers with per-request headers (per-request wins)', async () => {
    const deps = makeDeps(() => jsonResponse({}));
    const client = createHttpGlobal(deps).client({
      baseUrl: 'https://api.example.com',
      headers: { 'X-Base': 'b', Accept: 'application/json' },
    });
    await client.get('/x', { headers: { Accept: 'text/plain' } });
    const headers = deps.fetch.calls[0].init?.headers as Record<string, string>;
    expect(headers['X-Base']).toBe('b');
    expect(headers['Accept']).toBe('text/plain');
  });

  it('attaches a Bearer Authorization header when token() resolves', async () => {
    const deps = makeDeps(() => jsonResponse({}));
    const client = createHttpGlobal(deps).client({
      baseUrl: 'https://api.example.com',
      token: async () => 'tok-1',
    });
    await client.get('/me');
    const headers = deps.fetch.calls[0].init?.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer tok-1');
  });

  it('re-resolves token() per request (no memoization)', async () => {
    const deps = makeDeps(() => jsonResponse({}));
    let n = 0;
    const token = vi.fn(async () => `tok-${++n}`);
    const client = createHttpGlobal(deps).client({
      baseUrl: 'https://api.example.com',
      token,
    });
    await client.get('/a');
    await client.get('/b');
    expect(token).toHaveBeenCalledTimes(2);
    const h0 = deps.fetch.calls[0].init?.headers as Record<string, string>;
    const h1 = deps.fetch.calls[1].init?.headers as Record<string, string>;
    expect(h0['Authorization']).toBe('Bearer tok-1');
    expect(h1['Authorization']).toBe('Bearer tok-2');
  });

  it('does not overwrite a caller-supplied Authorization header', async () => {
    const deps = makeDeps(() => jsonResponse({}));
    const client = createHttpGlobal(deps).client({
      baseUrl: 'https://api.example.com',
      token: () => 'should-not-win',
    });
    await client.get('/x', { headers: { Authorization: 'Basic abc' } });
    const headers = deps.fetch.calls[0].init?.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Basic abc');
  });

  it('skips Authorization when token() returns null/undefined', async () => {
    const deps = makeDeps(() => jsonResponse({}));
    const client = createHttpGlobal(deps).client({
      baseUrl: 'https://api.example.com',
      token: async () => null,
    });
    await client.get('/x');
    const headers = deps.fetch.calls[0].init?.headers as Record<string, string>;
    expect(headers['Authorization']).toBeUndefined();
  });
});

describe('http.client — body + response parsing', () => {
  it('stringifies object bodies and sets Content-Type to JSON by default', async () => {
    const deps = makeDeps(() => jsonResponse({ created: true }));
    const client = createHttpGlobal(deps).client({ baseUrl: 'https://api.example.com' });
    await client.post('/users', { body: { name: 'alice' } });
    const init = deps.fetch.calls[0].init!;
    const headers = init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(init.body).toBe(JSON.stringify({ name: 'alice' }));
  });

  it('passes through string bodies and respects caller Content-Type', async () => {
    const deps = makeDeps(() => jsonResponse({}));
    const client = createHttpGlobal(deps).client({ baseUrl: 'https://api.example.com' });
    await client.post('/raw', {
      body: 'plain',
      headers: { 'Content-Type': 'text/plain' },
    });
    const init = deps.fetch.calls[0].init!;
    expect(init.body).toBe('plain');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('text/plain');
  });

  it('parses JSON responses based on content-type', async () => {
    const deps = makeDeps(() => jsonResponse({ a: 1 }));
    const client = createHttpGlobal(deps).client({ baseUrl: 'https://api.example.com' });
    const out = await client.get('/x');
    expect(out).toEqual({ a: 1 });
  });

  it('returns text for non-JSON responses', async () => {
    const deps = makeDeps(() => textResponse('hello'));
    const client = createHttpGlobal(deps).client({ baseUrl: 'https://api.example.com' });
    const out = await client.get('/x');
    expect(out).toBe('hello');
  });

  it('recognizes +json content-types', async () => {
    const deps = makeDeps(
      () =>
        new Response(JSON.stringify({ v: 2 }), {
          status: 200,
          headers: { 'content-type': 'application/vnd.api+json' },
        })
    );
    const client = createHttpGlobal(deps).client({ baseUrl: 'https://api.example.com' });
    expect(await client.get('/x')).toEqual({ v: 2 });
  });
});

describe('http.client — error handling', () => {
  it('throws HttpError on !ok responses, including parsed JSON body', async () => {
    const deps = makeDeps(
      () =>
        new Response(JSON.stringify({ error: 'nope' }), {
          status: 404,
          statusText: 'Not Found',
          headers: { 'content-type': 'application/json' },
        })
    );
    const client = createHttpGlobal(deps).client({ baseUrl: 'https://api.example.com' });
    let caught: unknown;
    try {
      await client.get('/missing');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(HttpError);
    const err = caught as HttpError;
    expect(err.status).toBe(404);
    expect(err.statusText).toBe('Not Found');
    expect(err.body).toEqual({ error: 'nope' });
  });
});

describe('http.client — retries', () => {
  it('retries on 429 honoring Retry-After delta-seconds', async () => {
    let n = 0;
    const deps = makeDeps(() => {
      n++;
      if (n === 1) {
        return new Response('rate limited', {
          status: 429,
          statusText: 'Too Many Requests',
          headers: { 'retry-after': '2' },
        });
      }
      return jsonResponse({ ok: true });
    });
    const client = createHttpGlobal(deps).client({
      baseUrl: 'https://api.example.com',
      retry: { on: [429], maxAttempts: 3 },
    });
    const out = await client.get('/x');
    expect(out).toEqual({ ok: true });
    expect(deps.fetch).toHaveBeenCalledTimes(2);
    expect(deps.sleep.waits).toEqual([2000]);
  });

  it('retries on 503 with exponential backoff when Retry-After is absent', async () => {
    let n = 0;
    const deps = makeDeps(() => {
      n++;
      if (n < 3) return new Response('busy', { status: 503, statusText: 'Service Unavailable' });
      return jsonResponse({ ok: true });
    });
    const client = createHttpGlobal(deps).client({
      baseUrl: 'https://api.example.com',
      retry: { on: [503], maxAttempts: 4 },
    });
    await client.get('/x');
    expect(deps.fetch).toHaveBeenCalledTimes(3);
    // 500 * 2^0 = 500, 500 * 2^1 = 1000
    expect(deps.sleep.waits).toEqual([500, 1000]);
  });

  it('parses HTTP-date Retry-After values', async () => {
    let n = 0;
    const future = new Date(Date.now() + 1500).toUTCString();
    const deps = makeDeps(() => {
      n++;
      if (n === 1) {
        return new Response('limited', {
          status: 429,
          headers: { 'retry-after': future },
        });
      }
      return jsonResponse({ ok: true });
    });
    const client = createHttpGlobal(deps).client({
      baseUrl: 'https://api.example.com',
      retry: { on: [429], maxAttempts: 2 },
    });
    await client.get('/x');
    expect(deps.sleep.waits).toHaveLength(1);
    // Accept any positive delay within a generous window — wall clock may drift.
    expect(deps.sleep.waits[0]).toBeGreaterThan(0);
    expect(deps.sleep.waits[0]).toBeLessThanOrEqual(2000);
  });

  it('throws after exhausting maxAttempts on a retryable status', async () => {
    const deps = makeDeps(
      () =>
        new Response('still rate limited', {
          status: 429,
          statusText: 'Too Many Requests',
          headers: { 'retry-after': '0' },
        })
    );
    const client = createHttpGlobal(deps).client({
      baseUrl: 'https://api.example.com',
      retry: { on: [429], maxAttempts: 3 },
    });
    await expect(client.get('/x')).rejects.toBeInstanceOf(HttpError);
    expect(deps.fetch).toHaveBeenCalledTimes(3);
    expect(deps.sleep.waits).toEqual([0, 0]);
  });

  it('does not retry statuses outside retry.on', async () => {
    const deps = makeDeps(
      () => new Response('forbidden', { status: 403, statusText: 'Forbidden' })
    );
    const client = createHttpGlobal(deps).client({
      baseUrl: 'https://api.example.com',
      retry: { on: [429, 503], maxAttempts: 3 },
    });
    await expect(client.get('/x')).rejects.toBeInstanceOf(HttpError);
    expect(deps.fetch).toHaveBeenCalledTimes(1);
    expect(deps.sleep).not.toHaveBeenCalled();
  });

  it('resolves the token once per request, fresh on the next request after expiry', async () => {
    // Pins the per-request semantic: token() is called exactly once per
    // request (not per retry attempt within a request), but a new
    // request after a token has expired calls token() again — so
    // skill.token's exec'd `oauth-token` refresh hook gets to run.
    let attempts = 0;
    const token = vi.fn(async () => `tok-${++attempts}`);
    let reqCount = 0;
    const deps = makeDeps(() => {
      reqCount++;
      // First request: 429 then 200 (one retry inside the request).
      if (reqCount === 1) {
        return new Response('limited', {
          status: 429,
          headers: { 'retry-after': '0' },
        });
      }
      return jsonResponse({ ok: true });
    });
    const client = createHttpGlobal(deps).client({
      baseUrl: 'https://api.example.com',
      token,
      retry: { on: [429], maxAttempts: 2 },
    });
    await client.get('/x');
    expect(token).toHaveBeenCalledTimes(1);
    expect(deps.fetch).toHaveBeenCalledTimes(2);
    // A fresh request re-invokes token().
    await client.get('/y');
    expect(token).toHaveBeenCalledTimes(2);
    const h0 = deps.fetch.calls[0].init?.headers as Record<string, string>;
    const h2 = deps.fetch.calls[2].init?.headers as Record<string, string>;
    expect(h0['Authorization']).toBe('Bearer tok-1');
    expect(h2['Authorization']).toBe('Bearer tok-2');
  });
});

describe('http.client — methods', () => {
  it('routes get/post/put/patch/delete to the correct HTTP method', async () => {
    const deps = makeDeps(() => jsonResponse({}));
    const client = createHttpGlobal(deps).client({ baseUrl: 'https://api.example.com' });
    await client.get('/g');
    await client.post('/p');
    await client.put('/u');
    await client.patch('/pa');
    await client.delete('/d');
    expect(deps.fetch.calls.map((c) => c.init?.method)).toEqual([
      'GET',
      'POST',
      'PUT',
      'PATCH',
      'DELETE',
    ]);
  });

  it('serializes object bodies as JSON on PATCH with Content-Type application/json', async () => {
    const deps = makeDeps(() => jsonResponse({ ok: true }));
    const client = createHttpGlobal(deps).client({ baseUrl: 'https://api.example.com' });
    await client.patch('/items/1', { body: { name: 'alice' } });
    const init = deps.fetch.calls[0].init!;
    const headers = init.headers as Record<string, string>;
    expect(init.method).toBe('PATCH');
    expect(headers['Content-Type']).toBe('application/json');
    expect(init.body).toBe(JSON.stringify({ name: 'alice' }));
  });

  it('exposes patch as an enumerable own property of the client', () => {
    const deps = makeDeps(() => jsonResponse({}));
    const client = createHttpGlobal(deps).client({});
    const keys = Object.keys(client);
    expect(keys).toContain('patch');
  });

  it('returns a frozen client object', () => {
    const deps = makeDeps(() => jsonResponse({}));
    const client = createHttpGlobal(deps).client({});
    expect(Object.isFrozen(client)).toBe(true);
  });

  it('returns a frozen http global', () => {
    const deps = makeDeps(() => jsonResponse({}));
    const http = createHttpGlobal(deps);
    expect(Object.isFrozen(http)).toBe(true);
  });
});

describe('http.client — raw responses', () => {
  it('returns { body, headers, status } when raw: true', async () => {
    const deps = makeDeps(() =>
      jsonResponse(
        { ok: true },
        { status: 201, headers: { 'content-type': 'application/json', 'x-trace': 'abc' } }
      )
    );
    const client = createHttpGlobal(deps).client({ baseUrl: 'https://api.example.com' });
    const resp = (await client.get('/x', { raw: true })) as {
      body: unknown;
      headers: Record<string, string>;
      status: number;
    };
    expect(resp.status).toBe(201);
    expect(resp.body).toEqual({ ok: true });
    expect(resp.headers['x-trace']).toBe('abc');
    expect(resp.headers['content-type']).toBe('application/json');
  });

  it('returns body directly when raw is omitted', async () => {
    const deps = makeDeps(() => jsonResponse({ ok: true }));
    const client = createHttpGlobal(deps).client({ baseUrl: 'https://api.example.com' });
    const resp = await client.get('/x');
    expect(resp).toEqual({ ok: true });
  });
});

describe('http.client — token request context', () => {
  it('passes { method, path, url } to the token function', async () => {
    const seen: Array<{ method: string; path: string; url: string } | undefined> = [];
    const deps = makeDeps(() => jsonResponse({}));
    const client = createHttpGlobal(deps).client({
      baseUrl: 'https://api.example.com',
      token: (req) => {
        seen.push(req);
        return 'tok';
      },
    });
    await client.get('/users/1', { params: { x: '1' } });
    await client.post('/items');
    expect(seen[0]).toEqual({
      method: 'GET',
      path: '/users/1',
      url: 'https://api.example.com/users/1?x=1',
    });
    expect(seen[1]).toEqual({
      method: 'POST',
      path: '/items',
      url: 'https://api.example.com/items',
    });
  });

  it('still works when token ignores the request argument (back-compat)', async () => {
    const deps = makeDeps(() => jsonResponse({}));
    const client = createHttpGlobal(deps).client({
      baseUrl: 'https://api.example.com',
      token: () => 'legacy-tok',
    });
    await client.get('/x');
    const h = deps.fetch.calls[0].init?.headers as Record<string, string>;
    expect(h['Authorization']).toBe('Bearer legacy-tok');
  });
});

describe('http.client — timeoutMs', () => {
  it('aborts the request when the per-attempt timeout fires', async () => {
    vi.useFakeTimers();
    try {
      const deps: HttpGlobalDeps = {
        fetch: vi.fn(async (_url: string, init?: RequestInit) => {
          return await new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              reject(init.signal!.reason ?? new Error('aborted'));
            });
          });
        }),
        sleep: async () => {},
      };
      const client = createHttpGlobal(deps).client({
        baseUrl: 'https://api.example.com',
        timeoutMs: 50,
      });
      const p = client.get('/slow');
      const caught = p.catch((e) => e);
      await vi.advanceTimersByTimeAsync(60);
      const err = await caught;
      expect(err).toBeInstanceOf(Error);
      expect(String((err as Error).message)).toMatch(/timeout|abort/i);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('http.client — caller signal', () => {
  it('aborts when the caller signal fires', async () => {
    const ctl = new AbortController();
    const deps: HttpGlobalDeps = {
      fetch: vi.fn(async (_url: string, init?: RequestInit) => {
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(init.signal!.reason ?? new Error('aborted'));
          });
        });
      }),
      sleep: async () => {},
    };
    const client = createHttpGlobal(deps).client({ baseUrl: 'https://api.example.com' });
    const p = client.get('/slow', { signal: ctl.signal });
    const caught = p.catch((e) => e);
    ctl.abort(new Error('user-cancel'));
    const err = await caught;
    expect(err).toBeInstanceOf(Error);
    expect(String((err as Error).message)).toMatch(/cancel|abort/i);
  });
});
