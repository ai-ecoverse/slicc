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

export interface ProcessRuntimes {
  wasi?: () => Promise<{
    runWasiProcess(init: WasmProcessInitMsg, port: SabPostLike): Promise<number>;
    runWasiThread(init: WasmThreadInitMsg, port: SabPostLike): Promise<void>;
  }>;
  emscripten?: (init: WasmProcessInitMsg, port: SabPostLike) => Promise<number>;
}

const loadWasi: NonNullable<ProcessRuntimes['wasi']> = () => import('./wasi/wasi-runtime.js');

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
