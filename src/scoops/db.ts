/**
 * IndexedDB storage for scoops, messages, sessions, and tasks.
 * Schema v2: renamed from groups to scoops with type/isCone/assistantLabel fields.
 */

import type { RegisteredScoop, ChannelMessage, ScheduledTask } from './types.js';

const DB_NAME = 'slicc-groups';
const DB_VERSION = 2;

const STORES = {
  SCOOPS: 'scoops',
  MESSAGES: 'messages',
  SESSIONS: 'sessions',
  TASKS: 'tasks',
  STATE: 'state',
} as const;

let db: IDBDatabase | null = null;

async function openDB(): Promise<IDBDatabase> {
  if (db) return db;

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const database = (event.target as IDBOpenDBRequest).result;
      const oldVersion = event.oldVersion;

      if (oldVersion < 1) {
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

      if (oldVersion < 2) {
        // Migration: groups → scoops
        const tx = (event.target as IDBOpenDBRequest).transaction!;

        // If old 'groups' store exists, migrate data
        if (database.objectStoreNames.contains('groups')) {
          // Read all groups from old store
          const oldStore = tx.objectStore('groups');
          const getAllReq = oldStore.getAll();
          getAllReq.onsuccess = () => {
            const oldGroups = getAllReq.result;

            // Delete old store
            database.deleteObjectStore('groups');

            // Create new scoops store
            const scoopsStore = database.createObjectStore(STORES.SCOOPS, { keyPath: 'jid' });
            scoopsStore.createIndex('type', 'type');

            // Migrate records
            for (const g of oldGroups) {
              const isCone = g.isMain ?? false;
              const scoop: RegisteredScoop = {
                jid: g.jid,
                name: g.name,
                folder: g.folder,
                trigger: isCone ? undefined : (g.trigger || `@${g.folder}`),
                requiresTrigger: !isCone && (g.requiresTrigger ?? true),
                isCone,
                type: isCone ? 'cone' : 'scoop',
                assistantLabel: isCone ? 'sliccy' : (g.config?.assistantName || g.folder),
                addedAt: g.addedAt,
                config: g.config ? {
                  systemPromptAppend: g.config.systemPromptAppend,
                  timeout: g.config.timeout,
                  assistantName: g.config.assistantName,
                } : undefined,
              };
              scoopsStore.put(scoop);
            }
          };
        } else if (!database.objectStoreNames.contains(STORES.SCOOPS)) {
          // No old store, just create the new one
          const scoopsStore = database.createObjectStore(STORES.SCOOPS, { keyPath: 'jid' });
          scoopsStore.createIndex('type', 'type');
        }
      }
    };

    request.onsuccess = () => {
      db = request.result;
      resolve(db);
    };
    request.onerror = () => reject(request.error);
  });
}

async function getStore(name: string, mode: IDBTransactionMode = 'readonly'): Promise<IDBObjectStore> {
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

export async function saveMessage(msg: ChannelMessage): Promise<void> {
  const store = await getStore(STORES.MESSAGES, 'readwrite');
  return new Promise((resolve, reject) => {
    const req = store.put(msg);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export async function getMessagesForGroup(chatJid: string): Promise<ChannelMessage[]> {
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
  excludeSender?: string,
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
