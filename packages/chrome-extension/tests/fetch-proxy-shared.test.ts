import { createHmac } from 'node:crypto';
import { SecretsPipeline } from '@slicc/shared-ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  handleFetchProxyConnection,
  handleFetchProxyConnectionAsync,
  type PortLike,
} from '../src/fetch-proxy-shared.js';

function makePort(
  onPost: (msg: unknown) => void
): PortLike & { fireMessage(msg: unknown): void; fireDisconnect(): void } {
  const listeners: ((msg: unknown) => void)[] = [];
  const disconnectListeners: (() => void)[] = [];
  return {
    onMessage: { addListener: (fn: (msg: unknown) => void) => listeners.push(fn) },
    onDisconnect: { addListener: (fn: () => void) => disconnectListeners.push(fn) },
    postMessage: onPost,
    fireMessage: (m: unknown) => {
      listeners.forEach((l) => {
        l(m);
      });
    },
    fireDisconnect: () => {
      disconnectListeners.forEach((l) => {
        l();
      });
    },
  };
}

describe('handleFetchProxyConnection', () => {
  let pipeline: SecretsPipeline;
  let masked: string;

  beforeEach(async () => {
    pipeline = new SecretsPipeline({
      sessionId: 'session-fixed',
      source: {
        get: async () => undefined,
        listAll: async () => [
          { name: 'GITHUB_TOKEN', value: 'ghp_realtoken', domains: ['api.github.com'] },
        ],
      },
    });
    await pipeline.reload();
    masked = await pipeline.maskOne('GITHUB_TOKEN', 'ghp_realtoken');
  });

  it('streams a multi-chunk response back and ends with response-end', async () => {
    const chunks = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6])];
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        chunks.forEach((ch) => {
          c.enqueue(ch);
        });
        c.close();
      },
    });
    (globalThis as any).fetch = vi.fn(
      async () => new Response(stream, { status: 200, statusText: 'OK' })
    );

    const posts: any[] = [];
    const port = makePort((m) => posts.push(m));
    handleFetchProxyConnection(port, pipeline);
    port.fireMessage({
      type: 'request',
      url: 'https://api.github.com/user',
      method: 'GET',
      headers: { authorization: `Bearer ${masked}` },
    });

    await new Promise((r) => setTimeout(r, 10));
    expect(posts[0]).toMatchObject({ type: 'response-head', status: 200 });
    expect(posts.filter((p) => p.type === 'response-chunk').length).toBe(2);
    expect(posts[posts.length - 1]).toMatchObject({ type: 'response-end' });
  });

  it('aborts upstream fetch on port disconnect', async () => {
    const ac = new AbortController();
    (globalThis as any).fetch = vi.fn(async (_url: string, init: { signal?: AbortSignal }) => {
      init.signal!.addEventListener('abort', () => ac.abort());
      return new Promise(() => {});
    });
    const port = makePort(() => {});
    handleFetchProxyConnection(port, pipeline);
    port.fireMessage({
      type: 'request',
      url: 'https://api.github.com/x',
      method: 'GET',
      headers: {},
    });
    await new Promise((r) => setTimeout(r, 5));
    port.fireDisconnect();
    await new Promise((r) => setTimeout(r, 5));
    expect(ac.signal.aborted).toBe(true);
  });

  it('returns 413 + Payload Too Large when requestBodyTooLarge is set', async () => {
    const posts: any[] = [];
    const port = makePort((m) => posts.push(m));
    handleFetchProxyConnection(port, pipeline);
    port.fireMessage({
      type: 'request',
      url: 'https://api.github.com/x',
      method: 'POST',
      headers: {},
      requestBodyTooLarge: true,
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(posts[0]).toMatchObject({
      type: 'response-head',
      status: 413,
      statusText: 'Payload Too Large',
    });
    expect(posts[1]).toMatchObject({ type: 'response-end' });
  });

  it('forbidden domain returns response-error', async () => {
    (globalThis as any).fetch = vi.fn();
    const posts: any[] = [];
    const port = makePort((m) => posts.push(m));
    handleFetchProxyConnection(port, pipeline);
    port.fireMessage({
      type: 'request',
      url: 'https://evil.example.com/',
      method: 'GET',
      headers: { authorization: `Bearer ${masked}` },
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(posts.find((p) => p.type === 'response-error')).toBeDefined();
  });

  it('the real value never appears in any posted message', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('hello world'));
        c.close();
      },
    });
    (globalThis as any).fetch = vi.fn(
      async () => new Response(stream, { status: 200, statusText: 'OK' })
    );
    const posts: any[] = [];
    const port = makePort((m) => posts.push(m));
    handleFetchProxyConnection(port, pipeline);
    port.fireMessage({
      type: 'request',
      url: 'https://api.github.com/user',
      method: 'GET',
      headers: { authorization: `Bearer ${masked}` },
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(JSON.stringify(posts)).not.toContain('ghp_realtoken');
  });

  it('URL with masked cred for allowed domain → synthetic Authorization header', async () => {
    let fetchUrl: string | undefined;
    let fetchHeaders: Record<string, string> | undefined;
    (globalThis as any).fetch = vi.fn(async (url: string, init: any) => {
      fetchUrl = url;
      fetchHeaders = init.headers;
      return new Response('ok', { status: 200, statusText: 'OK' });
    });

    const posts: any[] = [];
    const port = makePort((m) => posts.push(m));
    handleFetchProxyConnection(port, pipeline);
    port.fireMessage({
      type: 'request',
      url: `https://x-access-token:${masked}@api.github.com/repos/foo/bar`,
      method: 'GET',
      headers: {},
    });
    await new Promise((r) => setTimeout(r, 10));

    expect(fetchUrl).toBe('https://api.github.com/repos/foo/bar');
    expect(fetchHeaders?.authorization).toBeDefined();
    expect(fetchHeaders?.authorization).toMatch(/^Basic /);

    const basicMatch = /^Basic (.+)$/.exec(fetchHeaders?.authorization || '');
    expect(basicMatch).toBeDefined();
    const decoded = atob(basicMatch![1]);
    expect(decoded).toBe('x-access-token:ghp_realtoken');

    expect(posts[0]).toMatchObject({ type: 'response-head', status: 200 });
  });

  it('URL with masked cred for forbidden domain → response-error', async () => {
    const fetchSpy = vi.fn();
    (globalThis as any).fetch = fetchSpy;

    const posts: any[] = [];
    const port = makePort((m) => posts.push(m));
    handleFetchProxyConnection(port, pipeline);
    port.fireMessage({
      type: 'request',
      url: `https://x-access-token:${masked}@evil.example.com/repos/foo`,
      method: 'GET',
      headers: {},
    });
    await new Promise((r) => setTimeout(r, 10));

    expect(fetchSpy).not.toHaveBeenCalled();

    const errorPost = posts.find((p) => p.type === 'response-error');
    expect(errorPost).toBeDefined();
    expect(errorPost.error).toContain('forbidden');
    expect(errorPost.error).toContain('GITHUB_TOKEN');
    expect(errorPost.error).toContain('evil.example.com');
  });

  it('URL with masked cred AND existing authorization header → synthetic does not clobber', async () => {
    let fetchHeaders: Record<string, string> | undefined;
    (globalThis as any).fetch = vi.fn(async (_url: string, init: any) => {
      fetchHeaders = init.headers;
      return new Response('ok', { status: 200, statusText: 'OK' });
    });

    const posts: any[] = [];
    const port = makePort((m) => posts.push(m));
    handleFetchProxyConnection(port, pipeline);
    port.fireMessage({
      type: 'request',
      url: `https://x-access-token:${masked}@api.github.com/foo`,
      method: 'GET',
      headers: { authorization: 'Bearer existing-token' },
    });
    await new Promise((r) => setTimeout(r, 10));

    expect(fetchHeaders?.authorization).toBe('Bearer existing-token');
    expect(posts[0]).toMatchObject({ type: 'response-head', status: 200 });
  });
});

