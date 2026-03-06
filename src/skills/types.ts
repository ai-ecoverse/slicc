/**
 * Skills Engine Types
 * 
 * Defines the structure of skills, manifests, and state tracking.
 */

/** Skill manifest - machine-readable metadata */
export interface SkillManifest {
  /** Unique skill identifier */
  skill: string;
  /** Semantic version */
  version: string;
  /** Human-readable description */
  description: string;
  /** Files to add (paths relative to project root) */
  adds?: string[];
  /** Files to modify (paths relative to project root) */
  modifies?: string[];
  /** Structured operations */
  structured?: {
    /** Environment variables to add */
    env_additions?: string[];
  };
  /** Skills that conflict with this one */
  conflicts?: string[];
  /** Skills that must be installed first */
  depends?: string[];
  /** Command to run tests after installation */
  test?: string;
  /** Author name */
  author?: string;
}

/** Record of an applied skill */
export interface AppliedSkill {
  /** Skill name */
  name: string;
  /** Installed version */
  version: string;
  /** ISO timestamp of installation */
  applied_at: string;
  /** SHA-256 hashes of added/modified files */
  file_hashes: Record<string, string>;
  /** List of files that were added (for reliable uninstall) */
  added_files?: string[];
}

/** Skills system state - persisted to .slicc/state.json */
export interface SkillsState {
  /** Skills system version */
  version: string;
  /** List of applied skills */
  applied_skills: AppliedSkill[];
}

/** Result of applying a skill */
export interface ApplyResult {
  /** Whether the operation succeeded */
  success: boolean;
  /** Skill name */
  skill: string;
  /** Skill version */
  version: string;
  /** Error message if failed */
  error?: string;
  /** Files that had merge conflicts */
  mergeConflicts?: string[];
}

/** Result of uninstalling a skill */
export interface UninstallResult {
  /** Whether the operation succeeded */
  success: boolean;
  /** Skill name */
  skill: string;
  /** Error message if failed */
  error?: string;
}

/** Discovered skill info */
export interface DiscoveredSkill {
  /** Skill name (directory name) */
  name: string;
  /** Path to skill directory */
  path: string;
  /** Parsed manifest */
  manifest: SkillManifest;
  /** Whether the skill is currently installed */
  installed: boolean;
  /** Installed version (if installed) */
  installedVersion?: string;
}
