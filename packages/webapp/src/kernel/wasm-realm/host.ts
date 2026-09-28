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
import type { FdTable } from './fd-table.js';
import type { JobTable } from './jobs.js';
import { isWasmSyscall, type StateListener, WasmProcess } from './process.js';
import {
  type ForkState,
  WASM_PROCESS_ERROR,
  WASM_PROCESS_EXIT,
  WASM_PROCESS_INIT,
  type WasmProcessInitMsg,
  type WasmProgram,
} from './protocol.js';
import { SIG, sigbit } from './signals.js';

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

  fds: FdTable;

  fs: SyncFsTokenEntry['fs'];
  createWorker?: () => WasmWorkerLike;

  onError?: (message: string) => void;

  spawner?: ChildSpawner;

  forker?: ChildForker;

  fork?: ForkState;

  kill?: (pid: number, sig: number) => boolean | Promise<boolean>;

  jobs?: JobTable;
}

export interface WasmProcessHandle {
  pid: number;

  exited: Promise<number>;

  kill(code?: number): void;

  signal(sig: number): void;

  termsig(): number | undefined;

  onState(listener: StateListener): void;
}

const CRASHED = 70;

function defaultWorker(): WasmWorkerLike {
  return new Worker(new URL('./process-worker.ts', import.meta.url), {
    type: 'module',
  }) as WasmWorkerLike;
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

  const finish = (code: number, sig?: number): void => {
    if (done) return;
    done = true;
    endedBy = sig ?? process.execTermsig;
    worker.removeEventListener('message', onMessage);
    worker.removeEventListener('error', onError);
    responder.dispose();
    revokeSyncFsToken(token);
    worker.terminate();

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
    ...(opts.fork ? { fork: opts.fork } : { fds: opts.fds.numbers().filter((fd) => fd > 2) }),
  };

  worker.postMessage(init, opts.fork ? [opts.fork.memory.buffer] : []);
  const signal = (sig: number): void => {
    if (process.signal(sig) === 'terminate') finish(sig === SIG.KILL ? 137 : 128 + sig, sig);
  };

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
