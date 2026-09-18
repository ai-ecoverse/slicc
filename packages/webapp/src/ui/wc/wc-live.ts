import type { BrowserAPI, CDPTransport } from '../../cdp/index.js';
import { isFeatureEnabled } from '../../core/feature-flags.js';
import { installPageStorageSync } from '../../kernel/page-storage-sync.js';
import type { RemoteTerminalView } from '../../kernel/remote-terminal-view.js';
import { type SpawnedKernelHost, spawnKernelWorker } from '../../kernel/spawn.js';
import { formatBudgetResets } from '../../providers/provider-budget.js';
import type { RegisteredScoop } from '../../scoops/types.js';
import { registerTranscriptExportService } from '../../transcript/export-provider.js';
import { DefaultTranscriptExportService } from '../../transcript/export-service.js';
import { readSnapshot, writeSnapshot } from '../../transcript/snapshot-store.js';
import { getStrictKnownSecretRedactor } from '../../transcript/strict-secret-client.js';
import type { Unsubscribe, WorkUnitClient, WorkUnitSummary } from '../../work-unit/client/types.js';
import { CanonicalSessionReader } from '../../work-unit/conversation/sessions.js';
import { WorkUnitConversationStore } from '../../work-unit/conversation/store.js';
import { ownerWorkspaceFor } from '../../work-unit/descriptor.js';
import { isRootUnit } from '../../work-unit/policy.js';
import type { WorkUnitWorkspace } from '../../work-unit/types.js';
import {
  guardedReload,
  installWorkerStaleAssetReloadListener,
} from '../boot/setup-preload-error-reload.js';
import { setupStandalonePrelude } from '../boot/setup-standalone-prelude.js';
import type { BootStageLogger } from '../boot/types.js';
import { OffscreenClient } from '../offscreen-client.js';
import type { UiRuntimeMode } from '../runtime-mode.js';
import type { ChatMessage } from '../types.js';
import type { WcChatAttachment } from './wc-chat.js';
import type { WcChatController } from './wc-chat-controller.js';
import {
  createLeaderChatHost,
  DETACHED_CHAT_HOST,
  type LeaderChatHost,
  type WcChatHost,
} from './wc-chat-host.js';
import { wireConeActions } from './wc-cone-actions.js';
import { makeGelatiereCardFallback } from './wc-gelatiere-fallback.js';
import {
  createWcLiveCallbacks,
  ensureWorkUnitClient,
  type LickBackpressureState,
  type WcLiveWiring,
} from './wc-live-callbacks.js';
import { wireWcComposer } from './wc-live-composer.js';
import type { WelcomeInterceptHolder } from './wc-live-controller.js';
import { wireFreezerRail } from './wc-live-freezer.js';
import { createWcMonitorDeps } from './wc-live-monitor-deps.js';
import { setupSyncFsBootNonce } from './wc-live-sync-fs.js';
import { applyThreadContext } from './wc-live-thinking-hydration.js';
import { mountWcShell } from './wc-mount.js';
import { buildWcShellFrame, type WcShellRefs } from './wc-shell.js';
import {
  defaultRootOf,
  isReadOnlyRole,
  rootForSelection,
  switcherLabelFor,
  unitForContext,
  unitRoleFor,
  unitSlugFor,
} from './wc-unit-context.js';
import { createWorkbenchActivator, type WorkbenchActivator } from './wc-workbench.js';
import { wireFileMentions } from './wire-file-mentions.js';

export {
  createWcLiveCallbacks,
  type LickBackpressureState,
  type ScoopStatus,
  toSwitcherScoops,
  type WcLiveWiring,
} from './wc-live-callbacks.js';
export type { WelcomeInterceptHolder } from './wc-live-controller.js';
export { parseProcStatLine } from './wc-live-monitor-deps.js';
export {
  applyLeaderLocalThinkingChange,
  effortOverrideForAgent,
  metaThinkingForScoop,
  shouldSkipSessionHydration,
  thinkingLevelForAgent,
} from './wc-live-thinking-hydration.js';
export { scoopColor } from './wc-scoop-color.js';

export interface WcPageVfs {
  reader: import('../../kernel/local-vfs-client.js').LocalVfsClient;
  writer: import('../../kernel/writable-vfs-client.js').WritableVfsClient;
}

export interface WcShellBoot {
  refs: WcShellRefs;
  wiring: WcLiveWiring;
  setClient(client: OffscreenClient): void;

  setChatTransport(client: WorkUnitClient, host: WcChatHost): void;
  getChatHost(): WcChatHost;
  selectScoop(unit: WorkUnitSummary): void;
  getSelected(): WorkUnitSummary | null;
  clearSelection(): void;

  holdQueuedPile(): void;

  watchUnit(id: string): void;
  getController(): WcChatController | null;
  setController(controller: WcChatController): void;

  setActivateSurface(activator: WorkbenchActivator): void;

  onClientReady(fn: () => void): void;
}

function holdQueuedPile(args: {
  controller: WcChatController | null;
  held: Map<string, ChatMessage[]>;
  jid: string;
  roster: readonly WorkUnitSummary[];
}): void {
  const { controller, held, jid, roster } = args;
  const items = controller?.stashQueued() ?? [];
  if (items.length === 0) return;
  const unit = roster.find((u) => u.id === jid);
  const key = unit ? (rootForSelection(roster, unit)?.id ?? unit.id) : jid;
  held.set(key, [...(held.get(key) ?? []), ...items]);
}

