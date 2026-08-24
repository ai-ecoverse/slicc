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
  private readonly pendingSnapshots = new Map<
    WorkUnitId,
    Set<(snapshot: WorkUnitSnapshot) => void>
  >();

  constructor(private readonly deps: RemoteWorkUnitClientDeps) {}

  /** The unit the leader is currently mirroring to this follower. */
  get selectedUnitId(): WorkUnitId | null {
    return this.selectedId;
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
   * The base handler runs first on every frame, so the shell still sees each
   * event exactly when and as it did before.
   */
  wrapOptions<T extends FollowerCallbackSlice>(base: T): T {
    return {
      ...base,
      onScoopsList: (scoops: ScoopSummary[], activeScoopJid: string) => {
        this.units = scoops.map(summaryToWorkUnit);
        if (!this.selectedId || !this.units.some((unit) => unit.id === this.selectedId)) {
          this.selectedId = activeScoopJid;
        }
        // Before the shell's handler: it publishes the strip from this roster.
        this.emitList();
        base.onScoopsList?.(scoops, activeScoopJid);
      },
      onSnapshot: (messages: ChatMessage[], scoopJid: string) => {
        this.selectedId = scoopJid;
        const summary = this.summaryOf(scoopJid);
        if (summary) {
          const snapshot: WorkUnitSnapshot = {
            messages: messages as unknown as readonly WorkUnitChatMessage[],
            summary,
            // A follower never reports a queue: its leader does not send one
            // and its own orchestrator is deliberately idle, so `[]` would
            // reorder the pile against a lie. `undefined` says "nobody could
            // answer", which is the truth.
          };
          this.emit(scoopJid, { snapshot, type: 'snapshot' });
          const waiters = this.pendingSnapshots.get(scoopJid);
          if (waiters) {
            this.pendingSnapshots.delete(scoopJid);
            for (const resolve of waiters) resolve(snapshot);
          }
        }
        base.onSnapshot?.(messages, scoopJid);
      },
      onStatus: (scoopStatus: string, scoopJid?: string) => {
        // The leader's status frame may omit the unit; `shouldApplyFollowerStatus`
        // is the existing rule for whether it describes what we are showing.
        const target = scoopJid ?? this.selectedId;
        if (target && shouldApplyFollowerStatus(scoopJid, this.selectedId)) {
          this.emit(target, {
            state: scoopStatus === 'processing' ? 'working' : 'idle',
            type: 'status',
          });
        }
        base.onStatus?.(scoopStatus, scoopJid);
      },
    } as T;
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

  subscribe(id: WorkUnitId, listener: (event: WorkUnitClientEvent) => void): Unsubscribe {
    const listeners = this.unitListeners.get(id) ?? new Set<(event: WorkUnitClientEvent) => void>();
    listeners.add(listener);
    this.unitListeners.set(id, listeners);
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
    const arrival = new Promise<WorkUnitSnapshot>((resolve) => {
      waiters.add(resolve);
    });
    this.selectedId = id;
    sync.selectScoop(id);
    const fallback = new Promise<WorkUnitSnapshot | null>((resolve) => {
      setTimeout(() => {
        // Drop the waiter with the request: a snapshot that never arrived must
        // not resolve a later call's promise when the leader finally answers.
        this.pendingSnapshots.delete(id);
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
    if (this.selectedId !== id) {
      this.selectedId = id;
      sync.selectScoop(id);
    }
    sync.sendMessage(
      input.text,
      undefined,
      input.attachments as Parameters<FollowerSyncManager['sendMessage']>[2],
      input.steer ? { steer: true } : undefined
    );
    return Promise.resolve();
  }

  signal(id: WorkUnitId, signal: WorkUnitSignal): Promise<void> {
    if (signal !== 'stop') return Promise.resolve();
    const sync = this.deps.getSync();
    if (!sync) return Promise.resolve();
    // The tray's `abort` frame carries no unit either: it aborts whatever the
    // leader is running for this follower, which is the selected unit.
    if (this.selectedId !== id) {
      this.selectedId = id;
      sync.selectScoop(id);
    }
    sync.stop();
    return Promise.resolve();
  }
}
