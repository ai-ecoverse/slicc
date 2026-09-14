import { matchLickTargetAlias } from '../base/lick-target-match.js';
import { setLastSeenVersionReader } from '../base/slicc-version.js';
import type { BrowserAPI } from '../cdp/browser-api.js';
import {
  createOwnTabMatcher,
  type DiscoveryEvent,
  NavigationWatcher,
} from '../cdp/navigation-watcher.js';
import { getDiscoveryEnabled } from '../core/discovery-preference.js';
import { isFeatureEnabled } from '../core/feature-flags.js';
import { resolveFloatTopology } from '../core/float-topology.js';
import { setMountCapabilityBroker } from '../fs/mount/capability-broker.js';
import type { VirtualFS } from '../fs/virtual-fs.js';
import type { ProbeFetch } from '../net/well-known-probe.js';
import { publishAgentBridge } from '../scoops/agent-bridge.js';
import { formatLickEventForCone } from '../scoops/lick-formatting.js';
import type { LickEvent, LickManager } from '../scoops/lick-manager.js';
import { scoopCanBrowse } from '../scoops/llms-txt-ignore.js';
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
import {
  createAccountStoreEnvSeeder,
  registerProviderEnvSeeder,
} from '../shell/provider-env-seed.js';
import { createProxiedFetch } from '../shell/proxied-fetch.js';
import { makeSentinel, splitSentinel } from '../shell/supplemental-commands/workflow-script.js';
import {
  type CapabilityAdapterId,
  type CapabilityBroker,
  createCapabilityBrokerForTopology,
  type PageGestureChannel,
} from '../work-unit/capability/index.js';
import { rootsOf } from '../work-unit/policy.js';
import { matchDiscoveryRouteCandidate } from './discovery-lick-routing.js';
import { ProcMountBackend } from './proc-mount.js';
import { ProcessManager } from './process-manager.js';
import { installSyncFsResponder } from './realm/sync-fs-responder.js';
import type { SyncFsNonce } from './realm/sync-fs-wire.js';
import type { WsSubscriberRegistry } from './realm/ws-subscribers.js';
import type { KernelFacade } from './types.js';

export interface KernelHostLogger {
  info(msg: string, ...rest: unknown[]): void;
  warn(msg: string, ...rest: unknown[]): void;
  debug?(msg: string, ...rest: unknown[]): void;
  error?(msg: string, ...rest: unknown[]): void;
}

export interface KernelHostConfig {
  container: HTMLElement;

  browser: BrowserAPI;

  bridge: KernelFacade;

  callbacks: Omit<OrchestratorCallbacks, 'getBrowserAPI'>;

  skipConeBootstrap?: boolean;

  lickEventHandler?: (event: LickEvent, ctx: LickRoutingContext) => void;

  logger?: KernelHostLogger;

  localLickWsUrl?: string | null;

  syncFsChannelNonce?: SyncFsNonce | null;

  appPageUrl?: string | null;

  capabilityBroker?: CapabilityBroker;

  pageGestures?: PageGestureChannel;

  onBootProgress?: (stage: string) => void;
}

export interface LickRoutingContext {
  orchestrator: OrchestratorType;
  lickManager: LickManager;
  log: KernelHostLogger;
}

interface KernelHostGlobals {
  __slicc_pm?: ProcessManager;
  __slicc_browser?: BrowserAPI;
  __slicc_lickManager?: LickManager;
  __slicc_wsSubscribers?: WsSubscriberRegistry;
  [WORKFLOW_MANAGER_GLOBAL_KEY]?: unknown;
}

function kernelHostGlobals(): typeof globalThis & KernelHostGlobals {
  return globalThis as typeof globalThis & KernelHostGlobals;
}

interface NavigateLickBody {
  url: string;
  verb: string;
  target: string;
  instruction?: string;
  branch?: string;
  path?: string;
  title?: string;
}

export interface KernelHost {
  orchestrator: OrchestratorType;
  browser: BrowserAPI;
  bridge: KernelFacade;
  lickManager: LickManager;
  sharedFs: VirtualFS | null;

