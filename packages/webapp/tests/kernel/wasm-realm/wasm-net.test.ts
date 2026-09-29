/**
 * Real programs through the realm's HTTP proxy (#3571): `socktest`
 * (`tests/fixtures/wasm-sockets`) and, when built, curl 8.22.0 run as
 * wasm-realm processes in worker threads, connect to 127.0.0.1:3128 with
 * their own syscalls, and the proxy (started by that connect) forwards over a
 * scripted transport.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RealmCa } from '../../../src/kernel/wasm-realm/net/realm-ca.js';
import {
  enableRealmNetwork,
  realmCaEnv,
  realmNetworkEnv,
  realmProxy,
} from '../../../src/kernel/wasm-realm/net/realm-network.js';
import type { RealmTransportRequest } from '../../../src/kernel/wasm-realm/net/transport.js';
import type { WasmProgram } from '../../../src/kernel/wasm-realm/protocol.js';
import { LoopbackNet } from '../../../src/kernel/wasm-realm/socket.js';
import { bundleProcessWorker, loadProgram, runProgram } from './helpers/node-wasm-process.js';
import { reply, scripted, text } from './net/proxy-helpers.js';
import { nodeTlsEngine } from './net/tls-helpers.js';

const FIXTURE = new URL('../../fixtures/wasm-sockets/socktest', import.meta.url).pathname;

let worker: { file: string; dispose(): void };
let socktest: WasmProgram;

beforeAll(async () => {
  worker = await bundleProcessWorker();
  socktest = await loadProgram(FIXTURE);
}, 60_000);

afterAll(() => worker?.dispose());

/** A namespace whose proxy answers through `handler` (terminating TLS with `ca`). */
function network(handler: (req: RealmTransportRequest) => ReturnType<typeof reply>, ca?: RealmCa) {
  const net = new LoopbackNet();
  const t = scripted(handler, { maxRequestBody: 1 << 20 });
  enableRealmNetwork(net, {
    transport: () => t.transport,
    tls: ca ? { ca: async () => ca, engine: () => nodeTlsEngine() } : false,
  });
  return { net, seen: t.seen, stop: () => realmProxy(net)?.close() };
}