function reconcileQueueForSwitch(args: {
  controller: WcChatController | null;
  destination: string;
  held: Map<string, ChatMessage[]>;
  previousJid: string | null;
  roster: readonly WorkUnitSummary[];
}): void {
  const { controller, destination, held, previousJid, roster } = args;

  if (previousJid && previousJid !== destination) {
    holdQueuedPile({ controller, held, jid: previousJid, roster });
  }

  if (roster.some((u) => u.id === destination)) {
    for (const key of [...held.keys()]) {
      if (!roster.some((u) => u.id === key)) held.delete(key);
    }
  }

  const returning = held.get(destination);
  if (returning) {
    held.delete(destination);
    controller?.restoreQueued(returning);
  }
}

function createUnitWatcher(
  getClient: () => WorkUnitClient,
  load: (messages: readonly ChatMessage[], queuedIds?: readonly string[]) => void
): { watch(jid: string): void; shownUnitId(): string | null } {
  let watch: Unsubscribe | null = null;

  let shown: string | null = null;
  return {
    shownUnitId: () => shown,
    watch: (jid) => {
      if (shown === jid && watch) return;
      watch?.();
      shown = jid;

      watch = getClient().subscribe(jid, (event) => {
        if (event.type !== 'snapshot') return;
        if (shown !== jid) return;
        load(event.snapshot.messages as unknown as ChatMessage[], event.snapshot.queuedIds);
      });
    },
  };
}

export function workspaceForSelection(deps: {
  client: Pick<OffscreenClient, 'getScoop' | 'getScoops'>;
  clearSelection(): void;
  selectedId: string | undefined;
}): WorkUnitWorkspace {
  const { client, selectedId } = deps;
  const record = selectedId === undefined ? undefined : client.getScoop(selectedId);
  if (selectedId !== undefined && !record) deps.clearSelection();
  return ownerWorkspaceFor(client.getScoops(), record);
}

function createSelection(deps: {
  refs: WcShellRefs;
  client(): WorkUnitClient;
  host(): WcChatHost;
  controller(): WcChatController | null;
  workbench(): WorkbenchActivator | null;
  wiring(): WcLiveWiring;
  lickBackpressure: Map<string, LickBackpressureState>;
  watchUnit(id: string): void;
}): {
  selectScoop(unit: WorkUnitSummary): void;
  getSelected(): WorkUnitSummary | null;
  clear(): void;
  holdQueue(): void;
} {
  const { refs } = deps;
  let selected: WorkUnitSummary | null = null;

  const heldQueues = new Map<string, ChatMessage[]>();

  const selectScoop = (unit: WorkUnitSummary): void => {
    const previousJid = selected?.id ?? null;
    selected = unit;
    const readOnly = isReadOnlyRole(unitRoleFor(unit));
    const host = deps.host();
    reconcileQueueForSwitch({
      controller: deps.controller(),
      destination: unit.id,
      held: heldQueues,
      previousJid,
      roster: deps.client().currentUnits(),
    });
    const cachedBackpressure = deps.lickBackpressure.get(unit.id);
    deps
      .controller()
      ?.setLickBackpressure(
        cachedBackpressure?.count ?? 0,
        cachedBackpressure?.waitingMs ?? 0,
        unitSlugFor(unit)
      );

    deps.controller()?.setReadOnly(readOnly);
    if (!readOnly) refs.inputCard.removeAttribute('disabled');

    void applyThreadContext(refs, unit, deps.client().currentUnits(), host.getRecord?.bind(host), {
      skipModelPill: host.ownsModelPill === true,
    });

    void deps
      .client()
      .snapshot(unit.id)
      .catch(() => undefined);
    deps.watchUnit(unit.id);

    deps.controller()?.setProcessing(
      deps
        .client()
        .currentUnits()
        .find((candidate) => candidate.id === unit.id)?.state === 'working'
    );

    if (!refs.switcher.hasAttribute('attention')) {
      refs.switcher.setAttribute('attention', unit.id);
    }

    deps.wiring().refreshScoops?.();

    deps.workbench()?.refreshMemory();
    deps.workbench()?.refreshFiles();

    host.onSelectionApplied?.();
  };

  return {
    clear: () => {
      selected = null;
    },
    getSelected: () => selected,

    holdQueue: () => {
      const jid = selected?.id;
      if (!jid) return;
      holdQueuedPile({
        controller: deps.controller(),
        held: heldQueues,
        jid,
        roster: deps.client().currentUnits(),
      });
    },
    selectScoop,
  };
}

