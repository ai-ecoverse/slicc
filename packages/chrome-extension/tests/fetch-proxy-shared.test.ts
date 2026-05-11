import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  handleFetchProxyConnection,
  handleFetchProxyConnectionAsync,
  type PortLike,
} from '../src/fetch-proxy-shared.js';
import { SecretsPipeline } from '@slicc/shared';

function makePort(
  onPost: (msg: unknown) => void
): PortLike & { fireMessage(msg: unknown): void; fireDisconnect(): void } {
  const listeners: ((msg: unknown) => void)[] = [];
  const disconnectListeners: (() => void)[] = [];
  return {
    onMessage: { addListener: (fn: (msg: unknown) => void) => listeners.push(fn) },
    onDisconnect: { addListener: (fn: () => void) => disconnectListeners.push(fn) },
    postMessage: onPost,
    fireMessage: (m: unknown) => listeners.forEach((l) => l(m)),
    fireDisconnect: () => disconnectListeners.forEach((l) => l()),
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
          { name: 'GITHUB_TOKEN', value: 'ghp_real', domains: ['api.github.com'] },
        ],
      },
    });
    await pipeline.reload();
    masked = await pipeline.maskOne('GITHUB_TOKEN', 'ghp_real');
  });

  it('streams a multi-chunk response back and ends with response-end', async () => {
    const chunks = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6])];
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        chunks.forEach((ch) => c.enqueue(ch));
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
    expect(JSON.stringify(posts)).not.toContain('ghp_real');
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
    expect(decoded).toBe('x-access-token:ghp_real');

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
