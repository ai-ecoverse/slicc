/**
 * `WorkUnitStore` — durable home of the canonical conversation records
 * (#2275), plus the resumable cursor its migration writes.
 *
 * One IndexedDB database (`slicc-work-units`) with two object stores:
 *
 * | Store           | Key       | Holds                                   |
 * | --------------- | --------- | --------------------------------------- |
 * | `conversations` | `key`     | one {@link WorkUnitConversationRecord}   |
 * | `migrations`    | `id`      | one {@link ConversationMigrationState}   |
 *
 * **Reads never throw.** A record this build cannot parse, a database that
 * will not open, a browser with IndexedDB disabled — every one of them
 * answers `null`, and `null` means "fall back to the legacy stores". That is
 * the kill switch: user history is never gated on this database working.
 *
 * **Writes are append-only** in the ordinary case: {@link syncAgentMessages}
 * re-ingests the unit's full message list and stores only the entries beyond
 * the ones already persisted. Exactly one transition is not an append —
 * compaction (and `clear-chat`) replaces Pi's history wholesale, so the new
 * entries do not extend the stored prefix. That is detected, counted on
 * `rewrites`, and applied as a replace; silently interleaving the two would
 * splice a pre-compaction conversation into a post-compaction one.
 */

import type { AgentMessage } from '../../core/index.js';
import { createLogger } from '../../core/index.js';
import { entriesFromAgentMessages } from './entries.js';
import type {
  ConversationEntry,
  ConversationOrigin,
  LegacyConversationKeys,
  WorkUnitConversationRecord,
} from './types.js';
import { CONVERSATION_RECORD_VERSION, isReadableRecord } from './types.js';

const log = createLogger('work-unit-conversation');

export const CONVERSATION_DB_NAME = 'slicc-work-units';
const DB_VERSION = 1;
const CONVERSATIONS_STORE = 'conversations';
const MIGRATIONS_STORE = 'migrations';

/** Resumable cursor of a versioned migration into the canonical store. */
export interface ConversationMigrationState {
  id: string;
  /** Schema version this cursor was written for; a bump re-runs everything. */
  version: number;
  /** Canonical keys already migrated — the resume point after a crash. */
  completedKeys: string[];
  /** Units whose legacy data could not be read, with the reason. Never wiped. */
  skipped: Array<{ key: string; reason: string }>;
  done: boolean;
  startedAt: number;
  updatedAt: number;
}

/** Identity a write supplies so a record created on first append is complete. */
export interface ConversationIdentity {
  key: string;
  workUnitId: string;
  workspaceId: string;
  folder: string;
  legacyKeys: LegacyConversationKeys;
}

export class WorkUnitConversationStore {
  private dbPromise: Promise<IDBDatabase> | null = null;
  private readonly dbName: string;

  /** `dbName` is injectable so tests get one database per suite. */
  constructor(options: { dbName?: string } = {}) {
    this.dbName = options.dbName ?? CONVERSATION_DB_NAME;
  }

  /**
   * Read one record, or `null` when there is none, when it is unreadable, or
   * when the database itself is unavailable. Callers treat all three the
   * same: fall back to the legacy stores.
   */
  async load(key: string): Promise<WorkUnitConversationRecord | null> {
    try {
      const db = await this.getDb();
      const record = await request<WorkUnitConversationRecord | undefined>(
        db.transaction(CONVERSATIONS_STORE, 'readonly').objectStore(CONVERSATIONS_STORE).get(key)
      );
      if (!record) return null;
      if (!isReadableRecord(record)) {
        // A record from a NEWER build. Leave it exactly where it is — the
        // other build still needs it — and let this one use the legacy path.
        log.warn('Ignoring conversation record from a newer schema', {
          key,
          version: record.version,
        });
        return null;
      }
      if (!Array.isArray(record.entries)) {
        log.warn('Ignoring conversation record with no entry list', { key });
        return null;
      }
      return record;
    } catch (err) {
      log.warn('Conversation record read failed', { key, error: errorText(err) });
      return null;
    }
  }

  /** Write a record verbatim. Used by the migration and by the sync paths. */
  async save(record: WorkUnitConversationRecord): Promise<void> {
    const db = await this.getDb();
    const tx = db.transaction(CONVERSATIONS_STORE, 'readwrite');
    tx.objectStore(CONVERSATIONS_STORE).put(record);
    await transaction(tx);
  }

  /** Forget a unit's conversation (the unit was dropped). */
  async delete(key: string): Promise<void> {
    try {
      const db = await this.getDb();
      const tx = db.transaction(CONVERSATIONS_STORE, 'readwrite');
      tx.objectStore(CONVERSATIONS_STORE).delete(key);
      await transaction(tx);
    } catch (err) {
      log.warn('Conversation record delete failed', { key, error: errorText(err) });
    }
  }

  /** Every canonical key currently stored. */
  async listKeys(): Promise<string[]> {
    try {
      const db = await this.getDb();
      const keys = await request<IDBValidKey[]>(
        db
          .transaction(CONVERSATIONS_STORE, 'readonly')
          .objectStore(CONVERSATIONS_STORE)
          .getAllKeys()
      );
      return keys.map(String);
    } catch (err) {
      log.warn('Conversation key listing failed', { error: errorText(err) });
      return [];
    }
  }