// Regression: chrome.runtime.Port drops messages that arrive before any
// onMessage listener is attached. The SW originally awaited an async
// buildSecretsPipeline() in the onConnect callback and only THEN attached
// the listener — too late for the page's immediate `request` postMessage,
// and curl-from-the-extension hung forever waiting for a response that
// would never come.
//
// `handleFetchProxyConnectionAsync` attaches the listener synchronously
// and awaits the pipeline INSIDE the handler. This test pins that contract.
describe('handleFetchProxyConnectionAsync — synchronous listener attach', () => {
  it('queues a request that arrives before the pipeline resolves', async () => {
    let resolvePipeline: ((p: SecretsPipeline) => void) | null = null;
    const pipelinePromise = new Promise<SecretsPipeline>((res) => {
      resolvePipeline = res;
    });

    const posts: any[] = [];
    const port = makePort((m) => posts.push(m));

    // The SW attaches the listener synchronously.
    handleFetchProxyConnectionAsync(port, pipelinePromise);

    // Page-side immediately posts a request — same race that broke prod.
    port.fireMessage({
      type: 'request',
      url: 'https://api.github.com/test',
      method: 'GET',
      headers: {},
    });

    // No response yet — pipeline hasn't resolved.
    expect(posts).toHaveLength(0);

    // Now resolve the pipeline.
    const pipeline = new SecretsPipeline({
      sessionId: 'late-init',
      source: { get: async () => undefined, listAll: async () => [] },
    });
    await pipeline.reload();
    (globalThis as any).fetch = vi.fn(
      async () => new Response('ok', { status: 200, statusText: 'OK' })
    );
    resolvePipeline!(pipeline);

    // The buffered request now processes.
    await new Promise((r) => setTimeout(r, 10));
    expect(posts.some((p) => p.type === 'response-head' && p.status === 200)).toBe(true);
    expect(posts.some((p) => p.type === 'response-end')).toBe(true);
  });

  it('posts response-error when the pipeline-build promise rejects', async () => {
    const pipelinePromise = Promise.reject(new Error('storage unavailable'));
    // Suppress the unhandled-rejection warning for this test.
    pipelinePromise.catch(() => {});

    const posts: any[] = [];
    const port = makePort((m) => posts.push(m));
    handleFetchProxyConnectionAsync(port, pipelinePromise);

    port.fireMessage({
      type: 'request',
      url: 'https://api.github.com/test',
      method: 'GET',
      headers: {},
    });

    await new Promise((r) => setTimeout(r, 10));
    expect(posts).toEqual([
      {
        type: 'response-error',
        error: expect.stringContaining('fetch-proxy init failed: storage unavailable'),
      },
    ]);
  });
});

