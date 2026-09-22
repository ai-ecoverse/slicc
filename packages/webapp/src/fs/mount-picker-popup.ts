import { createLogger } from '../base/logger.js';
import { type DirectoryPickerResult, openPickerPopup } from './picker-popup.js';

const log = createLogger('mount-picker-popup');

const PENDING_MOUNT_DB = 'slicc-pending-mount';
const POPUP_TIMEOUT_MS = 60_000;

export function openMountPickerPopup(requestId?: string): Promise<DirectoryPickerResult> {
  const popupRequestId = requestId ?? `mount-${Date.now().toString(36)}`;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: DirectoryPickerResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => finish({ cancelled: true }), POPUP_TIMEOUT_MS);

    openPickerPopup('directory', [], popupRequestId, { timeoutMs: POPUP_TIMEOUT_MS })
      .then((result) => {
        const r = result as DirectoryPickerResult;
        if (r.error) {
          log.error('picker popup launch failed for directory kind', {
            requestId: popupRequestId,
            error: r.error,
          });
          finish({ error: 'Failed to open directory picker window' });
          return;
        }
        finish(r);
      })
      .catch((err: unknown) => {
        log.error('picker popup launch threw for directory kind', {
          requestId: popupRequestId,
          error: err instanceof Error ? err.message : String(err),
          name: err instanceof Error ? err.name : undefined,
        });
        finish({ error: 'Failed to open directory picker window' });
      });
  });
}

function openPendingMountDB(): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(PENDING_MOUNT_DB, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains('handles')) {
        req.result.createObjectStore('handles');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function storePendingHandle(
  idbKey: string,
  handle: FileSystemDirectoryHandle
): Promise<void> {
  const db = await openPendingMountDB();
  const tx = db.transaction('handles', 'readwrite');
  tx.objectStore('handles').put(handle, idbKey);
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IDB transaction aborted'));
  });
  db.close();
}

export async function listPendingMountKeys(): Promise<string[]> {
  const db = await openPendingMountDB();
  try {
    const tx = db.transaction('handles', 'readonly');
    const req = tx.objectStore('handles').getAllKeys();
    const keys = await new Promise<IDBValidKey[]>((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('IDB getAllKeys failed'));
      tx.onabort = () => reject(tx.error ?? new Error('IDB transaction aborted'));
    });
    return keys.filter((key): key is string => typeof key === 'string');
  } finally {
    db.close();
  }
}

export async function clearPendingMountHandle(idbKey: string): Promise<void> {
  const db = await openPendingMountDB();
  try {
    const tx = db.transaction('handles', 'readwrite');
    tx.objectStore('handles').delete(idbKey);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('IDB transaction failed'));
      tx.onabort = () => reject(tx.error ?? new Error('IDB transaction aborted'));
    });
  } finally {
    db.close();
  }
}

export async function loadAndClearPendingHandle(
  idbKey: string
): Promise<FileSystemDirectoryHandle | null> {
  const db = await openPendingMountDB();
  const tx = db.transaction('handles', 'readwrite');
  const store = tx.objectStore('handles');
  const getReq = store.get(idbKey);
  const deleteReq = store.delete(idbKey);

  deleteReq.onerror = () => {
    log.warn('Failed to delete pending handle from IDB', { idbKey, error: deleteReq.error });
  };
  const handle = await new Promise<FileSystemDirectoryHandle | null>((resolve, reject) => {
    tx.oncomplete = () => resolve(getReq.result ?? null);
    getReq.onerror = () => reject(getReq.error ?? new Error('IDB get failed'));
    tx.onerror = () => reject(tx.error ?? new Error('IDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IDB transaction aborted'));
  });
  db.close();
  return handle;
}

export async function reactivateHandle(handle: FileSystemDirectoryHandle): Promise<void> {
  type HandleWithPermission = FileSystemDirectoryHandle & {
    requestPermission?: (opts: { mode: string }) => Promise<string>;
  };
  const h = handle as HandleWithPermission;
  if (h.requestPermission) {
    const state = await h.requestPermission({ mode: 'readwrite' });
    if (state !== 'granted') {
      throw new Error(`Permission denied for "${handle.name}" (${state})`);
    }
  }
}
