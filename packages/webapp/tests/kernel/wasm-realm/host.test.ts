import { describe, expect, it, vi } from 'vitest';
import type { SyncFsResult } from '../../../src/kernel/realm/sync-fs-dispatch.js';
import {
  decodeSabResult,
  SAB_I_CHUNK,
  SAB_I_SEQ,
  SAB_I_STATE,
  SAB_I_STATUS,
  SAB_STATE_PENDING,
  SAB_STATE_READY,
  SYNC_SAB_REQ_MSG,
  type SyncSabRequestBody,
  sabViews,
} from '../../../src/kernel/realm/sync-sab-wire.js';
import {
  bytesSource,
  FdTable,
  openPipe,
  sinkFile,
} from '../../../src/kernel/wasm-realm/fd-table.js';
import { spawnWasmProcess, type WasmWorkerLike } from '../../../src/kernel/wasm-realm/host.js';
import type { WasmProcessInitMsg } from '../../../src/kernel/wasm-realm/protocol.js';

const bytes = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array) => new TextDecoder().decode(b);

type Call = (req: SyncSabRequestBody) => Promise<SyncFsResult>;
type Program = (call: Call, init: WasmProcessInitMsg) => Promise<number>;

function fakeWorker(program: Program) {
  const listeners = new Map<string, Set<(event: MessageEvent) => void>>();
  const emit = (type: string, data: unknown) => {
    for (const h of [...(listeners.get(type) ?? [])]) h({ data } as MessageEvent);
  };
  let seq = 0;
  const worker: WasmWorkerLike & {
    terminated: boolean;
    fail(message: string): void;
    lastError?: { preventDefault: () => void };
  } = {
    terminated: false,
    postMessage(message: unknown) {
      const init = message as WasmProcessInitMsg;
      if (init.type !== 'wasm-process-init') return;
      const { header, window } = sabViews(init.sab);
      const call: Call = async (req) => {
        const id = ++seq;
        Atomics.store(header, SAB_I_STATE, SAB_STATE_PENDING);
        emit('message', { type: SYNC_SAB_REQ_MSG, id, req });
        for (;;) {
          if (
            Atomics.load(header, SAB_I_STATE) === SAB_STATE_READY &&
            Atomics.load(header, SAB_I_SEQ) === id
          ) {
            const chunk = Atomics.load(header, SAB_I_CHUNK);
            return decodeSabResult(Atomics.load(header, SAB_I_STATUS), window.slice(0, chunk));
          }
          await new Promise((r) => setTimeout(r, 1));
        }
      };
      void program(call, init).then(
        (code) => emit('message', { type: 'wasm-process-exit', code }),
        (e: unknown) => emit('message', { type: 'wasm-process-error', message: String(e) })
      );
    },
    addEventListener: (type, handler) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(handler);
    },
    removeEventListener: (type, handler) => listeners.get(type)?.delete(handler),
    terminate() {
      worker.terminated = true;
    },

    fail: (message) => {
      const event = { message, preventDefault: vi.fn() };
      worker.lastError = event;
      for (const h of [...(listeners.get('error') ?? [])]) h(event as unknown as MessageEvent);
    },
  };
  return worker;
}

function memFs(files: Record<string, string>) {
  return {
    resolvePath: (_cwd: string, p: string) => p,
    readFileBuffer: async (p: string) => {
      if (!(p in files)) throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
      return bytes(files[p]);
    },
  } as unknown as Parameters<typeof spawnWasmProcess>[0]['fs'];
}

const program = { glue: '', module: {} as WebAssembly.Module };

function stdioTable(stdin: string, out: string[], err: string[]): FdTable {
  const t = new FdTable();
  t.install(bytesSource(bytes(stdin)));
  t.install(sinkFile((b) => out.push(text(b))));
  t.install(sinkFile((b) => err.push(text(b))));
  return t;
}

