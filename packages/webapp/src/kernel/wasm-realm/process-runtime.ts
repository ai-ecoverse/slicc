/**
 * `process-runtime.ts` — one Emscripten program inside a wasm-realm process
 * worker (#3530). The worker entry (`process-worker.ts`) is a thin wrapper;
 * this module is the part tests can drive without a real worker.
 *
 * - The glue runs with our `Module`: the kernel compiled the wasm already
 *   (`instantiateWasm`), `argv[0]` selects the program of a multi-call
 *   binary, and the environment is copied into Emscripten's `ENV`.
 * - Files: the live VFS is mounted into the module's FS over the SAB bridge,
 *   as `__slicc_mountVfs` does in the node realm. A program that uses no files
 *   (printf only) is linked with Emscripten's minimal FS, a stub without
 *   streams: it runs on stdio alone, its output through `Module.print`.
 * - fds 0, 1, 2 are kernel descriptors: every read and write is a blocking
 *   `fd-read` / `fd-write` syscall, byte-exact. A read on an empty pipe parks
 *   this worker in `Atomics.wait` until a writer (another process) delivers.
 */
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
  type ProcessStream,
  type ProcessSys,
  SyscallError,
} from './kernel-streams.js';
import { createProcessKernel, type ProcessKernel } from './process-children.js';
import {
  type GlueSyscalls,
  trackCloseOnExec,
  useDevFd,
  wasmMemory,
  wrapCloexecSyscalls,
} from './process-fds.js';
import {
  describeForFork,
  describeInherited,
  placeKernelStream,
  restoreForkedStreams,
  vfsPromoter,
} from './process-fork.js';
import type { PtyKernel } from './process-pty.js';
import { SignalGate } from './process-signals.js';
import { createSocketKernel } from './process-sockets.js';
import type { ForkState, InheritedFd, WasmProcessInitMsg } from './protocol.js';
import { ownByRealmUser } from './realm-user.js';
import type { Termios } from './tty.js';

export {
  type ProcessFs,
  type ProcessStream,
  type ProcessSys,
  SyscallError,
} from './kernel-streams.js';

