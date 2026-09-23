/**
 * `createProxiedStreamingFetch` hands the `/api/fetch-proxy` body over chunk
 * by chunk (so `hf download` can write weights without buffering whole
 * files, #3441), past the buffered path's response-body ceiling, and fires
 * the progress observer's `end` exactly once however the body is consumed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setExtensionDelegateId, setLocalApiBaseUrl } from '../../src/base/api-endpoint.js';
import {
  createProxiedStreamingFetch,
  type FetchProgressObserver,
  setChromeExtensionRealm,
  setResponseBodyCap,
} from '../../src/shell/proxied-fetch.js';

const url = 'https://huggingface.co/o/r/resolve/main/model.bin';

function streamResponse(
  chunks: Uint8Array[],
  init: { status?: number; headers?: Record<string, string> } = {},
  onCancel?: () => void
): Response {
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = chunks.shift();
      if (next) controller.enqueue(next);
      else controller.close();
    },
    cancel() {
      onCancel?.();
    },
  });
  return new Response(body, { status: init.status ?? 200, headers: init.headers });
}

function recorder() {
  const calls: Array<[string, ...unknown[]]> = [];
  const observer: FetchProgressObserver = {
    start: (u, total) => calls.push(['start', u, total]),
    chunk: (u, loaded, total) => calls.push(['chunk', u, loaded, total]),
    end: (u) => calls.push(['end', u]),
  };
  return { calls, observer };
}

describe('createProxiedStreamingFetch — CLI path', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    setLocalApiBaseUrl('http://localhost:5710');
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });
  afterEach(() => {
    setResponseBodyCap(null);
    setLocalApiBaseUrl(null);
    vi.unstubAllGlobals();
  });

  it('yields chunks as they arrive, beyond the buffered body cap', async () => {
    setResponseBodyCap(4);
    fetchSpy.mockResolvedValue(
      streamResponse([new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6])], {
        headers: { 'x-proxy-content-length': '6', 'x-proxy-www-authenticate': 'Bearer' },
      })
    );
    const { calls, observer } = recorder();
    const resp = await createProxiedStreamingFetch({ progress: observer })(url, {
      method: 'GET',
      headers: { Cookie: 'a=b' },
    });
    const [proxyUrl, init] = fetchSpy.mock.calls[0];
    expect(String(proxyUrl)).toBe('http://localhost:5710/api/fetch-proxy');
    expect(init.headers).toMatchObject({ 'X-Target-URL': url, 'X-Proxy-Cookie': 'a=b' });
    expect(resp).toMatchObject({ status: 200, contentLength: 6, url });
    expect(resp.headers['www-authenticate']).toBe('Bearer');

    const seen: number[][] = [];
    for await (const chunk of resp.body) seen.push([...chunk]);
    expect(seen).toEqual([
      [1, 2, 3],
      [4, 5, 6],
    ]);
    expect(calls).toEqual([
      ['start', url, 6],
      ['chunk', url, 3, 6],
      ['chunk', url, 6, 6],
      ['end', url],
    ]);
  });

  it('cancels the upstream body when the reader stops early', async () => {
    const onCancel = vi.fn();
    fetchSpy.mockResolvedValue(
      streamResponse([new Uint8Array(2), new Uint8Array(2), new Uint8Array(2)], {}, onCancel)
    );
    const { calls, observer } = recorder();
    const resp = await createProxiedStreamingFetch({ progress: observer })(url);
    for await (const _chunk of resp.body) break;
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(calls.filter(([k]) => k === 'end')).toHaveLength(1);
  });

  it('cancel() drops an unread body and ends progress once', async () => {
    const onCancel = vi.fn();
    fetchSpy.mockResolvedValue(streamResponse([new Uint8Array(2)], { status: 404 }, onCancel));
    const { calls, observer } = recorder();
    const resp = await createProxiedStreamingFetch({ progress: observer })(url);
    expect(resp.status).toBe(404);
    await resp.cancel();
    await resp.cancel();
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(calls.filter(([k]) => k === 'end')).toHaveLength(1);
  });

  it('yields nothing for a null-body status', async () => {
    fetchSpy.mockResolvedValue(new Response(null, { status: 204 }));
    const { calls, observer } = recorder();
    const resp = await createProxiedStreamingFetch({ progress: observer })(url);
    const chunks: Uint8Array[] = [];
    for await (const chunk of resp.body) chunks.push(chunk);
    expect(chunks).toEqual([]);
    expect(calls.filter(([k]) => k === 'end')).toHaveLength(1);
  });

  it('surfaces a proxy infrastructure error', async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ error: 'upstream unreachable' }), {
        status: 502,
        headers: { 'X-Proxy-Error': '1', 'content-type': 'application/json' },
      })
    );
    await expect(createProxiedStreamingFetch()(url)).rejects.toThrow(/upstream unreachable/);
  });
});

describe('createProxiedStreamingFetch — extension realms', () => {
  afterEach(() => {
    setChromeExtensionRealm(null);
    setExtensionDelegateId(null);
    vi.unstubAllGlobals();
  });

  it('falls back to the buffered fetch and yields the body as one chunk', async () => {
    setExtensionDelegateId('ext-id');
    const call = vi.fn().mockResolvedValue({
      head: {
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'application/octet-stream' },
      },
      body: new Uint8Array([7, 8, 9]).buffer,
    });
    vi.doMock('../../src/kernel/panel-rpc.js', () => ({
      getPanelRpcClient: () => ({ call }),
    }));
    const resp = await createProxiedStreamingFetch()(url);
    const chunks: number[][] = [];
    for await (const chunk of resp.body) chunks.push([...chunk]);
    expect(chunks).toEqual([[7, 8, 9]]);
    expect(resp.contentLength).toBe(3);
    await expect(resp.cancel()).resolves.toBeUndefined();
    expect(call).toHaveBeenCalledWith(
      'proxied-fetch',
      expect.objectContaining({ url, method: 'GET' }),
      expect.anything()
    );
    vi.doUnmock('../../src/kernel/panel-rpc.js');
  });
});
