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
import { TerminalSessionHost } from './terminal-session-host.js';
import { WasmShellHeadless } from '../shell/wasm-shell-headless.js';

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
 * `provider-settings.getApiKey()` and friends from a shim. Phase 2.7
 * will replace this with a proper page↔worker state-sync mechanism;
 * the seed is a Phase 2.6d minimal fix to unblock the smoke test.
 *
 * Sent via `worker.postMessage(init, [kernelPort, cdpPort])` so the
 * ports are transferred (not copied).
 */
export interface KernelWorkerInitMsg {
  type: 'kernel-worker-init';
  kernelPort: MessagePort;
  cdpPort: MessagePort;
  localStorageSeed?: Record<string, string>;
}

/** Posted back over the kernel port once `createKernelHost` resolves. */
export interface KernelWorkerReadyMsg {
  type: 'kernel-worker-ready';
}

// ---------------------------------------------------------------------------
// Fetch bypass header (Phase 2.7 polish)
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
// localStorage shim (Phase 2.6d)
// ---------------------------------------------------------------------------

/**
 * Install a Storage-shaped shim on `globalThis.localStorage`. Web
 * Workers don't have a real `localStorage`; the page passes a snapshot
 * of its keys/values via `kernel-worker-init.localStorageSeed`. The
 * shim is read-only at this Phase — writes from the worker only stay
 * in the worker's Map and don't propagate back to the page (changes
 * to model/provider come FROM the page, so the worker just needs to
 * read).
 *
 * Phase 2.7 will replace this with a proper bidirectional state-sync
 * channel (e.g. a Storage-event mirror over the kernel transport).
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

self.addEventListener('message', (event: MessageEvent) => {
  const data = event.data as { type?: string };
  if (data?.type !== 'kernel-worker-init') return;
  const init = event.data as KernelWorkerInitMsg;
  void boot(init).catch((err) => {
    console.error('[kernel-worker] boot failed', err);
  });
});

async function boot(init: KernelWorkerInitMsg): Promise<void> {
  // Phase 2.7: stamp `x-bypass-llm-proxy: 1` on every worker-issued
  // fetch so the page-installed LLM-proxy SW doesn't double-intercept
  // worker requests. Must run before any fetcher does.
  installFetchBypass();

  // Phase 2.6d minimal fix: the worker has no `localStorage` (Web
  // Workers don't get one). `provider-settings.getApiKey()` and
  // `selected-model` reads on the worker side would otherwise crash
  // or return empty, which makes `ScoopContext.init` fail with no
  // provider configured. Seed a Map-backed shim from the page's
  // `localStorage` snapshot the page passed in `kernel-worker-init`.
  // Phase 2.7 polish (`OffscreenBridge` `local-storage-*` handlers +
  // `installPageStorageSync` on the page) keeps the shim in sync
  // with subsequent page writes.
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

  // Phase 3.2/3.3: take the process manager from the kernel host so
  // scoop-turns (registered by `ScoopContext`) and shell execs
  // (registered by `TerminalSessionHost`) land in the same table.
  // `createKernelHost` also publishes it on `globalThis.__slicc_pm`
  // for shell-script callers that can't accept constructor injection.
  const pm = host.processManager;

  // Phase 2b step 5a: stand up the terminal-RPC host on the same kernel
  // transport. The factory builds a fresh `WasmShellHeadless` per
  // session over the orchestrator's shared FS so terminal `cd` state
  // and `mount`/`git` commands hit the same backing store the agent
  // sees. Sessions are terminal-scoped — each panel terminal-view
  // opens its own session, and `terminal-close` disposes the shell.
  //
  // Falls back to a no-op if the orchestrator failed to publish a
  // shared FS (logged at host construction); the panel terminal-view
  // surfaces this as a `terminal-status: error` to its open promise.
  const sharedFs = host.sharedFs;
  if (sharedFs) {
    const terminalHost = new TerminalSessionHost({
      transport: bridgeTransport,
      createShell: (_sid, opts) =>
        new WasmShellHeadless({
          fs: sharedFs,
          cwd: opts.cwd,
          env: opts.env,
          browserAPI: browser,
        }),
      processManager: pm,
      logger: console,
    });
    stopTerminalHost = terminalHost.start();
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
