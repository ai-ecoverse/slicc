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
import { SAB_DEFAULT_WINDOW_BYTES, SAB_HEADER_BYTES } from '../realm/sync-sab-wire.js';
import type { ChildForker, ChildSpawner } from './children.js';
import type { FdTable } from './fd-table.js';
import { isWasmSyscall, WasmProcess } from './process.js';
import {
  type ForkState,
  WASM_PROCESS_ERROR,
  WASM_PROCESS_EXIT,
  WASM_PROCESS_INIT,
  type WasmProcessInitMsg,
  type WasmProgram,
} from './protocol.js';

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
}

export interface WasmProcessHandle {
  pid: number;
  /** Resolves to the exit code (128 + signal when killed). */
  exited: Promise<number>;
  /** SIGKILL: the worker ends at once. */
  kill(code?: number): void;
}

/** Exit code of a process whose worker failed outside the program. */
const CRASHED = 70; // EX_SOFTWARE

function defaultWorker(): WasmWorkerLike {
  return new Worker(new URL('./process-worker.ts', import.meta.url), {
    type: 'module',
  }) as WasmWorkerLike;
}

export function spawnWasmProcess(opts: SpawnWasmOptions): WasmProcessHandle {
  const process = new WasmProcess(opts.pid, opts.fds, {
    spawner: opts.spawner,
    forker: opts.forker,
    fs: opts.fs,
  });
  const token = mintSyncFsToken({ fs: opts.fs, cwd: opts.cwd });
  const sab = new SharedArrayBuffer(SAB_HEADER_BYTES + SAB_DEFAULT_WINDOW_BYTES);
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
  const finish = (code: number): void => {
    if (done) return;
    done = true;
    worker.removeEventListener('message', onMessage);
    worker.removeEventListener('error', onError);
    responder.dispose();
    revokeSyncFsToken(token);
    process.exit();
    worker.terminate();
    settle(code);
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
    ...(opts.fork ? { fork: opts.fork } : {}),
  };
  // A fork's memory copy is the child's alone: hand it over instead of cloning it.
  worker.postMessage(init, opts.fork ? [opts.fork.memory.buffer] : []);
  return { pid: opts.pid, exited, kill: (code = 137) => finish(code) };
}
