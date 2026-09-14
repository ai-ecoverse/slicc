import type { Command } from 'just-bash';
import { defineCommand } from 'just-bash';

const LEGACY_LFS_DB_NAME = 'slicc-fs';

export type LegacyIdbCleanupKind = 'absent' | 'deleted' | 'blocked' | 'error';

export interface LegacyIdbCleanupResult {
  kind: LegacyIdbCleanupKind;
  message: string;
}

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
