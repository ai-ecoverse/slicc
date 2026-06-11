/**
 * Live boot for the WC shell (`?ui=wc`): spawns the kernel worker directly —
 * no legacy `Layout` — and wires its callbacks onto a `WcChatController` and
 * the shell's scoop switcher. Phase 1 scope is the conversation loop:
 * composer → orchestrator prompt, agent events → thread, scoop switching.
 * Sprinkles, terminal, onboarding, tray, and sudo approvals still live only
 * in the legacy UI.
 */

import { spawnKernelWorker } from '../../kernel/spawn.js';
import type { RegisteredScoop, ThinkingLevel } from '../../scoops/types.js';
import { setupStandalonePrelude } from '../boot/setup-standalone-prelude.js';
import type { BootStageLogger } from '../boot/types.js';
import { type DipInstance, disposeDips, hydrateDips } from '../dip.js';
import { isLickChannel } from '../lick-channels.js';
import type { OffscreenClient, OffscreenClientCallbacks } from '../offscreen-client.js';
import type { ChatMessage } from '../types.js';
import { WcChatController } from './wc-chat-controller.js';
import {
  FREEZER_TINT,
  type FrozenSessionIndexEntry,
  refreshFreezerCards,
  thawFrozenSession,
} from './wc-freezer.js';
import { mountWcShell, type SwitcherScoop, submittedText, type WcShellRefs } from './wc-shell.js';
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
  statuses?: ReadonlyMap<string, ScoopStatus>
): SwitcherScoop[] {
  return [...scoops]
    .sort((a, b) => Number(b.isCone) - Number(a.isCone))
    .map((scoop) => ({
      key: scoop.jid,
      type: scoop.isCone ? 'cone' : 'scoop',
      color: scoopColor(scoop),
      label: scoop.isCone ? 'sliccy' : scoop.name,
      eyes: eyesFor(statuses?.get(scoop.jid)),
    }));
}

export interface WcLiveWiring {
  refs: WcShellRefs;
  /** Live per-scoop status, written by the callbacks on every broadcast. */
  statuses: Map<string, ScoopStatus>;
  getController(): WcChatController | null;
  getClient(): OffscreenClient | null;
  getSelected(): RegisteredScoop | null;
  selectScoop(scoop: RegisteredScoop): void;
}

/**
 * Kernel callbacks for the WC live shell. Pure factory over the wiring
 * handle so tests can drive it with fakes — no worker required.
 */
export function createWcLiveCallbacks(wiring: WcLiveWiring): OffscreenClientCallbacks {
  const refreshScoops = (): void => {
    const client = wiring.getClient();
    if (client) {
      wiring.refs.switcher.scoops = toSwitcherScoops(client.getScoops(), wiring.statuses);
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
      if (!wiring.getSelected()) wiring.selectScoop(scoop);
    },
    onScoopListUpdate: () => refreshScoops(),
    onIncomingMessage: (jid, message) => {
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
      const client = wiring.getClient();
      refreshScoops();
      const cone = client?.getScoops().find((s) => s.isCone);
      if (cone && !wiring.getSelected()) wiring.selectScoop(cone);
    },
  };
}

/** Point the thread chrome at a scoop (context label + accent hue + model). */
async function applyThreadContext(refs: WcShellRefs, scoop: RegisteredScoop): Promise<void> {
  refs.thread.setAttribute('context', scoop.isCone ? 'cone' : `scoop:${scoop.name}`);
  refs.thread.setAttribute('accent', scoopColor(scoop));
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
  openFs(): Promise<import('../../fs/virtual-fs.js').VirtualFS>;
  client: OffscreenClient;
  getController(): WcChatController | null;
  selectScoop(scoop: RegisteredScoop): void;
  clearSelection(): void;
  log: BootStageLogger;
}

/**
 * Freezer rail behavior: frozen sessions thaw read-only into the thread,
 * and the "New +" gestures freeze/clear the cone (click = LLM-enriched
 * freeze, double-click = quick-freeze, long-press = erase). Returns the
 * card-refresh function for the post-boot initial fill.
 */
