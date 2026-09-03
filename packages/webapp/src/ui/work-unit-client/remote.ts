/**
 * `RemoteWorkUnitClient` — the {@link WorkUnitClient} over a tray
 * `FollowerSyncManager` (#2274).
 *
 * An ADAPTER over the follower path exactly as `LocalWorkUnitClient` is one
 * over the kernel path: `FollowerSyncManager` keeps every method it has, and
 * the small state machine `wc-follower.ts` runs (the last roster, the
 * selected unit) moves behind the protocol. Cherry and hosted followers ride
 * this unchanged — they are the same follower path — and no wire field
 * changes, so iOS is untouched.
 */

import type { FollowerSyncManager } from '../../scoops/tray-follower-sync.js';
import { shouldApplyFollowerStatus } from '../../scoops/tray-follower-sync.js';
import type { ScoopSummary } from '../../scoops/tray-sync-protocol.js';
import type { WorkUnitModel } from '../../scoops/types.js';
import type {
  Unsubscribe,
  WorkUnitChatMessage,
  WorkUnitClient,
  WorkUnitClientEvent,
  WorkUnitClientInput,
  WorkUnitId,
  WorkUnitSignal,
  WorkUnitSnapshot,
  WorkUnitSummary,
} from '../../work-unit/client/types.js';
import { qualifiedModelId } from '../../work-unit/record.js';
import type { ChatMessage } from '../types.js';
import { summaryToWorkUnit } from '../wc/wc-tray-scoops.js';

/** How long to wait for the leader's snapshot before answering with what we have. */
const SNAPSHOT_TIMEOUT_MS = 10000;

export interface RemoteWorkUnitClientDeps {
  getSync(): FollowerSyncManager | null;
}

/**
 * The three leader frames this adapter observes. Declared structurally so
 * both the sync manager's option bag and the page tray's superset satisfy it.
 */
export interface FollowerCallbackSlice {
  onScoopsList?: (scoops: ScoopSummary[], activeScoopJid: string) => void;
  onSnapshot?: (messages: ChatMessage[], scoopJid: string) => void;
  onStatus?: (scoopStatus: string, scoopJid?: string) => void;
}

export class RemoteWorkUnitClient implements WorkUnitClient {
  private units: readonly WorkUnitSummary[] = [];
  private selectedId: WorkUnitId | null = null;
  private readonly listListeners = new Set<(units: readonly WorkUnitSummary[]) => void>();
  private readonly unitListeners = new Map<WorkUnitId, Set<(event: WorkUnitClientEvent) => void>>();
  /**
   * The last snapshot published per unit — seeds a subscriber attaching
   * mid-turn, so a `message` never reaches a listener that has not seen one.
   */
  private readonly lastSnapshots = new Map<WorkUnitId, WorkUnitSnapshot>();
  private readonly pendingSnapshots = new Map<
    WorkUnitId,
    Set<(snapshot: WorkUnitSnapshot) => void>
  >();

  constructor(private readonly deps: RemoteWorkUnitClientDeps) {}

  /** The unit the leader is currently mirroring to this follower. */
  get selectedUnitId(): WorkUnitId | null {
    return this.selectedId;
  }

  /**
   * Forget which unit this client is showing, for a channel that went away.
   *
   * A reconnect is a fresh bootstrap: the leader may have dropped the unit we
   * were viewing, and it re-answers with its own. Keeping the previous
   * session's id would make {@link wrapOptions}'s staleness rule judge the new
   * session's first snapshot against a unit that no longer exists and drop it.
   */
  resetSelection(): void {
    this.selectedId = null;
  }

  /** Forget one pending {@link snapshot} caller, and the set once it is empty. */
  private forgetWaiter(id: WorkUnitId, resolve: (snapshot: WorkUnitSnapshot) => void): void {
    const waiters = this.pendingSnapshots.get(id);
    if (!waiters) return;
    waiters.delete(resolve);
    if (waiters.size === 0) this.pendingSnapshots.delete(id);
  }

  private emitList(): void {
    for (const listener of this.listListeners) listener(this.units);
  }

  private emit(id: WorkUnitId, event: WorkUnitClientEvent): void {
    const listeners = this.unitListeners.get(id);
    if (!listeners) return;
    for (const listener of listeners) listener(event);
  }

  private summaryOf(id: WorkUnitId): WorkUnitSummary | undefined {
    return this.units.find((unit) => unit.id === id);
  }

  /** Emit a snapshot to this unit's subscribers and settle anyone awaiting it. */
  private publishSnapshot(id: WorkUnitId, snapshot: WorkUnitSnapshot): void {
    this.lastSnapshots.set(id, snapshot);
    this.emit(id, { snapshot, type: 'snapshot' });
    const waiters = this.pendingSnapshots.get(id);
    if (!waiters) return;
    this.pendingSnapshots.delete(id);
    for (const resolve of waiters) resolve(snapshot);
  }