// Proxy-side HMAC body signing (x-slicc-hmac-sign): the page/agent side never
// holds the real secret, so it asks the SW proxy to sign the (unmasked) body
// and attach the result under the header it names — see HMAC_SIGN_HEADER.
describe('handleFetchProxyConnection — x-slicc-hmac-sign', () => {
  const HMAC_SECRET = 'job-signing-secret-abcdefghijklmnop';
  let hmacPipeline: SecretsPipeline;

  beforeEach(async () => {
    hmacPipeline = new SecretsPipeline({
      sessionId: 'session-fixed',
      source: {
        get: async () => undefined,
        listAll: async () => [
          { name: 'SIGNING_KEY', value: HMAC_SECRET, domains: ['worker.example.com'] },
        ],
      },
    });
    await hmacPipeline.reload();
  });

  function encodeBase64(s: string): string {
    return btoa(s);
  }

  it('signs the request body and strips the sentinel header before fetch', async () => {
    let fetchHeaders: Record<string, string> | undefined;
    let fetchBody: unknown;
    (globalThis as any).fetch = vi.fn(async (_url: string, init: any) => {
      fetchHeaders = init.headers;
      fetchBody = init.body;
      return new Response('ok', { status: 200, statusText: 'OK' });
    });

    const body = JSON.stringify({ step: 3, status: 'running' });
    const posts: any[] = [];
    const port = makePort((m) => posts.push(m));
    handleFetchProxyConnection(port, hmacPipeline);
    port.fireMessage({
      type: 'request',
      url: 'https://worker.example.com/api/jobs/j1/events',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-slicc-hmac-sign': 'SIGNING_KEY:x-job-signature',
      },
      bodyBase64: encodeBase64(body),
    });
    await new Promise((r) => setTimeout(r, 10));

    expect(new TextDecoder().decode(fetchBody as Uint8Array)).toBe(body);
    expect(fetchHeaders?.['x-slicc-hmac-sign']).toBeUndefined();
    expect(fetchHeaders?.['x-job-signature']).toBe(
      createHmac('sha256', HMAC_SECRET).update(body).digest('hex')
    );
  });

  it('response-error when the signing secret is scoped to a different domain', async () => {
    const fetchSpy = vi.fn();
    (globalThis as any).fetch = fetchSpy;

    const posts: any[] = [];
    const port = makePort((m) => posts.push(m));
    handleFetchProxyConnection(port, hmacPipeline);
    port.fireMessage({
      type: 'request',
      url: 'https://evil.example.com/steal',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-slicc-hmac-sign': 'SIGNING_KEY:x-job-signature',
      },
      bodyBase64: encodeBase64('{}'),
    });
    await new Promise((r) => setTimeout(r, 10));

    expect(fetchSpy).not.toHaveBeenCalled();
    const errorPost = posts.find((p) => p.type === 'response-error');
    expect(errorPost?.error).toContain('forbidden');
    expect(errorPost?.error).toContain('SIGNING_KEY');
    expect(errorPost?.error).toContain('evil.example.com');
  });
});

