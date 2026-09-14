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

const SNAPSHOT_TIMEOUT_MS = 10000;

export interface RemoteWorkUnitClientDeps {
  getSync(): FollowerSyncManager | null;
}

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

  private readonly lastSnapshots = new Map<WorkUnitId, WorkUnitSnapshot>();
  private readonly pendingSnapshots = new Map<
    WorkUnitId,
    Set<(snapshot: WorkUnitSnapshot) => void>
  >();

  constructor(private readonly deps: RemoteWorkUnitClientDeps) {}

  get selectedUnitId(): WorkUnitId | null {
    return this.selectedId;
  }

  resetSelection(): void {
    this.selectedId = null;

    this.units = [];
    this.lastSnapshots.clear();

    this.pendingSnapshots.clear();
  }

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

  private publishSnapshot(id: WorkUnitId, snapshot: WorkUnitSnapshot): void {
    this.lastSnapshots.set(id, snapshot);
    this.emit(id, { snapshot, type: 'snapshot' });
    const waiters = this.pendingSnapshots.get(id);
    if (!waiters) return;
    this.pendingSnapshots.delete(id);
    for (const resolve of waiters) resolve(snapshot);
  }

  wrapOptions<T extends FollowerCallbackSlice>(base: T): T {
    return {
      ...base,
      onScoopsList: (scoops: ScoopSummary[], activeScoopJid: string) => {
        this.units = scoops.map(summaryToWorkUnit);
        if (!this.selectedId || !this.units.some((unit) => unit.id === this.selectedId)) {
          this.selectedId = activeScoopJid.length > 0 ? activeScoopJid : null;
        }

        this.emitList();
        base.onScoopsList?.(scoops, activeScoopJid);
      },
      onSnapshot: (messages: ChatMessage[], scoopJid: string) => {
        if (this.selectedId !== null && this.selectedId !== scoopJid) return;
        this.selectedId = scoopJid;
        const transcript = messages as unknown as readonly WorkUnitChatMessage[];
        const summary = this.summaryOf(scoopJid);

        this.publishSnapshot(scoopJid, {
          messages: transcript,
          ...(summary ? { summary } : {}),
        });
        base.onSnapshot?.(messages, scoopJid);
      },
      onStatus: (scoopStatus: string, scoopJid?: string) => {
        const target = scoopJid ?? this.selectedId;
        if (target && shouldApplyFollowerStatus(scoopJid, this.selectedId)) {
          const state = scoopStatus === 'processing' ? 'working' : 'idle';
          this.emit(target, { state, type: 'status' });

          this.applyState(target, state);
        }
        base.onStatus?.(scoopStatus, scoopJid);
      },
    } as T;
  }

  private applyState(id: WorkUnitId, state: WorkUnitSummary['state']): void {
    const current = this.summaryOf(id);
    if (!current || current.state === state) return;
    this.units = this.units.map((unit) =>
      unit.id === id ? { ...unit, state, phase: undefined, awaiting: undefined } : unit
    );
    this.emitList();
  }

  currentUnits(): readonly WorkUnitSummary[] {
    return this.units;
  }

  list(): Promise<readonly WorkUnitSummary[]> {
    return Promise.resolve(this.units);
  }

  subscribeList(listener: (units: readonly WorkUnitSummary[]) => void): Unsubscribe {
    this.listListeners.add(listener);

    listener(this.units);
    return () => {
      this.listListeners.delete(listener);
    };
  }

  subscribe(id: WorkUnitId, listener: (event: WorkUnitClientEvent) => void): Unsubscribe {
    const listeners = this.unitListeners.get(id) ?? new Set<(event: WorkUnitClientEvent) => void>();
    listeners.add(listener);
    this.unitListeners.set(id, listeners);

    const known = this.lastSnapshots.get(id);
    if (known && !this.pendingSnapshots.has(id)) listener({ snapshot: known, type: 'snapshot' });
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.unitListeners.delete(id);
    };
  }

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

  send(id: WorkUnitId, input: WorkUnitClientInput): Promise<void> {
    const sync = this.deps.getSync();
    if (!sync) return Promise.reject(new Error('not connected to a leader'));

    if (input.guestGate) {
      return Promise.reject(new Error('a guest gate cannot travel over the tray wire'));
    }
    if (this.selectedId !== id) {
      this.selectedId = id;
      sync.selectScoop(id);
    }

    const accepted = sync.sendMessage(
      input.text,
      input.messageId,
      input.attachments as Parameters<FollowerSyncManager['sendMessage']>[2],
      input.steer ? { steer: true } : undefined
    );
    if (!accepted) return Promise.reject(new Error('the leader channel refused the message'));
    return Promise.resolve();
  }

  setModel(id: WorkUnitId, model: WorkUnitModel): Promise<boolean | undefined> {
    const sync = this.deps.getSync();
    if (!sync) return Promise.reject(new Error('not connected to a leader'));
    sync.selectModel(qualifiedModelId(model), id);
    return Promise.resolve(undefined);
  }

  signal(id: WorkUnitId, signal: WorkUnitSignal): Promise<void> {
    if (signal !== 'stop') return Promise.resolve();
    const sync = this.deps.getSync();

    if (!sync) return Promise.reject(new Error('not connected to a leader'));

    if (this.selectedId !== id) {
      this.selectedId = id;
      sync.selectScoop(id);
    }
    if (!sync.stop()) return Promise.reject(new Error('the leader channel refused the abort'));
    return Promise.resolve();
  }
}
