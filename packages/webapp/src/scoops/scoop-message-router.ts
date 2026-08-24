/**
 * ScoopMessageRouter - owns per-scoop message queueing, routing, and
 * the polling loop that drives queued messages into each scoop's agent.
 *
 * Extracted from `Orchestrator` so the in-memory queues, the
 * `lastAgentTimestamp` high-water mark, and the `setInterval`-driven
 * processing loop live next to the data they own. Lookups into the
 * scoop registry / tabs / contexts and side-effects (createScoopTab
 * retry, sendPrompt dispatch, callbacks) are injected via
 * {@link ScoopMessageRouterDeps} so this module stays free of
 * orchestrator coupling.
 */

import { createLogger } from '../base/logger.js';
import { formatPromptWithAttachments, imageContentFromAttachments } from '../core/attachments.js';
import type { SessionStore } from '../core/session.js';
import { advanceMessageWatermark, parseMessageWatermark, serializeMessageWatermark } from './db.js';
import type { ScoopContext } from './scoop-context.js';
import { emitScoopLifecycle } from './scoop-telemetry-hook.js';
import type { ChannelMessage, RegisteredScoop, ScoopTabState } from './types.js';

const log = createLogger('scoop-message-router');
export const SCOOP_QUEUE_DEBOUNCE_MS = 1000;
export const SCOOP_QUEUE_MAX_COALESCE_MS = 3000;
export const SCOOP_DEFERRAL_STARVATION_MS = 300_000;

interface DebounceWaiter {
  messageId: string;
  resolve(): void;
  reject(error: unknown): void;
}

interface DebounceState {
  startedAt: number;
  timer?: ReturnType<typeof setTimeout>;
  waiters: DebounceWaiter[];
}

interface ProcessingState {
  rerun: boolean;
  done: Promise<void>;
}

interface BusyDeferralState {
  startedAt: number;
  reported: boolean;
  count: number;
}

export interface ScoopMessageRouterDeps {
  /** Live snapshot of registered scoops; the router reads `parentJid`, `assistantLabel`, `folder`, `name`, `trigger`, `requiresTrigger`. */
  getScoops(): Map<string, RegisteredScoop>;
  /** Live snapshot of tab state by jid. */
  getTabs(): Map<string, ScoopTabState>;
  /** Live snapshot of scoop contexts by jid. */
  getContexts(): Map<string, ScoopContext>;
  /** Re-init a scoop's tab/context when its previous init failed (error-state retry). */
  createScoopTab(jid: string): Promise<void>;
  /** Dispatch a formatted prompt to the scoop's agent. */
  sendPrompt(
    jid: string,
    text: string,
    senderId: string,
    senderName: string,
    images?: ReturnType<typeof imageContentFromAttachments>,
    options?: { steer?: boolean }
  ): Promise<void>;
  /** Notify the UI about a new incoming message (delegation / external lick chip). */
  notifyIncomingMessage(scoopJid: string, message: ChannelMessage): void;
  /** Surface a routing / queue-processing error on the orchestrator's error channel. */
  onError(jid: string, error: string): void;
  /** Report or clear sustained lick backpressure without using the error channel. */
  onLickBackpressure?(jid: string, info: { count: number; waitingMs: number }): void;
  /** Live SessionStore (or null before init). The single-scoop wipe uses it to drop the agent session. */
  getSessionStore(): SessionStore | null;
  /** Hook to reset the per-session cost tracker when clearing every scoop's history. */
  resetCostTracker(): void;
  /** DB seam — kept injectable so tests can stub without monkey-patching the module-scope import. */
  db: {
    saveMessage(msg: ChannelMessage): Promise<void>;
    deleteMessage(id: string): Promise<void>;
    clearMessagesForScoop(jid: string): Promise<void>;
    clearAllMessages(): Promise<void>;
    getMessagesSince(jid: string, since: string, excludeName: string): Promise<ChannelMessage[]>;
    setState(key: string, value: string): Promise<void>;
  };
  /** Channel predicate — fires `notifyIncomingMessage` on inbound external licks. */
  isExternalLickChannel(channel: ChannelMessage['channel']): boolean;
}

