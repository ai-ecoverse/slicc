import { isLickChannel } from '../../base/lick-channels.js';
import type { RegisteredScoop } from '../../scoops/types.js';
import { isRootUnit } from '../../work-unit/policy.js';
import type {
  OffscreenClient,
  OffscreenClientCallbacks,
  ScoopBusyPhase,
} from '../offscreen-client.js';
import type { ChatMessage } from '../types.js';
import type { WcChatController } from './wc-chat-controller.js';
import { scoopColor } from './wc-scoop-color.js';
import type { SwitcherScoop, WcShellRefs } from './wc-shell.js';
import {
  defaultRootOf,
  orderForSwitcher,
  switcherLabelFor,
  unitForContext,
  unitSlugFor,
} from './wc-unit-context.js';

/** Scoop runtime status, as broadcast by `onStatusChange`. */
export type ScoopStatus = 'initializing' | 'ready' | 'processing' | 'error';

export interface LickBackpressureState {
  count: number;
  waitingMs: number;
}

/** Mutable live state shared between kernel callbacks and shell wiring. */
export interface WcLiveWiring {
  refs: WcShellRefs;
  /** Re-sync the rail's cone actions with the roster (set by the live shell). */
  refreshConeActions?: () => void;
  statuses: Map<string, ScoopStatus>;
  fills: Map<string, number>;
  phases: Map<string, ScoopBusyPhase>;
  lickBackpressure: Map<string, LickBackpressureState>;
  pendingUrlContext: string | null;
  lastActivity: Map<string, string>;
  awaitingInput?: string | null;
  getController(): WcChatController | null;
  getClient(): OffscreenClient | null;
  getSelected(): RegisteredScoop | null;
  selectScoop(scoop: RegisteredScoop): void;
  notifyScoopStateChanged?(): void;
  refreshScoops?(): void;
  notifyReady?(): void;
}

function eyesFor(status: ScoopStatus | undefined): SwitcherScoop['eyes'] {
  if (status === 'error') return 'dead';
  if (status === 'initializing') return 'none';
  return 'open';
}

function stateFor(status: ScoopStatus | undefined): NonNullable<SwitcherScoop['state']> {
  switch (status) {
    case 'processing':
      return 'working';
    case 'error':
      return 'broken';
    case 'initializing':
      return 'initializing';
    case 'ready':
    case undefined:
      return 'idle';
  }
  status satisfies never;
  return 'idle';
}

/** Map registered scoops onto switcher tab descriptors (cone first). */
export function toSwitcherScoops(
  scoops: readonly RegisteredScoop[],
  statuses?: ReadonlyMap<string, ScoopStatus>,
  fills?: ReadonlyMap<string, number>,
  phases?: ReadonlyMap<string, ScoopBusyPhase>,
  awaitingJid?: string | null,
  selectedJid?: string | null
): SwitcherScoop[] {
  return orderForSwitcher(scoops, selectedJid).map((scoop) => {
    const fill = fills?.get(scoop.jid);
    const status = statuses?.get(scoop.jid);
    return {
      key: scoop.jid,
      type: isRootUnit(scoop) ? 'cone' : 'scoop',
      color: scoopColor({ isRoot: isRootUnit(scoop), name: scoop.name }),
      label: switcherLabelFor(scoop),
      eyes: eyesFor(status),
      state: stateFor(status),
      fill: typeof fill === 'number' ? Math.round(fill * 100) : undefined,
      phase: status === 'processing' ? phases?.get(scoop.jid) : undefined,
      awaiting: awaitingJid === scoop.jid || undefined,
    };
  });
}

/** Kernel callbacks for the WC live shell, factored for worker-free tests. */
export function createWcLiveCallbacks(wiring: WcLiveWiring): OffscreenClientCallbacks {
  const refreshScoops = (): void => {
    const client = wiring.getClient();
    if (client) {
      wiring.refs.switcher.scoops = toSwitcherScoops(
        client.getScoops(),
        wiring.statuses,
        wiring.fills,
        wiring.phases,
        wiring.awaitingInput,
        wiring.getSelected()?.jid
      );
    }
    wiring.refreshConeActions?.();
  };
  wiring.refreshScoops = refreshScoops;

  const viewingFrozen = (): boolean =>
    (wiring.refs.thread.getAttribute('context') ?? '').startsWith('freezer:');

  const ensureSelection = (): void => {
    if (wiring.getSelected() || viewingFrozen()) return;
    const scoops = wiring.getClient()?.getScoops() ?? [];
    const pending = wiring.pendingUrlContext;
    if (pending?.startsWith('freezer:')) return;
    if (pending?.startsWith('scoop:') || pending?.startsWith('cone:')) {
      const scoop = unitForContext(scoops, pending);
      if (scoop) {
        wiring.pendingUrlContext = null;
        wiring.selectScoop(scoop);
        return;
      }
    }
    const cone = defaultRootOf(scoops);
    if (cone) {
      wiring.pendingUrlContext = null;
      wiring.selectScoop(cone);
    }
  };

  return {
    onStatusChange: (jid, status) => {
      const previous = wiring.statuses.get(jid);
      const next = status as ScoopStatus;
      wiring.statuses.set(jid, next);
      if (next !== 'ready' && wiring.awaitingInput === jid) wiring.awaitingInput = null;
      if (eyesFor(previous) !== eyesFor(next) || stateFor(previous) !== stateFor(next)) {
        refreshScoops();
        wiring.notifyScoopStateChanged?.();
      }
      if (wiring.getSelected()?.jid !== jid) return;
      wiring.getController()?.setProcessing(status === 'processing');
    },
    onScoopCreated: (scoop) => {
      refreshScoops();
      if (!wiring.getSelected() && !viewingFrozen() && !wiring.pendingUrlContext) {
        wiring.selectScoop(scoop);
      }
    },
    onScoopListUpdate: (scoops) => {
      const registered = new Set(scoops.map((scoop) => scoop.jid));
      for (const jid of wiring.lickBackpressure.keys()) {
        if (!registered.has(jid)) wiring.lickBackpressure.delete(jid);
      }
      refreshScoops();
      ensureSelection();
    },
    onScoopActivity: (jid) => {
      wiring.refs.switcher.setAttribute('attention', jid);
    },
    onScoopPhaseChange: (jid, phase) => {
      wiring.phases.set(jid, phase);
      refreshScoops();
      wiring.notifyScoopStateChanged?.();
    },
    onIncomingMessage: (jid, message) => {
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
    onLickBackpressure: (jid, info) => {
      if (info.count <= 0) wiring.lickBackpressure.delete(jid);
      else wiring.lickBackpressure.set(jid, info);
      const selected = wiring.getSelected();
      if (selected?.jid !== jid) return;
      const scoopName = unitSlugFor(selected);
      wiring.getController()?.setLickBackpressure(info.count, info.waitingMs, scoopName);
    },
    onMessageUpdate: (jid, update) => {
      if (wiring.getSelected()?.jid !== jid) return;
      if (update.lickId && update.lickState) {
        wiring.getController()?.updateLickState(update.lickId, update.lickState);
      }
    },
    onScoopMessagesReplaced: (jid, messages, queuedIds) => {
      if (wiring.getSelected()?.jid !== jid) return;
      // `queuedIds` rides the SAME envelope as `messages`, so the two are a
      // consistent snapshot of the backend at one instant — which is what a
      // queue held across a read-only detour is reconciled against (#2354).
      wiring.getController()?.loadMessages(messages as unknown as ChatMessage[], queuedIds);
    },
    onReady: () => {
      refreshScoops();
      ensureSelection();
      wiring.notifyReady?.();
    },
  };
}
