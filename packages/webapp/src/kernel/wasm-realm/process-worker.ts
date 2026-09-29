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
  const init = event.data as WasmProcessInitMsg;

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