export class ScoopMessageRouter {
  private messageQueues: Map<string, ChannelMessage[]> = new Map();
  private lastAgentTimestamp: Map<string, string> = new Map();
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private debounceStates: Map<string, DebounceState> = new Map();
  /**
   * Per-jid re-entrancy guard for {@link processScoopQueue}. While a run is in
   * flight for a jid, its entry lives here; a re-entrant call sets `rerun` so
   * the in-flight run loops once more instead of executing concurrently (which
   * would let two invocations read the same stale high-water mark and format
   * overlapping slices of the same rows) or being dropped (which would lose a
   * message that arrived mid-flight). `done` settles when that run's drain
   * finishes, so a coalesced caller can await the turn its message lands in.
   * Keyed by jid so distinct scoops still process in parallel.
   */
  private processing: Map<string, ProcessingState> = new Map();
  private busyDeferrals: Map<string, BusyDeferralState> = new Map();

  constructor(private deps: ScoopMessageRouterDeps) {}

  /** Prime the per-scoop queue. Called from `registerScoop` and during `init()` restore. */
  ensureQueue(jid: string): void {
    if (!this.messageQueues.has(jid)) {
      this.messageQueues.set(jid, []);
    }
  }

  /** Restore the persisted high-water mark for a scoop on boot. */
  setLastAgentTimestamp(jid: string, ts: string): void {
    this.lastAgentTimestamp.set(jid, ts);
  }

  /** Drop all per-scoop state on unregister. */
  forgetScoop(jid: string): void {
    this.cancelDebounce(jid);
    this.messageQueues.delete(jid);
    this.lastAgentTimestamp.delete(jid);
    this.clearBusyDeferral(jid);
  }

