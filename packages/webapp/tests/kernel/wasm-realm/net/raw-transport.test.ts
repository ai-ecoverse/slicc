import { describe, expect, it, vi } from 'vitest';
import { RealmProxy } from '../../../../src/kernel/wasm-realm/net/proxy-service.js';
import {
  rawFetchTransport,
  realmFetchTransport,
} from '../../../../src/kernel/wasm-realm/net/raw-transport.js';
import type { RealmTransport } from '../../../../src/kernel/wasm-realm/net/transport.js';
import { LoopbackNet } from '../../../../src/kernel/wasm-realm/socket.js';
import {
  type RawFetchCapabilities,
  RawFetchError,
  type RawProxiedFetch,
} from '../../../../src/shell/proxied-fetch.js';
import { Client, enc, reply, text } from './proxy-helpers.js';

const CAPS: RawFetchCapabilities = {
  supported: true,
  requestBodyStreaming: false,
  maxRequestBodyBytes: 1234,
};

const request = (over: Partial<Parameters<RealmTransport['fetch']>[0]> = {}) => ({
  url: 'http://h.test/a',
  method: 'GET',
  headers: [
    ['Accept', '*/*'],
    ['Cookie', 'a=1'],
    ['Cookie', 'b=2'],
  ] as const,
  signal: new AbortController().signal,
  ...over,
});

function stream(...chunks: string[]): ReadableStream<Uint8Array> & { cancelled: () => boolean } {
  let cancelled = false;
  let i = 0;
  const s = new ReadableStream<Uint8Array>(
    {
      pull(c) {
        if (i < chunks.length) c.enqueue(enc(chunks[i++]));
        else c.close();
      },
      cancel() {
        cancelled = true;
      },
    },
    { highWaterMark: 0 }
  );
  return Object.assign(s, { cancelled: () => cancelled });
}

async function drain(body: AsyncIterable<Uint8Array>): Promise<string> {
  let out = '';
  for await (const piece of body) out += text(piece);
  return out;
}

describe('rawFetchTransport', () => {
  it('passes the request and the response through as lists, with a pulled body', async () => {
    const raw = vi.fn<RawProxiedFetch>(async () => ({
      status: 301,
      statusText: 'Moved Permanently',
      url: 'http://h.test/a',
      headers: [
        ['Location', '/b'],
        ['Set-Cookie', 'a=1'],
        ['Set-Cookie', 'b=2'],
      ],
      body: stream('mo', 'ved'),
    }));
    const t = rawFetchTransport(raw, CAPS);
    expect(t.traits).toEqual({ manualRedirects: true, encodedBodies: true, maxRequestBody: 1234 });
    const res = await t.fetch(request({ method: 'POST', body: enc('x') }));
    const [url, init] = raw.mock.calls[0];
    expect(url).toBe('http://h.test/a');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toEqual([
      ['Accept', '*/*'],
      ['Cookie', 'a=1'],
      ['Cookie', 'b=2'],
    ]);
    expect(text(init?.body as Uint8Array)).toBe('x');
    expect(res.status).toBe(301);
    expect(res.headers).toEqual([
      ['Location', '/b'],
      ['Set-Cookie', 'a=1'],
      ['Set-Cookie', 'b=2'],
    ]);
    expect(await drain(res.body)).toBe('moved');
  });

  it('sends no body for an empty one, and has none for a bodiless response', async () => {
    const raw = vi.fn<RawProxiedFetch>(async () => ({
      status: 204,
      statusText: '',
      url: 'u',
      headers: [],
      body: null,
    }));
    const res = await rawFetchTransport(raw, CAPS).fetch(request({ body: new Uint8Array(0) }));
    expect(raw.mock.calls[0][1]).not.toHaveProperty('body');
    expect(await drain(res.body)).toBe('');
    await res.cancel();
  });

  it('cancels the stream when the proxy drops the body', async () => {
    const body = stream('a', 'b', 'c');
    const raw: RawProxiedFetch = async () => ({
      status: 200,
      statusText: '',
      url: 'u',
      headers: [],
      body,
    });
    const res = await rawFetchTransport(raw, CAPS).fetch(request());
    await res.cancel();
    expect(body.cancelled()).toBe(true);
  });
});

