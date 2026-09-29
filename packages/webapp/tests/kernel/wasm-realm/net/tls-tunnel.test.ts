import { createHash } from 'node:crypto';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { type CaRecord, RealmCa } from '../../../../src/kernel/wasm-realm/net/realm-ca.js';
import {
  enableRealmNetwork,
  realmProxy,
} from '../../../../src/kernel/wasm-realm/net/realm-network.js';
import type { TlsEngine } from '../../../../src/kernel/wasm-realm/net/tls-engine.js';
import { authority } from '../../../../src/kernel/wasm-realm/net/tls-tunnel.js';
import type { RealmTransportRequest } from '../../../../src/kernel/wasm-realm/net/transport.js';
import { LoopbackNet } from '../../../../src/kernel/wasm-realm/socket.js';
import { reply, scripted, text } from './proxy-helpers.js';
import { exchange, nodeTlsEngine, tlsTunnel } from './tls-helpers.js';

let engine: TlsEngine;
let ca: RealmCa;
const nets: LoopbackNet[] = [];

beforeAll(async () => {
  engine = await nodeTlsEngine();
  const records = new Map<string, CaRecord>();
  ca = await RealmCa.open('cone:', {
    get: async (o) => records.get(o),
    put: async (o, r) => {
      records.set(o, r);
    },
  });
}, 30_000);

afterEach(async () => {
  for (const net of nets.splice(0)) {
    const proxy = realmProxy(net);
    proxy?.close();
    await proxy?.closed;
  }
});

function network(handler: (req: RealmTransportRequest) => ReturnType<typeof reply>) {
  const net = new LoopbackNet();
  nets.push(net);
  const t = scripted(handler, { maxRequestBody: 1 << 20 });
  enableRealmNetwork(net, {
    transport: () => t.transport,
    tls: { ca: async () => ca, engine: async () => engine },
  });
  return { net, seen: t.seen };
}

const complete = (s: string) => s.endsWith('0\r\n\r\n');

describe('TLS termination', () => {
  it.each(['TLSv1.2', 'TLSv1.3'] as const)(
    'serves %s as the CONNECT host, verified against the realm CA only, http/1.1 by ALPN',
    async (version) => {
      const { net, seen } = network((req) =>
        reply(200, [['Content-Type', 'text/plain']], `hi ${req.url}`)
      );
      const socket = await tlsTunnel(net, 'example.com:443', ca.pem, {
        minVersion: version,
        maxVersion: version,
      });
      expect(socket.authorized).toBe(true);
      expect(socket.getProtocol()).toBe(version);
      expect(socket.alpnProtocol).toBe('http/1.1');
      const cert = socket.getPeerX509Certificate();
      expect(cert?.subjectAltName).toBe('DNS:example.com');
      const res = await exchange(
        socket,
        'GET /path?q=1 HTTP/1.1\r\nHost: example.com\r\n\r\n',
        complete
      );
      expect(res.toString()).toMatch(/^HTTP\/1\.1 200 OK\r\n/);
      expect(res.toString()).toContain('hi https://example.com/path?q=1');
      expect(seen.map((r) => r.url)).toEqual(['https://example.com/path?q=1']);
      socket.destroy();
    },
    20_000
  );

  it('keeps the tunnel alive for several requests and names a non-default port in the URL', async () => {
    const { net, seen } = network((req) =>
      reply(200, [], `${req.method} ${text(req.body ?? new Uint8Array())}`)
    );
    const socket = await tlsTunnel(net, 'api.test:8443', ca.pem);
    const one = await exchange(socket, 'GET / HTTP/1.1\r\nHost: api.test:8443\r\n\r\n', complete);
    expect(one.toString()).toContain('GET ');
    const two = await exchange(
      socket,
      'POST /up HTTP/1.1\r\nHost: api.test:8443\r\nContent-Length: 4\r\n\r\ndata',
      complete
    );
    expect(two.toString()).toContain('POST data');
    expect(seen.map((r) => r.url)).toEqual(['https://api.test:8443/', 'https://api.test:8443/up']);
    socket.destroy();
  }, 20_000);

  it('streams a large binary body intact', async () => {
    const piece = new Uint8Array(256 * 1024).map((_, i) => (i * 7) & 0xff);
    const { net } = network(() => ({
      status: 200,
      statusText: 'OK',
      headers: [],
      body: (async function* () {
        for (let i = 0; i < 16; i++) yield piece;
      })(),
      cancel: async () => undefined,
    }));
    const socket = await tlsTunnel(net, 'big.test:443', ca.pem);
    const res = await exchange(socket, 'GET /blob HTTP/1.1\r\nHost: big.test\r\n\r\n', complete);
    const raw = res.toString('latin1');
    const body = raw.slice(raw.indexOf('\r\n\r\n') + 4);

    const out: Buffer[] = [];
    for (let at = 0; ; ) {
      const eol = body.indexOf('\r\n', at);
      const size = Number.parseInt(body.slice(at, eol), 16);
      if (size === 0) break;
      out.push(Buffer.from(body.slice(eol + 2, eol + 2 + size), 'latin1'));
      at = eol + 2 + size + 2;
    }
    const got = Buffer.concat(out);
    const want = Buffer.concat(Array.from({ length: 16 }, () => Buffer.from(piece)));
    expect(got.length).toBe(want.length);
    expect(createHash('sha256').update(got).digest('hex')).toBe(
      createHash('sha256').update(want).digest('hex')
    );
    socket.destroy();
  }, 30_000);

  it('aborts the upstream when the client leaves a tunnel before the headers come', async () => {
    const signals: AbortSignal[] = [];
    const { net } = network((req) => {
      signals.push(req.signal);
      return new Promise(() => undefined) as unknown as ReturnType<typeof reply>;
    });
    const socket = await tlsTunnel(net, 'slow.test:443', ca.pem);
    socket.write('GET / HTTP/1.1\r\nHost: slow.test\r\n\r\n');
    for (let i = 0; i < 50 && signals.length === 0; i++)
      await new Promise((r) => setTimeout(r, 10));
    expect(signals).toHaveLength(1);
    socket.destroy();
    for (let i = 0; i < 50 && !signals[0].aborted; i++) await new Promise((r) => setTimeout(r, 10));
    expect(signals[0].aborted).toBe(true);
  }, 20_000);

  it.each([
    ['[2001:db8::1]:443', 'https://[2001:db8::1]/v6'],
    ['203.0.113.7:8443', 'https://203.0.113.7:8443/v6'],
  ])(
    'terminates a CONNECT to the IP literal %s with an iPAddress leaf',
    async (target, url) => {
      const { net, seen } = network(() => reply(200, [], 'by address'));
      const socket = await tlsTunnel(net, target, ca.pem);
      expect(socket.authorized).toBe(true);
      const host = new URL(url).host;
      const res = await exchange(socket, `GET /v6 HTTP/1.1\r\nHost: ${host}\r\n\r\n`, complete);
      expect(res.toString()).toContain('by address');
      expect(seen.map((r) => r.url)).toEqual([url]);
      socket.destroy();
    },
    20_000
  );

  it('answers 421 to a request for another host inside the tunnel', async () => {
    const { net, seen } = network(() => reply(200, [], 'no'));
    const socket = await tlsTunnel(net, 'example.com:443', ca.pem);
    const res = await exchange(
      socket,
      'GET / HTTP/1.1\r\nHost: evil.test\r\n\r\n',
      (s) => s.includes('\r\n\r\n') && s.endsWith('\n')
    );
    expect(res.toString()).toMatch(/^HTTP\/1\.1 421 Misdirected Request\r\n/);
    expect(seen).toHaveLength(0);
    socket.destroy();
  }, 20_000);

  it('refuses a handshake whose SNI names another host', async () => {
    const { net } = network(() => reply(200, [], 'no'));
    await expect(
      tlsTunnel(net, 'example.com:443', ca.pem, { servername: 'evil.test' })
    ).rejects.toThrow();
  }, 20_000);

  it('is not trusted by a client that does not trust the realm CA', async () => {
    const { net } = network(() => reply(200, [], 'no'));
    const other = await RealmCa.open('other', {
      get: async () => undefined,
      put: async () => undefined,
    });
    await expect(tlsTunnel(net, 'example.com:443', ca.pem, { ca: other.pem })).rejects.toThrow(
      /certificate/i
    );
  }, 20_000);

  it('serves sixteen tunnels at once, each with its own host', async () => {
    const { net, seen } = network((req) => reply(200, [], new URL(req.url).host));
    const results = await Promise.all(
      Array.from({ length: 16 }, async (_, i) => {
        const host = `h${i}.test`;
        const socket = await tlsTunnel(
          net,
          `${host}:443`,
          ca.pem,
          i % 2 ? { maxVersion: 'TLSv1.2' } : {}
        );
        const res = await exchange(socket, `GET / HTTP/1.1\r\nHost: ${host}\r\n\r\n`, complete);
        socket.destroy();
        return res.toString().includes(`\r\n${host}\r\n`);
      })
    );
    expect(results.every(Boolean)).toBe(true);
    expect(seen).toHaveLength(16);
  }, 60_000);
});