  /** Handle incoming message from a channel. */
  async handleMessage(message: ChannelMessage): Promise<void> {
    log.info('handleMessage', {
      id: message.id,
      chatJid: message.chatJid,
      sender: message.senderName,
      channel: message.channel,
      contentPreview: message.content.slice(0, 80),
    });

    // Surface external lick events (webhook / cron / sprinkle / fswatch /
    // session-reload / navigate / upgrade / cherry / workflow / sudo-request)
    // to the UI as a chat chip the moment they arrive. Without this fire the
    // lick persists to IDB and queues for the agent, but the chat panel only
    // learns about it on session reload. Scoop-lifecycle channels
    // (scoop-notify, scoop-idle, scoop-wait, scoop-error, delegation) are
    // intentionally excluded — their builders fire `onIncomingMessage`
    // explicitly next to the point they create the message, so they would
    // double-fire here.
    if (this.deps.isExternalLickChannel(message.channel)) {
      try {
        this.deps.notifyIncomingMessage(message.chatJid, message);
      } catch (err) {
        log.warn('onIncomingMessage for external lick channel threw', {
          channel: message.channel,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    await this.deps.db.saveMessage(message);

    // Route to the direct target (chatJid) only.
    // No @mention scanning — the cone delegates to scoops via the delegate_to_scoop tool,
    // which lets it add context/clarification before routing.
    await this.routeToScoop(message);
  }

  /** Delegate a prompt directly to a scoop's agent. Used by the delegate_to_scoop tool. */
  async delegateToScoop(scoopJid: string, prompt: string, senderName: string): Promise<void> {
    const scoop = this.deps.getScoops().get(scoopJid);
    if (!scoop) throw new Error(`Scoop not found: ${scoopJid}`);

    emitScoopLifecycle('feed', scoop.folder);

    const msg: ChannelMessage = {
      id: `delegate-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      chatJid: scoopJid,
      senderId: 'cone',
      senderName,
      content: prompt,
      timestamp: new Date().toISOString(),
      fromAssistant: true,
      channel: 'delegation',
    };
    await this.deps.db.saveMessage(msg);

    this.deps.notifyIncomingMessage(scoopJid, msg);

    log.info('Delegating to scoop', {
      scoopJid,
      scoopName: scoop.name,
      promptLength: prompt.length,
    });

    // Fire-and-forget: don't await the scoop's agent loop.
    // The cone's tool call returns immediately so the cone can finish its turn.
    // The scoop processes in the background; completion notification routes back to cone.
    this.deps.sendPrompt(scoopJid, prompt, 'cone', senderName).catch((err) => {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.error('Delegation failed', { scoopJid, error: errMsg });
      this.deps.onError(scoopJid, `Delegation failed: ${errMsg}`);
    });
  }

  /** Route a message to the scoop specified by `message.chatJid`. */
  private async routeToScoop(message: ChannelMessage): Promise<void> {
    const scoop = this.deps.getScoops().get(message.chatJid);
    if (!scoop) {
      log.info('routeToScoop: unregistered target', { chatJid: message.chatJid });
      return;
    }

    if (!this.passesTriggerGate(scoop, message)) {
      log.info('routeToScoop: trigger not found in content', {
        chatJid: message.chatJid,
        trigger: scoop.trigger,
        contentPreview: message.content.slice(0, 80),
      });
      return;
    }

    const queue = this.messageQueues.get(message.chatJid) ?? [];
    queue.push(message);
    this.messageQueues.set(message.chatJid, queue);

    let tab = this.deps.getTabs().get(message.chatJid);
    log.debug('routeToScoop: queued', {
      chatJid: message.chatJid,
      scoopName: scoop.name,
      tabStatus: tab?.status ?? 'no-tab',
      queueLength: queue.length,
    });
    if (tab?.status === 'error') {
      log.info('routeToScoop: tab in error state, retrying init', { chatJid: message.chatJid });
      try {
        await this.deps.createScoopTab(message.chatJid);
        tab = this.deps.getTabs().get(message.chatJid);
      } catch {
        log.warn('routeToScoop: retry init failed', { chatJid: message.chatJid });
      }
    }
    if (tab?.status !== 'ready' && tab?.status !== 'processing') return;

    if (this.deps.isExternalLickChannel(message.channel)) {
      await this.scheduleScoopQueue(message.chatJid, message.id);
      return;
    }

    await this.flushScoopQueue(message.chatJid);
  }

  /**
   * A `requiresTrigger` scoop only sees messages containing its `@trigger` —
   * except for machine-addressed licks, which nothing types a trigger into.
   *
   * Deliberately narrower than `EXTERNAL_LICK_CHANNELS`: this is the set of
   * events that address a scoop directly, not every channel that formats as a
   * lick. `bash` belongs here because a detached job's completion is the result
   * of work that scoop itself started — dropping it would silently break the
   * promise the tool made when it returned the job id.
   */
  private passesTriggerGate(scoop: RegisteredScoop | undefined, message: ChannelMessage): boolean {
    const isLick =
      message.channel === 'webhook' ||
      message.channel === 'cron' ||
      message.channel === 'fswatch' ||
      message.channel === 'sprinkle' ||
      message.channel === 'bash';
    return (
      !scoop ||
      scoop.parentJid === null ||
      !scoop.requiresTrigger ||
      !scoop.trigger ||
      isLick ||
      message.content.includes(scoop.trigger)
    );
  }

  /** Restart one scoop's trailing window, capped so sustained licks cannot starve. */
  private scheduleScoopQueue(jid: string, messageId: string): Promise<void> {
    const state = this.debounceStates.get(jid) ?? {
      startedAt: Date.now(),
      waiters: [],
    };
    if (state.timer !== undefined) clearTimeout(state.timer);

    const done = new Promise<void>((resolve, reject) => {
      state.waiters.push({ messageId, resolve, reject });
    });
    const remainingMaxWait = Math.max(
      0,
      SCOOP_QUEUE_MAX_COALESCE_MS - (Date.now() - state.startedAt)
    );
    const delay = Math.min(SCOOP_QUEUE_DEBOUNCE_MS, remainingMaxWait);
    state.timer = setTimeout(() => {
      state.timer = undefined;
      this.flushScoopQueue(jid).catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        log.error('Debounced message queue processing failed', { jid, error: message });
        this.deps.onError(jid, `Queue processing failed: ${message}`);
      });
    }, delay);
    this.debounceStates.set(jid, state);
    return done;
  }

  /** Drain now and settle every debounced caller whose batch was consumed. */
  private async flushScoopQueue(jid: string): Promise<void> {
    const state = this.takeDebounce(jid);
    if (state && this.processing.has(jid) && this.shouldDeferQueuedLicks(jid)) {
      for (const waiter of state.waiters) waiter.resolve();
      this.recordBusyDeferral(jid, this.messageQueues.get(jid)?.length ?? 0);
      return;
    }
    try {
      await this.processScoopQueue(jid);
      for (const waiter of state?.waiters ?? []) waiter.resolve();
    } catch (err) {
      for (const waiter of state?.waiters ?? []) waiter.reject(err);
      throw err;
    }
  }

  /** Flush work retained while a scoop was busy, using the normal serialized drain path. */
  async flushOnIdle(jid: string): Promise<void> {
    if (!this.messageQueues.has(jid)) return;
    try {
      await this.flushScoopQueue(jid);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error('Idle message queue processing failed', { jid, error: message });
      this.deps.onError(jid, `Queue processing failed: ${message}`);
    }
  }

  private shouldDeferQueuedLicks(jid: string): boolean {
    const queue = this.messageQueues.get(jid);
    return (
      queue !== undefined &&
      queue.length > 0 &&
      queue.every((message) => this.deps.isExternalLickChannel(message.channel))
    );
  }

  private recordBusyDeferral(jid: string, count?: number): void {
    const state = this.busyDeferrals.get(jid) ?? {
      startedAt: Date.now(),
      reported: false,
      count: count ?? 0,
    };
    if (count !== undefined) state.count = count;
    this.busyDeferrals.set(jid, state);
    const waitingMs = Date.now() - state.startedAt;
    if (state.reported || waitingMs < SCOOP_DEFERRAL_STARVATION_MS) return;

    state.reported = true;
    const error = `Lick queue remained deferred while scoop was busy for ${SCOOP_DEFERRAL_STARVATION_MS / 1000}s`;
    log.warn('Busy lick queue may be starved', { jid, error });
    this.emitLickBackpressure(jid, { count: state.count, waitingMs });
  }

  private clearBusyDeferral(jid: string): void {
    const state = this.busyDeferrals.get(jid);
    this.busyDeferrals.delete(jid);
    if (!state?.reported) return;
    this.emitLickBackpressure(jid, {
      count: 0,
      waitingMs: Date.now() - state.startedAt,
    });
  }

  private emitLickBackpressure(jid: string, info: { count: number; waitingMs: number }): void {
    try {
      this.deps.onLickBackpressure?.(jid, info);
    } catch (err) {
      log.warn('Lick backpressure callback failed', {
        jid,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private takeDebounce(jid: string): DebounceState | undefined {
    const state = this.debounceStates.get(jid);
    if (state?.timer !== undefined) clearTimeout(state.timer);
    this.debounceStates.delete(jid);
    return state;
  }

  private cancelDebounce(jid: string): void {
    const state = this.takeDebounce(jid);
    for (const waiter of state?.waiters ?? []) waiter.resolve();
  }

  private cancelDebounces(): void {
    for (const jid of this.debounceStates.keys()) this.cancelDebounce(jid);
  }

  private cancelDebounceWaiter(jid: string, messageId: string): void {
    const state = this.debounceStates.get(jid);
    if (!state) return;
    const remaining: DebounceWaiter[] = [];
    for (const waiter of state.waiters) {
      if (waiter.messageId === messageId) waiter.resolve();
      else remaining.push(waiter);
    }
    state.waiters = remaining;
    if (remaining.length === 0) this.cancelDebounce(jid);
  }

  /**
   * Process queued messages for a scoop, serialized per jid.
   *
   * A burst of inbound messages fires one call per message; without this guard
   * every concurrent call reads the same stale `lastAgentTimestamp` across the
   * `await db.getMessagesSince` and formats an overlapping slice of the same
   * rows, so each message reaches the agent multiple times. The guard runs the
   * real work ({@link runScoopQueue}) one turn at a time per jid and coalesces
   * re-entrant calls into a single rerun, so a message that arrives mid-flight
   * is still delivered exactly once.
   *
   * A coalesced caller awaits the active drain rather than returning as soon as
   * it has flagged the rerun: {@link runScoopQueue} clears the shared queue
   * after taking its DB snapshot, so an early return would let the caller
   * believe its message was handled while the rerun that actually delivers it
   * is still pending. The drain's failure belongs to the owning caller, which
   * rethrows it, so it is swallowed on the coalesced path.
   */
  async processScoopQueue(jid: string): Promise<void> {
    const inFlight = this.processing.get(jid);
    if (inFlight) {
      inFlight.rerun = true;
      await inFlight.done.catch(() => {});
      return;
    }

    const state: ProcessingState = {
      rerun: false,
      done: Promise.resolve(),
    };
    this.processing.set(jid, state);
    state.done = this.drainScoopQueue(jid, state);
    return state.done;
  }

  /**
   * Run turns for a jid until no rerun is pending, then release the guard.
   *
   * A turn that throws (e.g. `sendPrompt` rejects) must not swallow a rerun
   * requested while it was in flight: the coalesced message is already
   * persisted but the in-memory queue was cleared, so it would sit stranded
   * until unrelated traffic happens to enqueue work — long enough for a
   * coalesced sudo request to reach its timeout. Turn errors are therefore held
   * back until the loop drains, and the first one is rethrown to the owning
   * caller. The `finally` releases the guard even on that path so a failed turn
   * cannot wedge the queue.
   */
  private async drainScoopQueue(jid: string, state: ProcessingState): Promise<void> {
    let failed = false;
    let firstError: unknown;
    try {
      do {
        state.rerun = false;
        try {
          await this.runScoopQueue(jid);
        } catch (err) {
          if (!failed) {
            failed = true;
            firstError = err;
          }
        }
      } while (state.rerun);
    } finally {
      this.processing.delete(jid);
    }
    if (failed) throw firstError;
  }

  /** Drain one turn of a scoop's queue. Callers must go through {@link processScoopQueue}. */
  private async runScoopQueue(jid: string): Promise<void> {
    const queue = this.messageQueues.get(jid);
    if (!queue) {
      log.debug('processScoopQueue: queue not registered', { jid });
      return;
    }

    const tab = this.deps.getTabs().get(jid);
    if (tab?.status !== 'ready' && tab?.status !== 'processing') {
      log.debug('processScoopQueue: tab not ready', { jid, status: tab?.status ?? 'no-tab' });
      return;
    }

    // Get all messages since last agent interaction.
    // Exclude messages from this scoop's own assistant (prevents processing own responses).
    // Use the scoop's assistantLabel, not the global config name, so cone→scoop relays aren't filtered.
    const scoop = this.deps.getScoops().get(jid);
    const excludeName = scoop?.assistantLabel ?? jid;
    const since = this.lastAgentTimestamp.get(jid) ?? '';
    const messages = await this.deps.db.getMessagesSince(jid, since, excludeName);
    const eligibleMessages = messages.filter((message) => this.passesTriggerGate(scoop, message));

    log.debug('processScoopQueue: DB query', {
      jid,
      scoopName: scoop?.name,
      excludeName,
      since,
      dbMessageCount: messages.length,
      eligibleMessageCount: eligibleMessages.length,
      queueLength: queue.length,
    });

    if (messages.length === 0) {
      log.debug('processScoopQueue: no messages from DB, clearing queue', { jid });
      this.messageQueues.set(jid, []);
      this.clearBusyDeferral(jid);
      return;
    }

    if (eligibleMessages.length === 0) {
      log.debug('processScoopQueue: no messages passed trigger gate, clearing queue', { jid });
      this.messageQueues.set(jid, []);
      this.clearBusyDeferral(jid);
      const nextWatermark = serializeMessageWatermark(
        advanceMessageWatermark(parseMessageWatermark(since), messages)
      );
      this.lastAgentTimestamp.set(jid, nextWatermark);
      await this.deps.db.setState(`lastAgentTs_${jid}`, nextWatermark);
      return;
    }

    const isPureLickBatch = eligibleMessages.every((message) =>
      this.deps.isExternalLickChannel(message.channel)
    );
    if (isPureLickBatch && this.deps.getContexts().get(jid)?.isBusy) {
      log.debug('processScoopQueue: deferring lick batch while scoop is busy', {
        jid,
        messageCount: eligibleMessages.length,
      });
      this.recordBusyDeferral(jid, eligibleMessages.length);
      return;
    }

    this.clearBusyDeferral(jid);

    const formatted = eligibleMessages
      .map((m) => {
        const date = new Date(m.timestamp);
        const time = date.toLocaleString('en-US', {
          month: 'short',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
          hour12: true,
        });
        return `[${time}] ${m.senderName}: ${formatPromptWithAttachments(m.content, m.attachments)}`;
      })
      .join('\n');
    const images = eligibleMessages.flatMap((m) => imageContentFromAttachments(m.attachments));

    this.messageQueues.set(jid, []);

    const lastMsg = eligibleMessages[eligibleMessages.length - 1];
    // Advance the high-water mark by the composite (timestamp, id) cursor so a
    // batch that shares one millisecond is consumed exactly once: the id set
    // accumulated at the max ms lets a later pass skip already-delivered rows
    // without dropping same-ms siblings (which a bare-timestamp mark would).
    const nextWatermark = serializeMessageWatermark(
      advanceMessageWatermark(parseMessageWatermark(since), messages)
    );
    this.lastAgentTimestamp.set(jid, nextWatermark);
    await this.deps.db.setState(`lastAgentTs_${jid}`, nextWatermark);

    // One steering send anywhere in the batch steers the whole batch — the
    // batch is delivered as a single prompt, so it cannot be split into a
    // steered and a queued half.
    const steer = eligibleMessages.some((m) => m.steer);

    await this.deps.sendPrompt(jid, formatted, lastMsg.senderId, lastMsg.senderName, images, {
      steer,
    });
  }

  /** Start the message polling loop. */
  startMessageLoop(): void {
    if (this.pollInterval) return;

    // `setInterval` (no `window.` prefix) so this works in both page and
    // DedicatedWorker contexts. The standalone runtime runs the orchestrator
    // in a worker; `window` is undefined there.
    this.pollInterval = setInterval(() => {
      // `getTabs()` is a per-tick snapshot; read it once per tick, not per scoop.
      const tabs = this.deps.getTabs();
      for (const jid of this.deps.getScoops().keys()) {
        const tab = tabs.get(jid);
        this.recordBusyDeferralIfPresent(jid);
        const queueHasMessages = (this.messageQueues.get(jid)?.length ?? 0) > 0;
        if (tab?.status === 'ready' && queueHasMessages && !this.debounceStates.has(jid)) {
          this.processScoopQueue(jid).catch((err) => {
            const message = err instanceof Error ? err.message : String(err);
            log.error('Message queue processing failed', { jid, error: message });
            this.deps.onError(jid, `Queue processing failed: ${message}`);
          });
        }
      }
    }, 2000);
  }

  private recordBusyDeferralIfPresent(jid: string): void {
    if (this.busyDeferrals.has(jid)) this.recordBusyDeferral(jid);
  }

  /** Stop the message polling loop. */
  stopMessageLoop(): void {
    this.cancelDebounces();
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  /**
   * Clear messages for a single scoop: persisted history, agent session,
   * live agent in-memory history, and the in-memory queue. The caller
   * passes the live context so the in-process agent's transcript is
   * cleared too.
   */
  async clearScoopMessages(jid: string, context: ScoopContext | undefined): Promise<void> {
    this.cancelDebounce(jid);
    if (context) {
      // Clears the live list AND both durable representations — the canonical
      // work-unit record and the legacy agent session (#2275). Deleting only
      // the legacy one would leave the record standing, and a restore prefers
      // the record: "New chat" would come back on the next reload.
      await context.clearSession().catch((err) => {
        log.warn('Failed to clear the durable conversation for scoop', {
          jid,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
    await this.deps.db.clearMessagesForScoop(jid).catch((err) => {
      log.warn('Failed to clear persisted channel history for scoop', {
        jid,
        error: err instanceof Error ? err.message : String(err),
      });
    });
    this.lastAgentTimestamp.delete(jid);
    this.messageQueues.set(jid, []);
    this.clearBusyDeferral(jid);
    log.info('Scoop messages cleared', { jid });
  }

  /** Clear all messages from the orchestrator DB, agent sessions, and live agent contexts. */
  async clearAllMessages(): Promise<void> {
    this.cancelDebounces();
    await this.deps.db.clearAllMessages();
    const sessionStore = this.deps.getSessionStore();
    if (sessionStore) {
      await sessionStore.clearAll().catch((err) => {
        log.warn('Failed to clear agent sessions', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
    await Promise.all(
      [...this.deps.getContexts().values()].map((ctx) =>
        ctx.clearSession().catch((err) => {
          log.warn('Failed to clear a durable conversation', {
            error: err instanceof Error ? err.message : String(err),
          });
        })
      )
    );
    this.lastAgentTimestamp.clear();
    for (const jid of this.busyDeferrals.keys()) this.clearBusyDeferral(jid);
    for (const jid of this.deps.getScoops().keys()) {
      this.messageQueues.set(jid, []);
    }
    this.deps.resetCostTracker();
    log.info('All messages cleared');
  }

  /** Clear all queued messages for a scoop (removes from both IndexedDB and in-memory queue). */
  async clearQueuedMessages(jid: string): Promise<void> {
    this.cancelDebounce(jid);
    const queue = this.messageQueues.get(jid) ?? [];
    const scoop = this.deps.getScoops().get(jid);
    const excludeName = scoop?.assistantLabel ?? jid;
    const since = this.lastAgentTimestamp.get(jid) ?? '';
    const persisted = await this.deps.db.getMessagesSince(jid, since, excludeName);
    const ids = new Set([...queue, ...persisted].map((message) => message.id));
    for (const id of ids) {
      await this.deps.db.deleteMessage(id);
    }
    this.messageQueues.set(jid, []);
    this.clearBusyDeferral(jid);
  }

  /** Delete a queued message by ID (removes from both IndexedDB and in-memory queue). */
  async deleteQueuedMessage(jid: string, messageId: string): Promise<void> {
    const queue = this.messageQueues.get(jid);
    if (queue) {
      const idx = queue.findIndex((m) => m.id === messageId);
      if (idx !== -1) queue.splice(idx, 1);
      if (queue.length === 0) this.clearBusyDeferral(jid);
    }
    this.cancelDebounceWaiter(jid, messageId);
    await this.deps.db.deleteMessage(messageId);
  }
}
