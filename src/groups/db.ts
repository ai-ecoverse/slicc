/**
 * IndexedDB storage for groups, messages, sessions, and tasks.
 * Replaces NanoClaw's SQLite with browser-native storage.
 */

import type { RegisteredGroup, ChannelMessage, ScheduledTask } from './types.js';

const DB_NAME = 'slicc-groups';
const DB_VERSION = 1;

const STORES = {
  GROUPS: 'groups',
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

      if (!database.objectStoreNames.contains(STORES.GROUPS)) {
        database.createObjectStore(STORES.GROUPS, { keyPath: 'jid' });
      }

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

// ─── Groups ─────────────────────────────────────────────────────────────────

export async function saveGroup(group: RegisteredGroup): Promise<void> {
  const store = await getStore(STORES.GROUPS, 'readwrite');
  return new Promise((resolve, reject) => {
    const req = store.put(group);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export async function getGroup(jid: string): Promise<RegisteredGroup | null> {
  const store = await getStore(STORES.GROUPS);
  return new Promise((resolve, reject) => {
    const req = store.get(jid);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

export async function getAllGroups(): Promise<Record<string, RegisteredGroup>> {
  const store = await getStore(STORES.GROUPS);
  return new Promise((resolve, reject) => {
    const req = store.getAll();
    req.onsuccess = () => {
      const groups: Record<string, RegisteredGroup> = {};
      for (const g of req.result) groups[g.jid] = g;
      resolve(groups);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function deleteGroup(jid: string): Promise<void> {
  const store = await getStore(STORES.GROUPS, 'readwrite');
  return new Promise((resolve, reject) => {
    const req = store.delete(jid);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

// ─── Messages ───────────────────────────────────────────────────────────────

export async function saveMessage(msg: ChannelMessage): Promise<void> {
  const store = await getStore(STORES.MESSAGES, 'readwrite');
  return new Promise((resolve, reject) => {
    const req = store.put(msg);
    req.onsuccess = () => resolve();
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
