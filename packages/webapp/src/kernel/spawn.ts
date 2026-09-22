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
 *   4. Mint the caller's panel-side client over the kernel-port
 *      transport — the panel's existing UI callbacks (chat, scoops,
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
import type { FeatureFlagFloat } from '../core/feature-flags.js';
import { startPageCdpForwarder } from './cdp-page-forwarder.js';
import type {
  KernelWorkerBootErrorMsg,
  KernelWorkerBootProgressMsg,
  KernelWorkerInitMsg,
  KernelWorkerReadyMsg,
} from './kernel-worker.js';
import type { SyncFsNonce } from './realm/sync-fs-wire.js';
import { createPanelMessageChannelTransport } from './transport-message-channel.js';

/**
 * The page-side kernel-port transport handed to {@link
 * KernelWorkerSpawnOptions.makeClient}. Callers wrap it in their client of
 * choice (the UI shells pass `new OffscreenClient(callbacks, transport)`) —
 * inverted so this kernel-layer module never imports up the stack into
 * `ui/` (layer back-edge paid down with #1984's changes).
 */
export type PanelKernelTransport = ReturnType<typeof createPanelMessageChannelTransport>;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Minimal `Worker`-like surface the bootstrap relies on. */
export interface WorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  terminate(): void;
  /** Optional — real `Worker` has it; the mock may omit it. */
  addEventListener?(type: 'error', listener: () => void): void;
}

export interface KernelWorkerSpawnOptions<TClient> {
  /**
   * Optional override for the worker URL. Defaults to
   * `DEFAULT_KERNEL_WORKER_URL` (the Vite-bundled
   * `./kernel-worker.ts`). Override only if loading the worker from a
   * non-default location (e.g. a test harness or a custom asset path).
   */
  workerUrl?: string | URL;
  /** Real CDP transport (WebSocket-backed `CDPClient` in standalone). */
  realCdpTransport: CDPTransport;
  /**
   * Re-dial `realCdpTransport` when a worker CDP command arrives while it is
   * disconnected (the `/cdp` proxy closes it with `upstream-reset` after
   * rebuilding its Chrome leg). Standalone passes the page `BrowserAPI`'s
   * reconnect so the bridge URL + subprotocol token are replayed. Optional;
   * without it the worker fails fast until the page's own lazy reconnect.
   */
  reconnectCdp?: () => Promise<void>;
  /**
   * Build the panel-side client over the kernel-port transport. The UI
   * shells pass `(t) => new OffscreenClient(callbacks, t)`; inverted so
   * this kernel-layer module never imports `ui/`.
   */
  makeClient: (transport: PanelKernelTransport) => TClient;
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
  /**
   * Absolute origin (e.g. `http://localhost:5710`) the worker-side
   * proxied-fetch realm should target for `/api/fetch-proxy`. Set in
   * thin-bridge mode where the hosted leader serves the UI but has no
   * local /api surface. `null` / undefined falls back to same-origin.
   */
  localApiBaseUrl?: string | null;
  /**
   * Per-process bridge token paired with `localApiBaseUrl`. Forwarded
   * to the worker-side `proxied-fetch` realm so cross-origin /api/*
   * calls carry the required `X-Bridge-Token` header. `null` / undefined
   * outside thin-bridge mode.
   */
  bridgeToken?: string | null;
  /**
   * Enable the realm synchronous-fs SW bridge. The page sets this only after
   * confirming a controlling Service Worker (see `ui/wc/wc-live.ts`); forwarded to the
   * worker via `KernelWorkerInitMsg.syncFsBridgeEnabled`. Default off keeps the
   * bounded snapshot behavior.
   */
  syncFsBridgeEnabled?: boolean;
  /**
   * Per-session nonce naming the sync-fs SW↔responder BroadcastChannel. The
   * page mints it alongside `syncFsBridgeEnabled` and hands it to BOTH the
   * kernel (this init) and the SW (`controller.postMessage`); realms never see
   * it, so the channel is effectively private (see `sync-fs-wire.ts`).
   */
  syncFsChannelNonce?: SyncFsNonce | null;
  /**
   * Absolute lick-WS URL (e.g. `ws://localhost:5710/licks-ws`) the
   * worker-resident `/licks-ws` bridge should dial in thin-bridge mode.
   * Set when the hosted leader serves the UI but the node-server lives
   * on a different origin — deriving the URL from `self.location.href`
   * inside the worker would dial the UI origin instead. `null` /
   * undefined falls back to same-origin (the legacy bundled-UI path).
   */
  localLickWsUrl?: string | null;
  /**
   * Extension id of the thin-bridge leader's extension. Forwarded to the
   * worker-side `proxied-fetch` realm so cross-origin shell fetches bridge
   * to the extension Port through the page. `null` / undefined outside the
   * thin-bridge extension leader.
   */
  extensionDelegateId?: string | null;
  /**
   * The page's resolved feature-flag float (its `UiRuntimeMode`) — the
   * worker adopts the page's cached remote flag values for it at boot so
   * worker-realm `isFeatureEnabled` matches the page (#2003).
   */
  flagFloat?: FeatureFlagFloat | null;
  /** Page-side hook fired on ANY uncaught kernel-worker `error` event — notably a
   *  stale worker ENTRY chunk failing to load after a deploy (the worker never
   *  evaluates, so its own boot catch can't run). Not message-filtered: a
   *  load-failure ErrorEvent is often opaque, and the shared guarded reload makes
   *  even an unrelated worker error reload at most once. (#1330) */
  onWorkerScriptError?: () => void;
  /** See {@link KernelWorkerBootstrapOptions.onReadyStall}. */
  onReadyStall?: (info: ReadyStallInfo) => void;
  /** See {@link KernelWorkerBootstrapOptions.readyStallLimit}. */
  readyStallLimit?: number;
  /** See {@link KernelWorkerBootstrapOptions.onLateReady}. */
  onLateReady?: () => void;
  /** See {@link KernelWorkerBootstrapOptions.onBootProgress}. */
  onBootProgress?: (stage: string) => void;
}

