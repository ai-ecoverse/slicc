/**
 * Skill discovery - finds available skills in the filesystem
 */

import type { VirtualFS } from '../fs/index.js';
import type { DiscoveredSkill } from './types.js';
import { discoverSkillCandidates, resolveSkillNameCollisions } from './catalog.js';
import { readManifest } from './manifest.js';
import { readState } from './state.js';

/**
 * Discover all available skills from the native skills directory plus
 * recursively reachable compatibility roots.
 */
export async function discoverSkills(
  fs: VirtualFS,
  skillsDir: string = '/workspace/skills'
): Promise<DiscoveredSkill[]> {
  // Get current state to check installation status
  const state = await readState(fs);
  const installedMap = new Map(state.applied_skills.map((s) => [s.name, s.version]));
  const discovered: DiscoveredSkill[] = [];
  const candidates = await discoverSkillCandidates(fs, skillsDir);

  for (const candidate of candidates) {
    try {
      if (candidate.hasManifest) {
        const manifest = await readManifest(fs, candidate.path);
        const installed = installedMap.has(manifest.skill);

        discovered.push({
          name: manifest.skill,
          source: candidate.source,
          sourceRoot: candidate.sourceRoot,
          path: candidate.path,
          skillFilePath: candidate.skillFilePath,
          manifest,
          installed,
          installedVersion: installed ? installedMap.get(manifest.skill) : undefined,
        });
        continue;
      }

      const name = candidate.path.split('/').pop() ?? candidate.path;
      discovered.push({
        name,
        source: candidate.source,
        sourceRoot: candidate.sourceRoot,
        path: candidate.path,
        skillFilePath: candidate.skillFilePath,
        manifest: {
          skill: name,
          version: '1.0.0',
          description: `Skill from ${name}`,
        },
        installed: installedMap.has(name),
        installedVersion: installedMap.get(name),
      });
    } catch (err) {
      // Skip skills with invalid manifests
      console.warn(`Skipping invalid skill at ${candidate.path}:`, err);
    }
  }

  const { winners, collisions } = resolveSkillNameCollisions(discovered, (skill) => skill.name);
  const collisionPaths = new Map(
    collisions.map((collision) => [
      collision.winner.path,
      collision.shadowed.map((shadowed) => shadowed.path),
    ])
  );

  return winners.map((skill) => ({
    ...skill,
    shadowedPaths: collisionPaths.get(skill.path),
  }));
}

/**
 * Get information about a specific skill.
 */
export async function getSkillInfo(
  fs: VirtualFS,
  skillName: string,
  skillsDir: string = '/workspace/skills'
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
  skillsDir: string = '/workspace/skills'
): Promise<string | null> {
  const skill = await getSkillInfo(fs, skillName, skillsDir);
  if (!skill?.skillFilePath) return null;

  try {
    return await fs.readTextFile(skill.skillFilePath);
  } catch {
    return null;
  }
}
