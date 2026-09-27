/**
 * `process-runtime.ts` — one Emscripten program inside a wasm-realm process
 * worker (#3530). The worker entry (`process-worker.ts`) is a thin wrapper;
 * this module is the part tests can drive without a real worker.
 *
 * - The glue runs with our `Module`: the kernel compiled the wasm already
 *   (`instantiateWasm`), `argv[0]` selects the program of a multi-call
 *   binary, and the environment is copied into Emscripten's `ENV`.
 * - Files: the live VFS is mounted into the module's FS over the SAB bridge,
 *   as `__slicc_mountVfs` does in the node realm.
 * - fds 0, 1, 2 are kernel descriptors: every read and write is a blocking
 *   `fd-read` / `fd-write` syscall, byte-exact. A read on an empty pipe parks
 *   this worker in `Atomics.wait` until a writer (another process) delivers.
 */
import { type EmscriptenFsForHook, mountVfsIntoEmscripten } from '../realm/emscripten-vfs-hook.js';
import { SyncFsCache } from '../realm/sync-fs-cache.js';
import {
  createSyncFsSabBridge,
  createSyncSabTransport,
  type SabPostLike,
  type SyncSabTransport,
} from '../realm/sync-sab-bridge.js';
import type { WasmProcessInitMsg } from './protocol.js';

/** Emscripten's (WASI) errno numbers for the kernel errors a syscall returns. */
const WASI_ERRNO: Readonly<Partial<Record<string, number>>> = {
  EBADF: 8,
  EINVAL: 28,
  EIO: 29,
  EMFILE: 33,
  EPIPE: 64,
};

/** A kernel error from a syscall, carrying its errno name. */
export class SyscallError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

/** The blocking syscalls a process makes on its kernel descriptors. */
export interface ProcessSys {
  /** Up to `max` bytes; empty at end of file. */
  read(fd: number, max: number): Uint8Array;
  /** Bytes written (all of them). */
  write(fd: number, bytes: Uint8Array): number;
}

export function kernelSys(transport: SyncSabTransport): ProcessSys {
  return {
    read(fd, max) {
      const r = transport.call(
        { op: 'fd-read', fd, max },
        Number.POSITIVE_INFINITY,
        `fd-read ${fd}`
      );
      if (!r.ok) throw new SyscallError(r.errno);
      return r.kind === 'bytes' ? r.bytes : new Uint8Array(0);
    },
    write(fd, bytes) {
      const r = transport.call(
        { op: 'fd-write', fd, body: bytes },
        Number.POSITIVE_INFINITY,
        `fd-write ${fd}`
      );
      if (!r.ok) throw new SyscallError(r.errno);
      return r.kind === 'json' && typeof r.json === 'number' ? r.json : bytes.length;
    },
  };
}

/** The slice of Emscripten's FS the runtime uses. */
export interface ProcessFs extends EmscriptenFsForHook {
  getStream(fd: number): { stream_ops: StreamOps } | null;
  mkdirTree(path: string): void;
}

interface StreamOps {
  read?: (stream: unknown, buffer: Uint8Array, offset: number, length: number) => number;
  write?: (stream: unknown, buffer: Uint8Array, offset: number, length: number) => number;
  fsync?: () => number;
}

/** Point fds 0, 1, 2 of the module's FS at the kernel descriptors of the same numbers. */
export function wireKernelStdio(Fs: ProcessFs, sys: ProcessSys): void {
  const fail = (e: unknown): never => {
    if (e instanceof SyscallError) throw new Fs.ErrnoError(WASI_ERRNO[e.code] ?? WASI_ERRNO.EIO!);
    throw e;
  };
  for (const fd of [0, 1, 2]) {
    const stream = Fs.getStream(fd);
    if (!stream) continue;
    stream.stream_ops = {
      ...stream.stream_ops,
      read: (_s, buffer, offset, length) => {
        try {
          const bytes = sys.read(fd, length);
          buffer.set(bytes, offset);
          return bytes.length;
        } catch (e) {
          return fail(e);
        }
      },
      write: (_s, buffer, offset, length) => {
        try {
          return sys.write(fd, buffer.slice(offset, offset + length));
        } catch (e) {
          return fail(e);
        }
      },
      fsync: () => 0,
    };
  }
}

