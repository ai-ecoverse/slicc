import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  enableRealmNetwork,
  realmNetworkEnv,
  realmProxy,
} from '../../../src/kernel/wasm-realm/net/realm-network.js';
import type { RealmTransportRequest } from '../../../src/kernel/wasm-realm/net/transport.js';
import type { WasmProgram } from '../../../src/kernel/wasm-realm/protocol.js';
import { LoopbackNet } from '../../../src/kernel/wasm-realm/socket.js';
import { bundleProcessWorker, loadProgram, runProgram } from './helpers/node-wasm-process.js';
import { reply, scripted, text } from './net/proxy-helpers.js';

const FIXTURE = new URL('../../fixtures/wasm-sockets/socktest', import.meta.url).pathname;

let worker: { file: string; dispose(): void };
let socktest: WasmProgram;

beforeAll(async () => {
  worker = await bundleProcessWorker();
  socktest = await loadProgram(FIXTURE);
}, 60_000);

afterAll(() => worker?.dispose());

function network(handler: (req: RealmTransportRequest) => ReturnType<typeof reply>) {
  const net = new LoopbackNet();
  const t = scripted(handler, { maxRequestBody: 1 << 20 });
  enableRealmNetwork(net, { transport: () => t.transport });
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

    expect(run.stdout()).toBe(
      'HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nhello from outside\n'
    );
  }, 30_000);

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
});
