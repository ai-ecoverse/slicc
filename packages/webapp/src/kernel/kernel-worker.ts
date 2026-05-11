/**
 * `kernel-worker.ts` — DedicatedWorker entry for the standalone kernel host.
 *
 * The worker:
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
 * Worker safety: this file lives in `tsconfig.webapp-worker.json` and
 * must not reference DOM globals. The orchestrator's `container` arg
 * is unused at runtime today (stored but never read), so we pass a
 * stub typed as `HTMLElement` to satisfy the constructor signature.
 */

/// <reference lib="webworker" />

import { BrowserAPI } from '../cdp/browser-api.js';
import { OffscreenBridge } from '../../../chrome-extension/src/offscreen-bridge.js';
import { createKernelHost, type KernelHost } from './host.js';
import { createBridgeMessageChannelTransport } from './transport-message-channel.js';
import { WorkerCdpProxy } from './cdp-worker-proxy.js';
import { createPanelTerminalHost } from './panel-terminal-host.js';
import { makeKernelWorkerInitGuard } from './kernel-worker-init-guard.js';

// Provider registration is async-explicit (not side-effect import).
// `providers/index.ts` switched to lazy `import.meta.glob` to break a
// circular import chain (providers/index → built-in/azure-openai →
// ui/provider-settings → providers/index) that hit TDZ in the worker's
// native ESM module graph in dev mode. Entry points await
// `registerProviders()` during boot before any code that reads from
// the registry runs.
import { registerProviders } from '../providers/index.js';

declare const self: DedicatedWorkerGlobalScope;

// ---------------------------------------------------------------------------
// Init protocol
// ---------------------------------------------------------------------------

/**
 * The page sends this once at boot. `kernelPort` carries the
 * `ExtensionMessage` envelope stream that `OffscreenBridge` listens on
 * and emits over. `cdpPort` carries the kernel-CDP wire that
 * `WorkerCdpProxy` ⇄ `startPageCdpForwarder` use. `localStorageSeed`
 * is a snapshot of the page's `localStorage` keys/values so the
 * worker — which doesn't have its own `localStorage` — can serve
 * `provider-settings.getApiKey()` and friends from a shim;
 * `installPageStorageSync` keeps the shim in sync with subsequent
 * page writes.
 *
 * Sent via `worker.postMessage(init, [kernelPort, cdpPort])` so the
 * ports are transferred (not copied).
 */
export interface KernelWorkerInitMsg {
  type: 'kernel-worker-init';
  kernelPort: MessagePort;
  cdpPort: MessagePort;
  localStorageSeed?: Record<string, string>;
  /**
   * Per-instance discriminator used by same-origin RPC channels (e.g.
   * the sprinkle BroadcastChannel bridge) so two SLICC tabs on the
   * same origin don't cross-talk. The page generates this once at
   * boot and the worker reuses it when constructing channel names.
   * Optional: callers that don't need scoping can omit it and the
   * bridge falls back to a global channel name.
   */
  instanceId?: string;
}

/** Posted back over the kernel port once `createKernelHost` resolves. */
export interface KernelWorkerReadyMsg {
  type: 'kernel-worker-ready';
}

// ---------------------------------------------------------------------------
// Fetch bypass header
// ---------------------------------------------------------------------------

/**
 * Wrap `globalThis.fetch` to add `x-bypass-llm-proxy: 1` to every
 * outgoing request from the worker.
 *
 * Why: in standalone, the page registers `/llm-proxy-sw.js` as a
 * service worker that intercepts cross-origin LLM provider fetches
 * and reroutes them through `/api/fetch-proxy` to bypass CORS in
 * dev. The kernel worker is spawned by a SW-controlled page; in
 * Chromium, module-worker fetches can also be intercepted by the
 * page's SW. We don't want that — the worker has direct network
 * access (the LLM-proxy is for the page's `dist/ui` bundle), and
 * double-rerouting through `/api/fetch-proxy` would change the
 * origin / break credentials.
 *
 * The SW already honors `x-bypass-llm-proxy: 1` (see
 * `packages/webapp/src/ui/llm-proxy-sw.ts:71`). Installing this
 * wrapper at worker boot, before any fetcher runs, lets the SW
 * pass-through every worker-issued request.
 */
function installFetchBypass(): void {
  const orig = globalThis.fetch;
  if (!orig) return;
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    if (!headers.has('x-bypass-llm-proxy')) {
      headers.set('x-bypass-llm-proxy', '1');
    }
    return orig(input, { ...init, headers });
  };
}

// ---------------------------------------------------------------------------
// localStorage shim
// ---------------------------------------------------------------------------

/**
 * Install a Storage-shaped shim on `globalThis.localStorage`. Web
 * Workers don't have a real `localStorage`; the page passes a snapshot
 * of its keys/values via `kernel-worker-init.localStorageSeed`. Writes
 * from the worker only stay in the worker's Map and don't propagate
 * back to the page (changes to model/provider come FROM the page, so
 * the worker just needs to read). `installPageStorageSync` on the
 * page mirrors subsequent page writes into the worker's shim.
 */
