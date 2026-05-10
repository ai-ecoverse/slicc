/**
 * `createKernelHost` — the kernel boot factory.
 *
 * Encapsulates the moveable parts of the offscreen-side boot sequence
 * so the same factory can back two floats:
 *
 *  - **Extension**: `offscreen.ts` calls `createKernelHost(...)` and
 *    wraps it with extension-specific bits (CDP proxy construction,
 *    sprinkle BroadcastChannel host, tray-runtime sync, chrome.runtime
 *    listeners for `agent-spawn-request` / `get-session-costs` /
 *    `navigate-lick`, startup `offscreen-ready` emission).
 *
 *  - **Standalone**: `kernel-worker.ts` also calls `createKernelHost(...)`,
 *    with a `MessageChannel`-backed bridge instead of the chrome.runtime
 *    one.
 *
 * What the factory wires up (matches offscreen.ts 1:1):
 *
 *  1. `Orchestrator` with the supplied callbacks + `getBrowserAPI`.
 *  2. `bridge.bind(orchestrator, browser)`.
 *  3. Tray-runtime subscription so leader/follower status pushes to the
 *     panel via `bridge.emitTrayRuntimeStatus()`.
 *  4. `orchestrator.init()`.
 *  5. `publishAgentBridge` on `globalThis.__slicc_agent` (worker-safe;
 *     no chrome.runtime).
 *  6. `registerSessionCostsProvider` — supplemental commands consult
 *     this for the `cost` shell command.
 *  7. `LickManager.init()` + default lick-event handler that mirrors
 *     offscreen's behavior (route via `formatLickEventForCone` to the
 *     cone or the named target scoop). Callers that need different
 *     routing (the standalone wizard's onboarding flow) supply
 *     `lickEventHandler`.
 *  8. `globalThis.__slicc_lickManager = lickManager`.
 *  9. `recoverMounts` against the shared FS, emitting a `session-reload`
 *     lick if any mount needs user re-consent. Fire-and-forget.
 *  10. Cone bootstrap (skippable via `skipConeBootstrap`).
 *  11. Upgrade detection.
 *  12. `BshWatchdog` start.
 *
 * What the factory deliberately does NOT do (because it varies per
 * float):
 *  - Construct the `BrowserAPI` / CDP transport. The caller passes a
 *    ready-to-use `BrowserAPI` since the extension uses chrome.debugger
 *    via the service worker, while standalone uses a WebSocket.
 *  - Tray-runtime config sync (uses `window.localStorage`).
 *  - chrome.runtime listeners (extension-only).
 *  - Sprinkle `BroadcastChannel` host or `.shtml` watcher relay
 *    (extension-only; relays panel ⇄ offscreen).
 *  - Wiring `dispose` to a lifecycle hook (`beforeunload` in extension,
 *    worker close in standalone).
 *
 * The returned `KernelHost.dispose()` cleans up tray subscriptions and
 * the BshWatchdog. Callers wire it to whatever lifecycle hook fits
 * their float.
 */

import type {
  Orchestrator as OrchestratorType,
  OrchestratorCallbacks,
} from '../scoops/orchestrator.js';
import { Orchestrator } from '../scoops/orchestrator.js';
import type { BrowserAPI } from '../cdp/browser-api.js';
import type { VirtualFS } from '../fs/virtual-fs.js';
import type { LickEvent, LickManager } from '../scoops/lick-manager.js';
import type { ChannelMessage, RegisteredScoop } from '../scoops/types.js';
import type { KernelFacade } from './types.js';
import { publishAgentBridge } from '../scoops/agent-bridge.js';
import { ProcessManager } from './process-manager.js';
import { ProcMountBackend } from './proc-mount.js';
import { subscribeToLeaderTrayRuntimeStatus } from '../scoops/tray-leader.js';
import { subscribeToFollowerTrayRuntimeStatus } from '../scoops/tray-follower-status.js';
import { formatLickEventForCone } from '../scoops/lick-formatting.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface KernelHostLogger {
  info(msg: string, ...rest: unknown[]): void;
  warn(msg: string, ...rest: unknown[]): void;
  debug?(msg: string, ...rest: unknown[]): void;
  error?(msg: string, ...rest: unknown[]): void;
}

export interface KernelHostConfig {
  /**
   * DOM container the orchestrator constructs scoop tabs into. Must
   * remain valid for the host's lifetime. In offscreen this is
   * `document.body`; in standalone it'd be the layout's iframe
   * container.
   */
  container: HTMLElement;

