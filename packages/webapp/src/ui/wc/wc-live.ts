/**
 * Live boot for the WC shell (`?ui=wc`): spawns the kernel worker directly —
 * no legacy `Layout` — and wires its callbacks onto a `WcChatController` and
 * the shell's scoop switcher. Phase 1 scope is the conversation loop:
 * composer → orchestrator prompt, agent events → thread, scoop switching.
 * Sprinkles, terminal, onboarding, tray, and sudo approvals still live only
 * in the legacy UI.
 */

import type { BrowserAPI, CDPTransport } from '../../cdp/index.js';
import { isFeatureEnabled } from '../../core/feature-flags.js';
import { SessionStore as AgentSessionStore } from '../../core/session.js';
import { installPageStorageSync } from '../../kernel/page-storage-sync.js';
import type { RemoteTerminalView } from '../../kernel/remote-terminal-view.js';
import { spawnKernelWorker } from '../../kernel/spawn.js';
import { SessionStore as UiSessionStore } from '../../scoops/chat-session-store.js';
import type { RegisteredScoop } from '../../scoops/types.js';
import { registerTranscriptExportService } from '../../transcript/export-provider.js';
import { DefaultTranscriptExportService } from '../../transcript/export-service.js';
import { readSnapshot, writeSnapshot } from '../../transcript/snapshot-store.js';
import { getStrictKnownSecretRedactor } from '../../transcript/strict-secret-client.js';
import { ownerWorkspaceFor } from '../../work-unit/descriptor.js';
import { isRootUnit } from '../../work-unit/policy.js';
import {
  guardedReload,
  installWorkerStaleAssetReloadListener,
} from '../boot/setup-preload-error-reload.js';
import { setupStandalonePrelude } from '../boot/setup-standalone-prelude.js';
import type { BootStageLogger } from '../boot/types.js';
import { OffscreenClient } from '../offscreen-client.js';
import type { UiRuntimeMode } from '../runtime-mode.js';
import type { ChatMessage } from '../types.js';
import type { WcChatController } from './wc-chat-controller.js';
import { wireConeActions } from './wc-cone-actions.js';
import {
  createWcLiveCallbacks,
  type LickBackpressureState,
  toSwitcherScoops,
  type WcLiveWiring,
} from './wc-live-callbacks.js';
import { wireWcComposer } from './wc-live-composer.js';
import { createWcController, type WelcomeInterceptHolder } from './wc-live-controller.js';
import { wireFreezerRail } from './wc-live-freezer.js';
import { createWcMonitorDeps } from './wc-live-monitor-deps.js';
import { setupSyncFsBootNonce } from './wc-live-sync-fs.js';
import { applyThreadContext } from './wc-live-thinking-hydration.js';
import { mountWcShell, type WcShellRefs } from './wc-shell.js';
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

/** Page-side VFS handles routed through the worker's `VfsRpcHost`. */
export interface WcPageVfs {
  reader: import('../../kernel/local-vfs-client.js').LocalVfsClient;
  writer: import('../../kernel/writable-vfs-client.js').WritableVfsClient;
}

/** Mutable boot state shared between the callbacks and the attach phase. */
export interface WcShellBoot {
  refs: WcShellRefs;
  wiring: WcLiveWiring;
  setClient(client: OffscreenClient): void;
  selectScoop(scoop: RegisteredScoop): void;
  getSelected(): RegisteredScoop | null;
  clearSelection(): void;
  getController(): WcChatController | null;
  setController(controller: WcChatController): void;
  /**
   * Wire the workbench's per-panel poller lifecycle. `wc-sprinkles.ts`'s
   * tool-panel dock-select/collapse listeners call `activate`/`deactivate`
   * directly; this setter's own job is only to replay `activate` for every
   * tool panel the restored dock-tree already placed (their pollers never
   * started, since the activator didn't exist yet when
   * `wireDockTreePersistence` ran).
   */
  setActivateSurface(activator: WorkbenchActivator): void;
  /**
   * Run `fn` once the kernel reports ready (immediately when it already has).
   * Wiring that reads worker state at attach time re-runs through this — an
   * RPC sent before the worker's hosts are installed is lost, not queued.
   */
  onClientReady(fn: () => void): void;
}

/**
 * Phase A of the live boot, float-agnostic: mount the shell and build the
 * mutable wiring the kernel callbacks close over. The client arrives in
 * {@link attachWcClient} (phase B) — standalone spawns a kernel worker,
 * the extension popout connects to the offscreen engine.
 */
