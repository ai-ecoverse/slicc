import { isLickChannel } from '../../base/lick-channels.js';
import type { RegisteredScoop } from '../../scoops/types.js';
import {
  presentationStateFor,
  recordToWorkUnitSummary,
} from '../../work-unit/client/from-record.js';
import { toTabDescriptors } from '../../work-unit/client/presentation.js';
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
  /**
   * The kernel-backed {@link WorkUnitClient} (#2274), published here so the
   * rest of the shell can reach the protocol rather than the transport.
   * Assigned by {@link createWcLiveCallbacks}, which is where the adapter has
   * to be built — `OffscreenClient` takes its callback bag in the constructor.
   */
  workUnits?: LocalWorkUnitClient;
}

/**
 * Map registered scoops onto switcher tab descriptors.
 *
 * Ordering and rendering live in `work-unit/client/presentation.ts` since
 * #2274 — the follower builds its strip from the same two functions, so the
 * leader can no longer render a roster the follower would order differently
 * (#2317). This is the leader's projection onto the protocol and nothing more.
 */
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

/**
 * The leader's half of the client protocol (#2274) for one wiring bag —
 * created on first ask and held on the bag afterwards.
 *
 * Idempotent because three places need it and none of them can be the sole
 * owner: `prepareWcShell` builds the bag, `createWcLiveCallbacks` DECORATES
 * the callback bag the adapter must observe (so it has to exist before
 * `OffscreenClient` does), and `attachWcClient` mounts the composer on it. A
 * second instance would mean a second last-snapshot cache and a strip that
 * repaints from a different roster than the composer sends to.
 */
export function ensureWorkUnitClient(wiring: WcLiveWiring): LocalWorkUnitClient {
  wiring.workUnits ??= new LocalWorkUnitClient({
    fills: wiring.fills,
    getAwaiting: () => wiring.awaitingInput,
    getClient: () => wiring.getClient(),
    phases: wiring.phases,
    statuses: wiring.statuses,
  });
  return wiring.workUnits;
}

/** Kernel callbacks for the WC live shell, factored for worker-free tests. */
export function createWcLiveCallbacks(wiring: WcLiveWiring): OffscreenClientCallbacks {
  const workUnits = ensureWorkUnitClient(wiring);

  // The strip renders from the protocol's roster, not from `getScoops()` plus
  // three page-side maps — the same `toTabDescriptors` the follower calls.
  // The roster is held rather than re-fetched because a selection change
  // re-orders the SAME units and must repaint synchronously.
  // The roster is read at repaint time rather than held: `awaitingInput` and
  // the selection change with no kernel event behind them, so a cached copy
  // would render the previous instant.
  const publish = (): void => {
    if (wiring.getClient()) {
      wiring.refs.switcher.scoops = toTabDescriptors(
        workUnits.currentUnits(),
        wiring.getSelected()?.jid,
        scoopColor
      ) as SwitcherScoop[];
    }
    wiring.refreshConeActions?.();
  };
  // Never unsubscribed: the live shell owns this client for the lifetime of
  // the page, and the callback bag it decorates dies with it.
  workUnits.subscribeList(() => publish());
  const refreshScoops = publish;
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

  return workUnits.wrapCallbacks({
    onStatusChange: (jid, status) => {
      const previous = wiring.statuses.get(jid);
      const next = status as ScoopStatus;
      wiring.statuses.set(jid, next);
      if (next !== 'ready' && wiring.awaitingInput === jid) wiring.awaitingInput = null;
      // Eyes are a function of the rendered state (`broken` → dead,
      // `initializing` → none, else open), so one comparison covers what the
      // two used to: repaint the strip only when the face actually changes.
      if (presentationStateFor(previous) !== presentationStateFor(next)) {
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
    // No `onScoopMessagesReplaced` here any more (#2382): the transcript is
    // rendered from `WorkUnitClient.subscribe` in the mount, so a replay
    // reaches the thread through the protocol on both sides. The ADAPTER still
    // consumes this callback — `wrapCallbacks` turns it into the snapshot
    // event — which is why the kernel wiring below is unchanged.
    onReady: () => {
      refreshScoops();
      ensureSelection();
      wiring.notifyReady?.();
    },
  });
}
