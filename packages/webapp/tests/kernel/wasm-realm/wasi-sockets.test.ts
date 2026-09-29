/**
 * WASI preview1 sockets and poll (#3530 phase 5b), with real programs in
 * worker threads: `wasisock` (C, wasi-libc) serves on a listener it
 * inherits — as `wasm --listen` hands one over — and a TypeScript client
 * on the same loopback network talks to it; poll reports a pipe's hangup.
 */
import 'fake-indexeddb/auto';
import { existsSync, readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { VirtualFS } from '../../../src/fs/virtual-fs.js';
import {
  FdTable,
  nullFile,
  OpenFile,
  openPipe,
  sinkFile,
} from '../../../src/kernel/wasm-realm/fd-table.js';
import { spawnWasmProcess } from '../../../src/kernel/wasm-realm/host.js';
import type { WasmProgram } from '../../../src/kernel/wasm-realm/protocol.js';
import { LoopbackNet, type SockAddr } from '../../../src/kernel/wasm-realm/socket.js';
import { VfsAdapter } from '../../../src/shell/vfs-adapter.js';
import { bundleProcessWorker, nodeWorker } from './helpers/node-wasm-process.js';

const FIXTURE = new URL('../../fixtures/wasm-wasi/wasisock.wasm', import.meta.url).pathname;
const GO_HTTPD = process.env.WASI_RESEARCH && `${process.env.WASI_RESEARCH}/go-demo/httpd.wasm`;

let worker: { file: string; dispose(): void };
let fs: VfsAdapter;
let program: WasmProgram;
let nextPid = 36000;
let nextPort = 18000;

beforeAll(async () => {
  worker = await bundleProcessWorker();
  const vfs = await VirtualFS.create({ dbName: `wasi-sock-${Math.random()}`, wipe: true });
  await vfs.mkdir('/w', { recursive: true });
  fs = new VfsAdapter(vfs);
  program = { abi: 'wasi', glue: '', module: await WebAssembly.compile(readFileSync(FIXTURE)) };
}, 120_000);

afterAll(() => worker?.dispose());

interface Served {
  addr: SockAddr;
  net: LoopbackNet;
  out(): string;
  err(): string;
  exited: Promise<number>;
}

/** Run `prog args` with a listener at fd 3 on a network of its own (what `wasm --listen` does). */
function serve(prog: WasmProgram, args: string[], stdin: OpenFile = nullFile()): Served {
  const net = new LoopbackNet();
  const addr: SockAddr = { family: 'inet', host: '127.0.0.1', port: nextPort++ };
  let out = '';
  let err = '';
  const dec = new TextDecoder();
  const fds = new FdTable();
  fds.installAt(0, stdin);
  fds.installAt(
    1,
    sinkFile((b) => void (out += dec.decode(b, { stream: true })))
  );
  fds.installAt(
    2,
    sinkFile((b) => void (err += dec.decode(b, { stream: true })))
  );
  fds.installAt(3, new OpenFile(net.listen(addr)));
  fds.setStatusFlags(3, 0o4000); // O_NONBLOCK, as `wasm --listen` hands it
  const exited = spawnWasmProcess({
    pid: nextPid++,
    program: prog,
    argv0: 'wasisock',
    args,
    env: {},
    cwd: '/w',
    fds,
    fs: fs as never,
    net,
    createWorker: () => nodeWorker(worker.file),
    onError: (m) => void (err += m),
  }).exited;
  return { addr, net, out: () => out, err: () => err, exited };
}

/** Connect, send `text`, read the answer to its end. */
async function ask(net: LoopbackNet, addr: SockAddr, text: string): Promise<string> {
  const sock = net.connect(addr);
  await sock.write(new TextEncoder().encode(text));
  const dec = new TextDecoder();
  let answer = '';
  for (let chunk = await sock.read(4096); chunk.length > 0; chunk = await sock.read(4096)) {
    answer += dec.decode(chunk, { stream: true });
  }
  sock.close();
  return answer;
}

describe('WASI sockets (wasisock, C/wasi-libc)', () => {
  it('accepts on the inherited listener (moved above the preopens, named by $SLICC_LISTEN_FDS)', async () => {
    const s = serve(program, ['serve', '2']);
    expect(await ask(s.net, s.addr, 'hi there\n')).toBe('echo: hi there\n');
    expect(await ask(s.net, s.addr, 'again\n')).toBe('echo: again\n');
    expect(await s.exited).toBe(0);
    const fd = Number(/listening on fd (\d+)/.exec(s.out())?.[1]);
    // fd 3 is `.`; the listener sits past /dev, /w and the other preopens.
    expect(fd).toBeGreaterThan(3);
    expect(s.out()).toContain('served (peeked hi t)');
    expect(s.err()).toBe('');
  });

  it('a non-blocking accept is EAGAIN until poll says a connection waits', async () => {
    const s = serve(program, ['nonblock']);
    await waitFor(() => s.out().includes('accept now'));
    expect(s.out()).toContain('starts non-blocking\naccept now: EAGAIN');
    expect(await ask(s.net, s.addr, 'late\n')).toBe('echo: late\n');
    expect(await s.exited).toBe(0);
    expect(s.out()).toContain('poll: 1 POLLIN');
  });

  it('poll reports POLLHUP once a pipe’s writer is gone', async () => {
    const pipe = openPipe();
    const s = serve(program, ['hangup'], pipe.read);
    await pipe.write.file.write?.(new TextEncoder().encode('x'));
    await Promise.resolve(pipe.write.release());
    expect(await s.exited).toBe(0);
    expect(s.out()).toContain('POLLHUP, then read 0');
  });

  it('a socket call on something else is ENOTSOCK', async () => {
    const s = serve(program, ['notsock']);
    expect(await s.exited).toBe(0);
    expect(s.out()).toBe('recv on stdin: ENOTSOCK\n');
  });
});

describe.skipIf(!GO_HTTPD || !existsSync(GO_HTTPD))('WASI sockets (Go net/http)', () => {
  it('serves HTTP on the inherited listener, through Go’s netpoll (poll_oneoff)', {
    timeout: 30_000,
  }, async () => {
    const go = {
      abi: 'wasi' as const,
      glue: '',
      module: await WebAssembly.compile(readFileSync(GO_HTTPD as string)),
    };
    const s = serve(go, []);
    await waitFor(() => s.out().includes('serving')).catch((e) => {
      throw new Error(`${e}: out=${s.out()} err=${s.err()}`);
    });
    const res = await ask(s.net, s.addr, 'GET /hello HTTP/1.0\r\nHost: x\r\n\r\n');
    expect(res).toMatch(/^HTTP\/1\.0 200 OK/);
    expect(res).toContain('hello from go on wasip1: /hello');
  });
});

async function waitFor(done: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !done(); i++) await new Promise((r) => setTimeout(r, 25));
  if (!done()) throw new Error('timed out');
}
