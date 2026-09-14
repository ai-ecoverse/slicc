import type { VirtualFS } from '../../../fs/index.js';
import { canWriteSkillFile, clearSkillDirPreservingDotfiles } from './dotfiles.js';
import type { UpskillProvenance } from './provenance.js';
import { readProvenance, writeProvenance } from './provenance.js';
import { isSafeSkillRelativePath } from './skill-paths.js';
import { SKILLS_DIR } from './types.js';

export type InstallProvenance = Omit<
  UpskillProvenance,
  'version' | 'installed' | 'skill' | 'files'
>;

interface InstallHookGlobals {
  __slicc_reloadSkills?: () => Promise<void>;
  __slicc_sprinkleManager?: { openNewAutoOpenSprinkles?: () => Promise<void> };
}

export async function reloadSkillsAfterInstall(): Promise<void> {
  try {
    const global = (typeof window !== 'undefined' ? window : globalThis) as InstallHookGlobals;
    const hook = global.__slicc_reloadSkills;
    if (typeof hook === 'function') {
      await hook();
      return;
    }

    if (typeof chrome !== 'undefined' && chrome?.runtime?.sendMessage) {
      chrome.runtime.sendMessage({
        source: 'panel',
        payload: { type: 'reload-skills' },
      });
    }
  } catch {}
}

export async function refreshSprinklesAfterInstall(): Promise<void> {
  try {
    const mgr = (globalThis as InstallHookGlobals).__slicc_sprinkleManager;
    if (typeof mgr?.openNewAutoOpenSprinkles === 'function') {
      await mgr.openNewAutoOpenSprinkles();
    }
  } catch {}
}

export async function runPostInstallHooks(): Promise<void> {
  await refreshSprinklesAfterInstall();
  await reloadSkillsAfterInstall();
}

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

    await clearSkillDirPreservingDotfiles(fs, destDir, await managedFiles(fs, skillName));
  } catch {}

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

      if (!(await canWriteSkillFile(fs, destDir, relativePath))) continue;

      if (!isSafeSkillRelativePath(relativePath)) continue;
      const filePath = `${destDir}/${relativePath}`;

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

export async function managedFiles(
  fs: VirtualFS,
  skillName: string
): Promise<Set<string> | undefined> {
  const provenance = await readProvenance(fs, skillName);
  return provenance?.files?.length ? new Set(provenance.files) : undefined;
}

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
