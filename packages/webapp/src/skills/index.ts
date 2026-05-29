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

export type {
  DiscoveredSkillCandidate,
  SkillDiscoverySource,
  SkillNameCollision,
} from './catalog.js';
export { discoverSkillCandidates, resolveSkillNameCollisions } from './catalog.js';
export {
  MAX_SKILL_ARCHIVE_SIZE_BYTES,
  SKILL_ARCHIVE_EXTENSION,
  SKILL_FILE,
  SKILLS_DIR,
  WORKSPACE_SKILLS_PATH,
} from './constants.js';
export { discoverSkills, getSkillInfo, readSkillInstructions } from './discover.js';
export { installSkillFromDrop } from './install-from-drop.js';
export type { DiscoveredSkill } from './types.js';
