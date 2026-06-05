/**
 * Deferred legacy `slicc-fs` IndexedDB cleanup.
 *
 * After the OPFS migration atomically writes `/.slicc-migrated` into
 * the OPFS-backed VFS, the legacy `slicc-fs` LightningFS IDB is
 * intentionally KEPT for at least one release as a one-version
 * rollback escape hatch. This module owns the explicit, user-invoked
 * deletion path:
 *
 *   1. Refuse to delete unless the OPFS sentinel is present (refusing
 *      would otherwise destroy the only path back to LFS in a partial /
 *      failed migration).
 *   2. If the legacy IDB is already absent, report a no-op.
 *   3. Otherwise call `indexedDB.deleteDatabase('slicc-fs')` and surface
 *      success / blocked / error to the caller.
 *
 * All I/O is dependency-injected so the pure orchestration can be
 * exercised without `indexedDB` / `fake-indexeddb`. The VFS-bound
 * wrapper at the bottom of this file plugs in the real probe + delete
 * implementations for production use.
 *
 * Secret-safe: only counts / IDB-name / outcome strings are surfaced.
 * No file paths or contents are ever read or logged.
 */

import type { VirtualFS } from '../virtual-fs.js';
import {
  LEGACY_LFS_DB_NAME,
  type MigrationLogger,
  OPFS_MIGRATION_SENTINEL,
} from './migration-detect.js';

/** Outcome kinds surfaced to the caller (and the `slicc-fs-cleanup` shell command). */
export type LegacyIdbCleanupKind = 'sentinel-missing' | 'absent' | 'deleted' | 'blocked' | 'error';

export interface LegacyIdbCleanupResult {
  kind: LegacyIdbCleanupKind;
  message: string;
}

export interface CleanupLegacyIdbDeps {
  /** Returns true if the OPFS sentinel exists on the worker-owned VFS. */
  sentinelExists: () => Promise<boolean>;
  /** Returns true if the legacy `slicc-fs` IDB exists in this origin. */
  probeLegacyDbExists: () => Promise<boolean>;
  /**
   * Deletes the legacy IDB. Implementations should treat `onblocked`
   * as a non-fatal "deletion blocked by another connection" outcome
   * and resolve `'blocked'` rather than throwing.
   */
  deleteLegacyDb: () => Promise<'deleted' | 'blocked' | 'error'>;
  logger?: MigrationLogger;
}

/**
 * Run the explicit cleanup. Pure orchestration — all environmental
 * dependencies are injected so tests can drive every branch without
 * needing `fake-indexeddb`.
 */
export async function cleanupLegacyIdb(
  deps: CleanupLegacyIdbDeps
): Promise<LegacyIdbCleanupResult> {
  if (!(await deps.sentinelExists())) {
    const message =
      'migration sentinel not present (/.slicc-migrated) — refusing to delete legacy slicc-fs IDB';
    deps.logger?.warn?.(`[slicc-fs-cleanup] ${message}`);
    return { kind: 'sentinel-missing', message };
  }
  if (!(await deps.probeLegacyDbExists())) {
    const message = 'legacy slicc-fs IDB not present — nothing to clean';
    deps.logger?.info?.(`[slicc-fs-cleanup] ${message}`);
    return { kind: 'absent', message };
  }
  const outcome = await deps.deleteLegacyDb();
  if (outcome === 'deleted') {
    const message = 'legacy slicc-fs IDB deleted';
    deps.logger?.info?.(`[slicc-fs-cleanup] ${message}`);
    return { kind: 'deleted', message };
  }
  if (outcome === 'blocked') {
    const message =
      'legacy slicc-fs IDB delete blocked by another connection — close other tabs and retry';
    deps.logger?.warn?.(`[slicc-fs-cleanup] ${message}`);
    return { kind: 'blocked', message };
  }
  const message = 'legacy slicc-fs IDB delete failed';
  deps.logger?.warn?.(`[slicc-fs-cleanup] ${message}`);
  return { kind: 'error', message };
}

/**
 * VFS-bound default — drives {@link cleanupLegacyIdb} with the real
 * `indexedDB` probe + delete and a sentinel check against the
 * OPFS-backed shared VFS. Callers must ensure `sharedFs.backend === 'opfs'`
 * before invoking; the LFS-default path has no sentinel to consult.
 */
export async function cleanupLegacyIdbFromVfs(
  sharedFs: VirtualFS,
  logger?: MigrationLogger
): Promise<LegacyIdbCleanupResult> {
  return cleanupLegacyIdb({
    sentinelExists: () => sentinelExistsOnVfs(sharedFs),
    probeLegacyDbExists: probeLegacyIdbExistsDefault,
    deleteLegacyDb: deleteLegacyIdbDefault,
    logger,
  });
}

/** Default sentinel probe — stats the marker file on the OPFS-backed VFS. */
export async function sentinelExistsOnVfs(sharedFs: VirtualFS): Promise<boolean> {
  try {
    await sharedFs.stat(OPFS_MIGRATION_SENTINEL);
    return true;
  } catch {
    return false;
  }
}

/**
 * Best-effort IDB-existence probe via `indexedDB.databases()`. Older
 * runtimes that don't expose `databases()` fall through to `true` so the
 * caller surfaces the blocked / error outcome of the actual delete
 * rather than incorrectly reporting "nothing to clean".
 */
export async function probeLegacyIdbExistsDefault(): Promise<boolean> {
  try {
    const factory = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
    if (!factory) return false;
    const databases = (factory as { databases?: () => Promise<{ name?: string }[]> }).databases;
    if (typeof databases !== 'function') return true;
    const dbs = await databases.call(factory);
    return dbs.some((d) => d.name === LEGACY_LFS_DB_NAME);
  } catch {
    return true;
  }
}

/**
 * Default deletion — wraps `indexedDB.deleteDatabase('slicc-fs')`. The
 * `onblocked` branch resolves `'blocked'` (instead of hanging) so a
 * holding connection in a peer tab surfaces a clear retry message
 * rather than wedging the shell.
 */
export async function deleteLegacyIdbDefault(): Promise<'deleted' | 'blocked' | 'error'> {
  const factory = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  if (!factory) return 'error';
  return new Promise((resolve) => {
    let req: IDBOpenDBRequest;
    try {
      req = factory.deleteDatabase(LEGACY_LFS_DB_NAME);
    } catch {
      resolve('error');
      return;
    }
    req.onsuccess = () => resolve('deleted');
    req.onerror = () => resolve('error');
    req.onblocked = () => resolve('blocked');
  });
}
