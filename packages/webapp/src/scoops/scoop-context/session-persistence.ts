/**
 * Durable conversation history for one work unit (#1987).
 *
 * Owns: the session id and creation timestamp, the debounce timer behind
 * mid-turn checkpoints, and the restore path (including orphan stripping).
 *
 * Changes when the durable representation of a conversation changes — the
 * record shape, the checkpoint cadence, what a restore has to repair.
 *
 * Since #2275 there are TWO durable representations and this module owns the
 * window between them: every write goes to the canonical work-unit record
 * (`work-unit/conversation/`) AND to the legacy `agent-sessions` store, while
 * every read prefers the canonical record and falls back to the legacy one
 * whenever it is absent, unreadable, or empty. Deleting the legacy write is a
 * follow-up, deliberately: for as long as both are written, dropping the
 * canonical database is a complete rollback.
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
 * The canonical half of the window (#2275). `null` when this unit has no
 * canonical store — the legacy path then behaves exactly as it did before.
 */
export interface CanonicalConversationDeps {
  store: WorkUnitConversationStore;
  identity: ConversationIdentity;
}

export interface SessionPersistenceDeps {
  store: SessionStore | null;
  /**
   * Internal persistence key — stable across days/restarts so saved
   * conversations can be restored by `SessionStore.load`. The outgoing
   * Adobe `X-Session-Id` is computed separately.
   */
  sessionId: string;
  /** Unit folder, for log correlation only. */
  folder: string;
  /** The agent's live message list, or `undefined` before/after the agent. */
  getMessages: () => AgentMessage[] | undefined;
  isDisposed: () => boolean;
  /** Surfaced to the user when a restore fails; the unit starts fresh. */
  onRestoreError: (message: string) => void;
  /** Canonical conversation record (#2275); omitted, only the legacy store is used. */
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

  /** The backing store, or `null` when this unit persists nothing. */
  get store(): SessionStore | null {
    return this.deps.store;
  }

  /**
   * Restore this unit's conversation.
   *
   * Canonical record first, legacy `agent-sessions` second. The fallback is
   * the kill switch and it is deliberately driven by DATA, not by a flag: a
   * unit with no canonical record — never migrated, migrated from a UI
   * projection (which derives to no Pi history by design), or a canonical
   * database that will not open — restores exactly as it did before #2275.
   */
  async restore(): Promise<AgentMessage[]> {
    const canonical = await this.restoreCanonical();
    if (canonical) return canonical;

    const store = this.deps.store;
    if (!store) return [];

    try {
      const saved = await store.load(this.deps.sessionId);
      if (saved) {
        const restoredMessages = stripOrphanedToolResults(saved.messages);
        this.createdAt = saved.createdAt;
        log.info('Restored agent session', {
          folder: this.deps.folder,
          messageCount: restoredMessages.length,
          droppedOrphans: saved.messages.length - restoredMessages.length,
        });
        return restoredMessages;
      }
    } catch (err) {
      log.error('Failed to restore agent session', {
        folder: this.deps.folder,
        error: err instanceof Error ? err.message : String(err),
      });
      this.deps.onRestoreError(`Conversation history could not be restored. Starting fresh.`);
    }
    return [];
  }

  /**
   * Read the canonical record and derive Pi history from it. `null` means
   * "no answer here" — no canonical store, no record, or a record that
   * derives to nothing — and sends the caller to the legacy store.
   */
  private async restoreCanonical(): Promise<AgentMessage[] | null> {
    const canonical = this.deps.canonical;
    if (!canonical) return null;
    let record: Awaited<ReturnType<WorkUnitConversationStore['load']>> = null;
    try {
      record = await canonical.store.load(canonical.identity.key);
    } catch (err) {
      // The store swallows its own read errors, so this is the belt to that
      // braces. It stays because the kill switch has to hold unconditionally:
      // a canonical read that fails in ANY way must send the caller to the
      // legacy store, never surface as a lost conversation.
      log.warn('Canonical conversation read failed; falling back to the legacy session', {
        folder: this.deps.folder,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
    const messages = toAgentMessages(record);
    if (messages.length === 0) return null;
    const restored = stripOrphanedToolResults(messages);
    if (record) this.createdAt = record.createdAt;
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
    this.persistCanonical(persistMessages);
    const store = this.deps.store;
    if (!store) return;
    store
      .save({
        id: this.deps.sessionId,
        messages: persistMessages,
        config: {},
        createdAt: this.createdAt || Date.now(),
        updatedAt: Date.now(),
      })
      .catch((err) => {
        log.error('Failed to save agent session', {
          folder: this.deps.folder,
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }

  /**
   * Write the canonical record (#2275). Fire-and-forget and never fatal: the
   * legacy write on the same call is still the one a restore falls back to,
   * so a canonical store that fails costs continuity of the new record, not
   * the user's conversation.
   */
  private persistCanonical(messages: AgentMessage[]): void {
    const canonical = this.deps.canonical;
    if (!canonical) return;
    void canonical.store
      .syncAgentMessages(canonical.identity, messages, {
        createdAt: this.createdAt || Date.now(),
      })
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
   * BOTH representations go, in one place. Deleting only the legacy session
   * would leave the canonical record standing, and since a restore prefers
   * that record the next reload would resurrect the conversation the user
   * just cleared. Any pending checkpoint is cancelled first so an in-flight
   * debounce cannot write the history back moments later.
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
    if (!this.deps.store && !this.deps.canonical) return;
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.deps.isDisposed()) this.persistNow();
    }, SESSION_CHECKPOINT_DEBOUNCE_MS);
  }
}
