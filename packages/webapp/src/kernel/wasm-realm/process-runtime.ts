import { type EmscriptenFsForHook, mountVfsIntoEmscripten } from '../realm/emscripten-vfs-hook.js';
import { SyncFsCache } from '../realm/sync-fs-cache.js';
import {
  createSyncFsSabBridge,
  createSyncSabTransport,
  type SabPostLike,
  type SyncSabTransport,
} from '../realm/sync-sab-bridge.js';
import type { WasmProcessInitMsg } from './protocol.js';

const WASI_ERRNO: Readonly<Partial<Record<string, number>>> = {
  EBADF: 8,
  EINVAL: 28,
  EIO: 29,
  EMFILE: 33,
  EPIPE: 64,
};

export class SyscallError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export interface ProcessSys {
  read(fd: number, max: number): Uint8Array;

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

export interface ProcessFs extends EmscriptenFsForHook {
  getStream(fd: number): { stream_ops: StreamOps } | null;
  mkdirTree(path: string): void;
}

interface StreamOps {
  read?: (stream: unknown, buffer: Uint8Array, offset: number, length: number) => number;
  write?: (stream: unknown, buffer: Uint8Array, offset: number, length: number) => number;
  fsync?: () => number;
}

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

interface RunningModule {
  FS: ProcessFs;
  callMain(args: string[]): number | undefined;
}

export type GlueEvaluator = (glue: string, module: object) => void;

export function glueBody(glue: string): string {
  return glue.startsWith('#!') ? glue.slice(glue.indexOf('\n') + 1) : glue;
}

const evaluateGlue: GlueEvaluator = (glue, module) => {
  let run: (module: object) => void;
  try {
    run = new Function('Module', `${glueBody(glue)}\n;Object.assign(ENV, Module.sliccEnv);`) as (
      module: object
    ) => void;
  } catch (e) {
    throw e instanceof EvalError ? new Error(EVAL_BLOCKED) : e;
  }
  run(module);
};

export const EVAL_BLOCKED =
  "the wasm realm evaluates the program's Emscripten glue, and this page's CSP forbids eval " +
  "(no 'unsafe-eval')";

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
      WebAssembly.instantiate(init.program.module, imports).then(
        (instance) => done(instance, init.program.module),
        failed
      );
      return {};
    },

    preRun: [
      (m: { FS: ProcessFs }) => {
        try {
          m.FS.mkdirTree(init.cwd);
          m.FS.chdir(init.cwd);
        } catch {}
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
    const status = (e as { status?: unknown })?.status;
    if (typeof status !== 'number') throw e;
    return status;
  } finally {
    vfs.flush();
  }
}
