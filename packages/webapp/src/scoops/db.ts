/**
 * IndexedDB storage for scoops, messages, sessions, tasks, webhooks, and crontasks.
 * Schema v3: added webhooks and crontasks stores.
 */

import type { CronTaskEntry, WebhookEntry } from './lick-manager.js';
import type { ChannelMessage, RegisteredScoop, ScheduledTask } from './types.js';

const DB_NAME = 'slicc-groups';
const DB_VERSION = 3;

const STORES = {
  SCOOPS: 'scoops',
  MESSAGES: 'messages',
  SESSIONS: 'sessions',
  TASKS: 'tasks',
  STATE: 'state',
  WEBHOOKS: 'webhooks',
  CRONTASKS: 'crontasks',
} as const;

let db: IDBDatabase | null = null;

function runMigrationV1(database: IDBDatabase): void {
  // Fresh install — create all stores
  if (!database.objectStoreNames.contains(STORES.MESSAGES)) {
    const store = database.createObjectStore(STORES.MESSAGES, { keyPath: 'id' });
    store.createIndex('chatJid', 'chatJid');
    store.createIndex('timestamp', 'timestamp');
    store.createIndex('chatJid_timestamp', ['chatJid', 'timestamp']);
  }

  if (!database.objectStoreNames.contains(STORES.SESSIONS)) {
    database.createObjectStore(STORES.SESSIONS, { keyPath: 'groupFolder' });
  }

  if (!database.objectStoreNames.contains(STORES.TASKS)) {
    const store = database.createObjectStore(STORES.TASKS, { keyPath: 'id' });
    store.createIndex('groupFolder', 'groupFolder');
  }

  if (!database.objectStoreNames.contains(STORES.STATE)) {
    database.createObjectStore(STORES.STATE, { keyPath: 'key' });
  }
}

function mapLegacyGroupToScoop(g: {
  jid: string;
  name: string;
  folder: string;
  trigger?: string;
  requiresTrigger?: boolean;
  isMain?: boolean;
  addedAt: string;
  config?: {
    systemPromptAppend?: string;
    timeout?: number;
    assistantName?: string;
  };
}): RegisteredScoop {
  const isCone = g.isMain ?? false;
  return {
    jid: g.jid,
    name: g.name,
    folder: g.folder,
    trigger: isCone ? undefined : g.trigger || `@${g.folder}`,
    requiresTrigger: !isCone && (g.requiresTrigger ?? true),
    isCone,
    type: isCone ? 'cone' : 'scoop',
    assistantLabel: isCone ? 'sliccy' : g.config?.assistantName || g.folder,
    addedAt: g.addedAt,
    config: g.config
      ? {
          systemPromptAppend: g.config.systemPromptAppend,
          timeout: g.config.timeout,
          assistantName: g.config.assistantName,
        }
      : undefined,
  };
}

function runMigrationV2(event: IDBVersionChangeEvent, database: IDBDatabase): void {
  // Migration: groups → scoops
  if (database.objectStoreNames.contains('groups')) {
    const tx = (event.target as IDBOpenDBRequest).transaction!;
    const oldStore = tx.objectStore('groups');
    const getAllReq = oldStore.getAll();
    getAllReq.onsuccess = () => {
      const oldGroups = getAllReq.result;
      database.deleteObjectStore('groups');
      const scoopsStore = database.createObjectStore(STORES.SCOOPS, { keyPath: 'jid' });
      scoopsStore.createIndex('type', 'type');
      for (const g of oldGroups) {
        scoopsStore.put(mapLegacyGroupToScoop(g));
      }
    };
    return;
  }
  if (!database.objectStoreNames.contains(STORES.SCOOPS)) {
    const scoopsStore = database.createObjectStore(STORES.SCOOPS, { keyPath: 'jid' });
    scoopsStore.createIndex('type', 'type');
  }
}

function runMigrationV3(database: IDBDatabase): void {
  if (!database.objectStoreNames.contains(STORES.WEBHOOKS)) {
    database.createObjectStore(STORES.WEBHOOKS, { keyPath: 'id' });
  }
  if (!database.objectStoreNames.contains(STORES.CRONTASKS)) {
    database.createObjectStore(STORES.CRONTASKS, { keyPath: 'id' });
  }
}

function applyMigrations(event: IDBVersionChangeEvent): void {
  const database = (event.target as IDBOpenDBRequest).result;
  const oldVersion = event.oldVersion;
  if (oldVersion < 1) runMigrationV1(database);
  if (oldVersion < 2) runMigrationV2(event, database);
  if (oldVersion < 3) runMigrationV3(database);
}

