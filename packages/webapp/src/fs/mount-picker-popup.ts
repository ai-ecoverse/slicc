/**
 * Shared helpers for opening the directory picker via a separate Chrome popup
 * window. Used by every extension-side mount entry point: the shell `mount`
 * command, agent-driven approval dips (tool-ui-renderer), and the welcome
 * sprinkle's `request-mount` lick.
 *
 * Why a popup instead of `window.showDirectoryPicker()` directly? Picking a
 * macOS TCC-protected folder (Documents, Downloads, Desktop, home) from the
 * side panel context crashes the panel renderer instead of throwing a normal
 * error. The popup is a regular browser window where TCC dialogs and Chrome's
 * "system folder" rejection render correctly.
 *
 * The popup posts the picked handle to a per-request key in the
 * `slicc-pending-mount` IndexedDB store; callers retrieve it with
 * {@link loadAndClearPendingHandle}, then call {@link reactivateHandle} to
 * re-prompt for permission before using the handle.
 */

import { createLogger } from '../core/logger.js';

const log = createLogger('mount-picker-popup');

const PENDING_MOUNT_DB = 'slicc-pending-mount';
const POPUP_TIMEOUT_MS = 60_000;

/**
 * Opens `mount-popup.html` and resolves with the popup's response message.
 * The response shape is one of:
 *   - `{ handleInIdb: true, idbKey, dirName }` — handle was stored in IDB;
 *     callers must use {@link loadAndClearPendingHandle} to retrieve it,
 *     then {@link reactivateHandle} before using it. The handle itself is
 *     never sent through the runtime message channel — only the IDB key.
 *   - `{ cancelled: true }` — user closed the popup or aborted the picker
 *   - `{ error: string }` — popup failed (e.g. window.create rejected); the
 *     full error is logged separately, callers get a generic message
 *
 * @param requestId Optional request id used to correlate the popup result
 *   with a caller-managed registry entry. Generated if omitted.
 */
export function openMountPickerPopup(requestId?: string): Promise<Record<string, unknown>> {
  const popupRequestId = requestId ?? `mount-${Date.now().toString(36)}`;
  return new Promise((resolve) => {
    const url = chrome.runtime.getURL(
      `mount-popup.html?requestId=${encodeURIComponent(popupRequestId)}`
    );

    const cleanup = () => {
      clearTimeout(timer);
      chrome.runtime.onMessage.removeListener(listener);
    };

    const timer = setTimeout(() => {
      cleanup();
      resolve({ cancelled: true });
    }, POPUP_TIMEOUT_MS);

    const listener = (msg: unknown) => {
      const m = msg as Record<string, unknown>;
      if (!m || m.source !== 'mount-popup' || m.requestId !== popupRequestId) return;
      cleanup();
      resolve(m);
    };
    chrome.runtime.onMessage.addListener(listener);

    chrome.windows
      .create({ url, type: 'popup', width: 300, height: 80, focused: true })
      .catch((err: unknown) => {
        cleanup();
        log.error('chrome.windows.create failed for mount picker popup', {
          requestId: popupRequestId,
          error: err instanceof Error ? err.message : String(err),
          name: err instanceof Error ? err.name : undefined,
        });
        resolve({ error: 'Failed to open directory picker window' });
      });
  });
}

/**
 * Stash a `FileSystemDirectoryHandle` under `idbKey` so the worker-side
 * agent can pick it up via {@link loadAndClearPendingHandle}. Used by
 * the standalone-worker dip path: the picker must fire on the panel's
 * click activation, but the consuming `LocalMountBackend` lives in
 * the kernel worker — IDB is the only structurally-cloneable path
 * that doesn't lose the handle's permission grant.
 *
 * Callers must ensure `idbKey` is unique per request (the existing
 * `pendingMount:<requestId>` convention is fine). The entry is
 * single-use — `loadAndClearPendingHandle` removes it.
 */
export async function storePendingHandle(
  idbKey: string,
  handle: FileSystemDirectoryHandle
): Promise<void> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(PENDING_MOUNT_DB, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains('handles')) {
        req.result.createObjectStore('handles');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  const tx = db.transaction('handles', 'readwrite');
  tx.objectStore('handles').put(handle, idbKey);
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IDB transaction aborted'));
  });
  db.close();
}

/**
 * Reads and removes the pending FileSystemDirectoryHandle the popup wrote
 * under `idbKey`. Returns null if the entry is missing.
 */
export async function loadAndClearPendingHandle(
  idbKey: string
): Promise<FileSystemDirectoryHandle | null> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(PENDING_MOUNT_DB, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains('handles')) {
        req.result.createObjectStore('handles');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  const tx = db.transaction('handles', 'readwrite');
  const store = tx.objectStore('handles');
  const getReq = store.get(idbKey);
  const deleteReq = store.delete(idbKey);
  // Non-fatal: the handle was retrieved successfully; failing to clean up the
  // IDB entry leaves an orphan keyed by an ephemeral request id but doesn't
  // affect this mount. Log via project logger so it surfaces in collected logs.
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

/**
 * Re-prompts for readwrite permission on a handle loaded from IndexedDB.
 * Without this, persisted handles raise NotAllowedError on first use.
 */
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
