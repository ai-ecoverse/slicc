import { resolveMountConfig } from '@zenfs/core';
import { WebAccess } from '@zenfs/dom';
import { repairOpfsMetadataSidecar, resolveWithSidecarRepair } from './sidecar-repair.js';

const OPFS_PRELOAD_MAX_OPEN_FILES = 16;

interface OpfsMountOptions {
  handle: FileSystemDirectoryHandle;
  dbName: string;
  asyncCache?: boolean;
  onRepairProgress?: () => void;
  withWriteLock: <T>(operation: () => Promise<T>) => Promise<T>;
}

export async function resolveOpfsMount({
  handle,
  dbName,
  asyncCache,
  onRepairProgress,
  withWriteLock,
}: OpfsMountOptions) {
  const repair = () => withWriteLock(() => repairOpfsMetadataSidecar(handle, onRepairProgress));

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
  } catch {}

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
