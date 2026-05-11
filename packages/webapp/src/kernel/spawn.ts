/**
 * Page-side spawn helper for the kernel worker.
 *
 * The standalone `main.ts` calls `spawnKernelWorker(...)` to:
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
  /**
   * Optional override for the worker URL. Defaults to
   * `DEFAULT_KERNEL_WORKER_URL` (the Vite-bundled
   * `./kernel-worker.ts`). Override only if loading the worker from a
   * non-default location (e.g. a test harness or a custom asset path).
   */
  workerUrl?: string | URL;
  /** Real CDP transport (WebSocket-backed `CDPClient` in standalone). */
  realCdpTransport: CDPTransport;
  /** Panel UI callbacks the `OffscreenClient` dispatches into. */
  callbacks: OffscreenClientCallbacks;
  /** Boot timeout in ms. Default 30s. */
  readyTimeoutMs?: number;
  /**
   * Optional snapshot of `window.localStorage` for the worker's shim.
   * Workers don't have a real `localStorage`; we seed a read-only
   * shim from the page's snapshot so `provider-settings.getApiKey()`
   * etc. work in the worker. A page↔worker state-sync channel keeps
   * the shim live thereafter.
   * Defaults to all `slicc*`-prefixed keys via `collectLocalStorageSeed()`.
   */
  localStorageSeed?: Record<string, string>;
  /**
   * Per-instance discriminator forwarded to the worker so same-origin
   * RPC channels (e.g. the sprinkle BroadcastChannel bridge) stay
   * scoped to one tab/worker pair. Optional.
   */
  instanceId?: string;
}

export interface KernelWorkerBootstrapOptions {
  worker: WorkerLike;
  realCdpTransport: CDPTransport;
  callbacks: OffscreenClientCallbacks;
  readyTimeoutMs?: number;
  localStorageSeed?: Record<string, string>;
  /**
   * Per-instance discriminator forwarded to the worker so same-origin
   * RPC channels (e.g. the sprinkle BroadcastChannel bridge) stay
   * scoped to one tab/worker pair. Optional.
   */
  instanceId?: string;
}

/**
 * Collect every page-side `localStorage` key/value pair for the
 * worker's shim. Returns an empty object if `localStorage` isn't
 * available (e.g. test environment).
 *
 * No filtering: the worker's import graph reaches into bedrock-camp,
 * tray-runtime-config, telemetry, primary-rail, etc., each with their
 * own key namespace. The bidirectional state sync layered on top
 * keeps the shim current after boot.
 */
export function collectLocalStorageSeed(): Record<string, string> {
  const seed: Record<string, string> = {};
  if (typeof localStorage === 'undefined') return seed;
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key === null) continue;
    const value = localStorage.getItem(key);
    if (value === null) continue;
    seed[key] = value;
  }
  return seed;
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
  const localStorageSeed = options.localStorageSeed ?? {};

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
  //
  // Single cleanup path: `cleanupReady()` removes the listener AND clears
  // the timeout. Called from the success branch, the timeout branch, AND
  // from `dispose()` so a caller that disposes before the worker replies
  // doesn't leave the listener attached for the worker's lifetime.
  let cleanupReady: (() => void) | null = null;
  const ready = new Promise<void>((resolve, reject) => {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let listener: ((event: MessageEvent) => void) | null = null;
    cleanupReady = (): void => {
      if (listener !== null) {
        kernelChannel.port1.removeEventListener('message', listener as EventListener);
        listener = null;
      }
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
    };
    listener = (event: MessageEvent): void => {
      const data = event.data as Partial<KernelWorkerReadyMsg> | null;
      if (data?.type !== 'kernel-worker-ready') return;
      cleanupReady?.();
      resolve();
    };
    kernelChannel.port1.addEventListener('message', listener as EventListener);
    timeoutId = setTimeout(() => {
      cleanupReady?.();
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
    localStorageSeed,
    instanceId: options.instanceId,
  };
  worker.postMessage(init, [kernelChannel.port2, cdpChannel.port2]);

  let disposed = false;
  return {
    client,
    ready,
    dispose() {
      if (disposed) return;
      disposed = true;
      // Tear down the ready-watcher BEFORE closing the port so a
      // callback racing in flight gets removed, not orphaned. The
      // timeout fires the rejection if `ready` is still pending; we
      // don't resolve it here.
      cleanupReady?.();
      stopForwarder();
      try {
        worker.postMessage({ type: 'kernel-worker-shutdown' });
      } catch {
        /* worker may already be terminated */
      }
      worker.terminate();
      kernelChannel.port1.close();
      cdpChannel.port1.close();
    },
  };
}

// ---------------------------------------------------------------------------
// Spawn (production)
// ---------------------------------------------------------------------------

/**
 * Construct a real `Worker` from the bundled kernel-worker entry and
 * bootstrap it. Standalone `main.ts` is the production caller.
 *
 * Worker bundling: the `new Worker(new URL('./kernel-worker.ts',
 * import.meta.url), { type: 'module' })` pattern must be **inline**
 * (not pulled out into a constant) for Vite's static-analysis pass
 * to recognize it during build. With the inline form, Vite runs the
 * referenced TS file through its own Rollup pipeline (applying the
 * `resolve.alias` map + `stub-pi-node-internals` resolveId plugin
 * from `vite.config.ts`) and emits a hashed worker bundle under
 * `dist/ui/assets/`. The optional `workerUrl` override is a runtime
 * swap (e.g. for tests with a custom server).
 *
 * The kernel worker's static graph used to hit a TDZ on the
 * `providers/index.ts` ↔ `provider-settings.ts` ↔
 * `built-in/azure-openai.ts` cycle in dev mode (where Vite serves
 * modules natively, no Rollup hoisting). The fix lives in
 * `providers/index.ts`: `import.meta.glob` is now lazy and
 * registration is explicit via `registerProviders()`. Entry points
 * (this worker's `boot()`, `main.ts`, `offscreen.ts`) await it during
 * boot.
 */
export function spawnKernelWorker(options: KernelWorkerSpawnOptions): SpawnedKernelHost {
  const worker = options.workerUrl
    ? new Worker(options.workerUrl, { type: 'module' })
    : new Worker(new URL('./kernel-worker.ts', import.meta.url), { type: 'module' });
  return bootstrapKernelWorker({
    worker,
    realCdpTransport: options.realCdpTransport,
    callbacks: options.callbacks,
    readyTimeoutMs: options.readyTimeoutMs,
    localStorageSeed: options.localStorageSeed ?? collectLocalStorageSeed(),
    instanceId: options.instanceId,
  });
}
