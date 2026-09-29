/**
 * A wasm-realm process worker for Node's `worker_threads`: `process-worker.ts`
 * with `parentPort` for `self`. Tests bundle it (esbuild) and run real
 * Emscripten programs against the real kernel host (`host.ts`), SAB bridge and
 * runtime; only the thread API differs from the browser's DedicatedWorker.
 */
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

// Emscripten glue built with ENVIRONMENT=node takes its node path here: it
// requires node modules and locates itself through CommonJS's __dirname.
const cjs = globalThis as { require?: unknown; __dirname?: string; __filename?: string };
cjs.require ??= createRequire(import.meta.url);
cjs.__filename ??= fileURLToPath(import.meta.url);
cjs.__dirname ??= dirname(cjs.__filename);

const port = parentPort;
if (!port) throw new Error('node-process-worker runs in a worker thread');

port.on('message', (data: { type?: string }) => {
  if (data?.type !== WASM_PROCESS_INIT) return;
  const init = data as WasmProcessInitMsg;
  const post = { postMessage: (msg: unknown) => port.postMessage(msg) };
  const run =
    init.program.abi === 'wasi'
      ? import('../../../../src/kernel/wasm-realm/wasi/wasi-runtime.js').then((m) =>
          m.runWasiProcess(init, post)
        )
      : runWasmProcess(init, post);
  run.then(
    (code) => port.postMessage({ type: WASM_PROCESS_EXIT, code }),
    (err: unknown) =>
      port.postMessage({
        type: WASM_PROCESS_ERROR,
        message: err instanceof Error ? (err.stack ?? err.message) : String(err),
      })
  );
});
