import type { VirtualFS } from '../../fs/index.js';
import type { RestrictedFS } from '../../fs/restricted-fs.js';
import type { WorkUnitDescriptor } from '../../work-unit/types.js';

export async function readUnitMemory(
  fs: VirtualFS | RestrictedFS,
  memoryPath: string
): Promise<string> {
  try {
    const content = await fs.readFile(memoryPath, { encoding: 'utf-8' });
    return typeof content === 'string' ? content : new TextDecoder().decode(content);
  } catch {
    return '';
  }
}

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
    } catch {}
  }

  return { scoopMemory, globalMemory };
}
