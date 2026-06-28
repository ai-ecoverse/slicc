/**
 * upskill — skill install pipeline and post-install hooks.
 *
 * Extracted verbatim from `upskill-command.ts`. These helpers write skill
 * files into the VFS and notify the rest of the app (skills reload, sprinkle
 * refresh) after a successful install.
 */

import type { VirtualFS } from '../../../fs/index.js';
import { SKILLS_DIR } from './types.js';

/** After a successful install, reload skills on all active agent contexts. */
export async function reloadSkillsAfterInstall(): Promise<void> {
  try {
    // CLI mode: direct window hook (check both window and globalThis for testability)
    const global = typeof window !== 'undefined' ? window : globalThis;
    const hook = (global as unknown as Record<string, unknown>).__slicc_reloadSkills;
    if (typeof hook === 'function') {
      await (hook as () => Promise<void>)();
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
    const mgr = (globalThis as Record<string, unknown>).__slicc_sprinkleManager;
    if (mgr && typeof (mgr as Record<string, unknown>).openNewAutoOpenSprinkles === 'function') {
      await (mgr as { openNewAutoOpenSprinkles: () => Promise<void> }).openNewAutoOpenSprinkles();
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
  try {
    await fs.stat(destDir);
    if (!force) {
      return { ok: false, error: `skill "${skillName}" already exists (use --force to overwrite)` };
    }
    await fs.rm(destDir, { recursive: true });
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

      const parentDir = filePath.substring(0, filePath.lastIndexOf('/'));
      if (parentDir !== destDir) {
        await fs.mkdir(parentDir, { recursive: true });
      }

      await fs.writeFile(filePath, content);
      fileCount++;
    }
  } catch (err) {
    await fs.rm(destDir, { recursive: true }).catch(() => {});
    throw err;
  }

  if (fileCount === 0) {
    await fs.rm(destDir, { recursive: true }).catch(() => {});
    return { ok: false, error: `no files found for skill "${skillName}" in ZIP` };
  }
  return { ok: true };
}