export function prepareWcShell(app: HTMLElement, floatLabel: string): WcShellBoot {
  const refs = mountWcShell(app, {
    messages: [],
    scoops: [],
    floatLabel,
    placeholder: 'Ask sliccy, or describe a change…',
    // Live floats sync UI state with the URL: the thread owns `ctx`/`at`,
    // the shell owns `ws` — each component manages its own params.
    urlState: true,
  });

  let controller: WcChatController | null = null;
  let client: OffscreenClient | null = null;
  let selected: RegisteredScoop | null = null;
  const lickBackpressure = new Map<string, LickBackpressureState>();
  let clientReady = false;
  let workbench: WorkbenchActivator | null = null;
  const readyListeners = new Set<() => void>();

  /**
   * A cone's queued pile held while the user reads one of its scoops (#2312).
   * Selecting a read-only unit is not "dropping a prompt by navigating away"
   * — there is nowhere else to talk — so the pile survives that round trip.
   *
   * The hold is scoped to the OWNING CONE, not merely to "the destination is
   * read-only": leaving cone A for a scoop of cone B is the user going
   * somewhere else to work, and A's prompt is abandoned exactly as it would
   * be by clicking B itself. Only a detour INSIDE A's own subtree preserves
   * it (Codex P1).
   */
  let stashedQueue: { jid: string; items: ChatMessage[] } | null = null;

  const selectScoop = (scoop: RegisteredScoop): void => {
    selected = scoop;
    if (!client) return;
    const readOnly = isReadOnlyRole(unitRoleFor(scoop));
    const cancelQueued = (jid: string, ids: readonly string[]): void => {
      for (const id of ids) void client?.deleteQueuedMessage(jid, id).catch(() => undefined);
    };
    const roster = client.getScoops();
    /**
     * The cone that owns a unit — itself for a cone, its root for a scoop.
     * `undefined` when the unit is not in the live roster: `rootForSelection`
     * would fall back to the DEFAULT root there, which would silently read as
     * "same cone" and preserve a queue the user actually walked away from.
     * Unknown owner therefore means "cancel", the conservative direction and
     * the behaviour that predates the hold.
     */
    const ownerOf = (jid: string | undefined): string | undefined => {
      const unit = jid === undefined ? undefined : roster.find((s) => s.jid === jid);
      return unit ? (rootForSelection(roster, unit)?.jid ?? unit.jid) : undefined;
    };
    const destinationOwner = ownerOf(scoop.jid);
    // Scoop-switch queue-cancel: snapshot the OLD scoop's currently-queued
    // ids and cancel them on the backend BEFORE switching selectedScoopJid,
    // so the orchestrator never silently delivers a prompt the user dropped
    // by navigating to a different scoop. The controller's #queued is
    // dropped locally later via loadMessages; its onQueuedCancel hook then
    // fires against the NEW jid as defense-in-depth (a redundant per-id
    // delete is a no-op once the backend already removed it).
    const previousJid = client.selectedScoopJid;
    if (previousJid && previousJid !== scoop.jid) {
      const previousOwner = ownerOf(previousJid);
      // Held only for a read-only detour that stays inside the queue owner's
      // own cone; anything else is a real departure.
      if (readOnly && destinationOwner !== undefined && destinationOwner === previousOwner) {
        // Keyed by the OWNING CONE, not by the unit we are leaving: the queue
        // belongs to the cone, so a hop between two of its scoops must not
        // re-key the hold onto a scoop jid (which no destination owner could
        // ever match, cancelling the pile on the next hop).
        const items = controller?.stashQueued() ?? [];
        if (items.length > 0) stashedQueue = { jid: previousOwner, items };
      } else {
        const queued = controller?.getQueuedMessages() ?? [];
        cancelQueued(
          previousJid,
          queued.map((m) => m.id)
        );
      }
    }
    if (stashedQueue) {
      // Back on the cone that owns the pile: hand it to the controller, which
      // re-installs it after the replay. Still somewhere inside that cone's
      // subtree (a sibling scoop): keep holding. Anywhere else — including a
      // DIFFERENT cone's scoop — the detour is over and the prompts really
      // were abandoned, so cancel them on the backend.
      if (stashedQueue.jid === scoop.jid) {
        controller?.restoreQueued(stashedQueue.items);
        stashedQueue = null;
      } else if (destinationOwner !== stashedQueue.jid) {
        cancelQueued(
          stashedQueue.jid,
          stashedQueue.items.map((m) => m.id)
        );
        stashedQueue = null;
      }
    }
    const cachedBackpressure = lickBackpressure.get(scoop.jid);
    controller?.setLickBackpressure(
      cachedBackpressure?.count ?? 0,
      cachedBackpressure?.waitingMs ?? 0,
      unitSlugFor(scoop)
    );
    client.setSelectedScoopJid(scoop.jid);
    // A cone gets its composer back (text and queue intact — the band is
    // hidden, never rebuilt); `applyThreadContext` re-locks it for a scoop.
    // Set BEFORE `requestScoopMessages`, so the replay for the new selection
    // is the first thing rendered under the new mode.
    controller?.setReadOnly(readOnly);
    if (!readOnly) refs.inputCard.removeAttribute('disabled');
    void applyThreadContext(refs, scoop, client.getScoops());
    client.requestScoopMessages(scoop.jid);
    // Ahead of the replay on purpose: the held-queue reconcile that runs when
    // it lands reads the turn state (see `#applyPendingQueueRestore`, #2354).
    controller?.setProcessing(client.isProcessing(scoop.jid));
    // Boot default for the navbar eyes: until any message/input lands, the
    // first-selected scoop wears them (selection itself is not "activity").
    if (!refs.switcher.hasAttribute('attention')) {
      refs.switcher.setAttribute('attention', scoop.jid);
    }
    // The strip orders every cone first, then the SELECTED cone's scoops
    // (`orderForSwitcher`), so the descriptors are stale the moment selection
    // moves. Nothing else republishes them on a selection change — the next
    // roster/status event or the 15s stats poll would, which is long enough to
    // read as the strip ignoring the click.
    wiring.refreshScoops?.();
    // The memory panel shows the memory of the cone that owns the selection
    // (#2271) and reads once per activation, so an open panel has to be told
    // the selection moved. The file tree re-points itself on its next poll.
    workbench?.refreshMemory();
  };

  const wiring: WcLiveWiring = {
    refs,
    statuses: new Map(),
    fills: new Map(),
    phases: new Map(),
    lickBackpressure,
    lastActivity: new Map(),
    // The thread component owns the `ctx` param — the host only routes it.
    pendingUrlContext:
      (refs.thread as HTMLElement & { urlContext?: string | null }).urlContext ?? null,
    getController: () => controller,
    getClient: () => client,
    getSelected: () => selected,
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
    selectScoop,
    getSelected: () => selected,
    clearSelection: () => {
      selected = null;
    },
    getController: () => controller,
    setController: (next) => {
      controller = next;
    },
    setActivateSurface: (next) => {
      workbench = next;
      // Every tool panel already placed in the restored dock-tree (persisted
      // or default) needs its lazy mount fired retroactively — the activator
      // didn't exist yet when `wireDockTreePersistence` restored the tree.
      // Gate behind kernel ready: VFS RPCs (e.g. file tree load) need the
      // worker's VfsRpcHost to be attached, which only happens after host.ready.
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

/**
 * Page-side VFS factory: the worker owns the (OPFS) filesystem — page reads
 * and writes route through its VfsRpcHost. Opening OPFS from the page would
 * fight the worker's exclusive sync-access handles. Lazy + memoized.
 */
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

/**
 * Welcome flow: first-run detection posts the onboarding dip; the holder
 * gives the controller's dip-lick path its interceptor once wired. The
 * kernel must be ready first — the VFS probe is a worker RPC.
 */
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

export interface AttachWcClientOptions {
  /** Standalone kernel-worker id; enables the sprinkle ops channel. */
  instanceId?: string;
  /** Standalone-only runtime bits enabling tray sync + panel RPC. */
  standalone?: {
    browser: BrowserAPI;
    realCdpTransport: CDPTransport;
    runtimeMode: UiRuntimeMode;
    floatKind: import('@slicc/webcomponents').FloatbarFloatKind;
  };
}

/**
 * Session-stats poller: the floatbar cost counter and the chip pupils'
 * context-fill, pulled from the worker every poll tick and after each
 * finished turn. Stats are decorative — a timeout keeps the last values.
 */
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
      // Feed per-model and per-scoop breakdown to the floatbar overlay
      const fb = wiring.refs.floatbar as HTMLElement & {
        costModels?: unknown;
        costScoops?: unknown;
      };
      if (stats.models) fb.costModels = stats.models;
      if (stats.scoops) fb.costScoops = stats.scoops;
      wiring.fills.clear();
      for (const f of stats.fills) wiring.fills.set(f.jid, f.fill);
      wiring.refs.switcher.scoops = toSwitcherScoops(
        client.getScoops(),
        wiring.statuses,
        wiring.fills,
        wiring.phases,
        wiring.awaitingInput,
        wiring.getSelected()?.jid
      );
    });
  };
  setInterval(refresh, 15_000);
  return refresh;
}

