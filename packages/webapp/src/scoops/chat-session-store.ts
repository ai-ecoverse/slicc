import type { ChatMessage, Session } from './chat-types.js';

const DB_NAME = 'browser-coding-agent';
const DB_VERSION = 1;
const STORE_NAME = 'sessions';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export class SessionStore {
  private db: IDBDatabase | null = null;

  async init(): Promise<void> {
    await this.getDb();
  }

  private async getDb(): Promise<IDBDatabase> {
    if (!this.db) {
      const db = await openDb();
      db.onversionchange = () => {
        db.close();
        this.db = null;
      };
      db.onclose = () => {
        this.db = null;
      };
      this.db = db;
    }
    return this.db;
  }

  async save(session: Session): Promise<void> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(session);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async load(id: string): Promise<Session | null> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(id);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => reject(req.error);
    });
  }

  async list(): Promise<string[]> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).getAll();
      req.onsuccess = () => {
        const sessions = (req.result as Session[]).sort((a, b) => b.updatedAt - a.updatedAt);
        resolve(sessions.map((s) => s.id));
      };
      req.onerror = () => reject(req.error);
    });
  }

  async delete(id: string): Promise<void> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async saveMessages(sessionId: string, messages: ChatMessage[]): Promise<void> {
    const existing = await this.load(sessionId);
    const session: Session = existing
      ? { ...existing, messages, updatedAt: Date.now() }
      : { id: sessionId, messages, createdAt: Date.now(), updatedAt: Date.now() };
    await this.save(session);
  }
}
