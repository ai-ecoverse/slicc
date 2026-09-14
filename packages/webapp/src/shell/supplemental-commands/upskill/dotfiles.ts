import type { VirtualFS } from '../../../fs/index.js';

export function hasDotSegment(relativePath: string): boolean {
  return relativePath.split('/').some((segment) => segment.startsWith('.'));
}

export async function canWriteSkillFile(
  fs: VirtualFS,
  destDir: string,
  relativePath: string
): Promise<boolean> {
  if (!hasDotSegment(relativePath)) return true;
  return !(await fs.exists(`${destDir}/${relativePath}`));
}

export async function clearSkillDirPreservingDotfiles(
  fs: VirtualFS,
  dir: string,
  managed?: Set<string>,
  prefix = ''
): Promise<boolean> {
  let entries: Array<{ name: string; type: 'file' | 'directory' }>;
  try {
    entries = (await fs.readDir(dir)) as Array<{ name: string; type: 'file' | 'directory' }>;
  } catch {
    return false;
  }
  let kept = false;
  for (const entry of entries) {
    const path = `${dir}/${entry.name}`;
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.name.startsWith('.')) {
      kept = true;
      continue;
    }
    if (entry.type === 'directory') {
      const keptInside = await clearSkillDirPreservingDotfiles(fs, path, managed, relative);
      if (keptInside) {
        kept = true;
      } else {
        await fs.rm(path, { recursive: true });
      }
    } else if (managed && !managed.has(relative)) {
      kept = true;
    } else {
      await fs.rm(path);
    }
  }
  return kept;
}

export async function listSkillFiles(
  fs: VirtualFS,
  dir: string,
  includeDotfiles = false,
  prefix = ''
): Promise<string[]> {
  let entries: Array<{ name: string; type: 'file' | 'directory' }>;
  try {
    entries = (await fs.readDir(dir)) as Array<{ name: string; type: 'file' | 'directory' }>;
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    if (!includeDotfiles && entry.name.startsWith('.')) continue;
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.type === 'directory') {
      files.push(...(await listSkillFiles(fs, `${dir}/${entry.name}`, includeDotfiles, relative)));
    } else {
      files.push(relative);
    }
  }
  return files.sort();
}