export function prepareWcShell(app: HTMLElement, floatLabel: string): WcShellBoot {
  const refs = buildWcShellFrame(app, {
    messages: [],
    scoops: [],
    floatLabel,
    placeholder: 'Ask sliccy, or describe a change…',

    urlState: true,
  });

  let controller: WcChatController | null = null;
  let client: OffscreenClient | null = null;

  let chatHost: WcChatHost = DETACHED_CHAT_HOST;

  let chatClient: WorkUnitClient | null = null;
  const clientOf = (): WorkUnitClient => chatClient ?? ensureWorkUnitClient(wiring);
  const lickBackpressure = new Map<string, LickBackpressureState>();
  let clientReady = false;
  let workbench: WorkbenchActivator | null = null;
  const readyListeners = new Set<() => void>();

  const unitWatcher = createUnitWatcher(
    () => clientOf(),
    (messages, queuedIds) => {
      controller?.loadMessages(messages, queuedIds);
      chatHost.onSnapshotRendered?.(messages);
    }
  );
  const watchUnit = unitWatcher.watch;

  const selection = createSelection({
    client: clientOf,
    controller: () => controller,
    host: () => chatHost,
    lickBackpressure,
    refs,
    watchUnit,
    wiring: () => wiring,
    workbench: () => workbench,
  });
  const selectScoop = selection.selectScoop;

  const wiring: WcLiveWiring = {
    refs,
    statuses: new Map(),
    fills: new Map(),
    phases: new Map(),
    turns: new Map(),
    lickBackpressure,
    lastActivity: new Map(),

    pendingUrlContext:
      (refs.thread as HTMLElement & { urlContext?: string | null }).urlContext ?? null,
    getController: () => controller,
    getClient: () => client,
    getSelected: () => selection.getSelected(),
    selectScoop,
    notifyReady: () => {
      clientReady = true;
      for (const fn of readyListeners) fn();
    },
  };

  return {
    refs,
    wiring,
    setClient: (next) => {
      client = next;
    },
    setChatTransport: (nextClient, nextHost) => {
      chatClient = nextClient;
      chatHost = nextHost;
    },
    getChatHost: () => chatHost,
    selectScoop,
    getSelected: () => selection.getSelected(),
    clearSelection: () => selection.clear(),
    holdQueuedPile: () => selection.holdQueue(),
    watchUnit,
    getController: () => controller,
    setController: (next) => {
      controller = next;
    },
    setActivateSurface: (next) => {
      workbench = next;

      const placed = new Set(
        (refs.dockTree as unknown as { getSurfaceIds(): string[] }).getSurfaceIds()
      );
      for (const id of ['files', 'term', 'memory', 'monitor']) {
        if (!placed.has(id)) continue;
        if (clientReady) next.activate(id);
        else readyListeners.add(() => next.activate(id));
      }
    },
    onClientReady: (fn) => {
      readyListeners.add(fn);
      if (clientReady) fn();
    },
  };
}

function makeOpenVfs(client: OffscreenClient): () => Promise<WcPageVfs> {
  let vfsPromise: Promise<WcPageVfs> | null = null;
  return () => {
    vfsPromise ??= (async () => {
      const [{ createRemoteVfsClient }, { createRemoteWritableVfsClient }] = await Promise.all([
        import('../../kernel/remote-vfs-client.js'),
        import('../../kernel/writable-vfs-client.js'),
      ]);
      return {
        reader: createRemoteVfsClient({ transport: client.getTransport() }),
        writer: createRemoteWritableVfsClient({ transport: client.getTransport() }),
      };
    })();
    return vfsPromise;
  };
}

function wireWcWelcome(
  boot: WcShellBoot,
  client: OffscreenClient,
  openVfs: () => Promise<WcPageVfs>,
  holder: WelcomeInterceptHolder,
  log: BootStageLogger
): void {
  boot.onClientReady(() => {
    if (holder.intercept) return;
    void import('./wc-onboarding.js')
      .then(({ wireWcOnboarding }) =>
        wireWcOnboarding({ client, getController: () => boot.getController(), openVfs, log })
      )
      .then((handle) => {
        holder.intercept = handle.interceptWelcomeLick;
      })
      .catch((err) => log.error('WC onboarding wiring failed', err));
  });
}

export interface AttachWcWorkbenchOptions {
  instanceId?: string;

  standalone?: {
    browser: BrowserAPI;
    realCdpTransport: CDPTransport;
    runtimeMode: UiRuntimeMode;
    floatKind: import('@slicc/webcomponents').FloatbarFloatKind;
  };
}

function wireWcStats(wiring: WcLiveWiring, client: OffscreenClient): () => void {
  const refresh = (): void => {
    void client.getSessionStats?.().then((stats) => {
      if (!stats) return;
      wiring.refs.floatbar.setAttribute('spent', stats.totalCost.toFixed(2));
      if (typeof stats.burnRate === 'number' && Number.isFinite(stats.burnRate)) {
        wiring.refs.floatbar.setAttribute('rate', stats.burnRate.toFixed(2));
      } else {
        wiring.refs.floatbar.removeAttribute('rate');
      }

      const fb = wiring.refs.floatbar as HTMLElement & {
        costModels?: unknown;
        costScoops?: unknown;
        budget?: unknown;
      };
      if (stats.models) fb.costModels = stats.models;
      if (stats.scoops) fb.costScoops = stats.scoops;

      fb.budget = stats.budget
        ? {
            percent: stats.budget.percent,
            status: stats.budget.status,
            window: stats.budget.window,
            resets: formatBudgetResets(stats.budget.resetsAt),
          }
        : null;
      wiring.fills.clear();
      for (const f of stats.fills) wiring.fills.set(f.jid, f.fill);

      wiring.refreshScoops?.();
    });
  };
  setInterval(refresh, 15_000);
  return refresh;
}

function wireWcBrowserOverlay(
  boot: WcShellBoot,
  options: AttachWcWorkbenchOptions,
  log: BootStageLogger
): void {
  const standalone = options.standalone;
  if (!standalone) return;
  void import('./wc-browser.js')
    .then(({ wireWcBrowser }) =>
      wireWcBrowser({ refs: boot.refs, browser: standalone.browser, log })
    )
    .catch((err) => log.error('WC browser overlay wiring failed', err));
}

function labelSourceOf(scoop: Pick<RegisteredScoop, 'parentJid' | 'name' | 'assistantLabel'>): {
  role: 'primary' | 'child';
  name: string;
  assistantLabel: string;
} {
  return {
    assistantLabel: scoop.assistantLabel,
    name: scoop.name,
    role: isRootUnit(scoop) ? 'primary' : 'child',
  };
}

