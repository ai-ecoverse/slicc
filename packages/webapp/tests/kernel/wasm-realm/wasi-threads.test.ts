/**
 * Threads of a WASI process (#3530 phase 5d), in Node worker threads against
 * the production kernel and a real VirtualFS: `threadtest` (Rust,
 * wasm32-wasip1-threads) spawns threads through `wasi.thread-spawn`, the
 * kernel starts a worker for each on the process's shared memory, and they
 * share its descriptor table, its exit and its thread cap.
 */
import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { VirtualFS } from '../../../src/fs/virtual-fs.js';
import { FdTable, nullFile, openPipe, sinkFile } from '../../../src/kernel/wasm-realm/fd-table.js';
import { spawnWasmProcess } from '../../../src/kernel/wasm-realm/host.js';
import type { WasmProgram } from '../../../src/kernel/wasm-realm/protocol.js';
import { SIG } from '../../../src/kernel/wasm-realm/signals.js';
import { LoopbackNet } from '../../../src/kernel/wasm-realm/socket.js';
import { importedMemory } from '../../../src/kernel/wasm-realm/wasi/wasi-module.js';
import { VfsAdapter } from '../../../src/shell/vfs-adapter.js';
import { bundleProcessWorker, nodeWorker } from './helpers/node-wasm-process.js';

const FIXTURE = new URL('../../fixtures/wasm-wasi/threadtest.wasm', import.meta.url).pathname;

let worker: { file: string; dispose(): void };
let fs: VfsAdapter;
let program: WasmProgram;
let nextPid = 44000;
/** Workers started (the process's and its threads'), per run. */
let started = 0;

beforeAll(async () => {
  worker = await bundleProcessWorker();
  const vfs = await VirtualFS.create({ dbName: `wasi-threads-${Math.random()}`, wipe: true });
  await vfs.mkdir('/workspace', { recursive: true });
  fs = new VfsAdapter(vfs);
  const bytes = readFileSync(FIXTURE);
  const memory = importedMemory(bytes);
  program = {
    abi: 'wasi',
    glue: '',
    module: new WebAssembly.Module(bytes),
    ...(memory ? { memory } : {}),
  };
}, 120_000);

afterAll(() => worker?.dispose());

async function run(args: string[], env: Record<string, string> = {}) {
  let stdout = '';
  let stderr = '';
  started = 0;
  const dec = new TextDecoder();
  const fds = new FdTable();
  fds.installAt(0, nullFile());
  fds.installAt(
    1,
    sinkFile((b) => void (stdout += dec.decode(b, { stream: true })))
  );
  fds.installAt(
    2,
    sinkFile((b) => void (stderr += dec.decode(b, { stream: true })))
  );
  const code = await spawnWasmProcess({
    pid: nextPid++,
    program,
    argv0: 'threadtest',
    args,
    env: { HOME: '/home', ...env },
    cwd: '/workspace',
    fds,
    fs: fs as never,
    net: new LoopbackNet(),
    createWorker: () => {
      started++;
      return nodeWorker(worker.file);
    },
    onError: (m) => void (stderr += m),
  }).exited;
  return { code, stdout, stderr, workers: started };
}

describe('WASI threads (wasm32-wasip1-threads)', () => {
  it('threads run on the shared memory, a worker each, and join', async () => {
    const r = await run(['sum']);
    expect(r).toMatchObject({ code: 0, stderr: '' });
    expect(r.stdout).toBe(`sum ${[0, 1, 2, 3].reduce((s, i) => s + i * 4999950000, 0)}\n`);
    expect(r.workers).toBe(5);
  });

  it('one descriptor table: a file opened in one thread is written and read in another', async () => {
    const r = await run(['files']);
    expect(r).toMatchObject({ code: 0, stderr: '' });
    expect(r.stdout).toBe('from a thread\nfrom main\nlen 24\n');
    expect(new TextDecoder().decode(await fs.readFileBuffer('/workspace/shared.txt'))).toBe(
      'from a thread\nfrom main\n'
    );
  });

  it('threads write to the process stdout', async () => {
    const r = await run(['stdout']);
    expect(r.code).toBe(0);
    expect(r.stdout.split('\n').filter(Boolean).sort()).toEqual([
      'thread 0',
      'thread 1',
      'thread 2',
    ]);
  });

  it('exit() in a thread ends the process, every thread with it', async () => {
    const t0 = performance.now();
    const r = await run(['exit']);
    expect(r).toMatchObject({ code: 3, stdout: '' });
    expect(performance.now() - t0).toBeLessThan(10_000);
  });

  it('the thread cap refuses a spawn past it (SLICC_WASM_THREADS), and frees as threads end', async () => {
    const r = await run(['cap', '10'], { SLICC_WASM_THREADS: '4' });
    expect(r).toMatchObject({ code: 0, stderr: '' });
    expect(r.stdout).toBe('spawned 3 of 10\nagain 7\n');
  });

  it('a signal ends the process with every thread, blocked ones included (their workers terminate)', async () => {
    let stdout = '';
    const terminated: number[] = [];
    let n = 0;
    const stdin = openPipe(); // never written, never closed: a thread blocks reading it
    const fds = new FdTable();
    fds.installAt(0, stdin.read);
    fds.installAt(
      1,
      sinkFile((b) => void (stdout += new TextDecoder().decode(b)))
    );
    fds.installAt(2, nullFile());
    const handle = spawnWasmProcess({
      pid: nextPid++,
      program,
      argv0: 'threadtest',
      args: ['block'],
      env: {},
      cwd: '/workspace',
      fds,
      fs: fs as never,
      net: new LoopbackNet(),
      createWorker: () => {
        const id = n++;
        const w = nodeWorker(worker.file);
        const terminate = w.terminate.bind(w);
        w.terminate = () => {
          terminated.push(id);
          terminate();
        };
        return w;
      },
    });
    for (let i = 0; i < 200 && !stdout.includes('blocked'); i++)
      await new Promise((r) => setTimeout(r, 25));
    expect(stdout).toBe('blocked\n');
    await new Promise((r) => setTimeout(r, 100)); // both threads parked in their syscalls
    handle.signal(SIG.TERM);
    expect(await handle.exited).toBe(128 + SIG.TERM);
    expect(n).toBe(3);
    expect(terminated.sort()).toEqual([0, 1, 2]);
    void stdin.write.release();
  });

  it('threads sleep concurrently (each its own poll_oneoff)', async () => {
    const r = await run(['sleep']);
    expect(r).toMatchObject({ code: 0, stdout: 'overlapped true\n' });
  });
});
