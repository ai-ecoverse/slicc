/**
 * `slicc-fs-cleanup` — manual cleanup of the legacy `slicc-fs`
 * LightningFS IndexedDB.
 *
 * After the OPFS migration writes the `/.slicc-migrated` sentinel,
 * the legacy IDB is intentionally KEPT for at least one release as a
 * rollback escape hatch. This one-shot command performs the deletion
 * ONLY on explicit user invocation and refuses unless the sentinel is
 * present in the OPFS-backed VFS.
 *
 * If the shell's VFS isn't OPFS-backed (test or unusual host), the
 * command is inert and prints a no-op message — there's no migration
 * to clean up after.
 *
 * Secret-safe: only the IDB name and outcome are surfaced. No file
 * paths or contents are read.
 */

import type { Command } from 'just-bash';
import { defineCommand } from 'just-bash';
import type { VirtualFS } from '../../fs/index.js';
import {
  cleanupLegacyIdbFromVfs,
  type LegacyIdbCleanupResult,
} from '../../fs/migration/migration-cleanup.js';

export interface SliccFsCleanupCommandOptions {
  /**
   * Shared VFS used for the sentinel check. When the shell has no
   * VFS (or the VFS isn't OPFS-backed), the command is inert and
   * exits with a "OPFS migration not active" message.
   */
  fs?: VirtualFS;
  /**
   * Override of the cleanup driver — exposed only for tests so the
   * destructive `indexedDB.deleteDatabase` call can be stubbed without
   * `fake-indexeddb` plumbing.
   */
  runCleanup?: (fs: VirtualFS) => Promise<LegacyIdbCleanupResult>;
}

function helpText(): string {
  return `slicc-fs-cleanup — delete the legacy slicc-fs IndexedDB after migration

Usage:
  slicc-fs-cleanup           Delete the legacy slicc-fs IDB (requires
                             /.slicc-migrated sentinel to be present).
  slicc-fs-cleanup --help    Show this help.

After the OPFS migration writes the /.slicc-migrated sentinel, the
legacy slicc-fs IDB is kept for at least one release as a rollback
escape hatch. This command performs the deletion ONLY when invoked
and refuses if the sentinel is missing.
`;
}

const EXIT_CODES: Record<LegacyIdbCleanupResult['kind'], number> = {
  deleted: 0,
  absent: 0,
  'sentinel-missing': 1,
  blocked: 1,
  error: 1,
};

export function createSliccFsCleanupCommand(options: SliccFsCleanupCommandOptions = {}): Command {
  const run = options.runCleanup ?? cleanupLegacyIdbFromVfs;
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
    const fs = options.fs;
    if (fs?.backend !== 'opfs') {
      return {
        stdout: '',
        stderr: 'slicc-fs-cleanup: OPFS migration not active on this shell — nothing to do\n',
        exitCode: 0,
      };
    }
    const result = await run(fs);
    const exitCode = EXIT_CODES[result.kind];
    if (exitCode === 0) {
      return { stdout: `${result.message}\n`, stderr: '', exitCode };
    }
    return { stdout: '', stderr: `slicc-fs-cleanup: ${result.message}\n`, exitCode };
  });
}
