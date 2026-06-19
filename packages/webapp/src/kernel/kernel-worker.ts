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

import { OffscreenBridge } from '../../../chrome-extension/src/offscreen-bridge.js';
import { BrowserAPI } from '../cdp/browser-api.js';
import { createPanelRpcTrayProvider } from '../cdp/panel-rpc-tray-provider.js';
// Provider registration is async-explicit (not side-effect import).
// `providers/index.ts` switched to lazy `import.meta.glob` to break a
// circular import chain (providers/index → built-in/azure-openai →
// ui/provider-settings → providers/index) that hit TDZ in the worker's
// native ESM module graph in dev mode. Entry points await
// `registerProviders()` during boot before any code that reads from
// the registry runs.
import { registerProviders } from '../providers/index.js';
import { setBridgeToken, setLocalApiBaseUrl } from '../shell/proxied-fetch.js';
import { initTelemetry } from '../ui/telemetry.js';
import { WorkerCdpProxy } from './cdp-worker-proxy.js';
import { createKernelHost, type KernelHost } from './host.js';
import { makeSameOriginBypassFetch } from './kernel-worker-fetch-bypass.js';
import { makeKernelWorkerInitGuard } from './kernel-worker-init-guard.js';
import { getPanelRpcClient } from './panel-rpc.js';
import { createPanelTerminalHost } from './panel-terminal-host.js';
import { createBridgeMessageChannelTransport } from './transport-message-channel.js';
import { startVfsRpcHost } from './vfs-rpc-host.js';

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
  /**
   * Absolute origin (e.g. `http://localhost:5710`) the worker-side
   * `proxied-fetch` realm should target for `/api/fetch-proxy`. Set in
   * thin-bridge mode where the hosted leader serves the UI but has no
   * local /api surface. `null` / undefined falls back to same-origin
   * (the bundled-UI legacy path).
   */
  localApiBaseUrl?: string | null;
  /**
   * Per-process bridge token paired with `localApiBaseUrl`. The worker
   * realm attaches it as the `X-Bridge-Token` header on cross-origin
   * /api/fetch-proxy calls. `null` / undefined outside thin-bridge mode.
   */
  bridgeToken?: string | null;
}

/** Posted back over the kernel port once `createKernelHost` resolves. */
export interface KernelWorkerReadyMsg {
  type: 'kernel-worker-ready';
}

// ---------------------------------------------------------------------------
// Fetch bypass header
// ---------------------------------------------------------------------------

/**
 * Wrap `globalThis.fetch` with a same-origin bypass-header stamper
 * so the page-installed LLM-proxy SW never re-routes a worker-issued
 * request to itself. See `kernel-worker-fetch-bypass.ts` for the
 * full rationale; the short version is that stamping on cross-origin
 * requests would turn every CDN fetch into a CORS-preflighted one,
 * which strict CDNs (jsdelivr et al) reject.
 */
