import { afterEach, describe, expect, it } from 'vitest';
import { parseRequestHead } from '../../../../src/kernel/wasm-realm/net/http1.js';
import {
  forwardResponseHeaders,
  isLoopbackHost,
  RealmProxy,
  type RealmProxyOptions,
  tunnelRequestUrl,
} from '../../../../src/kernel/wasm-realm/net/proxy-service.js';
import type { RealmTransportRequest } from '../../../../src/kernel/wasm-realm/net/transport.js';
import { LoopbackNet } from '../../../../src/kernel/wasm-realm/socket.js';
import { Client, enc, reply, scripted, text, tick } from './proxy-helpers.js';

const proxies: RealmProxy[] = [];

function start(options: Omit<RealmProxyOptions, 'net'> & { net?: LoopbackNet }) {
  const net = options.net ?? new LoopbackNet();
  const proxy = new RealmProxy({ ...options, net });
  proxies.push(proxy);
  return { net, proxy, client: () => Client.open(net, proxy.port) };
}

afterEach(async () => {
  for (const proxy of proxies.splice(0)) {
    proxy.close();
    await proxy.closed;
  }
});

const ok = () => reply(200, [['Content-Type', 'text/plain']], 'hello');

describe('RealmProxy: forwarding', () => {
  it('forwards an absolute-form GET with its end-to-end fields and streams the response', async () => {
    const t = scripted(() =>
      reply(
        200,
        [
          ['Content-Type', 'text/plain'],
          ['Content-Length', '999'],
          ['Content-Encoding', 'gzip'],
          ['Connection', 'X-Up-Hop'],
          ['X-Up-Hop', 'gone'],
          ['Set-Cookie', 'a=1'],
          ['Set-Cookie', 'b=2'],
        ],
        'hel',
        'lo'
      )
    );
    const { client } = start({ transport: t.transport });
    const c = client();
    await c.send(
      'GET http://example.com/a?b=1 HTTP/1.1\r\nHost: example.com\r\nUser-Agent: curl/8\r\n' +
        'Proxy-Authorization: Basic x\r\nProxy-Connection: keep-alive\r\nConnection: X-Hop\r\n' +
        'X-Hop: dropped\r\nAuthorization: Bearer masked\r\nAccept: */*\r\n\r\n'
    );
    const res = await c.response();
    expect(res.status).toBe(200);
    expect(res.body).toBe('hello');

    expect(res.headers).toEqual([
      ['Content-Type', 'text/plain'],
      ['Set-Cookie', 'a=1'],
      ['Set-Cookie', 'b=2'],
      ['Connection', 'keep-alive'],
      ['Transfer-Encoding', 'chunked'],
    ]);
    expect(t.seen).toHaveLength(1);
    expect(t.seen[0].url).toBe('http://example.com/a?b=1');
    expect(t.seen[0].method).toBe('GET');
    expect(t.seen[0].body).toBeUndefined();
    expect(t.seen[0].headers).toEqual([
      ['User-Agent', 'curl/8'],
      ['Authorization', 'Bearer masked'],
      ['Accept', '*/*'],
    ]);
  });

  it('keeps the connection alive and answers pipelined requests in order', async () => {
    let n = 0;
    const t = scripted((req) => reply(200, [], `${++n}:${new URL(req.url).pathname}`));
    const { client } = start({ transport: t.transport });
    const c = client();
    await c.send(
      'GET http://h.test/one HTTP/1.1\r\nHost: h.test\r\n\r\nGET http://h.test/two HTTP/1.1\r\nHost: h.test\r\n\r\n'
    );
    expect((await c.response()).body).toBe('1:/one');
    expect((await c.response()).body).toBe('2:/two');
    await c.send('GET http://h.test/three HTTP/1.1\r\nConnection: close\r\n\r\n');
    const last = await c.response();
    expect(last.body).toBe('3:/three');
    expect(last.header('connection')).toBe('close');
    expect(await c.rest()).toBe('');
  });

  it('sends Content-Length and chunked request bodies whole', async () => {
    const t = scripted((req) =>
      reply(201, [], `${req.method} ${text(req.body ?? new Uint8Array())}`)
    );
    const { client } = start({ transport: t.transport });
    const c = client();
    await c.send(
      'POST http://h.test/ HTTP/1.1\r\nContent-Length: 5\r\nContent-Type: a/b\r\n\r\nhello'
    );
    expect((await c.response()).body).toBe('POST hello');
    await c.send(
      'PUT http://h.test/ HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n2\r\nde\r\n0\r\n\r\n'
    );
    expect((await c.response()).body).toBe('PUT abcde');
    expect(t.seen[0].headers).toEqual([['Content-Type', 'a/b']]);
    expect(t.seen[1].headers).toEqual([]);
  });

  it('answers Expect: 100-continue before the client sends its body', async () => {
    const t = scripted((req) => reply(200, [], text(req.body ?? new Uint8Array())));
    const { client } = start({ transport: t.transport });
    const c = client();
    await c.send(
      'PUT http://h.test/ HTTP/1.1\r\nContent-Length: 4\r\nExpect: 100-continue\r\n\r\n'
    );
    const interim = await c.response();
    expect(interim.status).toBe(100);
    await c.send('data');
    expect((await c.response()).body).toBe('data');
    expect(t.seen[0].headers).toEqual([]);
  });

  it('refuses a body over the transport cap before reading it', async () => {
    const t = scripted(ok, { maxRequestBody: 8 });
    const { client } = start({ transport: t.transport });
    const c = client();
    await c.send(
      'POST http://h.test/ HTTP/1.1\r\nContent-Length: 9\r\nExpect: 100-continue\r\n\r\n'
    );
    const res = await c.response();
    expect(res.status).toBe(413);
    expect(res.body).toContain('over 8 bytes');
    expect(res.header('connection')).toBe('close');
    expect(t.seen).toHaveLength(0);
    const chunked = client();
    await chunked.send(
      'POST http://h.test/ HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n9\r\n123456789\r\n0\r\n\r\n'
    );
    expect((await chunked.response()).status).toBe(413);
  });

  it('sends no body for HEAD, 204 and 304, and keeps a HEAD length an encoded transport vouches for', async () => {
    const t = scripted(
      (req) =>
        req.method === 'HEAD'
          ? reply(200, [['Content-Length', '42']], 'ignored')
          : reply(Number(new URL(req.url).pathname.slice(1)), [['ETag', '"x"']], 'ignored'),
      { encodedBodies: true }
    );
    const { client } = start({ transport: t.transport });
    const c = client();
    await c.send('HEAD http://h.test/ HTTP/1.1\r\n\r\n');
    const head = await c.response({ head: true });
    expect(head.header('content-length')).toBe('42');
    expect(head.header('transfer-encoding')).toBeUndefined();
    for (const status of [204, 304]) {
      await c.send(`GET http://h.test/${status} HTTP/1.1\r\n\r\n`);
      const res = await c.response();
      expect(res.status).toBe(status);
      expect(res.header('etag')).toBe('"x"');
    }

    await c.send('GET http://h.test/200 HTTP/1.1\r\n\r\n');
    expect((await c.response()).body).toBe('ignored');
  });

  it('delimits an HTTP/1.0 response by closing the connection', async () => {
    const t = scripted(() => reply(200, [], 'one', 'two'));
    const { client } = start({ transport: t.transport });
    const c = client();
    await c.send('GET http://h.test/ HTTP/1.0\r\n\r\n');
    const res = await c.response();
    expect(res.header('transfer-encoding')).toBeUndefined();
    expect(res.header('connection')).toBe('close');
    expect(res.body).toBe('onetwo');
  });

  it('answers 502 when the transport has no response, with its message', async () => {
    const t = scripted(() => {
      throw new Error('Secret "TOKEN" is not allowed for domain "evil.test"');
    });
    const { client } = start({ transport: t.transport });
    const c = client();
    await c.send('GET http://evil.test/ HTTP/1.1\r\n\r\n');
    const res = await c.response();
    expect(res.status).toBe(502);
    expect(res.body).toBe(
      'slicc realm proxy: Secret "TOKEN" is not allowed for domain "evil.test"\n'
    );

    await c.send('GET http://evil.test/ HTTP/1.1\r\n\r\n');
    expect((await c.response()).status).toBe(502);
  });
});

