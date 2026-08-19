/**
 * upskill — dotfile protection.
 *
 * Skills keep their credentials in a dotfile inside their own directory
 * (`scripts/.config` for `bb`, `gmail`, `fastly`, …) and their install
 * provenance in `.upskill`. Before this module, `--force` reinstalled a skill
 * by `rm -r`-ing the directory, which silently revoked those credentials and
 * destroyed the provenance record that `upskill update` needs to read.
 *
 * The rule: **upskill never modifies or deletes a dotfile that already exists
 * in a skill directory.** Upstream dotfiles (`.gitignore`, `.config.example`)
 * are still written on first install — "never touch" means "never touch after
 * first install", otherwise those files could never land at all.
 *
 * `PROVENANCE_FILE` is the single exception: it is upskill's own bookkeeping,
 * not the skill's content, so `provenance.ts` writes it unconditionally.
 */

import type { VirtualFS } from '../../../fs/index.js';

/** True when any segment of a skill-relative path starts with a dot. */
export function hasDotSegment(relativePath: string): boolean {
  return relativePath.split('/').some((segment) => segment.startsWith('.'));
}

/**
 * True when a skill-relative path may be written. Dotfiles are writable only
 * when they do not exist yet (first install); an existing one is left alone.
 */
export async function canWriteSkillFile(
  fs: VirtualFS,
  destDir: string,
  relativePath: string
): Promise<boolean> {
  if (!hasDotSegment(relativePath)) return true;
  return !(await fs.exists(`${destDir}/${relativePath}`));
}

/**
 * Empty a skill directory for a reinstall, keeping every dotfile (at any
 * depth) and the directories needed to reach them. Returns true when anything
 * was preserved.
 *
 * Used instead of `fs.rm(destDir, { recursive: true })` on the `--force` and
 * `update` paths.
 */
export async function clearSkillDirPreservingDotfiles(
  fs: VirtualFS,
  dir: string
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
    if (entry.name.startsWith('.')) {
      kept = true;
      continue;
    }
    if (entry.type === 'directory') {
      const keptInside = await clearSkillDirPreservingDotfiles(fs, path);
      if (keptInside) {
        kept = true;
      } else {
        await fs.rm(path, { recursive: true });
      }
    } else {
      await fs.rm(path);
    }
  }
  return kept;
}

/**
 * List every file under a skill directory as skill-relative paths.
 * Dotfiles are included only when `includeDotfiles` is set.
 */
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