/** Passed to {@link KernelWorkerBootstrapOptions.onReadyStall} per watchdog fire. */
export interface ReadyStallInfo {
  /** Wall-clock ms since the ready deadline was last armed, not since page load. */
  elapsedMs: number;
  /** Consecutive watchdog fires with zero boot progress (1-based). */
  stalls: number;
  /** Latest `kernel-worker-boot-progress` stage, when the worker has reported one. */
  stage?: string;
}

export interface KernelWorkerBootstrapOptions<TClient> {
  worker: WorkerLike;
  realCdpTransport: CDPTransport;
  /** See {@link KernelWorkerSpawnOptions.reconnectCdp}. */
  reconnectCdp?: () => Promise<void>;
  /** See {@link KernelWorkerSpawnOptions.makeClient}. */
  makeClient: (transport: PanelKernelTransport) => TClient;
  readyTimeoutMs?: number;
  localStorageSeed?: Record<string, string>;
  /**
   * Per-instance discriminator forwarded to the worker so same-origin
   * RPC channels (e.g. the sprinkle BroadcastChannel bridge) stay
   * scoped to one tab/worker pair. Optional.
   */
  instanceId?: string;
  /** See `KernelWorkerSpawnOptions.localApiBaseUrl`. */
  localApiBaseUrl?: string | null;
  /** See `KernelWorkerSpawnOptions.syncFsBridgeEnabled`. */
  syncFsBridgeEnabled?: boolean;
  /** See `KernelWorkerSpawnOptions.syncFsChannelNonce`. */
  syncFsChannelNonce?: SyncFsNonce | null;
  /** See `KernelWorkerSpawnOptions.bridgeToken`. */
  bridgeToken?: string | null;
  /** See `KernelWorkerSpawnOptions.localLickWsUrl`. */
  localLickWsUrl?: string | null;
  /** See `KernelWorkerSpawnOptions.extensionDelegateId`. */
  extensionDelegateId?: string | null;
  /** See `KernelWorkerSpawnOptions.flagFloat`. */
  flagFloat?: FeatureFlagFloat | null;
  /** Page-side hook fired on ANY uncaught kernel-worker `error` event — notably a
   *  stale worker ENTRY chunk failing to load after a deploy (the worker never
   *  evaluates, so its own boot catch can't run). Not message-filtered: a
   *  load-failure ErrorEvent is often opaque, and the shared guarded reload makes
   *  even an unrelated worker error reload at most once. (#1330) */
  onWorkerScriptError?: () => void;
  /**
   * Fired when the ready watchdog expires but the boot is given another
   * window instead of failing (see {@link readyStallLimit}). The page uses
   * this to surface a non-destructive "still starting" state over the
   * already-wired shell — everything except the final `ready` await is set
   * up before the worker replies, so a late `kernel-worker-ready` resumes
   * the normal boot path with no reload (2026-08-24 field wedge: an 8-minute
   * sidecar repair finished AFTER the page had already bricked itself).
   */
  onReadyStall?: (info: ReadyStallInfo) => void;
  /**
   * Consecutive zero-progress watchdog windows tolerated before `ready`
   * rejects for real. Any `kernel-worker-boot-progress` resets the count —
   * the limit bounds SILENCE, not boot time. Defaults to 3 when
   * {@link onReadyStall} is provided (stall UI exists, so waiting is safe)
   * and 1 otherwise (legacy single-window behavior).
   */
  readyStallLimit?: number;
  /**
   * Fired if `kernel-worker-ready` arrives AFTER `ready` already rejected.
   * When set, the rejection path keeps the ready listener attached instead
   * of tearing it down, so a worker that finishes booting behind a recovery
   * screen is heard rather than discarded. The listener is removed once
   * this fires (or on `dispose()`).
   */
  onLateReady?: () => void;
  /**
   * Fired for each `kernel-worker-boot-progress` stage (`orchestrator-ready`,
   * `scoop-restored:<jid>`, `lick-manager-ready`, `mounts-restored`,
   * `cone-bootstrapped`, …). The page shows the stage on the boot status.
   * Reporting a stage also re-arms the ready deadline, unless the deadline
   * is paused for a leader-lock wait.
   */
  onBootProgress?: (stage: string) => void;
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

export interface SpawnedKernelHost<TClient> {
  /** Panel-side client, minted by the caller's `makeClient` factory. */
  client: TClient;
  /** Resolves when the worker has finished `createKernelHost`. */
  ready: Promise<void>;
  /**
   * Stop the ready clock without rejecting. Time spent paused does not
   * count: a tab deferred on the `slicc-tray-leader` Web Lock calls this
   * so minutes of waiting are not boot time. Boot-progress still updates
   * the stage, but does not start the failure window.
   */
  pauseReadyDeadline(): void;
  /**
   * Arm a fresh stall window from now and clear the pause. Call when the
   * leader-lock wait ends (late promotion, or a promotion the tab declines)
   * so the deadline measures kernel progress, not time since page load.
   */
  restartReadyDeadline(): void;
  /** Tear down the worker, the CDP forwarder, and close both ports. */
  dispose(): void;
}

// ---------------------------------------------------------------------------
// Bootstrap (testable)
// ---------------------------------------------------------------------------

/**
 * Silence watchdog for `kernel-worker-ready`.
 *
 * The clock bounds quiet time, not wall time since page load. Each
 * `kernel-worker-boot-progress` re-arms one window and clears the stall
 * count. `pause` drops the clock entirely (a tab waiting on the tray-leader
 * lock); `restart` arms a fresh window from that moment. Only
 * `readyStallLimit` consecutive quiet windows reject.
 */
function createReadyDeadline(options: {
  readyTimeoutMs: number;
  readyStallLimit: number;
  onReadyStall?: (info: ReadyStallInfo) => void;
  onBootProgress?: (stage: string) => void;
  onExhausted: (message: string) => void;
}): {
  pause(): void;
  restart(): void;
  arm(): void;
  clear(): void;
  noteProgress(stage: string | undefined): void;
  /** True once the stall budget rejected. Later progress must not re-arm. */
  timedOut(): boolean;
} {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let paused = false;
  let stopped = false;
  let exhausted = false;
  let stalls = 0;
  let startedAt = Date.now();
  let stage: string | undefined;

  const clearTimer = (): void => {
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
  };
  const arm = (): void => {
    clearTimer();
    if (paused || stopped || exhausted) return;
    timeoutId = setTimeout(() => {
      if (paused || stopped || exhausted) return;
      stalls += 1;
      if (stalls < options.readyStallLimit) {
        options.onReadyStall?.({ elapsedMs: Date.now() - startedAt, stalls, stage });
        arm();
        return;
      }
      exhausted = true;
      clearTimer();
      const budget = options.readyTimeoutMs * options.readyStallLimit;
      const where = stage ? ` (last progress: ${stage})` : '';
      options.onExhausted(`Kernel worker did not signal ready within ${budget}ms${where}`);
    }, options.readyTimeoutMs);
  };

  return {
    pause() {
      if (stopped || exhausted) return;
      paused = true;
      clearTimer();
    },
    restart() {
      if (stopped || exhausted) return;
      paused = false;
      stalls = 0;
      startedAt = Date.now();
      arm();
    },
    arm,
    clear() {
      stopped = true;
      clearTimer();
    },
    noteProgress(next: string | undefined) {
      if (next) {
        stage = next;
        options.onBootProgress?.(next);
      }
      // A paused clock stays paused: heartbeats during a leader-lock wait
      // update the stage and must not start the failure window.
      if (paused || stopped || exhausted) return;
      stalls = 0;
      arm();
    },
    timedOut: () => exhausted,
  };
}

/**
 * Watch the kernel port for the boot handshake and arm the ready watchdog.
 *
 * Single cleanup path: `cleanup()` removes the listener AND clears whichever
 * timer is armed. Called from the success branch, the hard-timeout branch,
 * the late-ready branch, AND from the host's `dispose()` so a caller that
 * disposes before the worker replies doesn't leave the listener attached for
 * the worker's lifetime.
 */
function watchKernelReady(
  port: MessagePort,
  options: Pick<
    KernelWorkerBootstrapOptions<unknown>,
    'onReadyStall' | 'readyStallLimit' | 'onLateReady' | 'onBootProgress'
  >,
  readyTimeoutMs: number
): {
  ready: Promise<void>;
  cleanup: () => void;
  pauseReadyDeadline: () => void;
  restartReadyDeadline: () => void;
} {
  let cleanupReady: () => void = () => {};
  let pauseReadyDeadline: () => void = () => {};
  let restartReadyDeadline: () => void = () => {};
  const ready = new Promise<void>((resolve, reject) => {
    let listener: ((event: MessageEvent) => void) | null = null;
    const readyStallLimit = Math.max(1, options.readyStallLimit ?? (options.onReadyStall ? 3 : 1));
    const deadline = createReadyDeadline({
      readyTimeoutMs,
      readyStallLimit,
      onReadyStall: options.onReadyStall,
      onBootProgress: options.onBootProgress,
      onExhausted: (message) => {
        // With onLateReady, keep the listener so a late kernel-worker-ready
        // is still heard. The deadline has already cleared its timer.
        if (!options.onLateReady) cleanupReady();
        reject(new Error(message));
      },
    });
    pauseReadyDeadline = () => deadline.pause();
    restartReadyDeadline = () => deadline.restart();

    cleanupReady = (): void => {
      if (listener !== null) {
        port.removeEventListener('message', listener as EventListener);
        listener = null;
      }
      deadline.clear();
    };
    listener = (event: MessageEvent): void => {
      const data = event.data as
        | Partial<KernelWorkerReadyMsg>
        | Partial<KernelWorkerBootErrorMsg>
        | Partial<KernelWorkerBootProgressMsg>
        | null;
      // #2007: a boot-progress heartbeat means the worker is still
      // advancing (orchestrator up, a scoop restored, cone bootstrapped,
      // …) — re-arm the clock so the timeout is a stall watchdog, not a
      // hard cap on a slow-but-healthy boot.
      if (data?.type === 'kernel-worker-boot-progress') {
        deadline.noteProgress((data as Partial<KernelWorkerBootProgressMsg>).stage);
        return;
      }
      if (data?.type === 'kernel-worker-ready') {
        cleanupReady();
        if (deadline.timedOut()) {
          // `ready` already rejected — the page moved on (recovery screen /
          // stall UI). Report the late arrival instead of resolving into a
          // settled promise nobody is awaiting.
          options.onLateReady?.();
          return;
        }
        resolve();
        return;
      }
      // Boot failed with a known cause: reject NOW with the real error
      // instead of letting the 30s timeout produce a generic message next
      // to the recovery screen's data-wipe button (#1984). `.code` rides
      // along so future recovery UI can special-case storage-shaped
      // failures.
      if (data?.type === 'kernel-worker-boot-error') {
        cleanupReady();
        const detail = (data as Partial<KernelWorkerBootErrorMsg>).message ?? 'unknown error';
        const code = (data as Partial<KernelWorkerBootErrorMsg>).code;
        const error = new Error(`Kernel worker boot failed: ${detail}`);
        if (code) (error as Error & { code?: string }).code = code;
        reject(error);
      }
    };
    port.addEventListener('message', listener as EventListener);
    deadline.arm();
  });
  return {
    ready,
    cleanup: () => cleanupReady(),
    pauseReadyDeadline: () => pauseReadyDeadline(),
    restartReadyDeadline: () => restartReadyDeadline(),
  };
}

/**
 * Wire up an existing Worker-like instance to a kernel host. Used by
 * `spawnKernelWorker` and by tests with a mock worker.
 */
export function bootstrapKernelWorker<TClient>(
  options: KernelWorkerBootstrapOptions<TClient>
): SpawnedKernelHost<TClient> {
  const { worker, realCdpTransport } = options;
  const readyTimeoutMs = options.readyTimeoutMs ?? 30_000;
  const localStorageSeed = options.localStorageSeed ?? {};

  const kernelChannel = new MessageChannel();
  const cdpChannel = new MessageChannel();

  // Panel-side client over the kernel port. Wraps payloads with
  // `source: 'panel'` so the worker-side bridge's source filter matches
  // exactly what chrome.runtime would have delivered.
  const panelTransport = createPanelMessageChannelTransport(kernelChannel.port1);
  const client = options.makeClient(panelTransport);

  // Attach the worker error listener before any async work so an uncaught
  // worker `error` event — notably a stale worker ENTRY chunk failing to load —
  // calls onWorkerScriptError.
  if (options.onWorkerScriptError) {
    options.worker.addEventListener?.('error', () => options.onWorkerScriptError!());
  }

  // Pump real CDP commands ⇄ wire on the cdp port.
  const stopForwarder = startPageCdpForwarder(cdpChannel.port1, realCdpTransport, {
    ...(options.reconnectCdp ? { reconnect: options.reconnectCdp } : {}),
  });

  // Wait for `kernel-worker-ready` on the kernel port. The OffscreenClient
  // already started this port via its onMessage subscription; the watcher
  // adds a second listener that resolves on the boot signal.
  const {
    ready,
    cleanup: cleanupReady,
    pauseReadyDeadline,
    restartReadyDeadline,
  } = watchKernelReady(kernelChannel.port1, options, readyTimeoutMs);

  // Hand the worker its ports. After `postMessage` with a transferable
  // list, the page can no longer use port2 of either channel — that's
  // intended; the worker now owns them.
  const init: KernelWorkerInitMsg = {
    type: 'kernel-worker-init',
    kernelPort: kernelChannel.port2,
    cdpPort: cdpChannel.port2,
    localStorageSeed,
    instanceId: options.instanceId,
    localApiBaseUrl: options.localApiBaseUrl ?? null,
    bridgeToken: options.bridgeToken ?? null,
    syncFsBridgeEnabled: options.syncFsBridgeEnabled ?? false,
    syncFsChannelNonce: options.syncFsChannelNonce ?? null,
    localLickWsUrl: options.localLickWsUrl ?? null,
    extensionDelegateId: options.extensionDelegateId ?? null,
    // Inlined into THIS (page-graph) chunk at build time; the worker
    // compares it against its own copy to catch mixed-build graphs after
    // a mid-session deploy (#1983).
    pageBuildId: __SLICC_BUILD_ID__,
    // When the browser window was last loaded. The worker's own
    // `performance.timeOrigin` is later — it is when the worker was
    // constructed — so `uptime` needs the page's (#2819).
    pageLoadedAt: globalThis.performance?.timeOrigin ?? Date.now(),
    flagFloat: options.flagFloat ?? null,
    // The leader tab's own URL, so the worker's NavigationWatcher can keep its
    // `Network` domain off this tab (issue #2417 follow-up). Read here rather than passed in:
    // every caller of this function runs in the page realm, and the value is
    // the page's identity, not a per-float configuration knob.
    appPageUrl: globalThis.location?.href ?? null,
  };
  worker.postMessage(init, [kernelChannel.port2, cdpChannel.port2]);

  let disposed = false;
  return {
    client,
    ready,
    pauseReadyDeadline,
    restartReadyDeadline,
    dispose() {
      if (disposed) return;
      disposed = true;
      // Tear down the ready-watcher BEFORE closing the port so a
      // callback racing in flight gets removed, not orphaned. The
      // timeout fires the rejection if `ready` is still pending; we
      // don't resolve it here.
      cleanupReady();
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
 * (this worker's `boot()` and the page's `main.ts`) await it during
 * boot.
 */
export function spawnKernelWorker<TClient>(
  options: KernelWorkerSpawnOptions<TClient>
): SpawnedKernelHost<TClient> {
  const worker = options.workerUrl
    ? new Worker(options.workerUrl, { type: 'module' })
    : new Worker(new URL('./kernel-worker.ts', import.meta.url), { type: 'module' });
  return bootstrapKernelWorker({
    worker,
    realCdpTransport: options.realCdpTransport,
    reconnectCdp: options.reconnectCdp,
    makeClient: options.makeClient,
    readyTimeoutMs: options.readyTimeoutMs,
    localStorageSeed: options.localStorageSeed ?? collectLocalStorageSeed(),
    instanceId: options.instanceId,
    localApiBaseUrl: options.localApiBaseUrl,
    bridgeToken: options.bridgeToken,
    syncFsBridgeEnabled: options.syncFsBridgeEnabled,
    syncFsChannelNonce: options.syncFsChannelNonce,
    localLickWsUrl: options.localLickWsUrl,
    extensionDelegateId: options.extensionDelegateId,
    flagFloat: options.flagFloat,
    onWorkerScriptError: options.onWorkerScriptError,
    onReadyStall: options.onReadyStall,
    readyStallLimit: options.readyStallLimit,
    onLateReady: options.onLateReady,
    onBootProgress: options.onBootProgress,
  });
}