  /**
   * `BrowserAPI` instance. The factory does NOT construct this — the
   * caller supplies the float-specific transport (extension wraps
   * `OffscreenCdpProxy`; standalone wraps a WebSocket-backed `CDPClient`;
   * future kernel-worker wraps a kernel-transport CDP proxy).
   */
  browser: BrowserAPI;

  /**
   * Bridge that converts orchestrator events into wire emissions.
   * `OffscreenBridge` satisfies `KernelFacade`. The factory calls
   * `bridge.bind(orchestrator, browser)` after the orchestrator is
   * constructed.
   */
  bridge: KernelFacade;

  /**
   * Orchestrator callbacks bag. Must omit `getBrowserAPI` — the factory
   * supplies that itself from the `browser` arg. Built by the bridge —
   * `OffscreenBridge.createCallbacks(bridge)` is the canonical builder.
   */
  callbacks: Omit<OrchestratorCallbacks, 'getBrowserAPI'>;

  /**
   * If true, skip auto-creating a cone scoop when none exist. Used by
   * the extension provider-less tray-join flow where a cone without an
   * API key would dead-end.
   */
  skipConeBootstrap?: boolean;

  /**
   * Override the lick-event handler. Default: route to the named
   * target scoop (or the cone, for untargeted events) using
   * `formatLickEventForCone`. Standalone overrides this with a wrapper
   * that handles welcome-flow onboarding licks before falling through
   * to the default routing.
   */
  lickEventHandler?: (event: LickEvent, ctx: LickRoutingContext) => void;

  /**
   * Logger. Defaults to `console`.
   */
  logger?: KernelHostLogger;
}

export interface LickRoutingContext {
  orchestrator: OrchestratorType;
  lickManager: LickManager;
  log: KernelHostLogger;
}

