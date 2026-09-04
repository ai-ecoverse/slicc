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
  /**
   * The last snapshot published per unit. Kept so a subscriber attaching
   * mid-turn can be seeded with it — the protocol's ordering guarantee is
   * that a `message` never reaches a listener that has not seen a snapshot.
   */
  private readonly lastSnapshots = new Map<WorkUnitId, WorkUnitSnapshot>();
  /**
   * A replay that arrived before its unit was in the roster. The kernel can
   * answer for a unit the page has not listed yet (a boot-time replay racing
   * the first `scoop-list`), and a dropped snapshot would leave a subscriber
   * with no transcript until something else asked for one.
   */
  private readonly orphanedReplays = new Map<
    WorkUnitId,
    { messages: readonly WorkUnitChatMessage[]; queuedIds: readonly string[] | undefined }
  >();
  /**
   * Units whose unanswered request has already been re-issued once. Bounds the
   * recovery in {@link snapshot} to a single extra ask per unit, and is cleared
   * for a unit as soon as one of its replays actually lands.
   */
  private readonly retriedSnapshots = new Set<WorkUnitId>();
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

  /** Emit a snapshot to this unit's subscribers and settle anyone awaiting it. */
  private publishSnapshot(id: WorkUnitId, snapshot: WorkUnitSnapshot): void {
    // The transport is answering for this unit again, so a future unanswered
    // request earns its own retry rather than inheriting this one's. Keep
    // clearing this mark: it is the fresh-budget rule, not the way a landed
    // replay suppresses the 5 s fallback — that timer is cancelled in
    // {@link snapshot} instead (#2859).
    this.retriedSnapshots.delete(id);
    this.lastSnapshots.set(id, snapshot);
    this.emit(id, { snapshot, type: 'snapshot' });
    const waiters = this.pendingSnapshots.get(id);
    if (!waiters) return;
    this.pendingSnapshots.delete(id);
    for (const resolve of waiters) resolve(snapshot);
  }

  /** Publish any replay that arrived before its unit was in the roster. */
  private drainOrphanedReplays(): void {
    for (const [id, replay] of this.orphanedReplays) {
      const snapshot = this.snapshotFor(id, replay.messages, replay.queuedIds);
      if (!snapshot) continue;
      this.orphanedReplays.delete(id);
      this.publishSnapshot(id, snapshot);
    }
  }

  /**
   * Answer for a unit whose replay request went unanswered.
   *
   * `subscribe` suppresses its own request while a snapshot is in flight, so
   * the timed-out ask was the ONLY one and nothing else will re-issue it. Left
   * alone, the shell would keep the PREVIOUS unit's transcript on screen while
   * the composer, the thread context and the navbar attention already belong
   * to the new one — the user reads B and sends into A.
   *
   * So: ask once more, and if that is dropped too, publish what we can for
   * this unit rather than leaving another unit's messages under its chrome.
   * Once, not a loop — a kernel that ignored two requests will not answer a
   * third, and a retry timer per selection would outlive the selection that
   * started it.
   */
  private recoverUnanswered(id: WorkUnitId): void {
    if (!this.unitListeners.has(id)) return;
    if (this.retriedSnapshots.has(id)) {
      this.publishRecovery(id);
      return;
    }
    this.retriedSnapshots.add(id);
    this.deps.getClient()?.requestScoopMessages(id);
    setTimeout(() => {
      // A replay landed in the meantime: `publishSnapshot` clears the mark.
      if (this.retriedSnapshots.has(id)) this.publishRecovery(id);
    }, SNAPSHOT_TIMEOUT_MS);
  }

  /**
   * Show this unit's OWN last-known transcript (or nothing) when the transport
   * will not answer for it.
   *
   * `queuedIds` is deliberately absent: it is the protocol's "nobody could
   * answer", which leaves the held pile standing instead of spending the
   * one-shot restore on a reconcile against a queue we never saw (#2354).
   *
   * Emitted rather than published: this snapshot is the CLIENT's answer, not
   * the transport's, so it must not become the cache a later subscriber is
   * seeded from as though the kernel had said it.
   */
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

  /** Forget one pending {@link snapshot} caller, and the set once it is empty. */
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
      // `queuedIds` rides the SAME envelope as the replay (#2354/#2362), so
      // the snapshot this publishes describes one instant of backend state.
      onScoopMessagesReplaced: (jid, messages, queuedIds) => {
        base.onScoopMessagesReplaced?.(jid, messages, queuedIds);
        const replayed = messages as unknown as readonly WorkUnitChatMessage[];
        const snapshot = this.snapshotFor(jid, replayed, queuedIds);
        if (snapshot) this.publishSnapshot(jid, snapshot);
        // Not in the roster yet — hold it for the next list update rather than
        // dropping a transcript the kernel already answered for.
        else this.orphanedReplays.set(jid, { messages: replayed, queuedIds });
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

  /**
   * Subscribe to one unit. The listener is SEEDED with the last snapshot this
   * client published, and when there is none the kernel is asked for a replay
   * — that is what makes the protocol's "a snapshot before any incremental
   * event" hold for a subscriber attaching mid-turn, instead of leaving it to
   * whoever calls {@link snapshot}.
   *
   * The request is side-effect-free for the shell: the panel's own handler
   * applies a replay only for the unit it is showing.
   */
  subscribe(id: WorkUnitId, listener: (event: WorkUnitClientEvent) => void): Unsubscribe {
    const listeners = this.unitListeners.get(id) ?? new Set<(event: WorkUnitClientEvent) => void>();
    listeners.add(listener);
    this.unitListeners.set(id, listeners);
    // A `snapshot(id)` in flight settles BOTH questions this branch asks. It
    // has already asked the transport, so asking again would replay the same
    // transcript twice — and its answer is about to arrive, so seeding the
    // listener with the cached one first would paint the unit's PREVIOUS
    // transcript and then immediately replace it: two wholesale renders, dips
    // disposed and rehydrated, a flash of stale history, and (on the leader)
    // the one-shot held-queue restore consumed against a stale `queuedIds`
    // (#2354). So a subscriber that joins an in-flight fetch just waits.
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

  /**
   * Select `id` and resolve with its replay. Selection is part of the call:
   * the kernel replays into the panel for whichever unit the page says it is
   * showing, and `queuedIds` rides that same envelope (#2362) so the queue
   * and the transcript describe one instant.
   *
   * A kernel that never answers resolves with the roster entry and no
   * messages rather than hanging — and with `queuedIds` ABSENT, which the
   * protocol reads as "nobody could answer" rather than "the queue is empty".
   * The 5 s fallback is cancelled when a replay lands (#2859); recovery is
   * only for a request that stayed unanswered.
   */
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
        // Drop THIS caller's waiter (not the set: a concurrent call for the
        // same unit still has its own pending promise and its own fallback).
        // Recover only if this waiter was still outstanding — a replay that
        // already landed settled it and cleared `retriedSnapshots`, and
        // recovering then would treat that success as a new unanswered
        // stretch and re-ask (#2859).
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
      // The caller's id when it has one: the backend queue is cancelled by it
      // and the panel's own copy of the message already carries it.
      messageId: input.messageId ?? `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      scoopJid: id,
      text: input.text,
      type: 'user-message',
      ...(input.steer ? { steer: true as const } : {}),
      ...(input.guestGate ? { guestGate: input.guestGate } : {}),
    } as Parameters<OffscreenClient['sendRaw']>[0]);
    return Promise.resolve();
  }

  /**
   * Pin one unit's model through the kernel's `set-scoop-model`, which
   * resolves a child to the cone that owns it (#2310). The kernel's ack is a
   * real `true`/`false`, so this transport never answers `undefined`.
   */
  setModel(id: WorkUnitId, model: WorkUnitModel): Promise<boolean | undefined> {
    const client = this.deps.getClient();
    if (!client) return Promise.reject(new Error('kernel client not attached'));
    return client.setScoopModel(id, model);
  }

  signal(id: WorkUnitId, signal: WorkUnitSignal): Promise<void> {
    if (signal !== 'stop') return Promise.resolve();
    const client = this.deps.getClient();
    // No kernel means the turn was NOT stopped. Resolving would report a stop
    // that never happened and let the composer drop its busy state on it.
    if (!client) return Promise.reject(new Error('kernel client not attached'));
    client.stopScoop(id);
    return Promise.resolve();
  }
}
