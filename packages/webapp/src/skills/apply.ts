/**
 * Skill application logic
 */

import type { VirtualFS } from '../fs/index.js';
import type { ApplyResult, AppliedSkill, SkillManifest } from './types.js';
import { readManifest, checkDependencies, checkConflicts } from './manifest.js';
import {
  getAppliedSkills,
  recordSkillApplication,
  computeFileHash,
  initSkillsSystem,
} from './state.js';

/**
 * Validate a file path to prevent path traversal attacks.
 * Rejects absolute paths and paths containing '..' segments.
 */
function validatePath(filePath: string): { valid: boolean; error?: string } {
  // Reject absolute paths
  if (filePath.startsWith('/')) {
    return { valid: false, error: `Absolute path not allowed: ${filePath}` };
  }

  // Reject paths with .. segments
  const segments = filePath.split('/');
  if (segments.some((s) => s === '..')) {
    return { valid: false, error: `Path traversal not allowed: ${filePath}` };
  }

  // Reject paths that try to escape via encoded characters
  if (filePath.includes('%2e%2e') || filePath.includes('%2E%2E')) {
    return { valid: false, error: `Encoded path traversal not allowed: ${filePath}` };
  }

  return { valid: true };
}

/**
 * Ensure a directory exists, creating parent directories as needed.
 */
async function ensureDir(fs: VirtualFS, dirPath: string): Promise<void> {
  const parts = dirPath.split('/').filter(Boolean);
  let currentPath = '';

  for (const part of parts) {
    currentPath += '/' + part;
    try {
      await fs.mkdir(currentPath);
    } catch {
      // Directory may already exist
    }
  }
}

/**
 * Apply a skill from the skills directory.
 *
 * @param fs - Virtual filesystem
 * @param skillName - Name of the skill (directory name in skills dir)
 * @param skillsDir - Base directory for skills (default: /workspace/skills)
 */
