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
import type { FdTable } from './fd-table.js';
import { isWasmSyscall, WasmProcess } from './process.js';
import {
  WASM_PROCESS_ERROR,
  WASM_PROCESS_EXIT,
  WASM_PROCESS_INIT,
  type WasmProcessInitMsg,
  type WasmProgram,
} from './protocol.js';

export interface WasmWorkerLike {
  postMessage(message: unknown): void;
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
}

export interface WasmProcessHandle {
  pid: number;

  exited: Promise<number>;

  kill(code?: number): void;
}

const CRASHED = 70;

function defaultWorker(): WasmWorkerLike {
  return new Worker(new URL('./process-worker.ts', import.meta.url), {
    type: 'module',
  }) as WasmWorkerLike;
}

export function spawnWasmProcess(opts: SpawnWasmOptions): WasmProcessHandle {
  const process = new WasmProcess(opts.pid, opts.fds);
  const token = mintSyncFsToken({ fs: opts.fs, cwd: opts.cwd });
  const sab = new SharedArrayBuffer(SAB_HEADER_BYTES + SAB_DEFAULT_WINDOW_BYTES);
  const worker = (opts.createWorker ?? defaultWorker)();
  const dispatch = (req: SyncSabDispatchRequest): Promise<SyncFsResult> => {
    if (isWasmSyscall(req)) return process.syscall(req);
    if ('op' in req && typeof req.op === 'string' && 'path' in req) return dispatchSyncFs(req);
    return Promise.resolve({ ok: false, errno: 'ENOSYS', message: 'wasm-realm: no exec yet' });
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
  };
  worker.postMessage(init);
  return { pid: opts.pid, exited, kill: (code = 137) => finish(code) };
}
