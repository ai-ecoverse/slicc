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

import type { BrowserAPI } from '../cdp/browser-api.js';
import { NavigationWatcher } from '../cdp/navigation-watcher.js';
import type { VirtualFS } from '../fs/virtual-fs.js';
import { publishAgentBridge } from '../scoops/agent-bridge.js';
import { formatLickEventForCone } from '../scoops/lick-formatting.js';
import type { LickEvent, LickManager } from '../scoops/lick-manager.js';
import type {
  OrchestratorCallbacks,
  Orchestrator as OrchestratorType,
} from '../scoops/orchestrator.js';
import { Orchestrator } from '../scoops/orchestrator.js';
import { subscribeToFollowerTrayRuntimeStatus } from '../scoops/tray-follower-status.js';
import { subscribeToLeaderTrayRuntimeStatus } from '../scoops/tray-leader.js';
import type { ChannelMessage, RegisteredScoop } from '../scoops/types.js';
import {
  publishWorkflowRunManager,
  WORKFLOW_MANAGER_GLOBAL_KEY,
} from '../scoops/workflow-run-manager.js';
import { executeJsCode } from '../shell/jsh-executor.js';
import { makeSentinel, splitSentinel } from '../shell/supplemental-commands/workflow-script.js';
import { ProcMountBackend } from './proc-mount.js';
import { ProcessManager } from './process-manager.js';
import type { KernelFacade } from './types.js';

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
   * If true, the caller is the extension float. The kernel host then
   * skips two pieces of standalone-only plumbing:
   *
   * 1. The CDP-level `NavigationWatcher` — the extension observes
   *    main-frame `Link` headers via `chrome.webRequest` in the service
   *    worker and emits `navigate-lick` messages directly (see
   *    `offscreen.ts`); a CDP watcher in the offscreen kernel would
   *    double-fire.
   * 2. The `/licks-ws` bridge to the node-server (`startLickWsBridge`)
   *    — there is no node-server in extension mode. Webhooks land at
   *    the cloudflare tray worker and the panel webhook command uses
   *    the BroadcastChannel proxy in `lick-manager-proxy.ts` instead.
   *
   * Leaving this falsy in standalone / kernel-worker boots is what
   * makes both navigate-licks AND the lick-ws management wire work.
   */
  isExtension?: boolean;

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
 * Resolve the `eventName` used to label the routed `ChannelMessage`
 * (`senderName = "<channel>:<eventName>"`). Mirrors the original nested
 * ternary chain in `defaultLickEventHandler` exactly.
 */
function resolveLickEventName(event: LickEvent): string | undefined {
  switch (event.type) {
    case 'webhook':
      return event.webhookName;
    case 'sprinkle':
      return event.sprinkleName;
    case 'fswatch':
      return event.fswatchName;
    case 'navigate':
      return event.navigateUrl;
    case 'upgrade':
      return `${event.upgradeFromVersion ?? 'unknown'}→${event.upgradeToVersion ?? 'unknown'}`;
    case 'session-reload':
      return 'mount-recovery';
    case 'workflow':
      return event.workflowName ?? event.workflowRunId ?? 'workflow';
    default:
      return event.cronName;
  }
}

/**
 * Resolve the `eventId` baked into the `ChannelMessage` id
 * (`"<channel>-<eventId>-<Date.now()>"`). Mirrors the original nested
 * ternary chain in `defaultLickEventHandler` exactly.
 */
function resolveLickEventId(event: LickEvent): string | undefined {
  switch (event.type) {
    case 'webhook':
      return event.webhookId;
    case 'sprinkle':
      return event.sprinkleName;
    case 'fswatch':
      return event.fswatchId;
    case 'navigate':
      return event.navigateUrl;
    case 'upgrade':
      return `upgrade-${event.upgradeToVersion ?? 'unknown'}`;
    case 'session-reload':
      return `session-reload-${event.timestamp}`;
    case 'workflow':
      return `workflow-${event.workflowRunId ?? 'unknown'}`;
    default:
      return event.cronId;
  }
}

/**
 * Default lick event handler. Formats the event via
 * `formatLickEventForCone`, resolves a target scoop (named target or
 * cone), and hands the resulting `ChannelMessage` to
 * `orchestrator.handleMessage`. Drops events that
 * `formatLickEventForCone` returns `null` for.
 *
 * `'sudo-request'` is a special case (Path b in the lick design): the
 * orchestrator's `enqueueSudoRequest` already delivers the actionable
 * message to the cone via `deliverSudoRequestToCone`, AND that delivery
 * (channel `'sudo-request'` ∈ `EXTERNAL_LICK_CHANNELS`) auto-fires the
 * UI chip through `handleMessage`. Re-routing the lick emit through
 * `handleMessage` here would double-deliver to the agent. We skip it.
 */
