/**
 * Skills Engine Types
 *
 * Skills are SKILL.md packages discovered from the native /workspace/skills
 * directory and from compatibility roots (.agents/skills, .claude/skills).
 * They are read-only — the engine no longer ships an install/uninstall
 * machinery layered on top of a slicc-specific manifest.yaml format.
 */

/** Discovered skill info */
export interface DiscoveredSkill {
  /** Skill name (directory name) */
  name: string;
  /** Discovery source bucket */
  source: 'native' | 'agents' | 'claude';
  /** Root directory that yielded this skill */
  sourceRoot: string;
  /** Path to skill directory */
  path: string;
  /** Path to the skill instructions file when available */
  skillFilePath?: string;
  /** Human-readable description (parsed from SKILL.md frontmatter when present) */
  description: string;
  /** Lower-precedence paths that were shadowed by this skill name */
  shadowedPaths?: string[];
}
