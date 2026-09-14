import type { RegisteredScoop, WorkUnitModel } from '../../scoops/types.js';
import {
  presentationStateFor,
  recordToWorkUnitSummary,
} from '../../work-unit/client/from-record.js';
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
import type {
  OffscreenClient,
  OffscreenClientCallbacks,
  ScoopBusyPhase,
} from '../offscreen-client.js';
import type { ScoopStatus } from '../wc/wc-live-callbacks.js';

const SNAPSHOT_TIMEOUT_MS = 5000;

export interface LocalWorkUnitClientDeps {
  getClient(): OffscreenClient | null;
  statuses: ReadonlyMap<string, ScoopStatus>;

  fills: ReadonlyMap<string, number>;
  phases: ReadonlyMap<string, ScoopBusyPhase>;

  turns?: ReadonlyMap<string, number>;
  getAwaiting?(): string | null | undefined;
}

export class LocalWorkUnitClient implements WorkUnitClient {
  private readonly listListeners = new Set<(units: readonly WorkUnitSummary[]) => void>();
  private readonly unitListeners = new Map<WorkUnitId, Set<(event: WorkUnitClientEvent) => void>>();

  private readonly lastSnapshots = new Map<WorkUnitId, WorkUnitSnapshot>();

  private readonly orphanedReplays = new Map<
    WorkUnitId,
    { messages: readonly WorkUnitChatMessage[]; queuedIds: readonly string[] | undefined }
  >();

  private readonly retriedSnapshots = new Set<WorkUnitId>();

  private readonly pendingSnapshots = new Map<
    WorkUnitId,
    Set<(snapshot: WorkUnitSnapshot) => void>
  >();

  constructor(private readonly deps: LocalWorkUnitClientDeps) {}

  private toSummary(scoop: RegisteredScoop): WorkUnitSummary {
    return recordToWorkUnitSummary(scoop, {
      awaiting: this.deps.getAwaiting?.() === scoop.jid,
      fill: this.deps.fills.get(scoop.jid),
      phase: this.deps.phases.get(scoop.jid),
      status: this.deps.statuses.get(scoop.jid),
      turns: this.deps.turns?.get(scoop.jid),
    });
  }

  private snapshotFor(
    id: WorkUnitId,
    messages: readonly WorkUnitChatMessage[],
    queuedIds: readonly string[] | undefined
  ): WorkUnitSnapshot | null {
    const scoop = this.deps
      .getClient()
      ?.getScoops()
      .find((unit) => unit.jid === id);
    if (!scoop) return null;
    return { summary: this.toSummary(scoop), messages, ...(queuedIds ? { queuedIds } : {}) };
  }

  currentUnits(): readonly WorkUnitSummary[] {
    return (this.deps.getClient()?.getScoops() ?? []).map((scoop) => this.toSummary(scoop));
  }

  private publishSnapshot(id: WorkUnitId, snapshot: WorkUnitSnapshot): void {
    this.retriedSnapshots.delete(id);
    this.lastSnapshots.set(id, snapshot);
    this.emit(id, { snapshot, type: 'snapshot' });
    const waiters = this.pendingSnapshots.get(id);
    if (!waiters) return;
    this.pendingSnapshots.delete(id);
    for (const resolve of waiters) resolve(snapshot);
  }

  private drainOrphanedReplays(): void {
    for (const [id, replay] of this.orphanedReplays) {
      const snapshot = this.snapshotFor(id, replay.messages, replay.queuedIds);
      if (!snapshot) continue;
      this.orphanedReplays.delete(id);
      this.publishSnapshot(id, snapshot);
    }
  }

  private recoverUnanswered(id: WorkUnitId): void {
    if (!this.unitListeners.has(id)) return;
    if (this.retriedSnapshots.has(id)) {
      this.publishRecovery(id);
      return;
    }
    this.retriedSnapshots.add(id);
    this.deps.getClient()?.requestScoopMessages(id);
    setTimeout(() => {
      if (this.retriedSnapshots.has(id)) this.publishRecovery(id);
    }, SNAPSHOT_TIMEOUT_MS);
  }

  private publishRecovery(id: WorkUnitId): void {
    if (!this.unitListeners.has(id)) return;
    const cached = this.lastSnapshots.get(id);
    const scoop = this.deps
      .getClient()
      ?.getScoops()
      .find((unit) => unit.jid === id);
    this.emit(id, {
      snapshot: {
        messages: cached?.messages ?? [],
        ...(scoop ? { summary: this.toSummary(scoop) } : {}),
      },
      type: 'snapshot',
    });
  }

  private forgetWaiter(id: WorkUnitId, resolve: (snapshot: WorkUnitSnapshot) => void): void {
    const waiters = this.pendingSnapshots.get(id);
    if (!waiters) return;
    waiters.delete(resolve);
    if (waiters.size === 0) this.pendingSnapshots.delete(id);
  }

  private emitList(): void {
    this.drainOrphanedReplays();
    if (this.listListeners.size === 0) return;
    const units = this.currentUnits();
    for (const listener of this.listListeners) listener(units);
  }

  private emit(id: WorkUnitId, event: WorkUnitClientEvent): void {
    const listeners = this.unitListeners.get(id);
    if (!listeners) return;
    for (const listener of listeners) listener(event);
  }

