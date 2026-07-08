/**
 * Live boot for the WC shell (`?ui=wc`): spawns the kernel worker directly —
 * no legacy `Layout` — and wires its callbacks onto a `WcChatController` and
 * the shell's scoop switcher. Phase 1 scope is the conversation loop:
 * composer → orchestrator prompt, agent events → thread, scoop switching.
 * Sprinkles, terminal, onboarding, tray, and sudo approvals still live only
 * in the legacy UI.
 */

import type { BrowserAPI, CDPTransport } from '../../cdp/index.js';
import { installPageStorageSync } from '../../kernel/page-storage-sync.js';
import { spawnKernelWorker } from '../../kernel/spawn.js';
import { resolveCurrentModel, resolveModelById } from '../../providers/account-store.js';
import type { LickEvent } from '../../scoops/lick-manager.js';
import { hasStoredTrayJoinUrl } from '../../scoops/tray-runtime-config.js';
import type { RegisteredScoop, ThinkingLevel } from '../../scoops/types.js';
import {
  guardedReload,
  installWorkerStaleAssetReloadListener,
} from '../boot/setup-preload-error-reload.js';
import { setupStandalonePrelude } from '../boot/setup-standalone-prelude.js';
import type { BootStageLogger } from '../boot/types.js';
import { type DipInstance, disposeDips, hydrateDips } from '../dip.js';
import { isLickChannel } from '../lick-channels.js';
import type { OffscreenClient, OffscreenClientCallbacks } from '../offscreen-client.js';
import type { UiRuntimeMode } from '../runtime-mode.js';
import type { ChatMessage } from '../types.js';
import { WcChatController } from './wc-chat-controller.js';
import { scoopColor } from './wc-scoop-color.js';

export { scoopColor } from './wc-scoop-color.js';

import {
  enrichFreezerIcons,
  FREEZER_TINT,
  type FrozenSessionIndexEntry,
  readFreezerEntries,
  readFreezerIndexState,
  rebuildFreezerIndexFromArchives,
  renderFreezerCards,
  SESSIONS_INDEX_PATH,
  thawFrozenSession,
} from './wc-freezer.js';
import {
  applyShellContext,
  mountWcShell,
  type SwitcherScoop,
  submittedText,
  type WcShellRefs,
} from './wc-shell.js';
import { createWorkbenchActivator } from './wc-workbench.js';

/**
 * Bridge the composer-meta thinking scale (`off…xhigh|max`) onto pi's
 * `ThinkingLevel` (`off|minimal|low|medium|high|xhigh`) and back. The
 * library's `max` caps at pi's `xhigh`; pi's `minimal` displays as `low`.
 */
const PI_FROM_META: Readonly<Record<string, ThinkingLevel>> = {
  off: 'off',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'xhigh',
};
const META_FROM_PI: Readonly<Record<string, string>> = {
  off: 'off',
  minimal: 'low',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
};

export function thinkingLevelForAgent(metaLevel: string | undefined): ThinkingLevel | undefined {
  return metaLevel ? PI_FROM_META[metaLevel] : undefined;
}

/**
 * Raw API effort override for levels that exceed pi-ai's ThinkingLevel range.
 * Returns `'max'` when the user picks Sprofondato (the UI's `max` level),
 * `undefined` otherwise — so the stream layer can inject `effort: 'max'`
 * directly into `output_config` without going through pi-ai's mapping.
 */
export function effortOverrideForAgent(metaLevel: string | undefined): string | undefined {
  return metaLevel === 'max' ? 'max' : undefined;
}

export function metaThinkingForScoop(
  level: ThinkingLevel | undefined,
  effortOverride?: string
): string {
  if (effortOverride === 'max') return 'max';
  return (level && META_FROM_PI[level]) ?? 'off';
}

/**
 * Whether stale-session hydration should be skipped: true when the page is a
 * tray follower (stored join URL or cherry embed) or when a non-cone URL
 * context is pending. In all these cases the leader's snapshot replaces local
 * history, so flashing IndexedDB content first would cause flicker.
 */
export function shouldSkipSessionHydration(
  pendingUrlContext: string | null | undefined,
  win: { location: { href: string }; localStorage: Storage }
): boolean {
  if (pendingUrlContext != null && pendingUrlContext !== 'cone') return true;
  if (new URL(win.location.href).searchParams.get('cherry') === '1') return true;
  return hasStoredTrayJoinUrl(win.localStorage);
}

/** Scoop runtime status, as broadcast by `onStatusChange`. */
export type ScoopStatus = 'initializing' | 'ready' | 'processing' | 'error';

/** Chip eye state for a scoop status: errored scoops get the dead look. */
function eyesFor(status: ScoopStatus | undefined): SwitcherScoop['eyes'] {
  if (status === 'error') return 'dead';
  if (status === 'initializing') return 'none';
  return 'open';
}

/** Map registered scoops onto switcher chip descriptors (cone first). */
export function toSwitcherScoops(
  scoops: readonly RegisteredScoop[],
  statuses?: ReadonlyMap<string, ScoopStatus>,
  fills?: ReadonlyMap<string, number>
): SwitcherScoop[] {
  return [...scoops]
    .sort((a, b) => Number(b.isCone) - Number(a.isCone))
    .map((scoop) => {
      const fill = fills?.get(scoop.jid);
      return {
        key: scoop.jid,
        type: scoop.isCone ? 'cone' : 'scoop',
        color: scoopColor(scoop),
        label: scoop.isCone ? 'sliccy' : scoop.name,
        eyes: eyesFor(statuses?.get(scoop.jid)),
        // The chip pupils dilate with context fullness (pill `fill` 0-100).
        fill: typeof fill === 'number' ? Math.round(fill * 100) : undefined,
      };
    });
}

