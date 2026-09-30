/**
 * Worker entry for pi-codemode in the browser. This file becomes its own
 * Vite chunk (`new URL('./codemode-worker.ts', import.meta.url)`) and runs
 * as a DedicatedWorker nested under the kernel worker.
 *
 * Flow:
 * 1. The host-side `Worker` shim posts `workerData` as the first message.
 * 2. This file receives it, calls `_initWorkerSide` to set the shim's
 *    module-level `workerData` and `parentPort` bindings.
 * 3. Only then does it import `@earendil-works/pi-codemode/worker`, which
 *    reads those bindings at top level.
 */

import { _initWorkerSide } from '../shims/worker-threads.js';

globalThis.addEventListener(
  'message',
  async (event: MessageEvent) => {
    _initWorkerSide(event.data);
    try {
      await import('@earendil-works/pi-codemode/worker');
    } catch (err) {
      globalThis.postMessage({
        type: 'crash',
        message: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      });
    }
  },
  { once: true }
);