describe('leaves', () => {
  function counting(fail = 0) {
    let issued = 0;
    let failures = fail;

    let now = Date.now() - 6 * 86400_000 - 2 * 3600_000;
    const counted = {
      get cert() {
        return ca.cert;
      },
      issue: async (host: string, spki: Uint8Array) => {
        if (failures-- > 0) throw new Error('signing failed');
        issued++;
        return ca.issue(host, spki, now);
      },
    } as unknown as RealmCa;
    const net = new LoopbackNet();
    nets.push(net);
    enableRealmNetwork(net, {
      transport: () => scripted(() => reply(200, [], 'ok')).transport,
      tls: { ca: async () => counted, engine: async () => engine, now: () => now },
    });
    return {
      net,
      issued: () => issued,
      advance: (ms: number) => {
        now += ms;
      },
    };
  }

  it('issues one leaf per host and reuses it, then replaces it near its expiry', async () => {
    const n = counting();
    for (let i = 0; i < 3; i++) (await tlsTunnel(n.net, 'a.test:443', ca.pem)).destroy();
    (await tlsTunnel(n.net, 'b.test:443', ca.pem)).destroy();
    expect(n.issued()).toBe(2);
    n.advance(6 * 86400_000 + 1);
    (await tlsTunnel(n.net, 'a.test:443', ca.pem)).destroy();
    expect(n.issued()).toBe(3);
  }, 30_000);

  it('does not keep a failed issuance: the next tunnel tries again', async () => {
    const n = counting(1);
    await expect(tlsTunnel(n.net, 'a.test:443', ca.pem)).rejects.toThrow();
    (await tlsTunnel(n.net, 'a.test:443', ca.pem)).destroy();
    expect(n.issued()).toBe(1);
  }, 30_000);

  it('names the default port nowhere', () => {
    expect(authority({ host: 'a.test', port: 443 })).toBe('a.test');
    expect(authority({ host: 'a.test', port: 8443 })).toBe('a.test:8443');
  });
});