export interface WcLiveWiring {
  refs: WcShellRefs;
  /** Live per-scoop status, written by the callbacks on every broadcast. */
  statuses: Map<string, ScoopStatus>;
  /** Per-scoop context-window fill (0..1), refreshed by the stats poller. */
  fills: Map<string, number>;
  /**
   * URL-restored boot context (the thread's `ctx` param) still awaiting
   * routing. While set, the boot auto-select targets it instead of the cone
   * (`scoop:<name>` selects that scoop; `freezer:<file>` suppresses selection
   * until the host thaws it). Cleared once routed.
   */
  pendingUrlContext: string | null;
  /**
   * Most recent activity snippet per scoop jid (latest incoming message,
   * user input, or finished reply) — the raw material for the hover-tooltip
   * summaries and the `attention` (blinking eyes) bookkeeping.
   */
  lastActivity: Map<string, string>;
  getController(): WcChatController | null;
  getClient(): OffscreenClient | null;
  getSelected(): RegisteredScoop | null;
  selectScoop(scoop: RegisteredScoop): void;
  /** Fired once the kernel reports ready (late wiring re-runs boot reads). */
  notifyReady?(): void;
}

/**
 * Kernel callbacks for the WC live shell. Pure factory over the wiring
 * handle so tests can drive it with fakes — no worker required.
 */
export function createWcLiveCallbacks(wiring: WcLiveWiring): OffscreenClientCallbacks {
  const refreshScoops = (): void => {
    const client = wiring.getClient();
    if (client) {
      wiring.refs.switcher.scoops = toSwitcherScoops(
        client.getScoops(),
        wiring.statuses,
        wiring.fills
      );
    }
  };
  /** Read-only frozen-session view — selection is intentionally empty there. */
  const viewingFrozen = (): boolean =>
    (wiring.refs.thread.getAttribute('context') ?? '').startsWith('freezer:');
  /**
   * Select the boot target when nothing is selected. The first state snapshot
   * can land BEFORE the cone finishes restoring (e.g. right after a clear +
   * reload) — onReady then has no cone to select, and a restored cone only
   * ever appears via later scoop-list updates (no scoop-created event). The
   * frozen view is exempt: its empty selection is deliberate. A URL-restored
   * context redirects the default: `scoop:<name>` selects that scoop,
   * `freezer:<file>` keeps the selection empty for the host's thaw routing.
   */
  const ensureSelection = (): void => {
    if (wiring.getSelected() || viewingFrozen()) return;
    const scoops = wiring.getClient()?.getScoops() ?? [];
    const pending = wiring.pendingUrlContext;
    if (pending?.startsWith('freezer:')) return;
    if (pending?.startsWith('scoop:')) {
      const name = pending.slice('scoop:'.length);
      const scoop = scoops.find((s) => !s.isCone && s.name === name);
      if (scoop) {
        wiring.pendingUrlContext = null;
        wiring.selectScoop(scoop);
        return;
      }
    }
    const cone = scoops.find((s) => s.isCone);
    if (cone) {
      // The URL scoop is gone (dropped since) — the cone is the live truth.
      wiring.pendingUrlContext = null;
      wiring.selectScoop(cone);
    }
  };
  return {
    onStatusChange: (jid, status) => {
      const previous = wiring.statuses.get(jid);
      wiring.statuses.set(jid, status as ScoopStatus);
      // Re-chip only on eye-state transitions; processing flickers are
      // frequent and don't change the chip rendering.
      if (eyesFor(previous) !== eyesFor(status as ScoopStatus)) refreshScoops();
      if (wiring.getSelected()?.jid !== jid) return;
      wiring.getController()?.setProcessing(status === 'processing');
    },
    onScoopCreated: (scoop) => {
      refreshScoops();
      // A pending URL context owns the boot selection — don't steal it.
      if (!wiring.getSelected() && !viewingFrozen() && !wiring.pendingUrlContext) {
        wiring.selectScoop(scoop);
      }
    },
    onScoopListUpdate: () => {
      refreshScoops();
      ensureSelection();
    },
    onScoopActivity: (jid) => {
      // Agent-event ping for ANY scoop (selected or not): keep the navbar
      // eyes on whichever scoop is actively streaming. Mirrors the
      // `attention` write in `onIncomingMessage`; no thread routing.
      wiring.refs.switcher.setAttribute('attention', jid);
    },
    onIncomingMessage: (jid, message) => {
      // Most-recent-activity tracking: the scoop that just received a message
      // wears the blinking navbar eyes (the switcher's `attention` chip) and
      // the snippet feeds the hover-tooltip summary.
      wiring.refs.switcher.setAttribute('attention', jid);
      wiring.lastActivity.set(jid, String(message.content ?? '').slice(0, 600));
      if (wiring.getSelected()?.jid !== jid) return;
      if (message.channel !== 'web' && isLickChannel(message.channel)) {
        wiring
          .getController()
          ?.addLickMessage(
            message.id,
            message.content,
            message.channel,
            new Date(message.timestamp).getTime(),
            message.lickId
          );
      }
    },
    onMessageUpdate: (jid, update) => {
      // Live flip of an actionable lick card's state (sudo-request settled).
      // Only the selected scoop's thread is mounted, so a non-selected update
      // is a no-op here — the persisted lickState rehydrates it on next load.
      if (wiring.getSelected()?.jid !== jid) return;
      if (update.lickId && update.lickState) {
        wiring.getController()?.updateLickState(update.lickId, update.lickState);
      }
    },
    onScoopMessagesReplaced: (jid, messages) => {
      if (wiring.getSelected()?.jid !== jid) return;
      wiring.getController()?.loadMessages(messages as unknown as ChatMessage[]);
    },
    onReady: () => {
      refreshScoops();
      ensureSelection();
      wiring.notifyReady?.();
    },
  };
}