export interface KernelHost {
  orchestrator: OrchestratorType;
  browser: BrowserAPI;
  bridge: KernelFacade;
  lickManager: LickManager;
  sharedFs: VirtualFS | null;
  /**
   * Process manager. Tracks every long-running unit the kernel
   * performs — scoop turns, tool calls, shell execs, jsh scripts.
   * Surfaced by the `ps` / `kill` shell commands and the `/proc`
   * mount.
   */
  processManager: ProcessManager;
  /**
   * Stop the BshWatchdog and unsubscribe tray-runtime listeners. Idempotent.
   * Callers wire this to their float's lifecycle hook (`beforeunload` in
   * extension; worker-close in standalone).
   */
  dispose(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Default lick handler (mirrors offscreen.ts:186-260)
// ---------------------------------------------------------------------------

/**
 * Default lick event handler. Formats the event via
 * `formatLickEventForCone`, resolves a target scoop (named target or
 * cone), and hands the resulting `ChannelMessage` to
 * `orchestrator.handleMessage`. Drops events that
 * `formatLickEventForCone` returns `null` for.
 */
export function defaultLickEventHandler(
  event: LickEvent,
  { orchestrator, log }: LickRoutingContext
): void {
  const formatted = formatLickEventForCone(event);
  if (formatted === null) {
    log.debug?.('dropping lick event with no renderable content', { type: event.type });
    return;
  }

  const isWebhook = event.type === 'webhook';
  const isSprinkle = event.type === 'sprinkle';
  const isFsWatch = event.type === 'fswatch';
  const isNavigate = event.type === 'navigate';
  const isUpgrade = event.type === 'upgrade';
  const isSessionReload = event.type === 'session-reload';
  const eventName = isWebhook
    ? event.webhookName
    : isSprinkle
      ? event.sprinkleName
      : isFsWatch
        ? event.fswatchName
        : isNavigate
          ? event.navigateUrl
          : isUpgrade
            ? `${event.upgradeFromVersion ?? 'unknown'}→${event.upgradeToVersion ?? 'unknown'}`
            : isSessionReload
              ? 'mount-recovery'
              : event.cronName;
  const eventId = isWebhook
    ? event.webhookId
    : isSprinkle
      ? event.sprinkleName
      : isFsWatch
        ? event.fswatchId
        : isNavigate
          ? event.navigateUrl
          : isUpgrade
            ? `upgrade-${event.upgradeToVersion ?? 'unknown'}`
            : isSessionReload
              ? `session-reload-${event.timestamp}`
              : event.cronId;
  const channel = event.type;

  const scoops = orchestrator.getScoops();
  let resolvedTarget: RegisteredScoop | undefined;
  if (!event.targetScoop) {
    resolvedTarget = scoops.find((s) => s.isCone);
  } else {
    resolvedTarget = scoops.find(
      (s) =>
        s.name === event.targetScoop ||
        s.folder === event.targetScoop ||
        s.folder === `${event.targetScoop}-scoop`
    );
  }

  if (!resolvedTarget) {
    log.warn('Lick target scoop not found', event.targetScoop);
    return;
  }

  const msgId = `${channel}-${eventId}-${Date.now()}`;
  const channelMsg: ChannelMessage = {
    id: msgId,
    chatJid: resolvedTarget.jid,
    senderId: channel,
    senderName: `${channel}:${eventName}`,
    content: formatted.content,
    timestamp: event.timestamp,
    fromAssistant: false,
    channel,
  };
  orchestrator.handleMessage(channelMsg);
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export async function createKernelHost(config: KernelHostConfig): Promise<KernelHost> {
  const { container, browser, bridge, callbacks, skipConeBootstrap = false } = config;
  const log: KernelHostLogger = config.logger ?? console;

  // 1. Construct orchestrator + process manager. The manager is the
  // single source of truth for live processes — every scoop turn,
  // tool call, shell exec, jsh script registers here. Surfaced via
  // `KernelHost.processManager` so callers (kernel-worker boot
  // wiring it into `TerminalSessionHost`, the `ps` / `kill` shell
  // commands) share one table.
  const processManager = new ProcessManager();
  const orchestrator = new Orchestrator(container, {
    ...callbacks,
    getBrowserAPI: () => browser,
  });
  orchestrator.setProcessManager(processManager);
  // Fallback global for shell scripts / `.jsh` callers that can't
  // accept constructor injection. `ps` prefers the DI path when the
  // supplemental command is constructed via
  // `createSupplementalCommands`.
  (globalThis as Record<string, unknown>).__slicc_pm = processManager;

  // 2. Bind bridge — sets up the wire listener and persistence store.
  await bridge.bind(orchestrator, browser);

  // 3. Tray-runtime subscriptions so the panel sees status changes the
  //    moment they happen (otherwise the panel's avatar popover would
  //    be stuck at 'inactive' until the next snapshot push).
  const unsubLeader = subscribeToLeaderTrayRuntimeStatus(() => bridge.emitTrayRuntimeStatus());
  const unsubFollower = subscribeToFollowerTrayRuntimeStatus(() => bridge.emitTrayRuntimeStatus());

  // 4. Init orchestrator (loads persisted scoops, mounts the shared FS).
  await orchestrator.init();

  // 5. Publish agent bridge for the `agent` shell command.
  const sharedFs = orchestrator.getSharedFS();
  if (sharedFs) {
    publishAgentBridge(orchestrator, sharedFs, orchestrator.getSessionStore());
  } else {
    log.warn('AgentBridge not published — orchestrator.getSharedFS() returned null');
  }

  // 5b. Mount /proc on the shared FS. `mountInternal` keeps it out
  // of `listMounts()` (so scoops can't see it), out of `mount list`,
  // and unpersisted (every reload starts fresh). The backend reads
  // from the same `processManager` the kernel host uses, so
  // `cat /proc/<pid>/status` always reflects the live table.
  if (sharedFs) {
    try {
      await sharedFs.mountInternal('/proc', new ProcMountBackend(processManager));
    } catch (err) {
      log.warn('Failed to mount /proc', err);
    }
  }

  // 6. Register session-costs provider for the `cost` shell command.
  const { registerSessionCostsProvider } =
    await import('../shell/supplemental-commands/cost-command.js');
  registerSessionCostsProvider(() => orchestrator.getSessionCosts());

  // 7. LickManager init + lick→cone routing.
  const { getLickManager } = await import('../scoops/lick-manager.js');
  const lickManager = getLickManager();
  await lickManager.init();
  orchestrator.setLickManager(lickManager);

  const lickHandler = config.lickEventHandler ?? defaultLickEventHandler;
  const routingCtx: LickRoutingContext = { orchestrator, lickManager, log };
  lickManager.setEventHandler((event) => lickHandler(event, routingCtx));

  // 8. Expose lickManager on globalThis for the `crontask` / `webhook`
  //    shell commands. globalThis is identical in worker + page.
  (globalThis as Record<string, unknown>).__slicc_lickManager = lickManager;

  // 9. Restore persisted mounts. MUST run AFTER setEventHandler so the
  //    `session-reload` lick we may emit below routes through the
  //    handler installed above.
  if (sharedFs) {
    void (async () => {
      try {
        const { getAllMountEntries } = await import('../fs/mount-table-store.js');
        const { recoverMounts } = await import('../fs/mount-recovery.js');
        const entries = await getAllMountEntries();
        if (entries.length === 0) return;
        const { needsRecovery } = await recoverMounts(entries, sharedFs, log);
        if (needsRecovery.length === 0) return;
        lickManager.emitEvent({
          type: 'session-reload',
          targetScoop: undefined,
          timestamp: new Date().toISOString(),
          body: { reason: 'mount-recovery', mounts: needsRecovery },
        });
      } catch (err) {
        log.warn('mount recovery failed', err);
      }
    })();
  }

  // 10. Cone bootstrap.
  if (!skipConeBootstrap) {
    const allScoops = orchestrator.getScoops();
    const hasCone = allScoops.some((s) => s.isCone);
    if (!hasCone) {
      await orchestrator.registerScoop({
        jid: `cone_${Date.now()}`,
        name: 'Cone',
        folder: 'cone',
        isCone: true,
        type: 'cone',
        requiresTrigger: false,
        assistantLabel: 'sliccy',
        addedAt: new Date().toISOString(),
      });
    }
  }

  // 11. Upgrade detection. Must run after cone bootstrap so an upgrade
  //     lick has a routable target.
  if (sharedFs) {
    void (async () => {
      try {
        const { detectUpgrade, recordVersionSeen } = await import('../scoops/upgrade-detection.js');
        const result = await detectUpgrade();
        if (!result.isUpgrade || result.lastSeen === null) return;
        lickManager.emitEvent({
          type: 'upgrade',
          targetScoop: undefined,
          timestamp: new Date().toISOString(),
          upgradeFromVersion: result.lastSeen,
          upgradeToVersion: result.bundled.version,
          body: {
            from: result.lastSeen,
            to: result.bundled.version,
            releasedAt: result.bundled.releasedAt,
          },
        });
        await recordVersionSeen(result.bundled.version);
      } catch (err) {
        log.warn('Upgrade detection failed', err);
      }
    })();
  }

  // 12. BshWatchdog start.
  let bshWatchdogStop: (() => void) | null = null;
  let scriptCatalogDispose: (() => void) | null = null;
  if (sharedFs) {
    try {
      const { BshWatchdog } = await import('../shell/bsh-watchdog.js');
      const { ScriptCatalog } = await import('../shell/script-catalog.js');
      const sc = new ScriptCatalog({
        jshFs: sharedFs,
        bshFs: sharedFs,
        watcher: sharedFs.getWatcher(),
      });
      const wd = new BshWatchdog({
        browserAPI: browser,
        scriptCatalog: sc,
        fs: sharedFs,
      });
      void wd.start();
      bshWatchdogStop = () => wd.stop();
      scriptCatalogDispose = () => sc.dispose();
    } catch (err) {
      log.warn('Failed to start BSH watchdog', err);
    }
  }

  let disposed = false;
  return {
    orchestrator,
    browser,
    bridge,
    lickManager,
    sharedFs: sharedFs ?? null,
    processManager,
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      unsubLeader?.();
      unsubFollower?.();
      bshWatchdogStop?.();
      scriptCatalogDispose?.();
      // Tear down /proc. Best-effort: a missing entry (sharedFs
      // unavailable at boot, or mountInternal failed) throws ENOENT
      // we swallow.
      if (sharedFs) {
        try {
          await sharedFs.unmountInternal('/proc');
        } catch {
          /* not mounted */
        }
      }
      releaseHostGlobals({ processManager, lickManager });
    },
  };
}

/**
 * Clear the kernel-host globals (`__slicc_pm`, `__slicc_lickManager`)
 * iff they still point at the supplied references. A second host
 * that booted while we were running would have replaced them, and
 * tearing down our own ref would re-orphan that host's surface for
 * shell-script callers (`__slicc_pm` is the fallback for `ps` /
 * `kill` / `crontask` / `webhook`).
 *
 * Exported for tests; production callers go through `dispose()`.
 */
export function releaseHostGlobals(refs: {
  processManager: ProcessManager;
  lickManager: LickManager;
}): void {
  const g = globalThis as Record<string, unknown>;
  if (g.__slicc_pm === refs.processManager) delete g.__slicc_pm;
  if (g.__slicc_lickManager === refs.lickManager) delete g.__slicc_lickManager;
}
