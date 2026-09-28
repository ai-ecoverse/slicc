/**
 * `host.ts` — the kernel side of a wasm-realm process (#3530): start its
 * worker, answer its syscalls, and clean up when it ends.
 *
 * One worker per process. The SAB responder is the one the node realm uses,
 * with a dispatcher that sends process syscalls to the process's fd table
 * and file operations to the token-scoped sync-fs dispatch (the gated
 * `ctx.fs` of whoever started the process). Exit, a crash, or a kill all end
 * in {@link finish}: the responder detaches, the token is revoked, the
 * process's descriptors are released (pipes see EOF / EPIPE) and the worker is
 * terminated.
 */
import { dispatchSyncFs, type SyncFsResult } from '../realm/sync-fs-dispatch.js';
import {
  mintSyncFsToken,
  revokeSyncFsToken,
  type SyncFsTokenEntry,
} from '../realm/sync-fs-token-registry.js';
import {
  attachSyncSabResponder,
  type SyncSabDispatchRequest,
} from '../realm/sync-sab-responder.js';
import {
  SAB_DEFAULT_WINDOW_BYTES,
  SAB_HEADER_BYTES,
  SAB_HEADER_I32,
  SAB_I_SIGNALS,
} from '../realm/sync-sab-wire.js';
import type { ChildForker, ChildSpawner } from './children.js';
import { type FdTable, kernelFdKind, type OpenFile } from './fd-table.js';
import type { JobTable } from './jobs.js';
import { isWasmSyscall, type StateListener, WasmProcess } from './process.js';
import {
  type ForkState,
  type InheritedFd,
  WASM_PROCESS_ERROR,
  WASM_PROCESS_EXIT,
  WASM_PROCESS_INIT,
  type WasmProcessInitMsg,
  type WasmProgram,
} from './protocol.js';
import { SIG, sigbit } from './signals.js';
import { KernelSocket, type LoopbackNet } from './socket.js';

/** The worker surface the host needs (a DedicatedWorker; a fake in tests). */
export interface WasmWorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: 'message' | 'error', handler: (event: MessageEvent) => void): void;
  removeEventListener(type: 'message' | 'error', handler: (event: MessageEvent) => void): void;
  terminate(): void;
}

export interface SpawnWasmOptions {
  pid: number;
  program: WasmProgram;
  argv0: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  /** The process's descriptors; the process owns (and releases) them from here on. */
  fds: FdTable;
  /** The filesystem the process sees (the spawner's gated `ctx.fs`). */
  fs: SyncFsTokenEntry['fs'];
  createWorker?: () => WasmWorkerLike;
  /** Diagnostics when the worker fails before or outside the program. */
  onError?: (message: string) => void;
  /** Starts the children the program spawns; without it `posix_spawn` fails (ENOSYS). */
  spawner?: ChildSpawner;
  /** Starts the children the program forks; without it the toolchain emulates fork in-process. */
  forker?: ChildForker;
  /** A forked child: resume from the parent's state instead of running main. */
  fork?: ForkState;
  /** kill(2) the program sends another process (a negative pid: a group): false when there is none (ESRCH). */
  kill?: (pid: number, sig: number) => boolean | Promise<boolean>;
  /** Process groups and sessions of its invocation. */
  jobs?: JobTable;
  /** The loopback network its sockets live on: its owner's, shared across invocations. */
  net?: LoopbackNet;
}

export interface WasmProcessHandle {
  pid: number;
  /** Resolves to the exit code (128 + signal when killed). */
  exited: Promise<number>;
  /** SIGKILL: the worker ends at once. */
  kill(code?: number): void;
  /**
   * Send a signal: SIGKILL and an uncaught signal's default action end the
   * process (128 + signal); a caught one runs its handler at the program's
   * next syscall boundary.
   */
  signal(sig: number): void;
  /** The signal that ended the process (its parent's WIFSIGNALED), once it ended by one. */
  termsig(): number | undefined;
  /** Hear of its stops and continues (its parent's waitpid(WUNTRACED)). */
  onState(listener: StateListener): void;
}

/** Exit code of a process whose worker failed outside the program. */
const CRASHED = 70; // EX_SOFTWARE

function defaultWorker(): WasmWorkerLike {
  return new Worker(new URL('./process-worker.ts', import.meta.url), {
    type: 'module',
  }) as WasmWorkerLike;
}

/** Ids of open file descriptions, for the inodes a runtime gives stream placeholders. */
const descIds = new WeakMap<OpenFile, number>();
let nextDescId = 1;

function descId(file: OpenFile): number {
  let id = descIds.get(file);
  if (id === undefined) descIds.set(file, (id = nextDescId++));
  return id;
}