export function defaultLickEventHandler(event: LickEvent, ctx: LickRoutingContext): void {
  if (event.type === 'sudo-request') {
    ctx.log.debug?.('sudo-request lick: UI-chip-only path; orchestrator owns delivery', {
      lickId: event.lickId,
    });
    return;
  }
  routeFormattedLickToCone(event, ctx);
}

function routeFormattedLickToCone(
  event: LickEvent,
  { orchestrator, log }: LickRoutingContext
): void {
  // Navigate (handoff / upskill) licks are actionable: mint + register a
  // stable lickId BEFORE formatting so the formatter can surface it and the
  // built ChannelMessage carries it onto the persisted message + UI chip.
  // Only runs on the leader/standalone (followers forward navigate licks
  // upstream instead of reaching this handler).
  if (event.type === 'navigate') {
    event.lickId = orchestrator.registerNavigateLick(event);
  }

  const formatted = formatLickEventForCone(event);
  if (formatted === null) {
    log.debug?.('dropping lick event with no renderable content', { type: event.type });
    return;
  }

  const eventName = resolveLickEventName(event);
  const eventId = resolveLickEventId(event);
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
    // Actionable navigate licks carry the minted id so the resolve path
    // (upskill lick_confirm / handoff human dip) can locate this stored
    // message and flip its rendered card.
    ...(event.lickId ? { lickId: event.lickId } : {}),
  };
  orchestrator.handleMessage(channelMsg);
}

// ---------------------------------------------------------------------------
// Boot-phase helpers (extracted from createKernelHost for size/complexity).
// Each takes the locals it needs and returns what the body threads onward;
// ordering of side effects is preserved by the call order in the factory.
// ---------------------------------------------------------------------------

/**
 * Steps 1–4b: construct the orchestrator + process manager, publish their
 * globals, bind the bridge, wire tray-runtime subscriptions, init the
 * orchestrator, and seed the bridge's chat buffers. Ordering of these side
 * effects is load-bearing and preserved verbatim from the original inline
 * sequence. Returns the locals the factory threads onward.
 */
async function bootOrchestrator(
  container: HTMLElement,
  browser: BrowserAPI,
  bridge: KernelFacade,
  callbacks: Omit<OrchestratorCallbacks, 'getBrowserAPI'>
): Promise<{
  processManager: ProcessManager;
  orchestrator: OrchestratorType;
  unsubLeader: () => void;
  unsubFollower: () => void;
  sharedFs: VirtualFS | null;
}> {
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
  // Expose the BrowserAPI so the OAuth intercept launcher
  // (`providers/intercepted-oauth.ts`) can reach the active CDP
  // transport without dragging in BrowserAPI as a constructor dep.
  (globalThis as Record<string, unknown>).__slicc_browser = browser;

  // 2. Bind bridge — sets up the wire listener and persistence store.
  await bridge.bind(orchestrator, browser);

  // 3. Tray-runtime subscriptions so the panel sees status changes the
  //    moment they happen (otherwise the panel's avatar popover would
  //    be stuck at 'inactive' until the next snapshot push).
  const unsubLeader = subscribeToLeaderTrayRuntimeStatus(() => bridge.emitTrayRuntimeStatus());
  const unsubFollower = subscribeToFollowerTrayRuntimeStatus(() => bridge.emitTrayRuntimeStatus());

  // 4. Init orchestrator (loads persisted scoops, mounts the shared FS).
  await orchestrator.init();

  // 4b. Seed the bridge's chat buffers from each scoop's restored
  // canonical conversation, BEFORE `kernel-worker-ready` is signaled and
  // therefore before the panel selects a scoop or a post-boot turn runs
  // `persistScoop`. Without this the buffers start empty and the first
  // turn after a reload overwrites the full history in the
  // `browser-coding-agent` UI store with only the new messages.
  await bridge.seedBuffersFromAgentState();

  // 5 (caller): publish agent bridge for the `agent` shell command.
  const sharedFs = orchestrator.getSharedFS();
  return { processManager, orchestrator, unsubLeader, unsubFollower, sharedFs };
}