export async function applySkill(
  fs: VirtualFS,
  skillName: string,
  skillsDir: string = '/workspace/skills'
): Promise<ApplyResult> {
  const skillDir = `${skillsDir}/${skillName}`;

  // Initialize skills system if needed
  await initSkillsSystem(fs);

  // Read manifest
  let manifest: SkillManifest;
  try {
    manifest = await readManifest(fs, skillDir);
  } catch (err) {
    return {
      success: false,
      skill: skillName,
      version: 'unknown',
      error: `Failed to read manifest: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Enforce that manifest.skill matches the directory name for consistency
  if (manifest.skill !== skillName) {
    return {
      success: false,
      skill: skillName,
      version: manifest.version,
      error: `Manifest skill name "${manifest.skill}" does not match directory name "${skillName}"`,
    };
  }

  // Get current applied skills
  const appliedSkills = await getAppliedSkills(fs);

  // Check if already installed
  if (appliedSkills.includes(manifest.skill)) {
    return {
      success: false,
      skill: manifest.skill,
      version: manifest.version,
      error: `Skill "${manifest.skill}" is already installed`,
    };
  }

  // Check dependencies
  const deps = checkDependencies(manifest, appliedSkills);
  if (!deps.ok) {
    return {
      success: false,
      skill: manifest.skill,
      version: manifest.version,
      error: `Missing dependencies: ${deps.missing.join(', ')}`,
    };
  }

  // Check conflicts
  const conflicts = checkConflicts(manifest, appliedSkills);
  if (!conflicts.ok) {
    return {
      success: false,
      skill: manifest.skill,
      version: manifest.version,
      error: `Conflicting skills: ${conflicts.conflicting.join(', ')}`,
    };
  }

  // Track file hashes for state
  const fileHashes: Record<string, string> = {};
  // Track actually added files for reliable uninstall
  const addedFiles: string[] = [];

  try {
    // Copy files from add/ directory
    if (manifest.adds && manifest.adds.length > 0) {
      for (const filePath of manifest.adds) {
        // Validate path to prevent traversal attacks
        const validation = validatePath(filePath);
        if (!validation.valid) {
          return {
            success: false,
            skill: manifest.skill,
            version: manifest.version,
            error: validation.error!,
          };
        }

        const sourcePath = `${skillDir}/add/${filePath}`;
        const targetPath = `/${filePath}`;

        try {
          // Ensure parent directory exists
          const parentDir = targetPath.substring(0, targetPath.lastIndexOf('/'));
          if (parentDir) {
            await ensureDir(fs, parentDir);
          }

          // Use copyFile for binary-safe copying
          await fs.copyFile(sourcePath, targetPath);
          addedFiles.push(filePath);

          // Compute hash from the copied file
          const content = await fs.readTextFile(targetPath);
          fileHashes[filePath] = await computeFileHash(content);
        } catch (err) {
          return {
            success: false,
            skill: manifest.skill,
            version: manifest.version,
            error: `Failed to copy ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      }
    }

    // Apply modifications from modify/ directory
    if (manifest.modifies && manifest.modifies.length > 0) {
      for (const filePath of manifest.modifies) {
        // Validate path to prevent traversal attacks
        const validation = validatePath(filePath);
        if (!validation.valid) {
          return {
            success: false,
            skill: manifest.skill,
            version: manifest.version,
            error: validation.error!,
          };
        }

        const patchPath = `${skillDir}/modify/${filePath}`;

        try {
          // Read the patch/replacement content
          const patchContent = await fs.readTextFile(patchPath);

          // For now, we do simple append-based modifications
          let existingContent = '';

          try {
            existingContent = await fs.readTextFile(`/${filePath}`);
          } catch {
            // File doesn't exist yet, that's ok
          }

          // Simple strategy: if the patch content contains a marker like
          // "// APPEND_AFTER: <marker>", we insert after that marker
          // Otherwise, we append to the end
          let newContent: string;

          if (patchContent.includes('// APPEND_AFTER:')) {
            const lines = patchContent.split('\n');
            const markerLine = lines.find((l: string) => l.includes('// APPEND_AFTER:'));
            const marker = markerLine?.split('// APPEND_AFTER:')[1]?.trim();
            const contentToAppend = lines
              .filter((l: string) => !l.includes('// APPEND_AFTER:'))
              .join('\n');

            if (marker && existingContent.includes(marker)) {
              const markerIdx = existingContent.indexOf(marker) + marker.length;
              const lineEnd = existingContent.indexOf('\n', markerIdx);

              // Handle case where marker is on the last line (no trailing newline)
              if (lineEnd === -1) {
                // Marker is on the last line with no trailing newline
                const separator = existingContent.endsWith('\n') ? '' : '\n';
                newContent = existingContent + separator + contentToAppend;
              } else {
                newContent =
                  existingContent.slice(0, lineEnd + 1) +
                  contentToAppend +
                  existingContent.slice(lineEnd + 1);
              }
            } else {
              newContent = existingContent + '\n' + contentToAppend;
            }
          } else {
            // Simple append
            newContent = existingContent ? existingContent + '\n' + patchContent : patchContent;
          }

          await fs.writeFile(`/${filePath}`, newContent);
          fileHashes[filePath] = await computeFileHash(newContent);
        } catch (err) {
          return {
            success: false,
            skill: manifest.skill,
            version: manifest.version,
            error: `Failed to modify ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      }
    }

    // Record the application with the list of added files for reliable uninstall
    const appliedSkill: AppliedSkill = {
      name: manifest.skill,
      version: manifest.version,
      applied_at: new Date().toISOString(),
      file_hashes: fileHashes,
      added_files: addedFiles,
    };

    await recordSkillApplication(fs, appliedSkill);

    return {
      success: true,
      skill: manifest.skill,
      version: manifest.version,
    };
  } catch (err) {
    return {
      success: false,
      skill: manifest.skill,
      version: manifest.version,
      error: `Unexpected error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
