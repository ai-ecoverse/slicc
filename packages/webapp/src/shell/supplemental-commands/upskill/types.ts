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

export interface CatalogSkillSource {
  repo: string;
  path?: string;
  skill?: string;

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

  installAll?: string;
}

export interface ScoredSkill {
  entry: CatalogSkill;
  score: number;
  matchReasons: string[];
}

export interface GitHubContent {
  name: string;
  path: string;
  type: 'file' | 'dir';
  download_url?: string;
}

export type GitHubFetchResponse = Awaited<ReturnType<SecureFetch>>;

export interface GitHubRequestContext {
  hasToken: boolean;
  request: (url: string, accept?: string) => Promise<GitHubFetchResponse>;
}

export interface TabUpskillLink {
  target: string;
  branch?: string;
  path?: string;
  instruction?: string;
  installHint: string;
}

export interface TabCatalogMatch {
  slug: string;
  hostname: string;
  task: string;
  title: string;
  description?: string;
  installed: boolean;
  installHint: string;
}

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