function wireFreezerRail(deps: FreezerRailDeps): () => void {
  const { refs, openFs, client, getController, selectScoop, clearSelection, log } = deps;
  let frozenEntries: FrozenSessionIndexEntry[] = [];

  const refreshFreezer = (): void => {
    void openFs()
      .then(async (fs) => {
        frozenEntries = await refreshFreezerCards(refs.freezer, fs);
      })
      .catch((err) => log.error('WC freezer refresh failed', err));
  };

  const runNewSession = (action: 'save' | 'skip' | 'erase'): void => {
    void (async () => {
      try {
        const fs = await openFs();
        const { runNewSessionFreeze, runNewSessionFreezeQuick } = await import('../new-session.js');
        if (action === 'save') await runNewSessionFreeze({ vfs: fs });
        else if (action === 'skip') await runNewSessionFreezeQuick({ vfs: fs });
        await client.clearAllMessages();
        refreshFreezer();
        const cone = client.getScoops().find((s) => s.isCone);
        if (cone) selectScoop(cone);
      } catch (err) {
        log.error('WC new session failed', err);
      }
    })();
  };
  for (const action of ['save', 'skip', 'erase'] as const) {
    refs.freezer.addEventListener(`new-chat-${action}`, () => runNewSession(action));
  }

  refs.freezer.addEventListener('freezer-card-select', (event) => {
    const slug = (event as CustomEvent<{ slug?: string }>).detail?.slug;
    const entry = frozenEntries.find((e) => e.filename === slug);
    if (!entry) return;
    void openFs()
      .then(async (fs) => {
        const { messages } = await thawFrozenSession(fs, entry);
        getController()?.loadMessages(messages);
        refs.thread.setAttribute('context', `freezer:${entry.filename}`);
        refs.thread.setAttribute('accent', FREEZER_TINT);
        refs.inputCard.setAttribute('disabled', '');
        refs.switcher.removeAttribute('active');
        clearSelection();
      })
      .catch((err) => log.error('WC thaw failed', err));
  });

  return refreshFreezer;
}

