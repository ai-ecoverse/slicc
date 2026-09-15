import { resolveMountConfig } from '@zenfs/core';
import { WebAccess } from '@zenfs/dom';
import { repairOpfsMetadataSidecar, resolveWithSidecarRepair } from './sidecar-repair.js';

/** DOM 1.2.14 wires the core semaphore through; 16 is the native-browser tested limit. */
const OPFS_PRELOAD_MAX_OPEN_FILES = 16;

interface OpfsMountOptions {
  handle: FileSystemDirectoryHandle;
  dbName: string;
  asyncCache?: boolean;
  onRepairProgress?: () => void;
  withWriteLock: <T>(operation: () => Promise<T>) => Promise<T>;
}

/** Loaded only when creating an OPFS backend; repairs share the sidecar's write lock. */
export async function resolveOpfsMount({
  handle,
  dbName,
  asyncCache,
  onRepairProgress,
  withWriteLock,
}: OpfsMountOptions) {
  const repair = () => withWriteLock(() => repairOpfsMetadataSidecar(handle, onRepairProgress));
  // Undersized entries and colliding inodes can silently corrupt reads without
  // throwing during mount (#2146). Repair before ZenFS parses the sidecar.
  try {
    const preboot = await repair();
    if (preboot?.changed) {
      console.warn('[virtual-fs] repaired metadata sidecar before mount (#2146)', {
        dbName,
        kindFixed: preboot.kindFixed,
        sizesFixed: preboot.sizesFixed,
        dropped: preboot.dropped,
        inosReassigned: preboot.inosReassigned,
        nlinksFixed: preboot.nlinksFixed,
        selfEntryDropped: preboot.selfEntryDropped,
      });
    }
  } catch {
    /* Best-effort; the on-throw retry below still covers hard failures. */
  }
  // Kind flips and stale paths may throw while preloading (#1984). Recheck the
  // real tree and retry once; preserve the failure if repair cannot recover it.
  return resolveWithSidecarRepair(
    () =>
      resolveMountConfig({
        backend: WebAccess,
        handle,
        metadata: '/.metadata.json',
        maxOpenFilesForCopy: OPFS_PRELOAD_MAX_OPEN_FILES,
        disableAsyncCache: asyncCache === false,
      }),
    repair,
    (summary) =>
      console.warn('[virtual-fs] repaired poisoned metadata sidecar; retrying mount', {
        dbName,
        kindFixed: summary.kindFixed,
        sizesFixed: summary.sizesFixed,
        dropped: summary.dropped,
        nlinksFixed: summary.nlinksFixed,
        selfEntryDropped: summary.selfEntryDropped,
      })
  );
}
