/**
 * Response-body ceiling: every realm branch of `createProxiedFetch` refuses a
 * download over `getResponseBodyCap()` with a clear error — from the size
 * hint before anything is buffered, and again as bytes stream in when the
 * hint is absent or wrong. Large bodies under the ceiling still flow, but are
 * not parked in `binary-cache`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setLocalApiBaseUrl } from '../../src/base/api-endpoint.js';
import { consumeCachedBinaryByUrl } from '../../src/shell/binary-cache.js';
import {
  BINARY_CACHE_BODY_CAP,
  createProxiedFetch,
  type FetchProgressObserver,
  getResponseBodyCap,
  readResponseBody,
  setChromeExtensionRealm,
  setResponseBodyCap,
} from '../../src/shell/proxied-fetch.js';

const url = 'https://example.com/big.bin';

function streamResponse(
  chunks: Uint8Array[],
  headers: Record<string, string>,
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
  return new Response(body, { status: 200, headers });
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

describe('response body cap — CLI path', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    setLocalApiBaseUrl('http://localhost:5710');
    setResponseBodyCap(16);
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });
  afterEach(() => {
    setResponseBodyCap(null);
    setLocalApiBaseUrl(null);
    vi.unstubAllGlobals();
  });

  it('defaults to 512 MiB and the setter round-trips', () => {
    expect(getResponseBodyCap()).toBe(16);
    setResponseBodyCap(null);
    expect(getResponseBodyCap()).toBe(512 * 1024 * 1024);
  });

  it('rejects from the proxy length hint before reading any body bytes', async () => {
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        controller.enqueue(new Uint8Array(8));
      },
    });
    fetchSpy.mockResolvedValue(
      new Response(body, {
        status: 200,
        headers: { 'content-type': 'application/octet-stream', 'x-proxy-content-length': '17' },
      })
    );
    const { calls, observer } = recorder();
    await expect(createProxiedFetch({ progress: observer })(url)).rejects.toThrow(
      /exceeds the 0 MiB download limit \(17 bytes\)/
    );
    // The overlay unit still opens and closes (end fires on every exit path).
    expect(calls.map((c) => c[0])).toEqual(['start', 'end']);
    // Only the stream-setup pull (if any) ran; nothing was accumulated.
    expect(pulled).toBeLessThanOrEqual(1);
  });

  it('rejects mid-stream and cancels the reader when there is no hint', async () => {
    const cancelled = vi.fn();
    fetchSpy.mockResolvedValue(
      streamResponse(
        [new Uint8Array(8), new Uint8Array(8), new Uint8Array(8), new Uint8Array(8)],
        { 'content-type': 'application/octet-stream' },
        cancelled
      )
    );
    const { calls, observer } = recorder();
    await expect(createProxiedFetch({ progress: observer })(url)).rejects.toThrow(
      /exceeds the 0 MiB download limit; download it in ranges/
    );
    expect(cancelled).toHaveBeenCalledTimes(1);
    // Two 8-byte chunks fit the 16-byte cap; the third trips it before it is reported.
    expect(calls).toEqual([
      ['start', url, undefined],
      ['chunk', url, 8, undefined],
      ['chunk', url, 16, undefined],
      ['end', url],
    ]);
  });

  it('enforces the cap without a progress observer too', async () => {
    fetchSpy.mockResolvedValue(
      streamResponse([new Uint8Array(10), new Uint8Array(10)], {
        'content-type': 'application/octet-stream',
      })
    );
    await expect(createProxiedFetch()(url)).rejects.toThrow(/download limit/);
  });

  it('passes a body exactly at the cap through intact', async () => {
    const payload = Uint8Array.from({ length: 16 }, (_, i) => 255 - i);
    fetchSpy.mockResolvedValue(
      streamResponse([payload.slice(0, 7), payload.slice(7)], {
        'content-type': 'application/octet-stream',
        'x-proxy-content-length': '16',
      })
    );
    const result = await createProxiedFetch()(url);
    expect(Array.from(result.body)).toEqual(Array.from(payload));
    expect(consumeCachedBinaryByUrl(url)).not.toBeNull();
  });
});

describe('response body cap — extension Port path', () => {
  type Listener = (m: unknown) => void;
  function mockPort() {
    const msgListeners: Listener[] = [];
    const discListeners: (() => void)[] = [];
    const port = {
      postMessage: vi.fn(),
      disconnect: vi.fn(),
      onMessage: { addListener: (fn: Listener) => msgListeners.push(fn) },
      onDisconnect: { addListener: (fn: () => void) => discListeners.push(fn) },
    };
    const emit = (m: unknown) => {
      for (const l of msgListeners) l(m);
    };
    return { port, emit, discListeners };
  }

  beforeEach(() => {
    setResponseBodyCap(16);
  });
  afterEach(() => {
    setResponseBodyCap(null);
    (globalThis as { chrome?: unknown }).chrome = undefined;
    // `getChromeExtensionRealm()` caches its answer per realm (#2276); force
    // a fresh read of the next block's stub instead of this one's.
    setChromeExtensionRealm(null);
  });

  it('rejects on the response-head content-length and disconnects the Port', async () => {
    const { port, emit } = mockPort();
    (globalThis as { chrome?: unknown }).chrome = {
      runtime: { connect: vi.fn(() => port), id: 'test-id' },
    };
    setChromeExtensionRealm(true);
    const { calls, observer } = recorder();
    const pending = createProxiedFetch({ progress: observer })(url);
    await new Promise((r) => setTimeout(r, 0));
    emit({
      type: 'response-head',
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'application/octet-stream', 'content-length': '4096' },
    });
    await expect(pending).rejects.toThrow(/download limit \(4096 bytes\)/);
    expect(port.disconnect).toHaveBeenCalledTimes(1);
    // Never started a unit for a transfer that was refused up front.
    expect(calls).toEqual([['end', url]]);
  });

  it('rejects once the streamed chunks pass the cap, ignoring later messages', async () => {
    const { port, emit, discListeners } = mockPort();
    (globalThis as { chrome?: unknown }).chrome = {
      runtime: { connect: vi.fn(() => port), id: 'test-id' },
    };
    setChromeExtensionRealm(true);
    const pending = createProxiedFetch()(url);
    await new Promise((r) => setTimeout(r, 0));
    emit({
      type: 'response-head',
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'application/octet-stream' },
    });
    const eight = btoa(String.fromCharCode(...new Uint8Array(8)));
    emit({ type: 'response-chunk', dataBase64: eight });
    emit({ type: 'response-chunk', dataBase64: eight });
    emit({ type: 'response-chunk', dataBase64: eight });
    // Late traffic from the SW and our own disconnect must not re-settle.
    emit({ type: 'response-chunk', dataBase64: eight });
    emit({ type: 'response-end' });
    for (const l of discListeners) l();
    await expect(pending).rejects.toThrow(/download limit; download it in ranges/);
    expect(port.disconnect).toHaveBeenCalledTimes(1);
  });
});

describe('binary-cache ceiling', () => {
  it('parks binary bodies up to the ceiling and skips larger ones', async () => {
    const small = new Response(new Uint8Array(64), {
      headers: { 'content-type': 'application/octet-stream' },
    });
    await readResponseBody(small, 'https://example.com/small.bin');
    expect(consumeCachedBinaryByUrl('https://example.com/small.bin')).not.toBeNull();

    const big = new Response(new Uint8Array(BINARY_CACHE_BODY_CAP + 1), {
      headers: { 'content-type': 'application/octet-stream' },
    });
    const bytes = await readResponseBody(big, 'https://example.com/large.bin');
    expect(bytes.byteLength).toBe(BINARY_CACHE_BODY_CAP + 1);
    expect(consumeCachedBinaryByUrl('https://example.com/large.bin')).toBeNull();
  });
});
