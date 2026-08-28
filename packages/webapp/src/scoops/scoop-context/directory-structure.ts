/**
 * On-disk skeleton for one work unit.
 *
 * Owns: creating the directories a unit needs before its shell or agent
 * exists, and seeding a default `CLAUDE.md` when the unit has somewhere
 * writable to put one.
 *
 * Changes when the float's directory layout changes (a new shared root, a new
 * per-scoop subdirectory) — a filesystem concern with no bearing on how turns
 * are run, and one that has to stay in lockstep with `workspaceFor`.
 */

import { createLogger } from '../../core/index.js';
import type { VirtualFS } from '../../fs/index.js';
import type { RestrictedFS } from '../../fs/restricted-fs.js';
import { TMP_ROOT } from '../../work-unit/descriptor.js';
import type { WorkUnitDescriptor } from '../../work-unit/types.js';
import type { RegisteredScoop } from '../types.js';

const log = createLogger('scoop-context');

export async function ensureDirectoryStructure(
  fs: VirtualFS | RestrictedFS | null,
  scoop: RegisteredScoop,
  unit: WorkUnitDescriptor,
  /**
   * This unit's `$TMPDIR` (`tmpDirFor`). Created eagerly: a shell that
   * publishes the variable and a `mktemp` that resolves against it both need
   * the directory to exist before the first turn, and `mkdir -p` is not
   * something an agent should have to remember (#2267).
   */
  tmpDir: string
): Promise<void> {
  if (!fs) return;

  // A cone creates its OWN workspace root — `/workspace` for the primary,
  // `/cones/<folder>/workspace` for an extra cone (#2271) — plus the
  // float-wide directories every unit shares.
  const dirs =
    unit.policy.filesystem.kind === 'full-workspace'
      ? [unit.workspace.root, '/shared', '/scoops', '/home', '/home/user', TMP_ROOT, tmpDir, '/mnt']
      : [
          `/scoops/${scoop.folder}`,
          `/scoops/${scoop.folder}/workspace`,
          `/scoops/${scoop.folder}/home`,
          `/scoops/${scoop.folder}/tmp`,
          '/shared',
          // Shared global scratch space (see `builtinScoopGrants`). Normally
          // the cone has already created it, but a scoop must not depend on
          // that ordering — and `tmpDir` nests under the OWNING cone's, which
          // may not have been created yet either. `recursive` covers both.
          TMP_ROOT,
          tmpDir,
        ];

  for (const dir of dirs) {
    try {
      await fs.mkdir(dir, { recursive: true });
    } catch {
      // Directory may already exist
    }
  }

  // Create default CLAUDE.md if missing. Best-effort: scoops with
  // pure-replace `writablePaths: []` (or no overlap with the memory
  // path) have no writable location for this file, and that's a
  // legitimate configuration — a read-only / audit-style scoop
  // simply runs without a persisted memory file. Swallowing the
  // EACCES keeps init on the happy path for zero-write sandboxes.
  const memoryPath = unit.workspace.memoryPath;
  try {
    await fs.readFile(memoryPath);
  } catch {
    const defaultMemory = `# ${scoop.assistantLabel} Memory

${unit.display.role === 'primary' ? 'Role: Cone (main orchestrator)' : `Scoop: ${scoop.name}`}
Folder: ${scoop.folder}
Created: ${new Date().toISOString()}

## Preferences
(Add preferences here)

## Context
(Add important context here)
`;
    try {
      await fs.writeFile(memoryPath, defaultMemory);
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (code === 'EACCES') {
        log.debug('Skipping default memory write (sandbox is read-only)', {
          folder: scoop.folder,
          path: memoryPath,
        });
      } else {
        throw err;
      }
    }
  }
}