/**
 * Browser · CDP dock item (standalone only): the full-screen tab switcher
 * with screenshot thumbnails — local tabs plus tray followers, whose
 * captures stream over the WebRTC-backed federated CDP channel.
 */
function wireWcBrowserOverlay(
  boot: WcShellBoot,
  options: AttachWcClientOptions,
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

/** Switcher wiring: tab clicks select scoops; hovered segments get LLM tooltips. */
function wireWcSwitcher(boot: WcShellBoot, client: OffscreenClient): void {
  const { refs } = boot;
  refs.switcher.addEventListener('slicc-scoop-select', (event) => {
    const key = (event as CustomEvent<{ key?: string }>).detail?.key;
    const scoop = client.getScoops().find((s) => s.jid === key);
    if (scoop && scoop.jid !== boot.getSelected()?.jid) boot.selectScoop(scoop);
  });
  wireWcChipTips({
    switcher: refs.switcher,
    getScoops: () => client.getScoops(),
    lastActivity: boot.wiring.lastActivity,
  });
}

/**
 * Turn-finished hook: refresh the suggested placeholder + session stats,
 * then record the reply as the selected scoop's most-recent activity (the
 * navbar eyes and the hover-tooltip summary both key off it).
 */
function makeTurnFinishedHook(deps: {
  boot: WcShellBoot;
  triggerPlaceholder(): void;
  refreshStats(): void;
}): () => void {
  return () => {
    deps.triggerPlaceholder();
    const jid = deps.boot.getSelected()?.jid;
    // The turn is over and the composer is ready: that scoop's avatar switches
    // from idle's lazy wander to eye contact with the composer (and, if it is
    // kept waiting, the drowse). Set BEFORE the stats refresh so the rebuilt
    // descriptors carry it.
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

/**
 * Richer scoop/cone hover tooltips: pointing at a segment sets a one-line LLM
 * summary of that agent's most recent activity as the segment's native title.
 * Summaries generate lazily on hover (no calls for idle scoops), are cached
 * per activity snapshot, and the bare scoop label stands in while (or if)
 * the call doesn't land.
 */
export function wireWcChipTips(deps: {
  switcher: HTMLElement;
  getScoops(): RegisteredScoop[];
  lastActivity: ReadonlyMap<string, string>;
  /** Injectable label runner (tests). Defaults to `quickLabel`. */
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
    if (!chip.title) chip.title = switcherLabelFor(scoop);
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
            `Agent: ${isRootUnit(scoop) ? `${switcherLabelFor(scoop)} (a main agent)` : scoop.name}\n` +
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

/**
 * Mount the worker-shell terminal into the workbench `term` surface.
 *
 * Gated on `boot.onClientReady`: a `terminal-open` sent before the worker's
 * `TerminalSessionHost` subscribes is dropped (same race as the freezer/stats
 * wiring — the bus has no listener yet). `onClientReady` fires immediately
 * when the kernel already reported ready, so this is free on late
 * activations. The client-side `open()` also retries defensively.
 */
/**
 * The one property this module hangs off `globalThis` — the mounted terminal
 * view, published for Playwright. Named rather than an untyped string-keyed
 * bag, mirroring `BrowserHolder` in `cdp/active-transport.ts`.
 */
interface TerminalViewHolder {
  __slicc_terminal_view?: RemoteTerminalView;
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
  // E2E seam: publish the mounted view so Playwright can drive
  // `executeCommandInTerminal` directly (mirrors the chat panel's "run
  // in terminal" affordance and avoids xterm-canvas scraping). Same
  // unconditional-publish pattern as `__slicc_pm` / `__slicc_browser`.
  (globalThis as unknown as TerminalViewHolder).__slicc_terminal_view = view;
  window.addEventListener('beforeunload', () => view.dispose(), { once: true });
}

/**
 * URL context routing. The thread owns the `ctx` param; the host resolves a
 * context id to app state: cone / scoop selection, or a freezer thaw. Covers
 * back/forward (the thread's `slicc-url-context` on popstate — it re-applies
 * its own scroll param) and the boot deep link to a frozen session.
 */
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
    const scoop = unitForContext(client.getScoops(), ctx);
    if (scoop && scoop.jid !== boot.getSelected()?.jid) boot.selectScoop(scoop);
  };
  boot.refs.thread.addEventListener('slicc-url-context', (event) => {
    const ctx = (event as CustomEvent<{ context?: string }>).detail?.context;
    if (ctx) routeUrlContext(ctx);
  });
  // Boot deep-link to a frozen session: scoop targets route through the
  // callbacks' ensureSelection, but a thaw needs the worker's VFS — wait
  // for kernel-ready. (`onClientReady` fires repeatedly; route only once.)
  const pendingFrozen = boot.wiring.pendingUrlContext;
  if (pendingFrozen?.startsWith('freezer:')) {
    boot.onClientReady(() => {
      if (boot.wiring.pendingUrlContext !== pendingFrozen) return;
      boot.wiring.pendingUrlContext = null;
      routeUrlContext(pendingFrozen);
    });
  }
}

/**
 * Leader-tab permission surface: the in-tab `<slicc-permissions>` host
 * routes camera / mic / USB / HID / serial / FS pickers through ONE
 * gesture-gated surface and accepts folder drops as writable mounts
 * (Wave 1 Spike A). Cherry follower iframes skip the mount — Spike A
 * confirmed cross-origin iframes can't hold writable FS handles.
 *
 * The mounted handle is published via the page-realm accessor
 * (`getLeaderPermissionsSurface`) in `wc-permissions-registry.ts` so
 * other page-side callers (panel-RPC `permission-request` handler,
 * terminal `<cmd> request` gestures, composer mic / PTT, the cone-driven
 * approval card) can reach the same surface without an ad-hoc DOM query.
 *
 * Extension mode (detected via `chrome.runtime.id`) injects popup-backed
 * providers from `wc-permissions-providers.ts` so the surface keeps a
 * single gesture entry point across runtimes — the side panel can't host
 * `showDirectoryPicker` / `navigator.{usb,hid,serial}.request*` directly,
 * so the popup window owns the picker click and the page re-acquires the
 * granted device before handing it back to the surface.
 */
function wireWcPermissionsSurface(
  boot: WcShellBoot,
  client: OffscreenClient,
  options: AttachWcClientOptions,
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
      // Spike A back-half: a dropped folder dispatches `slicc-mount-pending`;
      // this consumer adopts the stashed handle and mounts it under /mnt via
      // the worker's existing local-mount fast path. The runner opens a single
      // hidden worker shell session lazily on the first drop (gated on
      // kernel-ready so the fire-once `terminal-open` isn't dropped).
      installMountPendingConsumer({ runShell: makeDropMountRunner(boot, client) });
    })
    .catch((err) => log.warn('WC permissions surface wiring failed', err));
}

/**
 * Build the `runShell` the mount-pending consumer uses to drive the worker
 * `mount` command. Lazily opens ONE `TerminalSessionClient` on the first drop
 * (waiting for kernel-ready first — same race the workbench terminal guards)
 * and reuses it for every subsequent command.
 */
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
        // Reset so a later drop can retry instead of inheriting a poisoned
        // open promise (e.g. a one-off kernel-open timeout).
        opening = null;
        throw err;
      });
    }
    return opening;
  };
  return async (command) => (await getSession()).exec(command);
}