/** The descriptors beyond 0-2 a process starts with, as its runtime backs them. */
export function inheritedFds(fds: FdTable): InheritedFd[] {
  return fds
    .numbers()
    .filter((fd) => fd > 2)
    .map((fd): InheritedFd => {
      const open = fds.get(fd);
      const flags = fds.statusFlags(fd);
      const kind = open.file instanceof KernelSocket ? 'socket' : kernelFdKind(open.file);
      return {
        fd,
        kind,
        ...(flags !== undefined ? { flags } : {}),
        ...(fds.closesOnExec(fd) ? { cloexec: true } : {}),
        ...(kind === 'stream' ? { desc: descId(open) } : {}),
      };
    });
}

export function spawnWasmProcess(opts: SpawnWasmOptions): WasmProcessHandle {
  const sab = new SharedArrayBuffer(SAB_HEADER_BYTES + SAB_DEFAULT_WINDOW_BYTES);
  const header = new Int32Array(sab, 0, SAB_HEADER_I32);
  const process = new WasmProcess(opts.pid, opts.fds, {
    spawner: opts.spawner,
    forker: opts.forker,
    fs: opts.fs,
    kill: opts.kill,
    jobs: opts.jobs,
    net: opts.net,
    // The worker takes the word after every syscall and runs the handlers.
    onPending: (sig) => void Atomics.or(header, SAB_I_SIGNALS, sigbit(sig)),
    hasPending: () => Atomics.load(header, SAB_I_SIGNALS) !== 0,
  });
  const token = mintSyncFsToken({ fs: opts.fs, cwd: opts.cwd });
  const worker = (opts.createWorker ?? defaultWorker)();
  const dispatch = async (req: SyncSabDispatchRequest): Promise<SyncFsResult> => {
    if (isWasmSyscall(req)) return process.syscall(req);
    if ('op' in req && typeof req.op === 'string' && 'path' in req) return dispatchSyncFs(req);
    return { ok: false, errno: 'ENOSYS', message: 'wasm-realm: no exec yet' };
  };
  const responder = attachSyncSabResponder(worker, sab, token, { dispatch });

  let settle!: (code: number) => void;
  const exited = new Promise<number>((resolve) => (settle = resolve));
  let done = false;
  let endedBy: number | undefined;
  /** `sig`: the signal that ends it; else the one its exec'd program died of, if any. */
  const finish = (code: number, sig?: number): void => {
    if (done) return;
    done = true;
    endedBy = sig ?? process.execTermsig;
    worker.removeEventListener('message', onMessage);
    worker.removeEventListener('error', onError);
    responder.dispose();
    revokeSyncFsToken(token);
    worker.terminate();
    // Await the final VFS writeback before publishing exit: waitpid / the next
    // shell command must see what the process wrote, and a rejected write must
    // not become an unhandled rejection after settle.
    void process.exit().then(
      () => settle(code),
      () => settle(code)
    );
  };
  const onMessage = (event: MessageEvent): void => {
    const data = event.data as { type?: string; code?: unknown; message?: unknown } | undefined;
    if (data?.type === WASM_PROCESS_EXIT) {
      finish(typeof data.code === 'number' ? data.code : CRASHED);
    } else if (data?.type === WASM_PROCESS_ERROR) {
      opts.onError?.(String(data.message));
      finish(CRASHED);
    }
  };
  const onError = (event: MessageEvent): void => {
    // Handled here: unhandled, a program's crash (an Emscripten abort, a trap)
    // would propagate to the kernel worker's global scope and take the page down.
    event.preventDefault();
    opts.onError?.(String((event as unknown as ErrorEvent).message ?? 'worker error'));
    finish(CRASHED);
  };
  worker.addEventListener('message', onMessage);
  worker.addEventListener('error', onError);

  const init: WasmProcessInitMsg = {
    type: WASM_PROCESS_INIT,
    pid: opts.pid,
    program: opts.program,
    argv0: opts.argv0,
    args: opts.args,
    env: opts.env,
    cwd: opts.cwd,
    sab,
    ...(opts.fork ? { fork: opts.fork } : { fds: inheritedFds(opts.fds) }),
  };
  // A fork's memory copy is the child's alone: hand it over instead of cloning it.
  worker.postMessage(init, opts.fork ? [opts.fork.memory.buffer] : []);
  const signal = (sig: number): void => {
    if (process.signal(sig) === 'terminate') finish(sig === SIG.KILL ? 137 : 128 + sig, sig);
  };
  // A kill's code is 128 + the signal it stands for (137 SIGKILL, 130 an abort's SIGINT).
  const kill = (code = 137): void =>
    finish(code, code > 128 && code < 160 ? code - 128 : undefined);
  return {
    pid: opts.pid,
    exited,
    kill,
    signal,
    termsig: () => endedBy,
    onState: (listener) => process.onState(listener),
  };
}