describe('RealmProxy: refusals', () => {
  const cases: Array<[string, string, number, string]> = [
    ['origin-form', 'GET /index.html HTTP/1.1\r\nHost: h.test\r\n\r\n', 400, 'absolute URL'],
    ['loopback', 'GET http://localhost:8000/ HTTP/1.1\r\n\r\n', 403, 'no_proxy'],
    ['127.x', 'GET http://127.1.2.3/ HTTP/1.1\r\n\r\n', 403, 'no_proxy'],
    ['scheme', 'GET ftp://h.test/ HTTP/1.1\r\n\r\n', 400, 'scheme'],
    ['garbage', 'hello\r\n\r\n', 400, 'malformed'],
    ['version', 'GET http://h.test/ HTTP/2.0\r\n\r\n', 505, 'not supported'],
    ['CONNECT', 'CONNECT example.com:443 HTTP/1.1\r\n\r\n', 501, 'no tunnels'],
    ['CONNECT loopback', 'CONNECT localhost:443 HTTP/1.1\r\n\r\n', 403, 'no_proxy'],
    ['CONNECT port', 'CONNECT example.com HTTP/1.1\r\n\r\n', 400, 'host:port'],
    ['expectation', 'GET http://h.test/ HTTP/1.1\r\nExpect: tea\r\n\r\n', 417, 'expectation'],
  ];
  it.each(cases)('%s', async (_name, request, status, message) => {
    const t = scripted(ok);
    const { client } = start({ transport: t.transport });
    const c = client();
    await c.send(request);
    const res = await c.response();
    expect(res.status).toBe(status);
    expect(res.body).toContain(message);
    expect(await c.rest()).toBe('');
    expect(t.seen).toHaveLength(0);
  });

  it('knows loopback names', () => {
    for (const host of [
      'localhost',
      'LOCALHOST.',
      'a.localhost',
      '127.0.0.1',
      '0.0.0.0',
      '[::1]',
    ]) {
      expect(isLoopbackHost(host)).toBe(true);
    }
    for (const host of [
      'example.com',
      'localhost.example.com',
      '128.0.0.1',
      '10.0.0.1',
      '[2001:db8::1]',
      '[::ffff:8.8.8.8]',
      '[::8.8.8.8]',
      '169.255.0.1',
      '8.8.8.8.',
    ]) {
      expect(isLoopbackHost(host)).toBe(false);
    }
  });

  const LOCAL = [
    'localhost',
    'LocalHost.',
    'api.localhost',
    'api.localhost.',
    '127.0.0.1',
    '127.9.9.9',
    '127.0.0.1.',
    '127.1',
    '2130706433',
    '0x7f.1',
    '0x7f000001',
    '0177.0.0.1',
    '0.0.0.0',
    '0',
    '169.254.169.254',
    '[::1]',
    '[0:0:0:0:0:0:0:1]',
    '[::]',
    '[::ffff:127.0.0.1]',
    '[::ffff:7f00:1]',
    '[::FFFF:0:0]',
    '[::127.0.0.1]',
    '[::7f00:1]',
    '[fe80::1]',
    '[febf::1]',
  ];

  it.each(LOCAL)('refuses %s as an absolute-form target', async (host) => {
    const t = scripted(ok);
    const { client } = start({ transport: t.transport });
    const c = client();
    await c.send(`GET http://${host}:5710/api/fetch-proxy HTTP/1.1\r\n\r\n`);
    const res = await c.response();
    expect(res.status).toBe(403);
    expect(res.body).toContain('no_proxy');
    expect(t.seen).toHaveLength(0);
  });

  it.each(LOCAL)('refuses %s as a CONNECT target', async (host) => {
    const t = scripted(ok);
    let tunneled = false;
    const { client } = start({
      transport: t.transport,
      tunnel: async () => {
        tunneled = true;
      },
    });
    const c = client();
    await c.send(`CONNECT ${host}:443 HTTP/1.1\r\n\r\n`);
    const res = await c.response();
    expect(res.status).toBe(403);
    expect(tunneled).toBe(false);
  });

  it('tunnels to the canonical host a CONNECT names', async () => {
    const t = scripted(ok);
    const targets: string[] = [];
    const { client } = start({
      transport: t.transport,
      tunnel: async (_conn, _incoming, target) => {
        targets.push(`${target.host}:${target.port}`);
      },
    });
    const c = client();
    await c.send('CONNECT 0x08.8.8.8:443 HTTP/1.1\r\n\r\n');
    expect((await c.response({ head: true })).status).toBe(200);
    expect(targets).toEqual(['8.8.8.8:443']);
  });
});

