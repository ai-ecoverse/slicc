import type { AgentMessage } from '../../core/index.js';
import { createLogger } from '../../core/index.js';
import type { ChatMessage } from '../../scoops/chat-types.js';
import { entriesFromAgentMessages } from './entries.js';
import type {
  ConversationAttachmentOverlay,
  ConversationEntry,
  ConversationMarker,
  ConversationOrigin,
  LegacyConversationKeys,
  WorkUnitConversationRecord,
} from './types.js';
import { CONVERSATION_RECORD_VERSION, isReadableRecord, recordSchemaVersion } from './types.js';

const log = createLogger('work-unit-conversation');

export const CONVERSATION_DB_NAME = 'slicc-work-units';
const DB_VERSION = 1;
const CONVERSATIONS_STORE = 'conversations';
const MIGRATIONS_STORE = 'migrations';

const MAX_MARKERS = 64;

const MAX_ATTACHMENT_OVERLAYS = 256;

export interface ConversationMigrationState {
  id: string;

  version: number;

  completedKeys: string[];

  skipped: Array<{ key: string; reason: string }>;
  done: boolean;
  startedAt: number;
  updatedAt: number;
}

export type ConversationReadResult =
  | { status: 'ok'; record: WorkUnitConversationRecord }
  | { status: 'absent' }
  | { status: 'malformed'; reason: string }
  | { status: 'incompatible'; version: number }
  | { status: 'error'; reason: string };

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

  private readonly writeChains = new Map<string, Promise<unknown>>();

  constructor(options: { dbName?: string } = {}) {
    this.dbName = options.dbName ?? CONVERSATION_DB_NAME;
  }

  async load(key: string): Promise<WorkUnitConversationRecord | null> {
    const result = await this.read(key);
    return result.status === 'ok' ? result.record : null;
  }

  async read(key: string): Promise<ConversationReadResult> {
    try {
      const db = await this.getDb();
      const record = await request<WorkUnitConversationRecord | undefined>(
        db.transaction(CONVERSATIONS_STORE, 'readonly').objectStore(CONVERSATIONS_STORE).get(key)
      );
      if (!record) return { status: 'absent' };
      if (!isReadableRecord(record)) {
        log.warn('Ignoring conversation record from a newer schema', {
          key,
          version: record.version,
        });
        return { status: 'incompatible', version: record.version };
      }
      if (!Array.isArray(record.entries)) {
        log.warn('Conversation record has no entry list', { key });
        return { status: 'malformed', reason: 'entries is not a list' };
      }
      return { status: 'ok', record };
    } catch (err) {
      log.warn('Conversation record read failed', { key, error: errorText(err) });
      return { status: 'error', reason: errorText(err) };
    }
  }

  async save(record: WorkUnitConversationRecord): Promise<WorkUnitConversationRecord> {
    const version =
      record.version > CONVERSATION_RECORD_VERSION ? record.version : recordSchemaVersion(record);
    const stored = { ...record, version };
    const db = await this.getDb();
    const tx = db.transaction(CONVERSATIONS_STORE, 'readwrite');
    tx.objectStore(CONVERSATIONS_STORE).put(stored);
    await transaction(tx);
    return stored;
  }

  delete(key: string): Promise<void> {
    return this.serialize(key, async () => {
      try {
        const db = await this.getDb();
        const tx = db.transaction(CONVERSATIONS_STORE, 'readwrite');
        tx.objectStore(CONVERSATIONS_STORE).delete(key);
        await transaction(tx);
      } catch (err) {
        log.warn('Conversation record delete failed', { key, error: errorText(err) });
      }
    });
  }

  async rekey(fromKey: string, identity: ConversationIdentity): Promise<void> {
    if (fromKey === identity.key) return;
    try {
      const source = await this.read(fromKey);
      if (source.status !== 'ok') return;
      const target = await this.read(identity.key);
      if (target.status === 'incompatible' || target.status === 'error') {
        log.warn('Conversation rekey refused: target is not writable', {
          fromKey,
          toKey: identity.key,
          status: target.status,
        });
        return;
      }
      const now = Date.now();
      await this.save({
        ...source.record,
        key: identity.key,
        workUnitId: identity.workUnitId,
        workspaceId: identity.workspaceId,
        folder: identity.folder,
        legacyKeys: identity.legacyKeys,
        updatedAt: now,
      });
      await this.delete(fromKey);
    } catch (err) {
      log.warn('Conversation rekey failed', {
        fromKey,
        toKey: identity.key,
        error: errorText(err),
      });
    }
  }

  async loadAll(): Promise<WorkUnitConversationRecord[]> {
    try {
      const db = await this.getDb();
      const records = await request<WorkUnitConversationRecord[]>(
        db.transaction(CONVERSATIONS_STORE, 'readonly').objectStore(CONVERSATIONS_STORE).getAll()
      );
      return records.filter((r) => isReadableRecord(r) && Array.isArray(r.entries));
    } catch (err) {
      log.warn('Conversation record listing failed', { error: errorText(err) });
      return [];
    }
  }

  async loadLatestInWorkspace(workspaceId: string): Promise<WorkUnitConversationRecord | null> {
    try {
      const prefix = `${workspaceId}::`;
      const db = await this.getDb();
      const records = await request<WorkUnitConversationRecord[]>(
        db
          .transaction(CONVERSATIONS_STORE, 'readonly')
          .objectStore(CONVERSATIONS_STORE)
          .getAll(IDBKeyRange.bound(prefix, `${prefix}\uffff`))
      );
      let latest: WorkUnitConversationRecord | null = null;
      for (const record of records) {
        if (!isReadableRecord(record) || !Array.isArray(record.entries)) continue;
        if (!latest || record.updatedAt > latest.updatedAt) latest = record;
      }
      return latest;
    } catch (err) {
      log.warn('Conversation workspace lookup failed', { workspaceId, error: errorText(err) });
      return null;
    }
  }

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

  async syncAgentMessages(
    identity: ConversationIdentity,
    messages: readonly AgentMessage[],
    options: { createdAt?: number; now?: number } = {}
  ): Promise<WorkUnitConversationRecord | null> {
    const now = options.now ?? Date.now();
    const next = entriesFromAgentMessages(messages);
    return this.serialize(identity.key, () => this.ingestEntries(identity, next, options, now));
  }

  private async ingestEntries(
    identity: ConversationIdentity,
    next: ConversationEntry[],
    options: { createdAt?: number },
    now: number
  ): Promise<WorkUnitConversationRecord | null> {
    try {
      const current = await this.read(identity.key);
      if (current.status === 'incompatible' || current.status === 'error') {
        return null;
      }
      const existing = current.status === 'ok' ? current.record : null;
      const record = mergeEntries(existing, next, identity, 'agent-history', {
        createdAt: options.createdAt ?? now,
        now,
      });
      if (!record) return existing;
      return await this.save(record);
    } catch (err) {
      log.warn('Conversation record write failed', {
        key: identity.key,
        error: errorText(err),
      });
      return null;
    }
  }

  async putMarker(
    key: string,
    marker: ConversationMarker,
    options: { createWith?: ConversationIdentity } = {}
  ): Promise<boolean> {
    return this.withRecord(key, options.createWith, (record) => {
      const kept = (record.markers ?? []).filter((m) => m.id !== marker.id);
      kept.push(marker);
      kept.sort((a, b) => a.timestamp - b.timestamp);
      return { ...record, markers: kept.slice(-MAX_MARKERS) };
    });
  }

  async putAttachments(
    identity: ConversationIdentity,
    overlays: readonly ConversationAttachmentOverlay[]
  ): Promise<boolean> {
    if (overlays.length === 0) return false;
    const ids = new Set(overlays.map((o) => o.id));
    return this.withRecord(identity.key, identity, (record) => ({
      ...record,
      attachments: [...(record.attachments ?? []).filter((o) => !ids.has(o.id)), ...overlays]
        .sort((a, b) => a.timestamp - b.timestamp)
        .slice(-MAX_ATTACHMENT_OVERLAYS),
    }));
  }

  async deleteMarker(key: string, markerId: string): Promise<boolean> {
    return this.withRecord(key, undefined, (record) => {
      const kept = (record.markers ?? []).filter((m) => m.id !== markerId);
      if (kept.length === (record.markers?.length ?? 0)) return null;
      return { ...record, markers: kept };
    });
  }

  private withRecord(
    key: string,
    createWith: ConversationIdentity | undefined,
    mutate: (record: WorkUnitConversationRecord) => WorkUnitConversationRecord | null
  ): Promise<boolean> {
    return this.serialize(key, () => this.mutateRecord(key, createWith, mutate));
  }

  private async mutateRecord(
    key: string,
    createWith: ConversationIdentity | undefined,
    mutate: (record: WorkUnitConversationRecord) => WorkUnitConversationRecord | null
  ): Promise<boolean> {
    try {
      const current = await this.read(key);

      const base =
        current.status === 'ok'
          ? current.record
          : current.status === 'absent' && createWith
            ? emptyRecord(createWith, Date.now())
            : null;
      if (!base) return false;
      const next = mutate(base);
      if (!next) return false;
      await this.save({ ...next, updatedAt: Date.now() });
      return true;
    } catch (err) {
      log.warn('Conversation marker write failed', { key, error: errorText(err) });
      return false;
    }
  }

  private serialize<T>(key: string, op: () => Promise<T>): Promise<T> {
    const prior = this.writeChains.get(key) ?? Promise.resolve();
    const run = prior.then(op, op);
    const settled = run.then(
      () => undefined,
      () => undefined
    );
    this.writeChains.set(key, settled);
    void settled.then(() => {
      if (this.writeChains.get(key) === settled) this.writeChains.delete(key);
    });
    return run;
  }

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
  if (existing.origin === 'ui-projection' && origin === 'agent-history') {
    if (next.length === 0) return null;
    return {
      ...existing,
      version: CONVERSATION_RECORD_VERSION,
      origin,
      entries: next,
      projectionPrefix: [...(existing.projectionPrefix ?? []), ...projectedChat(existing)],
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

function emptyRecord(identity: ConversationIdentity, now: number): WorkUnitConversationRecord {
  return {
    key: identity.key,
    version: CONVERSATION_RECORD_VERSION,
    workUnitId: identity.workUnitId,
    workspaceId: identity.workspaceId,
    folder: identity.folder,
    origin: 'agent-history',
    entries: [],
    createdAt: now,
    updatedAt: now,
    legacyKeys: identity.legacyKeys,
  };
}

function projectedChat(record: WorkUnitConversationRecord): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const entry of record.entries) {
    if (entry.kind !== 'tool-call' && entry.chat) out.push(entry.chat);
  }
  return out;
}

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
