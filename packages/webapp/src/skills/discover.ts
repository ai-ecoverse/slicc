import type { VirtualFS } from '../fs/index.js';
import { discoverSkillCandidates, resolveSkillNameCollisions } from './catalog.js';
import type { DiscoveredSkill } from './types.js';

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
      } catch {}
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

export async function getSkillInfo(
  fs: VirtualFS,
  skillName: string,
  skillsDir: string = '/workspace/skills'
): Promise<DiscoveredSkill | null> {
  const skills = await discoverSkills(fs, skillsDir);
  return skills.find((s) => s.name === skillName) || null;
}

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

function extractDescription(content: string): string | null {
  const normalized = content
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .trimStart();
  const fm = normalized.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!fm) return null;
  for (const line of fm[1].split('\n')) {
    const m = line.match(/^description:\s*(.*)$/);
    if (m) return m[1].trim();
  }
  return null;
}