describe('RealmProxy: flow control and lifetime', () => {
  it('reads the upstream only as fast as the client drains its socket', async () => {
    let pulled = 0;
    const piece = new Uint8Array(16 * 1024).fill(0x61);
    const t = scripted(() => ({
      status: 200,
      statusText: 'OK',
      headers: [],
      body: (async function* () {
        for (let i = 0; i < 64; i++) {
          pulled++;
          yield piece;
        }
      })(),
      cancel: async () => undefined,
    }));
    const { client } = start({ transport: t.transport });
    const c = client();
    await c.send('GET http://h.test/big HTTP/1.1\r\n\r\n');
    await tick(20);

    expect(pulled).toBeGreaterThan(0);
    expect(pulled).toBeLessThan(8);
    const res = await c.response();
    expect(res.body.length).toBe(64 * 16 * 1024);
    expect(pulled).toBe(64);
  });

  it('cancels the upstream and aborts its signal when the client goes away mid-body', async () => {
    let finished = false;
    let signal: AbortSignal | undefined;
    const t = scripted((req: RealmTransportRequest) => {
      signal = req.signal;
      return {
        status: 200,
        statusText: 'OK',
        headers: [],
        body: (async function* () {
          try {
            for (;;) yield new Uint8Array(32 * 1024);
          } finally {
            finished = true;
          }
        })(),
        cancel: async () => undefined,
      };
    });
    const { client } = start({ transport: t.transport });
    const c = client();
    await c.send('GET http://h.test/endless HTTP/1.1\r\n\r\n');
    await tick(10);
    c.close();
    await tick(10);
    expect(finished).toBe(true);
    expect(signal?.aborted).toBe(true);
  });

  it('serves at most maxConnections at once; the rest wait in the backlog', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const t = scripted(async () => {
      await gate;
      return ok();
    });
    const { client } = start({ transport: t.transport, limits: { maxConnections: 1 } });
    const first = client();
    const second = client();
    await first.send('GET http://h.test/1 HTTP/1.1\r\nConnection: close\r\n\r\n');
    await second.send('GET http://h.test/2 HTTP/1.1\r\nConnection: close\r\n\r\n');
    await tick(10);
    expect(t.seen.map((r) => r.url)).toEqual(['http://h.test/1']);
    release();
    expect((await first.response()).status).toBe(200);
    expect((await second.response()).status).toBe(200);
    expect(t.seen).toHaveLength(2);
  });

  it('frees the slot of a client that leaves while the upstream never answers', async () => {
    const signals: AbortSignal[] = [];
    const t = scripted((req) => {
      if (new URL(req.url).pathname === '/ok') return ok();
      signals.push(req.signal);
      return new Promise(() => undefined);
    });
    const { client } = start({ transport: t.transport });
    for (let i = 0; i < 64; i++) {
      const c = client();
      await c.send(`GET http://h.test/hang/${i} HTTP/1.1\r\n\r\n`);
      await tick();
      c.close();
    }
    await tick(10);
    expect(signals).toHaveLength(64);
    expect(signals.every((sig) => sig.aborted)).toBe(true);
    const last = client();
    await last.send('GET http://h.test/ok HTTP/1.1\r\nConnection: close\r\n\r\n');
    expect((await last.response()).body).toBe('hello');
  }, 10_000);

  it('still answers a client that only shut down its writing side', async () => {
    let answer: (r: ReturnType<typeof ok>) => void = () => undefined;
    const t = scripted(() => new Promise((resolve) => (answer = resolve)));
    const { client } = start({ transport: t.transport });
    const c = client();
    await c.send('GET http://h.test/ HTTP/1.0\r\n\r\n');
    c.conn.shutdown(1);
    await tick(10);
    expect(t.seen[0].signal.aborted).toBe(false);
    answer(ok());
    expect((await c.response()).body).toBe('hello');
  });

  it('closes a connection that stays idle past idleMs', async () => {
    const t = scripted(ok);
    const { client } = start({ transport: t.transport, limits: { idleMs: 20 } });
    const c = client();
    await c.send('GET http://h.test/ HTTP/1.1\r\n\r\n');
    expect((await c.response()).status).toBe(200);
    expect(await c.rest()).toBe('');
  });

  it('close() stops listening and aborts what is in flight', async () => {
    let signal: AbortSignal | undefined;
    const t = scripted(
      (req) =>
        new Promise((_resolve, reject) => {
          signal = req.signal;
          req.signal.addEventListener('abort', () => reject(new Error('aborted')));
        })
    );
    const { net, proxy, client } = start({ transport: t.transport });
    const c = client();
    await c.send('GET http://h.test/ HTTP/1.1\r\n\r\n');
    await tick(10);
    proxy.close();
    await proxy.closed;
    expect(signal?.aborted).toBe(true);
    expect(await c.rest()).toBe('');
    expect(() => net.connect({ family: 'inet', host: '127.0.0.1', port: proxy.port })).toThrow(
      'ECONNREFUSED'
    );
  });

  it('hands a CONNECT to the tunnel handler with the bytes read past its head', async () => {
    const t = scripted(ok);
    const seen: string[] = [];
    const { client } = start({
      transport: t.transport,
      tunnel: async (conn, incoming, target) => {
        seen.push(`${target.host}:${target.port}`, text(await incoming.exactly(5)));
        await conn.write(enc('pong'));
      },
    });
    const c = client();
    await c.send('CONNECT Example.COM:8443 HTTP/1.1\r\nHost: example.com:8443\r\n\r\nhello');
    const established = await c.incoming.head(1024);
    expect(text(established ?? new Uint8Array())).toBe(
      'HTTP/1.1 200 Connection Established\r\n\r\n'
    );
    expect(await c.rest()).toBe('pong');
    expect(seen).toEqual(['example.com:8443', 'hello']);
  });
});