/**
 * localStorage key for the persisted dock-tree layout (the GUI drag-drop dock
 * editor, `tree: true` presets — see `layout-spec.ts`). `default` stands in
 * for a future multi-profile scheme; today every float has exactly one
 * implicit profile (this browser/extension origin already scopes storage).
 */
export const DOCK_TREE_STORAGE_KEY = 'slicc-dock-tree:default';

/**
 * The boot-time fallback tree when nothing is persisted yet: a 5-zone tree
 * seating the reserved, non-closable `chat` leaf in `left` — the exact shape
 * of the `focus` preset (see `layout-spec.ts`), which has chat and nothing
 * else. Tool panels (files/terminal/memory/monitor) start closed, exactly
 * like any sprinkle, and are placed into `right` the first time their dock
 * icon is clicked (see `DEFAULT_TOOL_ZONE` in `wc-sprinkles.ts`). Kept as an
 * independent literal here rather than a static import so this module's
 * bundle doesn't pull in `wc-sprinkles.js`/`layout-spec.js` eagerly — the
 * `'chat'` surface id is likewise the literal `CHAT_SURFACE_ID` value, not an
 * import, for the same reason.
 *
 * Once a user drags chat elsewhere, `dock-tree-change` persists that tree and
 * THIS default is never consulted again for that profile — restoring a
 * persisted tree with `chat` in a different zone is handled entirely by
 * `setTree` below.
 */
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

