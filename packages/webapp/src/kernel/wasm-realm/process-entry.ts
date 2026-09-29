/**
 * `process-entry.ts` — what a wasm-realm process worker does with its init
 * message (#3530), whatever the worker API (`process-worker.ts` in the
 * browser, `worker_threads` in tests): run the program, or one thread of a
 * WASI program, and report how it ended.
 *
 * Every end is reported, a start that rejects included: the kernel keeps a
 * worker until it hears, so a thread whose runtime failed to load or to
 * instantiate would otherwise leave a join waiting forever.
 */
import type { SabPostLike } from '../realm/sync-sab-bridge.js';
import { runWasmProcess } from './process-runtime.js';
import {
  WASM_PROCESS_ERROR,
  WASM_PROCESS_EXIT,
  WASM_PROCESS_INIT,
  WASM_THREAD_INIT,
  type WasmProcessErrorMsg,
  type WasmProcessExitMsg,
  type WasmProcessInitMsg,
  type WasmThreadInitMsg,
} from './protocol.js';

/** The runtimes a worker runs: the WASI host loads only for a WASI program. */
export interface ProcessRuntimes {
  wasi?: () => Promise<{
    runWasiProcess(init: WasmProcessInitMsg, port: SabPostLike): Promise<number>;
    runWasiThread(init: WasmThreadInitMsg, port: SabPostLike): Promise<void>;
  }>;
  emscripten?: (init: WasmProcessInitMsg, port: SabPostLike) => Promise<number>;
}

const loadWasi: NonNullable<ProcessRuntimes['wasi']> = () => import('./wasi/wasi-runtime.js');

/** The worker's message handler, posting through `port`. */
export function processEntry(
  port: SabPostLike,
  runtimes: ProcessRuntimes = {}
): (data: unknown) => void {
  const wasi = runtimes.wasi ?? loadWasi;
  const emscripten = runtimes.emscripten ?? runWasmProcess;
  const failed = (err: unknown) =>
    port.postMessage({
      type: WASM_PROCESS_ERROR,
      message: err instanceof Error ? (err.stack ?? err.message) : String(err),
    } satisfies WasmProcessErrorMsg);
  return (data) => {
    const type = (data as { type?: string } | undefined)?.type;
    // A thread of a WASI process reports its own end; a start that fails ends the process.
    if (type === WASM_THREAD_INIT) {
      wasi()
        .then((m) => m.runWasiThread(data as WasmThreadInitMsg, port))
        .catch(failed);
      return;
    }
    if (type !== WASM_PROCESS_INIT) return;
    const init = data as WasmProcessInitMsg;
    const run =
      init.program.abi === 'wasi'
        ? wasi().then((m) => m.runWasiProcess(init, port))
        : emscripten(init, port);
    run.then(
      (code) => port.postMessage({ type: WASM_PROCESS_EXIT, code } satisfies WasmProcessExitMsg),
      failed
    );
  };
}
