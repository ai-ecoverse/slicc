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
  type WasmProcessErrorMsg,
  type WasmProcessExitMsg,
  type WasmProcessInitMsg,
} from './protocol.js';

declare const self: DedicatedWorkerGlobalScope;

self.addEventListener('message', (event: MessageEvent) => {
  const data = event.data as { type?: string } | undefined;
  if (data?.type !== WASM_PROCESS_INIT) return;
  const port = { postMessage: (msg: unknown) => self.postMessage(msg) };
  runWasmProcess(event.data as WasmProcessInitMsg, port).then(
    (code) => self.postMessage({ type: WASM_PROCESS_EXIT, code } satisfies WasmProcessExitMsg),
    (err: unknown) =>
      self.postMessage({
        type: WASM_PROCESS_ERROR,
        message: err instanceof Error ? (err.stack ?? err.message) : String(err),
      } satisfies WasmProcessErrorMsg)
  );
});