/** The Emscripten `Module` surface after the runtime is up. */
interface RunningModule {
  FS: ProcessFs;
  callMain(args: string[]): number | undefined;
}

/** Evaluate the glue with `Module` (overridable in tests). */
export type GlueEvaluator = (glue: string, module: object) => void;

/** The glue without the `#!/usr/bin/env node` line of an extensionless Emscripten output. */
export function glueBody(glue: string): string {
  return glue.startsWith('#!') ? glue.slice(glue.indexOf('\n') + 1) : glue;
}

/**
 * Runs in the glue's scope right after its body. ENV, FS and callMain are the
 * glue's own variables: ENV is filled before the (asynchronous) instantiation
 * reads it, and FS and callMain are taken from the scope, so a program linked
 * without exporting them (`-sEXPORTED_RUNTIME_METHODS`) still runs.
 */
const GLUE_TRAILER = [
  'Object.assign(ENV, Module.sliccEnv);',
  "if (typeof FS !== 'undefined') Module.FS ??= FS;",
  "if (typeof callMain === 'function') Module.callMain ??= callMain;",
].join('\n');

export const evaluateGlue: GlueEvaluator = (glue, module) => {
  let run: (module: object) => void;
  try {
    run = new Function('Module', `${glueBody(glue)}\n;${GLUE_TRAILER}`) as (module: object) => void;
  } catch (e) {
    throw e instanceof EvalError ? new Error(EVAL_BLOCKED) : e;
  }
  run(module);
};

/** The page's CSP forbids eval, which evaluating the Emscripten glue needs. */
export const EVAL_BLOCKED =
  "the wasm realm evaluates the program's Emscripten glue, and this page's CSP forbids eval " +
  "(no 'unsafe-eval')";

/** Run the program of `init` to completion; resolves to its exit code. */
export async function runWasmProcess(
  init: WasmProcessInitMsg,
  port: SabPostLike,
  deps: { evaluate?: GlueEvaluator; warn?: (message: string) => void } = {}
): Promise<number> {
  const transport = createSyncSabTransport(init.sab, port);
  const sys = kernelSys(transport);
  const encoder = new TextEncoder();
  const say = (fd: number) => (text: string) => sys.write(fd, encoder.encode(`${text}\n`));
  let ready!: () => void;
  let failed!: (error: unknown) => void;
  const initialized = new Promise<void>((resolve, reject) => {
    ready = resolve;
    failed = reject;
  });
  const module = {
    noInitialRun: true,
    thisProgram: init.argv0,
    sliccEnv: init.env,
    print: say(1),
    printErr: say(2),
    instantiateWasm(
      imports: WebAssembly.Imports,
      done: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void
    ): object {
      // A module that cannot satisfy the glue's imports (a mismatched .js and
      // .wasm) fails the process instead of leaving it waiting forever.
      WebAssembly.instantiate(init.program.module, imports).then(
        (instance) => done(instance, init.program.module),
        failed
      );
      return {};
    },
    // Static constructors may read the cwd: stand it up before they run.
    preRun: [
      (m: { FS: ProcessFs }) => {
        try {
          m.FS.mkdirTree(init.cwd);
          m.FS.chdir(init.cwd);
        } catch {
          /* mounted over below */
        }
      },
    ],
    onRuntimeInitialized: () => ready(),
  };
  (deps.evaluate ?? evaluateGlue)(init.program.glue, module);
  await initialized;
  const running = module as unknown as RunningModule;
  const vfs = mountVfsIntoEmscripten(
    running.FS,
    {
      bridge: createSyncFsSabBridge(transport),
      syncFs: new SyncFsCache({ entries: [] }),
      cwd: init.cwd,
      warn: deps.warn ?? say(2),
    },
    { cwd: init.cwd }
  );
  wireKernelStdio(running.FS, sys);
  try {
    return running.callMain(init.args) ?? 0;
  } catch (e) {
    // Emscripten signals exit() with an ExitStatus throw.
    const status = (e as { status?: unknown })?.status;
    if (typeof status !== 'number') throw e;
    return status;
  } finally {
    // Even when the program traps: what it wrote to open files must not be
    // lost with the worker.
    vfs.flush();
  }
}
