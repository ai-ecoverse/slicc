/**
 * Page-side spawn helper for the kernel worker.
 *
 * Phase 2 step 6c. The standalone `main.ts` (Phase 2 step 6d) calls
 * `spawnKernelWorker(...)` to:
 *
 *   1. Construct a `Worker` from `/kernel-worker.js`.
 *   2. Create two `MessageChannel`s (one for the kernel ⇄ panel
 *      bridge stream, one for CDP).
 *   3. Wire the page-side CDP forwarder against the existing
 *      WebSocket-backed `CDPTransport` so the worker can issue real
 *      CDP commands.
 *   4. Construct an `OffscreenClient` over the panel-side kernel
 *      port — the panel's existing UI callbacks (chat, scoops,
 *      memory, sprinkle-op) wire into it exactly like they do for
 *      the extension panel.
 *   5. Post `kernel-worker-init` to the worker, transferring the
 *      worker-side ports.
 *   6. Wait for `kernel-worker-ready` before resolving.
 *
 * Returns `{ client, ready, dispose }` so the caller can await the
 * boot, then start using the client. `dispose()` tears down the
 * worker, the CDP forwarder, and closes both ports.
 *
 * The split between `bootstrapKernelWorker` (testable; takes a
 * pre-constructed `WorkerLike`) and `spawnKernelWorker` (production;
 * constructs the real `Worker`) lets the bootstrap logic be unit-tested
 * with a mock worker — vitest can't easily spawn a real DedicatedWorker
 * in Node.
 */

import type { CDPTransport } from '../cdp/transport.js';
import { OffscreenClient, type OffscreenClientCallbacks } from '../ui/offscreen-client.js';
import { createPanelMessageChannelTransport } from './transport-message-channel.js';
import { startPageCdpForwarder } from './cdp-worker-proxy.js';
import type { KernelWorkerInitMsg, KernelWorkerReadyMsg } from './kernel-worker.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Minimal `Worker`-like surface the bootstrap relies on. */
export interface WorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  terminate(): void;
}

export interface KernelWorkerSpawnOptions {
  /** URL of the bundled kernel worker JS (e.g. `/kernel-worker.js`). */
  workerUrl: string | URL;
  /** Real CDP transport (WebSocket-backed `CDPClient` in standalone). */
  realCdpTransport: CDPTransport;
  /** Panel UI callbacks the `OffscreenClient` dispatches into. */
  callbacks: OffscreenClientCallbacks;
  /** Boot timeout in ms. Default 30s. */
  readyTimeoutMs?: number;
}

export interface KernelWorkerBootstrapOptions {
  worker: WorkerLike;
  realCdpTransport: CDPTransport;
  callbacks: OffscreenClientCallbacks;
  readyTimeoutMs?: number;
}

export interface SpawnedKernelHost {
  /** Panel-side client. UI callbacks wire into it. */
  client: OffscreenClient;
  /** Resolves when the worker has finished `createKernelHost`. */
  ready: Promise<void>;
  /** Tear down the worker, the CDP forwarder, and close both ports. */
  dispose(): void;
}

// ---------------------------------------------------------------------------
// Bootstrap (testable)
// ---------------------------------------------------------------------------

/**
 * Wire up an existing Worker-like instance to a kernel host. Used by
 * `spawnKernelWorker` and by tests with a mock worker.
 */
export function bootstrapKernelWorker(options: KernelWorkerBootstrapOptions): SpawnedKernelHost {
  const { worker, realCdpTransport, callbacks } = options;
  const readyTimeoutMs = options.readyTimeoutMs ?? 30_000;

  const kernelChannel = new MessageChannel();
  const cdpChannel = new MessageChannel();

  // Panel-side client over the kernel port. Wraps payloads with
  // `source: 'panel'` so the worker-side bridge's source filter matches
  // exactly what chrome.runtime would have delivered.
  const panelTransport = createPanelMessageChannelTransport(kernelChannel.port1);
  const client = new OffscreenClient(callbacks, panelTransport);

  // Pump real CDP commands ⇄ wire on the cdp port.
  const stopForwarder = startPageCdpForwarder(cdpChannel.port1, realCdpTransport);

  // Wait for `kernel-worker-ready` on the kernel port. The OffscreenClient
  // already started this port via its onMessage subscription; we just add
  // a second listener that resolves on the boot signal.
  let readyResolved = false;
  const ready = new Promise<void>((resolve, reject) => {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const listener = (event: MessageEvent): void => {
      const data = event.data as Partial<KernelWorkerReadyMsg> | null;
      if (data?.type !== 'kernel-worker-ready') return;
      kernelChannel.port1.removeEventListener('message', listener as EventListener);
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      readyResolved = true;
      resolve();
    };
    kernelChannel.port1.addEventListener('message', listener as EventListener);
    timeoutId = setTimeout(() => {
      timeoutId = null;
      kernelChannel.port1.removeEventListener('message', listener as EventListener);
      reject(new Error(`Kernel worker did not signal ready within ${readyTimeoutMs}ms`));
    }, readyTimeoutMs);
  });

  // Hand the worker its ports. After `postMessage` with a transferable
  // list, the page can no longer use port2 of either channel — that's
  // intended; the worker now owns them.
  const init: KernelWorkerInitMsg = {
    type: 'kernel-worker-init',
    kernelPort: kernelChannel.port2,
    cdpPort: cdpChannel.port2,
  };
  worker.postMessage(init, [kernelChannel.port2, cdpChannel.port2]);

  let disposed = false;
  return {
    client,
    ready,
    dispose() {
      if (disposed) return;
      disposed = true;
      stopForwarder();
      try {
        worker.postMessage({ type: 'kernel-worker-shutdown' });
      } catch {
        /* worker may already be terminated */
      }
      worker.terminate();
      kernelChannel.port1.close();
      cdpChannel.port1.close();
      // If `ready` is still pending (boot never completed), the timeout
      // above fires the rejection. We don't resolve it here — a caller
      // awaiting `ready` after dispose would otherwise deadlock if we
      // never resolve. Mark it explicitly:
      void readyResolved;
    },
  };
}

// ---------------------------------------------------------------------------
// Spawn (production)
// ---------------------------------------------------------------------------

/**
 * Construct a real `Worker` from `/kernel-worker.js` and bootstrap it.
 * Standalone `main.ts` is the production caller (Phase 2 step 6d).
 */
export function spawnKernelWorker(options: KernelWorkerSpawnOptions): SpawnedKernelHost {
  // The kernel-worker bundle is an IIFE (classic worker), not a module
  // worker, so omit `{ type: 'module' }`. See `vite.config.ts` —
  // bundling as IIFE avoids Rollup's code-splitting which a worker
  // can't import from.
  const worker = new Worker(options.workerUrl);
  return bootstrapKernelWorker({
    worker,
    realCdpTransport: options.realCdpTransport,
    callbacks: options.callbacks,
    readyTimeoutMs: options.readyTimeoutMs,
  });
}