function installFetchBypass(): void {
  const orig = globalThis.fetch;
  if (!orig) return;
  const selfOrigin = self?.location ? self.location.origin : undefined;
  globalThis.fetch = makeSameOriginBypassFetch(orig.bind(globalThis), selfOrigin);
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
let stopVfsRpcHost: (() => void) | null = null;
let panelRpcClient: { dispose: () => void } | null = null;

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
  // Stamp `x-bypass-llm-proxy: 1` on same-origin worker fetches so
  // the page-installed LLM-proxy SW doesn't double-intercept them.
  // Cross-origin requests are intentionally left bare — see
  // `kernel-worker-fetch-bypass.ts` for the CORS-preflight reasoning.
  // Must run before any fetcher does.
  installFetchBypass();

  // Thin-bridge: the hosted leader serves the UI but has no local /api
  // surface, so proxied-fetch must target the bridge-discovered local
  // node-server origin + carry the per-process `X-Bridge-Token` (origin
  // allowlist alone is insufficient — see `bridge-security.ts`). The
  // page realm sets its own copy in `setupStandalonePrelude`.
  setLocalApiBaseUrl(init.localApiBaseUrl ?? null);
  setBridgeToken(init.bridgeToken ?? null);

  // The worker has no `localStorage` (Web Workers don't get one).
  // `provider-settings.getApiKey()` and `selected-model` reads on the
  // worker side would otherwise crash or return empty, which makes
  // `ScoopContext.init` fail with no provider configured. Seed a
  // Map-backed shim from the page's `localStorage` snapshot the page
  // passed in `kernel-worker-init`. The `OffscreenBridge`
  // `local-storage-*` handlers + `installPageStorageSync` on the page
  // keep the shim in sync with subsequent page writes.
  installLocalStorageShim(init.localStorageSeed ?? {});

  // Initialize RUM telemetry so beacons fire from the worker
  // AlmostBashShell and uncaught errors in the agent loop are captured.
  // Without this, `trackShellCommand` and friends silently no-op because
  // `sampleRUM` is per-realm module state. Runs AFTER the localStorage
  // shim so the `telemetry-disabled` / `slicc-rum-debug` keys the page
  // seeded propagate into the worker's `initTelemetry` decision. Fire-
  // and-forget — telemetry init must never block the boot.
  void initTelemetry().catch(() => {});

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
  const { createSprinkleManagerProxyOverChannel } = await import(
    '../scoops/sprinkle-bridge-channel.js'
  );
  (globalThis as Record<string, unknown>).__slicc_sprinkleManager =
    createSprinkleManagerProxyOverChannel({ instanceId: init.instanceId });

  // Publish the panel-RPC bridge client. DOM-bound shell supplemental
  // commands (`screencapture`, `say`, `afplay`, `pbcopy`/`pbpaste`,
  // `open`, plus `playwright`'s appOrigin lookup) detect this global
  // and route their DOM calls to the page handler installed by
  // `mainStandaloneWorker`. See `kernel/panel-rpc.ts` for the op
  // surface. `imgcat` is intentionally NOT bridged — it's terminal-only
  // and the panel AlmostBashShell renders the preview locally.
  const { createPanelRpcClient } = await import('./panel-rpc.js');
  panelRpcClient = createPanelRpcClient({ instanceId: init.instanceId });
  (globalThis as Record<string, unknown>).__slicc_panelRpc = panelRpcClient;

  // Give the worker BrowserAPI a tray target provider so the cone can
  // *drive* federated tray/cherry targets, not just list them. The
  // provider tunnels each CDP op over panel-RPC to the page-side
  // RemoteCDPTransport (which owns the WebRTC channel). Safe to set
  // unconditionally: its methods run only for composite remote ids
  // (which exist only when a tray is active), and with no panel-RPC
  // client they fail closed. See issue #848.
  browser.setTrayTargetProvider(createPanelRpcTrayProvider(getPanelRpcClient));

  // Take the process manager from the kernel host so scoop-turns
  // (registered by `ScoopContext`) and shell execs (registered by
  // `TerminalSessionHost`) land in the same table. `createKernelHost`
  // also publishes it on `globalThis.__slicc_pm` for shell-script
  // callers that can't accept constructor injection.
  const pm = host.processManager;

  // Stand up the terminal-RPC host on the same kernel transport. The
  // shared `createPanelTerminalHost` factory pins parity with the
  // extension offscreen path — both pass `processManager` into
  // `TerminalSessionHost` AND the per-session `AlmostBashShellHeadless` so
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
      // Thread the orchestrator's SudoManager through so the panel
      // shell's explicit `sudo <cmd...>` prompts the human via the same
      // broker the agent uses. The factory pins `transparentGating: false`
      // so plain commands the human types still run ungated.
      sudoManager: host.orchestrator.getSudoManager(),
      logger: console,
    });
    stopTerminalHost = handle.stop;
    // Stand up the worker-side VFS read RPC surface on the same
    // kernel transport. `VirtualFS` satisfies the `LocalVfsClient`
    // shape structurally so we hand `sharedFs` in directly.
    //
    // Also wire `writableClient: sharedFs` so the host accepts
    // `vfs-write-file` / `vfs-mkdir` / `vfs-rm` / `vfs-flush`
    // envelopes from the page-side `WritableVfsClient`. `VirtualFS`
    // satisfies the `WritableVfsBackend` shape structurally. With
    // the OPFS flag off, the page never constructs the writable
    // client so these write request types fan out into nobody —
    // existing behavior is unchanged. With the flag on, the leader
    // tab routes session-freezer + cone-memory writes through this
    // handler.
    const vfsHandle = startVfsRpcHost({
      transport: bridgeTransport,
      client: sharedFs,
      writableClient: sharedFs,
      logger: console,
    });
    stopVfsRpcHost = vfsHandle.stop;
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
  stopVfsRpcHost?.();
  stopVfsRpcHost = null;
  panelRpcClient?.dispose();
  panelRpcClient = null;
  void host?.dispose();
});
