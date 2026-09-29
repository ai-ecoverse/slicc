/**
 * `createProxiedStreamingFetch({ mode: 'raw' })` (#3571): the realm HTTP
 * proxy's view of the node-server bridge. Covers the request envelope, frame
 * parsing across chunk boundaries, pull-driven backpressure, bodiless
 * responses, error mapping and the request-body ceiling.
 */
import {
  decodeRawRequestHead,
  encodeRawResponseFrame,
  RAW_FETCH_BRIDGE_REQUEST_BODY_CAP,
  RAW_FETCH_CONTENT_TYPE,
  type RawFetchResponseHead,
} from '@slicc/shared-ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setBridgeToken, setLocalApiBaseUrl } from '../../src/base/api-endpoint.js';
import {
  createProxiedStreamingFetch,
  getRawFetchCapabilities,
  RawFetchError,
  resetRawFetchCapabilities,
} from '../../src/shell/proxied-fetch.js';

const url = 'https://github.com/o/r.git/info/refs?service=git-upload-pack';

/** A text type forces the buffered path (the float unmasks secrets in it). */
const textType: [string, string][] = [['Content-Type', 'application/json']];

const redirectHead: RawFetchResponseHead = {
  status: 302,
  statusText: 'Found',
  url,
  headers: [
    ['location', 'https://example.com/next'],
    ['set-cookie', 'a=1'],
    ['set-cookie', 'b=2'],
  ],
};

/** A bridge body whose chunks are handed out only when pulled. */
function bridgeResponse(chunks: Uint8Array[], onPull?: () => void, onCancel?: () => void) {
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        onPull?.();
        const next = chunks.shift();
        if (next) controller.enqueue(next);
        else controller.close();
      },
      cancel() {
        onCancel?.();
      },
    },
    { highWaterMark: 0 }
  );
  return new Response(body, { headers: { 'content-type': RAW_FETCH_CONTENT_TYPE } });
}

function frameWith(head: RawFetchResponseHead, ...body: number[][]): Uint8Array[] {
  return [encodeRawResponseFrame(head), ...body.map((b) => new Uint8Array(b))];
}

function proxyError(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { 'X-Proxy-Error': '1', 'content-type': 'application/json' },
  });
}

async function drain(stream: ReadableStream<Uint8Array> | null): Promise<number[]> {
  const out: number[] = [];
  if (!stream) return out;
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return out;
    out.push(...value);
  }
}

const probeOk = () =>
  new Response(
    JSON.stringify({
      rawFetch: 1,
      requestBodyStreaming: true,
      maxRequestBodyBytes: RAW_FETCH_BRIDGE_REQUEST_BODY_CAP,
    }),
    { headers: { 'content-type': 'application/json' } }
  );

