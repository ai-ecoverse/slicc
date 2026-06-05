/**
 * Copy a legacy LightningFS manifest into OPFS, verify file-count
 * (presence) parity, then atomically write the `/.slicc-migrated`
 * sentinel as the final operation.
 *
 * This module is **pure transport**: all I/O is injected. The
 * detection manifest is taken as input (no re-walk of the legacy
 * store), file bytes are read strictly READ-ONLY from the legacy
 * LFS (the IDB is the rollback escape hatch and must never be
 * mutated; deletion is deferred to a separate cleanup step), bytes
 * are written into OPFS via the injected target writer, the OPFS
 * tree is then walked to confirm each manifest file is present, and
 * only on success does the
 * caller-supplied `writeSentinel` run. Byte totals are still
 * collected and logged as a diagnostic but do NOT gate the sentinel:
 * concurrent boot writes (orchestrator defaults, sidecar metadata)
 * legitimately drift the OPFS byte total away from the manifest's
 * snapshot.
 *
 * Logging is **counts only** — no filenames, contents, sizes per
 * file. Symmetric to C1's secret-safe logging.
 */

import type { MigrationLogger, MigrationManifest } from './migration-detect.js';

/** Sentinel path inside the worker-owned OPFS subdir. */
export const OPFS_MIGRATION_SENTINEL = '/.slicc-migrated';

/** Strictly read-only legacy source — file bytes only. */
export interface LegacyFileReader {
  readFile(path: string): Promise<Uint8Array>;
}

/**
 * OPFS-side writer. Methods mirror the subset of ZenFS `fs.promises`
 * we need: idempotent recursive `mkdir`, byte `writeFile`, and
 * `symlink` (lands in the OPFS metadata sidecar).
 */
export interface OpfsTargetWriter {
  mkdir(path: string): Promise<void>;
  writeFile(path: string, content: Uint8Array): Promise<void>;
  symlink(target: string, linkPath: string): Promise<void>;
}

/** Result of the post-copy parity walk over OPFS. */
export interface OpfsParityCount {
  fileCount: number;
  totalBytes: number;
}

export interface RunLegacyMigrationCopyOptions {
  manifest: MigrationManifest;
  source: LegacyFileReader;
  target: OpfsTargetWriter;
  /**
   * Count OPFS files + sum their bytes for the parity gate. Excludes
   * symlinks (counted separately in the manifest) and the sentinel
   * (not yet written at parity-check time). The count is what gates
   * the sentinel (presence-based parity); the byte total is logged
   * as a diagnostic only.
   */
  countOpfsFiles: () => Promise<OpfsParityCount>;
  /**
   * Best-effort durability hook called AFTER the copy but BEFORE the
   * parity walk + sentinel write. Used by the VFS-bound runner to
   * flush the ZenFS `WebAccessFS` metadata sidecar so symlinks +
   * filemode survive a crash before the sentinel lands.
   */
  flushBeforeSentinel?: () => Promise<void>;
  /**
   * Writes the sentinel atomically. Called LAST, only on count
   * (presence) parity. The runner typically implements this as a
   * single `writeFile` to `/.slicc-migrated` (atomic at the OPFS
   * layer for a single write call) followed by another sidecar
   * flush.
   */
  writeSentinel: () => Promise<void>;
  /**
   * Optional per-file progress hook. Invoked after each successful
   * `writeFile` with the running copy count and the manifest's total
   * file count. The runner uses this to plumb a UI progress bar over
   * the kernel port; tests that don't care omit it.
   */
  onProgress?: (progress: { copied: number; total: number }) => void;
  logger?: MigrationLogger;
}

export type MigrationCopyResult =
  | { kind: 'success'; fileCount: number; totalBytes: number }
  | {
      kind: 'parity-mismatch';
      expected: { fileCount: number; totalBytes: number };
      actual: { fileCount: number; totalBytes: number };
    }
  | {
      kind: 'copy-error';
      expected: { fileCount: number; totalBytes: number };
      copiedFiles: number;
      stage: 'mkdir' | 'writeFile' | 'symlink' | 'read';
    };

/**
 * Run the C2 copy + parity + sentinel sequence.
 *
 * Order is load-bearing:
 *   1. mkdir all directories (parents before children, by depth).
 *   2. writeFile all file bytes (read from source, write to target).
 *   3. symlink all symlinks (after dirs/files so targets exist).
 *   4. flushBeforeSentinel() — persists metadata sidecar.
 *   5. countOpfsFiles() — parity walk over OPFS.
 *   6. ONLY on count (presence) parity match — every manifest file
 *      is present on OPFS — writeSentinel() runs as the FINAL
 *      operation. Byte totals are logged as a diagnostic; drift
 *      between manifest bytes and live OPFS bytes (boot rewrites,
 *      orchestrator defaults) is expected and does NOT gate the
 *      sentinel.
 *
 * On any copy error OR parity mismatch the function returns a
 * non-success result WITHOUT invoking `writeSentinel`. The OPFS state
 * is left as-is for a retry on the next boot and the legacy store
 * (which we only read from) is untouched.
 */