/** Point the thread chrome at a scoop (context label + accent hue + model). */
async function applyThreadContext(refs: WcShellRefs, scoop: RegisteredScoop): Promise<void> {
  refs.thread.setAttribute('context', scoop.isCone ? 'cone' : `scoop:${scoop.name}`);
  refs.thread.setAttribute('accent', scoopColor(scoop));
  // The whole frame changes mood with the selection: waffle lattice + warm
  // amber for the cone, swirling pastels + the scoop's accent for scoops.
  applyShellContext(
    refs,
    scoop.isCone ? { kind: 'cone' } : { kind: 'scoop', accent: scoopColor(scoop) }
  );
  refs.switcher.setAttribute('active', scoop.jid);
  const lockedEffort = localStorage.getItem('slicc_locked_effort_level');
  refs.composerMeta.setAttribute(
    'thinking',
    metaThinkingForScoop(
      (lockedEffort ?? scoop.config?.thinkingLevel) as ThinkingLevel | undefined,
      scoop.config?.effortOverride
    )
  );
  try {
    const { resolveCurrentModel, resolveModelById } = await import('../provider-settings.js');
    const modelId = scoop.config?.modelId;
    const model = modelId ? resolveModelById(modelId) : resolveCurrentModel();
    refs.composerMeta.setAttribute('model', model.name ?? model.id);
    // The thinking-effort pill only shows for a reasoning-capable model.
    // When locked, hide the pill entirely so the user cannot change it.
    refs.composerMeta.toggleAttribute(
      'no-thinking',
      (model as { reasoning?: boolean }).reasoning !== true || !!lockedEffort
    );
  } catch {
    // Model display is informational; never block scoop selection on it.
  }
}

interface FreezerRailDeps {
  refs: WcShellRefs;
  openVfs(): Promise<WcPageVfs>;
  client: OffscreenClient;
  getController(): WcChatController | null;
  getSelected(): RegisteredScoop | null;
  selectScoop(scoop: RegisteredScoop): void;
  clearSelection(): void;
  log: BootStageLogger;
}

/** Handles returned by {@link wireFreezerRail} for boot + URL routing. */
interface FreezerRailHandles {
  /** Re-read the frozen-session index and re-render the rail cards. */
  refreshFreezer(): void;
  /** Thaw a frozen session by archive filename (URL `ctx=freezer:<file>`). */
  openFrozen(slug: string): Promise<void>;
}

/**
 * Freezer rail behavior: frozen sessions thaw read-only into the thread,
 * and the "New +" gestures freeze/clear the cone (click = LLM-enriched
 * freeze, double-click = quick-freeze, long-press = erase). Returns the
 * card-refresh function for the post-boot initial fill plus the by-slug
 * thaw used by URL routing.
 */
