/**
 * Memory files a unit's system prompt is built from.
 *
 * Owns: reading the unit's own `CLAUDE.md` and mirroring `/shared/CLAUDE.md`
 * into the VFS for units allowed to see it.
 *
 * Changes when the memory layout changes (#2271 made it per-cone). It is read
 * twice — at init and on `reloadSkills` — and having one place that knows how
 * to read a unit's memory is why that second read stopped drifting.
 */

import type { VirtualFS } from '../../fs/index.js';
import type { RestrictedFS } from '../../fs/restricted-fs.js';
import type { WorkUnitDescriptor } from '../../work-unit/types.js';

/** Read a unit's private memory file; `''` when it does not exist yet. */
export async function readUnitMemory(
  fs: VirtualFS | RestrictedFS,
  memoryPath: string
): Promise<string> {
  try {
    const content = await fs.readFile(memoryPath, { encoding: 'utf-8' });
    return typeof content === 'string' ? content : new TextDecoder().decode(content);
  } catch {
    // No memory file yet
    return '';
  }
}

/** Load scoop memory and global memory. */
export async function loadMemories(
  fs: VirtualFS | RestrictedFS,
  unit: WorkUnitDescriptor,
  getGlobalMemory: () => Promise<string>
): Promise<{ scoopMemory: string; globalMemory: string }> {
  const scoopMemory = await readUnitMemory(fs, unit.workspace.memoryPath);

  const globalMemory = await getGlobalMemory();
  if (globalMemory && unit.policy.canWriteSharedMemory) {
    try {
      const underlying =
        'getUnderlyingFS' in fs ? (fs as RestrictedFS).getUnderlyingFS() : (fs as VirtualFS);
      await underlying.writeFile('/shared/CLAUDE.md', globalMemory);
    } catch {
      // /shared may not be accessible
    }
  }

  return { scoopMemory, globalMemory };
}
