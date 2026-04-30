/**
 * Skills Engine
 *
 * Discovers SKILL.md packages from the native /workspace/skills directory and
 * from compatibility roots (.agents/skills, .claude/skills) anywhere in the
 * VFS. Skills are read-only — installation/uninstallation logic was removed
 * along with the slicc-specific manifest.yaml format.
 *
 * Usage:
 * ```typescript
 * import { discoverSkills, getSkillInfo, readSkillInstructions } from '../skills/index.js';
 *
 * const skills = await discoverSkills(fs);
 * const skill = await getSkillInfo(fs, 'my-skill');
 * const instructions = await readSkillInstructions(fs, 'my-skill');
 * ```
 */

export { discoverSkillCandidates, resolveSkillNameCollisions } from './catalog.js';
export { discoverSkills, getSkillInfo, readSkillInstructions } from './discover.js';
export { installSkillFromDrop } from './install-from-drop.js';
export {
  SKILLS_DIR,
  SKILL_ARCHIVE_EXTENSION,
  MAX_SKILL_ARCHIVE_SIZE_BYTES,
  WORKSPACE_SKILLS_PATH,
  SKILL_FILE,
} from './constants.js';
export type { DiscoveredSkill } from './types.js';
export type {
  SkillDiscoverySource,
  DiscoveredSkillCandidate,
  SkillNameCollision,
} from './catalog.js';