export function kernelSys(transport: SyncSabTransport): ProcessSys & PtyKernel {
  const call = (req: SyncSabRequestBody, label: string): SyncFsResult => {
    const r = transport.call(req, Number.POSITIVE_INFINITY, label);
    if (!r.ok) throw new SyscallError(r.errno);
    return r;
  };
  const json = (r: SyncFsResult): unknown => (r.ok && r.kind === 'json' ? r.json : undefined);
  return {
    read(fd, max, opts) {
      const flags = {
        ...(opts?.nonblock ? { nonblock: true } : {}),
        ...(opts?.peek ? { peek: true } : {}),
      };
      const r = call({ op: 'fd-read', fd, max, ...flags }, `fd-read ${fd}`);
      return r.ok && r.kind === 'bytes' ? r.bytes : new Uint8Array(0);
    },
    write(fd, bytes, opts) {
      const req = {
        op: 'fd-write' as const,
        fd,
        body: bytes,
        ...(opts?.nonblock ? { nonblock: true } : {}),
      };
      const n = json(call(req, `fd-write ${fd}`));
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
            ...(opts?.truncate ? { truncate: true } : {}),
            ...(opts?.create ? { create: true } : {}),
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
    pread(fd, max, at) {
      const r = call({ op: 'fd-pread', fd, max, offset: at }, `fd-pread ${fd}`);
      return r.ok && r.kind === 'bytes' ? r.bytes : new Uint8Array(0);
    },
    isatty(fd) {
      return (
        (json(call({ op: 'fd-info', fd }, `fd-info ${fd}`)) as { tty?: boolean })?.tty === true
      );
    },
    openTty() {
      return json(call({ op: 'fd-open-tty' }, 'fd-open-tty')) as number;
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
    openPty() {
      return json(call({ op: 'pty-open' }, 'pty-open')) as number;
    },
    openPts(n, noctty) {
      return json(call({ op: 'pty-slave-open', n, noctty }, `pty-slave-open ${n}`)) as number;
    },
    ptyNumbers() {
      return json(call({ op: 'pty-list' }, 'pty-list')) as number[];
    },
    ptyNumber(fd) {
      return json(call({ op: 'pty-number', fd }, `pty-number ${fd}`)) as number;
    },
    ptyLock(fd, lock) {
      call({ op: 'pty-lock', fd, lock }, `pty-lock ${fd}`);
    },
    setControllingTerminal(fd) {
      call({ op: 'pty-ctty', fd }, `pty-ctty ${fd}`);
    },
    setPacketMode(fd, on) {
      call({ op: 'pty-packet', fd, on }, `pty-packet ${fd}`);
    },
    setWinsize(fd, rows, cols) {
      call({ op: 'pty-winsz-set', fd, rows, cols }, `pty-winsz-set ${fd}`);
    },
  };
}

/**
 * Open fd `entry.fd` of the module's FS on the kernel descriptor of that
 * number (one the process started with beyond 0-2), backed as its kind says.
 */
export function wireKernelFd(Fs: ProcessFs, streams: KernelStreams, entry: InheritedFd): void {
  placeKernelStream(Fs, streams, { ...entry, kernel: entry.fd });
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
  sliccForkChild?: (state: ForkState & { pid: number }) => number | undefined;
  PIPEFS?: ProcessPipeFs;
  /** 1 when the program ignores or handles SIGPIPE (the toolchain's `slicc_sigpipe`). */
  sliccSigpipe?: () => number;
  /** Signal masks (0 caught, 1 ignored, 2 SA_RESTART); -1 without signal support. */
  sliccSigMask?: (which: number) => number;
  /** raise(sig) in the program. */
  sliccRaise?: (sig: number) => void;
  /** posix_spawn / waitpid for the toolchain's libc shims. */
  sliccKernel?: ProcessKernel;
  /** The glue's own fcntl, pipe2, … (the trailer hands them over to be wrapped). */
  sliccSyscalls?: GlueSyscalls;
}

/** Evaluate the glue with `Module` (overridable in tests). */
export type GlueEvaluator = (glue: string, module: object) => void;

/** The glue without the `#!/usr/bin/env node` line of an extensionless Emscripten output. */
export function glueBody(glue: string): string {
  return glue.startsWith('#!') ? glue.slice(glue.indexOf('\n') + 1) : glue;
}

/**
 * Runs in the glue's scope right after its body. ENV, FS and callMain are the
 * glue's own variables, each absent when the program does not use it: ENV is
 * filled before the (asynchronous) instantiation reads it, and FS and callMain
 * are taken from the scope, so a program linked without exporting them
 * (`-sEXPORTED_RUNTIME_METHODS`) still runs. With
 * assertions on (any `-O0` link) such a symbol is an accessor on `Module`
 * that aborts when read, so it is replaced without reading it.
 */
const GLUE_TRAILER = [
  // ENV exists only when the program reads its environment (getenv pulls it in).
  "if (typeof ENV !== 'undefined') Object.assign(ENV, Module.sliccEnv);",
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
  // The syscalls that must know FD_CLOEXEC (process-fds.ts), wrapped before instantiation.
  'Module.sliccSyscalls ??= {',
  "  fcntl: typeof ___syscall_fcntl64 === 'function' ? ___syscall_fcntl64 : undefined,",
  "  pipe2: typeof ___syscall_pipe2 === 'function' ? ___syscall_pipe2 : undefined,",
  "  dup3: typeof ___syscall_dup3 === 'function' ? ___syscall_dup3 : undefined,",
  "  socket: typeof ___syscall_socket === 'function' ? ___syscall_socket : undefined,",
  "  accept4: typeof ___syscall_accept4 === 'function' ? ___syscall_accept4 : undefined,",
  "  ioctl: typeof ___syscall_ioctl === 'function' ? ___syscall_ioctl : undefined,",
  '};',
  // The toolchain's SIGPIPE disposition query (exported once instantiated).
  // Only while the runtime is up: an assertions build (-O0) aborts on an
  // export called before it is initialized or after it exited, and syscalls
  // come during init and after exit (the final stdio flush) — an abort there
  // writes its message, whose syscall asks again, without end.
  'const __sliccUp = () =>',
  "  (typeof runtimeInitialized === 'undefined' || runtimeInitialized) &&",
  "  !(typeof runtimeExited !== 'undefined' && runtimeExited) &&",
  "  !(typeof ABORT !== 'undefined' && ABORT);",
  "Module.sliccSigpipe ??= () => (__sliccUp() && typeof _slicc_sigpipe === 'function' ? _slicc_sigpipe() : -1);",
  // The toolchain's signal support (slicc_signals.c): dispositions and raise().
  "Module.sliccSigMask ??= (w) => (__sliccUp() && typeof _slicc_sig_mask === 'function' ? _slicc_sig_mask(w) : -1);",
  "Module.sliccRaise ??= (sig) => { if (__sliccUp() && typeof _slicc_raise === 'function') _slicc_raise(sig); };",
  // The fork emulation (slicc-fork.js) rewinds past Asyncify's doRewind, so
  // the keepalive each fork's unwind pushed was never popped: after one fork,
  // exit() skipped exitRuntime, and with it the atexit handlers (git's wait
  // for its pager) and the final stdio flush. Pop it where the fork is taken,
  // unless the toolchain's own copy does (`balancesKeepalive`).
  "if (typeof SliccFork !== 'undefined' && !SliccFork.balancesKeepalive && typeof runtimeKeepalivePop === 'function') {",
  '  let __sliccForking = SliccFork.forking === true;',
  "  Object.defineProperty(SliccFork, 'forking', {",
  '    get: () => __sliccForking,',
  '    set: (on) => { if (__sliccForking && !on) runtimeKeepalivePop(); __sliccForking = on; },',
  '    configurable: true,',
  '  });',
  '}',
].join('\n');

/**
 * An optional runtime symbol of the module, without reading an accessor: an
 * assertions build defines unexported ones as getters that abort.
 */
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

/** The page's CSP forbids eval, which evaluating the Emscripten glue needs. */
export const EVAL_BLOCKED =
  "the wasm realm evaluates the program's Emscripten glue, and this page's CSP forbids eval " +
  "(no 'unsafe-eval')";

/**
 * The program's signal dispositions, or null when it was linked without
 * signal support. A mask is 32 bits as a signed int: signal 31 (SIGSYS, which
 * bash catches) makes it negative, so only -1 — every bit, impossible since
 * bit 0 is no signal — means "none".
 */
export function signalMasks(
  m: Pick<RunningModule, 'sliccSigMask'>
): { caught: number; ignored: number; restart: number } | null {
  const mask = m.sliccSigMask;
  const caught = mask?.(0) ?? -1;
  if (!mask || caught === -1) return null;
  return { caught, ignored: mask(1), restart: mask(2) };
}

/** Run the program of `init` to completion; resolves to its exit code. */
export async function runWasmProcess(
  init: WasmProcessInitMsg,
  port: SabPostLike,
  deps: { evaluate?: GlueEvaluator; warn?: (message: string) => void } = {}
): Promise<number> {
  // Every syscall goes through the signal gate: dispositions out, handlers in.
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
  let memory: WebAssembly.Memory | undefined;
  const initialized = new Promise<void>((resolve, reject) => {
    ready = resolve;
    failed = reject;
  });
  const module = {
    noInitialRun: true,
    thisProgram: init.argv0,
    sliccPid: init.pid,
    // getppid(): the toolchain's fork library adopts both (absent: the invocation's parent).
    ...(init.ppid !== undefined ? { sliccPpid: init.ppid } : {}),
    sliccEnv: init.env,
    print: say(1),
    printErr: say(2),
    instantiateWasm(
      imports: WebAssembly.Imports,
      done: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void
    ): object {
      // The glue asks while its body runs, before the trailer hands over the
      // syscalls to wrap: instantiate once it has. A module that cannot
      // satisfy the glue's imports (a mismatched .js and .wasm) fails the
      // process instead of leaving it waiting forever.
      Promise.resolve()
        .then(() => {
          wrapCloexecSyscalls(imports, ownValue<GlueSyscalls>(module, 'sliccSyscalls'), {
            fs: () => ownValue<ProcessFs>(module, 'FS'),
            heap: () => (memory ? new Int32Array(memory.buffer) : undefined),
            pty: sys,
          });
          return WebAssembly.instantiate(init.program.module, imports);
        })
        .then((instance) => {
          memory = wasmMemory(instance, imports);
          done(instance, init.program.module);
        }, failed);
      return {};
    },
    // Static constructors may read the cwd: stand it up before they run.
    preRun: [
      (m: object) => {
        // Emscripten runs this before onRuntimeInitialized: a program without
        // a FS (see runStdioOnly) has nothing to track or chdir.
        if (!hasStreams(m)) return;
        const fs = (m as RunningModule).FS;
        // Before static constructors: an open(O_CLOEXEC) of theirs counts too.
        trackCloseOnExec(fs);
        try {
          fs.mkdirTree(init.cwd);
          fs.chdir(init.cwd);
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
  if (!hasStreams(running)) return runStdioOnly(running, init);
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
  const sigpipe = (): boolean => running.sliccSigpipe?.() === 1;
  const restartable = (): boolean => signals.restartable();
  const streams = new KernelStreams(running.FS, sys, { sigpipe, restartable });
  trackCloseOnExec(running.FS);
  if (init.fork) restoreForkedStreams(running.FS, streams, init.fork.streams ?? []);
  else {
    wireKernelStdio(running.FS, streams);
    for (const entry of init.fds ?? []) wireKernelFd(running.FS, streams, entry);
  }
  const pipefs = ownValue<ProcessPipeFs>(running, 'PIPEFS');
  if (pipefs) streams.usePipes(pipefs);
  streams.useControllingTerminal();
  useDevFd(running.FS);
  ownByRealmUser(running.FS);
  const livePath = (s: ProcessStream) => liveNodePath(s.node as unknown as LiveFsNode);
  running.sliccKernel = createProcessKernel({
    transport,
    Fs: running.FS,
    env: init.env,
    beforeSpawn: () => vfs.flush(),
    afterChild: () => vfs.invalidate(),
    pid: init.pid,
    raise: (sig) => running.sliccRaise?.(sig),
    restartable,
    describeFork: () => describeForFork(running.FS, sys, streams, livePath),
    inherit: (actions) => describeInherited(running.FS, sys, streams, livePath, actions),
    stdioPromoter: () => vfsPromoter(running.FS, sys, streams, livePath),
  });
  running.sliccKernel.net = createSocketKernel({
    transport,
    Fs: running.FS,
    sys,
    streams,
    sigpipe,
    restartable,
  });
  try {
    return runMain(running, init);
  } finally {
    // Even when the program traps: what it wrote to open files must not be
    // lost with the worker.
    vfs.flush();
  }
}

/**
 * Has the module a real FS? Emscripten's minimal-FS stub (a program that uses
 * no files) has no streams, and a glue may define no FS at all.
 */
function hasStreams(module: object): boolean {
  return typeof ownValue<Partial<ProcessFs>>(module, 'FS')?.getStream === 'function';
}

/**
 * A program without a FS: nothing to mount and no descriptors to wire. Its
 * stdout and stderr reach the kernel's fds 1 and 2 through `Module.print` /
 * `printErr`, and it cannot read stdin (that would have pulled in the FS).
 */
function runStdioOnly(running: RunningModule, init: WasmProcessInitMsg): number {
  if (init.fork) throw new Error(`${init.argv0} cannot resume a fork: it has no filesystem`);
  return runMain(running, init);
}

/** Run main, or resume a fork; an exit() is its status. */
function runMain(running: RunningModule, init: WasmProcessInitMsg): number {
  try {
    if (init.fork) {
      // A forked child: become the parent's copy and go on from fork() returning 0.
      if (!running.sliccForkChild) throw new Error(`${init.argv0} cannot resume a fork`);
      return running.sliccForkChild({ ...init.fork, pid: init.pid }) ?? 0;
    }
    // A program with the fork emulation (slicc-fork.js) drives its forks from sliccRunMain.
    return (running.sliccRunMain ?? running.callMain)(init.args) ?? 0;
  } catch (e) {
    // Emscripten signals exit() with an ExitStatus throw.
    const status = (e as { status?: unknown })?.status;
    if (typeof status !== 'number') throw e;
    return status;
  }
}
