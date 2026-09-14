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

  tmpDir: string
): Promise<void> {
  if (!fs) return;

  const dirs =
    unit.policy.filesystem.kind === 'full-workspace'
      ? [unit.workspace.root, '/shared', '/scoops', '/home', '/home/user', TMP_ROOT, tmpDir, '/mnt']
      : [
          `/scoops/${scoop.folder}`,
          `/scoops/${scoop.folder}/workspace`,
          `/scoops/${scoop.folder}/home`,
          `/scoops/${scoop.folder}/tmp`,
          '/shared',

          TMP_ROOT,
          tmpDir,
        ];

  for (const dir of dirs) {
    try {
      await fs.mkdir(dir, { recursive: true });
    } catch {}
  }

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
      } else if (!(await directoryExists(fs, unit.workspace.root))) {
        throw new Error(
          `workspace filesystem unavailable: ${unit.workspace.root} is missing and could not be created` +
            ` (${code ?? 'unknown error'}) — reload the session`,
          { cause: err }
        );
      } else {
        throw err;
      }
    }
  }
}

async function directoryExists(fs: VirtualFS | RestrictedFS, path: string): Promise<boolean> {
  try {
    return await fs.exists(path);
  } catch {
    return false;
  }
}
