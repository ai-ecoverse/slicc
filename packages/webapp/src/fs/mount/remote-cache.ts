/**
 * RemoteMountCache — TTL + ETag cache for S3 and DA backends.
 *
 * Backed by IndexedDB (`slicc-mount-cache` database), keyed by
 * (mountId, mountRelativePath). Both panel and offscreen instances point at
 * the same IDB store; in-memory state is per-instance and best-effort
 * synchronized via the BroadcastChannel mount sync.
 *
 * See spec §"Cache key path convention": all paths are mount-relative
 * (e.g. 'foo/bar.html'), never VFS-absolute.
 */

import type { MountDirEntry } from './backend.js';

export interface CachedListing {
  entries: MountDirEntry[];
  cachedAt: number;
}

export interface CachedBody {
  body: Uint8Array;
  etag: string;
  size: number;
  cachedAt: number;
}

export interface RemoteMountCacheOptions {
  /** Stable per-mount UUID — namespaces all entries within the IDB store. */
  mountId: string;
  /** Default freshness window in ms (typical: 30_000). */
  ttlMs: number;
  /** Override for tests (default: 'slicc-mount-cache'). */
  dbName?: string;
}

const DEFAULT_DB = 'slicc-mount-cache';
const LISTING_STORE = 'listings';
const BODY_STORE = 'bodies';

export class RemoteMountCache {
  private readonly mountId: string;
  private readonly ttlMs: number;
  private readonly dbName: string;
  private dbPromise: Promise<IDBDatabase> | null = null;

  constructor(opts: RemoteMountCacheOptions) {
    this.mountId = opts.mountId;
    this.ttlMs = opts.ttlMs;
    this.dbName = opts.dbName ?? DEFAULT_DB;
  }

  /** Synchronous TTL check on a previously-fetched cachedAt timestamp. */
  isStale(cachedAt: number, ttlMs?: number): boolean {
    return Date.now() - cachedAt >= (ttlMs ?? this.ttlMs);
  }

  private async openDb(): Promise<IDBDatabase> {
    if (!this.dbPromise) {
      this.dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(this.dbName, 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(LISTING_STORE)) {
            db.createObjectStore(LISTING_STORE);
          }
          if (!db.objectStoreNames.contains(BODY_STORE)) {
            db.createObjectStore(BODY_STORE);
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return this.dbPromise;
  }

  private key(path: string): string {
    return `${this.mountId}::${path}`;
  }

  // --- listing cache ---

  async getListing(dirPath: string): Promise<CachedListing | null> {
    const db = await this.openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(LISTING_STORE, 'readonly');
      const req = tx.objectStore(LISTING_STORE).get(this.key(dirPath));
      req.onsuccess = () => resolve((req.result as CachedListing | undefined) ?? null);
      req.onerror = () => reject(req.error);
    });
  }

  async putListing(dirPath: string, entries: MountDirEntry[]): Promise<void> {
    const db = await this.openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(LISTING_STORE, 'readwrite');
      const value: CachedListing = { entries, cachedAt: Date.now() };
      tx.objectStore(LISTING_STORE).put(value, this.key(dirPath));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async invalidateListing(dirPath: string): Promise<void> {
    const db = await this.openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(LISTING_STORE, 'readwrite');
      tx.objectStore(LISTING_STORE).delete(this.key(dirPath));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  // --- body cache ---

  async getBody(filePath: string): Promise<CachedBody | null> {
    const db = await this.openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(BODY_STORE, 'readonly');
      const req = tx.objectStore(BODY_STORE).get(this.key(filePath));
      req.onsuccess = () => resolve((req.result as CachedBody | undefined) ?? null);
      req.onerror = () => reject(req.error);
    });
  }

  async putBody(filePath: string, body: Uint8Array, etag: string): Promise<void> {
    const db = await this.openDb();
    const value: CachedBody = { body, etag, size: body.byteLength, cachedAt: Date.now() };
    try {
      await this.txPut(db, BODY_STORE, this.key(filePath), value);
    } catch (err: unknown) {
      // QuotaExceededError → LRU evict ~25% of this mount's bodies and retry once.
      // If the second put still fails, swallow: the read already completed; we
      // just couldn't memoize.
      if (err instanceof DOMException && err.name === 'QuotaExceededError') {
        await this.evictLru(0.25);
        try {
          await this.txPut(db, BODY_STORE, this.key(filePath), value);
        } catch {
          // Best-effort; don't fail the read path on cache pressure.
        }
        return;
      }
      throw err;
    }
  }

  async invalidateBody(filePath: string): Promise<void> {
    const db = await this.openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(BODY_STORE, 'readwrite');
      tx.objectStore(BODY_STORE).delete(this.key(filePath));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  /** Drop all listings + bodies for this mountId only. */
  async clearMount(): Promise<void> {
    const db = await this.openDb();
    const prefix = `${this.mountId}::`;
    const dropFromStore = (storeName: string): Promise<void> =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite');
        const store = tx.objectStore(storeName);
        const req = store.getAllKeys();
        req.onsuccess = () => {
          for (const key of req.result as IDBValidKey[]) {
            if (typeof key === 'string' && key.startsWith(prefix)) {
              store.delete(key);
            }
          }
        };
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    await Promise.all([dropFromStore(LISTING_STORE), dropFromStore(BODY_STORE)]);
  }

  // --- internal helpers ---

  private txPut(db: IDBDatabase, storeName: string, key: string, value: unknown): Promise<void> {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  /**
   * Evict the oldest fraction of this mount's body cache (by cachedAt). Used
   * on QuotaExceededError. Listing entries are tiny — we leave them.
   */
  private async evictLru(fraction: number): Promise<void> {
    const db = await this.openDb();
    const prefix = `${this.mountId}::`;
    const candidates: { key: IDBValidKey; cachedAt: number }[] = await new Promise(
      (resolve, reject) => {
        const tx = db.transaction(BODY_STORE, 'readonly');
        const store = tx.objectStore(BODY_STORE);
        const out: { key: IDBValidKey; cachedAt: number }[] = [];
        const req = store.openCursor();
        req.onsuccess = () => {
          const cursor = req.result;
          if (!cursor) {
            resolve(out);
            return;
          }
          if (typeof cursor.key === 'string' && cursor.key.startsWith(prefix)) {
            const v = cursor.value as CachedBody;
            out.push({ key: cursor.key, cachedAt: v.cachedAt });
          }
          cursor.continue();
        };
        req.onerror = () => reject(req.error);
      }
    );
    candidates.sort((a, b) => a.cachedAt - b.cachedAt);
    const toEvict = Math.max(1, Math.ceil(candidates.length * fraction));
    const targets = candidates.slice(0, toEvict);
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(BODY_STORE, 'readwrite');
      const store = tx.objectStore(BODY_STORE);
      for (const { key } of targets) store.delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
}
