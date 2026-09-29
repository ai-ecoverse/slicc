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
import { processEntry } from '../../../../src/kernel/wasm-realm/process-entry.js';

// Emscripten glue built with ENVIRONMENT=node takes its node path here: it
// requires node modules and locates itself through CommonJS's __dirname.
const cjs = globalThis as { require?: unknown; __dirname?: string; __filename?: string };
cjs.require ??= createRequire(import.meta.url);
cjs.__filename ??= fileURLToPath(import.meta.url);
cjs.__dirname ??= dirname(cjs.__filename);

const port = parentPort;
if (!port) throw new Error('node-process-worker runs in a worker thread');

const onMessage = processEntry({ postMessage: (msg: unknown) => port.postMessage(msg) });
port.on('message', onMessage);