function makeTurnFinishedHook(deps: {
  boot: WcShellBoot;
  triggerPlaceholder(): void;
  refreshStats(): void;
}): () => void {
  return () => {
    deps.triggerPlaceholder();
    const jid = deps.boot.getSelected()?.id;

    deps.boot.wiring.awaitingInput = jid ?? null;
    deps.boot.wiring.refreshScoops?.();
    deps.boot.wiring.notifyScoopStateChanged?.();
    deps.refreshStats();
    if (!jid) return;
    deps.boot.refs.switcher.setAttribute('attention', jid);
    const last = deps.boot
      .getController()
      ?.getMessages()
      .filter((m) => m.role === 'assistant')
      .at(-1);
    if (last) {
      deps.boot.wiring.lastActivity.set(jid, String(last.content ?? '').slice(0, 600));
    }
  };
}

export function wireWcChipTips(deps: {
  switcher: HTMLElement;
  getScoops(): RegisteredScoop[];
  lastActivity: ReadonlyMap<string, string>;

  labelFn?: (opts: {
    prompt: string;
    system?: string;
    maxTokens?: number;
  }) => Promise<string | null>;
}): void {
  const tips = new Map<string, { activity: string; tip: string }>();
  const inFlight = new Set<string>();
  deps.switcher.addEventListener('pointerover', (event) => {
    const chip = (event.target as HTMLElement | null)?.closest?.<HTMLElement>(
      '.slicc-agent-tabs__segment'
    );
    if (!chip || !deps.switcher.contains(chip)) return;
    const jid = chip.dataset.k ?? '';
    const scoop = deps.getScoops().find((s) => s.jid === jid);
    if (!scoop) return;
    const activity = deps.lastActivity.get(jid) ?? '';
    const cached = tips.get(jid);
    if (cached && cached.activity === activity) {
      chip.title = cached.tip;
      return;
    }
    if (!chip.title) chip.title = switcherLabelFor(labelSourceOf(scoop));
    if (!activity || inFlight.has(jid)) return;
    inFlight.add(jid);
    void (async () => {
      try {
        const labelFn = deps.labelFn ?? (await import('../../providers/quick-llm.js')).quickLabel;
        const tip = await labelFn({
          system:
            'One line for a hover tooltip: at most 14 words, present tense, ' +
            'no quotes, no trailing period.',
          prompt:
            `Summarize what this agent has been doing.\n` +
            `Agent: ${isRootUnit(scoop) ? `${switcherLabelFor(labelSourceOf(scoop))} (a main agent)` : scoop.name}\n` +
            `Most recent activity:\n${activity}`,
          maxTokens: 40,
        });
        if (tip) {
          tips.set(jid, { activity, tip });
          chip.title = tip;
        }
      } finally {
        inFlight.delete(jid);
      }
    })();
  });
}

interface TerminalViewHolder {
  __slicc_terminal_view?: RemoteTerminalView;
}

interface KernelReadyHolder {
  __slicc_kernel_ready?: boolean;
}

async function mountWorkbenchTerminal(
  boot: WcShellBoot,
  client: OffscreenClient,
  container: HTMLElement
): Promise<void> {
  const { RemoteTerminalView } = await import('../../kernel/remote-terminal-view.js');
  const { fetchSecretEnvVars } = await import('../../core/secret-env.js');
  const env = await fetchSecretEnvVars();
  const view = new RemoteTerminalView({
    client,
    cwd: '/',
    env: Object.keys(env).length > 0 ? env : undefined,
  });
  await new Promise<void>((resolve) => boot.onClientReady(resolve));
  await view.mount(container);

  (globalThis as unknown as TerminalViewHolder).__slicc_terminal_view = view;
  window.addEventListener('beforeunload', () => view.dispose(), { once: true });
}

function wireWcUrlContext(
  boot: WcShellBoot,
  client: OffscreenClient,
  openFrozen: (slug: string) => Promise<void>
): void {
  const routeUrlContext = (ctx: string): void => {
    if (ctx.startsWith('freezer:')) {
      void openFrozen(ctx.slice('freezer:'.length));
      return;
    }
    const unit = unitForContext(ensureWorkUnitClient(boot.wiring).currentUnits(), ctx);
    if (unit && unit.id !== boot.getSelected()?.id) boot.selectScoop(unit);
  };
  boot.refs.thread.addEventListener('slicc-url-context', (event) => {
    const ctx = (event as CustomEvent<{ context?: string }>).detail?.context;
    if (ctx) routeUrlContext(ctx);
  });

  const pendingFrozen = boot.wiring.pendingUrlContext;
  if (pendingFrozen?.startsWith('freezer:')) {
    boot.onClientReady(() => {
      if (boot.wiring.pendingUrlContext !== pendingFrozen) return;
      boot.wiring.pendingUrlContext = null;
      routeUrlContext(pendingFrozen);
    });
  }
}

function wireWcPermissionsSurface(
  boot: WcShellBoot,
  client: OffscreenClient,
  options: AttachWcWorkbenchOptions,
  log: BootStageLogger
): void {
  void import('./wc-permissions.js')
    .then(async ({ installLeaderPermissionsSurface, installMountPendingConsumer }) => {
      const runtimeMode = options.standalone?.runtimeMode ?? 'standalone';
      const { buildLeaderPermissionProviders, isExtensionRuntime } = await import(
        './wc-permissions-providers.js'
      );
      const providers = await buildLeaderPermissionProviders(
        isExtensionRuntime() || runtimeMode === 'extension' || runtimeMode === 'extension-detached'
      );
      installLeaderPermissionsSurface({ runtimeMode, providers });

      installMountPendingConsumer({ runShell: makeDropMountRunner(boot, client) });
    })
    .catch((err) => log.warn('WC permissions surface wiring failed', err));

  if ((options.standalone?.runtimeMode ?? 'standalone') !== 'cherry') {
    void import('./wc-secret-request.js')
      .then(({ installSecretRequestSurface }) => installSecretRequestSurface())
      .catch((err) => log.warn('WC secret request surface wiring failed', err));
  }
}

