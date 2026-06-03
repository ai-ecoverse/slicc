import type { VirtualFS } from '../../fs/virtual-fs.js';

/**
 * Read installed skill names from the VFS by reading directory entries
 * from /workspace/skills — the canonical install-managed native skills root.
 */
export async function listInstalledSkills(vfs: VirtualFS): Promise<string[]> {
  try {
    const entries = await vfs.readDir('/workspace/skills');
    return entries
      .filter((e) => e.type === 'directory')
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}