function installLocalStorageShim(seed: Record<string, string>): void {
  const store = new Map<string, string>(Object.entries(seed));
  const shim: Storage = {
    get length(): number {
      return store.size;
    },
    key(index: number): string | null {
      return Array.from(store.keys())[index] ?? null;
    },
    getItem(key: string): string | null {
      return store.has(key) ? store.get(key)! : null;
    },
    setItem(key: string, value: string): void {
      store.set(key, value);
    },
    removeItem(key: string): void {
      store.delete(key);
    },
    clear(): void {
      store.clear();
    },
  };
  // Define on globalThis so `localStorage.getItem(...)` and
  // `window.localStorage` (where guarded) resolve to the shim.
  Object.defineProperty(globalThis, 'localStorage', {
    value: shim,
    configurable: true,
    writable: true,
  });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

let host: KernelHost | null = null;
let stopTerminalHost: (() => void) | null = null;

/**
 * Wire the init listener using a double-init guard. Exported via
 * `makeKernelWorkerInitGuard` so tests can exercise the guard
 * without pulling in the worker-global side effects of this module.
 *
 * Without the guard, two concurrent `boot()` calls would race on
 * `createKernelHost`, `orchestrator.init`, and `globalThis.__slicc_pm`,
 * leaving the host in indeterminate state.
 */
const initGuard = makeKernelWorkerInitGuard((init) => boot(init));

self.addEventListener('message', (event: MessageEvent) => {
  const data = event.data as { type?: string };
  if (data?.type !== 'kernel-worker-init') return;
  initGuard.handle(event.data as KernelWorkerInitMsg);
});

async function boot(init: KernelWorkerInitMsg): Promise<void> {
  // Stamp `x-bypass-llm-proxy: 1` on every worker-issued fetch so the
  // page-installed LLM-proxy SW doesn't double-intercept worker
  // requests. Must run before any fetcher does.
  installFetchBypass();

  // The worker has no `localStorage` (Web Workers don't get one).
  // `provider-settings.getApiKey()` and `selected-model` reads on the
  // worker side would otherwise crash or return empty, which makes
  // `ScoopContext.init` fail with no provider configured. Seed a
  // Map-backed shim from the page's `localStorage` snapshot the page
  // passed in `kernel-worker-init`. The `OffscreenBridge`
  // `local-storage-*` handlers + `installPageStorageSync` on the page
  // keep the shim in sync with subsequent page writes.
  installLocalStorageShim(init.localStorageSeed ?? {});

  // Register providers first — kernel host construction reads the
  // provider registry (via scoop-context → provider-settings).
  await registerProviders();

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

  // Publish a sprinkle-manager proxy on the worker's globalThis so the
  // `sprinkle` / `open` / `upskill` shell commands can reach the real
  // page-side manager. The bridge uses a same-origin BroadcastChannel
  // scoped by `instanceId` (page-generated, threaded through
  // `kernel-worker-init`) so two SLICC tabs on the same origin don't
  // cross-talk. The page bootstrap (`mainStandaloneWorker`) installs
  // the matching handler under the same id. Extension offscreen has
  // its own chrome.runtime-based proxy in `offscreen.ts` and never
  // goes through this path.
  const { createSprinkleManagerProxyOverChannel } =
    await import('../scoops/sprinkle-bridge-channel.js');
  (globalThis as Record<string, unknown>).__slicc_sprinkleManager =
    createSprinkleManagerProxyOverChannel({ instanceId: init.instanceId });

  // Publish the panel-RPC bridge client. DOM-bound shell supplemental
  // commands (`screencapture`, `say`, `afplay`, `pbcopy`/`pbpaste`,
  // `imgcat`, `open`, plus `playwright`'s appOrigin lookup) detect this
  // global and route their DOM calls to the page handler installed by
  // `mainStandaloneWorker`. See `kernel/panel-rpc.ts` for the op surface.
  const { createPanelRpcClient } = await import('./panel-rpc.js');
  (globalThis as Record<string, unknown>).__slicc_panelRpc = createPanelRpcClient({
    instanceId: init.instanceId,
  });

  // Take the process manager from the kernel host so scoop-turns
  // (registered by `ScoopContext`) and shell execs (registered by
  // `TerminalSessionHost`) land in the same table. `createKernelHost`
  // also publishes it on `globalThis.__slicc_pm` for shell-script
  // callers that can't accept constructor injection.
  const pm = host.processManager;

  // Stand up the terminal-RPC host on the same kernel transport. The
  // shared `createPanelTerminalHost` factory pins parity with the
  // extension offscreen path — both pass `processManager` into
  // `TerminalSessionHost` AND the per-session `WasmShellHeadless` so
  // `ps` / `kill` / `/proc` see the same table.
  //
  // Falls back to a no-op if the orchestrator failed to publish a
  // shared FS (logged at host construction); the panel terminal-view
  // surfaces this as a `terminal-status: error` to its open promise.
  const sharedFs = host.sharedFs;
  if (sharedFs) {
    const handle = createPanelTerminalHost({
      transport: bridgeTransport,
      fs: sharedFs,
      browser,
      processManager: pm,
      logger: console,
    });
    stopTerminalHost = handle.stop;
  } else {
    console.warn('[kernel-worker] shared FS unavailable; terminal sessions will fail to open');
  }

  // Signal readiness to the page over the kernel port.
  init.kernelPort.postMessage({ type: 'kernel-worker-ready' } satisfies KernelWorkerReadyMsg);
}

// Tear-down on worker close. DedicatedWorker doesn't fire `beforeunload`,
// but the page can post a 'kernel-worker-shutdown' message before
// terminate() so the host gets a chance to dispose cleanly.
self.addEventListener('message', (event: MessageEvent) => {
  const data = event.data as { type?: string };
  if (data?.type !== 'kernel-worker-shutdown') return;
  stopTerminalHost?.();
  stopTerminalHost = null;
  void host?.dispose();
});
