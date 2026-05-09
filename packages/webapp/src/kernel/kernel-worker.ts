/**
 * `kernel-worker.ts` — DedicatedWorker entry for the standalone kernel host.
 *
 * Phase 2 step 5d. The worker:
 *
 *   1. Waits for an init message from the page containing two
 *      `MessagePort`s — one for the kernel ⇄ panel bridge envelope
 *      stream, one for CDP.
 *   2. Constructs an `OffscreenBridge` over the kernel port (using
 *      `createBridgeMessageChannelTransport`).
 *   3. Constructs a `BrowserAPI` over a `WorkerCdpProxy` on the CDP
 *      port; the page-side `startPageCdpForwarder` pumps real CDP
 *      traffic between the worker and the WebSocket-backed `CDPClient`.
 *   4. Calls `createKernelHost(...)` with the bridge, browser, and
 *      orchestrator callbacks.
 *   5. Posts a `kernel-worker-ready` message back over the kernel port
 *      so the page knows the worker has finished booting.
 *
 * Phase 2 step 6 wires the standalone `main.ts` to spawn this worker;
 * Phase 2 step 7 adds the `LocalVfsClient` page-side mirror; Phase 2b
 * splits the WasmShell so the agent's bash loop can run worker-side
 * without dragging xterm into the worker.
 *
 * Worker safety: this file lives in `tsconfig.webapp-worker.json` and
 * must not reference DOM globals. The orchestrator's `container` arg
 * is unused at runtime today (stored but never read), so we pass a
 * stub typed as `HTMLElement` to satisfy the constructor signature.
 *
 * NOTE: This file is not yet bundled / referenced from a Vite entry —
 * Phase 2 step 6's `main.ts` integration adds the `/kernel-worker.js`
 * Vite IIFE entry that ships this code.
 */

/// <reference lib="webworker" />

import { BrowserAPI } from '../cdp/browser-api.js';
import { OffscreenBridge } from '../../../chrome-extension/src/offscreen-bridge.js';
import { createKernelHost, type KernelHost } from './host.js';
import { createBridgeMessageChannelTransport } from './transport-message-channel.js';
import { WorkerCdpProxy } from './cdp-worker-proxy.js';

// Provider registration runs as a side-effect import. Both standalone
// `main.ts` and the extension `offscreen.ts` already import this; the
// worker needs the same registrations because the kernel runs here.
import '../providers/index.js';

declare const self: DedicatedWorkerGlobalScope;

// ---------------------------------------------------------------------------
// Init protocol
// ---------------------------------------------------------------------------

/**
 * The page sends this once at boot. `kernelPort` carries the
 * `ExtensionMessage` envelope stream that `OffscreenBridge` listens on
 * and emits over. `cdpPort` carries the kernel-CDP wire that
 * `WorkerCdpProxy` ⇄ `startPageCdpForwarder` use.
 *
 * Sent via `worker.postMessage(init, [kernelPort, cdpPort])` so the
 * ports are transferred (not copied).
 */
export interface KernelWorkerInitMsg {
  type: 'kernel-worker-init';
  kernelPort: MessagePort;
  cdpPort: MessagePort;
}

/** Posted back over the kernel port once `createKernelHost` resolves. */
export interface KernelWorkerReadyMsg {
  type: 'kernel-worker-ready';
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

let host: KernelHost | null = null;

self.addEventListener('message', (event: MessageEvent) => {
  const data = event.data as { type?: string };
  if (data?.type !== 'kernel-worker-init') return;
  const init = event.data as KernelWorkerInitMsg;
  void boot(init).catch((err) => {
    console.error('[kernel-worker] boot failed', err);
  });
});

async function boot(init: KernelWorkerInitMsg): Promise<void> {
  const bridgeTransport = createBridgeMessageChannelTransport(init.kernelPort);
  const bridge = new OffscreenBridge(bridgeTransport);
  const callbacks = OffscreenBridge.createCallbacks(bridge);

  const cdpProxy = new WorkerCdpProxy(init.cdpPort);
  await cdpProxy.connect();
  const browser = new BrowserAPI(cdpProxy);

  // The orchestrator's `container` parameter is stored but never read
  // in production (verified at the time of writing). A worker has no
  // DOM; passing an empty stub satisfies the constructor without
  // dragging in a fake DOM impl. If a future change to Orchestrator
  // starts using `container`, this needs to grow into a UI capability
  // RPC back to the page.
  const stubContainer = {} as unknown as HTMLElement;

  host = await createKernelHost({
    container: stubContainer,
    browser,
    bridge,
    callbacks,
    logger: console,
  });

  // Signal readiness to the page over the kernel port.
  init.kernelPort.postMessage({ type: 'kernel-worker-ready' } satisfies KernelWorkerReadyMsg);
}

// Tear-down on worker close. DedicatedWorker doesn't fire `beforeunload`,
// but the page can post a 'kernel-worker-shutdown' message before
// terminate() so the host gets a chance to dispose cleanly.
self.addEventListener('message', (event: MessageEvent) => {
  const data = event.data as { type?: string };
  if (data?.type !== 'kernel-worker-shutdown') return;
  void host?.dispose();
});