function getCachedDB(): IDBDatabase | null {
  if (!db) return null;
  const hasAllStores = Object.values(STORES).every((name) => db!.objectStoreNames.contains(name));
  if (db.version === DB_VERSION && hasAllStores) return db;
  // Close outdated/incomplete connection to trigger upgrade
  db.close();
  db = null;
  return null;
}

function bindLifecycle(connection: IDBDatabase): void {
  // Drop the cache if another context (side panel ↔ offscreen) bumps the
  // schema or `nuke` runs `deleteDatabase` — the next caller re-opens
  // cleanly instead of throwing "the database connection is closing".
  // Capture `connection` so concurrent opens close their own handle even
  // when a later open has already overwritten the module-level cache.
  connection.onversionchange = () => {
    connection.close();
    if (db === connection) db = null;
  };
  connection.onclose = () => {
    if (db === connection) db = null;
  };
}

async function openDB(): Promise<IDBDatabase> {
  const cached = getCachedDB();
  if (cached) return cached;

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = applyMigrations;
    request.onsuccess = () => {
      const connection = request.result;
      bindLifecycle(connection);
      db = connection;
      resolve(connection);
    };
    request.onerror = () => reject(request.error);
  });
}

async function getStore(
  name: string,
  mode: IDBTransactionMode = 'readonly'
): Promise<IDBObjectStore> {
  const database = await openDB();
  return database.transaction(name, mode).objectStore(name);
}

// ─── Scoops ─────────────────────────────────────────────────────────────────

