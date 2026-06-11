/**
 * Live boot for the WC shell (`?ui=wc`): spawns the kernel worker directly —
 * no legacy `Layout` — and wires its callbacks onto a `WcChatController` and
 * the shell's scoop switcher. Phase 1 scope is the conversation loop:
 * composer → orchestrator prompt, agent events → thread, scoop switching.
 * Sprinkles, terminal, onboarding, tray, and sudo approvals still live only
 * in the legacy UI.
 */

import type { BrowserAPI, CDPTransport } from '../../cdp/index.js';
import { spawnKernelWorker } from '../../kernel/spawn.js';
import type { RegisteredScoop, ThinkingLevel } from '../../scoops/types.js';
import { setupStandalonePrelude } from '../boot/setup-standalone-prelude.js';
import type { BootStageLogger } from '../boot/types.js';
import { type DipInstance, disposeDips, hydrateDips } from '../dip.js';
import { isLickChannel } from '../lick-channels.js';
import type { OffscreenClient, OffscreenClientCallbacks } from '../offscreen-client.js';
import type { UiRuntimeMode } from '../runtime-mode.js';
import type { ChatMessage } from '../types.js';
import { WcChatController } from './wc-chat-controller.js';
import {
  FREEZER_TINT,
  type FrozenSessionIndexEntry,
  readFreezerEntries,
  renderFreezerCards,
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

const CONE_COLOR = '#b07823';
const SCOOP_PALETTE = ['#06b6d4', '#8b5cf6', '#f59e0b', '#10b981', '#3b82f6', '#ef4444'];

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

export function metaThinkingForScoop(level: ThinkingLevel | undefined): string {
  return (level && META_FROM_PI[level]) ?? 'off';
}

/** Stable palette pick for a scoop chip, keyed by name. */
export function scoopColor(scoop: Pick<RegisteredScoop, 'isCone' | 'name'>): string {
  if (scoop.isCone) return CONE_COLOR;
  let hash = 0;
  for (const ch of scoop.name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return SCOOP_PALETTE[hash % SCOOP_PALETTE.length];
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
    onIncomingMessage: (jid, message) => {
      // Most-recent-activity tracking: the scoop that just received a message
      // wears the blinking navbar eyes (the switcher's `attention` chip).
      wiring.refs.switcher.setAttribute('attention', jid);
      if (wiring.getSelected()?.jid !== jid) return;
      if (message.channel !== 'web' && isLickChannel(message.channel)) {
        wiring
          .getController()
          ?.addLickMessage(
            message.id,
            message.content,
            message.channel,
            new Date(message.timestamp).getTime()
          );
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
  refs.composerMeta.setAttribute('thinking', metaThinkingForScoop(scoop.config?.thinkingLevel));
  try {
    const { resolveCurrentModel, resolveModelById } = await import('../provider-settings.js');
    const modelId = scoop.config?.modelId;
    const model = modelId ? resolveModelById(modelId) : resolveCurrentModel();
    refs.composerMeta.setAttribute('model', model.name ?? model.id);
  } catch {
    // Model display is informational; never block scoop selection on it.
  }
}

interface FreezerRailDeps {
  refs: WcShellRefs;
  openVfs(): Promise<WcPageVfs>;
  client: OffscreenClient;
  getController(): WcChatController | null;
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
  const { refs, openVfs, client, getController, selectScoop, clearSelection, log } = deps;
  let frozenEntries: FrozenSessionIndexEntry[] = [];

  // Monotonic guard: boot fires several overlapping refreshes (attach-time,
  // scoop-list ready, kernel-worker-ready) and a lost early RPC fails LATE —
  // only the newest call may touch the rail, and faults never wipe it.
  let refreshSeq = 0;
  const refreshFreezer = (): void => {
    const seq = ++refreshSeq;
    void openVfs()
      .then(async ({ reader }) => {
        const entries = await readFreezerEntries(reader);
        if (entries === null || seq !== refreshSeq) return;
        frozenEntries = entries;
        renderFreezerCards(refs.freezer, entries);
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
          if (action === 'save') await runNewSessionFreeze({ vfs: writer });
          else await runNewSessionFreezeQuick({ vfs: writer });
        }
        await client.clearAllMessages();
        // Clear the thread directly — re-selection only *requests* a replay,
        // and the worker no-ops the reply for a (now) empty history, which
        // left the old conversation on screen until the next reload.
        getController()?.loadMessages([]);
        refreshFreezer();
        const cone = client.getScoops().find((s) => s.isCone);
        if (cone) selectScoop(cone);
      } catch (err) {
        log.error('WC new session failed', err);
      } finally {
        newSessionInFlight = false;
        freezerNew()?.removeAttribute('busy');
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
      if (!entry) return;
      const { messages } = await thawFrozenSession(reader, entry);
      getController()?.loadMessages(messages);
      refs.thread.setAttribute('context', `freezer:${entry.filename}`);
      refs.thread.setAttribute('accent', FREEZER_TINT);
      // Frost mood: crystallizing shader + ice-blue accent across the frame.
      applyShellContext(refs, { kind: 'freezer' });
      refs.inputCard.setAttribute('disabled', '');
      refs.switcher.removeAttribute('active');
      clearSelection();
    } catch (err) {
      log.error('WC thaw failed', err);
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
      const active = refs.workbenchBody.getAttribute('active');
      if (active && refs.shell.hasAttribute('open')) fn(active);
    },
    onClientReady: (fn) => {
      readyListeners.add(fn);
      if (clientReady) fn();
    },
  };
}

/** Controller + dip lifecycle over the live agent handle. */
function createWcController(
  refs: WcShellRefs,
  client: OffscreenClient,
  onIdle?: () => void
): { controller: WcChatController; agentHandle: ReturnType<OffscreenClient['createAgentHandle']> } {
  // Dip licks dispatch to the cone as the `inline` sprinkle (the legacy
  // onDipLick local path — welcome-flow interception and follower
  // forwarding are not wired in WC mode yet).
  const dipInstances = new Map<string, DipInstance[]>();
  void import('../legacy-styles.js')
    .then(({ loadDipStyles }) => loadDipStyles())
    .catch(() => undefined);
  const agentHandle = client.createAgentHandle();
  const controller = new WcChatController({
    thread: refs.thread,
    agent: agentHandle,
    onProcessingChange: (processing) => {
      refs.frame.toggleAttribute('data-processing', processing);
      refs.inputCard.querySelector('slicc-send-button')?.toggleAttribute('busy', processing);
      if (!processing) onIdle?.();
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
          client.sendSprinkleLick('inline', { action, data });
        })
      );
    },
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
    cherryJoinUrl?: string;
    cherryTransport?: import('../../cdp/cherry-host-transport.js').CherryHostTransport;
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
}): void {
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
  void (async () => {
    try {
      const pending = boot.wiring.pendingUrlContext;
      if (pending != null && pending !== 'cone') return;
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
    boot.getController()?.sendUserMessage(text, attachStage?.take());
    (refs.inputCard as HTMLElement & { clear?: () => void }).clear?.();
    // User input is most-recent activity: the addressed scoop gets the eyes.
    const jid = boot.getSelected()?.jid;
    if (jid) refs.switcher.setAttribute('attention', jid);
  });

  // The send button morphs into a stop control while a turn is processing.
  refs.inputCard.addEventListener('stop', () => {
    if (boot.getController()?.processing) agentHandle.stop();
  });

  // Brain pill: cycle the scoop's thinking level (persisted by the worker).
  refs.composerMeta.addEventListener('thinking-change', (event) => {
    const metaLevel = (event as CustomEvent<{ thinking?: string }>).detail?.thinking;
    const level = thinkingLevelForAgent(metaLevel);
    const selected = boot.getSelected();
    if (selected && level) client.setScoopThinkingLevel(selected.jid, level);
  });
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

export function attachWcClient(
  boot: WcShellBoot,
  client: OffscreenClient,
  log: BootStageLogger,
  options: AttachWcClientOptions = {}
): void {
  const { refs } = boot;
  boot.setClient(client);
  // Turn-finished hooks: the suggested composer placeholder (assigned by
  // wireWcComposer once its module loads) + a stats refresh.
  let refreshPlaceholder: (() => void) | null = null;
  const refreshStats = wireWcStats(boot.wiring, client);
  const triggerPlaceholder = (): void => {
    refreshPlaceholder?.();
  };
  const { controller, agentHandle } = createWcController(refs, client, () => {
    triggerPlaceholder();
    refreshStats();
    // A finished turn = the selected scoop just received an agent message.
    const jid = boot.getSelected()?.jid;
    if (jid) refs.switcher.setAttribute('attention', jid);
  });
  boot.setController(controller);
  boot.onClientReady(refreshStats);

  // Page-side VFS: the worker owns the (OPFS) filesystem — page reads and
  // writes route through its VfsRpcHost. Opening OPFS from the page would
  // fight the worker's exclusive sync-access handles.
  let vfsPromise: Promise<WcPageVfs> | null = null;
  const openVfs = (): Promise<WcPageVfs> => {
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
  const openReader = async (): Promise<WcPageVfs['reader']> => (await openVfs()).reader;

  wireWcComposer({
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

  refs.switcher.addEventListener('slicc-scoop-select', (event) => {
    const key = (event as CustomEvent<{ key?: string }>).detail?.key;
    const scoop = client.getScoops().find((s) => s.jid === key);
    if (scoop && scoop.jid !== boot.getSelected()?.jid) boot.selectScoop(scoop);
  });

  // Workbench: VFS file tree + worker-shell terminal, both lazy on first
  // surface activation from the dock or tab bar.
  boot.setActivateSurface(
    createWorkbenchActivator({
      fileTree: refs.fileTree,
      termSurface: refs.termSurface,
      memoryHost: refs.memoryHost,
      openFs: openReader,
      mountTerminal: async (container) => {
        const { RemoteTerminalView } = await import('../../kernel/remote-terminal-view.js');
        const { fetchSecretEnvVars } = await import('../../core/secret-env.js');
        const env = await fetchSecretEnvVars();
        const view = new RemoteTerminalView({
          client,
          cwd: '/',
          env: Object.keys(env).length > 0 ? env : undefined,
        });
        await view.mount(container);
        window.addEventListener('beforeunload', () => view.dispose(), { once: true });
      },
      log,
    })
  );

  // Freezer rail: frozen cone sessions thaw read-only into the thread;
  // selecting any scoop chip returns to the live conversation.
  const { refreshFreezer, openFrozen } = wireFreezerRail({
    refs,
    openVfs,
    client,
    getController: () => boot.getController(),
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
          cherryJoinUrl: options.standalone.cherryJoinUrl,
          cherryTransport: options.standalone.cherryTransport,
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

  // Voice: mic toggle in the composer-meta row (Web Speech API, Chromium).
  void import('./wc-voice.js')
    .then(({ wireWcVoice }) =>
      wireWcVoice({ refs, send: (text) => boot.getController()?.sendUserMessage(text), log })
    )
    .catch((err) => log.error('WC voice wiring failed', err));
}

/** Boot the standalone live WC shell: prelude → kernel spawn → attach. */
export async function mountWcUiLive(
  app: HTMLElement,
  log: BootStageLogger,
  runtimeMode: UiRuntimeMode = 'standalone'
): Promise<void> {
  const { browser, realCdpTransport, instanceId, cherryJoinUrl, cherryTransport } =
    await setupStandalonePrelude({
      runtimeMode,
      envBaseUrl: import.meta.env.VITE_WORKER_BASE_URL ?? null,
      window,
      log,
    });

  const boot = prepareWcShell(app, 'standalone · live');
  const { createMigrationSplash } = await import('../migration-splash.js');
  let migrationSplash: ReturnType<typeof createMigrationSplash> | null = null;
  const ensureSplash = (): void => {
    if (!migrationSplash) {
      migrationSplash = createMigrationSplash({ root: document.body, logger: log });
      migrationSplash.arm();
    }
  };
  const disarmSplash = (): void => {
    migrationSplash?.disarm();
  };
  const host = spawnKernelWorker({
    realCdpTransport,
    instanceId,
    onMigrationStart: ensureSplash,
    onMigrationProgress: (progress) => {
      ensureSplash();
      migrationSplash?.updateProgress(progress);
    },
    onMigrationFinish: disarmSplash,
    callbacks: createWcLiveCallbacks(boot.wiring),
  });
  attachWcClient(boot, host.client, log, {
    instanceId,
    standalone: { browser, realCdpTransport, runtimeMode, cherryJoinUrl, cherryTransport },
  });

  const { setupSudoStandalone } = await import('../boot/setup-sudo.js');
  await setupSudoStandalone({ log });

  await host.ready;
  disarmSplash();
  // `host.ready` resolves on `kernel-worker-ready`, which the worker posts
  // AFTER its VfsRpcHost attaches — unlike the first scoop-list (the
  // callbacks' onReady), which fires mid-boot while VFS RPCs still fan out
  // into nobody. Re-notify so boot reads (freezer rail) finally land.
  boot.wiring.notifyReady?.();
  log.info('WC live shell ready', { scoops: host.client.getScoops().length });
}
