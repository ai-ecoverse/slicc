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

export const SESSION_CHECKPOINT_DEBOUNCE_MS = 1_000;

export interface CanonicalConversationDeps {
  store: WorkUnitConversationStore;
  identity: ConversationIdentity;
}

export interface SessionPersistenceDeps {
  store: SessionStore | null;

  sessionId: string;

  folder: string;

  getMessages: () => AgentMessage[] | undefined;
  isDisposed: () => boolean;

  onRestoreError: (message: string) => void;

  canonical?: CanonicalConversationDeps | null;
}

export class SessionPersistence {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private createdAt = 0;

  constructor(private readonly deps: SessionPersistenceDeps) {}

  get sessionId(): string {
    return this.deps.sessionId;
  }

  get store(): SessionStore | null {
    return this.deps.store;
  }

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

  private async restoreCanonical(): Promise<AgentMessage[] | null> {
    const canonical = this.deps.canonical;
    if (!canonical) return null;
    let record: Awaited<ReturnType<WorkUnitConversationStore['load']>> = null;
    try {
      record = await canonical.store.load(canonical.identity.key);
    } catch (err) {
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
