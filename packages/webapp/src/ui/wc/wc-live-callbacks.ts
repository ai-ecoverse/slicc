import { isLickChannel } from '../../base/lick-channels.js';
import type { RegisteredScoop } from '../../scoops/types.js';
import {
  presentationStateFor,
  recordToWorkUnitSummary,
} from '../../work-unit/client/from-record.js';
import { toTabDescriptors } from '../../work-unit/client/presentation.js';
import type { WorkUnitSummary } from '../../work-unit/client/types.js';
import type {
  OffscreenClient,
  OffscreenClientCallbacks,
  ScoopBusyPhase,
} from '../offscreen-client.js';
import { LocalWorkUnitClient } from '../work-unit-client/local.js';
import type { WcChatController } from './wc-chat-controller.js';
import { scoopColor } from './wc-scoop-color.js';
import type { SwitcherScoop, WcShellRefs } from './wc-shell.js';
import { defaultRootOf, unitForContext, unitSlugFor } from './wc-unit-context.js';

export type ScoopStatus = 'initializing' | 'ready' | 'processing' | 'error';

export interface LickBackpressureState {
  count: number;
  waitingMs: number;
}

export interface WcLiveWiring {
  refs: WcShellRefs;

  refreshConeActions?: () => void;
  statuses: Map<string, ScoopStatus>;
  fills: Map<string, number>;
  phases: Map<string, ScoopBusyPhase>;

  turns: Map<string, number>;
  lickBackpressure: Map<string, LickBackpressureState>;
  pendingUrlContext: string | null;
  lastActivity: Map<string, string>;
  awaitingInput?: string | null;
  getController(): WcChatController | null;
  getClient(): OffscreenClient | null;
  getSelected(): WorkUnitSummary | null;
  selectScoop(unit: WorkUnitSummary): void;
  notifyScoopStateChanged?(): void;
  refreshScoops?(): void;
  notifyReady?(): void;

  workUnits?: LocalWorkUnitClient;
}

export function toSwitcherScoops(
  scoops: readonly RegisteredScoop[],
  statuses?: ReadonlyMap<string, ScoopStatus>,
  fills?: ReadonlyMap<string, number>,
  phases?: ReadonlyMap<string, ScoopBusyPhase>,
  awaitingJid?: string | null,
  selectedJid?: string | null
): SwitcherScoop[] {
  const units = scoops.map((scoop) =>
    recordToWorkUnitSummary(scoop, {
      awaiting: awaitingJid === scoop.jid,
      fill: fills?.get(scoop.jid),
      phase: phases?.get(scoop.jid),
      status: statuses?.get(scoop.jid),
    })
  );
  return toTabDescriptors(units, selectedJid, scoopColor);
}

export function ensureWorkUnitClient(wiring: WcLiveWiring): LocalWorkUnitClient {
  wiring.workUnits ??= new LocalWorkUnitClient({
    fills: wiring.fills,
    getAwaiting: () => wiring.awaitingInput,
    getClient: () => wiring.getClient(),
    phases: wiring.phases,
    statuses: wiring.statuses,
    turns: wiring.turns,
  });
  return wiring.workUnits;
}

export function createWcLiveCallbacks(wiring: WcLiveWiring): OffscreenClientCallbacks {
  const workUnits = ensureWorkUnitClient(wiring);

  const refreshScoops = (): void => wiring.refreshScoops?.();

  const viewingFrozen = (): boolean =>
    (wiring.refs.thread.getAttribute('context') ?? '').startsWith('freezer:');

  const ensureSelection = (): void => {
    if (wiring.getSelected() || viewingFrozen()) return;

    const units = workUnits.currentUnits();
    const pending = wiring.pendingUrlContext;
    if (pending?.startsWith('freezer:')) return;
    if (pending?.startsWith('scoop:') || pending?.startsWith('cone:')) {
      const unit = unitForContext(units, pending);
      if (unit) {
        wiring.pendingUrlContext = null;
        wiring.selectScoop(unit);
        return;
      }
    }
    const cone = defaultRootOf(units);
    if (cone) {
      wiring.pendingUrlContext = null;
      wiring.selectScoop(cone);
    }
  };

  return workUnits.wrapCallbacks({
    onStatusChange: (jid, status) => {
      const previous = wiring.statuses.get(jid);
      const next = status as ScoopStatus;
      wiring.statuses.set(jid, next);
      if (next !== 'ready' && wiring.awaitingInput === jid) wiring.awaitingInput = null;

      if (
        presentationStateFor(previous) === 'working' &&
        presentationStateFor(next) !== 'working'
      ) {
        wiring.turns.set(jid, (wiring.turns.get(jid) ?? 0) + 1);
      }

      if (presentationStateFor(previous) !== presentationStateFor(next)) {
        refreshScoops();
        wiring.notifyScoopStateChanged?.();
      }
      if (wiring.getSelected()?.id !== jid) return;
      wiring.getController()?.setProcessing(status === 'processing');
    },
    onScoopCreated: (scoop) => {
      refreshScoops();
      if (!wiring.getSelected() && !viewingFrozen() && !wiring.pendingUrlContext) {
        wiring.selectScoop(
          recordToWorkUnitSummary(scoop, {
            fill: wiring.fills.get(scoop.jid),
            phase: wiring.phases.get(scoop.jid),
            status: wiring.statuses.get(scoop.jid),
          })
        );
      }
    },
    onScoopListUpdate: (scoops) => {
      const registered = new Set(scoops.map((scoop) => scoop.jid));
      for (const jid of wiring.lickBackpressure.keys()) {
        if (!registered.has(jid)) wiring.lickBackpressure.delete(jid);
      }

      for (const jid of wiring.turns.keys()) if (!registered.has(jid)) wiring.turns.delete(jid);
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
      if (wiring.getSelected()?.id !== jid) return;
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
      if (selected?.id !== jid) return;
      const scoopName = unitSlugFor(selected);
      wiring.getController()?.setLickBackpressure(info.count, info.waitingMs, scoopName);
    },
    onMessageUpdate: (jid, update) => {
      if (wiring.getSelected()?.id !== jid) return;
      if (update.lickId && update.lickState) {
        wiring.getController()?.updateLickState(update.lickId, update.lickState);
      }
    },

    onReady: () => {
      refreshScoops();
      ensureSelection();
      wiring.notifyReady?.();
    },
  });
}
