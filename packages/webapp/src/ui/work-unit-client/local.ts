/**
 * `LocalWorkUnitClient` — the {@link WorkUnitClient} over a kernel
 * `OffscreenClient` (#2274).
 *
 * This is an ADAPTER, not a rewrite: `OffscreenClient` keeps every method it
 * has, and this class translates its vocabulary (a roster plus a callback bag
 * plus page-side status/fill/phase maps) into the protocol. Both local floats
 * ride it — the CLI's kernel worker and the extension's offscreen document
 * differ only in transport (`MessageChannel` vs `chrome.runtime`), which the
 * protocol never sees.
 */

import type { RegisteredScoop } from '../../scoops/types.js';
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

/** How long to wait for the kernel's replay before answering with what we have. */
const SNAPSHOT_TIMEOUT_MS = 5000;

/**
 * The page-side state the live shell already keeps. Read rather than
 * duplicated: this adapter is a translation layer, and a second copy of the
 * status maps would be one more thing to drift.
 */
export interface LocalWorkUnitClientDeps {
  getClient(): OffscreenClient | null;
  statuses: ReadonlyMap<string, ScoopStatus>;
  /** 0–1 share of the context window, as the kernel reports it. */
  fills: ReadonlyMap<string, number>;
  phases: ReadonlyMap<string, ScoopBusyPhase>;
  getAwaiting?(): string | null | undefined;
}

export class LocalWorkUnitClient implements WorkUnitClient {
  private readonly listListeners = new Set<(units: readonly WorkUnitSummary[]) => void>();
  private readonly unitListeners = new Map<WorkUnitId, Set<(event: WorkUnitClientEvent) => void>>();
  /** Replays awaited by {@link snapshot}, keyed by unit. */
  private readonly pendingSnapshots = new Map<
    WorkUnitId,
    Set<(snapshot: WorkUnitSnapshot) => void>
  >();

  constructor(private readonly deps: LocalWorkUnitClientDeps) {}

