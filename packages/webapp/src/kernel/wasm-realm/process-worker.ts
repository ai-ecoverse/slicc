/**
 * `process-worker.ts` — DedicatedWorker entry of a wasm-realm process
 * (#3530): one worker, one program. See `process-runtime.ts`.
 *
 * No node shims and no realm bootstrap: the worker waits for its init
 * message, runs the program (`process-entry.ts`), and reports the exit code.
 * The kernel owns everything else (fds, pipes, the process record) and ends
 * the worker.
 */

/// <reference lib="webworker" />

import { processEntry } from './process-entry.js';

declare const self: DedicatedWorkerGlobalScope;

const onMessage = processEntry({ postMessage: (msg: unknown) => self.postMessage(msg) });
self.addEventListener('message', (event: MessageEvent) => onMessage(event.data));