/** Boot the live WC shell: prelude → kernel spawn → controller wiring. */
export async function mountWcUiLive(app: HTMLElement, log: BootStageLogger): Promise<void> {
  const { realCdpTransport, instanceId } = await setupStandalonePrelude({
    runtimeMode: 'standalone',
    envBaseUrl: import.meta.env.VITE_WORKER_BASE_URL ?? null,
    window,
    log,
  });

  let activateSurface: ((surfaceId: string) => void) | null = null;
  const refs = mountWcShell(app, {
    messages: [],
    scoops: [],
    floatLabel: 'standalone · live',
    placeholder: 'Ask sliccy, or describe a change…',
    onSurfaceActivate: (surfaceId) => activateSurface?.(surfaceId),
  });

  let controller: WcChatController | null = null;
  let client: OffscreenClient | null = null;
  let selected: RegisteredScoop | null = null;

  const selectScoop = (scoop: RegisteredScoop): void => {
    selected = scoop;
    if (!client) return;
    client.setSelectedScoopJid(scoop.jid);
    refs.inputCard.removeAttribute('disabled');
    void applyThreadContext(refs, scoop);
    client.requestScoopMessages(scoop.jid);
    controller?.setProcessing(client.isProcessing(scoop.jid));
  };

  const wiring: WcLiveWiring = {
    refs,
    statuses: new Map(),
    getController: () => controller,
    getClient: () => client,
    getSelected: () => selected,
    selectScoop,
  };

  const host = spawnKernelWorker({
    realCdpTransport,
    instanceId,
    callbacks: createWcLiveCallbacks(wiring),
  });
  client = host.client;

  // Inline dips: assistant ```shtml blocks hydrate into sandboxed iframes on
  // each stable message render; dip licks dispatch to the cone as the
  // `inline` sprinkle (the legacy onDipLick local path — welcome-flow
  // interception and follower forwarding are not wired in WC mode yet).
  const liveClientForDips = client;
  const dipInstances = new Map<string, DipInstance[]>();
  const agentHandle = client.createAgentHandle();
  controller = new WcChatController({
    thread: refs.thread,
    agent: agentHandle,
    onProcessingChange: (processing) => {
      refs.frame.toggleAttribute('data-processing', processing);
      refs.inputCard.querySelector('slicc-send-button')?.toggleAttribute('busy', processing);
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
          liveClientForDips.sendSprinkleLick('inline', { action, data });
        })
      );
    },
  });

  refs.inputCard.addEventListener('submit', (event) => {
    const text = submittedText(event);
    if (text) controller?.sendUserMessage(text);
  });

  // The send button morphs into a stop control while a turn is processing.
  refs.inputCard.addEventListener('stop', () => {
    if (controller?.processing) agentHandle.stop();
  });

  // Brain pill: cycle the scoop's thinking level (persisted by the worker).
  refs.composerMeta.addEventListener('thinking-change', (event) => {
    const metaLevel = (event as CustomEvent<{ thinking?: string }>).detail?.thinking;
    const level = thinkingLevelForAgent(metaLevel);
    if (selected && client && level) client.setScoopThinkingLevel(selected.jid, level);
  });

  refs.switcher.addEventListener('slicc-scoop-select', (event) => {
    const key = (event as CustomEvent<{ key?: string }>).detail?.key;
    const scoop = client?.getScoops().find((s) => s.jid === key);
    if (scoop && scoop.jid !== selected?.jid) selectScoop(scoop);
  });

  // Workbench: VFS file tree + worker-shell terminal, both lazy on first
  // surface activation from the dock or tab bar.
  let fsPromise: ReturnType<typeof openPageFs> | null = null;
  const openFs = (): ReturnType<typeof openPageFs> => {
    fsPromise ??= openPageFs();
    return fsPromise;
  };
  const liveClient = client;
  activateSurface = createWorkbenchActivator({
    fileTree: refs.fileTree,
    termSurface: refs.termSurface,
    memoryHost: refs.memoryHost,
    openFs,
    mountTerminal: async (container) => {
      const { RemoteTerminalView } = await import('../../kernel/remote-terminal-view.js');
      const { fetchSecretEnvVars } = await import('../../core/secret-env.js');
      const env = await fetchSecretEnvVars();
      const view = new RemoteTerminalView({
        client: liveClient,
        cwd: '/',
        env: Object.keys(env).length > 0 ? env : undefined,
      });
      await view.mount(container);
      window.addEventListener('beforeunload', () => view.dispose(), { once: true });
    },
    log,
  });

  // Freezer rail: frozen cone sessions thaw read-only into the thread;
  // selecting any scoop chip returns to the live conversation.
  const refreshFreezer = wireFreezerRail({
    refs,
    openFs,
    client: liveClient,
    getController: () => controller,
    selectScoop,
    clearSelection: () => {
      selected = null;
    },
    log,
  });

  await host.ready;
  refreshFreezer();

  // Sprinkles: the legacy SprinkleManager (renderer + bridge + exec) over the
  // WC workbench chrome. Needs the kernel up for exec sessions and licks.
  void openFs()
    .then(async (fs) => {
      const { wireWcSprinkles } = await import('./wc-sprinkles.js');
      await wireWcSprinkles({ refs, client: liveClient, fs, instanceId, log });
    })
    .catch((err) => log.error('WC sprinkle wiring failed', err));

  // Nav: model picker + avatar menu (settings dialog, legacy-UI escape hatch).
  void import('./wc-nav.js')
    .then(({ wireWcNav }) => wireWcNav({ refs, client: liveClient, log }))
    .catch((err) => log.error('WC nav wiring failed', err));

  log.info('WC live shell ready', { scoops: client.getScoops().length });
}

/** Page-side VFS over the shared LightningFS IndexedDB (`slicc-fs`). */
async function openPageFs(): Promise<import('../../fs/virtual-fs.js').VirtualFS> {
  const { VirtualFS } = await import('../../fs/virtual-fs.js');
  return VirtualFS.create({ dbName: 'slicc-fs' });
}