/**
 * Persist the dock-tree's layout per profile: `dock-tree-change` (drag-drop /
 * `placeSurface` / `removeSurface` mutations) and `dock-tree-resize` (divider
 * drags) both carry the full serialized tree in `detail.tree` — write it
 * straight to `localStorage` (best-effort, try/catch; persistence is a
 * convenience, never load-bearing for the tree to render). On attach, restore
 * whatever was last persisted, or fall back to `DEFAULT_DOCK_TREE_ON_BOOT`.
 * `setTree` does not itself emit a change event, so this restore can never
 * loop back into a persist write. Runs for BOTH floats (standalone and
 * extension) via `attachWcClient` — dual-mode by construction.
 */
export function wireDockTreePersistence(refs: WcShellRefs, log: BootStageLogger): void {
  const dockTreeEl = refs.dockTree as unknown as HTMLElement;
  const dockTree = refs.dockTree as unknown as { setTree(spec: unknown): void };
  const persist = (tree: unknown): void => {
    try {
      localStorage.setItem(DOCK_TREE_STORAGE_KEY, JSON.stringify(tree));
    } catch {
      /* best-effort — persistence is a convenience, not load-bearing */
    }
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

/** Sequence the focused live-shell factories over a connected client. */
// biome-ignore lint/complexity/noExcessiveLinesPerFunction: boot wiring is sequential; focused concerns live in neighboring factories
export function attachWcClient(
  boot: WcShellBoot,
  client: OffscreenClient,
  log: BootStageLogger,
  options: AttachWcClientOptions = {}
): (() => void) | undefined {
  // Apply persisted timestamp visibility preference (both standalone + extension).
  void import('../timestamp-preference.js')
    .then(({ initTimestampPreference }) => initTimestampPreference())
    .catch(() => undefined);
  const { refs } = boot;
  boot.setClient(client);
  // Panel system: re-parents the shell's chrome into `<slicc-layout>` panels.
  // Gated by the `panel-layouts` feature flag (off by default) rather than a URL
  // param, so there is ONE source of truth — a query flag would let a bookmarked
  // URL contradict the user's own setting with nothing in the UI explaining why.
  // Resolved once at boot: the flag mechanism has no live refresh, and switching
  // layout engines mid-session would strand the panels already mounted.
  //
  // Read BEFORE `wireDockTreePersistence` so the dock-tree it would restore into
  // is already superseded when panels are on.
  const panelsRequested = isFeatureEnabled('panel-layouts');
  refs.dockTree.tilesMovable = panelsRequested;
  if (!panelsRequested) {
    // GUI drag-drop dock-tree layout editor: restore any persisted tree (or
    // seed the default) and wire future mutations back to storage. Runs
    // regardless of the currently-active layout — the dock-tree element is
    // always mounted (hidden until a `tree: true` layout activates it).
    wireDockTreePersistence(refs, log);
  }
  // Turn-finished hooks: the suggested composer placeholder (assigned by
  // wireWcComposer once its module loads) + a stats refresh.
  let refreshPlaceholder: (() => void) | null = null;
  const refreshStats = wireWcStats(boot.wiring, client);
  const triggerPlaceholder = (): void => refreshPlaceholder?.();
  const welcomeHolder: WelcomeInterceptHolder = { intercept: null };
  const { controller, agentHandle } = createWcController(
    refs,
    client,
    () => boot.getSelected(),
    makeTurnFinishedHook({ boot, triggerPlaceholder, refreshStats }),
    welcomeHolder
  );
  boot.setController(controller);
  boot.onClientReady(refreshStats);

  const openVfs = makeOpenVfs(client);
  const openReader = async (): Promise<WcPageVfs['reader']> => (await openVfs()).reader;

  if (
    options.standalone?.runtimeMode !== 'cherry' &&
    options.standalone?.runtimeMode !== 'hosted-leader'
  ) {
    wireWcWelcome(boot, client, openVfs, welcomeHolder, log);
  }

  const composer = wireWcComposer({
    boot,
    client,
    agentHandle,
    setRefreshPlaceholder: (fn) => {
      refreshPlaceholder = fn;
    },
    triggerPlaceholder,
    openReader,
    openWriter: async () => (await openVfs()).writer,
    log,
  });

  wireWcSwitcher(boot, client);
  wireWcBrowserOverlay(boot, options, log);
  wireWcPermissionsSurface(boot, client, options, log);
  // Workbench: VFS file tree + worker-shell terminal, both lazy on first
  // surface activation from the dock or tab bar. `workbenchActivator` is
  // captured here (not just handed to `boot`) so the sprinkle wiring below
  // can also call `deactivate` when a tool panel's leaf closes.
  const workbenchActivator = createWorkbenchActivator({
    fileTree: refs.fileTree,
    termSurface: refs.termSurface,
    memoryHost: refs.memoryHost,
    monitor: refs.monitor,
    openFs: openReader,
    openWriter: async () => (await openVfs()).writer,
    onKernelReady: (fn) => boot.onClientReady(fn),
    getMonitorDeps: () => createWcMonitorDeps({ client, openReader, storage: window.localStorage }),
    // The workbench shows the files and memory of the cone that owns the
    // current selection — the primary's `/workspace` until an extra cone is
    // selected (#2271).
    getWorkspace: () => ownerWorkspaceFor(client.getScoops(), boot.getSelected() ?? undefined),
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

  // Panelize when `panel-layouts` is on (see the flag read above).
  //
  // Placed after `workbenchActivator` exists because panelization takes over the
  // dock rail's clicks (the dock-tree it used to drive is gone), and opening a
  // tool panel must still start its poller / lazy-mount — otherwise the terminal
  // opens with no session, which is exactly what happened before this was wired.
  // The VFS arrives later via `attachFs` (see the `openVfs()` block below).
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

  // File mentions: agents name files constantly ("I rewrote bb.jsh"), and those
  // names are the most clickable thing in a transcript. Each one is verified
  // against the VFS before it becomes a link, so a mention that does not
  // resolve stays ordinary text.
  //
  // Wired AFTER panelization on purpose. Linking is decoration on text the user
  // is already reading, whereas the block above starts the tool panels' pollers
  // and lazy mounts — including the terminal's. Ordering it last means it can
  // neither delay that work nor, if it throws, prevent it.
  wireFileMentions({ thread: refs.thread, openFs: openReader, log });

  // Floatbar click toggles the monitor panel.
  refs.floatbar.addEventListener('click', () => {
    const dock = refs.dock as HTMLElement & {
      active: string | null;
      selectItem(id: string): void;
      collapse(): void;
    };
    if (dock.active === 'monitor') dock.collapse();
    else dock.selectItem('monitor');
  });

  // Freezer rail: frozen cone sessions thaw read-only into the thread;
  // selecting any scoop chip returns to the live conversation.
  const freezerRail = wireFreezerRail({
    refs,
    openVfs,
    client,
    getController: () => boot.getController(),
    getSelected: () => boot.getSelected(),
    selectScoop: boot.selectScoop,
    clearSelection: boot.clearSelection,
    log,
  });
  const { refreshFreezer, openFrozen, getViewedFrozenSessionId } = freezerRail;
  // The boot-time refresh races the worker's VfsRpcHost installation (a lost
  // request hangs silently) — re-run once the kernel reports ready.
  refreshFreezer();
  boot.onClientReady(refreshFreezer);

  // Cone actions of the rail's action row: new cone / drop cone (#1666,
  // #2272). Experimental — behind the `multiple-cones` flag (Settings →
  // Experimental); without it the row never learns a cone count and shows
  // neither. Re-synced from the roster whenever the switcher chips refresh.
  if (isFeatureEnabled('multiple-cones')) {
    const coneActions = wireConeActions({
      freezer: refs.freezer,
      client,
      getSelected: () => boot.getSelected(),
      selectScoop: boot.selectScoop,
      freezeCone: freezerRail.freezeCone,
      log,
    });
    boot.wiring.refreshConeActions = coneActions.refresh;
    boot.onClientReady(coneActions.refresh);
  }

  wireWcUrlContext(boot, client, openFrozen);

  // Page-side preview-vfs fallback responder (the worker's responder is
  // canonical; this covers pre-boot requests). Mount recovery is the
  // worker's job — its kernel host replays the mount table itself.
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

  // Sprinkles (the legacy SprinkleManager over the WC workbench chrome),
  // then tray sync on top — the leader broadcasts sprinkle state.
  void openVfs()
    .then(async ({ reader, writer }) => {
      const { createRemoteSprinkleVfs } = await import('../../kernel/remote-sprinkle-vfs.js');
      // Resolved before `wireWcSprinkles` so its sprinkle-hosting hooks can be
      // wired at construction: a panelized shell must host sprinkle surfaces
      // itself (see `hostSprinkleSurface`).
      const panelizedForSprinkles = (await import('./panelize-shell.js')).getPanelizedShell();
      const { wireWcSprinkles } = await import('./wc-sprinkles.js');
      const sprinkles = await wireWcSprinkles({
        refs,
        client,
        fs: createRemoteSprinkleVfs({ reader, writer }),
        instanceId: options.instanceId,
        onAttachImage: makeSprinkleAttachImage(composer, log),
        onToolPanelActivate: (id) => workbenchActivator.activate(id),
        onToolPanelDeactivate: (id) => workbenchActivator.deactivate(id),
        // Panelized shells host sprinkle surfaces themselves: the dock-tree
        // `WcSprinkleZone` would otherwise append to is gone, so a new sprinkle
        // would be created detached and never render.
        hostSprinkleSurface: panelizedForSprinkles
          ? (surfaceId, surface) => panelizedForSprinkles.hostSprinkleSurface(surfaceId, surface)
          : undefined,
        removeSprinkleSurface: panelizedForSprinkles
          ? (surfaceId) => panelizedForSprinkles.removeSprinkleSurface(surfaceId)
          : undefined,
        log,
      });
      // The wire-up-time discovery/restore races the worker's VfsRpcHost
      // installation (a lost RPC fails 30s late) — re-run on kernel-ready,
      // same recovery the freezer rail uses. resync() is idempotent.
      boot.onClientReady(() => void sprinkles.resync());
      // Register the page-side layout applier so the kernel worker's
      // `layout` command (via the `layout-apply` panel-RPC op) can reach
      // `applyLayout`. This shared boot path covers BOTH floats — standalone
      // (wc-live's own boot) and extension (`wc-extension.ts` reuses
      // `attachWcClient`).
      const { getPanelizedShell } = await import('./panelize-shell.js');
      const panelized = getPanelizedShell();
      if (panelized) {
        // Panels are running: hand it the VFS so the document verbs
        // (`load`/`save`/`docs`) and the add-panel menu's saved-layout list work,
        // and register agent-authored panels now that a filesystem exists.
        // Crucially, do NOT install the dock-tree applier below — it would
        // overwrite the panel applier `panelizeShell` already registered and
        // silently route every `layout` command to the wrong engine.
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
          getSelectedJid: () => boot.getSelected()?.jid ?? 'cone',
          agentHandle,
          openFs: openReader,
          openWriter: async () => (await openVfs()).writer,
          window,
          log,
        });
        boot.wiring.notifyScoopStateChanged = () => tray.scheduleScoopsListBroadcast();
      }
    })
    .catch((err) => log.error('WC sprinkle/tray wiring failed', err));

  // Register the page-side transcript export service so commands on the page
  // can call getTranscriptExportService() without hitting session-not-found.
  // Teardown is identity-safe: a later re-registration won't be evicted.
  {
    const agentSessionStore = new AgentSessionStore();
    const uiSessionStore = new UiSessionStore();
    const pageService = new DefaultTranscriptExportService({
      collection: {
        listScoops: () => client.getScoops(),
        isProcessing: (jid) => client.isProcessing(jid),
        // Live agent messages are worker-side; fall back to persisted sessions.
        getAgentMessages: () => null,
        loadPersistedSessions: () => agentSessionStore.loadAll(),
        loadUiChatSessions: async () => {
          const ids = await uiSessionStore.list();
          const sessions = await Promise.all(ids.map((id) => uiSessionStore.load(id)));
          return sessions.filter((s): s is NonNullable<typeof s> => s !== null);
        },
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
        const cone = defaultRootOf(client.getScoops());
        return { id: cone?.jid ?? `session-${Date.now()}`, title: cone?.name ?? 'Active Session' };
      },
      version: __SLICC_VERSION__,
    });
    const teardown = registerTranscriptExportService(pageService);
    // Clean up on page unload so a re-mount doesn't leave a stale registration.
    window.addEventListener('unload', teardown, { once: true });
  }

  // Nav: model picker + avatar menu (settings dialog, legacy-UI escape hatch).
  // Duplicate-click guard: only one export may be in-flight at a time.
  // Defense-in-depth guard: wc-nav also tracks in-flight state, but this
  // ensures no concurrent export even if the nav guard is bypassed.
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
      } finally {
        exportInFlight = false;
      }
    })();
  };
  void import('./wc-nav.js')
    .then(({ wireWcNav }) => wireWcNav({ refs, client, log, onExportTranscript }))
    .catch((err) => log.error('WC nav wiring failed', err));

  // Push-to-talk: arm the composer's hold-to-dictate gesture and inject the
  // webapp speech controller (builtin Web Speech now, whisper-tiny once its
  // lazy download completes). The controller module stays out of the boot
  // bundle — it only loads here, and the model only downloads on first use.
  void import('../../speech/composer-speech.js')
    .then(({ getComposerSpeech, setComposerSpeechInstanceId }) => {
      const composer = refs.composer as HTMLElement & { speech?: unknown };
      // Scope the page→worker speech-assets bridge to this kernel instance so
      // the PTT warmup auto-stages the on-device assets (R10) before loading.
      setComposerSpeechInstanceId(options.instanceId);
      composer.speech = getComposerSpeech();
      composer.setAttribute('ptt', '');
    })
    .catch((err) => log.error('WC push-to-talk wiring failed', err));
  // Scope the kokoro warmup's speech-assets bridge (R10) to this kernel instance.
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

