/**
 * Skills Engine
 * 
 * A system for discovering, installing, and managing skills that extend
 * the agent's capabilities. Native install-managed skills live under
 * /workspace/skills/. Discoverable compatibility skills can also come from
 * accessible .agents/skills and .claude/skills directories anywhere in the
 * VFS, but those compatibility roots remain read-only unless copied into the
 * native skills directory.
 * 
 * Usage:
 * ```typescript
 * import { discoverSkills, applySkill, uninstallSkill } from '../skills/index.js';
 * 
 * // Find available skills
 * const skills = await discoverSkills(fs);
 * 
 * // Install a skill
 * const result = await applySkill(fs, 'my-skill');
 * 
 * // Uninstall a skill
 * await uninstallSkill(fs, 'my-skill');
 * ```
 */

export { applySkill } from './apply.js';
export { discoverSkillCandidates, resolveSkillNameCollisions } from './catalog.js';
export { discoverSkills, getSkillInfo, readSkillInstructions } from './discover.js';
export { installSkillFromDrop } from './install-from-drop.js';
export { uninstallSkill } from './uninstall.js';
export {
  initSkillsSystem,
  readState,
  getAppliedSkills,
} from './state.js';
export {
  readManifest,
  parseManifestContent,
  checkDependencies,
  checkConflicts,
} from './manifest.js';
export {
  SLICC_DIR,
  STATE_FILE,
  SKILLS_DIR,
  MANIFEST_FILE,
  SKILL_ARCHIVE_EXTENSION,
  MAX_SKILL_ARCHIVE_SIZE_BYTES,
  WORKSPACE_SKILLS_PATH,
  SKILL_FILE,
  SKILLS_SYSTEM_VERSION,
} from './constants.js';
export type {
  SkillManifest,
  AppliedSkill,
  SkillsState,
  ApplyResult,
  UninstallResult,
  DiscoveredSkill,
} from './types.js';
export type {
  SkillDiscoverySource,
  DiscoveredSkillCandidate,
  SkillNameCollision,
} from './catalog.js';