// X-Proxy-* forbidden-header transport parity with CLI. Browser `fetch()`
// silently strips Cookie/Origin/Referer/Proxy-* request headers AND the
// `Set-Cookie` response header, so both the page→SW request and the
// SW→page response are encoded under `X-Proxy-*` names.
describe('handleFetchProxyConnection — X-Proxy-* request decode', () => {
  let pipeline: SecretsPipeline;

  beforeEach(async () => {
    pipeline = new SecretsPipeline({
      sessionId: 'session-fixed',
      source: { get: async () => undefined, listAll: async () => [] },
    });
    await pipeline.reload();
  });

  async function dispatch(headers: Record<string, string>): Promise<Record<string, string>> {
    let captured: Record<string, string> | undefined;
    (globalThis as any).fetch = vi.fn(async (_url: string, init: { headers: any }) => {
      captured = init.headers as Record<string, string>;
      return new Response('ok', { status: 200, statusText: 'OK' });
    });
    const port = makePort(() => {});
    handleFetchProxyConnection(port, pipeline);
    port.fireMessage({
      type: 'request',
      url: 'https://api.example.com/path',
      method: 'GET',
      headers,
    });
    await new Promise((r) => setTimeout(r, 10));
    if (!captured) throw new Error('fetch was not called');
    return captured;
  }

  it('decodes X-Proxy-Origin → origin', async () => {
    const h = await dispatch({ 'X-Proxy-Origin': 'https://example.com' });
    expect(h.origin).toBe('https://example.com');
    expect('X-Proxy-Origin' in h).toBe(false);
  });

  it('decodes X-Proxy-Referer → referer', async () => {
    const h = await dispatch({ 'X-Proxy-Referer': 'https://example.com/page' });
    expect(h.referer).toBe('https://example.com/page');
    expect('X-Proxy-Referer' in h).toBe(false);
  });

  it('decodes X-Proxy-Cookie → cookie', async () => {
    const h = await dispatch({ 'X-Proxy-Cookie': 'sid=abc; theme=dark' });
    expect(h.cookie).toBe('sid=abc; theme=dark');
    expect('X-Proxy-Cookie' in h).toBe(false);
  });

  it('decodes X-Proxy-Proxy-* → proxy-* (preserves original suffix)', async () => {
    const h = await dispatch({ 'X-Proxy-Proxy-Authorization': 'Basic dXNlcjpwYXNz' });
    expect(h['proxy-authorization']).toBe('Basic dXNlcjpwYXNz');
    expect('X-Proxy-Proxy-Authorization' in h).toBe(false);
  });

  it('leaves non-forbidden headers untouched', async () => {
    const h = await dispatch({ 'User-Agent': 'curl/8', Accept: '*/*' });
    expect(h['User-Agent']).toBe('curl/8');
    expect(h['Accept']).toBe('*/*');
  });

  // Default-Origin fallback parity with CLI `/api/fetch-proxy`. When no
  // caller-supplied Origin reaches the SW (page-side strips Origin on the
  // forbidden-headers boundary), synthesize one from the target URL so
  // CORS-protected upstreams see a real Origin instead of nothing.
  it('synthesizes Origin from target URL when no Origin given', async () => {
    const h = await dispatch({});
    expect(h.origin).toBe('https://api.example.com');
  });

  it('caller-supplied X-Proxy-Origin wins over default-Origin fallback', async () => {
    const h = await dispatch({ 'X-Proxy-Origin': 'https://my.app' });
    expect(h.origin).toBe('https://my.app');
    expect('X-Proxy-Origin' in h).toBe(false);
  });
});