function makeDropMountRunner(
  boot: WcShellBoot,
  client: OffscreenClient
): (command: string) => Promise<{ stdout: string; stderr: string; exitCode: number }> {
  let opening: Promise<
    import('../../kernel/terminal-session-client.js').TerminalSessionClient
  > | null = null;
  const getSession = (): Promise<
    import('../../kernel/terminal-session-client.js').TerminalSessionClient
  > => {
    if (!opening) {
      opening = (async () => {
        await new Promise<void>((resolve) => boot.onClientReady(resolve));
        const { TerminalSessionClient } = await import('../../kernel/terminal-session-client.js');
        const session = new TerminalSessionClient({ client, sid: `mount-drop-${Date.now()}` });
        await session.open({ cwd: '/workspace' });
        return session;
      })().catch((err) => {
        opening = null;
        throw err;
      });
    }
    return opening;
  };
  return async (command) => (await getSession()).exec(command);
}

export const DOCK_TREE_STORAGE_KEY = 'slicc-dock-tree:default';

export const DEFAULT_DOCK_TREE_ON_BOOT = {
  zones: {
    top: null,
    left: { type: 'leaf', surfaceId: 'chat' },
    middle: null,
    right: null,
    bottom: null,
  },
  rowFr: { top: 1, center: 1, bottom: 1 },
  colFr: { left: 3, middle: 1, right: 1 },
};

export function wireDockTreePersistence(refs: WcShellRefs, log: BootStageLogger): void {
  const dockTreeEl = refs.dockTree as unknown as HTMLElement;
  const dockTree = refs.dockTree as unknown as { setTree(spec: unknown): void };
  const persist = (tree: unknown): void => {
    try {
      localStorage.setItem(DOCK_TREE_STORAGE_KEY, JSON.stringify(tree));
    } catch {}
  };
  dockTreeEl.addEventListener('dock-tree-change', (event) => {
    persist((event as CustomEvent<{ tree?: unknown }>).detail?.tree);
  });
  dockTreeEl.addEventListener('dock-tree-resize', (event) => {
    persist((event as CustomEvent<{ tree?: unknown }>).detail?.tree);
  });
  try {
    const raw = localStorage.getItem(DOCK_TREE_STORAGE_KEY);
    dockTree.setTree(raw ? JSON.parse(raw) : DEFAULT_DOCK_TREE_ON_BOOT);
  } catch (err) {
    log.warn('WC dock-tree restore failed — seeding the default layout', err);
    dockTree.setTree(DEFAULT_DOCK_TREE_ON_BOOT);
  }
}