  processManager: ProcessManager;

  capabilityBroker: CapabilityBroker;

  dispose(): Promise<void>;
}

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
    case 'bash':
      return event.bashJobId ?? 'bash';
    case 'preview':
      return event.previewOrigin ?? 'preview';
    case 'discovery':
      return event.discoveryUrl ?? event.discoveryOrigin;
    default:
      return event.cronName;
  }
}

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
    case 'bash':
      return `bash-${event.bashJobId ?? 'unknown'}`;
    case 'preview':
      return event.previewConnId ?? `preview-${event.timestamp}`;
    case 'discovery':
      return event.discoveryUrl ?? `discovery-${event.timestamp}`;
    default:
      return event.cronId;
  }
}

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
  const scoops = orchestrator.getScoops();
  const roots = rootsOf(scoops);

  const contextualDiscoveryTarget =
    event.type === 'discovery' && !event.targetScoop
      ? matchDiscoveryRouteCandidate(
          event,
          roots.filter(scoopCanBrowse),
          (root) => orchestrator.getScoopContext?.(root.jid)?.getAgentMessages() ?? []
        )
      : undefined;
  const resolvedTarget: RegisteredScoop | undefined = event.targetScoop
    ? matchLickTargetAlias(scoops, event.targetScoop)
    : (contextualDiscoveryTarget ?? roots[0]);

  if (!resolvedTarget) {
    log.warn('Lick target scoop not found', event.targetScoop);
    return;
  }

  if (event.type === 'discovery' && !scoopCanBrowse(resolvedTarget)) {
    log.debug?.('dropping discovery lick for non-browsing scoop', {
      scoop: resolvedTarget.folder,
    });
    return;
  }

  if (event.type === 'navigate') {
    event.lickId = orchestrator.registerNavigateLick(event);
  } else if (event.type === 'session-reload') {
    event.lickId = orchestrator.registerSessionReloadLick(event);
  } else if (event.type === 'upgrade') {
    event.lickId = orchestrator.registerUpgradeLick(event);
  } else if (event.type === 'discovery') {
    event.lickId = orchestrator.registerDiscoveryLick(event) ?? undefined;
  }

  const formatted = formatLickEventForCone(event);
  if (formatted === null) {
    log.debug?.('dropping lick event with no renderable content', { type: event.type });
    return;
  }

  const eventName = resolveLickEventName(event);
  const eventId = resolveLickEventId(event);
  const channel = event.type;

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

    ...(event.lickId ? { lickId: event.lickId } : {}),
  };

  void orchestrator.handleMessage(channelMsg).catch((err: unknown) => {
    log.warn('Lick message routing failed', { channel, eventName, error: String(err) });
  });
}

async function bootOrchestrator(
  container: HTMLElement,
  browser: BrowserAPI,
  bridge: KernelFacade,
  callbacks: Omit<OrchestratorCallbacks, 'getBrowserAPI'>,
  config: KernelHostConfig
): Promise<{
  processManager: ProcessManager;
  orchestrator: OrchestratorType;
  unsubLeader: () => void;
  unsubFollower: () => void;
  sharedFs: VirtualFS | null;
  capabilityBroker: CapabilityBroker;
}> {
  const processManager = new ProcessManager();
  const orchestrator = new Orchestrator(container, {
    ...callbacks,
    getBrowserAPI: () => browser,
  });
  orchestrator.setProcessManager(processManager);

  const topology: CapabilityAdapterId = resolveFloatTopology();
  const capabilityBroker =
    config.capabilityBroker ??
    createCapabilityBrokerForTopology(topology, {
      ...(config.pageGestures ? { pageGestures: config.pageGestures } : {}),
    });
  orchestrator.setCapabilityBroker(capabilityBroker);

  setMountCapabilityBroker(capabilityBroker);

  kernelHostGlobals().__slicc_pm = processManager;

  registerProviderEnvSeeder(createAccountStoreEnvSeeder());

  kernelHostGlobals().__slicc_browser = browser;

  await bridge.bind(orchestrator, browser);

  const unsubLeader = subscribeToLeaderTrayRuntimeStatus(() => bridge.emitTrayRuntimeStatus());
  const unsubFollower = subscribeToFollowerTrayRuntimeStatus(() => bridge.emitTrayRuntimeStatus());

  await orchestrator.init(config.onBootProgress);

  await bridge.seedBuffersFromAgentState();

  const sharedFs = orchestrator.getSharedFS();
  return { processManager, orchestrator, unsubLeader, unsubFollower, sharedFs, capabilityBroker };
}

