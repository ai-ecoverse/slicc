/**
 * Skill uninstallation logic
 */

import type { VirtualFS } from '../fs/index.js';
import type { UninstallResult, SkillManifest } from './types.js';
import { readManifest } from './manifest.js';
import { readState, removeSkillFromState } from './state.js';

/**
 * Validate a file path to prevent path traversal attacks.
 * Rejects absolute paths and paths containing '..' segments.
 */
function validatePath(filePath: string): boolean {
  // Reject absolute paths
  if (filePath.startsWith('/')) {
    return false;
  }
  
  // Reject paths with .. segments
  const segments = filePath.split('/');
  if (segments.some(s => s === '..')) {
    return false;
  }
  
  return true;
}

/**
 * Uninstall a skill by removing its added files.
 * Note: Modifications are NOT automatically reverted - that would require
 * storing the original content or using a diff-based approach.
 */
export async function uninstallSkill(
  fs: VirtualFS,
  skillName: string,
  skillsDir: string = '/workspace/skills',
): Promise<UninstallResult> {
  const state = await readState(fs);
  const appliedSkill = state.applied_skills.find((s) => s.name === skillName);

  if (!appliedSkill) {
    return {
      success: false,
      skill: skillName,
      error: `Skill "${skillName}" is not installed`,
    };
  }

  // Check if other skills depend on this one
  const skillDir = `${skillsDir}/${skillName}`;
  let manifest: SkillManifest;

  try {
    manifest = await readManifest(fs, skillDir);
  } catch {
    // Manifest not found - proceed with basic uninstall using stored state
    manifest = {
      skill: skillName,
      version: appliedSkill.version,
      description: '',
      adds: [],
      modifies: [],
    };
  }

  // Check for dependent skills
  for (const other of state.applied_skills) {
    if (other.name === skillName) continue;

    try {
      const otherDir = `${skillsDir}/${other.name}`;
      const otherManifest = await readManifest(fs, otherDir);

      if (otherManifest.depends?.includes(skillName)) {
        return {
          success: false,
          skill: skillName,
          error: `Cannot uninstall: skill "${other.name}" depends on "${skillName}"`,
        };
      }
    } catch {
      // Skip if manifest can't be read
    }
  }

  try {
    // Use added_files from state if available (more reliable than manifest)
    // Fall back to manifest.adds for backward compatibility with older state
    const filesToRemove = appliedSkill.added_files ?? manifest.adds ?? [];
    
    // Remove added files
    for (const filePath of filesToRemove) {
      // Validate path to prevent traversal attacks
      if (!validatePath(filePath)) {
        console.warn(`Skipping invalid path during uninstall: ${filePath}`);
        continue;
      }
      
      try {
        await fs.rm(`/${filePath}`);
      } catch {
        // File may have been manually deleted
      }
    }

    // Note: We don't revert modifications - that would require
    // storing original content or computing diffs

    // Update state
    await removeSkillFromState(fs, skillName);

    return {
      success: true,
      skill: skillName,
    };
  } catch (err) {
    return {
      success: false,
      skill: skillName,
      error: `Failed to uninstall: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