describe('forwardResponseHeaders', () => {
  it('keeps the coding of bytes the transport left encoded, but never a body length', () => {
    const headers = [
      ['Content-Encoding', 'gzip'],
      ['Content-Length', '10'],
    ] as const;
    expect(forwardResponseHeaders(headers, { encodedBodies: true, bodiless: false })).toEqual([
      ['Content-Encoding', 'gzip'],
    ]);
    expect(forwardResponseHeaders(headers, { encodedBodies: false, bodiless: true })).toEqual([]);
  });
});

describe('tunnelRequestUrl', () => {
  const url = (head: string, origin = 'https://example.com') =>
    tunnelRequestUrl(parseRequestHead(enc(`${head}\r\n\r\n`)), origin);
  it('resolves origin-form and same-origin absolute targets', () => {
    expect(url('GET /a?b HTTP/1.1\r\nHost: example.com')).toBe('https://example.com/a?b');
    expect(url('GET /a HTTP/1.1\r\nHost: EXAMPLE.com:443')).toBe('https://example.com/a');
    expect(url('GET https://example.com/x HTTP/1.1')).toBe('https://example.com/x');
    expect(url('GET / HTTP/1.1\r\nHost: h.test:8443', 'https://h.test:8443')).toBe(
      'https://h.test:8443/'
    );
  });
  it('refuses another origin or Host with 421', () => {
    for (const head of [
      'GET / HTTP/1.1\r\nHost: evil.test',
      'GET https://evil.test/ HTTP/1.1',
      'GET http://example.com/ HTTP/1.1',
      'GET / HTTP/1.1\r\nHost: example.com:8443',
    ]) {
      expect(() => url(head)).toThrow('this tunnel is for example.com');
    }
  });
});

describe('CONNECT inside a tunnel', () => {
  it('is refused', async () => {
    const t = scripted(ok);
    const { client } = start({
      transport: t.transport,
      tunnel: async (conn, incoming, target, _signal, serveHttp) => {
        await serveHttp(
          { read: (max, signal) => incoming.some(max, signal) },
          conn,
          `https://${target.host}`
        );
      },
    });
    const c = client();
    await c.send('CONNECT a.test:443 HTTP/1.1\r\n\r\nCONNECT b.test:443 HTTP/1.1\r\n\r\n');
    expect(text((await c.incoming.head(1024)) ?? new Uint8Array())).toContain('200');
    const res = await c.response();
    expect(res.status).toBe(400);
    expect(res.body).toContain('CONNECT inside a tunnel');
  });
});
