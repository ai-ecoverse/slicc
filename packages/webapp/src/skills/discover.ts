/**
 * Skill discovery — finds available skills in the filesystem.
 *
 * Skills are SKILL.md packages. The native dir (/workspace/skills) and
 * compatibility roots (.agents/skills, .claude/skills) are walked
 * uniformly: every directory containing a SKILL.md is a skill.
 */

import type { VirtualFS } from '../fs/index.js';
import type { DiscoveredSkill } from './types.js';
import { discoverSkillCandidates, resolveSkillNameCollisions } from './catalog.js';

/**
 * Discover all available skills from the native skills directory plus
 * recursively reachable compatibility roots.
 */
export async function discoverSkills(
  fs: VirtualFS,
  skillsDir: string = '/workspace/skills'
): Promise<DiscoveredSkill[]> {
  const candidates = await discoverSkillCandidates(fs, skillsDir);
  const discovered: DiscoveredSkill[] = [];

  for (const candidate of candidates) {
    const name = candidate.path.split('/').pop() ?? candidate.path;
    let description = '';

    if (candidate.skillFilePath) {
      try {
        const content = await fs.readTextFile(candidate.skillFilePath);
        description = extractDescription(content) ?? '';
      } catch {
        // SKILL.md unreadable — leave description empty
      }
    }

    discovered.push({
      name,
      source: candidate.source,
      sourceRoot: candidate.sourceRoot,
      path: candidate.path,
      skillFilePath: candidate.skillFilePath,
      description,
    });
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

/**
 * Extract the `description:` value from a SKILL.md frontmatter block, if any.
 * Returns null when no frontmatter or no description key is present.
 */
function extractDescription(content: string): string | null {
  const fm = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!fm) return null;
  for (const line of fm[1].split('\n')) {
    const m = line.match(/^description:\s*(.*)$/);
    if (m) return m[1].trim();
  }
  return null;
}
