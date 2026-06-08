/**
 * `setup-pending-mount.ts` — IndexedDB-backed pending-mount helpers
 * extracted verbatim from `main.ts`.
 *
 * The welcome flow can stash a `FileSystemDirectoryHandle` chosen via
 * the mount picker popup, then re-apply it after the onboarding
 * orchestrator completes (so the mount lands on the same VFS the
 * cone will see). Both the extension and the standalone-worker boot
 * paths share these helpers.
 */

import type { VirtualFS } from '../../fs/index.js';
import { LocalMountBackend } from '../../fs/mount/backend-local.js';
import { newMountId } from '../../fs/mount/mount-id.js';
import type { BootStageLogger } from './types.js';

const PENDING_MOUNT_DB = 'slicc-pending-mount';
const PENDING_MOUNT_KEY = 'pendingMount';

/** Store a directory handle for later mount during onboarding completion. */
export async function storePendingMount(handle: FileSystemDirectoryHandle): Promise<void> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(PENDING_MOUNT_DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore('handles');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  const tx = db.transaction('handles', 'readwrite');
  tx.objectStore('handles').put(handle, PENDING_MOUNT_KEY);
  await new Promise<void>((r) => (tx.oncomplete = () => r()));
  db.close();
}

/** Retrieve and clear the pending mount handle, then mount it to `/mnt/<dirname>`. */
export async function applyPendingMount(fs: VirtualFS, log: BootStageLogger): Promise<void> {
  let db: IDBDatabase;
  try {
    db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(PENDING_MOUNT_DB, 1);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return; // DB doesn't exist yet
  }
  const tx = db.transaction('handles', 'readwrite');
  const handle = await new Promise<FileSystemDirectoryHandle | undefined>((resolve) => {
    const req = tx.objectStore('handles').get(PENDING_MOUNT_KEY);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(undefined);
  });
  if (handle) {
    tx.objectStore('handles').delete(PENDING_MOUNT_KEY);
    await new Promise<void>((r) => (tx.oncomplete = () => r()));
    const mountPath = `/mnt/${handle.name}`;
    const backend = LocalMountBackend.fromHandle(handle, { mountId: newMountId() });
    await fs.mount(mountPath, backend);
    log.info('Mounted folder from welcome onboarding', { name: handle.name, path: mountPath });
  }
  db.close();
}
