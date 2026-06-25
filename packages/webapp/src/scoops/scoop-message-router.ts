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

import { formatPromptWithAttachments, imageContentFromAttachments } from '../core/attachments.js';
import { createLogger } from '../core/logger.js';
import type { SessionStore } from '../core/session.js';
import type { ScoopContext } from './scoop-context.js';
import { emitScoopLifecycle } from './scoop-telemetry-hook.js';
import type { ChannelMessage, RegisteredScoop, ScoopTabState } from './types.js';

const log = createLogger('scoop-message-router');

export interface ScoopMessageRouterDeps {
  /** Live snapshot of registered scoops; the router reads `isCone`, `assistantLabel`, `folder`, `name`, `trigger`, `requiresTrigger`. */
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
    images?: ReturnType<typeof imageContentFromAttachments>
  ): Promise<void>;
  /** Notify the UI about a new incoming message (delegation / external lick chip). */
  notifyIncomingMessage(scoopJid: string, message: ChannelMessage): void;
  /** Surface a routing / queue-processing error on the orchestrator's error channel. */
  onError(jid: string, error: string): void;
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
    this.messageQueues.delete(jid);
    this.lastAgentTimestamp.delete(jid);
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

    // Check trigger requirement using the scoop's own trigger
    // Bypass trigger check for lick messages — they're explicitly routed to this scoop
    const isLick =
      message.channel === 'webhook' ||
      message.channel === 'cron' ||
      message.channel === 'fswatch' ||
      message.channel === 'sprinkle';
    if (!scoop.isCone && scoop.requiresTrigger && scoop.trigger && !isLick) {
      if (!message.content.includes(scoop.trigger)) {
        log.info('routeToScoop: trigger not found in content', {
          chatJid: message.chatJid,
          trigger: scoop.trigger,
          contentPreview: message.content.slice(0, 80),
        });
        return;
      }
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
    if (tab?.status === 'ready') {
      await this.processScoopQueue(message.chatJid);
    }
  }

  /** Process queued messages for a scoop. */
  async processScoopQueue(jid: string): Promise<void> {
    const queue = this.messageQueues.get(jid);
    if (!queue || queue.length === 0) {
      log.debug('processScoopQueue: empty queue', { jid });
      return;
    }

    const tab = this.deps.getTabs().get(jid);
    if (tab?.status !== 'ready') {
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

    log.debug('processScoopQueue: DB query', {
      jid,
      scoopName: scoop?.name,
      excludeName,
      since,
      dbMessageCount: messages.length,
      queueLength: queue.length,
    });

    if (messages.length === 0) {
      log.debug('processScoopQueue: no messages from DB, clearing queue', { jid });
      this.messageQueues.set(jid, []);
      return;
    }

    const formatted = messages
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
    const images = messages.flatMap((m) => imageContentFromAttachments(m.attachments));

    this.messageQueues.set(jid, []);

    const lastMsg = messages[messages.length - 1];
    this.lastAgentTimestamp.set(jid, lastMsg.timestamp);
    await this.deps.db.setState(`lastAgentTs_${jid}`, lastMsg.timestamp);

    await this.deps.sendPrompt(jid, formatted, lastMsg.senderId, lastMsg.senderName, images);
  }

  /** Start the message polling loop. */
  startMessageLoop(): void {
    if (this.pollInterval) return;

    // `setInterval` (no `window.` prefix) so this works in both page and
    // DedicatedWorker contexts. The standalone runtime runs the orchestrator
    // in a worker; `window` is undefined there.
    this.pollInterval = setInterval(() => {
      for (const jid of this.deps.getScoops().keys()) {
        const tab = this.deps.getTabs().get(jid);
        if (tab?.status === 'ready') {
          this.processScoopQueue(jid).catch((err) => {
            const message = err instanceof Error ? err.message : String(err);
            log.error('Message queue processing failed', { jid, error: message });
            this.deps.onError(jid, `Queue processing failed: ${message}`);
          });
        }
      }
    }, 2000);
  }

  /** Stop the message polling loop. */
  stopMessageLoop(): void {
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
    if (context) {
      context.clearMessages();
      const sessionStore = this.deps.getSessionStore();
      if (sessionStore) {
        const sessionId = context.getSessionId();
        await sessionStore.delete(sessionId).catch((err) => {
          log.warn('Failed to clear agent session for scoop', {
            jid,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
    }
    await this.deps.db.clearMessagesForScoop(jid).catch((err) => {
      log.warn('Failed to clear persisted channel history for scoop', {
        jid,
        error: err instanceof Error ? err.message : String(err),
      });
    });
    this.lastAgentTimestamp.delete(jid);
    this.messageQueues.set(jid, []);
    log.info('Scoop messages cleared', { jid });
  }

  /** Clear all messages from the orchestrator DB, agent sessions, and live agent contexts. */
  async clearAllMessages(): Promise<void> {
    await this.deps.db.clearAllMessages();
    const sessionStore = this.deps.getSessionStore();
    if (sessionStore) {
      await sessionStore.clearAll().catch((err) => {
        log.warn('Failed to clear agent sessions', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
    for (const ctx of this.deps.getContexts().values()) {
      ctx.clearMessages();
    }
    this.lastAgentTimestamp.clear();
    for (const jid of this.deps.getScoops().keys()) {
      this.messageQueues.set(jid, []);
    }
    this.deps.resetCostTracker();
    log.info('All messages cleared');
  }

  /** Clear all queued messages for a scoop (removes from both IndexedDB and in-memory queue). */
  async clearQueuedMessages(jid: string): Promise<void> {
    const queue = this.messageQueues.get(jid);
    if (queue && queue.length > 0) {
      for (const msg of queue) {
        await this.deps.db.deleteMessage(msg.id);
      }
      this.messageQueues.set(jid, []);
    }
  }

  /** Delete a queued message by ID (removes from both IndexedDB and in-memory queue). */
  async deleteQueuedMessage(jid: string, messageId: string): Promise<void> {
    const queue = this.messageQueues.get(jid);
    if (queue) {
      const idx = queue.findIndex((m) => m.id === messageId);
      if (idx !== -1) queue.splice(idx, 1);
    }
    await this.deps.db.deleteMessage(messageId);
  }
}
