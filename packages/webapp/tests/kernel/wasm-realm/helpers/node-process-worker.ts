import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parentPort } from 'node:worker_threads';
import { processEntry } from '../../../../src/kernel/wasm-realm/process-entry.js';

const cjs = globalThis as { require?: unknown; __dirname?: string; __filename?: string };
cjs.require ??= createRequire(import.meta.url);
cjs.__filename ??= fileURLToPath(import.meta.url);
cjs.__dirname ??= dirname(cjs.__filename);

const port = parentPort;
if (!port) throw new Error('node-process-worker runs in a worker thread');

const onMessage = processEntry({ postMessage: (msg: unknown) => port.postMessage(msg) });
port.on('message', onMessage);