describe('realmFetchTransport', () => {
  const fallback = (): RealmTransport & { calls: number } => {
    const t = {
      calls: 0,
      traits: { manualRedirects: false, encodedBodies: false, maxRequestBody: 32 },
      fetch: async () => {
        t.calls++;
        return reply(200, [], 'fallback');
      },
    };
    return t;
  };

  it('uses the fallback where the float has no raw mode', async () => {
    const fb = fallback();
    const raw = vi.fn<RawProxiedFetch>();
    const t = realmFetchTransport({
      capabilities: () => ({ ...CAPS, supported: false }),
      raw: () => raw,
      fallback: () => fb,
    });
    expect(t.traits.manualRedirects).toBe(false);
    expect(await drain((await t.fetch(request())).body)).toBe('fallback');
    expect(raw).not.toHaveBeenCalled();
  });

  it('switches to the fallback for good when a bridge answers unsupported', async () => {
    const fb = fallback();
    const raw = vi.fn<RawProxiedFetch>(async () => {
      throw new RawFetchError(
        'unsupported',
        501,
        'raw fetch: this bridge does not support raw mode'
      );
    });
    const t = realmFetchTransport({
      capabilities: async () => CAPS,
      raw: () => raw,
      fallback: () => fb,
    });

    expect(t.traits.manualRedirects).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(t.traits.manualRedirects).toBe(true);
    expect(await drain((await t.fetch(request())).body)).toBe('fallback');
    await t.fetch(request());
    expect(raw).toHaveBeenCalledTimes(1);
    expect(fb.calls).toBe(2);
    expect(t.traits.manualRedirects).toBe(false);
  });

  it('uses the fallback when asking the float fails', async () => {
    const fb = fallback();
    const raw = vi.fn<RawProxiedFetch>();
    const t = realmFetchTransport({
      capabilities: async () => {
        throw new Error('bridge down');
      },
      raw: () => raw,
      fallback: () => fb,
    });
    expect(await drain((await t.fetch(request())).body)).toBe('fallback');
    expect(raw).not.toHaveBeenCalled();
  });

  it('lets any other raw failure through, with its status', async () => {
    const fb = fallback();
    const t = realmFetchTransport({
      capabilities: () => CAPS,
      raw: () => async () => {
        throw new RawFetchError('request-body-too-large', 413, 'too large');
      },
      fallback: () => fb,
    });
    await expect(t.fetch(request())).rejects.toMatchObject({ status: 413 });
    expect(fb.calls).toBe(0);
  });
});

describe('raw mode through the proxy', () => {
  it('keeps a coding raw mode left in place and a HEAD’s length', async () => {
    const raw: RawProxiedFetch = async (_url, init) =>
      init?.method === 'HEAD'
        ? {
            status: 200,
            statusText: 'OK',
            url: 'u',
            headers: [['Content-Length', '42']],
            body: null,
          }
        : {
            status: 200,
            statusText: 'OK',
            url: 'u',
            headers: [
              ['Content-Encoding', 'zstd'],
              ['Content-Length', '5'],
            ],
            body: stream('zst!!'),
          };
    const net = new LoopbackNet();
    const proxy = new RealmProxy({ net, transport: rawFetchTransport(raw, CAPS) });
    try {
      const c = Client.open(net, proxy.port);
      await c.send('GET http://h.test/z HTTP/1.1\r\n\r\n');
      const coded = await c.response();
      expect(coded.header('content-encoding')).toBe('zstd');
      expect(coded.body).toBe('zst!!');
      await c.send('HEAD http://h.test/z HTTP/1.1\r\n\r\n');
      expect((await c.response({ head: true })).header('content-length')).toBe('42');
      c.close();
    } finally {
      proxy.close();
      await proxy.closed;
    }
  });
});
