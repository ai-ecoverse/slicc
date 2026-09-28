import { describe, expect, it } from 'vitest';
import {
  type FetchPath,
  joinHeaders,
  proxiedFetchTransport,
  splitHeaders,
} from '../../../../src/kernel/wasm-realm/net/fetch-transport.js';
import { REQUEST_BODY_CAP } from '../../../../src/shell/proxied-fetch.js';

const enc = (s: string) => new TextEncoder().encode(s);

async function drain(body: AsyncIterable<Uint8Array>): Promise<string> {
  let out = '';
  for await (const piece of body) out += new TextDecoder().decode(piece);
  return out;
}

function recordingPath(): FetchPath & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    buffered: async (url, options) => {
      calls.push(`buffered ${options.method} ${url} ${JSON.stringify(options.headers)}`);
      return {
        status: 201,
        statusText: 'Created',
        headers: { 'content-type': 'text/plain', 'set-cookie': '["a=1","b=2; Path=/"]' },
        body: enc(`got ${new TextDecoder().decode(options.body as Uint8Array)}`),
        url,
      };
    },
    streaming: async (url, options) => {
      calls.push(`streaming ${options?.method} ${url}`);
      let cancelled = false;
      return {
        status: 302,
        statusText: 'Found',
        headers: {
          location: '/next',
          'access-control-expose-headers': 'location',
          'x-proxy-content-length': '4',
        },
        url,
        body: (async function* () {
          yield enc('mo');
          yield enc('ved');
        })(),
        cancel: async () => {
          cancelled = !cancelled;
        },
      };
    },
  };
}

describe('proxiedFetchTransport', () => {
  it('states what the fetch path delivers today', () => {
    expect(proxiedFetchTransport(recordingPath()).traits).toEqual({
      manualRedirects: false,
      encodedBodies: false,
      maxRequestBody: REQUEST_BODY_CAP,
    });
  });

  it('streams a request without a body and drops the route’s own fields', async () => {
    const path = recordingPath();
    const res = await proxiedFetchTransport(path).fetch({
      url: 'https://h.test/x',
      method: 'GET',
      headers: [['Accept', '*/*']],
      signal: new AbortController().signal,
    });
    expect(path.calls).toEqual(['streaming GET https://h.test/x']);
    expect(res.status).toBe(302);
    expect(res.headers).toEqual([['location', '/next']]);
    expect(await drain(res.body)).toBe('moved');
  });

  it('sends a body through the buffered path and splits the Set-Cookie array', async () => {
    const path = recordingPath();
    const res = await proxiedFetchTransport(path).fetch({
      url: 'https://h.test/up',
      method: 'POST',
      headers: [
        ['Content-Type', 'text/plain'],
        ['Cookie', 'a=1'],
        ['Cookie', 'b=2'],
      ],
      body: enc('data'),
      signal: new AbortController().signal,
    });
    expect(path.calls).toEqual([
      'buffered POST https://h.test/up {"content-type":"text/plain","cookie":"a=1; b=2"}',
    ]);
    expect(res.status).toBe(201);
    expect(res.headers).toEqual([
      ['content-type', 'text/plain'],
      ['set-cookie', 'a=1'],
      ['set-cookie', 'b=2; Path=/'],
    ]);
    expect(await drain(res.body)).toBe('got data');
  });
});

describe('header helpers', () => {
  it('joins repeated request fields as fetch sends them', () => {
    expect(
      joinHeaders([
        ['X-A', '1'],
        ['x-a', '2'],
        ['Cookie', 'c=1'],
        ['cookie', 'd=2'],
      ])
    ).toEqual({ 'x-a': '1, 2', cookie: 'c=1; d=2' });
  });

  it('keeps a Set-Cookie that is not the array encoding as one cookie', () => {
    expect(splitHeaders({ 'set-cookie': 'plain=1' })).toEqual([['set-cookie', 'plain=1']]);
    expect(splitHeaders({ 'Set-Cookie': '[not json' })).toEqual([['Set-Cookie', '[not json']]);
  });
});
