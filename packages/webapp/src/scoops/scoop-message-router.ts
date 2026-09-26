import { createLogger } from '../base/logger.js';
import { formatPromptWithAttachments, imageContentFromAttachments } from '../core/attachments.js';
import type { SessionStore } from '../core/session.js';
import type { TurnGuestGate } from '../sudo/types.js';
import type { ConversationAttachmentOverlay } from '../work-unit/conversation/types.js';
import { advanceMessageWatermark, parseMessageWatermark, serializeMessageWatermark } from './db.js';
import type { ClearSessionOptions, ScoopContext } from './scoop-context.js';
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
  getScoops(): Map<string, RegisteredScoop>;

  getTabs(): Map<string, ScoopTabState>;

  getContexts(): Map<string, ScoopContext>;

  createScoopTab(jid: string): Promise<void>;

  sendPrompt(
    jid: string,
    text: string,
    senderId: string,
    senderName: string,
    images?: ReturnType<typeof imageContentFromAttachments>,
    options?: { steer?: boolean; guestGates?: TurnGuestGate[] }
  ): Promise<void>;

  notifyIncomingMessage(scoopJid: string, message: ChannelMessage): void;

  recordSentAttachments?(jid: string, overlays: ConversationAttachmentOverlay[]): void;

  onError(jid: string, error: string): void;

  onLickBackpressure?(jid: string, info: { count: number; waitingMs: number }): void;

  getSessionStore(): SessionStore | null;

  resetCostTracker(): void;

  settleFoldedCost?(jid: string): void | Promise<void>;

  db: {
    saveMessage(msg: ChannelMessage): Promise<void>;
    deleteMessage(id: string): Promise<void>;
    clearMessagesForScoop(jid: string): Promise<void>;
    clearAllMessages(): Promise<void>;
    getMessagesSince(jid: string, since: string, excludeName: string): Promise<ChannelMessage[]>;
    setState(key: string, value: string): Promise<void>;
  };

  isExternalLickChannel(channel: ChannelMessage['channel']): boolean;
}

export class ScoopMessageRouter {
  private messageQueues: Map<string, ChannelMessage[]> = new Map();
  private lastAgentTimestamp: Map<string, string> = new Map();
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private debounceStates: Map<string, DebounceState> = new Map();

  private processing: Map<string, ProcessingState> = new Map();
  private busyDeferrals: Map<string, BusyDeferralState> = new Map();

  constructor(private deps: ScoopMessageRouterDeps) {}

  ensureQueue(jid: string): void {
    if (!this.messageQueues.has(jid)) {
      this.messageQueues.set(jid, []);
    }
  }

  setLastAgentTimestamp(jid: string, ts: string): void {
    this.lastAgentTimestamp.set(jid, ts);
  }

  forgetScoop(jid: string): void {
    this.cancelDebounce(jid);
    this.messageQueues.delete(jid);
    this.lastAgentTimestamp.delete(jid);
    this.clearBusyDeferral(jid);
  }

  async handleMessage(message: ChannelMessage): Promise<void> {
    log.info('handleMessage', {
      id: message.id,
      chatJid: message.chatJid,
      sender: message.senderName,
      channel: message.channel,
      contentPreview: message.content.slice(0, 80),
    });

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

    await this.routeToScoop(message);
  }

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

    this.deps.sendPrompt(scoopJid, prompt, 'cone', senderName).catch((err) => {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.error('Delegation failed', { scoopJid, error: errMsg });
      this.deps.onError(scoopJid, `Delegation failed: ${errMsg}`);
    });
  }

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

  private passesTriggerGate(scoop: RegisteredScoop | undefined, message: ChannelMessage): boolean {
    const isLick =
      message.channel === 'webhook' ||
      message.channel === 'cron' ||
      message.channel === 'fswatch' ||
      message.channel === 'sprinkle' ||
      message.channel === 'bash' ||
      message.channel === 'scoop-notify' ||
      message.channel === 'scoop-idle' ||
      message.channel === 'scoop-wait';
    return (
      !scoop ||
      scoop.parentJid === null ||
      !scoop.requiresTrigger ||
      !scoop.trigger ||
      isLick ||
      message.content.includes(scoop.trigger)
    );
  }

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

    const overlays: ConversationAttachmentOverlay[] = [];
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
        const body = formatPromptWithAttachments(m.content, m.attachments);
        if (m.attachments?.length) {
          overlays.push({
            id: m.id,
            timestamp: date.getTime(),
            body,
            attachments: [...m.attachments],
          });
        }
        return `[${time}] ${m.senderName}: ${body}`;
      })
      .join('\n');
    if (overlays.length > 0) this.deps.recordSentAttachments?.(jid, overlays);
    const images = eligibleMessages.flatMap((m) => imageContentFromAttachments(m.attachments));

    this.messageQueues.set(jid, []);

    const lastMsg = eligibleMessages[eligibleMessages.length - 1];

    const nextWatermark = serializeMessageWatermark(
      advanceMessageWatermark(parseMessageWatermark(since), messages)
    );
    this.lastAgentTimestamp.set(jid, nextWatermark);
    await this.deps.db.setState(`lastAgentTs_${jid}`, nextWatermark);

    const steer = eligibleMessages.some((m) => m.steer);

    const seen = new Set<string>();
    const guestGates = [];
    for (const message of eligibleMessages) {
      if (!message.guestGate) continue;
      const key = JSON.stringify(message.guestGate);
      if (seen.has(key)) continue;
      seen.add(key);
      guestGates.push(message.guestGate);
    }

    await this.deps.sendPrompt(jid, formatted, lastMsg.senderId, lastMsg.senderName, images, {
      steer,
      ...(guestGates.length > 0 ? { guestGates } : {}),
    });
  }

  startMessageLoop(): void {
    if (this.pollInterval) return;

    this.pollInterval = setInterval(() => {
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

  stopMessageLoop(): void {
    this.cancelDebounces();
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  async clearScoopMessages(
    jid: string,
    context: ScoopContext | undefined,
    options: ClearSessionOptions = {}
  ): Promise<void> {
    this.cancelDebounce(jid);

    await this.deps.settleFoldedCost?.(jid);
    if (context) {
      await context.clearSession(options).catch((err) => {
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

  getQueuedMessageIds(jid: string): string[] {
    return (this.messageQueues.get(jid) ?? []).map((message) => message.id);
  }

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
