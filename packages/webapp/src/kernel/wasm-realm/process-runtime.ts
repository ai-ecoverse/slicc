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

export function wireKernelStdio(Fs: ProcessFs, streams: KernelStreams): void {
  for (const fd of [0, 1, 2]) {
    const stream = Fs.getStream(fd);
    if (stream) streams.attach(stream, fd);
  }
}

interface RunningModule {
  FS: ProcessFs;
  callMain(args: string[]): number | undefined;
  sliccRunMain?: (args: string[]) => number | undefined;
  PIPEFS?: ProcessPipeFs;

  sliccSigpipe?: () => number;

  sliccKernel?: ProcessKernel;
}

export type GlueEvaluator = (glue: string, module: object) => void;

export function glueBody(glue: string): string {
  return glue.startsWith('#!') ? glue.slice(glue.indexOf('\n') + 1) : glue;
}

const GLUE_TRAILER = [
  'Object.assign(ENV, Module.sliccEnv);',
  "if (typeof FS !== 'undefined') Module.FS ??= FS;",
  "if (typeof callMain === 'function') Module.callMain ??= callMain;",
  "if (typeof sliccRunMain === 'function') Module.sliccRunMain ??= sliccRunMain;",
  "if (typeof PIPEFS !== 'undefined') Module.PIPEFS ??= PIPEFS;",

  "Module.sliccSigpipe ??= () => (typeof _slicc_sigpipe === 'function' ? _slicc_sigpipe() : -1);",
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
  const streams = new KernelStreams(running.FS, sys, () => running.sliccSigpipe?.() === 1);
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
    return (running.sliccRunMain ?? running.callMain)(init.args) ?? 0;
  } catch (e) {
    const status = (e as { status?: unknown })?.status;
    if (typeof status !== 'number') throw e;
    return status;
  } finally {
    vfs.flush();
  }
}
