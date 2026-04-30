/**
 * Mount Table Store — persist mount entries (path → FileSystemDirectoryHandle)
 * in IndexedDB so they survive page reloads.
 *
 * Uses a dedicated database (`slicc-mount-table`) to avoid schema conflicts
 * with other stores.  Handles are structured-cloneable and can be stored
 * directly in IDB.
 */

const DB_NAME = 'slicc-mount-table';
const DB_VERSION = 1;
const STORE_NAME = 'mounts';

/** Open (or create) the mount-table database. */
function openDB(): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export interface MountEntry {
  path: string;
  handle: FileSystemDirectoryHandle;
}

/**
 * Stable per-mount identity + everything needed to reconstruct a backend on
 * session restore. Persisted across sessions; never carries live objects,
 * resolved secrets, or Uint8Arrays.
 *
 * Shipped alongside the legacy `MountEntry` export during the migration
 * window; Phase 8 deletes the legacy type and rewrites `getAllMountEntries`
 * to return `MountTableEntry[]`.
 */
export type BackendDescriptor =
  | { kind: 'local'; mountId: string; idbHandleKey: string }
  | { kind: 's3'; mountId: string; source: string; profile: string }
  | { kind: 'da'; mountId: string; source: string; profile: string };

export interface MountTableEntry {
  targetPath: string;
  descriptor: BackendDescriptor;
  createdAt: number;
}

/** Save a mount entry (path → handle) to IndexedDB. */
export async function saveMountEntry(
  path: string,
  handle: FileSystemDirectoryHandle
): Promise<void> {
  const db = await openDB();
  try {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(handle, path);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () =>
        reject(tx.error ?? new DOMException('IndexedDB transaction aborted', 'AbortError'));
    });
  } finally {
    db.close();
  }
}

/** Remove a mount entry from IndexedDB. */
export async function removeMountEntry(path: string): Promise<void> {
  const db = await openDB();
  try {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(path);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () =>
        reject(tx.error ?? new DOMException('IndexedDB transaction aborted', 'AbortError'));
    });
  } finally {
    db.close();
  }
}

/** Retrieve all persisted mount entries. */
export async function getAllMountEntries(): Promise<MountEntry[]> {
  const db = await openDB();
  try {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const abortError = () =>
      tx.error ?? new DOMException('IndexedDB transaction aborted', 'AbortError');
    const keys = await new Promise<IDBValidKey[]>((resolve, reject) => {
      const req = store.getAllKeys();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      tx.onabort = () => reject(abortError());
    });
    const values = await new Promise<FileSystemDirectoryHandle[]>((resolve, reject) => {
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      tx.onabort = () => reject(abortError());
    });
    return keys.map((key, i) => ({ path: key as string, handle: values[i] }));
  } finally {
    db.close();
  }
}

/** Remove all mount entries from IndexedDB. */
export async function clearMountEntries(): Promise<void> {
  const db = await openDB();
  try {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).clear();
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () =>
        reject(tx.error ?? new DOMException('IndexedDB transaction aborted', 'AbortError'));
    });
  } finally {
    db.close();
  }
}
