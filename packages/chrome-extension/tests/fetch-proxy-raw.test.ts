/**
 * Raw mode of the `fetch-proxy.fetch` Port (#3571), driven through the real
 * Port dispatcher with a fake Port, a fake `webRequest` capture, a stubbed
 * `fetch`, and a real `SecretsPipeline`.
 */
import { createHmac } from 'node:crypto';
import {
  base64ToUint8,
  type RawPortResponseMsg,
  SecretsPipeline,
  uint8ToBase64,
} from '@slicc/shared-ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type RawFetchDeps, rawSessionStarter } from '../src/fetch-proxy-raw.js';
import { handleFetchProxyConnectionAsync, type PortLike } from '../src/fetch-proxy-shared.js';
import { type CapturedHead, createRawFetchCapture } from '../src/raw-fetch-capture.js';

const REAL = 'ghp_rawrealtoken0123456789';
const HMAC_KEY = 'hook-signing-key-0123456789';

type Posted = RawPortResponseMsg;

function makePort() {
  const listeners: ((msg: unknown) => void)[] = [];
  const disconnects: (() => void)[] = [];
  const posts: Posted[] = [];
  const port: PortLike = {
    onMessage: { addListener: (fn) => listeners.push(fn) },
    onDisconnect: { addListener: (fn) => disconnects.push(fn) },
    postMessage: (m) => posts.push(m as Posted),
  };
  return {
    port,
    posts,
    send: (m: unknown) => {
      for (const l of listeners) l(m);
    },
    disconnect: () => {
      for (const d of disconnects) d();
    },
  };
}

const settle = () => new Promise((r) => setTimeout(r, 15));

/** A fetch stub that records its calls and feeds the capture like Chrome would. */
function stubFetch(
  capture: ReturnType<typeof createRawFetchCapture>,
  respond: (url: string, init: RequestInit) => Promise<Response> | Response,
  head?: (url: string) => CapturedHead | null
) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    const captured = head?.(url);
    if (captured) {
      capture.onHeadersReceived({
        url,
        statusCode: captured.status,
        statusLine: `HTTP/1.1 ${captured.status} ${captured.statusText}`,
        responseHeaders: captured.headers.map(([name, value]) => ({ name, value })),
      });
    }
    return respond(url, init);
  });
  return { calls, impl: impl as unknown as typeof fetch };
}

function opaqueRedirect(): Response {
  const resp = new Response(null, { status: 200 });
  Object.defineProperty(resp, 'type', { value: 'opaqueredirect' });
  Object.defineProperty(resp, 'status', { value: 0 });
  return resp;
}

