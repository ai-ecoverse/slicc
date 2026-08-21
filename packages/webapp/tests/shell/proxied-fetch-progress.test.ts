/**
 * CLI-path download progress: `createProxiedFetch({ progress })` streams the
 * proxy response, reports cumulative bytes against the proxy's
 * `X-Proxy-Content-Length` hint, and always closes the unit.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setLocalApiBaseUrl } from '../../src/base/api-endpoint.js';
import { createProxiedFetch, type FetchProgressObserver } from '../../src/shell/proxied-fetch.js';

function streamResponse(chunks: string[], headers: Record<string, string>, status = 200): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
  return new Response(body, { status, headers });
}

function recorder() {
  const calls: Array<[string, ...unknown[]]> = [];
  const observer: FetchProgressObserver = {
    start: (url, total) => calls.push(['start', url, total]),
    chunk: (url, loaded, total) => calls.push(['chunk', url, loaded, total]),
    end: (url) => calls.push(['end', url]),
  };
  return { calls, observer };
}

describe('createProxiedFetch progress (CLI path)', () => {
  const url = 'https://example.com/file.bin';
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    setLocalApiBaseUrl('http://localhost:5710');
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('streams chunks and reports bytes against the proxy length hint', async () => {
    fetchSpy.mockResolvedValue(
      streamResponse(['hello ', 'world'], {
        'content-type': 'text/plain',
        'x-proxy-content-length': '11',
      })
    );
    const { calls, observer } = recorder();
    const result = await createProxiedFetch({ progress: observer })(url);
    expect(new TextDecoder().decode(result.body)).toBe('hello world');
    expect(calls).toEqual([
      ['start', url, 11],
      ['chunk', url, 6, 11],
      ['chunk', url, 11, 11],
      ['end', url],
    ]);
  });

  it('reports an unknown total when the hint is absent or malformed', async () => {
    fetchSpy.mockResolvedValue(
      streamResponse(['abc'], { 'content-type': 'text/plain', 'x-proxy-content-length': 'nope' })
    );
    const { calls, observer } = recorder();
    await createProxiedFetch({ progress: observer })(url);
    expect(calls[0]).toEqual(['start', url, undefined]);
    expect(calls[1]).toEqual(['chunk', url, 3, undefined]);
  });

  it('closes the unit when the proxy reports an error', async () => {
    fetchSpy.mockResolvedValue(
      new Response('upstream down', { status: 502, headers: { 'x-proxy-error': '1' } })
    );
    const { calls, observer } = recorder();
    await expect(createProxiedFetch({ progress: observer })(url)).rejects.toThrow();
    expect(calls).toEqual([['end', url]]);
  });

  it('reads the body in one shot when no observer is attached', async () => {
    const resp = streamResponse(['one'], { 'content-type': 'text/plain' });
    const arrayBuffer = vi.spyOn(resp, 'arrayBuffer');
    fetchSpy.mockResolvedValue(resp);
    const result = await createProxiedFetch()(url);
    expect(new TextDecoder().decode(result.body)).toBe('one');
    expect(arrayBuffer).toHaveBeenCalledTimes(1);
  });
});
