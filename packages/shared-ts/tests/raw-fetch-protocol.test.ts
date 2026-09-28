import { describe, expect, it } from 'vitest';
import {
  decodeRawRequestHead,
  decodeRawResponseFrame,
  encodeRawRequestHead,
  encodeRawResponseFrame,
  foldRawRequestHeaders,
  RAW_FETCH_MAX_HEAD_BYTES,
  type RawFetchResponseHead,
  rawResponseHasBody,
  rawResponseHeaders,
  stripRawRequestHeaders,
} from '../src/raw-fetch-protocol.js';

const head: RawFetchResponseHead = {
  status: 302,
  statusText: 'Found',
  url: 'https://example.com/a',
  headers: [
    ['location', '/b'],
    ['set-cookie', 'a=1'],
    ['set-cookie', 'b=2; Path=/'],
  ],
};

describe('raw fetch request head', () => {
  it('round-trips and escapes non-ASCII into a valid header value', () => {
    const encoded = encodeRawRequestHead({
      url: 'https://example.com/ü',
      method: 'PUT',
      headers: [['x-name', 'Grüße 🍦']],
    });
    expect(/^[\x20-\x7e]*$/.test(encoded)).toBe(true);
    expect(decodeRawRequestHead(encoded)).toEqual({
      url: 'https://example.com/ü',
      method: 'PUT',
      headers: [['x-name', 'Grüße 🍦']],
    });
  });

  it('rejects malformed heads', () => {
    expect(decodeRawRequestHead('not json')).toBeNull();
    expect(decodeRawRequestHead('null')).toBeNull();
    expect(decodeRawRequestHead('{"url":"u","method":"G T","headers":[]}')).toBeNull();
    expect(decodeRawRequestHead('{"url":"u","method":"GET","headers":[["a"]]}')).toBeNull();
    expect(decodeRawRequestHead('{"url":1,"method":"GET","headers":[]}')).toBeNull();
    expect(decodeRawRequestHead('{"url":"u","method":"PROPFIND","headers":[]}')).not.toBeNull();
  });
});

describe('raw fetch response frame', () => {
  it('round-trips and leaves the body bytes after the frame', () => {
    const frame = encodeRawResponseFrame(head);
    const buffer = new Uint8Array(frame.byteLength + 3);
    buffer.set(frame);
    buffer.set([1, 2, 3], frame.byteLength);
    const split = decodeRawResponseFrame(buffer);
    expect(split?.head).toEqual(head);
    expect([...(split?.rest ?? [])]).toEqual([1, 2, 3]);
  });

  it('waits for an incomplete frame', () => {
    const frame = encodeRawResponseFrame(head);
    expect(decodeRawResponseFrame(frame.subarray(0, 2))).toBeNull();
    expect(decodeRawResponseFrame(frame.subarray(0, frame.byteLength - 1))).toBeNull();
  });

  it('throws on oversized or malformed frames', () => {
    const big = new Uint8Array(4);
    new DataView(big.buffer).setUint32(0, RAW_FETCH_MAX_HEAD_BYTES + 1);
    expect(() => decodeRawResponseFrame(big)).toThrow(/exceeds/);
    const junk = new Uint8Array([0, 0, 0, 2, 0x7b, 0x7d]);
    expect(() => decodeRawResponseFrame(junk)).toThrow(/malformed/);
    const notJson = new Uint8Array([0, 0, 0, 1, 0x7b]);
    expect(() => decodeRawResponseFrame(notJson)).toThrow(/malformed/);
  });
});

describe('raw request headers', () => {
  it('drops hop-by-hop, float-owned and Connection-named headers in order', () => {
    expect(
      stripRawRequestHeaders([
        ['Host', 'example.com'],
        ['Connection', 'keep-alive, X-Hop'],
        ['X-Hop', '1'],
        ['User-Agent', 'curl/8.22.0'],
        ['Accept-Encoding', 'zstd'],
        ['Content-Length', '3'],
        ['Expect', '100-continue'],
        ['Transfer-Encoding', 'chunked'],
        ['Accept', '*/*'],
      ])
    ).toEqual([
      ['User-Agent', 'curl/8.22.0'],
      ['Accept', '*/*'],
    ]);
  });

  it('folds repeats the way fetch does, Cookie with a semicolon', () => {
    expect(
      foldRawRequestHeaders([
        ['X-Repeat', 'a'],
        ['x-repeat', 'b'],
        ['Cookie', 'a=1'],
        ['cookie', 'b=2'],
      ])
    ).toEqual({ 'x-repeat': 'a, b', cookie: 'a=1; b=2' });
  });
});

describe('rawResponseHeaders', () => {
  const base: Array<[string, string]> = [
    ['content-type', 'text/plain'],
    ['transfer-encoding', 'chunked'],
    ['connection', 'close'],
  ];

  it('drops a decoded coding and its length', () => {
    expect(
      rawResponseHeaders({
        method: 'GET',
        status: 200,
        headers: [...base, ['content-encoding', 'gzip'], ['content-length', '10']],
        bodyRewritten: false,
      })
    ).toEqual([['content-type', 'text/plain']]);
  });

  it('keeps an identity length unless the body was rewritten', () => {
    const headers: Array<[string, string]> = [
      ['content-length', '10'],
      ['content-encoding', 'identity'],
    ];
    expect(
      rawResponseHeaders({ method: 'GET', status: 200, headers, bodyRewritten: false })
    ).toEqual([['content-length', '10']]);
    expect(
      rawResponseHeaders({ method: 'GET', status: 200, headers, bodyRewritten: true })
    ).toEqual([]);
  });

  it('keeps an unknown coding with its encoded bytes', () => {
    const headers: Array<[string, string]> = [
      ['content-encoding', 'compress'],
      ['content-length', '10'],
    ];
    expect(
      rawResponseHeaders({ method: 'GET', status: 200, headers, bodyRewritten: false })
    ).toEqual(headers);
  });

  it('leaves encoding and length alone on bodiless responses', () => {
    const headers: Array<[string, string]> = [
      ['content-encoding', 'gzip'],
      ['content-length', '10'],
    ];
    for (const [method, status] of [
      ['HEAD', 200],
      ['GET', 304],
      ['GET', 204],
    ] as const) {
      expect(rawResponseHeaders({ method, status, headers, bodyRewritten: true })).toEqual(headers);
    }
    expect(rawResponseHasBody('head', 200)).toBe(false);
    expect(rawResponseHasBody('GET', 302)).toBe(true);
  });
});