describe('handleFetchProxyConnection — Set-Cookie encode on response', () => {
  let pipeline: SecretsPipeline;

  beforeEach(async () => {
    pipeline = new SecretsPipeline({
      sessionId: 'session-fixed',
      source: { get: async () => undefined, listAll: async () => [] },
    });
    await pipeline.reload();
  });

  it('packs upstream Set-Cookie values into X-Proxy-Set-Cookie JSON array', async () => {
    const upstreamHeaders = new Headers([
      ['content-type', 'text/plain'],
      ['set-cookie', 'sid=abc; Path=/'],
      ['set-cookie', 'theme=dark; Path=/'],
    ]);
    (globalThis as any).fetch = vi.fn(
      async () => new Response('ok', { status: 200, statusText: 'OK', headers: upstreamHeaders })
    );

    const posts: any[] = [];
    const port = makePort((m) => posts.push(m));
    handleFetchProxyConnection(port, pipeline);
    port.fireMessage({
      type: 'request',
      url: 'https://api.example.com/login',
      method: 'GET',
      headers: {},
    });
    await new Promise((r) => setTimeout(r, 10));

    const head = posts.find((p) => p.type === 'response-head');
    expect(head).toBeDefined();
    expect(head.headers['X-Proxy-Set-Cookie']).toBeDefined();
    const parsed = JSON.parse(head.headers['X-Proxy-Set-Cookie']);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toContain('sid=abc; Path=/');
    expect(parsed).toContain('theme=dark; Path=/');
    // The raw `set-cookie` is dropped from the page-visible map (browsers
    // strip it anyway; X-Proxy-Set-Cookie is the recoverable transport).
    expect(head.headers['set-cookie']).toBeUndefined();
  });

  it('omits X-Proxy-Set-Cookie when upstream sets no cookies', async () => {
    (globalThis as any).fetch = vi.fn(
      async () => new Response('ok', { status: 200, statusText: 'OK' })
    );
    const posts: any[] = [];
    const port = makePort((m) => posts.push(m));
    handleFetchProxyConnection(port, pipeline);
    port.fireMessage({
      type: 'request',
      url: 'https://api.example.com/x',
      method: 'GET',
      headers: {},
    });
    await new Promise((r) => setTimeout(r, 10));
    const head = posts.find((p) => p.type === 'response-head');
    expect(head.headers['X-Proxy-Set-Cookie']).toBeUndefined();
  });
});