export function makeSprinkleAttachImage(
  composer: {
    getAttachStage(): import('./wc-attach.js').WcAttachmentStage | null;
  },
  log: BootStageLogger
): (base64: string, name?: string, mimeType?: string) => void {
  return (base64, name, mimeType) => {
    const stage = composer.getAttachStage();
    if (!stage) {
      log.warn('sprinkle attachImage dropped: composer stage not ready yet');
      return;
    }
    const dataUrlMatch = base64.match(/^data:(image\/[^;]+);base64,([A-Za-z0-9+/=]+)$/);
    const rawBase64 = dataUrlMatch ? dataUrlMatch[2] : base64;
    const mime = dataUrlMatch ? dataUrlMatch[1] : (mimeType ?? 'image/png');
    const ext = mime.split('/')[1]?.replace('jpeg', 'jpg').replace('svg+xml', 'svg') ?? 'png';
    const fileName = name ?? `annotation-${Date.now()}.${ext}`;
    stage.add({
      id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: fileName,
      mimeType: mime,
      size: Math.floor((rawBase64.length * 3) / 4),
      kind: 'image',
      data: rawBase64,
    });
  };
}

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: boot wiring is sequential; focused concerns live in neighboring factories
export function attachWcWorkbench(
  boot: WcShellBoot,
  client: OffscreenClient,
  chat: WcChatAttachment,
  host: LeaderChatHost,
  log: BootStageLogger,
  options: AttachWcWorkbenchOptions = {}
): (() => void) | undefined {
  void import('../timestamp-preference.js')
    .then(({ initTimestampPreference }) => initTimestampPreference())
    .catch(() => undefined);
  const { refs } = boot;
  boot.setClient(client);

  void import('../theme.js')
    .then(({ watchSprinkleThemeBroadcast }) => watchSprinkleThemeBroadcast())
    .catch(() => undefined);
  void import('../theme-engine.js')
    .then(({ applyThemeOverrides }) => applyThemeOverrides())
    .catch(() => undefined);

  const panelsRequested = isFeatureEnabled('panel-layouts');
  refs.dockTree.tilesMovable = panelsRequested;
  if (!panelsRequested) {
    wireDockTreePersistence(refs, log);
  }

  let refreshPlaceholder: (() => void) | null = null;
  const refreshStats = wireWcStats(boot.wiring, client);
  const triggerPlaceholder = (): void => refreshPlaceholder?.();

  const welcomeHolder = host.welcome ?? { intercept: null };

  const workUnits = ensureWorkUnitClient(boot.wiring);
  const { agentHandle } = chat;
  boot.onClientReady(refreshStats);

  const openVfs = makeOpenVfs(client);
  const openReader = async (): Promise<WcPageVfs['reader']> => (await openVfs()).reader;

  if (
    options.standalone?.runtimeMode !== 'cherry' &&
    options.standalone?.runtimeMode !== 'hosted-leader'
  ) {
    wireWcWelcome(boot, client, openVfs, welcomeHolder, log);
  } else {
    welcomeHolder.intercept = makeGelatiereCardFallback({
      openVfs: async () => (await openVfs()).writer,
      log,
    });
  }

  const composer = wireWcComposer({
    boot,
    client,
    setRefreshPlaceholder: (fn) => {
      refreshPlaceholder = fn;
    },
    triggerPlaceholder,
    openReader,
    openWriter: async () => (await openVfs()).writer,
    log,
  });

  host.setAttachmentSource(() => composer.getAttachStage()?.take());
  host.setTurnIdleHook(makeTurnFinishedHook({ boot, triggerPlaceholder, refreshStats }));

  wireWcChipTips({
    switcher: refs.switcher,
    getScoops: () => client.getScoops(),
    lastActivity: boot.wiring.lastActivity,
  });
  wireWcBrowserOverlay(boot, options, log);
  void import('./wc-computers.js')
    .then(({ installWcComputers }) => installWcComputers({ openFs: openReader, log }))
    .catch((err) => log.error('WC computers wiring failed', err));
  wireWcPermissionsSurface(boot, client, options, log);

  const workbenchActivator = createWorkbenchActivator({
    fileTree: refs.fileTree,
    termSurface: refs.termSurface,
    memoryHost: refs.memoryHost,
    monitor: refs.monitor,
    openFs: openReader,
    openWriter: async () => (await openVfs()).writer,
    onKernelReady: (fn) => boot.onClientReady(fn),
    getMonitorDeps: () => createWcMonitorDeps({ client, openReader, storage: window.localStorage }),

    getWorkspace: () =>
      workspaceForSelection({
        client,
        clearSelection: boot.clearSelection,
        selectedId: boot.getSelected()?.id,
      }),
    mountTerminal: (container) => mountWorkbenchTerminal(boot, client, container),
    insertReference: (path: string) => {
      const card = refs.inputCard as HTMLElement & { value: string; focus(): void };
      const current = card.value.trim();
      card.value = current ? `${current} @${path}` : `@${path}`;
      card.focus();
    },
    log,
  });
  boot.setActivateSurface(workbenchActivator);

  if (panelsRequested) {
    void import('./panelize-shell.js')
      .then(({ panelizeShell }) =>
        panelizeShell(refs, undefined, undefined, {
          onToolPanelActivate: (id) => workbenchActivator.activate(id),
          onToolPanelDeactivate: (id) => workbenchActivator.deactivate(id),
        })
      )
      .catch((err) => log.error('panelize failed — keeping the classic shell', err));
  }

  wireFileMentions({ thread: refs.thread, openFs: openReader, log });

  refs.floatbar.addEventListener('click', () => {
    const dock = refs.dock as HTMLElement & {
      active: string | null;
      selectItem(id: string): void;
      collapse(): void;
    };
    if (dock.active === 'monitor') dock.collapse();
    else dock.selectItem('monitor');
  });

  const freezerRail = wireFreezerRail({
    refs,
    openVfs,
    client,
    getUnits: () => workUnits.currentUnits(),
    getController: () => boot.getController(),
    getSelected: () => boot.getSelected(),
    selectScoop: boot.selectScoop,
    clearSelection: boot.clearSelection,
    holdQueuedPile: boot.holdQueuedPile,
    log,
  });
  const { refreshFreezer, openFrozen, getViewedFrozenSessionId } = freezerRail;

  refreshFreezer();
  boot.onClientReady(refreshFreezer);

  if (isFeatureEnabled('multiple-cones')) {
    const coneActions = wireConeActions({
      freezer: refs.freezer,
      client,
      getSelected: () => boot.getSelected(),
      getUnits: () => workUnits.currentUnits(),
      selectScoop: boot.selectScoop,
      freezeCone: freezerRail.freezeCone,
      log,
    });
    boot.wiring.refreshConeActions = coneActions.refresh;
    boot.onClientReady(coneActions.refresh);
  }

  wireWcUrlContext(boot, client, openFrozen);

  boot.onClientReady(() => {
    void openVfs()
      .then(async ({ reader, writer }) => {
        const { loadShortcutConfig } = await import('./wc-shortcut-config.js');
        await loadShortcutConfig({
          reader,
          writer,
          apply: ({ keymap, trigger }) => {
            refs.shortcuts.setKeymap(keymap);
            refs.shortcuts.setTrigger(trigger);
          },
        });
      })
      .catch((err) => log.warn('WC shortcut config load failed', err));
  });

  void openVfs()
    .then(async ({ reader }) => {
      const { installPreviewVfsResponder } = await import('../preview-vfs-responder.js');
      installPreviewVfsResponder({
        channel: new BroadcastChannel('preview-vfs'),
        getReader: () => reader,
        logger: log,
      });
    })
    .catch((err) => log.warn('WC page-VFS support wiring failed', err));

  void openVfs()
    .then(async ({ reader, writer }) => {
      const { createRemoteSprinkleVfs } = await import('../../kernel/remote-sprinkle-vfs.js');

      const panelizedForSprinkles = (await import('./panelize-shell.js')).getPanelizedShell();
      const { wireWcSprinkles } = await import('./wc-sprinkles.js');
      const sprinkles = await wireWcSprinkles({
        refs,
        client,
        getUnits: () => workUnits.currentUnits(),
        getSelected: () => boot.getSelected(),

        interceptWelcomeLick: (event) => welcomeHolder.intercept?.(event) ?? false,
        fs: createRemoteSprinkleVfs({ reader, writer }),
        instanceId: options.instanceId,
        onAttachImage: makeSprinkleAttachImage(composer, log),
        onToolPanelActivate: (id) => workbenchActivator.activate(id),
        onToolPanelDeactivate: (id) => workbenchActivator.deactivate(id),

        hostSprinkleSurface: panelizedForSprinkles
          ? (surfaceId, surface) => panelizedForSprinkles.hostSprinkleSurface(surfaceId, surface)
          : undefined,
        removeSprinkleSurface: panelizedForSprinkles
          ? (surfaceId) => panelizedForSprinkles.removeSprinkleSurface(surfaceId)
          : undefined,
        log,
      });

      boot.onClientReady(() => void sprinkles.resync());

      const { getPanelizedShell } = await import('./panelize-shell.js');
      const panelized = getPanelizedShell();
      if (panelized) {
        const sprinkleFs = createRemoteSprinkleVfs({ reader, writer });
        panelized.attachFs(sprinkleFs);
        const { registerAgentPanels } = await import('./agent-panels.js');
        await registerAgentPanels(sprinkleFs).catch((err) =>
          log.warn('agent panel discovery failed', err)
        );
      } else {
        const { setLayoutApplier } = await import('./layout-apply-registry.js');
        const { applyLayout } = await import('./apply-layout.js');
        setLayoutApplier((msg) => applyLayout(sprinkles.zone, msg));
      }
      if (options.standalone && options.instanceId) {
        const { wireWcTray } = await import('./wc-tray.js');
        const zoneCallbacks = sprinkles.zone.callbacks();
        const tray = await wireWcTray({
          refs,
          client,
          browser: options.standalone.browser,
          realCdpTransport: options.standalone.realCdpTransport,
          instanceId: options.instanceId,
          runtimeMode: options.standalone.runtimeMode,
          sprinkleManager: sprinkles.manager,
          addSprinkle: (name, title, element) => zoneCallbacks.addSprinkle(name, title, element),
          removeSprinkle: (name) => zoneCallbacks.removeSprinkle(name),
          getController: () => boot.getController(),
          getSelectedJid: () => boot.getSelected()?.id ?? 'cone',
          agentHandle,
          workUnits,
          restoreLocalChrome: () => {
            boot.wiring.refreshScoops?.();
            const selected = boot.getSelected();
            if (selected)
              void applyThreadContext(refs, selected, workUnits.currentUnits(), (id) =>
                client.getScoop(id)
              );
          },
          openFs: openReader,
          openWriter: async () => (await openVfs()).writer,
          window,
          log,
        });
        boot.wiring.notifyScoopStateChanged = () => tray.scheduleScoopsListBroadcast();
        boot.wiring.notifyUnitStatus = (jid, status) =>
          tray.broadcastUnitStatus(jid, status === 'processing' ? 'processing' : 'ready');
      }
    })
    .catch((err) => log.error('WC sprinkle/tray wiring failed', err));

  {
    const sessions = new CanonicalSessionReader(new WorkUnitConversationStore());
    const pageService = new DefaultTranscriptExportService({
      collection: {
        listScoops: () => client.getScoops(),
        isProcessing: (jid) => client.isProcessing(jid),

        getAgentMessages: () => null,

        loadPersistedSessions: () => sessions.loadAgentSessions(),
        loadUiChatSessions: () => sessions.loadChatSessions(),
        wait: (ms) => new Promise((res) => setTimeout(res, ms)),
      },
      knownSecrets: getStrictKnownSecretRedactor(),
      snapshotStore: {
        read: async (sessionId) => {
          const { reader } = await openVfs();
          return readSnapshot(reader, sessionId);
        },
        write: async (sessionId, snapshot) => {
          const { writer } = await openVfs();
          return writeSnapshot(writer, sessionId, snapshot);
        },
      },
      vfs: {
        readFile: async (path, opts) => (await openVfs()).reader.readFile(path, opts),
        readDir: async (path) => (await openVfs()).reader.readDir(path),
        stat: async (path) => (await openVfs()).reader.stat(path),
      },
      getActiveSessionInfo: () => {
        const cone = defaultRootOf(ensureWorkUnitClient(boot.wiring).currentUnits());
        return { id: cone?.id ?? `session-${Date.now()}`, title: cone?.name ?? 'Active Session' };
      },
      version: __SLICC_VERSION__,
    });
    const teardown = registerTranscriptExportService(pageService);

    window.addEventListener('unload', teardown, { once: true });
  }

  let exportInFlight = false;
  const onExportTranscript = (): Promise<void> => {
    if (exportInFlight) return Promise.resolve();
    exportInFlight = true;
    return (async () => {
      try {
        const [{ getTranscriptExportService }, { transcriptZipToBlob, downloadTranscriptBlob }] =
          await Promise.all([
            import('../../transcript/export-provider.js'),
            import('./wc-transcript-export.js'),
          ]);
        const frozenSelectorId = getViewedFrozenSessionId();
        const selector =
          frozenSelectorId != null
            ? { kind: 'frozen' as const, sessionId: frozenSelectorId }
            : { kind: 'active' as const };
        const service = getTranscriptExportService();
        const result = await service.export(selector, {});
        const { filename } = result;
        const blob = await transcriptZipToBlob(result);
        await downloadTranscriptBlob(blob, filename);
      } catch (err) {
        log.error('Transcript export failed', err);

        void import('./wc-transcript-export.js')
          .then(({ showTranscriptExportFailure }) => showTranscriptExportFailure(err))
          .catch((noticeErr) => log.error('Transcript export notice failed', noticeErr));
      } finally {
        exportInFlight = false;
      }
    })();
  };
  void import('./wc-nav.js')
    .then(({ wireWcNav }) =>
      wireWcNav({
        refs,
        client,
        workUnits,
        getUnits: () => workUnits.currentUnits(),
        log,
        onExportTranscript,
        shortcuts: refs.shortcuts,
        persistKeyboardTrigger: async (trigger) => {
          const { writer, reader } = await openVfs();
          const { writeShortcutTrigger } = await import('./wc-shortcut-config.js');
          await writeShortcutTrigger({ reader, writer }, trigger);
        },
      })
    )
    .catch((err) => log.error('WC nav wiring failed', err));

  void import('../../speech/composer-speech.js')
    .then(({ getComposerSpeech, setComposerSpeechInstanceId }) => {
      const composer = refs.composer as HTMLElement & { speech?: unknown };

      setComposerSpeechInstanceId(options.instanceId);
      composer.speech = getComposerSpeech();
      composer.setAttribute('ptt', '');
    })
    .catch((err) => log.error('WC push-to-talk wiring failed', err));

  void import('../../speech/speak.js')
    .then(({ setSpeakAssetsInstanceId }) => setSpeakAssetsInstanceId(options.instanceId))
    .catch((err) => log.error('WC say warmup wiring failed', err));

  if (!options.standalone) return undefined;
  return () => {
    void import('../new-session.js')
      .then(({ schedulePendingSessionCatchup }) =>
        schedulePendingSessionCatchup({
          openVfs: async () => (await openVfs()).writer,
          onComplete: refreshFreezer,
        })
      )
      .catch((err) => log.warn('Pending session catch-up scheduling failed', err));
  };
}