function wireFreezerRail(deps: FreezerRailDeps): FreezerRailHandles {
  const { refs, openVfs, client, getController, getSelected, selectScoop, clearSelection, log } =
    deps;
  let frozenEntries: FrozenSessionIndexEntry[] = [];

  // Monotonic guard: boot fires several overlapping refreshes (attach-time,
  // scoop-list ready, kernel-worker-ready) and a lost early RPC fails LATE —
  // only the newest call may touch the rail, and faults never wipe it.
  let refreshSeq = 0;
  let iconEnriching = false;
  const refreshFreezer = (): void => {
    const seq = ++refreshSeq;
    void openVfs()
      .then(async ({ reader, writer }) => {
        let entries = await readFreezerEntries(reader);
        if (entries === null) {
          // Faults keep the rail; a CORRUPT index (e.g. truncated by a
          // reload that killed the worker mid-write) self-heals from the
          // archives — they are the ground truth.
          const state = await readFreezerIndexState(reader);
          if (state.kind !== 'corrupt') return;
          log.warn('WC freezer index corrupt — rebuilding from archives');
          entries = await rebuildFreezerIndexFromArchives(reader);
          if (entries.length === 0) return;
          await writer.writeFile(SESSIONS_INDEX_PATH, JSON.stringify(entries, null, 2));
        }
        if (seq !== refreshSeq) return;
        frozenEntries = entries;
        renderFreezerCards(refs.freezer, entries);
        // Backfill LLM-picked rail icons for icon-less entries (legacy /
        // quick-frozen). Fire-and-forget and single-flight — refreshes
        // re-fire on kernel-ready.
        if (!iconEnriching && entries.some((e) => !e.icon && !e.pendingEnrichment)) {
          iconEnriching = true;
          void import('../../providers/quick-llm.js')
            .then(({ pickLucideIcon }) =>
              enrichFreezerIcons({
                reader,
                writer,
                freezer: refs.freezer,
                entries,
                pickIcon: (subject) => pickLucideIcon({ subject }),
              })
            )
            .catch((err) => log.warn('WC freezer icon enrichment failed', err))
            .finally(() => {
              iconEnriching = false;
            });
        }
      })
      .catch((err) => log.error('WC freezer refresh failed', err));
  };

  // One new-session at a time: a re-click while the freeze is in flight used
  // to run a SECOND freeze (the stuck spinner invited it), leaving duplicate
  // archives seconds apart. The spinner is set here and always cleared —
  // the library only enters the busy state, it never exits it on its own.
  let newSessionInFlight = false;
  const freezerNew = (): HTMLElement | null => refs.freezer.querySelector('slicc-freezer-new');
  const runNewSession = (action: 'save' | 'skip' | 'erase'): void => {
    if (newSessionInFlight) return;
    newSessionInFlight = true;
    freezerNew()?.setAttribute('busy', '');
    void (async () => {
      try {
        // The freezer itself skips empty/short sessions (MIN_MESSAGES_TO_FREEZE),
        // so save/skip can always run it; erase intentionally never archives.
        if (action !== 'erase') {
          const { writer } = await openVfs();
          const { runNewSessionFreeze, runNewSessionFreezeQuick } = await import(
            '../new-session.js'
          );
          if (action === 'save') {
            // Write-first + race: the durable archive lands before any LLM
            // call, and this resolves at min(LLM-done, race window) so the
            // chat clears even if the provider is hung. The race timer drives
            // the spinner's progress ring; background enrichment (timer-won)
            // refreshes the rail when the late rename/icon land.
            await runNewSessionFreeze({
              vfs: writer,
              onProgress: (fraction) => {
                const el = freezerNew();
                if (!el) return;
                if (fraction === null) el.removeAttribute('progress');
                else el.setAttribute('progress', String(fraction));
              },
              onBackgroundEnriched: () => refreshFreezer(),
            });
          } else {
            // Quick-freeze: durable archive with heuristic title, no LLM
            // enrichment (the entry stays pending-*.md forever).
            await runNewSessionFreezeQuick({ vfs: writer });
          }
        }
        await client.clearAllMessages();
        // Clear the thread directly — re-selection only *requests* a replay,
        // and the worker no-ops the reply for a (now) empty history, which
        // left the old conversation on screen until the next reload.
        getController()?.loadMessages([]);
        // Re-arm the dictation priming note: the next dictated turn in the
        // fresh session must carry the one-time TTS context note again.
        void import('../../speech/dictation-priming.js')
          .then(({ resetDictationPriming }) => resetDictationPriming())
          .catch(() => undefined);
        refreshFreezer();
        const cone = client.getScoops().find((s) => s.isCone);
        if (cone) selectScoop(cone);
      } catch (err) {
        log.error('WC new session failed', err);
      } finally {
        newSessionInFlight = false;
        const el = freezerNew();
        el?.removeAttribute('busy');
        el?.removeAttribute('progress');
      }
    })();
  };
  for (const action of ['save', 'skip', 'erase'] as const) {
    refs.freezer.addEventListener(`new-chat-${action}`, () => runNewSession(action));
  }

  // By-slug thaw: re-reads the index when the rail hasn't populated yet (URL
  // routing at boot lands before the first card refresh resolves).
  const openFrozen = async (slug: string): Promise<void> => {
    try {
      const { reader } = await openVfs();
      let entry = frozenEntries.find((e) => e.filename === slug);
      if (!entry) {
        entry = ((await readFreezerEntries(reader)) ?? []).find((e) => e.filename === slug);
      }
      // The ARCHIVE is the ground truth: at boot a corrupt index (this deep
      // link races the rail's self-heal rebuild) used to dead-end here with
      // a blank shell — thaw straight from the named archive instead.
      const { messages } = await thawFrozenSession(
        reader,
        entry ?? { filename: slug, title: slug, frozenAt: '', messageCount: 0 }
      );
      // Set the thread context BEFORE loading messages (mirrors selectScoop's
      // applyThreadContext-before-load order): loadMessages runs the cone-gated
      // stale-asset replay, which must see `freezer:…` here — not a stale `cone`
      // from a prior view — so a thaw can never consume/replay a dropped turn.
      refs.thread.setAttribute('context', `freezer:${entry?.filename ?? slug}`);
      getController()?.loadMessages(messages);
      refs.thread.setAttribute('accent', FREEZER_TINT);
      // Frost mood: crystallizing shader + ice-blue accent across the frame.
      applyShellContext(refs, { kind: 'freezer' });
      refs.inputCard.setAttribute('disabled', '');
      refs.switcher.removeAttribute('active');
      clearSelection();
    } catch (err) {
      log.error('WC thaw failed', err);
      // A failed boot deep link must still land somewhere usable: with the
      // pending URL context already consumed, nothing else selects a scoop —
      // fall back to the cone rather than a dead empty shell.
      if (!getSelected()) {
        const cone = client.getScoops().find((s) => s.isCone);
        if (cone) selectScoop(cone);
      }
    }
  };

  refs.freezer.addEventListener('freezer-card-select', (event) => {
    const slug = (event as CustomEvent<{ slug?: string }>).detail?.slug;
    if (slug) void openFrozen(slug);
  });

  return { refreshFreezer, openFrozen };
}

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
  setActivateSurface(fn: (surfaceId: string) => void): void;
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
  let activateSurface: ((surfaceId: string) => void) | null = null;
  const refs = mountWcShell(app, {
    messages: [],
    scoops: [],
    floatLabel,
    placeholder: 'Ask sliccy, or describe a change…',
    onSurfaceActivate: (surfaceId) => activateSurface?.(surfaceId),
    // Live floats sync UI state with the URL: the thread owns `ctx`/`at`,
    // the shell owns `ws` — each component manages its own params.
    urlState: true,
  });

  let controller: WcChatController | null = null;
  let client: OffscreenClient | null = null;
  let selected: RegisteredScoop | null = null;
  let clientReady = false;
  const readyListeners = new Set<() => void>();

  const selectScoop = (scoop: RegisteredScoop): void => {
    selected = scoop;
    if (!client) return;
    // Scoop-switch queue-cancel: snapshot the OLD scoop's currently-queued
    // ids and cancel them on the backend BEFORE switching selectedScoopJid,
    // so the orchestrator never silently delivers a prompt the user dropped
    // by navigating to a different scoop. The controller's #queued is
    // dropped locally later via loadMessages; its onQueuedCancel hook then
    // fires against the NEW jid as defense-in-depth (a redundant per-id
    // delete is a no-op once the backend already removed it).
    const previousJid = client.selectedScoopJid;
    if (previousJid && previousJid !== scoop.jid) {
      const queued = controller?.getQueuedMessages() ?? [];
      for (const m of queued) {
        void client.deleteQueuedMessage(previousJid, m.id).catch(() => undefined);
      }
    }
    client.setSelectedScoopJid(scoop.jid);
    refs.inputCard.removeAttribute('disabled');
    void applyThreadContext(refs, scoop);
    client.requestScoopMessages(scoop.jid);
    controller?.setProcessing(client.isProcessing(scoop.jid));
    // Boot default for the navbar eyes: until any message/input lands, the
    // first-selected scoop wears them (selection itself is not "activity").
    if (!refs.switcher.hasAttribute('attention')) {
      refs.switcher.setAttribute('attention', scoop.jid);
    }
  };

  return {
    refs,
    wiring: {
      refs,
      statuses: new Map(),
      fills: new Map(),
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
    },
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
    setActivateSurface: (fn) => {
      activateSurface = fn;
      // The shell's connect-time URL restore (`ws` param) ran before the
      // activator existed — re-fire it so the restored surface lazily mounts.
      // Gate behind kernel ready: VFS RPCs (e.g. file tree load) need the
      // worker's VfsRpcHost to be attached, which only happens after host.ready.
      const active = refs.workbenchBody.getAttribute('active');
      if (active && refs.shell.hasAttribute('open')) {
        if (clientReady) fn(active);
        else readyListeners.add(() => fn(active));
      }
    },
    onClientReady: (fn) => {
      readyListeners.add(fn);
      if (clientReady) fn();
    },
  };
}

