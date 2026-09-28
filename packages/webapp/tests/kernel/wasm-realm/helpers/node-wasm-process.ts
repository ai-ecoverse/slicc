/**
 * Run a real Emscripten program as a wasm-realm process in Node: the kernel
 * side is the production `spawnWasmProcess` (fd table, SAB responder,
 * syscalls), the process side the production runtime in a `worker_threads`
 * worker (`node-process-worker.ts`, bundled once with esbuild).
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { build } from 'esbuild';
import { FdTable, nullFile, sinkFile } from '../../../../src/kernel/wasm-realm/fd-table.js';
import {
  type SpawnWasmOptions,
  spawnWasmProcess,
  type WasmWorkerLike,
} from '../../../../src/kernel/wasm-realm/host.js';
import type { WasmProgram } from '../../../../src/kernel/wasm-realm/protocol.js';
import type { LoopbackNet } from '../../../../src/kernel/wasm-realm/socket.js';

/** The bundled worker entry: build it once, before the first process. */
export async function bundleProcessWorker(): Promise<{ file: string; dispose(): void }> {
  const dir = mkdtempSync(join(tmpdir(), 'slicc-wasm-worker-'));
  const file = join(dir, 'node-process-worker.mjs');
  await build({
    entryPoints: [new URL('./node-process-worker.ts', import.meta.url).pathname],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: file,
    logLevel: 'silent',
  });
  return { file, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

/** A `worker_threads` Worker as the kernel host's DedicatedWorker. */
function nodeWorker(file: string): WasmWorkerLike {
  const worker = new Worker(file);
  const wrapped = new Map<(event: MessageEvent) => void, (arg: unknown) => void>();
  return {
    postMessage: (message, transfer) =>
      worker.postMessage(message, transfer as unknown as readonly ArrayBuffer[]),
    addEventListener(type, handler) {
      const listener =
        type === 'message'
          ? (data: unknown) => handler({ data } as MessageEvent)
          : (err: unknown) =>
              handler({ message: String(err), preventDefault() {} } as unknown as MessageEvent);
      wrapped.set(handler, listener);
      worker.on(type, listener);
    },
    removeEventListener(type, handler) {
      const listener = wrapped.get(handler);
      if (listener) worker.off(type, listener);
    },
    terminate: () => void worker.terminate(),
  };
}

/** A program's glue and compiled module: `x` + `x.wasm`, or `x.js` + `x.wasm`. */
export async function loadProgram(glue: string): Promise<WasmProgram> {
  const wasm = glue.endsWith('.js') ? `${glue.slice(0, -3)}.wasm` : `${glue}.wasm`;
  return {
    glue: readFileSync(glue, 'utf8'),
    module: await WebAssembly.compile(readFileSync(wasm)),
  };
}

/** A filesystem with nothing on it: the programs here only use sockets and stdio. */
const emptyFs = {
  resolvePath: (cwd: string, path: string) => (path.startsWith('/') ? path : `${cwd}/${path}`),
  readdir: async () => [],
  stat: async () => {
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  },
} as unknown as SpawnWasmOptions['fs'];

let nextPid = 7000;

export interface RunningProgram {
  /** Everything written to stdout / stderr so far. */
  stdout(): string;
  stderr(): string;
  /** Resolves once stdout contains `text`. */
  waitFor(text: string): Promise<void>;
  exited: Promise<number>;
  kill(): void;
}

/** Start `program` with `args` on the loopback network `net`; stdin is /dev/null. */
export function runProgram(
  workerFile: string,
  program: WasmProgram,
  args: string[],
  net: LoopbackNet,
  argv0 = 'socktest'
): RunningProgram {
  const out: string[] = [];
  const err: string[] = [];
  const waiters: Array<() => void> = [];
  const decoder = new TextDecoder();
  const fds = new FdTable();
  fds.installAt(0, nullFile());
  fds.installAt(
    1,
    sinkFile((bytes) => {
      out.push(decoder.decode(bytes));
      for (const wake of waiters.splice(0)) wake();
    })
  );
  fds.installAt(
    2,
    sinkFile((bytes) => err.push(decoder.decode(bytes)))
  );
  const handle = spawnWasmProcess({
    pid: nextPid++,
    program,
    argv0,
    args,
    env: {},
    cwd: '/',
    fds,
    fs: emptyFs,
    net,
    createWorker: () => nodeWorker(workerFile),
    onError: (message) => err.push(message),
  });
  const stdout = () => out.join('');
  let ended = false;
  void handle.exited.then(() => {
    ended = true;
    for (const wake of waiters.splice(0)) wake();
  });
  return {
    stdout,
    stderr: () => err.join(''),
    async waitFor(text) {
      while (!stdout().includes(text)) {
        if (ended) throw new Error(`exited before printing ${JSON.stringify(text)}: ${stdout()}`);
        await new Promise<void>((resolve) => waiters.push(resolve));
      }
    },
    exited: handle.exited,
    kill: () => handle.kill(),
  };
}
