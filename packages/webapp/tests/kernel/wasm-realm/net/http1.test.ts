import { describe, expect, it } from 'vitest';
import {
  type ByteSource,
  chunk,
  fieldTokens,
  HttpError,
  Incoming,
  LAST_CHUNK,
  latin1,
  parseRequestHead,
  readBody,
  requestFraming,
  responseHead,
} from '../../../../src/kernel/wasm-realm/net/http1.js';

const enc = (s: string) => new TextEncoder().encode(s);

function source(...pieces: string[]): ByteSource {
  const queue = pieces.map(enc);
  return { read: async () => queue.shift() ?? new Uint8Array(0) };
}

async function rejects(p: Promise<unknown>, status: number): Promise<void> {
  const error = await p.then(
    () => undefined,
    (e: unknown) => e
  );
  expect(error).toBeInstanceOf(HttpError);
  expect((error as HttpError).status).toBe(status);
}

describe('Incoming', () => {
  it('reads a head split across reads and keeps what follows', async () => {
    const incoming = new Incoming(source('GET / HTTP/1.1\r\nHo', 'st: a\r\n\r', '\nbody'));
    const head = await incoming.head(1024);
    expect(latin1(head as Uint8Array)).toBe('GET / HTTP/1.1\r\nHost: a\r\n\r\n');
    expect(incoming.buffered).toBe(4);
    expect(latin1(await incoming.exactly(4))).toBe('body');
  });

  it('answers null at a clean end and 400 inside a head', async () => {
    expect(await new Incoming(source()).head(1024)).toBeNull();
    await rejects(new Incoming(source('GET / HT')).head(1024), 400);
  });

  it('refuses a head over the limit', async () => {
    await rejects(new Incoming(source(`GET /${'a'.repeat(100)}`)).head(64), 431);
    await rejects(
      new Incoming(source(`GET / HTTP/1.1\r\nX: ${'b'.repeat(80)}\r\n\r\n`)).head(64),
      431
    );
  });

  it('accepts bare LF line ends', async () => {
    const head = await new Incoming(source('GET / HTTP/1.1\nHost: a\n\n')).head(1024);
    expect(parseRequestHead(head as Uint8Array).headers).toEqual([['Host', 'a']]);
  });
});

describe('parseRequestHead', () => {
  it('parses the request line and fields in order', () => {
    const req = parseRequestHead(
      enc(
        '\r\nGET http://example.com/a?b HTTP/1.1\r\nHost: example.com\r\nX-A: 1\r\nx-a:  2 \r\n\r\n'
      )
    );
    expect(req).toEqual({
      method: 'GET',
      target: 'http://example.com/a?b',
      minor: 1,
      headers: [
        ['Host', 'example.com'],
        ['X-A', '1'],
        ['x-a', '2'],
      ],
    });
  });

  it('refuses malformed lines, folding and other versions', () => {
    const status = (text: string) => {
      try {
        parseRequestHead(enc(text));
      } catch (e) {
        return (e as HttpError).status;
      }
      return 0;
    };
    expect(status('GET /\r\n\r\n')).toBe(400);
    expect(status('GET / HTTP/2.0\r\n\r\n')).toBe(505);
    expect(status('GET / HTTP/1.1\r\nX: a\r\n b\r\n\r\n')).toBe(400);
    expect(status('GET / HTTP/1.1\r\nBad Name: a\r\n\r\n')).toBe(400);
    expect(status('GET / HTTP/1.1\r\n: a\r\n\r\n')).toBe(400);
  });
});

describe('requestFraming', () => {
  it('reads Content-Length and chunked, and refuses both or conflicting lengths', () => {
    expect(requestFraming([])).toEqual({ kind: 'none' });
    expect(requestFraming([['Content-Length', '0']])).toEqual({ kind: 'none' });
    expect(requestFraming([['content-length', '12']])).toEqual({ kind: 'length', length: 12 });
    expect(
      requestFraming([
        ['Content-Length', '5'],
        ['Content-Length', '5'],
      ])
    ).toEqual({ kind: 'length', length: 5 });
    expect(requestFraming([['Transfer-Encoding', 'Chunked']])).toEqual({ kind: 'chunked' });
    expect(() =>
      requestFraming([
        ['Content-Length', '5'],
        ['Content-Length', '6'],
      ])
    ).toThrow(HttpError);
    expect(() => requestFraming([['Content-Length', '-1']])).toThrow(HttpError);
    expect(() =>
      requestFraming([
        ['Transfer-Encoding', 'chunked'],
        ['Content-Length', '5'],
      ])
    ).toThrow('both');
    expect(() => requestFraming([['Transfer-Encoding', 'gzip, chunked']])).toThrow('unsupported');
  });
});

describe('readBody', () => {
  it('reads a fixed-length body', async () => {
    const body = await readBody(
      new Incoming(source('hel', 'lo!')),
      { kind: 'length', length: 5 },
      10
    );
    expect(latin1(body as Uint8Array)).toBe('hello');
  });

  it('decodes chunks, ignores extensions and drops trailers', async () => {
    const incoming = new Incoming(
      source('5;ext=1\r\nhello\r\n', '6\r\n world\r\n0\r\nX-Trailer: t\r\n\r\nNEXT')
    );
    const body = await readBody(incoming, { kind: 'chunked' }, 100);
    expect(latin1(body as Uint8Array)).toBe('hello world');
    expect(latin1(await incoming.exactly(4))).toBe('NEXT');
  });

  it('refuses a body over the cap, bad chunk sizes and a cut body', async () => {
    await rejects(readBody(new Incoming(source('')), { kind: 'length', length: 11 }, 10), 413);
    await rejects(
      readBody(new Incoming(source('b\r\nhello world\r\n0\r\n\r\n')), { kind: 'chunked' }, 10),
      413
    );
    await rejects(readBody(new Incoming(source('zz\r\n')), { kind: 'chunked' }, 10), 400);
    await rejects(readBody(new Incoming(source('3\r\nabcX')), { kind: 'chunked' }, 10), 400);
    await rejects(readBody(new Incoming(source('ab')), { kind: 'length', length: 5 }, 10), 400);
  });

  it('has no body without framing', async () => {
    expect(await readBody(new Incoming(source('x')), { kind: 'none' }, 10)).toBeUndefined();
  });
});

describe('response writing', () => {
  it('writes a status line and fields, dropping fields that could split the head', () => {
    const head = latin1(
      responseHead(200, 'OK', [
        ['Content-Type', 'text/plain'],
        ['X-Bad', 'a\r\nInjected: 1'],
        ['Bad Name', 'x'],
      ])
    );
    expect(head).toBe('HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\n');
    expect(latin1(responseHead(404, 'Not\r\nFound', []))).toBe('HTTP/1.1 404 \r\n\r\n');
  });

  it('frames chunks', () => {
    expect(latin1(chunk(enc('0123456789abcdefX')))).toBe('11\r\n0123456789abcdefX\r\n');
    expect(latin1(LAST_CHUNK)).toBe('0\r\n\r\n');
  });

  it('splits comma-separated tokens case-insensitively', () => {
    expect(
      fieldTokens(
        [
          ['Connection', 'Keep-Alive, X-Hop'],
          ['connection', 'close'],
        ],
        'CONNECTION'
      )
    ).toEqual(['keep-alive', 'x-hop', 'close']);
  });
});
