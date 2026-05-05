/**
 * Mount Table Store — persist mount entries in IndexedDB so they survive
 * page reloads.
 *
 * Schema (DB `slicc-mount-table`):
 *
 *   - **`mounts`** (legacy + still active for FS Access handles):
 *     keyed by `idbHandleKey`, value is `FileSystemDirectoryHandle`. Local
 *     backends store the live handle here so it can be re-loaded on session
 *     restore. Remote backends (S3, DA) don't use this store.
 *
 *   - **`mount-entries`** (new, since v2):
 *     keyed by `targetPath` (the VFS mount path), value is `MountTableEntry`
 *     — the descriptor + metadata needed to reconstruct any backend on
 *     session restore. No live objects, secrets, or `Uint8Array`s.
 *
 * Migration v1→v2 walks the legacy `mounts` keys and seeds matching
 * `mount-entries` rows with `kind: 'local'`. Idempotent — re-running on
 * already-upgraded rows is a no-op.
 */

import { newMountId } from './mount/mount-id.js';

const DB_NAME = 'slicc-mount-table';
const DB_VERSION = 2;
const HANDLE_STORE = 'mounts';
const ENTRY_STORE = 'mount-entries';

/**
 * Stable per-mount identity + everything needed to reconstruct a backend on
 * session restore. Persisted across sessions; never carries live objects,
 * resolved secrets, or `Uint8Array`s.
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

/** Open (or create) the mount-table database, applying schema migrations. */
function openDB(): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (event) => {
      const db = req.result;
      const oldVersion = event.oldVersion;
      if (!db.objectStoreNames.contains(HANDLE_STORE)) {
        db.createObjectStore(HANDLE_STORE);
      }
      if (!db.objectStoreNames.contains(ENTRY_STORE)) {
        db.createObjectStore(ENTRY_STORE);
      }
      if (oldVersion < 2) {
        // Migrate legacy { path → handle } rows in `mounts` to
        // MountTableEntry rows in `mount-entries`. Generates a fresh
        // mountId and uses the legacy key as both targetPath and
        // idbHandleKey. Handles stay in `mounts` untouched.
        const tx = req.transaction!;
        const handleStore = tx.objectStore(HANDLE_STORE);
        const entryStore = tx.objectStore(ENTRY_STORE);
        const keysReq = handleStore.getAllKeys();
        keysReq.onsuccess = () => {
          for (const key of keysReq.result as IDBValidKey[]) {
            if (typeof key !== 'string') continue;
            const entry: MountTableEntry = {
              targetPath: key,
              descriptor: {
                kind: 'local',
                mountId: newMountId(),
                idbHandleKey: key,
              },
              createdAt: Date.now(),
            };
            entryStore.put(entry, key);
          }
        };
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Persist a mount entry. For local backends, also stash the
 * `FileSystemDirectoryHandle` in the legacy `mounts` store keyed by
 * `descriptor.idbHandleKey` (typically equal to `entry.targetPath`).
 */
export async function saveMountEntry(
  entry: MountTableEntry,
  handle?: FileSystemDirectoryHandle
): Promise<void> {
  const db = await openDB();
  try {
    const stores =
      entry.descriptor.kind === 'local' && handle ? [HANDLE_STORE, ENTRY_STORE] : [ENTRY_STORE];
    const tx = db.transaction(stores, 'readwrite');
    tx.objectStore(ENTRY_STORE).put(entry, entry.targetPath);
    if (entry.descriptor.kind === 'local' && handle) {
      tx.objectStore(HANDLE_STORE).put(handle, entry.descriptor.idbHandleKey);
    }
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

/**
 * Remove a mount entry. Drops the descriptor from `mount-entries` and (for
 * local backends) the handle from `mounts`. Both deletes are issued in a
 * single transaction so unmount is atomic.
 */
export async function removeMountEntry(targetPath: string): Promise<void> {
  const db = await openDB();
  try {
    const tx = db.transaction([HANDLE_STORE, ENTRY_STORE], 'readwrite');
    tx.objectStore(ENTRY_STORE).delete(targetPath);
    // The legacy handle store is keyed by idbHandleKey, which today equals
    // targetPath for local mounts. We don't have the descriptor here, so
    // delete by targetPath as a best-effort match — works for the common
    // case where idbHandleKey == targetPath.
    tx.objectStore(HANDLE_STORE).delete(targetPath);
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
export async function getAllMountEntries(): Promise<MountTableEntry[]> {
  const db = await openDB();
  try {
    return await new Promise<MountTableEntry[]>((resolve, reject) => {
      const tx = db.transaction(ENTRY_STORE, 'readonly');
      const req = tx.objectStore(ENTRY_STORE).getAll();
      req.onsuccess = () => resolve(req.result as MountTableEntry[]);
      req.onerror = () => reject(req.error);
      tx.onabort = () =>
        reject(tx.error ?? new DOMException('IndexedDB transaction aborted', 'AbortError'));
    });
  } finally {
    db.close();
  }
}

/** Load the live `FileSystemDirectoryHandle` for a local mount. */
export async function loadMountHandle(
  idbHandleKey: string
): Promise<FileSystemDirectoryHandle | null> {
  const db = await openDB();
  try {
    return await new Promise<FileSystemDirectoryHandle | null>((resolve, reject) => {
      const tx = db.transaction(HANDLE_STORE, 'readonly');
      const req = tx.objectStore(HANDLE_STORE).get(idbHandleKey);
      req.onsuccess = () => resolve((req.result as FileSystemDirectoryHandle | undefined) ?? null);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

/** Remove all mount entries and handles from IndexedDB. */
export async function clearMountEntries(): Promise<void> {
  const db = await openDB();
  try {
    const tx = db.transaction([HANDLE_STORE, ENTRY_STORE], 'readwrite');
    tx.objectStore(HANDLE_STORE).clear();
    tx.objectStore(ENTRY_STORE).clear();
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
