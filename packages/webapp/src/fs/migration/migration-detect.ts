/**
 * Worker migration detection + legacy IDB read-only walk.
 *
 * Under the `slicc_opfs_vfs` flag the worker boots into the OPFS-backed
 * VirtualFS. On first boot the legacy `slicc-fs` LightningFS IndexedDB
 * still holds the user's data; the copy step will move it across, gated
 * by a `/.slicc-migrated` sentinel in the worker-owned OPFS.
 *
 * This module is **detection only**:
 *   1. Sentinel present in OPFS → fast no-op; legacy IDB is NOT touched.
 *   2. Sentinel absent → open the legacy `slicc-fs` IDB strictly read-only
 *      (LightningFS `readdir` / `lstat` / `readlink` only — never any
 *      write API) and build an in-memory manifest of files, directories,
 *      and symlinks.
 *
 * The boot log emits **counts only** (file/dir/symlink/totalBytes); paths
 * and contents are never logged. The flag-off path never imports this
 * module — the integration site in `host.ts` guards on
 * `sharedFs.backend === 'opfs'`.
 */

import type { VirtualFS } from '../virtual-fs.js';

/** Sentinel path inside the worker-owned OPFS subdir. */
export const OPFS_MIGRATION_SENTINEL = '/.slicc-migrated';

/** Default legacy LightningFS IndexedDB name. */
export const LEGACY_LFS_DB_NAME = 'slicc-fs';

export interface MigrationFileEntry {
  type: 'file';
  path: string;
  size: number;
}
export interface MigrationDirEntry {
  type: 'dir';
  path: string;
}
export interface MigrationSymlinkEntry {
  type: 'symlink';
  path: string;
  target: string;
}
export type MigrationEntry = MigrationFileEntry | MigrationDirEntry | MigrationSymlinkEntry;

export interface MigrationManifest {
  entries: MigrationEntry[];
  fileCount: number;
  dirCount: number;
  symlinkCount: number;
  totalBytes: number;
}

export type MigrationDetectionResult =
  | { kind: 'sentinel-present' }
  | { kind: 'legacy-absent'; manifest: MigrationManifest }
  | { kind: 'needs-migration'; manifest: MigrationManifest };

/** Minimal read-only subset of `FS.PromisifiedFS` used by the walker. */
export interface LegacyFsStats {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  size: number;
}
export interface LegacyLfsReader {
  readdir(path: string): Promise<string[]>;
  lstat(path: string): Promise<LegacyFsStats>;
  readlink(path: string): Promise<string>;
}

export interface MigrationLogger {
  info?: (msg: string, ctx?: unknown) => void;
  warn?: (msg: string, ctx?: unknown) => void;
}

export interface DetectLegacyMigrationOptions {
  /** Returns true if the OPFS sentinel exists. */
  sentinelExists: () => Promise<boolean>;
  /** Lazily constructs the legacy LightningFS read instance. */
  lfsFactory: () => Promise<LegacyLfsReader> | LegacyLfsReader;
  /**
   * Optional probe — when present and returning false, the walk is
   * skipped (no LightningFS instance constructed) and an empty manifest
   * is returned. Avoids creating an empty legacy IDB on a clean origin.
   */
  probeLegacyDbExists?: () => Promise<boolean>;
  logger?: MigrationLogger;
}

/**
 * Run the C1 detection. Pure function — all I/O is injected for testability.
 */
export async function detectLegacyMigration(
  opts: DetectLegacyMigrationOptions
): Promise<MigrationDetectionResult> {
  if (await opts.sentinelExists()) {
    opts.logger?.info?.('[migration] OPFS sentinel present — skipping legacy walk');
    return { kind: 'sentinel-present' };
  }
  if (opts.probeLegacyDbExists) {
    const exists = await opts.probeLegacyDbExists();
    if (!exists) {
      opts.logger?.info?.('[migration] legacy slicc-fs IDB not present — empty manifest');
      return { kind: 'legacy-absent', manifest: emptyManifest() };
    }
  }
  const lfs = await opts.lfsFactory();
  const manifest = await walkLegacyTree(lfs);
  opts.logger?.info?.('[migration] legacy slicc-fs walk complete', {
    files: manifest.fileCount,
    dirs: manifest.dirCount,
    symlinks: manifest.symlinkCount,
    totalBytes: manifest.totalBytes,
  });
  return { kind: 'needs-migration', manifest };
}

