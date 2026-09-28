import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parentPort } from 'node:worker_threads';
import { runWasmProcess } from '../../../../src/kernel/wasm-realm/process-runtime.js';
import {
  WASM_PROCESS_ERROR,
  WASM_PROCESS_EXIT,
  WASM_PROCESS_INIT,
  type WasmProcessInitMsg,
} from '../../../../src/kernel/wasm-realm/protocol.js';

const cjs = globalThis as { require?: unknown; __dirname?: string; __filename?: string };
cjs.require ??= createRequire(import.meta.url);
cjs.__filename ??= fileURLToPath(import.meta.url);
cjs.__dirname ??= dirname(cjs.__filename);

const port = parentPort;
if (!port) throw new Error('node-process-worker runs in a worker thread');

port.on('message', (data: { type?: string }) => {
  if (data?.type !== WASM_PROCESS_INIT) return;
  runWasmProcess(data as WasmProcessInitMsg, { postMessage: (msg) => port.postMessage(msg) }).then(
    (code) => port.postMessage({ type: WASM_PROCESS_EXIT, code }),
    (err: unknown) =>
      port.postMessage({
        type: WASM_PROCESS_ERROR,
        message: err instanceof Error ? (err.stack ?? err.message) : String(err),
      })
  );
});