describe('spawnWasmProcess', () => {
  it('serves stdio syscalls and resolves to the exit code', async () => {
    const out: string[] = [];
    const worker = fakeWorker(async (call) => {
      const r = await call({ op: 'fd-read', fd: 0, max: 64 });
      const input = r.ok && r.kind === 'bytes' ? text(r.bytes) : '';
      await call({ op: 'fd-write', fd: 1, body: bytes(input.toUpperCase()) });
      return 3;
    });
    const handle = spawnWasmProcess({
      pid: 3001,
      program,
      argv0: 'up',
      args: [],
      env: {},
      cwd: '/',
      fds: stdioTable('shout', out, []),
      fs: memFs({}),
      createWorker: () => worker,
    });
    expect(await handle.exited).toBe(3);
    expect(out).toEqual(['SHOUT']);
    expect(worker.terminated).toBe(true);
  });

  it('routes file operations to the sync-fs dispatch of its token', async () => {
    const out: string[] = [];
    const worker = fakeWorker(async (call) => {
      const r = await call({ op: 'read', path: '/w/in.txt' });
      await call({
        op: 'fd-write',
        fd: 1,
        body: r.ok && r.kind === 'bytes' ? r.bytes : bytes('?'),
      });
      const missing = await call({ op: 'read', path: '/w/none' });
      return missing.ok ? 1 : 0;
    });
    const handle = spawnWasmProcess({
      pid: 3002,
      program,
      argv0: 'cat',
      args: [],
      env: {},
      cwd: '/w',
      fds: stdioTable('', out, []),
      fs: memFs({ '/w/in.txt': 'from the vfs' }),
      createWorker: () => worker,
    });
    expect(await handle.exited).toBe(0);
    expect(out).toEqual(['from the vfs']);
  });

  it('releases the descriptors at exit: the reader of its pipe sees EOF', async () => {
    const { read, write } = openPipe();
    const fds = new FdTable();
    fds.install(bytesSource(new Uint8Array(0)));
    fds.install(write);
    const handle = spawnWasmProcess({
      pid: 3003,
      program,
      argv0: 'echo',
      args: [],
      env: {},
      cwd: '/',
      fds,
      fs: memFs({}),
      createWorker: () =>
        fakeWorker(async (call) => {
          await call({ op: 'fd-write', fd: 1, body: bytes('piped') });
          return 0;
        }),
    });
    await handle.exited;
    expect(text(await read.file.read!(64))).toBe('piped');
    expect(await read.file.read!(64)).toHaveLength(0);
  });

  it('answers a write to a pipe with no reader with EPIPE (the worker applies SIGPIPE)', async () => {
    const { read, write } = openPipe();
    await Promise.resolve(read.release());
    const fds = new FdTable();
    fds.install(bytesSource(new Uint8Array(0)));
    fds.install(write);
    let answer: SyncFsResult | undefined;
    const worker = fakeWorker(async (call) => {
      answer = await call({ op: 'fd-write', fd: 1, body: bytes('y\n') });
      return 0;
    });
    const handle = spawnWasmProcess({
      pid: 3010,
      program,
      argv0: 'yes',
      args: [],
      env: {},
      cwd: '/',
      fds,
      fs: memFs({}),
      createWorker: () => worker,
    });
    expect(await handle.exited).toBe(0);
    expect(answer).toMatchObject({ ok: false, errno: 'EPIPE' });
  });

  it("signal(): an uncaught signal's default action ends it; a caught one is left for the worker", async () => {
    let header!: Int32Array;
    let masked!: () => void;
    const reported = new Promise<void>((resolve) => (masked = resolve));
    const worker = fakeWorker(async (call, init) => {
      header = new Int32Array(init.sab, 0, 16);
      await call({ op: 'sig-mask', caught: 1 << 10, ignored: 0 });
      masked();
      return new Promise<number>(() => {});
    });
    const handle = spawnWasmProcess({
      pid: 3020,
      program,
      argv0: 'loop',
      args: [],
      env: {},
      cwd: '/',
      fds: new FdTable(),
      fs: memFs({}),
      createWorker: () => worker,
    });
    await reported;
    handle.signal(10);
    expect(Atomics.load(header, 8)).toBe(1 << 10);
    expect(handle.termsig()).toBeUndefined();
    handle.signal(15);
    expect(await handle.exited).toBe(143);
    expect(handle.termsig()).toBe(15);
    expect(worker.terminated).toBe(true);
  });

  it('kill ends the process at once with 137 and releases everything', async () => {
    const { read, write } = openPipe();
    const fds = new FdTable();
    fds.install(write);
    const worker = fakeWorker(() => new Promise(() => {}));
    const handle = spawnWasmProcess({
      pid: 3004,
      program,
      argv0: 'yes',
      args: [],
      env: {},
      cwd: '/',
      fds,
      fs: memFs({}),
      createWorker: () => worker,
    });
    handle.kill();
    expect(await handle.exited).toBe(137);
    expect(worker.terminated).toBe(true);
    expect(await read.file.read!(8)).toHaveLength(0);
  });

  it('announces the descriptors beyond stdio the program starts with', async () => {
    let seen: number[] | undefined;
    const fds = new FdTable();
    for (const n of [0, 1, 2, 97])
      fds.installAt(
        n,
        sinkFile(() => {})
      );
    const handle = spawnWasmProcess({
      pid: 3006,
      program,
      argv0: 'x',
      args: [],
      env: {},
      cwd: '/',
      fds,
      fs: memFs({}),
      createWorker: () =>
        fakeWorker(async (_call, init) => {
          seen = init.fds;
          return 0;
        }),
    });
    expect(await handle.exited).toBe(0);
    expect(seen).toEqual([97]);
  });

  it('a worker failure resolves to 70 with a diagnostic', async () => {
    const onError = vi.fn();
    const worker = fakeWorker(() => new Promise(() => {}));
    const handle = spawnWasmProcess({
      pid: 3005,
      program,
      argv0: 'x',
      args: [],
      env: {},
      cwd: '/',
      fds: new FdTable(),
      fs: memFs({}),
      createWorker: () => worker,
      onError,
    });
    worker.fail('boom');
    expect(await handle.exited).toBe(70);
    expect(onError).toHaveBeenCalledWith('boom');

    expect(worker.lastError?.preventDefault).toHaveBeenCalled();
  });
});