function emptyManifest(): MigrationManifest {
  return { entries: [], fileCount: 0, dirCount: 0, symlinkCount: 0, totalBytes: 0 };
}

/**
 * BFS walk over the legacy tree using read-only LightningFS methods.
 * `readdir` / `lstat` / `readlink` are non-mutating in LightningFS; no
 * write API is called from this function.
 */
async function walkLegacyTree(lfs: LegacyLfsReader): Promise<MigrationManifest> {
  const manifest = emptyManifest();
  const queue: string[] = ['/'];
  while (queue.length > 0) {
    const dir = queue.shift() as string;
    const names = await safeReaddir(lfs, dir);
    for (const name of names) {
      const path = dir === '/' ? `/${name}` : `${dir}/${name}`;
      await classifyAndAppend(lfs, path, manifest, queue);
    }
  }
  return manifest;
}

async function safeReaddir(lfs: LegacyLfsReader, dir: string): Promise<string[]> {
  try {
    return await lfs.readdir(dir);
  } catch {
    return [];
  }
}

async function classifyAndAppend(
  lfs: LegacyLfsReader,
  path: string,
  manifest: MigrationManifest,
  queue: string[]
): Promise<void> {
  let stats: LegacyFsStats;
  try {
    stats = await lfs.lstat(path);
  } catch {
    return;
  }
  if (stats.isSymbolicLink()) {
    const target = await safeReadlink(lfs, path);
    manifest.entries.push({ type: 'symlink', path, target });
    manifest.symlinkCount++;
    return;
  }
  if (stats.isDirectory()) {
    manifest.entries.push({ type: 'dir', path });
    manifest.dirCount++;
    queue.push(path);
    return;
  }
  if (stats.isFile()) {
    const size = typeof stats.size === 'number' ? stats.size : 0;
    manifest.entries.push({ type: 'file', path, size });
    manifest.fileCount++;
    manifest.totalBytes += size;
  }
}

async function safeReadlink(lfs: LegacyLfsReader, path: string): Promise<string> {
  try {
    return await lfs.readlink(path);
  } catch {
    return '';
  }
}

/**
 * Worker-boot integration: probe the sentinel via the (OPFS-backed)
 * shared VirtualFS and, when absent, open a real LightningFS read
 * instance for the legacy `slicc-fs` IDB. Callers MUST guard on
 * `sharedFs.backend === 'opfs'` so the LFS-backend path stays
 * byte-identical to before.
 */
export async function detectLegacyMigrationFromVfs(
  sharedFs: VirtualFS,
  logger?: MigrationLogger
): Promise<MigrationDetectionResult> {
  return detectLegacyMigration({
    sentinelExists: async () => {
      try {
        await sharedFs.stat(OPFS_MIGRATION_SENTINEL);
        return true;
      } catch {
        return false;
      }
    },
    probeLegacyDbExists: async () => probeIdbExists(LEGACY_LFS_DB_NAME),
    lfsFactory: async () => {
      const FS = (await import('@isomorphic-git/lightning-fs')).default;
      return new FS(LEGACY_LFS_DB_NAME).promises as unknown as LegacyLfsReader;
    },
    logger,
  });
}

/**
 * Best-effort IDB-existence probe via `indexedDB.databases()`. Older
 * runtimes that don't expose `databases()` fall through to `true` so the
 * walk still runs (LightningFS's lazy root-init is a no-data side
 * effect).
 */
async function probeIdbExists(dbName: string): Promise<boolean> {
  try {
    const factory = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
    if (!factory) return false;
    const databases = (factory as { databases?: () => Promise<{ name?: string }[]> }).databases;
    if (typeof databases !== 'function') return true;
    const dbs = await databases.call(factory);
    return dbs.some((d) => d.name === dbName);
  } catch {
    return true;
  }
}