/** Boot the standalone live WC shell: prelude → kernel spawn → attach. */
export async function mountWcUiLive(
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

  // Floatbar names the serving runtime (npx / sliccstart / hosted / …).
  const { floatKindForRuntimeMode, floatLabelForKind, resolveStandaloneFloatKind } = await import(
    './wc-float-label.js'
  );
  const { installFloatbarStatus } = await import('./wc-floatbar-online.js');
  const floatKind =
    runtimeMode === 'standalone'
      ? await resolveStandaloneFloatKind()
      : floatKindForRuntimeMode(runtimeMode);
  const floatLabel = floatLabelForKind(floatKind);

  const boot = prepareWcShell(app, floatLabel);
  installFloatbarStatus(boot.refs.floatbar, { floatKind, label: floatLabel });
  // #1330: install the reload listener BEFORE spawning — BroadcastChannel doesn't
  // buffer and the worker posts init synchronously, so a late listener would miss
  // a fast boot-time failure.
  if (instanceId) installWorkerStaleAssetReloadListener(instanceId);
  const { syncFsBridgeEnabled, syncFsChannelNonce } = setupSyncFsBootNonce();
  const host = spawnKernelWorker({
    realCdpTransport,
    instanceId,
    makeClient: (transport) => new OffscreenClient(createWcLiveCallbacks(boot.wiring), transport),
    localApiBaseUrl,
    bridgeToken,
    syncFsBridgeEnabled,
    syncFsChannelNonce,
    localLickWsUrl,
    extensionDelegateId,
    // The worker adopts this float's cached remote flags at boot (#2003).
    flagFloat: runtimeMode,
    onWorkerScriptError: () => {
      guardedReload();
    },
  });
  installPageStorageSync({ send: (m) => host.client.sendRaw(m) });
  // Extension-leader path only: late-bind the now-minted kernel client into the
  // extension-bridge `onLick` handler so forwarded handoff/upskill licks reach
  // the worker `LickManager`. No-op on every other CDP path.
  attachLickForwardingClient?.(host.client);
  const schedulePendingCatchup = attachWcClient(boot, host.client, log, {
    instanceId,
    standalone: {
      browser,
      realCdpTransport,
      runtimeMode,
      floatKind,
    },
  });

  const { setupSudoStandalone } = await import('../boot/setup-sudo.js');
  await setupSudoStandalone({ log });

  await host.ready;
  // `host.ready` resolves on `kernel-worker-ready`, which the worker posts
  // AFTER its VfsRpcHost attaches — unlike the first scoop-list (the
  // callbacks' onReady), which fires mid-boot while VFS RPCs still fan out
  // into nobody. Re-notify so boot reads (freezer rail) finally land.
  boot.wiring.notifyReady?.();
  log.info('WC live shell ready', { scoops: host.client.getScoops().length });
  schedulePendingCatchup?.();

  // Auto-submit: `node-server --prompt "..."` appends `?prompt=<text>` to
  // the launch URL. Consume it exactly once now that the kernel + controller
  // are ready. `consumeAutoPrompt` strips the param from the URL via
  // `history.replaceState` so reloads don't re-fire.
  const { consumeAutoPrompt } = await import('../boot/auto-prompt.js');
  const autoPrompt = consumeAutoPrompt(window.location.search);
  if (autoPrompt) {
    boot.getController()?.sendUserMessage(autoPrompt);
    log.info('Auto-prompt submitted', { length: autoPrompt.length });
  }
}