async function initCostsAndLickManager(
  orchestrator: OrchestratorType,
  config: KernelHostConfig,
  log: KernelHostLogger
): Promise<LickManager> {
  const { registerSessionBudgetProvider, registerSessionCostsProvider } = await import(
    '../shell/supplemental-commands/cost-command.js'
  );
  registerSessionCostsProvider((scope) => orchestrator.getSessionCostsForCommand(scope));
  const { refreshBudgetWindow } = await import('../providers/budget-usage-source.js');
  registerSessionBudgetProvider(() => refreshBudgetWindow());

  const { getLickManager } = await import('../scoops/lick-manager.js');
  const lickManager = getLickManager();
  await lickManager.init();
  orchestrator.setLickManager(lickManager);

  const lickHandler = config.lickEventHandler ?? defaultLickEventHandler;
  const routingCtx: LickRoutingContext = { orchestrator, lickManager, log };
  lickManager.setEventHandler((event) => lickHandler(event, routingCtx));
  return lickManager;
}

async function bootstrapCone(orchestrator: OrchestratorType): Promise<void> {
  const allScoops = orchestrator.getScoops();
  const hasRoot = rootsOf(allScoops).length > 0;
  if (!hasRoot) {
    await orchestrator.registerScoop({
      jid: `cone_${Date.now()}`,
      name: 'Cone',
      folder: 'cone',
      parentJid: null,
      requiresTrigger: false,
      assistantLabel: 'sliccy',
      addedAt: new Date().toISOString(),
    });
  }
}

function publishWorkflowRunManagerForHost(deps: {
  orchestrator: OrchestratorType;
  processManager: ProcessManager;
  lickManager: LickManager;
  sharedFs: VirtualFS;
}): void {
  const { orchestrator, processManager, lickManager, sharedFs } = deps;
  publishWorkflowRunManager({
    sharedFs,
    getStartingRoot: (parentJid) => {
      const roots = rootsOf(orchestrator.getScoops());
      const root = roots.find((r) => r.jid === parentJid);
      if (!root) return null;
      return { jid: root.jid, lickTarget: root.jid === roots[0]?.jid ? undefined : root.folder };
    },
    fireLick: (event) => lickManager.emitEvent(event),
    processManager,

    runRealm: (code, argv, ctx) =>
      executeJsCode(code, argv, ctx as unknown as Parameters<typeof executeJsCode>[2], undefined, {
        filename: argv[1],
      }),

    makeRunId: () => makeSentinel().slice('WF_RESULT_'.length, 'WF_RESULT_'.length + 12),
    splitResult: (stdout, sentinel) => splitSentinel(stdout, sentinel),
  });
}

async function buildWsSubscriberRegistry(deps: {
  browser: BrowserAPI;
  lickManager: LickManager;
  orchestrator: OrchestratorType;
  sharedFs: VirtualFS | null | undefined;
  log: KernelHostLogger;
}): Promise<{ wsBridge: { dispose(): void }; wsRegistry: WsSubscriberRegistry }> {
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
        } catch {}
        await sharedFs.writeFile(path, existing + line);
      },
      log: (payload) => {
        log.info?.('browser.websocket frame', { payload });
      },
    },
  });
  return { wsBridge, wsRegistry };
}

