/**
 * Durable conversation history for one work unit (#1987).
 *
 * Owns: the session id and creation timestamp, the debounce timer behind
 * mid-turn checkpoints, and the restore path (including orphan stripping).
 *
 * Changes when the durable representation of a conversation changes — the
 * record shape, the checkpoint cadence, what a restore has to repair. #2275
 * (one conversation record per work unit) lands here, which is precisely why
 * it should not have to be found inside a 2,200-line class.
 */

import { stripOrphanedToolResults } from '../../core/context-compaction.js';
import type { AgentMessage } from '../../core/index.js';
import { createLogger } from '../../core/index.js';
import type { SessionStore } from '../../core/session.js';

const log = createLogger('scoop-context');

/**
 * Debounce for mid-turn session checkpoints (#1987): long enough to coalesce
 * a tool burst into one IndexedDB write, short enough that an abnormal turn
 * death loses at most a moment of completed messages.
 */
export const SESSION_CHECKPOINT_DEBOUNCE_MS = 1_000;

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

  /** Restore agent session from storage. */
  async restore(): Promise<AgentMessage[]> {
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
    const store = this.deps.store;
    if (!store || persistMessages.length === 0) return;
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
   * Debounced mid-turn checkpoint (#1987). Persistence used to happen only
   * at `agent_end`, so a turn that aborted abnormally — compaction failure,
   * worker death, page reload — lost EVERY message since the previous turn:
   * in production a multi-minute tool turn existed only in the page's memory
   * and a reload silently dropped it. Each completed message now schedules a
   * write; the debounce keeps tool-heavy turns from write-storming IndexedDB.
   */
  schedule(): void {
    if (this.deps.isDisposed() || !this.deps.store) return;
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.deps.isDisposed()) this.persistNow();
    }, SESSION_CHECKPOINT_DEBOUNCE_MS);
  }
}