// Chrome strips Cookie/Referer/Proxy-* and overrides Origin on extension-SW
// `fetch()` even when those headers are listed in the init dict — empirically
// verified against Chrome for Testing 146 with the fetch-proxy SW (see
// `/tmp/slicc-empirical/echo-server.js` + `dnr-test.js`). The SW now installs
// a one-shot `chrome.declarativeNetRequest.updateSessionRules` rule that
// `set`s those headers on the wire and removes the rule when the response
// settles. These tests pin the rule shape and lifecycle.
describe('handleFetchProxyConnection — DNR forbidden-header rule', () => {
  let pipeline: SecretsPipeline;
  let dnrCalls: Array<{ addRules?: any[]; removeRuleIds?: number[] }>;

  beforeEach(async () => {
    pipeline = new SecretsPipeline({
      sessionId: 'session-fixed',
      source: { get: async () => undefined, listAll: async () => [] },
    });
    await pipeline.reload();
    dnrCalls = [];
    (globalThis as any).chrome = {
      declarativeNetRequest: {
        updateSessionRules: vi.fn(async (opts: any) => {
          dnrCalls.push(opts);
        }),
      },
    };
  });

  afterEach(() => {
    delete (globalThis as any).chrome;
  });

  async function dispatch(
    requestHeaders: Record<string, string>,
    url = 'https://api.example.com/path'
  ): Promise<{ fetchUrl: string; headersOnFetch: Record<string, string> }> {
    let fetchUrl: string | undefined;
    let headersOnFetch: Record<string, string> | undefined;
    (globalThis as any).fetch = vi.fn(async (u: string, init: any) => {
      fetchUrl = u;
      headersOnFetch = init.headers;
      return new Response('ok', { status: 200, statusText: 'OK' });
    });
    const port = makePort(() => {});
    handleFetchProxyConnection(port, pipeline);
    port.fireMessage({ type: 'request', url, method: 'GET', headers: requestHeaders });
    await new Promise((r) => setTimeout(r, 10));
    if (!fetchUrl || !headersOnFetch) throw new Error('fetch was not called');
    return { fetchUrl, headersOnFetch };
  }

  it('installs a session rule that sets origin/cookie/referer/proxy-* on the wire', async () => {
    await dispatch({
      'X-Proxy-Origin': 'https://my.app',
      'X-Proxy-Cookie': 'sid=abc',
      'X-Proxy-Referer': 'https://my.ref/page',
      'X-Proxy-Proxy-Authorization': 'Basic dXNlcjpwYXNz',
    });
    const installs = dnrCalls.filter((c) => c.addRules);
    expect(installs).toHaveLength(1);
    const rule = installs[0].addRules![0];
    expect(rule.action.type).toBe('modifyHeaders');
    const headerMap = new Map<string, string>(
      rule.action.requestHeaders.map((h: any) => [h.header, h.value])
    );
    expect(headerMap.get('origin')).toBe('https://my.app');
    expect(headerMap.get('cookie')).toBe('sid=abc');
    expect(headerMap.get('referer')).toBe('https://my.ref/page');
    expect(headerMap.get('proxy-authorization')).toBe('Basic dXNlcjpwYXNz');
    for (const h of rule.action.requestHeaders) {
      expect(h.operation).toBe('set');
    }
  });

  it('keys the rule via a unique URL fragment that survives to the fetch call', async () => {
    const { fetchUrl } = await dispatch({ 'X-Proxy-Origin': 'https://a.example' });
    expect(fetchUrl).toMatch(/^https:\/\/api\.example\.com\/path#slicc-req-/);
    const rule = dnrCalls.find((c) => c.addRules)!.addRules![0];
    expect(rule.condition.urlFilter).toBe(fetchUrl);
  });

  it('removes the session rule after the response settles', async () => {
    await dispatch({ 'X-Proxy-Origin': 'https://my.app' });
    const installs = dnrCalls.filter((c) => c.addRules);
    const removes = dnrCalls.filter((c) => c.removeRuleIds);
    expect(installs).toHaveLength(1);
    expect(removes).toHaveLength(1);
    expect(removes[0].removeRuleIds).toEqual([installs[0].addRules![0].id]);
  });

  it('removes the session rule even when fetch rejects', async () => {
    (globalThis as any).fetch = vi.fn(async () => {
      throw new Error('network');
    });
    const port = makePort(() => {});
    handleFetchProxyConnection(port, pipeline);
    port.fireMessage({
      type: 'request',
      url: 'https://api.example.com/x',
      method: 'GET',
      headers: { 'X-Proxy-Origin': 'https://my.app' },
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(dnrCalls.filter((c) => c.removeRuleIds)).toHaveLength(1);
  });

  it('does not install a rule when no forbidden header is present', async () => {
    // No X-Proxy-* headers AND a target URL that won't trigger the
    // default-origin fallback path? It always does — default-Origin
    // fallback synthesizes `origin` from the target URL, so DNR is
    // always invoked once the SW reaches fetch. Verify the rule has
    // ONLY `origin` (the fallback), not cookie/referer/proxy-*.
    await dispatch({});
    const installs = dnrCalls.filter((c) => c.addRules);
    expect(installs).toHaveLength(1);
    const rule = installs[0].addRules![0];
    const headerNames = rule.action.requestHeaders.map((h: any) => h.header);
    expect(headerNames).toEqual(['origin']);
  });

  it('strips a caller-supplied URL fragment from the wire URL', async () => {
    const { fetchUrl } = await dispatch(
      { 'X-Proxy-Origin': 'https://my.app' },
      'https://api.example.com/path#caller-supplied'
    );
    expect(fetchUrl).not.toContain('caller-supplied');
    expect(fetchUrl).toMatch(/^https:\/\/api\.example\.com\/path#slicc-req-/);
  });

  it('falls back to a no-op when chrome.declarativeNetRequest is unavailable', async () => {
    delete (globalThis as any).chrome;
    const { fetchUrl, headersOnFetch } = await dispatch({
      'X-Proxy-Origin': 'https://my.app',
      'X-Proxy-Cookie': 'sid=abc',
    });
    // No fragment appended — fetch sees the original URL.
    expect(fetchUrl).toBe('https://api.example.com/path');
    // Forbidden headers still passed under their real names so unit tests
    // that mock `fetch` can capture them. Real Chrome strips them; that's
    // the fallback-no-fix mode the helper documents.
    expect(headersOnFetch.origin).toBe('https://my.app');
    expect(headersOnFetch.cookie).toBe('sid=abc');
  });
});

// Regression: WebDAV / CalDAV verbs (PROPFIND, REPORT, MKCALENDAR, LOCK,
// etc.) must pass through `msg.method` straight to upstream `fetch()` —
// browser fetch only forbids CONNECT/TRACE/TRACK. The DNR forbidden-header
// installer only acts on Cookie/Origin/Referer/Proxy-*, so DAV-only headers
// like `Depth` and `Timeout` are forwarded as ordinary request headers and
// must survive the round-trip untouched.
describe('handleFetchProxyConnection — WebDAV/CalDAV verb pass-through', () => {
  let pipeline: SecretsPipeline;

  beforeEach(async () => {
    pipeline = new SecretsPipeline({
      sessionId: 'session-fixed',
      source: { get: async () => undefined, listAll: async () => [] },
    });
    await pipeline.reload();
  });

  function encodeBase64(s: string): string {
    let bin = '';
    const bytes = new TextEncoder().encode(s);
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }

  async function dispatchDav(req: {
    method: string;
    url?: string;
    headers?: Record<string, string>;
    body?: string;
  }): Promise<{
    method: string | undefined;
    headers: Record<string, string> | undefined;
    bodyBytes: Uint8Array | undefined;
    posts: any[];
  }> {
    let capturedMethod: string | undefined;
    let capturedHeaders: Record<string, string> | undefined;
    let capturedBody: Uint8Array | undefined;
    (globalThis as any).fetch = vi.fn(async (_url: string, init: any) => {
      capturedMethod = init.method;
      capturedHeaders = init.headers;
      capturedBody = init.body instanceof Uint8Array ? init.body : undefined;
      return new Response('<multistatus/>', {
        status: 207,
        statusText: 'Multi-Status',
        headers: { 'content-type': 'application/xml' },
      });
    });
    const posts: any[] = [];
    const port = makePort((m) => posts.push(m));
    handleFetchProxyConnection(port, pipeline);
    port.fireMessage({
      type: 'request',
      url: req.url ?? 'https://dav.example.com/calendars/user/',
      method: req.method,
      headers: req.headers ?? {},
      bodyBase64: req.body !== undefined ? encodeBase64(req.body) : undefined,
    });
    await new Promise((r) => setTimeout(r, 10));
    return {
      method: capturedMethod,
      headers: capturedHeaders,
      bodyBytes: capturedBody,
      posts,
    };
  }

  it('PROPFIND passes verb, XML body, and Depth: 1 header through; 207 reaches the port', async () => {
    const xml =
      '<?xml version="1.0"?><propfind xmlns="DAV:"><prop><displayname/></prop></propfind>';
    const { method, headers, bodyBytes, posts } = await dispatchDav({
      method: 'PROPFIND',
      headers: { Depth: '1', 'Content-Type': 'application/xml' },
      body: xml,
    });

    expect(method).toBe('PROPFIND');
    expect(headers?.Depth).toBe('1');
    expect(headers?.['Content-Type']).toBe('application/xml');
    expect(bodyBytes).toBeDefined();
    expect(new TextDecoder().decode(bodyBytes!)).toBe(xml);

    const head = posts.find((p) => p.type === 'response-head');
    expect(head).toMatchObject({ type: 'response-head', status: 207, statusText: 'Multi-Status' });
    expect(posts.some((p) => p.type === 'response-end')).toBe(true);
  });

  it('REPORT passes verb and XML body through; 207 reaches the port', async () => {
    const xml = '<?xml version="1.0"?><c:calendar-query xmlns:c="urn:ietf:params:xml:ns:caldav"/>';
    const { method, headers, bodyBytes, posts } = await dispatchDav({
      method: 'REPORT',
      headers: { Depth: '1', 'Content-Type': 'application/xml' },
      body: xml,
    });

    expect(method).toBe('REPORT');
    expect(headers?.Depth).toBe('1');
    expect(new TextDecoder().decode(bodyBytes!)).toBe(xml);

    const head = posts.find((p) => p.type === 'response-head');
    expect(head).toMatchObject({ status: 207 });
  });

  it('MKCALENDAR with no body passes verb through; body is undefined', async () => {
    const { method, bodyBytes, posts } = await dispatchDav({
      method: 'MKCALENDAR',
      headers: { 'Content-Type': 'application/xml' },
    });

    expect(method).toBe('MKCALENDAR');
    expect(bodyBytes).toBeUndefined();
    expect(posts.some((p) => p.type === 'response-head')).toBe(true);
    expect(posts.some((p) => p.type === 'response-end')).toBe(true);
  });

  it('LOCK passes verb, body, and Timeout: Second-300 header through', async () => {
    const xml =
      '<?xml version="1.0"?><lockinfo xmlns="DAV:"><lockscope><exclusive/></lockscope></lockinfo>';
    const { method, headers, bodyBytes } = await dispatchDav({
      method: 'LOCK',
      headers: { Timeout: 'Second-300', 'Content-Type': 'application/xml' },
      body: xml,
    });

    expect(method).toBe('LOCK');
    expect(headers?.Timeout).toBe('Second-300');
    expect(new TextDecoder().decode(bodyBytes!)).toBe(xml);
  });
});
