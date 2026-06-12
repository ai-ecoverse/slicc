/**
 * `slicc-fs-cleanup` — delete the legacy `slicc-fs` LightningFS
 * IndexedDB.
 *
 * The legacy IDB → OPFS migration code was removed (every active
 * profile migrated long ago, and the boot-time copy could resurrect
 * stale legacy content — e.g. sprinkles deleted from OPFS reappearing
 * from the old IDB). Nothing reads the legacy database anymore; this
 * one-shot command performs its deletion ONLY on explicit user
 * invocation. There is deliberately no read path left to roll back to.
 *
 * Secret-safe: only the IDB name and outcome are surfaced. No file
 * paths or contents are read.
 */

import type { Command } from 'just-bash';
import { defineCommand } from 'just-bash';

/** IndexedDB name the legacy LightningFS-backed VFS persisted into. */
const LEGACY_LFS_DB_NAME = 'slicc-fs';

/** Outcome kinds surfaced by the cleanup run. */
export type LegacyIdbCleanupKind = 'absent' | 'deleted' | 'blocked' | 'error';

export interface LegacyIdbCleanupResult {
  kind: LegacyIdbCleanupKind;
  message: string;
}

/**
 * Best-effort IDB-existence probe via `indexedDB.databases()`. Runtimes
 * that don't expose `databases()` fall through to `true` so the caller
 * surfaces the blocked / error outcome of the actual delete rather than
 * incorrectly reporting "nothing to clean".
 */
export async function probeLegacyIdbExists(): Promise<boolean> {
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
 * Wraps `indexedDB.deleteDatabase('slicc-fs')`. The `onblocked` branch
 * resolves `'blocked'` (instead of hanging) so a holding connection in a
 * peer tab surfaces a clear retry message rather than wedging the shell.
 */
export async function deleteLegacyIdb(): Promise<'deleted' | 'blocked' | 'error'> {
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

/** Run the cleanup: probe, then delete. Deletion-only — never reads. */
export async function cleanupLegacyIdb(): Promise<LegacyIdbCleanupResult> {
  if (!(await probeLegacyIdbExists())) {
    return { kind: 'absent', message: 'legacy slicc-fs IDB not present — nothing to clean' };
  }
  const outcome = await deleteLegacyIdb();
  if (outcome === 'deleted') {
    return { kind: 'deleted', message: 'legacy slicc-fs IDB deleted' };
  }
  if (outcome === 'blocked') {
    return {
      kind: 'blocked',
      message:
        'legacy slicc-fs IDB delete blocked by another connection — close other tabs and retry',
    };
  }
  return { kind: 'error', message: 'legacy slicc-fs IDB delete failed' };
}

export interface SliccFsCleanupCommandOptions {
  /**
   * Override of the cleanup driver — exposed only for tests so the
   * destructive `indexedDB.deleteDatabase` call can be stubbed without
   * `fake-indexeddb` plumbing.
   */
  runCleanup?: () => Promise<LegacyIdbCleanupResult>;
}

function helpText(): string {
  return `slicc-fs-cleanup — delete the legacy slicc-fs IndexedDB

Usage:
  slicc-fs-cleanup           Delete the legacy slicc-fs IDB.
  slicc-fs-cleanup --help    Show this help.

SLICC's filesystem lives in OPFS; the legacy slicc-fs IndexedDB from
the pre-OPFS era is never read anymore. This command deletes it on
explicit invocation to reclaim the space.
`;
}

const EXIT_CODES: Record<LegacyIdbCleanupResult['kind'], number> = {
  deleted: 0,
  absent: 0,
  blocked: 1,
  error: 1,
};

export function createSliccFsCleanupCommand(options: SliccFsCleanupCommandOptions = {}): Command {
  const run = options.runCleanup ?? cleanupLegacyIdb;
  return defineCommand('slicc-fs-cleanup', async (args) => {
    if (args.includes('--help') || args.includes('-h')) {
      return { stdout: helpText(), stderr: '', exitCode: 0 };
    }
    // Destructive command: refuse anything beyond the bare zero-arg
    // invocation (mirrors `df`'s arg validation). Unknown flags like
    // `--dry-run` must not silently fall through to deletion.
    if (args.length > 0) {
      return {
        stdout: '',
        stderr: `slicc-fs-cleanup: unsupported argument: ${args[0]}\n`,
        exitCode: 1,
      };
    }
    const result = await run();
    const exitCode = EXIT_CODES[result.kind];
    if (exitCode === 0) {
      return { stdout: `${result.message}\n`, stderr: '', exitCode };
    }
    return { stdout: '', stderr: `slicc-fs-cleanup: ${result.message}\n`, exitCode };
  });
}
