/**
 * Skills Engine Constants
 */

/** Skills directory name */
export const SKILLS_DIR = 'skills';

/** Drag-and-drop skill archive extension */
export const SKILL_ARCHIVE_EXTENSION = '.skill';

/** Maximum accepted drag-and-drop skill archive size (50 MB) */
export const MAX_SKILL_ARCHIVE_SIZE_BYTES = 50 * 1024 * 1024;

/** Maximum total extracted size for a dropped .skill archive (50 MB) */
export const MAX_SKILL_ARCHIVE_UNCOMPRESSED_SIZE_BYTES = 50 * 1024 * 1024;

/** Maximum number of entries allowed in a dropped .skill archive */
export const MAX_SKILL_ARCHIVE_ENTRY_COUNT = 1000;

/** Absolute workspace path for unpacked skill directories */
export const WORKSPACE_SKILLS_PATH = '/workspace/skills';

/** Skill instruction file name */
export const SKILL_FILE = 'SKILL.md';