describe('raw fetch-proxy Port', () => {
  let pipeline: SecretsPipeline;
  let masked: string;
  let capture: ReturnType<typeof createRawFetchCapture>;

  beforeEach(async () => {
    pipeline = new SecretsPipeline({
      sessionId: 'raw-session',
      source: {
        get: async (name) => (name === 'HOOK_KEY' ? HMAC_KEY : undefined),
        listAll: async () => [
          { name: 'GITHUB_TOKEN', value: REAL, domains: ['api.github.com'] },
          { name: 'HOOK_KEY', value: HMAC_KEY, domains: ['hooks.example.com'] },
        ],
      },
    });
    await pipeline.reload();
    masked = await pipeline.maskOne('GITHUB_TOKEN', REAL);
    capture = createRawFetchCapture();
  });
  afterEach(() => vi.unstubAllGlobals());

  function open(deps: Partial<RawFetchDeps>) {
    const p = makePort();
    const full: RawFetchDeps = { capture, supportsRequestStreams: () => true, ...deps };
    const pipelinePromise = Promise.resolve(pipeline);
    handleFetchProxyConnectionAsync(
      p.port,
      pipelinePromise,
      rawSessionStarter(p.port, pipelinePromise, full)
    );
    return p;
  }

  it('returns a manual 3xx with its captured head, scrubbing Location', async () => {
    const f = stubFetch(
      capture,
      () => opaqueRedirect(),
      () => ({
        status: 302,
        statusText: 'Found',
        headers: [
          ['Location', `https://api.github.com/cb?t=${REAL}`],
          ['Set-Cookie', 'a=1'],
          ['Set-Cookie', 'b=2'],
          ['Transfer-Encoding', 'chunked'],
        ],
      })
    );
    const p = open({ fetchImpl: f.impl });
    p.send({
      type: 'raw-request',
      head: {
        url: 'https://api.github.com/login',
        method: 'GET',
        headers: [
          ['Authorization', `Bearer ${masked}`],
          ['User-Agent', 'curl/8.22.0'],
        ],
      },
      hasBody: false,
      credits: 4,
    });
    await settle();

    const [call] = f.calls;
    expect(call?.url).toMatch(/^https:\/\/api\.github\.com\/login#slicc-raw-/);
    expect(call?.init).toMatchObject({ redirect: 'manual', credentials: 'omit', method: 'GET' });
    expect((call?.init.headers as Record<string, string>).authorization).toBe(`Bearer ${REAL}`);
    expect(p.posts).toEqual([
      {
        type: 'raw-response-head',
        head: {
          status: 302,
          statusText: 'Found',
          url: 'https://api.github.com/login',
          headers: [
            ['Location', `https://api.github.com/cb?t=${masked}`],
            ['Set-Cookie', 'a=1'],
            ['Set-Cookie', 'b=2'],
          ],
        },
        hasBody: false,
      },
      { type: 'raw-response-end' },
    ]);
  });

  it('fails a redirect whose head was never observed', async () => {
    const f = stubFetch(capture, () => opaqueRedirect());
    const p = open({ fetchImpl: f.impl });
    vi.useFakeTimers();
    p.send({
      type: 'raw-request',
      head: { url: 'https://example.com/r', method: 'GET', headers: [] },
      hasBody: false,
      credits: 4,
    });
    await vi.advanceTimersByTimeAsync(6000);
    vi.useRealTimers();
    expect(p.posts).toEqual([
      expect.objectContaining({ type: 'raw-response-error', code: 'upstream', status: 502 }),
    ]);
  });

  it('streams the body one chunk per credit, decoded coding headers dropped', async () => {
    const chunks = [new Uint8Array([1]), new Uint8Array([2]), new Uint8Array([3])];
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        const next = chunks.shift();
        if (next) c.enqueue(next);
        else c.close();
      },
    });
    const f = stubFetch(
      capture,
      () => new Response(body, { status: 200 }),
      () => ({
        status: 200,
        statusText: 'OK',
        headers: [
          ['Content-Type', 'application/octet-stream'],
          ['Content-Encoding', 'zstd'],
          ['Content-Length', '9'],
        ],
      })
    );
    const p = open({ fetchImpl: f.impl });
    p.send({
      type: 'raw-request',
      head: { url: 'https://example.com/bin', method: 'GET', headers: [] },
      hasBody: false,
      credits: 1,
    });
    await settle();
    expect(p.posts[0]).toMatchObject({
      type: 'raw-response-head',
      head: { headers: [['Content-Type', 'application/octet-stream']] },
      hasBody: true,
    });
    const chunkPosts = () => p.posts.filter((m) => m.type === 'raw-response-chunk');
    expect(chunkPosts()).toHaveLength(1);
    p.send({ type: 'raw-credit', chunks: 1 });
    await settle();
    expect(chunkPosts()).toHaveLength(2);
    p.send({ type: 'raw-credit', chunks: 5 });
    await settle();
    const bytes = chunkPosts().map((m) => [
      ...base64ToUint8((m as { dataBase64: string }).dataBase64),
    ]);
    expect(bytes).toEqual([[1], [2], [3]]);
    expect(p.posts.at(-1)).toEqual({ type: 'raw-response-end' });
  });

  it('falls back to the fetch headers when no head was captured, scrubbing text bodies', async () => {
    const f = stubFetch(
      capture,
      () => new Response(`echo ${REAL}`, { status: 200, headers: { 'Content-Type': 'text/plain' } })
    );
    const p = open({ fetchImpl: f.impl });
    p.send({
      type: 'raw-request',
      head: { url: 'https://api.github.com/echo', method: 'GET', headers: [] },
      hasBody: false,
      credits: 4,
    });
    await new Promise((r) => setTimeout(r, 1200));
    expect(p.posts[0]).toMatchObject({
      type: 'raw-response-head',
      head: { status: 200, headers: [['content-type', 'text/plain']] },
    });
    const chunk = p.posts.find((m) => m.type === 'raw-response-chunk') as { dataBase64: string };
    expect(new TextDecoder().decode(base64ToUint8(chunk.dataBase64))).toBe(`echo ${masked}`);
  });

  it('refuses a 206 whose coding Chrome undid', async () => {
    const f = stubFetch(
      capture,
      () => new Response(new Uint8Array([1, 2, 3]), { status: 206 }),
      () => ({
        status: 206,
        statusText: 'Partial Content',
        headers: [
          ['Content-Encoding', 'zstd'],
          ['Content-Range', 'bytes 0-2/99'],
        ],
      })
    );
    const p = open({ fetchImpl: f.impl });
    p.send({
      type: 'raw-request',
      head: { url: 'https://example.com/file', method: 'GET', headers: [['Range', 'bytes=0-2']] },
      hasBody: false,
      credits: 4,
    });
    await settle();
    expect(p.posts).toEqual([
      expect.objectContaining({ type: 'raw-response-error', code: 'upstream', status: 502 }),
    ]);
  });

  it('matches a secret on the hostname, whatever the port', async () => {
    const f = stubFetch(capture, () => new Response('ok'));
    const p = open({ fetchImpl: f.impl });
    p.send({
      type: 'raw-request',
      head: {
        url: 'https://api.github.com:8443/login',
        method: 'GET',
        headers: [['Authorization', `Bearer ${masked}`]],
      },
      hasBody: false,
      credits: 4,
    });
    await new Promise((r) => setTimeout(r, 1200));
    expect(p.posts.some((m) => m.type === 'raw-response-error')).toBe(false);
    expect((f.calls[0]?.init.headers as Record<string, string>).authorization).toBe(
      `Bearer ${REAL}`
    );
  });

  it('refuses a secret on a foreign domain without fetching', async () => {
    const f = stubFetch(capture, () => new Response('nope'));
    const p = open({ fetchImpl: f.impl });
    p.send({
      type: 'raw-request',
      head: {
        url: 'https://evil.example/steal',
        method: 'GET',
        headers: [['Authorization', `Bearer ${masked}`]],
      },
      hasBody: false,
      credits: 4,
    });
    await settle();
    expect(f.calls).toHaveLength(0);
    expect(p.posts).toEqual([
      expect.objectContaining({
        type: 'raw-response-error',
        code: 'forbidden-secret',
        status: 403,
      }),
    ]);
  });

  it('buffers a text upload, unmasks it and signs it for HMAC', async () => {
    const f = stubFetch(
      capture,
      () => new Response(null, { status: 204 }),
      () => ({
        status: 204,
        statusText: 'No Content',
        headers: [],
      })
    );
    const p = open({ fetchImpl: f.impl });
    p.send({
      type: 'raw-request',
      head: {
        url: 'https://hooks.example.com/in',
        method: 'POST',
        headers: [
          ['Content-Type', 'application/json'],
          ['X-Slicc-Hmac-Sign', 'HOOK_KEY:x-signature'],
        ],
      },
      hasBody: true,
      credits: 4,
    });
    const body = '{"a":1}';
    p.send({
      type: 'raw-body-chunk',
      dataBase64: uint8ToBase64(new TextEncoder().encode(body.slice(0, 3))),
    });
    p.send({
      type: 'raw-body-chunk',
      dataBase64: uint8ToBase64(new TextEncoder().encode(body.slice(3))),
    });
    p.send({ type: 'raw-body-end' });
    await settle();
    expect(p.posts[0]).toEqual({ type: 'raw-body-credit', chunks: 4 });
    expect(p.posts.filter((m) => m.type === 'raw-body-credit')).toHaveLength(3);
    const init = f.calls[0]!.init;
    expect(await new Response(init.body).text()).toBe(body);
    const headers = init.headers as Record<string, string>;
    expect(headers['x-signature']).toBe(createHmac('sha256', HMAC_KEY).update(body).digest('hex'));
    expect(headers['x-slicc-hmac-sign']).toBeUndefined();
    expect((init as { duplex?: string }).duplex).toBeUndefined();
    expect(p.posts.at(-1)).toEqual({ type: 'raw-response-end' });
  });

  it('streams a large binary upload and retries once when Chrome refuses it unread', async () => {
    let attempts = 0;
    const f = stubFetch(
      capture,
      async (_url, init) => {
        attempts += 1;
        if (attempts === 1) throw new TypeError('Failed to fetch');
        return new Response(await new Response(init.body).arrayBuffer(), { status: 200 });
      },
      () => ({
        status: 200,
        statusText: 'OK',
        headers: [['Content-Type', 'application/octet-stream']],
      })
    );
    const p = open({ fetchImpl: f.impl });
    p.send({
      type: 'raw-request',
      head: {
        url: 'https://git.example.com/repo.git/git-receive-pack',
        method: 'POST',
        headers: [['Content-Type', 'application/x-git-receive-pack-request']],
      },
      hasBody: true,
      credits: 8,
    });
    for (const byte of [7, 8, 9]) {
      p.send({ type: 'raw-body-chunk', dataBase64: uint8ToBase64(new Uint8Array([byte])) });
    }
    p.send({ type: 'raw-body-end' });
    await settle();
    expect(attempts).toBe(2);
    expect((f.calls[1]!.init as { duplex?: string }).duplex).toBe('half');
    const echoed = p.posts
      .filter((m) => m.type === 'raw-response-chunk')
      .flatMap((m) => [...base64ToUint8((m as { dataBase64: string }).dataBase64)]);
    expect(echoed).toEqual([7, 8, 9]);
  });

  /** Open a streamed binary POST and feed it `bytes`, one chunk each. */
  function streamedPost(p: ReturnType<typeof makePort>, bytes: number[]) {
    p.send({
      type: 'raw-request',
      head: {
        url: 'https://git.example.com/repo.git/git-receive-pack',
        method: 'POST',
        headers: [['Content-Type', 'application/x-git-receive-pack-request']],
      },
      hasBody: true,
      credits: 8,
    });
    for (const byte of bytes) {
      p.send({ type: 'raw-body-chunk', dataBase64: uint8ToBase64(new Uint8Array([byte])) });
    }
    p.send({ type: 'raw-body-end' });
  }

  it('never replays an upload the failed attempt had started sending', async () => {
    let attempts = 0;
    const f = stubFetch(capture, async (_url, init) => {
      attempts += 1;
      const reader = (init.body as ReadableStream<Uint8Array>).getReader();
      await reader.read();
      throw new TypeError('network error after the body started');
    });
    const p = open({ fetchImpl: f.impl });
    streamedPost(p, [1, 2]);
    await settle();
    expect(attempts).toBe(1);
    expect(p.posts.at(-1)).toMatchObject({ type: 'raw-response-error', code: 'upstream' });
  });

  it('does not retry a refusal that is not the measured TypeError', async () => {
    let attempts = 0;
    const f = stubFetch(capture, async () => {
      attempts += 1;
      throw new Error('something else');
    });
    const p = open({ fetchImpl: f.impl });
    streamedPost(p, [3]);
    await settle();
    expect(attempts).toBe(1);
  });

  it('answers the capability probe', async () => {
    const p = open({});
    p.send({ type: 'raw-probe' });
    await settle();
    expect(p.posts).toEqual([
      {
        type: 'raw-probe-reply',
        reply: { rawFetch: 1, requestBodyStreaming: true, maxRequestBodyBytes: 256 * 1024 * 1024 },
      },
    ]);
  });

  it('restores forbidden headers and User-Agent through a DNR rule on the same tag', async () => {
    const updateSessionRules = vi.fn(async () => undefined);
    vi.stubGlobal('chrome', { declarativeNetRequest: { updateSessionRules } });
    const f = stubFetch(capture, () => new Response('ok'));
    const p = open({ fetchImpl: f.impl });
    p.send({
      type: 'raw-request',
      head: {
        url: 'https://example.com/x',
        method: 'GET',
        headers: [
          ['User-Agent', 'git/2.55.0'],
          ['Cookie', 'a=1'],
          ['X-Custom', 'kept'],
        ],
      },
      hasBody: false,
      credits: 4,
    });
    await new Promise((r) => setTimeout(r, 1200));
    const added = (updateSessionRules.mock.calls[0] as unknown as [{ addRules: any[] }])[0]
      .addRules[0];
    expect(added.condition.urlFilter).toBe(f.calls[0]!.url);
    expect(f.calls[0]!.url).toContain('#slicc-raw-');
    expect(added.action.requestHeaders).toEqual([
      { header: 'user-agent', operation: 'set', value: 'git/2.55.0' },
      { header: 'cookie', operation: 'set', value: 'a=1' },
    ]);
    expect(updateSessionRules).toHaveBeenCalledWith({ removeRuleIds: [added.id] });
  });

  it('stops relaying and cancels upstream when the page goes away', async () => {
    const cancelled = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        c.enqueue(new Uint8Array([1]));
      },
      cancel: cancelled,
    });
    const f = stubFetch(capture, (_url, init) => {
      init.signal?.addEventListener('abort', () => cancelled());
      return new Response(body);
    });
    const p = open({ fetchImpl: f.impl });
    p.send({
      type: 'raw-request',
      head: { url: 'https://example.com/endless', method: 'GET', headers: [] },
      hasBody: false,
      credits: 2,
    });
    await new Promise((r) => setTimeout(r, 1200));
    p.disconnect();
    await settle();
    expect(cancelled).toHaveBeenCalled();
    expect(p.posts.filter((m) => m.type === 'raw-response-chunk')).toHaveLength(2);
    expect(p.posts.some((m) => m.type === 'raw-response-error')).toBe(false);
  });

  it('answers unsupported when no raw starter is wired', async () => {
    const p = makePort();
    handleFetchProxyConnectionAsync(p.port, Promise.resolve(pipeline));
    p.send({
      type: 'raw-request',
      head: { url: 'https://example.com', method: 'GET', headers: [] },
      hasBody: false,
      credits: 1,
    });
    p.send({ type: 'raw-credit', chunks: 1 });
    await settle();
    expect(p.posts).toEqual([expect.objectContaining({ code: 'unsupported', status: 501 })]);
  });
});