  wrapCallbacks(base: OffscreenClientCallbacks): OffscreenClientCallbacks {
    return {
      ...base,
      onStatusChange: (jid, status) => {
        base.onStatusChange(jid, status);
        this.emit(jid, { state: presentationStateFor(status as ScoopStatus), type: 'status' });
        this.emitList();
      },
      onScoopCreated: (scoop) => {
        base.onScoopCreated(scoop);
        this.emitList();
      },
      onScoopListUpdate: (scoops) => {
        base.onScoopListUpdate(scoops);
        this.emitList();
      },
      onScoopPhaseChange: (jid, phase) => {
        base.onScoopPhaseChange?.(jid, phase);
        this.emitList();
      },
      onIncomingMessage: (jid, message) => {
        base.onIncomingMessage(jid, message);
        this.emit(jid, { message: message as unknown as WorkUnitChatMessage, type: 'message' });
      },

      onScoopMessagesReplaced: (jid, messages, queuedIds) => {
        base.onScoopMessagesReplaced?.(jid, messages, queuedIds);
        const replayed = messages as unknown as readonly WorkUnitChatMessage[];
        const snapshot = this.snapshotFor(jid, replayed, queuedIds);
        if (snapshot) this.publishSnapshot(jid, snapshot);
        else this.orphanedReplays.set(jid, { messages: replayed, queuedIds });
      },
    };
  }

  list(): Promise<readonly WorkUnitSummary[]> {
    return Promise.resolve(this.currentUnits());
  }

  subscribeList(listener: (units: readonly WorkUnitSummary[]) => void): Unsubscribe {
    this.listListeners.add(listener);

    listener(this.currentUnits());
    return () => {
      this.listListeners.delete(listener);
    };
  }

  subscribe(id: WorkUnitId, listener: (event: WorkUnitClientEvent) => void): Unsubscribe {
    const listeners = this.unitListeners.get(id) ?? new Set<(event: WorkUnitClientEvent) => void>();
    listeners.add(listener);
    this.unitListeners.set(id, listeners);

    const known = this.lastSnapshots.get(id);
    if (!this.pendingSnapshots.has(id)) {
      if (known) listener({ snapshot: known, type: 'snapshot' });
      else this.deps.getClient()?.requestScoopMessages(id);
    }
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.unitListeners.delete(id);
    };
  }

  snapshot(id: WorkUnitId): Promise<WorkUnitSnapshot> {
    const client = this.deps.getClient();
    if (!client) return Promise.reject(new Error('kernel client not attached'));
    const waiters =
      this.pendingSnapshots.get(id) ?? new Set<(snapshot: WorkUnitSnapshot) => void>();
    this.pendingSnapshots.set(id, waiters);
    let resolveReplay: (snapshot: WorkUnitSnapshot) => void = () => {};
    const replay = new Promise<WorkUnitSnapshot>((resolve) => {
      resolveReplay = resolve;
      waiters.add(resolve);
    });
    client.setSelectedScoopJid(id);
    client.requestScoopMessages(id);
    let fallbackTimer: ReturnType<typeof setTimeout> | undefined;
    const fallback = new Promise<WorkUnitSnapshot | null>((resolve) => {
      fallbackTimer = setTimeout(() => {
        fallbackTimer = undefined;

        const stillWaiting = this.pendingSnapshots.get(id)?.has(resolveReplay) === true;
        this.forgetWaiter(id, resolveReplay);
        if (stillWaiting) this.recoverUnanswered(id);
        resolve(this.snapshotFor(id, [], undefined));
      }, SNAPSHOT_TIMEOUT_MS);
    });
    return Promise.race([
      replay.then((snapshot) => {
        if (fallbackTimer !== undefined) {
          clearTimeout(fallbackTimer);
          fallbackTimer = undefined;
        }
        return snapshot;
      }),
      fallback,
    ]).then((snapshot) => {
      if (!snapshot) throw new Error(`unknown work unit: ${id}`);
      return snapshot;
    });
  }

  send(id: WorkUnitId, input: WorkUnitClientInput): Promise<void> {
    const client = this.deps.getClient();
    if (!client) return Promise.reject(new Error('kernel client not attached'));
    client.sendRaw({
      attachments: input.attachments,

      messageId: input.messageId ?? `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      scoopJid: id,
      text: input.text,
      type: 'user-message',
      ...(input.steer ? { steer: true as const } : {}),
      ...(input.guestGate ? { guestGate: input.guestGate } : {}),
    } as Parameters<OffscreenClient['sendRaw']>[0]);
    return Promise.resolve();
  }

  setModel(id: WorkUnitId, model: WorkUnitModel): Promise<boolean | undefined> {
    const client = this.deps.getClient();
    if (!client) return Promise.reject(new Error('kernel client not attached'));
    return client.setScoopModel(id, model);
  }

  signal(id: WorkUnitId, signal: WorkUnitSignal): Promise<void> {
    if (signal !== 'stop') return Promise.resolve();
    const client = this.deps.getClient();

    if (!client) return Promise.reject(new Error('kernel client not attached'));
    client.stopScoop(id);
    return Promise.resolve();
  }
}