export async function runLegacyMigrationCopy(
  opts: RunLegacyMigrationCopyOptions
): Promise<MigrationCopyResult> {
  const { manifest, source, target, logger } = opts;
  const expected = { fileCount: manifest.fileCount, totalBytes: manifest.totalBytes };

  const dirs = manifest.entries
    .filter((e) => e.type === 'dir')
    .sort((a, b) => depthOf(a.path) - depthOf(b.path));
  const files = manifest.entries.filter((e) => e.type === 'file');
  const symlinks = manifest.entries.filter((e) => e.type === 'symlink');

  // 1. Directories first, parents before children.
  for (const entry of dirs) {
    try {
      await target.mkdir(entry.path);
    } catch (err) {
      logger?.warn?.('[migration] mkdir failed during C2 copy', {
        copiedFiles: 0,
        stage: 'mkdir',
        code: errCode(err),
      });
      return {
        kind: 'copy-error',
        expected,
        copiedFiles: 0,
        stage: 'mkdir',
      };
    }
  }

  // 2. File bytes.
  let copiedFiles = 0;
  // Initial progress tick so the splash flips from "Preparing…" to a
  // real ratio the moment the copy starts.
  try {
    opts.onProgress?.({ copied: 0, total: expected.fileCount });
  } catch {
    /* progress hook must never break the copy */
  }
  for (const entry of files) {
    if (entry.type !== 'file') continue;
    let bytes: Uint8Array;
    try {
      bytes = await source.readFile(entry.path);
    } catch (err) {
      logger?.warn?.('[migration] legacy read failed during C2 copy', {
        copiedFiles,
        stage: 'read',
        code: errCode(err),
      });
      return { kind: 'copy-error', expected, copiedFiles, stage: 'read' };
    }
    try {
      await target.writeFile(entry.path, bytes);
    } catch (err) {
      logger?.warn?.('[migration] OPFS write failed during C2 copy', {
        copiedFiles,
        stage: 'writeFile',
        code: errCode(err),
      });
      return { kind: 'copy-error', expected, copiedFiles, stage: 'writeFile' };
    }
    copiedFiles++;
    try {
      opts.onProgress?.({ copied: copiedFiles, total: expected.fileCount });
    } catch {
      /* progress hook must never break the copy */
    }
  }

  // 3. Symlinks last so the targets/dirs they may point at exist.
  // EEXIST is tolerated: the writer is expected to no-op on an
  // identical existing link and replace a mismatched one, but if the
  // writer surface still surfaces EEXIST (e.g. an underlying backend
  // raced) we treat it as already-copied rather than aborting the
  // whole re-run. Any other failure aborts so the sentinel is not
  // written and the next boot retries against the legacy IDB.
  let symlinkEexistSkipped = 0;
  for (const entry of symlinks) {
    if (entry.type !== 'symlink') continue;
    try {
      await target.symlink(entry.target, entry.path);
    } catch (err) {
      if (errCode(err) === 'EEXIST') {
        symlinkEexistSkipped++;
        continue;
      }
      logger?.warn?.('[migration] symlink failed during C2 copy', {
        copiedFiles,
        stage: 'symlink',
        code: errCode(err),
      });
      return { kind: 'copy-error', expected, copiedFiles, stage: 'symlink' };
    }
  }
  if (symlinkEexistSkipped > 0) {
    logger?.info?.('[migration] tolerated pre-existing symlinks during C2 re-run', {
      skipped: symlinkEexistSkipped,
      symlinks: manifest.symlinkCount,
    });
  }

  // 4. Persist metadata sidecar (symlinks, filemode) before parity check.
  if (opts.flushBeforeSentinel) {
    try {
      await opts.flushBeforeSentinel();
    } catch (err) {
      logger?.warn?.('[migration] sidecar flush failed before parity', {
        code: errCode(err),
      });
      // Treat as copy error so the sentinel is not written.
      return { kind: 'copy-error', expected, copiedFiles, stage: 'writeFile' };
    }
  }

  // 5. Parity walk over OPFS — presence (count) only. The byte total
  // is informational: boot writes (orchestrator defaults, sidecar
  // metadata) legitimately drift the OPFS byte total away from the
  // manifest snapshot, so we log the delta but never fail on it.
  const actual = await opts.countOpfsFiles();
  const byteDelta = actual.totalBytes - expected.totalBytes;
  if (actual.fileCount !== expected.fileCount) {
    logger?.warn?.('[migration] parity mismatch — sentinel NOT written', {
      expectedFiles: expected.fileCount,
      actualFiles: actual.fileCount,
      expectedBytes: expected.totalBytes,
      actualBytes: actual.totalBytes,
      byteDelta,
    });
    return { kind: 'parity-mismatch', expected, actual };
  }
  if (byteDelta !== 0) {
    logger?.info?.('[migration] byte drift tolerated (count parity matched)', {
      expectedBytes: expected.totalBytes,
      actualBytes: actual.totalBytes,
      byteDelta,
    });
  }

  // 6. Atomic sentinel write — FINAL operation.
  await opts.writeSentinel();
  logger?.info?.('[migration] C2 copy complete, sentinel written', {
    files: actual.fileCount,
    totalBytes: actual.totalBytes,
    expectedBytes: expected.totalBytes,
    byteDelta,
    symlinks: manifest.symlinkCount,
    dirs: manifest.dirCount,
  });
  return { kind: 'success', fileCount: actual.fileCount, totalBytes: actual.totalBytes };
}

function depthOf(path: string): number {
  // `/` → 0, `/a` → 1, `/a/b` → 2 ...
  if (path === '/') return 0;
  let n = 0;
  for (let i = 0; i < path.length; i++) if (path.charCodeAt(i) === 47) n++;
  return n;
}

function errCode(err: unknown): string | undefined {
  const c = (err as { code?: unknown })?.code;
  return typeof c === 'string' ? c : undefined;
}