describe('raw proxied fetch — bridge floats (CLI, cloud)', () => {
  /** The raw requests; capability probes are answered by `probeReply`. */
  let fetchSpy: ReturnType<typeof vi.fn>;
  let probeReply: () => Promise<Response> | Response;
  let probes: number;

  beforeEach(async () => {
    setLocalApiBaseUrl('http://localhost:5710');
    setBridgeToken('bridge-token');
    await resetRawFetchCapabilities();
    fetchSpy = vi.fn();
    probes = 0;
    probeReply = probeOk;
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      if (headers['X-Slicc-Raw-Probe'] !== undefined) {
        probes += 1;
        return Promise.resolve().then(probeReply);
      }
      return (fetchSpy as unknown as typeof fetch)(input, init);
    });
  });
  afterEach(() => {
    setLocalApiBaseUrl(null);
    setBridgeToken(null);
    vi.unstubAllGlobals();
  });

  it('asks the bridge once what raw mode it supports', async () => {
    expect(await getRawFetchCapabilities()).toEqual({
      supported: true,
      requestBodyStreaming: true,
      maxRequestBodyBytes: RAW_FETCH_BRIDGE_REQUEST_BODY_CAP,
    });
    await getRawFetchCapabilities();
    expect(probes).toBe(1);
  });

  it.each([
    ['swift-server or an older node-server', () => proxyError(400, 'Missing X-Target-URL header')],
    ['a page with no bridge', () => new Response('not found', { status: 404 })],
    ['a bridge that answers something else', () => new Response('<html>', { status: 200 })],
  ])('reports and fails unsupported, without sending, for %s', async (_name, reply) => {
    probeReply = reply;
    expect((await getRawFetchCapabilities()).supported).toBe(false);
    await expect(createProxiedStreamingFetch({ mode: 'raw' })(url)).rejects.toMatchObject({
      code: 'unsupported',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(probes).toBe(1);
  });

  it('asks again after the bridge could not be reached', async () => {
    probeReply = () => Promise.reject(new TypeError('Failed to fetch'));
    expect((await getRawFetchCapabilities()).supported).toBe(false);
    probeReply = probeOk;
    expect((await getRawFetchCapabilities()).supported).toBe(true);
    expect(probes).toBe(2);
  });

  it('maps an unreachable bridge to a bridge RawFetchError', async () => {
    fetchSpy.mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(createProxiedStreamingFetch({ mode: 'raw' })(url)).rejects.toMatchObject({
      name: 'RawFetchError',
      code: 'bridge',
      status: 502,
    });
  });

  it('maps a response body that breaks after the head to an upstream RawFetchError', async () => {
    let sent = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sent) {
          sent = true;
          controller.enqueue(encodeRawResponseFrame({ ...redirectHead, status: 200 }));
        } else {
          controller.error(new TypeError('network error'));
        }
      },
    });
    fetchSpy.mockResolvedValue(
      new Response(body, { headers: { 'content-type': RAW_FETCH_CONTENT_TYPE } })
    );
    const resp = await createProxiedStreamingFetch({ mode: 'raw' })(url);
    await expect(drain(resp.body)).rejects.toMatchObject({ code: 'upstream', status: 502 });
  });

  it('stops buffering a stalled upload when the caller aborts, cancelling the source', async () => {
    const cancelled = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1]));
      },
      cancel: cancelled,
    });
    const controller = new AbortController();
    const pending = createProxiedStreamingFetch({ mode: 'raw' })(url, {
      method: 'PUT',
      headers: textType,
      body,
      signal: controller.signal,
    });
    await new Promise((r) => setTimeout(r, 10));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(cancelled).toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('posts the request head and body, and returns the 3xx with its headers', async () => {
    fetchSpy.mockResolvedValue(bridgeResponse(frameWith(redirectHead, [9, 8])));
    const rawFetch = createProxiedStreamingFetch({ mode: 'raw' });
    const resp = await rawFetch(url, {
      method: 'PUT',
      headers: [
        ['Cookie', 'a=1'],
        ['User-Agent', 'git/2.55.0'],
      ],
      body: new Uint8Array([0xff, 0x00]),
    });

    const [proxyUrl, init] = fetchSpy.mock.calls[0]!;
    expect(String(proxyUrl)).toBe('http://localhost:5710/api/fetch-proxy');
    expect(init.method).toBe('POST');
    expect(init.headers['X-Bridge-Token']).toBe('bridge-token');
    expect(init.headers['X-Slicc-Raw-Body']).toBe('1');
    expect(init.headers['X-Target-URL']).toBeUndefined();
    expect(decodeRawRequestHead(init.headers['X-Slicc-Raw-Request'])).toEqual({
      url,
      method: 'PUT',
      headers: [
        ['Cookie', 'a=1'],
        ['User-Agent', 'git/2.55.0'],
      ],
    });
    expect([...new Uint8Array(await (init.body as Blob).arrayBuffer())]).toEqual([0xff, 0x00]);

    expect(resp.status).toBe(302);
    expect(resp.headers).toEqual(redirectHead.headers);
    expect(await drain(resp.body)).toEqual([9, 8]);
  });

  it('reassembles a head split across chunks and keeps the bytes behind it', async () => {
    const frame = encodeRawResponseFrame({ ...redirectHead, status: 200 });
    const withBody = new Uint8Array([...frame, 1, 2]);
    fetchSpy.mockResolvedValue(
      bridgeResponse([withBody.subarray(0, 2), withBody.subarray(2, 10), withBody.subarray(10)])
    );
    const resp = await createProxiedStreamingFetch({ mode: 'raw' })(url);
    expect(resp.status).toBe(200);
    expect(await drain(resp.body)).toEqual([1, 2]);
  });

  it('reads from the bridge only as fast as the caller does', async () => {
    const pulls = vi.fn();
    const chunks = frameWith({ ...redirectHead, status: 200 }, [1], [2], [3]);
    fetchSpy.mockResolvedValue(bridgeResponse(chunks, pulls));
    const resp = await createProxiedStreamingFetch({ mode: 'raw' })(url);
    const pullsAfterHead = pulls.mock.calls.length;
    await new Promise((r) => setTimeout(r, 10));
    expect(pulls.mock.calls.length).toBe(pullsAfterHead);

    const reader = resp.body!.getReader();
    expect((await reader.read()).value).toEqual(new Uint8Array([1]));
    expect(pulls.mock.calls.length).toBe(pullsAfterHead + 1);
    await new Promise((r) => setTimeout(r, 10));
    expect(pulls.mock.calls.length).toBe(pullsAfterHead + 1);
  });

  it('cancelling the body cancels the bridge stream', async () => {
    const onCancel = vi.fn();
    fetchSpy.mockResolvedValue(
      bridgeResponse(frameWith({ ...redirectHead, status: 200 }, [1], [2]), undefined, onCancel)
    );
    const resp = await createProxiedStreamingFetch({ mode: 'raw' })(url);
    await resp.body!.cancel();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('has no body for HEAD and 304, and releases the bridge stream', async () => {
    const onCancel = vi.fn();
    fetchSpy.mockResolvedValue(
      bridgeResponse(frameWith({ ...redirectHead, status: 304 }), undefined, onCancel)
    );
    const resp = await createProxiedStreamingFetch({ mode: 'raw' })(url, { method: 'GET' });
    expect(resp.body).toBeNull();
    expect(onCancel).toHaveBeenCalledTimes(1);

    fetchSpy.mockResolvedValue(bridgeResponse(frameWith({ ...redirectHead, status: 200 })));
    const head = await createProxiedStreamingFetch({ mode: 'raw' })(url, { method: 'HEAD' });
    expect(head.body).toBeNull();
  });

  it.each([
    [413, 'too big', 'request-body-too-large', 413],
    [403, 'Secret "T" is not allowed', 'forbidden-secret', 403],
    [502, 'Proxy fetch failed: ECONNREFUSED', 'upstream', 502],
    [400, 'Missing X-Target-URL header', 'unsupported', 501],
    [400, 'Malformed X-Slicc-Raw-Request header', 'bridge', 502],
  ])('maps a bridge %i (%s) to %s', async (status, message, code, suggested) => {
    fetchSpy.mockResolvedValue(proxyError(status, message));
    const failure = createProxiedStreamingFetch({ mode: 'raw' })(url);
    await expect(failure).rejects.toBeInstanceOf(RawFetchError);
    await expect(failure).rejects.toMatchObject({ code, status: suggested });
  });

  it('refuses a bridge that answers the default way', async () => {
    fetchSpy.mockResolvedValue(
      new Response('<html>', { headers: { 'content-type': 'text/html' } })
    );
    await expect(createProxiedStreamingFetch({ mode: 'raw' })(url)).rejects.toMatchObject({
      code: 'unsupported',
    });
  });

  it('rejects a truncated or malformed head as a bridge error', async () => {
    const frame = encodeRawResponseFrame(redirectHead);
    fetchSpy.mockResolvedValue(bridgeResponse([frame.subarray(0, 6)]));
    await expect(createProxiedStreamingFetch({ mode: 'raw' })(url)).rejects.toMatchObject({
      code: 'bridge',
    });
    fetchSpy.mockResolvedValue(bridgeResponse([new Uint8Array([0, 0, 0, 1, 0x7b])]));
    await expect(createProxiedStreamingFetch({ mode: 'raw' })(url)).rejects.toMatchObject({
      code: 'bridge',
    });
  });

  it('refuses an upload past the ceiling before contacting the bridge', async () => {
    const chunk = new Uint8Array(16 * 1024 * 1024);
    let sent = 0;
    const onCancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += chunk.byteLength;
        controller.enqueue(chunk);
      },
      cancel: onCancel,
    });
    await expect(
      createProxiedStreamingFetch({ mode: 'raw' })(url, { method: 'PUT', headers: textType, body })
    ).rejects.toMatchObject({ code: 'request-body-too-large', status: 413 });
    expect(sent).toBeGreaterThan(RAW_FETCH_BRIDGE_REQUEST_BODY_CAP);
    expect(onCancel).toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();

    const oversized = { size: RAW_FETCH_BRIDGE_REQUEST_BODY_CAP + 1 } as Blob;
    Object.setPrototypeOf(oversized, Blob.prototype);
    await expect(
      createProxiedStreamingFetch({ mode: 'raw' })(url, {
        method: 'PUT',
        headers: textType,
        body: oversized,
      })
    ).rejects.toMatchObject({ code: 'request-body-too-large' });
  });

  it('buffers a streamed upload within the ceiling into one body', async () => {
    fetchSpy.mockResolvedValue(bridgeResponse(frameWith({ ...redirectHead, status: 201 })));
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.enqueue(new Uint8Array([3]));
        controller.close();
      },
    });
    await createProxiedStreamingFetch({ mode: 'raw' })(url, {
      method: 'POST',
      headers: textType,
      body,
    });
    const init = fetchSpy.mock.calls[0]![1];
    expect([...new Uint8Array(await (init.body as Blob).arrayBuffer())]).toEqual([1, 2, 3]);
    expect(init.duplex).toBeUndefined();
  });

  it('streams a binary upload of unknown length, replaying it once after a refusal', async () => {
    const received: number[][] = [];
    fetchSpy
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockImplementationOnce(async (_url: string, init: RequestInit) => {
        received.push([...new Uint8Array(await new Response(init.body).arrayBuffer())]);
        return bridgeResponse(frameWith({ ...redirectHead, status: 200 }));
      });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([7, 8]));
        controller.enqueue(new Uint8Array([9]));
        controller.close();
      },
    });
    const resp = await createProxiedStreamingFetch({ mode: 'raw' })(url, {
      method: 'POST',
      headers: [['Content-Type', 'application/x-git-receive-pack-request']],
      body,
    });
    expect(resp.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls[1]![1]).toMatchObject({ method: 'POST', duplex: 'half' });
    expect(received).toEqual([[7, 8, 9]]);
  });

  it('keeps small binary bodies buffered so the bridge sees their length', async () => {
    fetchSpy.mockResolvedValue(bridgeResponse(frameWith({ ...redirectHead, status: 200 })));
    await createProxiedStreamingFetch({ mode: 'raw' })(url, {
      method: 'PUT',
      body: new Uint8Array(1024),
    });
    const init = fetchSpy.mock.calls[0]![1];
    expect(init.body).toBeInstanceOf(Blob);
    expect(init.duplex).toBeUndefined();
  });

  it('leaves the default streaming mode on the X-Target-URL route', async () => {
    fetchSpy.mockResolvedValue(new Response('ok'));
    await createProxiedStreamingFetch()(url);
    expect(fetchSpy.mock.calls[0]![1].headers['X-Target-URL']).toBe(url);
  });
});
