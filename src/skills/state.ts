/**
 * Skills state management - tracks installed skills
 */

import type { VirtualFS } from '../fs/index.js';
import type { AppliedSkill, SkillsState } from './types.js';
import { SLICC_DIR, STATE_FILE, SKILLS_SYSTEM_VERSION } from './constants.js';

const STATE_PATH = `/${SLICC_DIR}/${STATE_FILE}`;

/**
 * Initialize the skills system directory structure.
 */
export async function initSkillsSystem(fs: VirtualFS): Promise<void> {
  // Create .slicc directory
  try {
    await fs.mkdir(`/${SLICC_DIR}`);
  } catch {
    // Directory may already exist
  }

  // Create initial state if it doesn't exist
  try {
    await fs.stat(STATE_PATH);
  } catch {
    const initialState: SkillsState = {
      version: SKILLS_SYSTEM_VERSION,
      applied_skills: [],
    };
    await fs.writeFile(STATE_PATH, JSON.stringify(initialState, null, 2));
  }
}

/**
 * Read the current skills state.
 * Only returns empty state for missing file (ENOENT).
 * Throws for other errors (e.g., corrupted JSON) to surface issues.
 */
export async function readState(fs: VirtualFS): Promise<SkillsState> {
  try {
    const content = await fs.readTextFile(STATE_PATH);
    return JSON.parse(content) as SkillsState;
  } catch (err: unknown) {
    // Return empty state only if file doesn't exist
    if (typeof err === 'object' && err !== null && (err as { code?: string }).code === 'ENOENT') {
      return {
        version: SKILLS_SYSTEM_VERSION,
        applied_skills: [],
      };
    }
    // Re-throw other errors (corrupted JSON, permission issues, etc.)
    throw err;
  }
}

/**
 * Write the skills state.
 */
export async function writeState(
  fs: VirtualFS,
  state: SkillsState,
): Promise<void> {
  await initSkillsSystem(fs);
  await fs.writeFile(STATE_PATH, JSON.stringify(state, null, 2));
}

/**
 * Get list of applied skill names.
 */
export async function getAppliedSkills(fs: VirtualFS): Promise<string[]> {
  const state = await readState(fs);
  return state.applied_skills.map((s) => s.name);
}

/**
 * Record a skill application.
 */
export async function recordSkillApplication(
  fs: VirtualFS,
  skill: AppliedSkill,
): Promise<void> {
  const state = await readState(fs);

  // Remove existing entry if present (for updates)
  state.applied_skills = state.applied_skills.filter(
    (s) => s.name !== skill.name,
  );

  // Add new entry
  state.applied_skills.push(skill);

  await writeState(fs, state);
}

/**
 * Remove a skill from state.
 */
export async function removeSkillFromState(
  fs: VirtualFS,
  skillName: string,
): Promise<void> {
  const state = await readState(fs);
  state.applied_skills = state.applied_skills.filter(
    (s) => s.name !== skillName,
  );
  await writeState(fs, state);
}

/**
 * Compute SHA-256 hash of content.
 */
export async function computeFileHash(content: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(content);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}