/** Mutable slot for the lazily-wired welcome-flow lick interceptor. */
export interface WelcomeInterceptHolder {
  intercept: ((event: LickEvent) => boolean) | null;
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

/** Controller + dip lifecycle over the live agent handle. */
function createWcController(
  refs: WcShellRefs,
  client: OffscreenClient,
  getSelected: () => RegisteredScoop | null,
  onIdle?: () => void,
  welcome?: WelcomeInterceptHolder
): { controller: WcChatController; agentHandle: ReturnType<OffscreenClient['createAgentHandle']> } {
  // Dip licks dispatch to the cone as the `inline` sprinkle (the legacy
  // onDipLick local path), AFTER the welcome-flow interceptor gets first
  // refusal — onboarding licks must never reach the keyless cone.
  const dipInstances = new Map<string, DipInstance[]>();
  void import('../legacy-styles.js')
    .then(({ loadDipStyles }) => loadDipStyles())
    .catch(() => undefined);
  // Keep open dips in step with the WC shell's live theme (the legacy
  // initTheme path that did this is never called in WC mode).
  void import('../theme.js')
    .then(({ watchSprinkleThemeBroadcast }) => watchSprinkleThemeBroadcast())
    .catch(() => undefined);
  // Apply persisted custom theme overrides (initTheme is never called in WC mode).
  void import('../theme-engine.js')
    .then(({ applyThemeOverrides }) => applyThemeOverrides())
    .catch(() => undefined);
  const agentHandle = client.createAgentHandle();
  // Soundscape cues for the selected scoop's tool lifecycle: tool_use_start →
  // 'tool-start', tool_result → 'tool-finish'. The cue helper itself gates on
  // the persisted enable flag, the voice-mode window (`beginVoiceTurn` from
  // the composer's dictated-submit handler), and the TTS-active flag — so
  // typed turns stay silent, the wiring just feeds events through.
  agentHandle.onEvent((event) => {
    if (event.type !== 'tool_use_start' && event.type !== 'tool_result') return;
    void import('../../speech/soundscape.js')
      .then(({ playCue }) =>
        playCue(event.type === 'tool_use_start' ? 'tool-start' : 'tool-finish')
      )
      .catch(() => undefined);
  });
  const controller = new WcChatController({
    thread: refs.thread,
    agent: agentHandle,
    // Operational telemetry — emit a `formsubmit` beacon per user-initiated
    // chat send carrying the active scoop name + resolved model id. Resolves
    // the same way `applyThreadContext` builds the composer meta pill so the
    // beacon agrees with what the user sees in the UI. Returns null when no
    // scoop is selected (boot race) so the beacon is skipped rather than
    // reporting a meaningless empty source.
    resolveTelemetryContext: () => {
      const scoop = getSelected();
      if (!scoop) return null;
      const scoopName = scoop.isCone ? 'cone' : scoop.name;
      try {
        const modelId = scoop.config?.modelId;
        const model = modelId ? resolveModelById(modelId) : resolveCurrentModel();
        return { scoopName, model: model.id };
      } catch {
        return { scoopName, model: '' };
      }
    },
    // Spoken-reply loop: a turn that began as push-to-talk dictation (the
    // submit listener marks it) gets its reply read aloud — kokoro once the
    // chained model download is warm, Web Speech until then. The one-shot
    // flag is consumed on EVERY turn completion (even reply-less ones, e.g.
    // the error path) so it can never linger and voice a later typed turn.
    // The soundscape's voice-mode window also closes here — TTS is flagged
    // active for the spoken-reply duration so any tail cues are suppressed,
    // and `endVoiceTurn` runs in a finally so an error path never pins the
    // voice gate open for later typed turns.
    onTurnComplete: (message) => {
      void import('../../speech/voice-reply.js')
        .then(async ({ consumeVoiceSubmission, speakReplyMarkdown }) => {
          if (!consumeVoiceSubmission()) return;
          const { endVoiceTurn, setTtsActive } = await import('../../speech/soundscape.js');
          try {
            if (message?.content) {
              setTtsActive(true);
              try {
                await speakReplyMarkdown(message.content);
              } finally {
                setTtsActive(false);
              }
            }
          } finally {
            endVoiceTurn();
          }
        })
        .catch(() => undefined);
    },
    onProcessingChange: (processing) => {
      refs.frame.toggleAttribute('data-processing', processing);
      refs.inputCard.querySelector('slicc-send-button')?.toggleAttribute('busy', processing);
      if (!processing) onIdle?.();
    },
    // Drive the send button's busy treatment from the turn's phase: `tool`
    // (spinning ring) while a tool call runs, `thinking` (LLM-wait fill)
    // otherwise. Only meaningful while the button is `busy`.
    onBusyPhaseChange: (phase) => {
      refs.inputCard.querySelector('slicc-send-button')?.setAttribute('phase', phase);
    },
    onMessageDisposed: (messageId) => {
      const instances = dipInstances.get(messageId);
      if (instances) {
        disposeDips(instances);
        dipInstances.delete(messageId);
      }
    },
    onMessageRendered: (message, els) => {
      const host = els[0];
      if (!host) return;
      // Register unconditionally — img-dip placeholders can be pushed
      // asynchronously into the array after the call returns.
      dipInstances.set(
        message.id,
        hydrateDips(host, (action, data) => {
          const event: LickEvent = {
            type: 'sprinkle',
            sprinkleName: 'inline',
            timestamp: new Date().toISOString(),
            body: { action, data },
          };
          if (welcome?.intercept?.(event)) return;
          client.sendSprinkleLick('inline', { action, data });
        })
      );
    },
    // Route the controller's queued list into the composer's stack. The
    // component is purely presentational (setMessages replaces the rendered
    // list); the controller owns enqueue / dismiss / flush-on-consume.
    onQueuedChange: (items) => {
      refs.queuedStack.setMessages(items);
    },
    // Agent-driven `tool_ui` dips (mount approval, USB/serial/HID
    // pickers) fire their `data-action` clicks through this hook —
    // forward straight into the worker realm where the request is
    // registered, otherwise the page-side `toolUIRegistry` (which is
    // empty in standalone worker mode) silently drops the action and
    // the tool hangs out its own timeout.
    onToolUiAction: (requestId, action, data) => {
      client.sendToolUiAction(requestId, action, data);
    },
    // Scoop switch / session reload drops the live-only stack. Route each
    // dropped id through the SAME backend cancel RPC the `×` dismiss uses
    // so the orchestrator never delivers a prompt the user implicitly
    // dropped by navigating away. Best-effort — a transient RPC failure
    // must not block the local UI from clearing.
    onQueuedCancel: (messageId) => {
      const jid = client.selectedScoopJid;
      if (!jid) return;
      void client.deleteQueuedMessage(jid, messageId).catch(() => undefined);
    },
  });
  // Local dismiss path: the `×` button on the stack's front card emits a
  // composed `slicc-queued-remove`; the controller drops the matching item
  // and re-fires `onQueuedChange` so the stack re-renders. The same id is
  // also dropped from the orchestrator's queue so the message never reaches
  // the agent on the next poll.
  refs.queuedStack.addEventListener('slicc-queued-remove', (event) => {
    const id = (event as CustomEvent<{ id?: string }>).detail?.id;
    if (!id) return;
    controller.removeQueuedMessage(id);
    const jid = client.selectedScoopJid;
    if (jid) {
      void client.deleteQueuedMessage(jid, id).catch(() => undefined);
    }
  });
  return { controller, agentHandle };
}

export interface AttachWcClientOptions {
  /** Standalone kernel-worker id; enables the sprinkle ops channel. */
  instanceId?: string;
  /** Standalone-only runtime bits enabling tray sync + panel RPC. */
  standalone?: {
    browser: BrowserAPI;
    realCdpTransport: CDPTransport;
    runtimeMode: UiRuntimeMode;
    /** Resolved floatbar base label (`sliccstart · live` / `npx · live`). */
    baseFloatLabel?: string;
  };
}

/**
 * Phase B: wire a connected client into the prepared shell — controller,
 * composer, switcher, workbench, freezer, sprinkles, and nav.
 */
/**
 * Composer wiring: suggested placeholder (turn-finished hook), the add-menu's
 * real search + staged attachments, submit/stop, and the thinking pill.
 */
function wireWcComposer(deps: {
  boot: WcShellBoot;
  client: OffscreenClient;
  agentHandle: ReturnType<OffscreenClient['createAgentHandle']>;
  setRefreshPlaceholder(fn: () => void): void;
  triggerPlaceholder(): void;
  openReader(): Promise<WcPageVfs['reader']>;
  openWriter(): Promise<WcPageVfs['writer']>;
  log: BootStageLogger;
}): { getAttachStage(): import('./wc-attach.js').WcAttachmentStage | null } {
  const { boot, client, agentHandle, openReader, log } = deps;
  const { refs } = boot;
  void import('./wc-placeholder.js').then(({ createPlaceholderRefresher }) => {
    deps.setRefreshPlaceholder(
      createPlaceholderRefresher({
        inputCard: refs.inputCard as HTMLElement & { value?: string },
        getMessages: () => boot.getController()?.getMessages() ?? [],
        defaultPlaceholder:
          refs.inputCard.getAttribute('placeholder') ?? 'Ask sliccy, or describe a change…',
      })
    );
  });

  // Hydrate the persisted cone conversation immediately — the worker's
  // canonical replay (request-scoop-messages on selection) replaces it.
  // Skipped when the URL deep-links a non-cone context: flashing the cone
  // history there would be wrong content.
  // Also skipped for cloud cone followers and cherry embeds — the leader's
  // snapshot replaces any local history, so showing stale IndexedDB messages
  // causes flicker.
  void (async () => {
    try {
      if (shouldSkipSessionHydration(boot.wiring.pendingUrlContext, window)) return;
      const { SessionStore } = await import('../session-store.js');
      const store = new SessionStore();
      await store.init();
      const session = await store.load('session-cone');
      if (session && session.messages.length > 0 && !boot.getSelected()) {
        boot.getController()?.loadMessages(session.messages);
        deps.triggerPlaceholder();
      }
    } catch (err) {
      log.warn('WC session hydration failed', err);
    }
  })();

  // Add-menu (+): real Files/Skills/Conversations search + staged attachments
  // (uploads, VFS picks, camera photos, screen captures).
  let attachStage: import('./wc-attach.js').WcAttachmentStage | null = null;
  void import('./wc-attach.js')
    .then(({ wireWcAttach }) => {
      attachStage = wireWcAttach({
        inputCard: refs.inputCard as HTMLElement & { value?: string },
        freezer: refs.freezer,
        // Camera capture mounts as a compact drop-target box inside the
        // composer band — mirrors the `<slicc-add-menu>` `.results` geometry.
        composer: refs.composer,
        openReader,
        openWriter: deps.openWriter,
        listConversations: async () => {
          const { readSessionsIndex } = await import('../session-freezer.js');
          const entries = await readSessionsIndex(await openReader());
          return entries.map((e) => ({
            id: e.filename,
            label: e.title,
            sub: `${e.messageCount} turns`,
          }));
        },
        log,
      });
    })
    .catch((err) => log.error('WC add-menu wiring failed', err));

  refs.inputCard.addEventListener('submit', (event) => {
    const text = submittedText(event);
    if (!text) return;
    // Dictated turns (push-to-talk) get their reply spoken back — mark
    // BEFORE sending so the turn-complete hook sees the flag. The same
    // flag drives the dictation markers the controller appends to the
    // sent text so the model knows the input was dictated.
    const dictation =
      (event as Event as CustomEvent<{ source?: string }>).detail?.source === 'dictation';
    if (dictation) {
      void import('../../speech/voice-reply.js')
        .then(({ markVoiceSubmission }) => markVoiceSubmission())
        .catch(() => undefined);
      // Soundscape: open the voice-mode window and play the message-sent
      // cue. `beginVoiceTurn` runs BEFORE `playCue('sent')` so the cue's
      // own voice-turn gate passes; `endVoiceTurn` closes it in the
      // turn-complete hook above.
      void import('../../speech/soundscape.js')
        .then(({ beginVoiceTurn, playCue }) => {
          beginVoiceTurn();
          playCue('sent');
        })
        .catch(() => undefined);
    }
    boot.getController()?.sendUserMessage(text, attachStage?.take(), { dictation });
    (refs.inputCard as HTMLElement & { clear?: () => void }).clear?.();
    // User input is most-recent activity: the addressed scoop gets the eyes
    // and the text feeds its hover-tooltip summary.
    const jid = boot.getSelected()?.jid;
    if (jid) {
      refs.switcher.setAttribute('attention', jid);
      boot.wiring.lastActivity.set(jid, text.slice(0, 600));
    }
  });

  // The send button morphs into a stop control while a turn is processing.
  refs.inputCard.addEventListener('stop', () => {
    if (boot.getController()?.processing) agentHandle.stop();
  });

  // ArrowUp/ArrowDown in the composer walk the thread's user messages.
  void import('./wc-history-nav.js')
    .then(({ wireWcHistoryNav }) =>
      wireWcHistoryNav({ thread: refs.thread, inputCard: refs.inputCard })
    )
    .catch((err) => log.error('WC history nav wiring failed', err));

  // Brain pill: cycle the scoop's thinking level (persisted by the worker).
  refs.composerMeta.addEventListener('thinking-change', (event) => {
    if (localStorage.getItem('slicc_locked_effort_level')) return;
    const metaLevel = (event as CustomEvent<{ thinking?: string }>).detail?.thinking;
    const level = thinkingLevelForAgent(metaLevel);
    const effort = effortOverrideForAgent(metaLevel);
    const selected = boot.getSelected();
    if (selected && level) client.setScoopThinkingLevel(selected.jid, level, effort);
  });

  return { getAttachStage: () => attachStage };
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
        wiring.fills
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

/** Switcher wiring: chip clicks select scoops; hovered chips get LLM tooltips. */
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
    deps.refreshStats();
    const jid = deps.boot.getSelected()?.jid;
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
 * Richer scoop/cone hover tooltips: pointing at a chip sets a one-line LLM
 * summary of that agent's most recent activity as the chip's native title.
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
    const chip = (event.target as HTMLElement | null)?.closest?.<HTMLElement>('slicc-pill.scoop');
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
    if (!chip.title) chip.title = scoop.isCone ? 'sliccy' : scoop.name;
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
            `Agent: ${scoop.isCone ? 'sliccy (the main agent)' : scoop.name}\n` +
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
  (globalThis as Record<string, unknown>).__slicc_terminal_view = view;
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
    const scoops = client.getScoops();
    const scoop = ctx.startsWith('scoop:')
      ? scoops.find((s) => !s.isCone && s.name === ctx.slice('scoop:'.length))
      : scoops.find((s) => s.isCone);
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

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: boot wiring is sequential; extracting more helpers would obscure the order
export function attachWcClient(
  boot: WcShellBoot,
  client: OffscreenClient,
  log: BootStageLogger,
  options: AttachWcClientOptions = {}
): void {
  // Apply persisted timestamp visibility preference (both standalone + extension).
  void import('../timestamp-preference.js')
    .then(({ initTimestampPreference }) => initTimestampPreference())
    .catch(() => undefined);
  const { refs } = boot;
  boot.setClient(client);
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
  // surface activation from the dock or tab bar.
  boot.setActivateSurface(
    createWorkbenchActivator({
      fileTree: refs.fileTree,
      termSurface: refs.termSurface,
      memoryHost: refs.memoryHost,
      monitor: refs.monitor,
      openFs: openReader,
      openWriter: async () => (await openVfs()).writer,
      onKernelReady: (fn) => boot.onClientReady(fn),
      getMonitorDeps: () => ({
        getScoops: () => client.getScoops(),
        isProcessing: (jid: string) => client.isProcessing(jid),
        getCronTasks: async () => {
          const { getAllCronTasks } = await import('../../scoops/db.js');
          return getAllCronTasks();
        },
        getWebhooks: async () => {
          const { getAllWebhooks } = await import('../../scoops/db.js');
          return getAllWebhooks();
        },
        getMounts: async () => {
          const { getAllMountEntries } = await import('../../fs/mount-table-store.js');
          return getAllMountEntries();
        },
        getMcpServers: async () => {
          try {
            const fs = await openReader();
            const raw = await fs.readFile('/workspace/.mcp/servers.json', { encoding: 'utf-8' });
            const parsed = JSON.parse(
              typeof raw === 'string' ? raw : new TextDecoder().decode(raw)
            );
            return parsed.servers ?? {};
          } catch {
            return {};
          }
        },
        getOAuthProviders: () => {
          try {
            const raw = localStorage.getItem('slicc_accounts');
            if (!raw) return [];
            const accounts = JSON.parse(raw);
            if (!Array.isArray(accounts)) return [];
            const providerIds = accounts
              .map((a: { providerId?: string }) => a.providerId)
              .filter((id): id is string => typeof id === 'string');
            return [...new Set(providerIds)];
          } catch {
            return [];
          }
        },
        getSessionStats: async () => client.getSessionStats?.() ?? null,
        getProcesses: async () => {
          try {
            const fs = await openReader();
            const entries = await fs.readDir('/proc');
            const procs = [];
            for (const entry of entries.filter(
              (e) => e.type === 'directory' && /^\d+$/.test(e.name)
            )) {
              try {
                const status = await fs.readFile(`/proc/${entry.name}/status`, {
                  encoding: 'utf-8',
                });
                const cmdline = await fs.readFile(`/proc/${entry.name}/cmdline`, {
                  encoding: 'utf-8',
                });
                procs.push({
                  pid: parseInt(entry.name, 10),
                  argv: String(cmdline).trim(),
                  status: String(status).trim(),
                });
              } catch {
                /* process may have exited */
              }
            }
            return procs;
          } catch {
            return [];
          }
        },
      }),
      mountTerminal: (container) => mountWorkbenchTerminal(boot, client, container),
      insertReference: (path: string) => {
        const card = refs.inputCard as HTMLElement & { value: string; focus(): void };
        const current = card.value.trim();
        card.value = current ? `${current} @${path}` : `@${path}`;
        card.focus();
      },
      log,
    })
  );
  // Floatbar click toggles the monitor tab
  refs.floatbar.addEventListener('click', () => {
    const isOpen =
      refs.shell.hasAttribute('open') && refs.workbenchBody.getAttribute('active') === 'monitor';
    if (isOpen) {
      refs.shell.removeAttribute('open');
      refs.dock.removeAttribute('active');
    } else {
      (refs.dock as HTMLElement & { selectItem(id: string): void }).selectItem('monitor');
    }
  });

  // Freezer rail: frozen cone sessions thaw read-only into the thread;
  // selecting any scoop chip returns to the live conversation.
  const { refreshFreezer, openFrozen } = wireFreezerRail({
    refs,
    openVfs,
    client,
    getController: () => boot.getController(),
    getSelected: () => boot.getSelected(),
    selectScoop: boot.selectScoop,
    clearSelection: boot.clearSelection,
    log,
  });
  // The boot-time refresh races the worker's VfsRpcHost installation (a lost
  // request hangs silently) — re-run once the kernel reports ready.
  refreshFreezer();
  boot.onClientReady(refreshFreezer);

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
      const { wireWcSprinkles } = await import('./wc-sprinkles.js');
      const sprinkles = await wireWcSprinkles({
        refs,
        client,
        fs: createRemoteSprinkleVfs({ reader, writer }),
        instanceId: options.instanceId,
        onAttachImage: makeSprinkleAttachImage(composer, log),
        log,
      });
      // The wire-up-time discovery/restore races the worker's VfsRpcHost
      // installation (a lost RPC fails 30s late) — re-run on kernel-ready,
      // same recovery the freezer rail uses. resync() is idempotent.
      boot.onClientReady(() => void sprinkles.resync());
      if (options.standalone && options.instanceId) {
        const { wireWcTray } = await import('./wc-tray.js');
        const zoneCallbacks = sprinkles.zone.callbacks();
        await wireWcTray({
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
          baseFloatLabel: options.standalone.baseFloatLabel,
          window,
          log,
        });
      }
    })
    .catch((err) => log.error('WC sprinkle/tray wiring failed', err));