export async function bootLeaderFloat(
  app: HTMLElement,
  log: BootStageLogger,
  runtimeMode: UiRuntimeMode = 'standalone'
): Promise<void> {
  const {
    browser,
    realCdpTransport,
    instanceId,
    localApiBaseUrl,
    bridgeToken,
    localLickWsUrl,
    extensionDelegateId,
    attachLickForwardingClient,
  } = await setupStandalonePrelude({
    runtimeMode,
    envBaseUrl: import.meta.env.VITE_WORKER_BASE_URL ?? null,
    window,
    log,
  });

  const { floatKindForRuntimeMode, floatLabelForKind, resolveStandaloneFloatKind } = await import(
    './wc-float-label.js'
  );
  const floatKind =
    runtimeMode === 'standalone'
      ? await resolveStandaloneFloatKind()
      : floatKindForRuntimeMode(runtimeMode);
  const floatLabel = floatLabelForKind(floatKind);

  if (instanceId) installWorkerStaleAssetReloadListener(instanceId);
  const { syncFsBridgeEnabled, syncFsChannelNonce } = setupSyncFsBootNonce();
  let stallOverlayShown = false;
  let kernel!: SpawnedKernelHost<OffscreenClient>;
  let schedulePendingCatchup: (() => void) | undefined;

  const { boot } = await mountWcShell(app, log, {
    floatKind,
    floatLabel,
    connect: (boot) => {
      kernel = spawnKernelWorker({
        realCdpTransport,

        reconnectCdp: () => browser.reconnectIfNeeded(),
        instanceId,
        makeClient: (transport) =>
          new OffscreenClient(createWcLiveCallbacks(boot.wiring), transport),
        localApiBaseUrl,
        bridgeToken,
        syncFsBridgeEnabled,
        syncFsChannelNonce,
        localLickWsUrl,
        extensionDelegateId,

        flagFloat: runtimeMode,
        onWorkerScriptError: () => {
          guardedReload();
        },

        onReadyStall: (info) => {
          stallOverlayShown = true;
          void import('../boot/boot-stall-overlay.js').then((m) =>
            m.showBootStallOverlay(document, info)
          );
        },

        onLateReady: () => {
          guardedReload();
        },
      });
      installPageStorageSync({ send: (m) => kernel.client.sendRaw(m) });

      attachLickForwardingClient?.(kernel.client);
      const chatHost = createLeaderChatHost(kernel.client);
      return {
        client: ensureWorkUnitClient(boot.wiring),
        host: chatHost,
        workbench: (mounted, chat) => {
          schedulePendingCatchup = attachWcWorkbench(mounted, kernel.client, chat, chatHost, log, {
            instanceId,
            standalone: { browser, floatKind, realCdpTransport, runtimeMode },
          });
        },
      };
    },
  });

  const { setupSudoStandalone } = await import('../boot/setup-sudo.js');
  await setupSudoStandalone({ log });

  try {
    await kernel.ready;
  } finally {
    if (stallOverlayShown) {
      void import('../boot/boot-stall-overlay.js').then((m) => m.removeBootStallOverlay(document));
    }
  }

  boot.wiring.notifyReady?.();
  (globalThis as unknown as KernelReadyHolder).__slicc_kernel_ready = true;
  log.info('WC live shell ready', { scoops: kernel.client.getScoops().length });
  schedulePendingCatchup?.();

  const { consumeAutoPrompt } = await import('../boot/auto-prompt.js');
  const autoPrompt = consumeAutoPrompt(window.location.search);
  if (autoPrompt) {
    boot.getController()?.sendUserMessage(autoPrompt);
    log.info('Auto-prompt submitted', { length: autoPrompt.length });
  }
}
