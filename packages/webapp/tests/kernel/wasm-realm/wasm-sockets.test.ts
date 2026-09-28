/**
 * Real C programs on the loopback network (#3571): `socktest`
 * (`tests/fixtures/wasm-sockets`, built with the SLICC toolchain and its
 * `slicc_socket.c` shim) runs as wasm-realm processes in worker threads,
 * against the production kernel host, SAB bridge and runtime. Its peers are
 * TypeScript kernel services and other `socktest` processes.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { WasmProgram } from '../../../src/kernel/wasm-realm/protocol.js';
import { type KernelSocket, LoopbackNet } from '../../../src/kernel/wasm-realm/socket.js';
import { bundleProcessWorker, loadProgram, runProgram } from './helpers/node-wasm-process.js';

const FIXTURE = new URL('../../fixtures/wasm-sockets/socktest', import.meta.url).pathname;
const text = (b: Uint8Array) => new TextDecoder().decode(b);
const bytes = (s: string) => new TextEncoder().encode(s);

let worker: { file: string; dispose(): void };
let socktest: WasmProgram;

beforeAll(async () => {
  worker = await bundleProcessWorker();
  socktest = await loadProgram(FIXTURE);
}, 60_000);

afterAll(() => worker?.dispose());

/** Read a connection until its peer shuts down its writing side. */
async function readToEnd(conn: KernelSocket): Promise<string> {
  let out = '';
  for (let chunk = await conn.read(4096); chunk.length > 0; chunk = await conn.read(4096)) {
    out += text(chunk);
  }
  return out;
}

/** A kernel echo service: every connection gets its bytes back, then EOF. */
function echoService(net: LoopbackNet): { port: number; close(): void; served: Promise<string[]> } {
  const listener = net.listen({ family: 'inet', host: '127.0.0.1', port: 0 });
  const seen: string[] = [];
  const served = (async () => {
    for (;;) {
      let conn: KernelSocket;
      try {
        conn = await listener.accept();
      } catch {
        return seen; // closed
      }
      const got = await readToEnd(conn);
      seen.push(got);
      await conn.write(bytes(got));
      conn.close();
    }
  })();
  const port = listener.local?.family === 'inet' ? listener.local.port : 0;
  return { port, close: () => listener.close(), served };
}

