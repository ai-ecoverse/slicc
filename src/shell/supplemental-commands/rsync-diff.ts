/**
 * Pure diff engine for rsync-style file synchronization.
 *
 * Compares source and destination file entries (path + mtime + size)
 * and computes the set of operations needed to synchronize them.
 */

/** Metadata about a file in a directory tree. */
export interface RsyncEntry {
  /** Relative path from the sync root (forward-slash separated). */
  path: string;
  /** Size in bytes. */
  size: number;
  /** Last modification time in milliseconds since epoch. */
  mtimeMs: number;
}

/** Options controlling how the diff is computed. */
export interface RsyncDiffOptions {
  /** When true, files present in dest but not in source are marked for deletion. */
  delete?: boolean;
}

/** Actions computed by the diff engine. */
export interface RsyncDiffResult {
  /** Files present in source but not in dest — need to be copied. */
  toAdd: string[];
  /** Files present in both but with different mtime or size — need to be overwritten. */
  toUpdate: string[];
  /** Files present in dest but not in source — only populated when `delete` option is set. */
  toDelete: string[];
  /** Files present in both with same mtime AND size — no action needed. */
  toSkip: string[];
}

/**
 * Compare source and destination entry lists, returning the operations
 * needed to make dest match source.
 *
 * Comparison is by path + mtime + size. Files with identical mtime AND
 * size are skipped (assumed unchanged).
 */
export function computeRsyncDiff(
  sourceEntries: RsyncEntry[],
  destEntries: RsyncEntry[],
  options: RsyncDiffOptions = {}
): RsyncDiffResult {
  const destMap = new Map<string, RsyncEntry>();
  for (const entry of destEntries) {
    destMap.set(entry.path, entry);
  }

  const sourceSet = new Set<string>();
  const toAdd: string[] = [];
  const toUpdate: string[] = [];
  const toSkip: string[] = [];

  for (const src of sourceEntries) {
    sourceSet.add(src.path);
    const dst = destMap.get(src.path);

    if (!dst) {
      toAdd.push(src.path);
    } else if (dst.size === src.size && dst.mtimeMs === src.mtimeMs) {
      toSkip.push(src.path);
    } else {
      toUpdate.push(src.path);
    }
  }

  const toDelete: string[] = [];
  if (options.delete) {
    for (const dst of destEntries) {
      if (!sourceSet.has(dst.path)) {
        toDelete.push(dst.path);
      }
    }
  }

  return { toAdd, toUpdate, toDelete, toSkip };
}