async function startLickWsBridgeForHost(
  lickManager: LickManager,
  log: KernelHostLogger,
  localLickWsUrl: string | null | undefined,
  sharedFs: VirtualFS | null
): Promise<(() => void) | null> {
  try {
    const { startLickWsBridge } = await import('../scoops/lick-ws-bridge.js');
    const { HostFsMountBackend } = await import('../fs/mount/backend-hostfs.js');
    const handle = startLickWsBridge(lickManager, {
      locationHref: self.location.href,
      lickWsUrl: localLickWsUrl ?? null,
      onHostfsInvalidate: (event) => {
        if (!sharedFs) return;
        const backend = sharedFs.getMountBackend(event.mount);
        if (!(backend instanceof HostFsMountBackend)) {
          log.debug?.('hostfs_invalidate for unknown/non-hostfs mount', {
            mount: event.mount,
          });
          return;
        }
        void backend.applyHostInvalidation(event.paths).catch((err) => {
          log.warn('hostfs_invalidate apply failed', {
            mount: event.mount,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      },
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

function startNavigationWatcherForHost(
  browser: BrowserAPI,
  lickManager: LickManager,
  log: KernelHostLogger,
  appPageUrl: string | null | undefined
): (() => Promise<void>) | null {
  const transport = browser.getTransport();
  if (transport.isExtensionBridge) {
    log.debug?.(
      'Skipping NavigationWatcher: extension-bridge transport rejects sessionless ' +
        'Target.* discovery; the service worker observes handoffs via chrome.webRequest'
    );
    return null;
  }
  try {
    const navWatcher = new NavigationWatcher(
      transport,
      (event) => {
        const body: NavigateLickBody = {
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
      },
      {
        ...buildDiscoveryWatcherOptions(lickManager),

        isOwnTab: createOwnTabMatcher(() => appPageUrl ?? null),
      }
    );
    void navWatcher.start();
    return () => navWatcher.stop();
  } catch (err) {
    log.warn('Failed to start NavigationWatcher', err);
    return null;
  }
}

function buildDiscoveryWatcherOptions(lickManager: LickManager): {
  onDiscovery: (event: DiscoveryEvent) => void;
  probeFetch: ProbeFetch;
  isDiscoveryEnabled: () => boolean;
} {
  const proxiedFetch = createProxiedFetch();

  const probeFetch: ProbeFetch = async (url, init) => {
    const doFetch = proxiedFetch(url, { method: init?.method ?? 'GET' });
    const signal = init?.signal;
    const res = signal
      ? await Promise.race([
          doFetch,
          new Promise<never>((_resolve, reject) => {
            if (signal.aborted) {
              reject(new Error('aborted'));
              return;
            }
            signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          }),
        ])
      : await doFetch;
    const headers = res.headers as Record<string, string> | undefined;
    return {
      ok: res.status >= 200 && res.status < 300,
      status: res.status,
      headers: {
        get(name: string): string | null {
          if (!headers) return null;

          return headers[name.toLowerCase()] ?? headers[name] ?? null;
        },
      },
    };
  };

  return {
    onDiscovery: (event: DiscoveryEvent) => {
      lickManager.emitEvent({
        type: 'discovery',
        targetScoop: undefined,
        timestamp: new Date().toISOString(),
        discoveryOrigin: event.origin,
        discoveryKind: event.kind,
        discoveryUrl: event.url,
        discoverySource: 'live-navigation',
        body: {
          origin: event.origin,
          kind: event.kind,
          url: event.url,
          targetId: event.targetId,
        },
      });
    },
    probeFetch,

    isDiscoveryEnabled: () => getDiscoveryEnabled(),
  };
}

function scheduleMountRecovery(
  sharedFs: VirtualFS,
  lickManager: LickManager,
  log: KernelHostLogger
): void {
  void (async () => {
    try {
      const { getAllMountEntries, removeMountEntry } = await import('../fs/mount-table-store.js');
      const { recoverMounts } = await import('../fs/mount-recovery.js');

      const { hostShadowedEntries, mountConfiguredHostMounts, withoutHostMountedTargets } =
        await import('../fs/auto-mount-table.js');
      const hostMounted = await mountConfiguredHostMounts(sharedFs, log);

      const allEntries = await getAllMountEntries();
      const entries = withoutHostMountedTargets(allEntries, hostMounted);

      for (const stale of hostShadowedEntries(allEntries, hostMounted)) {
        void removeMountEntry(stale.targetPath).catch((err) => {
          log.warn('failed to purge host-owned mount row', {
            path: stale.targetPath,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
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

export function publishLastSeenVersionReader(): void {
  setLastSeenVersionReader(async () => {
    const { getLastSeenVersion } = await import('../scoops/upgrade-detection.js');
    return getLastSeenVersion();
  });
}

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

export function shouldStartLickWsBridge(adapter: CapabilityAdapterId): boolean {
  return adapter === 'node-rest';
}

function publishGelatiere(
  orchestrator: OrchestratorType,
  lickManager: LickManager,
  sharedFs: VirtualFS | null,
  log: KernelHostLogger
): void {
  void import('../scoops/gelatiere-unit.js')
    .then(async (unit) => {
      const seam = unit.createGelatiereSeam(orchestrator, lickManager);
      unit.publishGelatiereSeam(seam);
      if (!sharedFs || !isFeatureEnabled('memory-v2')) {
        await unit.haltGelatiere(seam);
        return;
      }
      const { loadGelatiereConfig } = await import('../base/gelatiere-store.js');
      const config = await loadGelatiereConfig(sharedFs);
      await unit.bootGelatiere(seam, config.nightly);
    })
    .catch((err) => log.warn('gelatiere seam failed to publish', err));
}

function publishMemoryCuration(sharedFs: VirtualFS | null, log: KernelHostLogger): () => void {
  if (!sharedFs) return () => {};
  void import('../scoops/memory-curation-seam.js')
    .then((seam) => seam.publishMemorySeam(seam.createMemorySeam(sharedFs)))
    .catch((err) => log.warn('memory seam failed to publish', err));
  let cancelled = false;
  let cancel: (() => void) | null = null;
  if (isFeatureEnabled('memory-v2')) {
    void import('../scoops/memory-health.js')
      .then((health) => {
        if (cancelled) return;
        cancel = health.scheduleMemoryHealthChecks(sharedFs, { log });
      })
      .catch((err) => log.warn('memory health check failed to schedule', err));
  }
  return () => {
    cancelled = true;
    cancel?.();
  };
}

function publishAgentSeams(
  orchestrator: Parameters<typeof publishAgentBridge>[0],
  sharedFs: Parameters<typeof publishAgentBridge>[1] | null,
  log: KernelHostLogger
): void {
  if (!sharedFs) {
    log.warn('AgentBridge not published — orchestrator.getSharedFS() returned null');
    return;
  }
  publishAgentBridge(orchestrator, sharedFs, orchestrator.getSessionStore());
}

export async function createKernelHost(config: KernelHostConfig): Promise<KernelHost> {
  const { container, browser, bridge, callbacks, skipConeBootstrap = false } = config;
  const log: KernelHostLogger = config.logger ?? console;
  const progress = (stage: string): void => config.onBootProgress?.(stage);

  publishLastSeenVersionReader();

  const { processManager, orchestrator, unsubLeader, unsubFollower, sharedFs, capabilityBroker } =
    await bootOrchestrator(container, browser, bridge, callbacks, config);
  progress('orchestrator-ready');
  publishAgentSeams(orchestrator, sharedFs, log);

  if (sharedFs) {
    try {
      await sharedFs.mountInternal('/proc', new ProcMountBackend(processManager));
    } catch (err) {
      log.warn('Failed to mount /proc', err);
    }
  }

  const lickManager = await initCostsAndLickManager(orchestrator, config, log);
  progress('lick-manager-ready');

  if (sharedFs) {
    publishWorkflowRunManagerForHost({ orchestrator, processManager, lickManager, sharedFs });
  }

  kernelHostGlobals().__slicc_lickManager = lickManager;
  publishGelatiere(orchestrator, lickManager, sharedFs, log);
  const memoryHealthStop = publishMemoryCuration(sharedFs, log);

  const { wsBridge, wsRegistry } = await buildWsSubscriberRegistry({
    browser,
    lickManager,
    orchestrator,
    sharedFs,
    log,
  });
  kernelHostGlobals().__slicc_wsSubscribers = wsRegistry;

  const lickWsBridgeStop: (() => void) | null = shouldStartLickWsBridge(capabilityBroker.adapter)
    ? await startLickWsBridgeForHost(lickManager, log, config.localLickWsUrl ?? null, sharedFs)
    : null;

  const navigationWatcherStop: (() => Promise<void>) | null = startNavigationWatcherForHost(
    browser,
    lickManager,
    log,
    config.appPageUrl
  );

  if (sharedFs) {
    scheduleMountRecovery(sharedFs, lickManager, log);
  }

  if (!skipConeBootstrap) {
    await bootstrapCone(orchestrator);
  }
  progress('cone-bootstrapped');

  if (sharedFs) {
    scheduleUpgradeDetection(lickManager, log);
  }

  let bshWatchdogStop: (() => void) | null = null;
  let scriptCatalogDispose: (() => void) | null = null;
  if (sharedFs) {
    ({ bshWatchdogStop, scriptCatalogDispose } = await startBshWatchdogForHost(
      sharedFs,
      browser,
      log
    ));
  }

  let syncFsResponderDispose: (() => void) | null = null;
  if (sharedFs && config.syncFsChannelNonce) {
    syncFsResponderDispose = installSyncFsResponder({ nonce: config.syncFsChannelNonce }).dispose;
  }

  let disposed = false;
  return {
    orchestrator,
    browser,
    bridge,
    lickManager,
    sharedFs: sharedFs ?? null,
    processManager,
    capabilityBroker,
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      await disposeKernelHost({
        unsubLeader,
        unsubFollower,
        bshWatchdogStop,
        memoryHealthStop,
        scriptCatalogDispose,
        lickWsBridgeStop,
        navigationWatcherStop,
        syncFsResponderDispose,
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

async function disposeKernelHost(h: {
  unsubLeader: (() => void) | null | undefined;
  unsubFollower: (() => void) | null | undefined;
  bshWatchdogStop: (() => void) | null;
  memoryHealthStop: (() => void) | null;
  scriptCatalogDispose: (() => void) | null;
  lickWsBridgeStop: (() => void) | null;
  navigationWatcherStop: (() => Promise<void>) | null;
  syncFsResponderDispose: (() => void) | null;
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
  h.memoryHealthStop?.();
  h.scriptCatalogDispose?.();
  h.lickWsBridgeStop?.();
  h.syncFsResponderDispose?.();

  if (h.navigationWatcherStop) {
    try {
      await h.navigationWatcherStop();
    } catch (err) {
      log.warn('NavigationWatcher.stop() failed', err);
    }
  }

  if (sharedFs) {
    try {
      await sharedFs.unmountInternal('/proc');
    } catch {}
  }

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

export function releaseHostGlobals(refs: {
  processManager: ProcessManager;
  lickManager: LickManager;
  browser?: BrowserAPI;
  wsRegistry?: unknown;
}): void {
  const g = kernelHostGlobals();
  if (g.__slicc_pm === refs.processManager) {
    delete g.__slicc_pm;
    registerProviderEnvSeeder(null);
  }
  if (g.__slicc_lickManager === refs.lickManager) delete g.__slicc_lickManager;
  if (refs.browser && g.__slicc_browser === refs.browser) delete g.__slicc_browser;
  if (refs.wsRegistry && g.__slicc_wsSubscribers === refs.wsRegistry) {
    delete g.__slicc_wsSubscribers;
  }

  delete g[WORKFLOW_MANAGER_GLOBAL_KEY];
}