  /**
   * Wrap the follower's options bag so leader frames reach this adapter
   * before they reach `wc-follower.ts`. Same decoration as the local
   * adapter's `wrapCallbacks`, for the same reason: the manager takes its
   * callbacks in the constructor.
   *
   * Generic over the bag because the page-tray options are a SUPERSET of the
   * sync manager's — the shell hands the whole thing to
   * `startPageFollowerTray`, which forwards these three through.
   *
   * This adapter runs BEFORE the base handler on every frame, unlike the local
   * one: there the page-side status maps the adapter reads are mutated by the
   * base handlers, while here the frame IS the state and the shell's handler
   * publishes the strip from the roster this one has just folded in. It is
   * also what lets a stale snapshot be dropped for both of them at once.
   */
  wrapOptions<T extends FollowerCallbackSlice>(base: T): T {
    return {
      ...base,
      onScoopsList: (scoops: ScoopSummary[], activeScoopJid: string) => {
        this.units = scoops.map(summaryToWorkUnit);
        if (!this.selectedId || !this.units.some((unit) => unit.id === this.selectedId)) {
          // An empty `activeScoopJid` is a leader that could not name a unit,
          // not a unit called `''`. Keeping it would make this client claim to
          // be mirroring something and let a send name the empty string.
          this.selectedId = activeScoopJid.length > 0 ? activeScoopJid : null;
        }
        // Before the shell's handler: it publishes the strip from this roster.
        this.emitList();
        base.onScoopsList?.(scoops, activeScoopJid);
      },
      onSnapshot: (messages: ChatMessage[], scoopJid: string) => {
        // A snapshot for a unit we are no longer showing is STALE, and applying
        // it is worse than dropping it: a tab click asks the leader for B while
        // A's snapshot is still in flight, and A would replace the transcript,
        // re-point `selectedId`, and make the NEXT SEND name A while the strip
        // shows B. Same rule `shouldApplyFollowerStatus` applies to status
        // frames. `null` is still "fresh join, take whatever the leader sends"
        // — which is also what a reconnect resets to (`resetSelection`), so a
        // new session is never judged against the previous one's unit.
        if (this.selectedId !== null && this.selectedId !== scoopJid) return;
        this.selectedId = scoopJid;
        const transcript = messages as unknown as readonly WorkUnitChatMessage[];
        const summary = this.summaryOf(scoopJid);
        // Published whether or not the roster describes the unit. It often will
        // not: a leader sends the initial transcript AHEAD of `scoops.list`,
        // and a biscotto seat never receives that frame at all — holding the
        // snapshot back for a summary left a guest's thread permanently blank.
        // A follower never reports a queue either: its leader does not send one
        // and its own orchestrator is deliberately idle, so `[]` would reorder
        // the pile against a lie. `undefined` says "nobody could answer".
        this.publishSnapshot(scoopJid, {
          messages: transcript,
          ...(summary ? { summary } : {}),
        });
        base.onSnapshot?.(messages, scoopJid);
      },
      onStatus: (scoopStatus: string, scoopJid?: string) => {
        // The leader's status frame may omit the unit; `shouldApplyFollowerStatus`
        // is the existing rule for whether it describes what we are showing.
        const target = scoopJid ?? this.selectedId;
        if (target && shouldApplyFollowerStatus(scoopJid, this.selectedId)) {
          const state = scoopStatus === 'processing' ? 'working' : 'idle';
          this.emit(target, { state, type: 'status' });
          // The roster carries the same fact, and `subscribeList` promises a
          // push for it: without this, `list()` reports the previous state
          // until the leader's next `scoops.list` frame.
          this.applyState(target, state);
        }
        base.onStatus?.(scoopStatus, scoopJid);
      },
    } as T;
  }

  /** Fold a status frame into the held roster and push it. */
  private applyState(id: WorkUnitId, state: WorkUnitSummary['state']): void {
    const current = this.summaryOf(id);
    if (!current || current.state === state) return;
    this.units = this.units.map((unit) =>
      unit.id === id
        ? // A status frame refines nothing else: `phase` and `awaiting` only
          // ever arrive on a roster frame, so a stale one must not survive a
          // state change it does not describe.
          { ...unit, state, phase: undefined, awaiting: undefined }
        : unit
    );
    this.emitList();
  }

  /** The last roster the leader sent. {@link list} is the protocol's async form. */
  currentUnits(): readonly WorkUnitSummary[] {
    return this.units;
  }

  list(): Promise<readonly WorkUnitSummary[]> {
    return Promise.resolve(this.units);
  }

  subscribeList(listener: (units: readonly WorkUnitSummary[]) => void): Unsubscribe {
    this.listListeners.add(listener);
    // Seed the subscriber with what we already know (protocol contract).
    listener(this.units);
    return () => {
      this.listListeners.delete(listener);
    };
  }

