/**
 * Durable conversation history for one work unit (#1987).
 *
 * Owns: the session id and creation timestamp, the debounce timer behind
 * mid-turn checkpoints, and the restore path (including orphan stripping).
 *
 * Changes when the durable representation of a conversation changes — the
 * record shape, the checkpoint cadence, what a restore has to repair.
 *
 * The durable representation is the canonical work-unit record
 * (`work-unit/conversation/`, #2275) and nothing else: since #2365 the legacy
 * `agent-sessions` store is neither written nor read here. It stays on disk,
 * frozen at the cut, as the input of the one-time migration; the only thing
 * this module still does to it is delete a unit's row when the user clears
 * that conversation, so a later migration pass cannot bring it back.
 */

import { stripOrphanedToolResults } from '../../core/context-compaction.js';
import type { AgentMessage } from '../../core/index.js';
import { createLogger } from '../../core/index.js';
import type { SessionStore } from '../../core/session.js';
import { toAgentMessages } from '../../work-unit/conversation/derive.js';
import type {
  ConversationIdentity,
  WorkUnitConversationStore,
} from '../../work-unit/conversation/store.js';

const log = createLogger('scoop-context');

/**
 * Debounce for mid-turn session checkpoints (#1987): long enough to coalesce
 * a tool burst into one IndexedDB write, short enough that an abnormal turn
 * death loses at most a moment of completed messages.
 */
export const SESSION_CHECKPOINT_DEBOUNCE_MS = 1_000;

/**
 * Where this unit's conversation lives. `null` when the unit has no canonical
 * store (a test double, a context built before the orchestrator): it then
 * persists nothing.
 */
export interface CanonicalConversationDeps {
  store: WorkUnitConversationStore;
  identity: ConversationIdentity;
}

export interface SessionPersistenceDeps {
  /** The frozen legacy `agent-sessions` store — only ever deleted from. */
  store: SessionStore | null;
  /**
   * The unit's legacy `agent-sessions` key. The outgoing Adobe
   * `X-Session-Id` is computed separately.
   */
  sessionId: string;
  /** Unit folder, for log correlation only. */
  folder: string;
  /** The agent's live message list, or `undefined` before/after the agent. */
  getMessages: () => AgentMessage[] | undefined;
  isDisposed: () => boolean;
  /** Surfaced to the user when a restore fails; the unit starts fresh. */
  onRestoreError: (message: string) => void;
  /** Canonical conversation record (#2275); omitted, nothing is persisted. */
  canonical?: CanonicalConversationDeps | null;
}

export class SessionPersistence {
  /** Pending debounced mid-turn session write (#1987); null when idle. */
  private timer: ReturnType<typeof setTimeout> | null = null;
  private createdAt = 0;

  constructor(private readonly deps: SessionPersistenceDeps) {}

  get sessionId(): string {
    return this.deps.sessionId;
  }

  /**
   * Restore this unit's conversation from its canonical record. A unit with
   * no record — never fed, just cleared, or a canonical database that will
   * not answer — starts fresh; there is no second store to consult (#2365).
   * A `ui-projection` record also restores nothing, by design: its rendered
   * transcript is shown to the user, never replayed to the model.
   */
  async restore(): Promise<AgentMessage[]> {
    const canonical = this.deps.canonical;
    if (!canonical) return [];
    let record: Awaited<ReturnType<WorkUnitConversationStore['load']>> = null;
    try {
      record = await canonical.store.load(canonical.identity.key);
    } catch (err) {
      // The store swallows its own read errors; this is the belt to those
      // braces, so a failed read can never fail the unit's init.
      log.error('Failed to restore the conversation', {
        folder: this.deps.folder,
        error: err instanceof Error ? err.message : String(err),
      });
      this.deps.onRestoreError(`Conversation history could not be restored. Starting fresh.`);
      return [];
    }
    const messages = toAgentMessages(record);
    if (record) this.createdAt = record.createdAt;
    if (messages.length === 0) return [];
    const restored = stripOrphanedToolResults(messages);
    log.info('Restored conversation from the canonical work-unit record', {
      folder: this.deps.folder,
      messageCount: restored.length,
      droppedOrphans: messages.length - restored.length,
    });
    return restored;
  }

  /**
   * Persist the agent's current message list to the session store (#1987).
   * Fire-and-forget with logging; safe to call from any point in a turn —
   * completed messages are immutable, so a mid-turn snapshot is always a
   * consistent prefix of the final history.
   */
  persistNow(fallbackMessages?: AgentMessage[]): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const persistMessages = this.deps.getMessages() ?? fallbackMessages ?? [];
    if (persistMessages.length === 0) return;
    const canonical = this.deps.canonical;
    if (!canonical) return;
    if (!this.createdAt) this.createdAt = Date.now();
    void canonical.store
      .syncAgentMessages(canonical.identity, persistMessages, { createdAt: this.createdAt })
      .catch((err) => {
        log.error('Failed to save the canonical conversation record', {
          folder: this.deps.folder,
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }

  /**
   * Forget this unit's durable conversation — "New chat" / `clear-chat`.
   *
   * The canonical record goes, and so does the unit's frozen legacy row:
   * a later migration pass (a schema bump re-arms it) would otherwise import
   * the pre-cut history the user just cleared. Any pending checkpoint is
   * cancelled first so an in-flight debounce cannot write the history back
   * moments later.
   */
  async clear(): Promise<void> {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.createdAt = 0;
    const canonical = this.deps.canonical;
    if (canonical) await canonical.store.delete(canonical.identity.key);
    try {
      await this.deps.store?.delete(this.deps.sessionId);
    } catch (err) {
      log.warn('Failed to clear the legacy agent session', {
        folder: this.deps.folder,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Debounced mid-turn checkpoint (#1987). Persistence used to happen only
   * at `agent_end`, so a turn that aborted abnormally — compaction failure,
   * worker death, page reload — lost EVERY message since the previous turn:
   * in production a multi-minute tool turn existed only in the page's memory
   * and a reload silently dropped it. Each completed message now schedules a
   * write; the debounce keeps tool-heavy turns from write-storming IndexedDB.
   */
  schedule(): void {
    if (this.deps.isDisposed()) return;
    if (!this.deps.canonical) return;
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.deps.isDisposed()) this.persistNow();
    }, SESSION_CHECKPOINT_DEBOUNCE_MS);
  }
}
