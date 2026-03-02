/**
 * Session persistence — stores conversation history in IndexedDB.
 *
 * Allows the agent to resume conversations across page reloads.
 */

import type { AgentMessage, SessionData } from './types.js';

const DB_NAME = 'agent-sessions';
const DB_VERSION = 1;
const STORE_NAME = 'sessions';

/** Open (or create) the IndexedDB database. */
function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export class SessionStore {
  private dbPromise: Promise<IDBDatabase> | null = null;

  private getDB(): Promise<IDBDatabase> {
    if (!this.dbPromise) {
      this.dbPromise = openDB();
    }
    return this.dbPromise;
  }

  /** Save a session. Creates or updates. */
  async save(session: SessionData): Promise<void> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const request = store.put(session);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  /** Load a session by ID. Returns null if not found. */
  async load(id: string): Promise<SessionData | null> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const request = store.get(id);
      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => reject(request.error);
    });
  }

  /** Delete a session by ID. */
  async delete(id: string): Promise<void> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const request = store.delete(id);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  /** List all session IDs and metadata (without full message history). */
  async list(): Promise<Array<{ id: string; updatedAt: number }>> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const request = store.getAll();
      request.onsuccess = () => {
        const sessions = (request.result as SessionData[]) ?? [];
        resolve(
          sessions.map((s) => ({ id: s.id, updatedAt: s.updatedAt })),
        );
      };
      request.onerror = () => reject(request.error);
    });
  }

  /** Generate a new unique session ID. */
  static newId(): string {
    return `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  /** Create a fresh SessionData object. */
  static createSession(
    id: string,
    config: SessionData['config'],
  ): SessionData {
    const now = Date.now();
    return {
      id,
      messages: [],
      config,
      createdAt: now,
      updatedAt: now,
    };
  }

  /** Update session messages and timestamp. */
  static updateMessages(
    session: SessionData,
    messages: AgentMessage[],
  ): SessionData {
    return {
      ...session,
      messages,
      updatedAt: Date.now(),
    };
  }
}