  /**
   * Subscribe to one unit, SEEDED with the last snapshot this client
   * published (the protocol's mid-turn ordering guarantee).
   *
   * Unlike the local adapter there is no request to make when none is held: a
   * follower only ever receives the SELECTED unit's transcript, so asking for
   * another unit's would mean changing what the leader mirrors — a side
   * effect a subscription must not have. {@link snapshot} is that call.
   */
  subscribe(id: WorkUnitId, listener: (event: WorkUnitClientEvent) => void): Unsubscribe {
    const listeners = this.unitListeners.get(id) ?? new Set<(event: WorkUnitClientEvent) => void>();
    listeners.add(listener);
    this.unitListeners.set(id, listeners);
    const known = this.lastSnapshots.get(id);
    if (known) listener({ snapshot: known, type: 'snapshot' });
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.unitListeners.delete(id);
    };
  }

  /**
   * Ask the leader to mirror `id` and resolve with the snapshot it sends
   * back. Selection is part of the call on this transport too — a follower
   * only ever receives the selected unit's transcript.
   */
  snapshot(id: WorkUnitId): Promise<WorkUnitSnapshot> {
    const sync = this.deps.getSync();
    if (!sync) return Promise.reject(new Error('not connected to a leader'));
    const waiters =
      this.pendingSnapshots.get(id) ?? new Set<(snapshot: WorkUnitSnapshot) => void>();
    this.pendingSnapshots.set(id, waiters);
    let resolveArrival: (snapshot: WorkUnitSnapshot) => void = () => {};
    const arrival = new Promise<WorkUnitSnapshot>((resolve) => {
      resolveArrival = resolve;
      waiters.add(resolve);
    });
    this.selectedId = id;
    sync.selectScoop(id);
    const fallback = new Promise<WorkUnitSnapshot | null>((resolve) => {
      setTimeout(() => {
        // Drop THIS caller's waiter (not the set: a concurrent call for the
        // same unit still has its own pending promise and its own fallback).
        this.forgetWaiter(id, resolveArrival);
        const summary = this.summaryOf(id);
        resolve(summary ? { messages: [], summary } : null);
      }, SNAPSHOT_TIMEOUT_MS);
    });
    return Promise.race([arrival, fallback]).then((snapshot) => {
      if (!snapshot) throw new Error(`unknown work unit: ${id}`);
      return snapshot;
    });
  }

  /**
   * Deliver a prompt to `id`. The tray's `user_message` frame carries no
   * unit — the leader routes it to whatever this follower last selected — so
   * a send to a unit we are not showing selects it first. That is the same
   * round trip the shell performs on a tab click; naming the unit in the
   * protocol only makes the dependency explicit.
   */
  send(id: WorkUnitId, input: WorkUnitClientInput): Promise<void> {
    const sync = this.deps.getSync();
    if (!sync) return Promise.reject(new Error('not connected to a leader'));
    // A gate is minted by a LEADER from its own seat record. Putting one on
    // the tray wire would be a guest granting itself a gate, so this is a
    // refusal, never a fallback to an ungated send.
    if (input.guestGate) {
      return Promise.reject(new Error('a guest gate cannot travel over the tray wire'));
    }
    if (this.selectedId !== id) {
      this.selectedId = id;
      sync.selectScoop(id);
    }
    // The channel's own answer, not a hope: `TraySyncChannel.send` refuses a
    // closed or closing data channel, and resolving anyway would report a
    // delivered send for a message that never left the device — after the
    // controller had already rendered its bubble and cleared the input.
    const accepted = sync.sendMessage(
      input.text,
      input.messageId,
      input.attachments as Parameters<FollowerSyncManager['sendMessage']>[2],
      input.steer ? { steer: true } : undefined
    );
    if (!accepted) return Promise.reject(new Error('the leader channel refused the message'));
    return Promise.resolve();
  }

  /**
   * Ask the leader to pin `id`'s model (#2310). The tray carries the
   * provider-qualified id as one string and resolves a child to the cone that
   * owns it on the leader side.
   *
   * `model.select` is fire-and-forget — there is no ack frame — so this always
   * answers `undefined` ("nobody could answer"), never `false`. The applied
   * value arrives on the next `model.state` / roster frame.
   */
  setModel(id: WorkUnitId, model: WorkUnitModel): Promise<boolean | undefined> {
    const sync = this.deps.getSync();
    if (!sync) return Promise.reject(new Error('not connected to a leader'));
    sync.selectModel(qualifiedModelId(model), id);
    return Promise.resolve(undefined);
  }

  signal(id: WorkUnitId, signal: WorkUnitSignal): Promise<void> {
    if (signal !== 'stop') return Promise.resolve();
    const sync = this.deps.getSync();
    // Not connected means the turn was NOT stopped. Resolving here reported a
    // stop that never happened, and the composer would have dropped its busy
    // state on the strength of it.
    if (!sync) return Promise.reject(new Error('not connected to a leader'));
    // The tray's `abort` frame carries no unit either: it aborts whatever the
    // leader is running for this follower, which is the selected unit.
    if (this.selectedId !== id) {
      this.selectedId = id;
      sync.selectScoop(id);
    }
    if (!sync.stop()) return Promise.reject(new Error('the leader channel refused the abort'));
    return Promise.resolve();
  }
}
