/**
 * upskill — shared types and module constants.
 *
 * Extracted verbatim from `upskill-command.ts` so the lower-coupling bands of
 * the command (catalog, help, install-pipeline) can share one canonical set of
 * interfaces without importing the monolith.
 */

import type { SecureFetch } from 'just-bash';
import { GLOBAL_FS_DB_NAME } from '../../../fs/global-db.js';

export const TESSL_API = 'https://api.tessl.io';
export const BROWSE_SH_API = 'https://browse.sh/api/skills';
export const SKILLS_DIR = '/workspace/skills';
export const GITHUB_GLOBAL_DB = GLOBAL_FS_DB_NAME;
export const GITHUB_TOKEN_PATH = '/workspace/.git/github-token';
export const GITHUB_API_ACCEPT = 'application/vnd.github.v3+json';
export const SKILL_CATALOG_BASE_URL = 'https://www.sliccy.com/skills/';
export const SKILL_CATALOG_URL = `${SKILL_CATALOG_BASE_URL}catalog.json`;

export interface TesslSkillAttributes {
  name: string;
  description: string;
  sourceUrl: string;
  path: string;
  featured: boolean;
  scores: {
    aggregate: number | null;
    quality: number | null;
    security: string | null;
    evalImprovementMultiplier: number | null;
  };
}

export interface TesslSearchResult {
  id: string;
  type: 'skill' | 'tile';
  attributes: TesslSkillAttributes;
}

export interface TesslSearchResponse {
  meta: { pagination: { total: number } };
  data: TesslSearchResult[];
}

export interface UnifiedSearchResult {
  name: string;
  displayName: string;
  summary: string;
  source: 'tessl' | 'browseSh';
  qualityScore: number | null;
  installHint: string;
  featured?: boolean;
  sourceRepo?: string;
}

// ── browse.sh types ──

export interface BrowseShSkillSummary {
  slug: string;
  hostname: string;
  task: string;
  name?: string;
  title?: string;
  description?: string;
  category?: string;
  tags?: string[];
  recommendedMethod?: string;
  verified?: boolean;
  installCount?: number;
  updated?: string;
}

export interface BrowseShDetail extends BrowseShSkillSummary {
  skillMd?: string;
  skillMdUrl?: string;
}

// ── Skill Catalog types ──

export interface CatalogSkillSource {
  repo: string;
  path?: string;
  skill?: string;
  /**
   * When true, install ALL skills found under `path` (not just the one named
   * in `skill`). Used for bundle entries — e.g. `migrate-page` is the primary
   * skill name (for display + dedup), but the migration bundle ships four
   * companion skills that should land together.
   */
  installAll?: boolean;
}

export interface CatalogSkill {
  name: string;
  displayName: string;
  description: string;
  source: CatalogSkillSource;
  affinity: {
    apps?: string[];
    tasks?: string[];
    role?: string[];
    purpose?: string[];
  };
  priority?: number;
}

export interface UserProfile {
  purpose: string;
  role: string;
  tasks: string[];
  apps: string[];
  name: string;
  /** Optional company / organization, collected by the welcome sprinkle. When
   *  set, recommendations also pull `/skills/<slug>.json` so company-specific
   *  skills can be pushed alongside the global catalog. */
  company?: string;
}

export interface RemoteCatalogRow {
  name: string;
  displayName: string;
  description: string;
  repo: string;
  path: string;
  skill: string;
  apps: string;
  tasks: string;
  role: string;
  purpose: string;
  boost: string;
  /** Sheet column — truthy values ("true", "TRUE", "1", "yes") opt the entry into bundle install. */
  installAll?: string;
}

export interface ScoredSkill {
  entry: CatalogSkill;
  score: number;
  matchReasons: string[];
}

// ── GitHub request context ──

export type GitHubFetchResponse = Awaited<ReturnType<SecureFetch>>;

export interface GitHubRequestContext {
  hasToken: boolean;
  request: (url: string, accept?: string) => Promise<GitHubFetchResponse>;
}

// ── upskill tabs types ──

/** Origin-advertised upskill link surfaced from a tab's Link header. */
export interface TabUpskillLink {
  target: string;
  branch?: string;
  path?: string;
  instruction?: string;
  installHint: string;
}

/** Browse.sh catalog match for a tab's hostname. */
export interface TabCatalogMatch {
  slug: string;
  hostname: string;
  task: string;
  title: string;
  description?: string;
  installed: boolean;
  installHint: string;
}

/** Per-tab result emitted by `upskill tabs`. */
export interface TabUpskillResult {
  targetId: string;
  title: string;
  url: string;
  hostname: string;
  active?: boolean;
  origin: TabUpskillLink[];
  catalog: TabCatalogMatch[];
  failures: Array<{ rel: string; href: string; error: string }>;
}

// ── createUpskillCommand flags ──

export interface ParsedUpskillFlags {
  selectedSkills: string[];
  subPath?: string;
  listOnly: boolean;
  installAll: boolean;
  force: boolean;
  sourceRef: string;
  branch?: string;
  earlyReturn?: { stdout: string; stderr: string; exitCode: number };
}