/**
 * Steps 6 + 7: register the session-costs provider for the `cost` shell
 * command, then init the LickManager, attach it to the orchestrator, and
 * install the lick→cone routing handler (the caller's override, or
 * `defaultLickEventHandler`). Returns the initialized LickManager.
 */
async function initCostsAndLickManager(
  orchestrator: OrchestratorType,
  config: KernelHostConfig,
  log: KernelHostLogger
): Promise<LickManager> {
  // 6. Register session-costs provider for the `cost` shell command.
  const { registerSessionCostsProvider } = await import(
    '../shell/supplemental-commands/cost-command.js'
  );
  registerSessionCostsProvider(() => orchestrator.getSessionCosts());

  // 7. LickManager init + lick→cone routing.
  const { getLickManager } = await import('../scoops/lick-manager.js');
  const lickManager = getLickManager();
  await lickManager.init();
  orchestrator.setLickManager(lickManager);

  const lickHandler = config.lickEventHandler ?? defaultLickEventHandler;
  const routingCtx: LickRoutingContext = { orchestrator, lickManager, log };
  lickManager.setEventHandler((event) => lickHandler(event, routingCtx));
  return lickManager;
}

/**
 * Step 10: bootstrap a cone scoop if none exists. The caller gates on
 * `!skipConeBootstrap`.
 */