  /**
   * Bring a unit's record in line with Pi's current message list.
   *
   * Returns the stored record, or `null` when the write could not happen —
   * a failed canonical write is never fatal, because the legacy store is
   * still being written on the same turn (the read-old/write-new window).
   */
  async syncAgentMessages(
    identity: ConversationIdentity,
    messages: readonly AgentMessage[],
    options: { createdAt?: number; now?: number } = {}
  ): Promise<WorkUnitConversationRecord | null> {
    const now = options.now ?? Date.now();
    const next = entriesFromAgentMessages(messages);
    try {
      const existing = await this.load(identity.key);
      const record = mergeEntries(existing, next, identity, 'agent-history', {
        createdAt: options.createdAt ?? now,
        now,
      });
      if (!record) return existing;
      await this.save(record);
      return record;
    } catch (err) {
      log.warn('Conversation record write failed', {
        key: identity.key,
        error: errorText(err),
      });
      return null;
    }
  }

  /** Read the cursor of a versioned migration, or `null` if it never ran. */
  async getMigrationState(id: string): Promise<ConversationMigrationState | null> {
    try {
      const db = await this.getDb();
      const state = await request<ConversationMigrationState | undefined>(
        db.transaction(MIGRATIONS_STORE, 'readonly').objectStore(MIGRATIONS_STORE).get(id)
      );
      return state ?? null;
    } catch (err) {
      log.warn('Migration state read failed', { id, error: errorText(err) });
      return null;
    }
  }

  /** Persist the cursor. Called after every unit so a crash resumes. */
  async putMigrationState(state: ConversationMigrationState): Promise<void> {
    try {
      const db = await this.getDb();
      const tx = db.transaction(MIGRATIONS_STORE, 'readwrite');
      tx.objectStore(MIGRATIONS_STORE).put(state);
      await transaction(tx);
    } catch (err) {
      log.warn('Migration state write failed', { id: state.id, error: errorText(err) });
    }
  }

  /**
   * Drop every canonical record and cursor. This is the documented ROLLBACK:
   * the legacy stores are written on every turn for as long as the
   * read-old/write-new window is open, so a cleared canonical store costs
   * nothing but the next migration pass. It never touches a legacy store.
   */
  async clearAll(): Promise<void> {
    const db = await this.getDb();
    const tx = db.transaction([CONVERSATIONS_STORE, MIGRATIONS_STORE], 'readwrite');
    tx.objectStore(CONVERSATIONS_STORE).clear();
    tx.objectStore(MIGRATIONS_STORE).clear();
    await transaction(tx);
  }

  private getDb(): Promise<IDBDatabase> {
    if (!this.dbPromise) {
      this.dbPromise = openDb(this.dbName).then((db) => {
        // Drop the cached handle when a peer context bumps the schema or the
        // database is deleted, so the next caller re-opens instead of
        // throwing "the database connection is closing".
        db.onversionchange = () => {
          db.close();
          this.dbPromise = null;
        };
        db.onclose = () => {
          this.dbPromise = null;
        };
        return db;
      });
      this.dbPromise.catch(() => {
        this.dbPromise = null;
      });
    }
    return this.dbPromise;
  }
}

/**
 * Fold freshly-ingested entries into the stored record.
 *
 * - identical → `null` (nothing to write; the common case mid-turn)
 * - the stored entries are a prefix of the new ones → append the tail
 * - anything else → replace, and count a rewrite (compaction / clear-chat)
 */
function mergeEntries(
  existing: WorkUnitConversationRecord | null,
  next: ConversationEntry[],
  identity: ConversationIdentity,
  origin: ConversationOrigin,
  times: { createdAt: number; now: number }
): WorkUnitConversationRecord | null {
  if (!existing) {
    if (next.length === 0) return null;
    return {
      key: identity.key,
      version: CONVERSATION_RECORD_VERSION,
      workUnitId: identity.workUnitId,
      workspaceId: identity.workspaceId,
      folder: identity.folder,
      origin,
      entries: next,
      createdAt: times.createdAt,
      updatedAt: times.now,
      legacyKeys: identity.legacyKeys,
    };
  }
  const prior = existing.entries;
  if (next.length === prior.length && isPrefix(prior, next)) return null;
  const appended = next.length > prior.length && isPrefix(prior, next);
  return {
    ...existing,
    version: CONVERSATION_RECORD_VERSION,
    origin,
    entries: next,
    updatedAt: times.now,
    rewrites: appended ? existing.rewrites : (existing.rewrites ?? 0) + 1,
    legacyKeys: identity.legacyKeys,
  };
}

/** `true` when `prior` is an entry-for-entry prefix of `next`. */
function isPrefix(
  prior: readonly ConversationEntry[],
  next: readonly ConversationEntry[]
): boolean {
  if (prior.length > next.length) return false;
  for (let i = 0; i < prior.length; i++) {
    if (!sameEntry(prior[i], next[i])) return false;
  }
  return true;
}

/**
 * Cheap identity test: kind, position and text (plus the tool-call handle).
 * Deliberately NOT a deep compare of the Pi message — a provider adding a
 * field to a message this build already stored must not read as a rewrite.
 */
function sameEntry(a: ConversationEntry, b: ConversationEntry): boolean {
  if (a.kind !== b.kind || a.seq !== b.seq) return false;
  if (a.kind === 'tool-call' && b.kind === 'tool-call') {
    return a.toolCallId === b.toolCallId && a.name === b.name;
  }
  const aText = 'text' in a ? a.text : '';
  const bText = 'text' in b ? b.text : '';
  return aText === bText;
}

function openDb(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(CONVERSATIONS_STORE)) {
        db.createObjectStore(CONVERSATIONS_STORE, { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains(MIGRATIONS_STORE)) {
        db.createObjectStore(MIGRATIONS_STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function transaction(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
