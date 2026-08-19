/**
 * upskill — skill install pipeline and post-install hooks.
 *
 * Extracted verbatim from `upskill-command.ts`. These helpers write skill
 * files into the VFS and notify the rest of the app (skills reload, sprinkle
 * refresh) after a successful install.
 */

import type { VirtualFS } from '../../../fs/index.js';
import { canWriteSkillFile, clearSkillDirPreservingDotfiles } from './dotfiles.js';
import type { UpskillProvenance } from './provenance.js';
import { writeProvenance } from './provenance.js';
import { SKILLS_DIR } from './types.js';

/** Provenance fields an install path supplies; `skill`/`files` are filled in here. */
export type InstallProvenance = Omit<
  UpskillProvenance,
  'version' | 'installed' | 'skill' | 'files'
>;

/**
 * The two globals the post-install hooks look for. Both are installed by
 * higher layers (the CLI boot path and the sprinkle manager) onto whichever
 * realm this code runs in, so they are read off the global object rather than
 * imported — but the shapes are known, not an untyped bag.
 */
interface InstallHookGlobals {
  __slicc_reloadSkills?: () => Promise<void>;
  __slicc_sprinkleManager?: { openNewAutoOpenSprinkles?: () => Promise<void> };
}

/** After a successful install, reload skills on all active agent contexts. */
export async function reloadSkillsAfterInstall(): Promise<void> {
  try {
    // CLI mode: direct window hook (check both window and globalThis for testability)
    const global = (typeof window !== 'undefined' ? window : globalThis) as InstallHookGlobals;
    const hook = global.__slicc_reloadSkills;
    if (typeof hook === 'function') {
      await hook();
      return;
    }
    // Extension mode: send message to offscreen document
    if (typeof chrome !== 'undefined' && chrome?.runtime?.sendMessage) {
      chrome.runtime.sendMessage({
        source: 'panel',
        payload: { type: 'reload-skills' },
      });
    }
  } catch {
    /* best-effort */
  }
}

/** After a successful install, refresh sprinkle manager and auto-open new sprinkles. */
export async function refreshSprinklesAfterInstall(): Promise<void> {
  try {
    // Read from `globalThis` so the lookup works in both the page
    // realm (real `SprinkleManager`) and the kernel-worker realm
    // (BroadcastChannel-backed proxy).
    const mgr = (globalThis as InstallHookGlobals).__slicc_sprinkleManager;
    if (typeof mgr?.openNewAutoOpenSprinkles === 'function') {
      await mgr.openNewAutoOpenSprinkles();
    }
  } catch {
    /* best-effort */
  }
}

/** Run all post-install hooks: refresh sprinkles + reload skills. */
export async function runPostInstallHooks(): Promise<void> {
  await refreshSprinklesAfterInstall();
  await reloadSkillsAfterInstall();
}

/**
 * Install a single skill from an already-downloaded and stripped ZIP archive.
 * Skips post-install hooks so batch callers can run them once at the end.
 */
export async function installSkillFromZip(
  skillPath: string,
  skillName: string,
  files: Record<string, Uint8Array>,
  fs: VirtualFS,
  force: boolean = false,
  provenance?: InstallProvenance
): Promise<{ ok: boolean; error?: string }> {
  const destDir = `${SKILLS_DIR}/${skillName}`;
  let existed = false;
  try {
    await fs.stat(destDir);
    if (!force) {
      return { ok: false, error: `skill "${skillName}" already exists (use --force to overwrite)` };
    }
    existed = true;
    // Reinstall clears the skill's own files but never its dotfiles — those
    // hold credentials (`scripts/.config`) and the `.upskill` provenance.
    await clearSkillDirPreservingDotfiles(fs, destDir);
  } catch {
    // Doesn't exist, continue
  }

  const normalizedSkillPath = skillPath.replace(/^\/|\/$/g, '');
  const prefix = normalizedSkillPath ? normalizedSkillPath + '/' : '';
  await fs.mkdir(destDir, { recursive: true });
  let fileCount = 0;
  const written: string[] = [];

  try {
    for (const [path, content] of Object.entries(files)) {
      if (!path.startsWith(prefix)) continue;
      const relativePath = path.slice(prefix.length);
      if (!relativePath || path.endsWith('/')) continue;
      // Upstream dotfiles land on first install only; an existing one is
      // left exactly as the user (or a previous install) left it.
      if (!(await canWriteSkillFile(fs, destDir, relativePath))) continue;

      const filePath = `${destDir}/${relativePath}`;

      // Zip-slip protection: reject paths that escape destDir
      const normalizedPath = filePath.replace(/\/+/g, '/');
      if (
        normalizedPath.includes('/../') ||
        normalizedPath.includes('/..') ||
        !normalizedPath.startsWith(destDir + '/')
      ) {
        continue; // skip malicious entry
      }

      const parentDir = filePath.substring(0, filePath.lastIndexOf('/'));
      if (parentDir !== destDir) {
        await fs.mkdir(parentDir, { recursive: true });
      }

      await fs.writeFile(filePath, content);
      written.push(relativePath);
      fileCount++;
    }
  } catch (err) {
    await discardFailedInstall(fs, destDir, existed);
    throw err;
  }

  if (fileCount === 0) {
    await discardFailedInstall(fs, destDir, existed);
    return { ok: false, error: `no files found for skill "${skillName}" in ZIP` };
  }
  if (provenance) {
    await writeProvenance(fs, skillName, {
      ...provenance,
      skill: skillName,
      files: written.sort(),
    });
  }
  return { ok: true };
}

/**
 * Roll back a failed install. A directory that existed before the install is
 * only emptied of non-dotfiles — deleting it outright would take the user's
 * credentials and provenance with it.
 */
export async function discardFailedInstall(
  fs: VirtualFS,
  destDir: string,
  existed: boolean
): Promise<void> {
  if (existed) {
    await clearSkillDirPreservingDotfiles(fs, destDir).catch(() => false);
    return;
  }
  await fs.rm(destDir, { recursive: true }).catch(() => {});
}
