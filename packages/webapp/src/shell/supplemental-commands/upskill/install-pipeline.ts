/**
 * upskill — skill install pipeline and post-install hooks.
 *
 * Extracted verbatim from `upskill-command.ts`. These helpers write skill
 * files into the VFS and notify the rest of the app (skills reload, sprinkle
 * refresh) after a successful install.
 */

import type { VirtualFS } from '../../../fs/index.js';
import { pruneSkillDirPreservingDotfiles, writeSkillFileGuarded } from './provenance.js';
import { SKILLS_DIR } from './types.js';

/**
 * The two globals the post-install hooks reach for. Both are installed by the
 * page realm (or, in the kernel worker, a BroadcastChannel-backed proxy), so
 * they are optional and must be feature-detected rather than assumed.
 */
interface InstallHookGlobals {
  __slicc_reloadSkills?: () => Promise<void> | void;
  __slicc_sprinkleManager?: { openNewAutoOpenSprinkles?: () => Promise<void> | void };
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
  force: boolean = false
): Promise<{ ok: boolean; error?: string }> {
  const destDir = `${SKILLS_DIR}/${skillName}`;
  let replacing = false;
  try {
    await fs.stat(destDir);
    if (!force) {
      return { ok: false, error: `skill "${skillName}" already exists (use --force to overwrite)` };
    }
    // `--force` used to `rm -rf` the whole directory, which deleted the
    // dotfiles a skill keeps its credentials (`scripts/.config`) and its
    // provenance (`.upskill`) in. Prune only the non-dot content instead.
    await pruneSkillDirPreservingDotfiles(fs, destDir);
    replacing = true;
  } catch {
    // Doesn't exist, continue
  }

  const normalizedSkillPath = skillPath.replace(/^\/|\/$/g, '');
  const prefix = normalizedSkillPath ? normalizedSkillPath + '/' : '';
  await fs.mkdir(destDir, { recursive: true });
  let fileCount = 0;

  try {
    for (const [path, content] of Object.entries(files)) {
      if (!path.startsWith(prefix)) continue;
      const relativePath = path.slice(prefix.length);
      if (!relativePath || path.endsWith('/')) continue;

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

      await writeSkillFileGuarded(fs, destDir, relativePath, content);
      fileCount++;
    }
  } catch (err) {
    await cleanupFailedInstall(fs, destDir, replacing);
    throw err;
  }

  if (fileCount === 0) {
    await cleanupFailedInstall(fs, destDir, replacing);
    return { ok: false, error: `no files found for skill "${skillName}" in ZIP` };
  }
  return { ok: true };
}

/**
 * Undo a failed install. A brand-new skill directory is removed outright; a
 * directory that already existed keeps its dotfiles, because a failed refresh
 * must not be more destructive than a successful one.
 */
async function cleanupFailedInstall(
  fs: VirtualFS,
  destDir: string,
  replacing: boolean
): Promise<void> {
  if (replacing) {
    await pruneSkillDirPreservingDotfiles(fs, destDir).catch(() => {});
    return;
  }
  await fs.rm(destDir, { recursive: true }).catch(() => {});
}