export async function saveScoop(scoop: RegisteredScoop): Promise<void> {
  const store = await getStore(STORES.SCOOPS, 'readwrite');
  return new Promise((resolve, reject) => {
    const req = store.put(scoop);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export async function getScoop(jid: string): Promise<RegisteredScoop | null> {
  const store = await getStore(STORES.SCOOPS);
  return new Promise((resolve, reject) => {
    const req = store.get(jid);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

export async function getAllScoops(): Promise<Record<string, RegisteredScoop>> {
  const store = await getStore(STORES.SCOOPS);
  return new Promise((resolve, reject) => {
    const req = store.getAll();
    req.onsuccess = () => {
      const scoops: Record<string, RegisteredScoop> = {};
      for (const s of req.result) scoops[s.jid] = s;
      resolve(scoops);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function deleteScoop(jid: string): Promise<void> {
  const store = await getStore(STORES.SCOOPS, 'readwrite');
  return new Promise((resolve, reject) => {
    const req = store.delete(jid);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

// ─── Messages ───────────────────────────────────────────────────────────────

export async function clearAllMessages(): Promise<void> {
  const store = await getStore(STORES.MESSAGES, 'readwrite');
  return new Promise((resolve, reject) => {
    const req = store.clear();
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

/**
 * Delete every persisted ChannelMessage for one chat jid. Used by the
 * "New session" flow to wipe the cone's history from the agent DB —
 * without this, `processScoopQueue` walks back over old `getMessagesSince`
 * rows on the next prompt and re-injects pre-reset turns into the
 * fresh session.
 */
export async function clearMessagesForScoop(chatJid: string): Promise<void> {
  const store = await getStore(STORES.MESSAGES, 'readwrite');
  const index = store.index('chatJid_timestamp');
  const range = IDBKeyRange.bound([chatJid, ''], [chatJid, '￿'], false, false);
  return new Promise((resolve, reject) => {
    const req = index.openCursor(range);
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) {
        resolve();
        return;
      }
      cursor.delete();
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
  });
}

export async function saveMessage(msg: ChannelMessage): Promise<void> {
  const store = await getStore(STORES.MESSAGES, 'readwrite');
  return new Promise((resolve, reject) => {
    const req = store.put(msg);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export async function deleteMessage(id: string): Promise<void> {
  const store = await getStore(STORES.MESSAGES, 'readwrite');
  return new Promise((resolve, reject) => {
    const req = store.delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export async function getMessagesForScoop(chatJid: string): Promise<ChannelMessage[]> {
  const store = await getStore(STORES.MESSAGES);
  const index = store.index('chatJid_timestamp');
  const range = IDBKeyRange.bound([chatJid, ''], [chatJid, '\uffff'], false, false);

  return new Promise((resolve, reject) => {
    const req = index.getAll(range);
    req.onsuccess = () => resolve(req.result as ChannelMessage[]);
    req.onerror = () => reject(req.error);
  });
}

export async function getMessagesSince(
  chatJid: string,
  since: string,
  excludeSender?: string
): Promise<ChannelMessage[]> {
  const store = await getStore(STORES.MESSAGES);
  const index = store.index('chatJid_timestamp');
  const range = IDBKeyRange.bound([chatJid, since], [chatJid, '\uffff'], true, false);

  return new Promise((resolve, reject) => {
    const req = index.getAll(range);
    req.onsuccess = () => {
      let msgs = req.result as ChannelMessage[];
      if (excludeSender) {
        msgs = msgs.filter((m) => m.senderName !== excludeSender);
      }
      resolve(msgs);
    };
    req.onerror = () => reject(req.error);
  });
}

// ─── Sessions ───────────────────────────────────────────────────────────────

export async function saveSession(groupFolder: string, sessionId: string): Promise<void> {
  const store = await getStore(STORES.SESSIONS, 'readwrite');
  return new Promise((resolve, reject) => {
    const req = store.put({ groupFolder, sessionId, updatedAt: new Date().toISOString() });
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export async function getSession(groupFolder: string): Promise<string | null> {
  const store = await getStore(STORES.SESSIONS);
  return new Promise((resolve, reject) => {
    const req = store.get(groupFolder);
    req.onsuccess = () => resolve(req.result?.sessionId ?? null);
    req.onerror = () => reject(req.error);
  });
}

export async function getAllSessions(): Promise<Record<string, string>> {
  const store = await getStore(STORES.SESSIONS);
  return new Promise((resolve, reject) => {
    const req = store.getAll();
    req.onsuccess = () => {
      const sessions: Record<string, string> = {};
      for (const s of req.result) sessions[s.groupFolder] = s.sessionId;
      resolve(sessions);
    };
    req.onerror = () => reject(req.error);
  });
}

// ─── Tasks ──────────────────────────────────────────────────────────────────

export async function saveTask(task: ScheduledTask): Promise<void> {
  const store = await getStore(STORES.TASKS, 'readwrite');
  return new Promise((resolve, reject) => {
    const req = store.put(task);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export async function getTask(id: string): Promise<ScheduledTask | null> {
  const store = await getStore(STORES.TASKS);
  return new Promise((resolve, reject) => {
    const req = store.get(id);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

export async function getAllTasks(): Promise<ScheduledTask[]> {
  const store = await getStore(STORES.TASKS);
  return new Promise((resolve, reject) => {
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function deleteTask(id: string): Promise<void> {
  const store = await getStore(STORES.TASKS, 'readwrite');
  return new Promise((resolve, reject) => {
    const req = store.delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

// ─── State ──────────────────────────────────────────────────────────────────

export async function getState(key: string): Promise<string | null> {
  const store = await getStore(STORES.STATE);
  return new Promise((resolve, reject) => {
    const req = store.get(key);
    req.onsuccess = () => resolve(req.result?.value ?? null);
    req.onerror = () => reject(req.error);
  });
}

export async function setState(key: string, value: string): Promise<void> {
  const store = await getStore(STORES.STATE, 'readwrite');
  return new Promise((resolve, reject) => {
    const req = store.put({ key, value });
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export async function initDB(): Promise<void> {
  await openDB();
}

// ─── Webhooks ───────────────────────────────────────────────────────────────

export async function saveWebhook(webhook: WebhookEntry): Promise<void> {
  const store = await getStore(STORES.WEBHOOKS, 'readwrite');
  return new Promise((resolve, reject) => {
    const req = store.put(webhook);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export async function getWebhook(id: string): Promise<WebhookEntry | null> {
  const store = await getStore(STORES.WEBHOOKS);
  return new Promise((resolve, reject) => {
    const req = store.get(id);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

export async function getAllWebhooks(): Promise<WebhookEntry[]> {
  try {
    const store = await getStore(STORES.WEBHOOKS);
    return new Promise((resolve, reject) => {
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } catch {
    // Store doesn't exist yet - return empty array
    return [];
  }
}

export async function deleteWebhook(id: string): Promise<void> {
  const store = await getStore(STORES.WEBHOOKS, 'readwrite');
  return new Promise((resolve, reject) => {
    const req = store.delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

// ─── Cron Tasks ─────────────────────────────────────────────────────────────

export async function saveCronTask(task: CronTaskEntry): Promise<void> {
  const store = await getStore(STORES.CRONTASKS, 'readwrite');
  return new Promise((resolve, reject) => {
    const req = store.put(task);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export async function getCronTask(id: string): Promise<CronTaskEntry | null> {
  const store = await getStore(STORES.CRONTASKS);
  return new Promise((resolve, reject) => {
    const req = store.get(id);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

export async function getAllCronTasks(): Promise<CronTaskEntry[]> {
  try {
    const store = await getStore(STORES.CRONTASKS);
    return new Promise((resolve, reject) => {
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } catch {
    // Store doesn't exist yet - return empty array
    return [];
  }
}

export async function deleteCronTask(id: string): Promise<void> {
  const store = await getStore(STORES.CRONTASKS, 'readwrite');
  return new Promise((resolve, reject) => {
    const req = store.delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}
