/**
 * Skill discovery - finds available skills in the filesystem
 */

import type { VirtualFS } from '../fs/index.js';
import type { DiscoveredSkill } from './types.js';
import { MANIFEST_FILE, SKILL_FILE } from './constants.js';
import { readManifest } from './manifest.js';
import { readState } from './state.js';

/**
 * Discover all available skills in the /workspace/skills directory.
 */
export async function discoverSkills(fs: VirtualFS, skillsDir: string = '/workspace/skills'): Promise<DiscoveredSkill[]> {
  const skillsPath = skillsDir;
  const discovered: DiscoveredSkill[] = [];

  // Get current state to check installation status
  const state = await readState(fs);
  const installedMap = new Map(
    state.applied_skills.map((s) => [s.name, s.version]),
  );

  try {
    const entries = await fs.readDir(skillsPath);

    for (const entry of entries) {
      if (entry.type !== 'directory') continue;

      const skillDir = `${skillsPath}/${entry.name}`;

      // Check if this looks like a skill (has manifest or SKILL.md)
      let hasManifest = false;
      let hasSkillMd = false;

      try {
        await fs.stat(`${skillDir}/${MANIFEST_FILE}`);
        hasManifest = true;
      } catch {
        // No manifest
      }

      try {
        await fs.stat(`${skillDir}/${SKILL_FILE}`);
        hasSkillMd = true;
      } catch {
        // No SKILL.md
      }

      if (!hasManifest && !hasSkillMd) continue;

      try {
        if (hasManifest) {
          const manifest = await readManifest(fs, skillDir);
          const installed = installedMap.has(manifest.skill);

          discovered.push({
            name: manifest.skill,
            path: skillDir,
            manifest,
            installed,
            installedVersion: installed
              ? installedMap.get(manifest.skill)
              : undefined,
          });
        } else {
          // SKILL.md only - create minimal manifest from directory name
          discovered.push({
            name: entry.name,
            path: skillDir,
            manifest: {
              skill: entry.name,
              version: '1.0.0',
              description: `Skill from ${entry.name}`,
            },
            installed: installedMap.has(entry.name),
            installedVersion: installedMap.get(entry.name),
          });
        }
      } catch (err) {
        // Skip skills with invalid manifests
        console.warn(`Skipping invalid skill at ${skillDir}:`, err);
      }
    }
  } catch {
    // Skills directory doesn't exist yet
  }

  return discovered;
}

/**
 * Get information about a specific skill.
 */
export async function getSkillInfo(
  fs: VirtualFS,
  skillName: string,
  skillsDir: string = '/workspace/skills',
): Promise<DiscoveredSkill | null> {
  const skills = await discoverSkills(fs, skillsDir);
  return skills.find((s) => s.name === skillName) || null;
}

/**
 * Read the SKILL.md content for a skill.
 */
export async function readSkillInstructions(
  fs: VirtualFS,
  skillName: string,
  skillsDir: string = '/workspace/skills',
): Promise<string | null> {
  const skillDir = `${skillsDir}/${skillName}`;

  try {
    return await fs.readTextFile(`${skillDir}/${SKILL_FILE}`);
  } catch {
    return null;
  }
}
