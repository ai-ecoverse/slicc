import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  handleFetchProxyConnection,
  type PortLike,
  REQUEST_BODY_CAP,
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
    fireMessage: (m) => listeners.forEach((l) => l(m)),
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
});
