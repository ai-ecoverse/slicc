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
import { mountVfsIntoEmscripten } from '../realm/emscripten-vfs-hook.js';
import { SyncFsCache } from '../realm/sync-fs-cache.js';
import type { SyncFsResult } from '../realm/sync-fs-wire.js';
import {
  createSyncFsSabBridge,
  createSyncSabTransport,
  type SabPostLike,
  type SyncSabTransport,
} from '../realm/sync-sab-bridge.js';
import type { SyncSabRequestBody } from '../realm/sync-sab-wire.js';
import type { PollState } from './fd-table.js';
import {
  KernelStreams,
  type ProcessFs,
  type ProcessPipeFs,
  type ProcessSys,
  SyscallError,
} from './kernel-streams.js';
import { createProcessKernel, type ProcessKernel } from './process-children.js';
import type { WasmProcessInitMsg } from './protocol.js';

export {
  type ProcessFs,
  type ProcessStream,
  type ProcessSys,
  SyscallError,
} from './kernel-streams.js';

export function kernelSys(transport: SyncSabTransport): ProcessSys {
  const call = (req: SyncSabRequestBody, label: string): SyncFsResult => {
    const r = transport.call(req, Number.POSITIVE_INFINITY, label);
    if (!r.ok) throw new SyscallError(r.errno);
    return r;
  };
  const json = (r: SyncFsResult): unknown => (r.ok && r.kind === 'json' ? r.json : undefined);
  return {
    read(fd, max) {
      const r = call({ op: 'fd-read', fd, max }, `fd-read ${fd}`);
      return r.ok && r.kind === 'bytes' ? r.bytes : new Uint8Array(0);
    },
    write(fd, bytes) {
      const n = json(call({ op: 'fd-write', fd, body: bytes }, `fd-write ${fd}`));
      return typeof n === 'number' ? n : bytes.length;
    },
    close(fd) {
      call({ op: 'fd-close', fd }, `fd-close ${fd}`);
    },
    pipe() {
      return json(call({ op: 'fd-pipe' }, 'fd-pipe')) as [number, number];
    },
    poll(fd) {
      return json(call({ op: 'fd-poll', fd }, `fd-poll ${fd}`)) as PollState;
    },
  };
}

/** Point fds 0, 1, 2 of the module's FS at the kernel descriptors of the same numbers. */
export function wireKernelStdio(Fs: ProcessFs, streams: KernelStreams): void {
  for (const fd of [0, 1, 2]) {
    const stream = Fs.getStream(fd);
    if (stream) streams.attach(stream, fd);
  }
}

/** The Emscripten `Module` surface after the runtime is up. */
interface RunningModule {
  FS: ProcessFs;
  callMain(args: string[]): number | undefined;
  sliccRunMain?: (args: string[]) => number | undefined;
  PIPEFS?: ProcessPipeFs;
  /** posix_spawn / waitpid for the toolchain's libc shims. */
  sliccKernel?: ProcessKernel;
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
  "if (typeof sliccRunMain === 'function') Module.sliccRunMain ??= sliccRunMain;",
  "if (typeof PIPEFS !== 'undefined') Module.PIPEFS ??= PIPEFS;",
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
  const streams = new KernelStreams(running.FS, sys);
  wireKernelStdio(running.FS, streams);
  if (running.PIPEFS) streams.usePipes(running.PIPEFS);
  running.sliccKernel = createProcessKernel({
    transport,
    Fs: running.FS,
    env: init.env,
    beforeSpawn: () => vfs.flush(),
    afterChild: () => vfs.invalidate(),
  });
  try {
    // A program with the fork emulation (slicc-fork.js) drives its forks from sliccRunMain.
    return (running.sliccRunMain ?? running.callMain)(init.args) ?? 0;
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