async function bootstrapCone(orchestrator: OrchestratorType): Promise<void> {
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

/**
 * Step 7b: publish the workflow run manager on `globalThis.__slicc_workflows`.
 * Sentinel ownership: the manager NEVER invents a sentinel — the command builds
 * it and threads it through `WorkflowStartOptions.sentinel`. For sentinel
 * handling, the deps supply only `makeRunId` (a short id derived from
 * `makeSentinel()`, the fallback when the command doesn't pass its own runId)
 * and `splitResult` (`splitSentinel`) — the sentinel itself is built by the
 * command and threaded via `WorkflowStartOptions.sentinel`. (The deps also wire
 * the float-specific `runRealm`/`sharedFs`/`processManager`/`fireLick`/
 * `getConeJid`.)
 */
function publishWorkflowRunManagerForHost(deps: {
  orchestrator: OrchestratorType;
  processManager: ProcessManager;
  lickManager: LickManager;
  sharedFs: VirtualFS;
}): void {
  const { orchestrator, processManager, lickManager, sharedFs } = deps;
  publishWorkflowRunManager({
    sharedFs,
    getConeJid: () => orchestrator.getScoops().find((s) => s.isCone)?.jid,
    fireLick: (event) => lickManager.emitEvent(event),
    processManager,
    // `CommandContextLike` is a structural subset of `executeJsCode`'s ctx
    // param, so this cast is safe — the real full ctx flows through at runtime.
    runRealm: (code, argv, ctx) =>
      executeJsCode(code, argv, ctx as unknown as Parameters<typeof executeJsCode>[2], undefined, {
        filename: argv[1],
      }),
    // Takes a 12-char id from the sentinel; collision risk is acceptable
    // because run ids are session-scoped and live only in the in-memory
    // registry Map.
    makeRunId: () => makeSentinel().slice('WF_RESULT_'.length, 'WF_RESULT_'.length + 12),
    splitResult: (stdout, sentinel) => splitSentinel(stdout, sentinel),
  });
}

/**
 * Step 8a-pre: construct the `browser.websocket` subscriber registry +
 * page-side CDP bridge. The registry owns the resolved sink dispatchers so
 * `browser.websocket` is end-to-end functional in both floats. Returns both
 * so the caller can publish the registry on globalThis and dispose both on
 * teardown.
 */
async function buildWsSubscriberRegistry(deps: {
  browser: BrowserAPI;
  lickManager: LickManager;
  orchestrator: OrchestratorType;
  sharedFs: VirtualFS | null | undefined;
  log: KernelHostLogger;
}): Promise<{ wsBridge: { dispose(): void }; wsRegistry: { dispose(): void } }> {
  const { browser, lickManager, orchestrator, sharedFs, log } = deps;
  const { CdpWsPageBridge } = await import('../cdp/cdp-ws-page-bridge.js');
  const { WsSubscriberRegistry } = await import('./realm/ws-subscribers.js');
  const wsBridge = new CdpWsPageBridge({ browser });
  const wsRegistry = new WsSubscriberRegistry({
    bridge: wsBridge,
    webhooks: { has: (id) => lickManager.getWebhook(id) !== undefined },
    dispatcher: {
      webhook: (id, payload) => {
        lickManager.handleWebhookEvent(id, {}, payload);
      },
      scoop: (jid, payload) => {
        const scoop = orchestrator.getScoops().find((s) => s.jid === jid);
        if (!scoop) {
          log.warn?.('browser.websocket: scoop sink not found', { jid });
          return;
        }
        const msg: ChannelMessage = {
          id: `ws-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          chatJid: jid,
          senderId: 'browser.websocket',
          senderName: 'browser.websocket',
          content: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2),
          timestamp: new Date().toISOString(),
          fromAssistant: false,
          channel: 'browser.websocket',
        };
        void orchestrator.handleMessage(msg);
      },
      vfs: async (path, payload) => {
        if (!sharedFs) return;
        const line = (typeof payload === 'string' ? payload : JSON.stringify(payload)) + '\n';
        let existing = '';
        try {
          const cur = await sharedFs.readFile(path);
          existing = typeof cur === 'string' ? cur : new TextDecoder().decode(cur);
        } catch {
          /* file does not exist yet */
        }
        await sharedFs.writeFile(path, existing + line);
      },
      log: (payload) => {
        log.info?.('browser.websocket frame', { payload });
      },
    },
  });
  return { wsBridge, wsRegistry };
}

/**
 * Step 8a: start the `/licks-ws` bridge to the node-server (non-extension
 * floats only — the caller gates on `!isExtension`). Returns the stop handle
 * or `null` on failure. Bridge failure is functionally identical to
 * webhook/crontask/handoff lick delivery being non-functional for the rest of
 * the session — so it's surfaced via `error` (falling back through `warn` and
 * a console fallback so we NEVER throw a TypeError inside the catch and lose
 * the original failure).
 */
async function startLickWsBridgeForHost(
  lickManager: LickManager,
  log: KernelHostLogger
): Promise<(() => void) | null> {
  try {
    const { startLickWsBridge } = await import('../scoops/lick-ws-bridge.js');
    const handle = startLickWsBridge(lickManager, {
      locationHref: self.location.href,
    });
    return handle.stop;
  } catch (err) {
    const errFn =
      log.error?.bind(log) ??
      log.warn.bind(log) ??
      ((msg: string, fields?: unknown) => console.error('[lick-ws-bridge]', msg, fields));
    errFn(
      'Failed to start lick-ws bridge — webhook / crontask / handoff lick delivery is non-functional in this session',
      { error: err instanceof Error ? err.message : String(err) }
    );
    return null;
  }
}

/**
 * Step 8b: start the CDP-level NavigationWatcher (standalone / kernel-worker
 * only — the caller gates on `!isExtension`). The extension float observes
 * main-frame `Link` headers via `chrome.webRequest`, so booting a CDP watcher
 * there would double-fire. Construction + `void start()` are synchronous (as
 * in the original inline block); returns the async stop handle or `null`.
 */
function startNavigationWatcherForHost(
  browser: BrowserAPI,
  lickManager: LickManager,
  log: KernelHostLogger
): (() => Promise<void>) | null {
  try {
    const navWatcher = new NavigationWatcher(browser.getTransport(), (event) => {
      const body: Record<string, unknown> = {
        url: event.url,
        verb: event.verb,
        target: event.target,
      };
      if (event.instruction != null) body.instruction = event.instruction;
      if (event.branch != null) body.branch = event.branch;
      if (event.path != null) body.path = event.path;
      if (event.title != null) body.title = event.title;
      lickManager.emitEvent({
        type: 'navigate',
        navigateUrl: event.url,
        targetScoop: undefined,
        timestamp: new Date().toISOString(),
        body,
      });
    });
    void navWatcher.start();
    return () => navWatcher.stop();
  } catch (err) {
    log.warn('Failed to start NavigationWatcher', err);
    return null;
  }
}

/**
 * Step 9: restore persisted mounts (fire-and-forget). MUST run AFTER
 * `setEventHandler` so the `session-reload` lick this may emit routes through
 * the installed handler. The caller gates on `sharedFs` being present.
 */
function scheduleMountRecovery(
  sharedFs: VirtualFS,
  lickManager: LickManager,
  log: KernelHostLogger
): void {
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

/**
 * Step 11: upgrade detection (fire-and-forget). MUST run after cone bootstrap
 * so an upgrade lick has a routable target. The caller gates on `sharedFs`.
 */
function scheduleUpgradeDetection(lickManager: LickManager, log: KernelHostLogger): void {
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

/**
 * Step 12: start the BshWatchdog + ScriptCatalog. The caller gates on
 * `sharedFs`. Returns the two teardown handles (or `null`s on failure) so the
 * factory can wire them into `dispose()`.
 */
async function startBshWatchdogForHost(
  sharedFs: VirtualFS,
  browser: BrowserAPI,
  log: KernelHostLogger
): Promise<{ bshWatchdogStop: (() => void) | null; scriptCatalogDispose: (() => void) | null }> {
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
    return { bshWatchdogStop: () => wd.stop(), scriptCatalogDispose: () => sc.dispose() };
  } catch (err) {
    log.warn('Failed to start BSH watchdog', err);
    return { bshWatchdogStop: null, scriptCatalogDispose: null };
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export async function createKernelHost(config: KernelHostConfig): Promise<KernelHost> {
  const {
    container,
    browser,
    bridge,
    callbacks,
    skipConeBootstrap = false,
    isExtension = false,
  } = config;
  const log: KernelHostLogger = config.logger ?? console;

  // Steps 1–4b: construct + init the orchestrator, bind the bridge, wire tray
  // subs, seed chat buffers. See `bootOrchestrator` for the per-step detail.
  const { processManager, orchestrator, unsubLeader, unsubFollower, sharedFs } =
    await bootOrchestrator(container, browser, bridge, callbacks);
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

  // (Step 5c, the legacy LightningFS-IDB → OPFS migration, was removed:
  // every active profile has long since migrated, and the boot-time copy
  // could resurrect stale legacy content — e.g. sprinkles deleted from
  // OPFS reappearing from the old IDB. The legacy database is never read
  // anymore; `slicc-fs-cleanup` deletes it on explicit request.)

  // 6. Register session-costs provider for the `cost` shell command;
  //    7. init the LickManager + wire lick→cone routing.
  const lickManager = await initCostsAndLickManager(orchestrator, config, log);

  // 7b. Publish the workflow run manager on `globalThis.__slicc_workflows`
  //     so the `workflow` shell command + the cone resolve it the same way
  //     they resolve `__slicc_agent`. Wired here (after `lickManager`) so
  //     `orchestrator`, `processManager`, `sharedFs`, and `lickManager` are
  //     all in scope.
  if (sharedFs) {
    publishWorkflowRunManagerForHost({ orchestrator, processManager, lickManager, sharedFs });
  }

  // 8. Expose lickManager on globalThis for the `crontask` / `webhook`
  //    shell commands. globalThis is identical in worker + page.
  (globalThis as Record<string, unknown>).__slicc_lickManager = lickManager;

  // 8a-pre. browser.websocket subscriber registry. The registry owns
  //    the resolved sink dispatchers + the page-side CDP bridge so
  //    `browser.websocket` is end-to-end functional in both floats
  //    (WebSocket CDP standalone, chrome.debugger extension). The
  //    realm-host resolves `globalThis.__slicc_wsSubscribers` at
  //    `wsObserve`/`wsUpdate`/etc. call time. `unregisterScoop`
  //    auto-cleans up subscribers via `dropForScoop`.
  const { wsBridge, wsRegistry } = await buildWsSubscriberRegistry({
    browser,
    lickManager,
    orchestrator,
    sharedFs,
    log,
  });
  (globalThis as Record<string, unknown>).__slicc_wsSubscribers = wsRegistry;

  // 8a. /licks-ws bridge to the node-server. The extension offscreen
  //     kernel-host has no node-server peer to connect to, so we gate
  //     on `isExtension`. See `scoops/lick-ws-bridge.ts` for the wire
  //     shape.
  let lickWsBridgeStop: (() => void) | null = null;
  if (!isExtension) {
    lickWsBridgeStop = await startLickWsBridgeForHost(lickManager, log);
  }

  // 8b. CDP-level NavigationWatcher (standalone / kernel-worker only).
  //     The extension float observes main-frame `Link` headers via
  //     `chrome.webRequest` in the service worker and forwards them as
  //     `navigate-lick` chrome.runtime messages directly into
  //     `lickManager.emitEvent` (see `offscreen.ts`); booting a CDP
  //     watcher there would double-fire. Standalone (CLI / Electron)
  //     and kernel-worker boots have no `chrome.webRequest`, so the
  //     watcher is what makes navigate-licks fire at all.
  let navigationWatcherStop: (() => Promise<void>) | null = null;
  if (!isExtension) {
    navigationWatcherStop = startNavigationWatcherForHost(browser, lickManager, log);
  }

  // 9. Restore persisted mounts. MUST run AFTER setEventHandler so the
  //    `session-reload` lick we may emit below routes through the
  //    handler installed above.
  if (sharedFs) {
    scheduleMountRecovery(sharedFs, lickManager, log);
  }

  // 10. Cone bootstrap.
  if (!skipConeBootstrap) {
    await bootstrapCone(orchestrator);
  }

  // 11. Upgrade detection. Must run after cone bootstrap so an upgrade
  //     lick has a routable target.
  if (sharedFs) {
    scheduleUpgradeDetection(lickManager, log);
  }

  // 12. BshWatchdog start.
  let bshWatchdogStop: (() => void) | null = null;
  let scriptCatalogDispose: (() => void) | null = null;
  if (sharedFs) {
    ({ bshWatchdogStop, scriptCatalogDispose } = await startBshWatchdogForHost(
      sharedFs,
      browser,
      log
    ));
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
      await disposeKernelHost({
        unsubLeader,
        unsubFollower,
        bshWatchdogStop,
        scriptCatalogDispose,
        lickWsBridgeStop,
        navigationWatcherStop,
        sharedFs,
        wsRegistry,
        wsBridge,
        processManager,
        lickManager,
        browser,
        log,
      });
    },
  };
}

/**
 * Run the kernel host's teardown. Extracted from `createKernelHost`'s
 * `dispose()` body — same order, same best-effort error handling. The caller
 * owns the idempotency guard (`disposed` flag); this does the work once.
 */
async function disposeKernelHost(h: {
  unsubLeader: (() => void) | null | undefined;
  unsubFollower: (() => void) | null | undefined;
  bshWatchdogStop: (() => void) | null;
  scriptCatalogDispose: (() => void) | null;
  lickWsBridgeStop: (() => void) | null;
  navigationWatcherStop: (() => Promise<void>) | null;
  sharedFs: VirtualFS | null | undefined;
  wsRegistry: { dispose(): void };
  wsBridge: { dispose(): void };
  processManager: ProcessManager;
  lickManager: LickManager;
  browser: BrowserAPI;
  log: KernelHostLogger;
}): Promise<void> {
  const { sharedFs, wsRegistry, wsBridge, processManager, lickManager, browser, log } = h;
  h.unsubLeader?.();
  h.unsubFollower?.();
  h.bshWatchdogStop?.();
  h.scriptCatalogDispose?.();
  h.lickWsBridgeStop?.();
  // Tear down the NavigationWatcher's CDP subscriptions so a
  // new-session reload doesn't leave a stray observer attached to
  // every page target.
  if (h.navigationWatcherStop) {
    try {
      await h.navigationWatcherStop();
    } catch (err) {
      log.warn('NavigationWatcher.stop() failed', err);
    }
  }
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
  // Tear down the browser.websocket subscriber registry. Drops
  // the page-side bridge's binding-called listener so we don't
  // keep delivering frames after the host is gone.
  try {
    wsRegistry.dispose();
  } catch (err) {
    log.warn('WsSubscriberRegistry.dispose() failed', err);
  }
  try {
    wsBridge.dispose();
  } catch (err) {
    log.warn('CdpWsPageBridge.dispose() failed', err);
  }
  releaseHostGlobals({ processManager, lickManager, browser, wsRegistry });
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
  browser?: BrowserAPI;
  wsRegistry?: unknown;
}): void {
  const g = globalThis as Record<string, unknown>;
  if (g.__slicc_pm === refs.processManager) delete g.__slicc_pm;
  if (g.__slicc_lickManager === refs.lickManager) delete g.__slicc_lickManager;
  if (refs.browser && g.__slicc_browser === refs.browser) delete g.__slicc_browser;
  if (refs.wsRegistry && g.__slicc_wsSubscribers === refs.wsRegistry) {
    delete g.__slicc_wsSubscribers;
  }
  // Release the workflow run manager so we don't leak a manager closed over a
  // disposed orchestrator / lickManager. Symmetric with the globals above; the
  // workflow manager has no shell-script fallback (unlike `__slicc_pm`), so an
  // unconditional clear is safe — a second host re-publishes its own on boot.
  delete g[WORKFLOW_MANAGER_GLOBAL_KEY];
}
