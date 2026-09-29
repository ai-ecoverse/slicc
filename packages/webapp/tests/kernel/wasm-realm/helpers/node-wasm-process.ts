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
import type { ChildSpawner } from '../../../../src/kernel/wasm-realm/children.js';
import {
  bytesSource,
  FdTable,
  nullFile,
  sinkFile,
} from '../../../../src/kernel/wasm-realm/fd-table.js';
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
export function nodeWorker(file: string): WasmWorkerLike {
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

/**
 * A read-only filesystem holding `files` (absolute path → contents) and their
 * directories: the programs here otherwise use only sockets, pipes, stdio
 * and their own /tmp.
 */
function memoryFs(files: Readonly<Record<string, string>> = {}): SpawnWasmOptions['fs'] {
  const bytes = new Map(Object.entries(files).map(([p, c]) => [p, new TextEncoder().encode(c)]));
  const isDir = (path: string) =>
    path === '/' || [...bytes.keys()].some((p) => p.startsWith(`${path.replace(/\/$/, '')}/`));
  const enoent = (path: string) => Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
  const stat = async (path: string) => {
    const file = bytes.get(path);
    if (!file && !isDir(path)) throw enoent(path);
    return {
      isFile: Boolean(file),
      isDirectory: !file,
      isSymbolicLink: false,
      size: file?.length ?? 0,
      mode: file ? 0o100644 : 0o40755,
      mtime: new Date(0),
    };
  };
  return {
    resolvePath: (cwd: string, path: string) => (path.startsWith('/') ? path : `${cwd}/${path}`),
    exists: async (path: string) => bytes.has(path) || isDir(path),
    stat,
    lstat: stat,
    readFileBuffer: async (path: string) => {
      const file = bytes.get(path);
      if (!file) throw enoent(path);
      return file;
    },
    readdir: async (path: string) => {
      const prefix = `${path.replace(/\/$/, '')}/`;
      return [
        ...new Set(
          [...bytes.keys()]
            .filter((p) => p.startsWith(prefix))
            .map((p) => p.slice(prefix.length).split('/')[0])
        ),
      ];
    },
  } as unknown as SpawnWasmOptions['fs'];
}

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

/**
 * Start `program` with `args` and `env` on the loopback network `net`, over
 * a filesystem of `files`; stdin is `stdin` (default /dev/null). Every child it spawns runs `program` again (with the argv it
 * asked for) on the descriptors the kernel built for it, and writes where
 * those lead: stdout / stderr here, unless redirected.
 */
export function runProgram(
  workerFile: string,
  program: WasmProgram,
  args: string[],
  net: LoopbackNet,
  argv0 = 'socktest',
  env: Record<string, string> = {},
  files: Readonly<Record<string, string>> = {},
  stdin?: Uint8Array
): RunningProgram {
  const fs = memoryFs(files);
  const out: string[] = [];
  const err: string[] = [];
  const waiters: Array<() => void> = [];
  const decoder = new TextDecoder();
  const fds = new FdTable();
  fds.installAt(0, stdin ? bytesSource(stdin) : nullFile());
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
  const start = (argv: string[], table: FdTable) =>
    spawnWasmProcess({
      pid: nextPid++,
      program,
      argv0,
      args: argv,
      env,
      cwd: '/',
      fds: table,
      fs,
      net,
      createWorker: () => nodeWorker(workerFile),
      onError: (message) => err.push(message),
      spawner,
    });
  const spawner: ChildSpawner = async (req, table) => {
    const child = start(req.argv.slice(1), table);
    return { pid: child.pid, exited: child.exited, termsig: child.termsig };
  };
  const handle = start(args, fds);
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
