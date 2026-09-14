import { newMountId } from './mount/mount-id.js';

const DB_NAME = 'slicc-mount-table';
const DB_VERSION = 2;
const HANDLE_STORE = 'mounts';
const ENTRY_STORE = 'mount-entries';

export type BackendDescriptor =
  | { kind: 'local'; mountId: string; idbHandleKey: string }
  | { kind: 'hostfs'; mountId: string; hostPath: string }
  | { kind: 's3'; mountId: string; source: string; profile: string }
  | { kind: 'da'; mountId: string; source: string; profile: string }
  | { kind: 'aem'; mountId: string; source: string; profile: string };

export interface MountTableEntry {
  targetPath: string;
  descriptor: BackendDescriptor;
  createdAt: number;
}

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

export async function removeMountEntry(targetPath: string): Promise<void> {
  const db = await openDB();
  try {
    const tx = db.transaction([HANDLE_STORE, ENTRY_STORE], 'readwrite');
    tx.objectStore(ENTRY_STORE).delete(targetPath);

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