describe('wasm-realm sockets (real C programs)', () => {
  it('a C client connects (non-blocking), sends and reads back from a TS echo service', async () => {
    const net = new LoopbackNet();
    const echo = echoService(net);
    const client = runProgram(
      worker.file,
      socktest,
      ['client', 'localhost', String(echo.port), 'hello'],
      net
    );
    expect(await client.exited).toBe(0);
    echo.close();
    expect(await echo.served).toEqual(['hello']);
    expect(client.stdout()).toBe('connect: in progress\ndontwait: EAGAIN\npeek h, reply hello\n');
    expect(client.stderr()).toBe('');
  }, 30_000);

  it('a C server (select, accept, poll, recv, send) serves a C client in another process', async () => {
    const net = new LoopbackNet();
    const server = runProgram(worker.file, socktest, ['server', '0', '1'], net);
    await server.waitFor('\n');
    const port = /listening (\d+)/.exec(server.stdout())?.[1];
    expect(port).toBeDefined();
    const client = runProgram(
      worker.file,
      socktest,
      ['client', '127.0.0.1', String(port), 'shout'],
      net
    );
    expect(await client.exited).toBe(0);
    expect(await server.exited).toBe(0);
    expect(client.stdout()).toContain('peek S, reply SHOUT\n');
    expect(server.stdout()).toBe(`listening ${port}\naccepted 127.0.0.1\n`);
  }, 30_000);

  it('a TS client reaches a C server: the listener outlives nothing but its process', async () => {
    const net = new LoopbackNet();
    const server = runProgram(worker.file, socktest, ['server', '8080', '1'], net);
    await server.waitFor('listening 8080');
    const conn = net.connect({ family: 'inet', host: '127.0.0.1', port: 8080 });
    await conn.write(bytes('from the kernel'));
    conn.shutdown(1); // SHUT_WR: the server reads EOF
    expect(await readToEnd(conn)).toBe('FROM THE KERNEL');
    expect(await server.exited).toBe(0);
    // Its listener closed with the process: the port refuses now.
    expect(() => net.connect({ family: 'inet', host: '127.0.0.1', port: 8080 })).toThrow(
      'ECONNREFUSED'
    );
  }, 30_000);

  it('does an HTTP GET against a TS HTTP listener', async () => {
    const net = new LoopbackNet();
    const listener = net.listen({ family: 'inet', host: '127.0.0.1', port: 8000 });
    const served = (async () => {
      const conn = await listener.accept();
      let request = '';
      while (!request.includes('\r\n\r\n')) request += text(await conn.read(4096));
      await conn.write(bytes('HTTP/1.0 200 OK\r\nContent-Length: 12\r\n\r\nhello, wasm\n'));
      conn.close();
      return request;
    })();
    const client = runProgram(worker.file, socktest, ['http', '127.0.0.1', '8000', '/hi'], net);
    expect(await client.exited).toBe(0);
    listener.close();
    expect(await served).toBe('GET /hi HTTP/1.0\r\nHost: 127.0.0.1:8000\r\n\r\n');
    expect(client.stdout()).toBe('HTTP/1.0 200 OK\r\nContent-Length: 12\r\n\r\nhello, wasm\n');
  }, 30_000);

  it('reports refused and unreachable connections, unknown hosts and IPv6', async () => {
    const run = runProgram(worker.file, socktest, ['errors', '9'], new LoopbackNet());
    expect(await run.exited).toBe(0);
    expect(run.stdout().split('\n')).toEqual([
      'loopback: Connection refused',
      'remote: Network unreachable',
      'example.com: Name does not resolve',
      'inet6: Address family not supported by protocol',
      '',
    ]);
  }, 30_000);

  it('serves AF_UNIX listeners, accept4(SOCK_NONBLOCK) and socketpair in one process', async () => {
    const run = runProgram(worker.file, socktest, ['unix', '/tmp/s.sock'], new LoopbackNet());
    expect(await run.exited).toBe(0);
    expect(run.stdout()).toBe(
      'accepted nonblocking: EAGAIN\nunix: over unix\nsocketpair: paired\n'
    );
  }, 30_000);

  // curl 8.22.0 built with the toolchain's shims is 0.5 MB: not a fixture. Build it with
  // the toolchain's build/loopback-3571/build-curl-http.sh and point SLICC_WASM_CURL at curl.js.
  it.skipIf(!process.env.SLICC_WASM_CURL)(
    'native curl fetches http://127.0.0.1:PORT/ and http://localhost:PORT/ from a TS service',
    async () => {
      const curl = await loadProgram(process.env.SLICC_WASM_CURL as string);
      const net = new LoopbackNet();
      const listener = net.listen({ family: 'inet', host: '127.0.0.1', port: 0 });
      const port = listener.local?.family === 'inet' ? listener.local.port : 0;
      const requests: string[] = [];
      void (async () => {
        for (;;) {
          const conn = await listener.accept().catch(() => undefined);
          if (!conn) return;
          let request = '';
          while (!request.includes('\r\n\r\n')) request += text(await conn.read(4096));
          requests.push(request.split('\r\n')[0] ?? '');
          const body = `hello from the kernel, ${requests.length}\n`;
          await conn.write(
            bytes(
              `HTTP/1.1 200 OK\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`
            )
          );
          conn.close();
        }
      })();
      for (const host of ['127.0.0.1', 'localhost']) {
        const run = runProgram(
          worker.file,
          curl,
          ['-q', '-sS', '-i', `http://${host}:${port}/hello`],
          net,
          'curl'
        );
        expect(await run.exited).toBe(0);
        expect(run.stderr()).toBe('');
        expect(run.stdout()).toMatch(/^HTTP\/1\.1 200 OK\r\n/);
        expect(run.stdout()).toContain(`hello from the kernel, ${requests.length}\n`);
      }
      listener.close();
      expect(requests).toEqual(['GET /hello HTTP/1.1', 'GET /hello HTTP/1.1']);
    },
    60_000
  );
});