  // Nav: model picker + avatar menu (settings dialog, legacy-UI escape hatch).
  void import('./wc-nav.js')
    .then(({ wireWcNav }) => wireWcNav({ refs, client, log }))
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

  // The floatbar names the serving runtime, not just "standalone": the
  // native Sliccstart server vs the Node CLI, fingerprinted via /api/status.
  const { resolveStandaloneFloatLabel, DEFAULT_STANDALONE_LABEL } = await import(
    './wc-float-label.js'
  );
  const floatLabel =
    runtimeMode === 'standalone' || runtimeMode === 'electron-overlay'
      ? await resolveStandaloneFloatLabel()
      : DEFAULT_STANDALONE_LABEL;

  const boot = prepareWcShell(app, floatLabel);
  // #1330: install the reload listener BEFORE spawning — BroadcastChannel doesn't
  // buffer and the worker posts init synchronously, so a late listener would miss
  // a fast boot-time failure.
  if (instanceId) installWorkerStaleAssetReloadListener(instanceId);
  const host = spawnKernelWorker({
    realCdpTransport,
    instanceId,
    callbacks: createWcLiveCallbacks(boot.wiring),
    localApiBaseUrl,
    bridgeToken,
    localLickWsUrl,
    extensionDelegateId,
    onWorkerScriptError: () => {
      guardedReload();
    },
  });
  installPageStorageSync({ send: (m) => host.client.sendRaw(m) });
  // Extension-leader path only: late-bind the now-minted kernel client into the
  // extension-bridge `onLick` handler so forwarded handoff/upskill licks reach
  // the worker `LickManager`. No-op on every other CDP path.
  attachLickForwardingClient?.(host.client);
  attachWcClient(boot, host.client, log, {
    instanceId,
    standalone: {
      browser,
      realCdpTransport,
      runtimeMode,
      baseFloatLabel: floatLabel,
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
}