  /** Project one registered record plus its page-side state onto the protocol. */
  private toSummary(scoop: RegisteredScoop): WorkUnitSummary {
    return recordToWorkUnitSummary(scoop, {
      awaiting: this.deps.getAwaiting?.() === scoop.jid,
      fill: this.deps.fills.get(scoop.jid),
      phase: this.deps.phases.get(scoop.jid),
      status: this.deps.statuses.get(scoop.jid),
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

  /**
   * The roster as it stands, synchronously. {@link list} is the protocol's
   * async form and answers with exactly this.
   *
   * The synchronous form exists because the leader's runtime state lives in
   * page-side maps the shell mutates directly (`awaitingInput` changes with no
   * kernel event at all), so the strip's repaint path has to be able to ask
   * "what is true right now" rather than replay the last push.
   */
  currentUnits(): readonly WorkUnitSummary[] {
    return (this.deps.getClient()?.getScoops() ?? []).map((scoop) => this.toSummary(scoop));
  }

  private emitList(): void {
    if (this.listListeners.size === 0) return;
    const units = this.currentUnits();
    for (const listener of this.listListeners) listener(units);
  }

  private emit(id: WorkUnitId, event: WorkUnitClientEvent): void {
    const listeners = this.unitListeners.get(id);
    if (!listeners) return;
    for (const listener of listeners) listener(event);
  }

  /**
   * Wrap the live shell's callback bag so kernel events reach this adapter
   * BEFORE they reach the shell. `OffscreenClient` takes its callbacks in the
   * constructor, so an adapter built alongside it cannot subscribe after the
   * fact — it decorates instead. Every base handler is still called, with its
   * original arguments, so wrapping changes nothing the shell sees.
   *
   * The base handler runs FIRST on every event. The page-side status/fill/
   * phase maps this adapter projects from are mutated by those handlers, so
   * emitting before them would publish a roster describing the previous
   * instant — the strip would then repaint one event behind.
   */
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
      // `queuedIds` is the third argument since #2362; the rest signature
      // keeps this assignable to a callback bag that predates it, and passes
      // whatever arrived straight through to the shell.
      onScoopMessagesReplaced: (
        jid: string,
        messages: Parameters<NonNullable<OffscreenClientCallbacks['onScoopMessagesReplaced']>>[1],
        ...rest: unknown[]
      ) => {
        const queuedIds = rest[0] as readonly string[] | undefined;
        (
          base.onScoopMessagesReplaced as
            | ((jid: string, messages: unknown, queuedIds?: unknown) => void)
            | undefined
        )?.(jid, messages, queuedIds);
        const snapshot = this.snapshotFor(
          jid,
          messages as unknown as readonly WorkUnitChatMessage[],
          queuedIds
        );
        if (snapshot) {
          this.emit(jid, { snapshot, type: 'snapshot' });
          const waiters = this.pendingSnapshots.get(jid);
          if (waiters) {
            this.pendingSnapshots.delete(jid);
            for (const resolve of waiters) resolve(snapshot);
          }
        }
      },
    };
  }

  list(): Promise<readonly WorkUnitSummary[]> {
    return Promise.resolve(this.currentUnits());
  }

  subscribeList(listener: (units: readonly WorkUnitSummary[]) => void): Unsubscribe {
    this.listListeners.add(listener);
    // Seed the subscriber with what we already know (protocol contract).
    listener(this.currentUnits());
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
   * Select `id` and resolve with its replay. Selection is part of the call:
   * the kernel replays into the panel for whichever unit the page says it is
   * showing, and `queuedIds` rides that same envelope (#2362) so the queue
   * and the transcript describe one instant.
   *
   * A kernel that never answers resolves with the roster entry and no
   * messages rather than hanging — and with `queuedIds` ABSENT, which the
   * protocol reads as "nobody could answer" rather than "the queue is empty".
   */
  snapshot(id: WorkUnitId): Promise<WorkUnitSnapshot> {
    const client = this.deps.getClient();
    if (!client) return Promise.reject(new Error('kernel client not attached'));
    const waiters =
      this.pendingSnapshots.get(id) ?? new Set<(snapshot: WorkUnitSnapshot) => void>();
    this.pendingSnapshots.set(id, waiters);
    const replay = new Promise<WorkUnitSnapshot>((resolve) => {
      waiters.add(resolve);
    });
    client.setSelectedScoopJid(id);
    client.requestScoopMessages(id);
    const fallback = new Promise<WorkUnitSnapshot | null>((resolve) => {
      setTimeout(() => {
        // Drop the waiter with the request (see the remote adapter): a replay
        // that arrives after the timeout belongs to no pending call.
        this.pendingSnapshots.delete(id);
        resolve(this.snapshotFor(id, [], undefined));
      }, SNAPSHOT_TIMEOUT_MS);
    });
    return Promise.race([replay, fallback]).then((snapshot) => {
      if (!snapshot) throw new Error(`unknown work unit: ${id}`);
      return snapshot;
    });
  }

  /**
   * Deliver a prompt to `id` explicitly, rather than through the agent
   * handle's implicit "currently selected scoop" — the protocol names the
   * unit, so the send must not depend on a selection race.
   */
  send(id: WorkUnitId, input: WorkUnitClientInput): Promise<void> {
    const client = this.deps.getClient();
    if (!client) return Promise.reject(new Error('kernel client not attached'));
    client.sendRaw({
      attachments: input.attachments,
      messageId: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      scoopJid: id,
      text: input.text,
      type: 'user-message',
      ...(input.steer ? { steer: true as const } : {}),
    } as Parameters<OffscreenClient['sendRaw']>[0]);
    return Promise.resolve();
  }

  signal(id: WorkUnitId, signal: WorkUnitSignal): Promise<void> {
    if (signal !== 'stop') return Promise.resolve();
    this.deps.getClient()?.stopScoop(id);
    return Promise.resolve();
  }
}