describe('wasm-realm network (real programs)', () => {
  it('a C client reaches the outside through the proxy its connect() started', async () => {
    const { net, seen, stop } = network(() =>
      reply(200, [['Content-Type', 'text/plain']], 'hello from outside\n')
    );
    const run = runProgram(
      worker.file,
      socktest,
      ['http', '127.0.0.1', '3128', 'http://example.com/hi'],
      net
    );
    expect(await run.exited).toBe(0);
    stop();
    expect(seen.map((r) => `${r.method} ${r.url}`)).toEqual(['GET http://example.com/hi']);
    // HTTP/1.0: the body ends with the connection, and no chunked coding.
    expect(run.stdout()).toBe(
      'HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nhello from outside\n'
    );
  }, 30_000);

  it('a C client sends any request it reads on stdin through the proxy (socktest pipe)', async () => {
    const { net, seen, stop } = network((req) =>
      reply(
        206,
        [
          ['Content-Range', 'bytes 2-4/10'],
          ['Set-Cookie', 'a=1'],
          ['Set-Cookie', 'b=2'],
        ],
        `${req.headers.find(([n]) => n === 'Range')?.[1]} ${req.headers.find(([n]) => n === 'Authorization')?.[1]}`
      )
    );
    const request =
      'GET http://example.com/r HTTP/1.0\r\nRange: bytes=2-4\r\nAuthorization: Bearer m\r\n\r\n';
    const run = runProgram(
      worker.file,
      socktest,
      ['pipe', '127.0.0.1', '3128'],
      net,
      'socktest',
      {},
      {},
      new TextEncoder().encode(request)
    );
    expect(await run.exited).toBe(0);
    stop();
    expect(seen.map((r) => r.url)).toEqual(['http://example.com/r']);
    expect(run.stdout()).toBe(
      'HTTP/1.1 206 \r\nContent-Range: bytes 2-4/10\r\nSet-Cookie: a=1\r\nSet-Cookie: b=2\r\nConnection: close\r\n\r\nbytes=2-4 Bearer m'
    );
  }, 30_000);

  // curl 8.22.0 built with the toolchain's shims is 0.5 MB: not a fixture. Build it with
  // the toolchain's build/loopback-3571/build-curl-http.sh and point SLICC_WASM_CURL at curl.js.
  it.skipIf(!process.env.SLICC_WASM_CURL)(
    'native curl uses the default proxy env: GET, POST, redirects left to the client, errors',
    async () => {
      const curl = await loadProgram(process.env.SLICC_WASM_CURL as string);
      const { net, seen, stop } = network((req) => {
        const path = new URL(req.url).pathname;
        if (path === '/moved') return reply(302, [['Location', 'http://example.com/there']]);
        if (path === '/fail') throw new Error('upstream unreachable');
        return reply(
          200,
          [
            ['Content-Type', 'text/plain'],
            ['Set-Cookie', 'a=1'],
            ['Set-Cookie', 'b=2'],
          ],
          `${req.method} ${path} ${text(req.body ?? new Uint8Array())}\n`
        );
      });
      const env = realmNetworkEnv();
      const run = async (...args: string[]) => {
        const p = runProgram(worker.file, curl, ['-q', '-sS', ...args], net, 'curl', env);
        return { code: await p.exited, out: p.stdout(), err: p.stderr() };
      };

      const get = await run('-i', 'http://example.com/hello');
      expect(get.code).toBe(0);
      expect(get.out).toMatch(/^HTTP\/1\.1 200 OK\r\n/);
      expect(get.out).toContain('Set-Cookie: a=1\r\nSet-Cookie: b=2\r\n');
      expect(get.out).toContain('GET /hello \n');

      const post = await run('--data-binary', 'payload', 'http://example.com/up');
      expect(post).toEqual({ code: 0, out: 'POST /up payload\n', err: '' });

      const followed = await run('-L', 'http://example.com/moved');
      expect(followed.out).toBe('GET /there \n');

      const failed = await run('-f', 'http://example.com/fail');
      expect(failed.code).toBe(22);
      expect(failed.err).toContain('502');

      // `no_proxy` keeps the realm's own loopback direct (nothing listens there).
      const local = await run('http://127.0.0.1:9/');
      expect(local.code).toBe(7);
      stop();
      expect(seen.map((r) => new URL(r.url).pathname)).toEqual([
        '/hello',
        '/up',
        '/moved',
        '/there',
        '/fail',
      ]);
    },
    60_000
  );

  // curl 8.22.0 over Mbed TLS with the socket shims (~0.9 MB): build it with
  // build-curl-tls.sh (the plain-HTTP script with CURL_USE_MBEDTLS) and point
  // SLICC_WASM_CURL_TLS at curl.js.
  it.skipIf(!process.env.SLICC_WASM_CURL_TLS)(
    'native curl does HTTPS through CONNECT, trusting only the realm CA',
    async () => {
      const curl = await loadProgram(process.env.SLICC_WASM_CURL_TLS as string);
      const store = new Map();
      const ca = await RealmCa.open('cone:', {
        get: async (o) => store.get(o),
        put: async (o, r) => void store.set(o, r),
      });
      const { net, seen, stop } = network(
        (req) =>
          reply(
            200,
            [['Content-Type', 'text/plain']],
            `${req.method} ${req.url} ${text(req.body ?? new Uint8Array())}\n`
          ),
        ca
      );
      const caFile = '/home/user/.config/slicc/realm-ca-cone.pem';
      const env = { ...realmNetworkEnv(), ...realmCaEnv(caFile) };
      const run = async (...args: string[]) => {
        const p = runProgram(worker.file, curl, ['-q', '-sS', ...args], net, 'curl', env, {
          [caFile]: ca.pem,
        });
        return { code: await p.exited, out: p.stdout(), err: p.stderr() };
      };

      const get = await run(
        '-w',
        '%{http_version} %{ssl_verify_result}\n',
        'https://example.com/a?b=1'
      );
      expect(get.err).toBe('');
      expect(get.out).toBe('GET https://example.com/a?b=1 \n1.1 0\n');

      const post = await run('--data-binary', 'secret-free', 'https://api.test:8443/up');
      expect(post.out).toBe('POST https://api.test:8443/up secret-free\n');

      // Two URLs, one tunnel reused.
      const both = await run('https://example.com/1', 'https://example.com/2');
      expect(both.out).toBe('GET https://example.com/1 \nGET https://example.com/2 \n');

      // Without the realm CA the leaf is untrusted (60: peer certificate cannot be authenticated).
      const untrusted = runProgram(
        worker.file,
        curl,
        ['-q', '-sS', 'https://example.com/'],
        net,
        'curl',
        realmNetworkEnv()
      );
      expect(await untrusted.exited).toBe(60);
      stop();
      expect(seen.map((r) => r.url)).toEqual([
        'https://example.com/a?b=1',
        'https://api.test:8443/up',
        'https://example.com/1',
        'https://example.com/2',
      ]);
    },
    120_000
  );
});
