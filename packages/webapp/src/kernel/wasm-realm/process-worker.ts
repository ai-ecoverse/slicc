/**
 * `process-worker.ts` — DedicatedWorker entry of a wasm-realm process
 * (#3530): one worker, one program. See `process-runtime.ts`.
 *
 * No node shims and no realm bootstrap: the worker waits for its init
 * message, runs the program, and reports the exit code. The kernel owns
 * everything else (fds, pipes, the process record) and ends the worker.
 */

/// <reference lib="webworker" />

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

declare const self: DedicatedWorkerGlobalScope;

self.addEventListener('message', (event: MessageEvent) => {
  const data = event.data as { type?: string } | undefined;
  const port = { postMessage: (msg: unknown) => self.postMessage(msg) };
  // A thread of a WASI process: its start function, reporting for itself.
  if (data?.type === WASM_THREAD_INIT) {
    const init = event.data as WasmThreadInitMsg;
    void import('./wasi/wasi-runtime.js').then((m) => m.runWasiThread(init, port));
    return;
  }
  if (data?.type !== WASM_PROCESS_INIT) return;
  const init = event.data as WasmProcessInitMsg;
  // The WASI host loads only for a WASI program: Emscripten programs never pay for it.
  const run =
    init.program.abi === 'wasi'
      ? import('./wasi/wasi-runtime.js').then((m) => m.runWasiProcess(init, port))
      : runWasmProcess(init, port);
  run.then(
    (code) => self.postMessage({ type: WASM_PROCESS_EXIT, code } satisfies WasmProcessExitMsg),
    (err: unknown) =>
      self.postMessage({
        type: WASM_PROCESS_ERROR,
        message: err instanceof Error ? (err.stack ?? err.message) : String(err),
      } satisfies WasmProcessErrorMsg)
  );
});
