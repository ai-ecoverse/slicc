import { mountVfsIntoEmscripten } from '../realm/emscripten-vfs-hook.js';
import { type LiveFsNode, liveNodePath } from '../realm/live-vfs-fs.js';
import { SyncFsCache } from '../realm/sync-fs-cache.js';
import type { SyncFsResult } from '../realm/sync-fs-wire.js';
import {
  createSyncFsSabBridge,
  createSyncSabTransport,
  type SabPostLike,
  type SyncSabTransport,
} from '../realm/sync-sab-bridge.js';
import { SAB_HEADER_I32, type SyncSabRequestBody } from '../realm/sync-sab-wire.js';
import type { PollState } from './fd-table.js';
import {
  KernelStreams,
  type ProcessFs,
  type ProcessPipeFs,
  type ProcessSys,
  SyscallError,
} from './kernel-streams.js';
import { createProcessKernel, type ProcessKernel } from './process-children.js';
import { describeForFork, restoreForkedStreams } from './process-fork.js';
import { SignalGate } from './process-signals.js';
import type { ForkState, WasmProcessInitMsg } from './protocol.js';
import type { Termios } from './tty.js';

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
    openVfs(path, flags, position, opts) {
      return json(
        call(
          {
            op: 'fd-open-vfs',
            path,
            flags,
            position,
            ...(opts?.contents !== undefined ? { contents: opts.contents } : {}),
            ...(opts?.orphan ? { orphan: true } : {}),
          },
          `fd-open-vfs ${path}`
        )
      ) as number;
    },
    seek(fd, offset, whence) {
      return json(call({ op: 'fd-seek', fd, offset, whence }, `fd-seek ${fd}`)) as number;
    },
    flush(fd) {
      call({ op: 'fd-flush', fd }, `fd-flush ${fd}`);
    },
    isatty(fd) {
      return (
        (json(call({ op: 'fd-info', fd }, `fd-info ${fd}`)) as { tty?: boolean })?.tty === true
      );
    },
    tcgets(fd) {
      return json(call({ op: 'tty-get', fd }, `tty-get ${fd}`)) as Termios;
    },
    tcsets(fd, termios) {
      call({ op: 'tty-set', fd, termios }, `tty-set ${fd}`);
    },
    winsize(fd) {
      return json(call({ op: 'tty-winsz', fd }, `tty-winsz ${fd}`)) as [number, number];
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
  sliccForkChild?: (state: ForkState & { pid: number }) => number | undefined;
  PIPEFS?: ProcessPipeFs;

  sliccSigpipe?: () => number;

  sliccSigMask?: (which: number) => number;

  sliccRaise?: (sig: number) => void;

  sliccKernel?: ProcessKernel;
}

export type GlueEvaluator = (glue: string, module: object) => void;

export function glueBody(glue: string): string {
  return glue.startsWith('#!') ? glue.slice(glue.indexOf('\n') + 1) : glue;
}

const GLUE_TRAILER = [
  'Object.assign(ENV, Module.sliccEnv);',
  'const __sliccTake = (name, value) => {',
  '  const own = Object.getOwnPropertyDescriptor(Module, name);',
  "  if (own && 'value' in own && own.value != null) return;",
  '  Object.defineProperty(Module, name, { value, writable: true, configurable: true, enumerable: true });',
  '};',
  "if (typeof FS !== 'undefined') __sliccTake('FS', FS);",
  "if (typeof callMain === 'function') __sliccTake('callMain', callMain);",
  "if (typeof sliccRunMain === 'function') __sliccTake('sliccRunMain', sliccRunMain);",
  "if (typeof sliccForkChild === 'function') __sliccTake('sliccForkChild', sliccForkChild);",
  "if (typeof PIPEFS !== 'undefined') __sliccTake('PIPEFS', PIPEFS);",

  "Module.sliccSigpipe ??= () => (typeof _slicc_sigpipe === 'function' ? _slicc_sigpipe() : -1);",

  "Module.sliccSigMask ??= (w) => (typeof _slicc_sig_mask === 'function' ? _slicc_sig_mask(w) : -1);",
  "Module.sliccRaise ??= (sig) => { if (typeof _slicc_raise === 'function') _slicc_raise(sig); };",
].join('\n');

export function ownValue<T>(module: object, name: string): T | undefined {
  const own = Object.getOwnPropertyDescriptor(module, name);
  return own && 'value' in own ? (own.value as T | undefined) : undefined;
}

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

export function signalMasks(
  m: Pick<RunningModule, 'sliccSigMask'>
): { caught: number; ignored: number; restart: number } | null {
  const mask = m.sliccSigMask;
  const caught = mask?.(0) ?? -1;
  if (!mask || caught === -1) return null;
  return { caught, ignored: mask(1), restart: mask(2) };
}

export async function runWasmProcess(
  init: WasmProcessInitMsg,
  port: SabPostLike,
  deps: { evaluate?: GlueEvaluator; warn?: (message: string) => void } = {}
): Promise<number> {
  const signals = new SignalGate(
    createSyncSabTransport(init.sab, port),
    new Int32Array(init.sab, 0, SAB_HEADER_I32),
    {
      masks: () => signalMasks(module as unknown as RunningModule),
      raise: (sig) => (module as unknown as RunningModule).sliccRaise?.(sig),
    }
  );
  const transport = signals.transport();
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
    sliccPid: init.pid,
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
  const streams = new KernelStreams(running.FS, sys, {
    sigpipe: () => running.sliccSigpipe?.() === 1,
    restartable: () => signals.restartable(),
  });
  if (init.fork) restoreForkedStreams(running.FS, streams, init.fork.streams ?? []);
  else wireKernelStdio(running.FS, streams);
  const pipefs = ownValue<ProcessPipeFs>(running, 'PIPEFS');
  if (pipefs) streams.usePipes(pipefs);
  streams.useControllingTerminal();
  running.sliccKernel = createProcessKernel({
    transport,
    Fs: running.FS,
    env: init.env,
    beforeSpawn: () => vfs.flush(),
    afterChild: () => vfs.invalidate(),
    pid: init.pid,
    raise: (sig) => running.sliccRaise?.(sig),
    restartable: () => signals.restartable(),
    describeFork: () =>
      describeForFork(running.FS, sys, streams, (s) =>
        liveNodePath(s.node as unknown as LiveFsNode)
      ),
  });
  try {
    if (init.fork) {
      if (!running.sliccForkChild) throw new Error(`${init.argv0} cannot resume a fork`);
      return running.sliccForkChild({ ...init.fork, pid: init.pid }) ?? 0;
    }

    return (running.sliccRunMain ?? running.callMain)(init.args) ?? 0;
  } catch (e) {
    const status = (e as { status?: unknown })?.status;
    if (typeof status !== 'number') throw e;
    return status;
  } finally {
    vfs.flush();
  }
}
