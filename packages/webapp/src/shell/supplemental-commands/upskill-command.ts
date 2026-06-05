/**
 * upskill — skill package manager for SLICC
 *
 * All direct fetch() calls in this file are intentionally shadowed by the
 * `fetch: SecureFetch` parameter passed from createProxiedFetch() in the
 * outer caller. This ensures network requests route through the fetch proxy
 * in CLI mode (forbidden-header bridging) and direct fetch in extension mode
 * (CORS bypass via host_permissions).
 */

import { unzipSync } from 'fflate';
import type { Command, CommandContext, SecureFetch } from 'just-bash';
import { defineCommand } from 'just-bash';
import type { BrowserAPI, PageInfo } from '../../cdp/index.js';
import { GLOBAL_FS_DB_NAME } from '../../fs/global-db.js';
import type { VirtualFS } from '../../fs/index.js';
import { VirtualFS as SharedVirtualFS } from '../../fs/index.js';
import {
  extractHandoff,
  isSafeUpskillBranch,
  isSafeUpskillPath,
  UPSKILL_REL,
} from '../../net/handoff-link.js';
import { parseLinkHeader } from '../../net/link-header.js';
import type { DiscoveredSkill } from '../../skills/types.js';
import { consumeCachedBinaryByUrl } from '../binary-cache.js';
import { decodeFetchBody, getFetchBodyBytes, parseFetchJson } from '../fetch-body.js';

const TESSL_API = 'https://api.tessl.io';
const BROWSE_SH_API = 'https://browse.sh/api/skills';
const SKILLS_DIR = '/workspace/skills';
const GITHUB_GLOBAL_DB = GLOBAL_FS_DB_NAME;
const GITHUB_TOKEN_PATH = '/workspace/.git/github-token';
const GITHUB_API_ACCEPT = 'application/vnd.github.v3+json';
const SKILL_CATALOG_BASE_URL = 'https://www.sliccy.com/skills/';
const SKILL_CATALOG_URL = `${SKILL_CATALOG_BASE_URL}catalog.json`;

interface TesslSkillAttributes {
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

interface TesslSearchResult {
  id: string;
  type: 'skill' | 'tile';
  attributes: TesslSkillAttributes;
}

interface TesslSearchResponse {
  meta: { pagination: { total: number } };
  data: TesslSearchResult[];
}

interface UnifiedSearchResult {
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

interface BrowseShDetail extends BrowseShSkillSummary {
  skillMd?: string;
  skillMdUrl?: string;
}

// ── Skill Catalog types ──

interface CatalogSkillSource {
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

interface CatalogSkill {
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

interface UserProfile {
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

interface RemoteCatalogRow {
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

interface ScoredSkill {
  entry: CatalogSkill;
  score: number;
  matchReasons: string[];
}

function splitField(value: string): string[] | undefined {
  if (!value?.trim()) return undefined;
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseInstallAll(raw: string | undefined): boolean {
  if (!raw) return false;
  const normalized = raw.trim().toLowerCase();
  return normalized === 'true' || normalized === '1' || normalized === 'yes';
}

function parseRemoteCatalog(data: RemoteCatalogRow[]): CatalogSkill[] {
  return data.map((row) => {
    const boost = row.boost ? parseFloat(row.boost) : NaN;
    const priority = Number.isFinite(boost) ? boost : undefined;

    return {
      name: row.name,
      displayName: row.displayName || row.name,
      description: row.description || '',
      source: {
        repo: row.repo,
        path: row.path || undefined,
        skill: row.skill || undefined,
        installAll: parseInstallAll(row.installAll),
      },
      affinity: {
        apps: splitField(row.apps),
        tasks: splitField(row.tasks),
        role: splitField(row.role),
        purpose: splitField(row.purpose),
      },
      priority,
    };
  });
}

const AFFINITY_WEIGHTS = { apps: 3, tasks: 2, role: 1, purpose: 1 };

export function scoreSkills(catalog: CatalogSkill[], profile: UserProfile): ScoredSkill[] {
  return catalog
    .map((entry) => {
      let score = 0;
      const reasons: string[] = [];

      const appMatches = (entry.affinity.apps ?? []).filter((a) => profile.apps.includes(a));
      if (appMatches.length) {
        score += appMatches.length * AFFINITY_WEIGHTS.apps;
        reasons.push(`apps(${appMatches.join(', ')})`);
      }

      const taskMatches = (entry.affinity.tasks ?? []).filter((t) => profile.tasks.includes(t));
      if (taskMatches.length) {
        score += taskMatches.length * AFFINITY_WEIGHTS.tasks;
        reasons.push(`tasks(${taskMatches.join(', ')})`);
      }

      if ((entry.affinity.role ?? []).includes(profile.role)) {
        score += AFFINITY_WEIGHTS.role;
        reasons.push(`role(${profile.role})`);
      }

      if ((entry.affinity.purpose ?? []).includes(profile.purpose)) {
        score += AFFINITY_WEIGHTS.purpose;
        reasons.push(`purpose(${profile.purpose})`);
      }

      score *= entry.priority ?? 1.0;

      return { entry, score, matchReasons: reasons };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);
}

function buildInstallCmd(source: CatalogSkillSource): string {
  let cmd = `upskill ${source.repo}`;
  if (source.path) cmd += ` --path ${source.path}`;
  if (source.installAll) cmd += ` --all`;
  else if (source.skill) cmd += ` --skill ${source.skill}`;
  return cmd;
}

/**
 * Lightweight check for installed skill names — avoids the expensive full-VFS
 * BFS walk that discoverSkills() performs for compatibility roots.
 * Only used by recommendations to filter already-installed skills.
 */
async function getInstalledSkillNames(fs: VirtualFS): Promise<Set<string>> {
  const names = new Set<string>();
  // 1. Native skills dir listing
  try {
    const entries = await fs.readDir(SKILLS_DIR);
    for (const e of entries) {
      if (e.type === 'directory') names.add(e.name);
    }
  } catch {
    /* dir may not exist */
  }
  // 2. Compatibility skill roots (.agents/skills/, .claude/skills/) — scan
  //    top-level VFS directories (no deep BFS) for these well-known paths.
  const COMPAT_DIRS = ['.agents', '.claude'] as const;
  try {
    const topLevel = await fs.readDir('/');
    for (const dir of topLevel) {
      if (dir.type !== 'directory') continue;
      for (const compatDir of COMPAT_DIRS) {
        try {
          const skillsRoot = `/${dir.name}/${compatDir}/skills`;
          const skillEntries = await fs.readDir(skillsRoot);
          for (const se of skillEntries) {
            if (se.type === 'directory') names.add(se.name);
          }
        } catch {
          /* no compat skills dir */
        }
      }
    }
  } catch {
    /* root listing failed */
  }
  return names;
}

interface GitHubContent {
  name: string;
  path: string;
  type: 'file' | 'dir';
  download_url?: string;
}

interface GitHubErrorBody {
  message?: string;
  documentation_url?: string;
}

type GitHubFetchResponse = Awaited<ReturnType<SecureFetch>>;

interface GitHubRequestContext {
  hasToken: boolean;
  request: (url: string, accept?: string) => Promise<GitHubFetchResponse>;
}

let cachedGlobalFsPromise: Promise<VirtualFS> | undefined;

function getGlobalFs(): Promise<VirtualFS> {
  if (!cachedGlobalFsPromise) {
    cachedGlobalFsPromise = SharedVirtualFS.create({ dbName: GITHUB_GLOBAL_DB });
  }
  return cachedGlobalFsPromise;
}

/** @internal Exported only for test cleanup. */
export function _resetGlobalFsCache(): void {
  const pending = cachedGlobalFsPromise;
  cachedGlobalFsPromise = undefined;
  if (!pending) return;
  // Fire-and-forget dispose so the cached VirtualFS releases its
  // LightningFS lock (held via navigator.locks). Without this, the
  // dangling lock request rejects with AbortError on process teardown
  // and surfaces as an unhandled rejection in tests. Errors during
  // dispose are intentionally swallowed — this path runs from test
  // teardown and hot-reload where surfacing a cleanup rejection
  // produces false failures.
  pending.then(
    (vfs) => {
      void vfs.dispose().catch(() => {});
    },
    () => {}
  );
}

async function loadConfiguredGitHubToken(): Promise<string | undefined> {
  try {
    const globalFs = await getGlobalFs();
    const token = (await globalFs.readTextFile(GITHUB_TOKEN_PATH)).trim();
    return token || undefined;
  } catch {
    return undefined;
  }
}

function buildGitHubHeaders(
  token?: string,
  accept: string = GITHUB_API_ACCEPT
): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: accept,
    'User-Agent': 'slicc-upskill',
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  return headers;
}

async function createGitHubRequestContext(fetch: SecureFetch): Promise<GitHubRequestContext> {
  const token = await loadConfiguredGitHubToken();
  return {
    hasToken: Boolean(token),
    request: (url: string, accept: string = GITHUB_API_ACCEPT) =>
      fetch(url, {
        headers: buildGitHubHeaders(token, accept),
      }),
  };
}

function getHeader(headers: Record<string, string> | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) return value;
  }
  return undefined;
}

function getGitHubErrorDetail(body: Uint8Array | string): string | undefined {
  const text = decodeFetchBody(body);
  if (!text) return undefined;
  try {
    const parsed = JSON.parse(text) as GitHubErrorBody;
    if (typeof parsed.message === 'string' && parsed.message.trim()) {
      return parsed.message.trim();
    }
  } catch {
    // Not JSON — fall back to a trimmed text preview.
  }

  const trimmed = text.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, 200);
}

function formatGitHubFailure(
  response: GitHubFetchResponse,
  resourceLabel: string,
  hasToken: boolean
): string {
  const detail = getGitHubErrorDetail(response.body);
  const detailSuffix = detail ? ` GitHub said: ${detail}` : '';
  const retryAfter = getHeader(response.headers, 'retry-after');
  const rateLimitRemaining = getHeader(response.headers, 'x-ratelimit-remaining');
  const normalizedDetail = detail?.toLowerCase() ?? '';
  const isRateLimit =
    response.status === 429 ||
    rateLimitRemaining === '0' ||
    normalizedDetail.includes('rate limit');

  if (isRateLimit) {
    if (hasToken) {
      return `GitHub rate-limited access to ${resourceLabel} (HTTP ${response.status}). The configured github.token was used, so retry later${retryAfter ? ` after about ${retryAfter} seconds` : ''}.${detailSuffix}`;
    }
    return `GitHub rate-limited anonymous access to ${resourceLabel} (HTTP ${response.status}). This often happens on shared VPNs or corporate egress IPs because unauthenticated GitHub API requests are limited per IP. Configure a token with: git config github.token <PAT>, then retry. You can also retry off VPN or later.${detailSuffix}`;
  }

  if (response.status === 401) {
    if (hasToken) {
      return `GitHub rejected the configured github.token while accessing ${resourceLabel} (HTTP 401). Update it with: git config github.token <PAT>, then retry.${detailSuffix}`;
    }
    return `GitHub requires authentication to access ${resourceLabel} (HTTP 401). Configure a token with: git config github.token <PAT>, then retry.${detailSuffix}`;
  }

  if (response.status === 404) {
    return `GitHub could not find ${resourceLabel} (HTTP 404). Check the repository, path, and permissions.${detailSuffix}`;
  }

  if (response.status === 403) {
    if (hasToken) {
      return `GitHub denied access to ${resourceLabel} (HTTP 403). Check that your github.token can access this repository or retry later if GitHub is throttling requests.${detailSuffix}`;
    }
    return `GitHub denied anonymous access to ${resourceLabel} (HTTP 403). If this repo is public on a shared VPN, you may have hit GitHub's shared IP limit; otherwise the repository or path may require authentication. Configure a token with: git config github.token <PAT>, then retry.${detailSuffix}`;
  }

  const statusDetail = response.statusText ? ` ${response.statusText}` : '';
  return `GitHub request for ${resourceLabel} failed (HTTP ${response.status}${statusDetail}).${detailSuffix}`;
}

function formatDiscoveryScope(): string {
  return 'Discovery roots: /workspace/skills plus accessible **/.agents/skills/* and **/.claude/skills/* anywhere in the VFS.\n';
}

function formatSkillSource(source: DiscoveredSkill['source']): string {
  switch (source) {
    case 'native':
      return 'native';
    case 'agents':
      return '.agents';
    case 'claude':
      return '.claude';
  }
}

function formatDiscoveredSkills(discovered: DiscoveredSkill[], heading: string): string {
  let output = `${heading}:\n\n`;
  output += '  NAME                 SOURCE    DESCRIPTION\n';
  output += '  ─────────────────────────────────────────────────────────────\n';

  for (const skill of discovered) {
    const description = skill.description || '';
    output += `  ${skill.name.padEnd(20)} ${formatSkillSource(skill.source).padEnd(9)} ${description}\n`;
  }

  output += `\n${formatDiscoveryScope()}`;
  return output;
}

function formatSkillInfo(skill: DiscoveredSkill): string {
  let output = `Skill: ${skill.name}\n`;
  output += `Description: ${skill.description || '(none)'}\n`;
  output += `Source: ${formatSkillSource(skill.source)}\n`;
  output += `Source root: ${skill.sourceRoot}\n`;

  if (skill.skillFilePath) {
    output += `Instructions: ${skill.skillFilePath}\n`;
  }

  if (skill.shadowedPaths?.length) {
    output += 'Shadowed paths:\n';
    for (const path of skill.shadowedPaths) {
      output += `  - ${path}\n`;
    }
  }

  return output;
}

function upskillHelp(): { stdout: string; stderr: string; exitCode: number } {
  return {
    stdout: `usage: upskill <command> [options]

Install skills from GitHub repositories, the Tessl registry, or browse.sh.

Commands:
  search <query>             Search registries for skills
  list                       List discoverable local skills
  tabs [--json]              Suggest skills for open browser tabs
  info <name>                Show details about a discoverable local skill
  read <name>                Read the SKILL.md instructions
  <owner/repo>               Install skill(s) from GitHub repository
  tessl:<name>               Install skill from Tessl registry
  browse:<hostname>/<task>   Install site-specific skill from browse.sh

${formatDiscoveryScope()}
GitHub Installation:
  upskill owner/repo                     List available skills in repo
  upskill owner/repo --skill name        Install specific skill
  upskill owner/repo --all               Install all skills from repo
  upskill owner/repo --path subdir       Restrict to subfolder
  upskill owner/repo@branch              Install from a specific branch
  upskill owner/repo --branch name       Same, using flag syntax

Recommendations:
  upskill recommendations                Show skills matching your profile
  upskill recommendations --install      Install all recommended skills

Registry Search:
  upskill search "pdf conversion"        Search registries
  upskill tessl:postgres-pro             Install from Tessl (via GitHub)
  upskill browse:weather.gov/get-forecast-1uezib
                                         Install from browse.sh by slug
  upskill https://browse.sh/skills/weather.gov/get-forecast-1uezib
                                         Same, using the URL form

Options:
  --skill <name>           Install specific skill (repeatable)
  --all                    Install all skills from source
  --path <subfolder>       Only discover skills under this subfolder
  --branch, -b <name>      Install from a specific branch (default: main)
  --list                   List available skills without installing
  --force                  Overwrite existing skills
  -h, --help               Show help

GitHub rate limits:
  On shared VPNs or corporate IPs, anonymous GitHub access may be rate-limited.
  Configure a token to avoid shared-IP limits: git config github.token <PAT>

Examples:
  upskill search "browser automation"
  upskill anthropics/skills --list
  upskill anthropics/skills --skill pdf --skill xlsx
  upskill adobe/skills --path skills/aem --all
  upskill aemcoder/skills@fix/stateless-tab-targeting --all
  upskill tessl:postgres-pro
  upskill browse:weather.gov/get-forecast-1uezib
`,
    stderr: '',
    exitCode: 0,
  };
}

/**
 * Extract owner/repo from a GitHub URL.
 */
function parseGitHubUrl(url: string): { owner: string; repo: string } | null {
  const match = url.match(/github\.com\/([^/?#]+)\/([^/?#]+)/);
  if (!match) return null;
  return { owner: match[1], repo: match[2].replace(/\.git$/, '') };
}

/**
 * Search Tessl registry for skills, returning unified results.
 */
async function fetchTesslResults(
  query: string,
  fetch: SecureFetch
): Promise<UnifiedSearchResult[]> {
  const url = `${TESSL_API}/experimental/search?q=${encodeURIComponent(query)}&contentType=skills&page%5Bsize%5D=20`;
  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
  });
  if (response.status !== 200) throw new Error(`Tessl returned HTTP ${response.status}`);
  const data = parseFetchJson<TesslSearchResponse>(response.body);
  if (!data.data) return [];

  // Filter to skills only (exclude tiles), deduplicate by sourceUrl
  const seen = new Map<string, UnifiedSearchResult>();
  for (const item of data.data) {
    if (item.type !== 'skill') continue;
    const a = item.attributes;
    const gh = parseGitHubUrl(a.sourceUrl);
    const repo = gh ? `${gh.owner}/${gh.repo}` : undefined;
    const score = a.scores.aggregate != null ? Math.round(a.scores.aggregate * 100) : null;
    const key = a.sourceUrl || item.id;
    const existing = seen.get(key);
    // Keep the highest-scored entry per source repo
    if (
      existing &&
      existing.qualityScore != null &&
      score != null &&
      existing.qualityScore >= score
    )
      continue;
    // Derive skill directory from path (parent of SKILL.md)
    const skillDir = a.path.replace(/\/SKILL\.md$/i, '');
    const skillId = skillDir.split('/').pop() || a.name;
    const installHint = gh
      ? `upskill ${gh.owner}/${gh.repo} --path ${skillDir.split('/').slice(0, -1).join('/') || '.'} --skill ${skillId}`
      : `upskill tessl:${a.name}`;
    seen.set(key, {
      name: a.name,
      displayName: a.name,
      summary: a.description || '',
      source: 'tessl' as const,
      qualityScore: score,
      installHint,
      featured: a.featured,
      sourceRepo: repo,
    });
  }
  return Array.from(seen.values());
}

// ── browse.sh registry ──

let cachedBrowseShCatalog: BrowseShSkillSummary[] | undefined;
let cachedBrowseShCatalogPromise: Promise<BrowseShSkillSummary[]> | undefined;

/** @internal Exported only for test cleanup. */
export function _resetBrowseShCatalogCache(): void {
  cachedBrowseShCatalog = undefined;
  cachedBrowseShCatalogPromise = undefined;
}

/**
 * Fetch the full browse.sh catalog. The list is ~200KB and CORS-open, so a
 * single fetch per shell session is fine — the result is cached in-module
 * for the lifetime of the process. Failures clear the cache so the next call
 * retries.
 */
export async function fetchBrowseShCatalog(fetch: SecureFetch): Promise<BrowseShSkillSummary[]> {
  if (cachedBrowseShCatalog) return cachedBrowseShCatalog;
  if (cachedBrowseShCatalogPromise) return cachedBrowseShCatalogPromise;
  cachedBrowseShCatalogPromise = (async () => {
    const response = await fetch(BROWSE_SH_API, { headers: { Accept: 'application/json' } });
    if (response.status !== 200) {
      throw new Error(`browse.sh returned HTTP ${response.status}`);
    }
    const data = parseFetchJson<{ skills?: BrowseShSkillSummary[] } | BrowseShSkillSummary[]>(
      response.body
    );
    const skills = Array.isArray(data) ? data : (data.skills ?? []);
    cachedBrowseShCatalog = skills;
    return skills;
  })();
  try {
    return await cachedBrowseShCatalogPromise;
  } catch (err) {
    cachedBrowseShCatalogPromise = undefined;
    throw err;
  }
}

/**
 * Search the cached browse.sh catalog and return unified results. Filters
 * client-side against `title`, `name`, `description`, `hostname`, and `tags`.
 */
async function fetchBrowseShResults(
  query: string,
  fetch: SecureFetch
): Promise<UnifiedSearchResult[]> {
  const catalog = await fetchBrowseShCatalog(fetch);
  const q = query.trim().toLowerCase();
  if (!q) return [];

  const matches = catalog.filter((s) => {
    const haystack = [
      s.title ?? '',
      s.name ?? '',
      s.description ?? '',
      s.hostname ?? '',
      ...(s.tags ?? []),
    ]
      .join(' ')
      .toLowerCase();
    return haystack.includes(q);
  });

  return matches.map((s) => ({
    name: s.slug,
    displayName: s.title || s.name || s.task || s.slug,
    summary: s.description || '',
    source: 'browseSh' as const,
    qualityScore: null,
    installHint: `upskill browse:${s.hostname}/${s.task}`,
    sourceRepo: s.hostname,
  }));
}

const BROWSE_SH_SEGMENT_RE = /^[A-Za-z0-9._-]+$/;

/**
 * Reject path-traversal-shaped segments (`.`, `..`) and empty strings. The
 * `BROWSE_SH_SEGMENT_RE` allowlist on its own accepts `.` and `..` as full
 * segments because `.` and `-` are in the character class; this helper closes
 * that gap so neither shorthand refs nor frontmatter-derived names can produce
 * `/workspace/skills/browse-./..-..` style targets.
 */
function isSafeBrowseShSegment(seg: string): boolean {
  if (!seg) return false;
  if (seg === '.' || seg === '..') return false;
  return BROWSE_SH_SEGMENT_RE.test(seg);
}

/**
 * Parse a browse.sh reference.
 *
 * Accepts:
 * - `browse:{hostname}/{task}` (shorthand)
 * - `https://browse.sh/skills/{hostname}/{task}` (URL form, trailing slash ok)
 *
 * Each segment must satisfy `[A-Za-z0-9._-]+` AND must not be `.` or `..`
 * (no path traversal, no shell metachars). Hostname is normalized to lowercase
 * with a leading `www.` stripped so refs match the install/match logic
 * elsewhere in this file. Returns null for anything else.
 */
export function parseBrowseShRef(ref: string): { hostname: string; task: string } | null {
  let hostnameTask: string | undefined;

  if (ref.startsWith('browse:')) {
    hostnameTask = ref.slice('browse:'.length);
  } else {
    const url = ref.match(/^https:\/\/browse\.sh\/skills\/([^/?#]+)\/([^/?#]+?)\/?$/);
    if (url) hostnameTask = `${url[1]}/${url[2]}`;
  }
  if (!hostnameTask) return null;

  const slash = hostnameTask.indexOf('/');
  if (slash < 0) return null;
  const rawHostname = hostnameTask.slice(0, slash);
  const task = hostnameTask.slice(slash + 1);
  if (!rawHostname || !task) return null;
  if (task.includes('/')) return null;
  if (!isSafeBrowseShSegment(rawHostname) || !isSafeBrowseShSegment(task)) return null;
  const hostname = normalizeHostname(rawHostname);
  // normalizeHostname only lowercases + strips a leading `www.`; re-verify the
  // result still satisfies the segment allowlist so a hostname like `www..`
  // (which normalizes to `.`) is still rejected.
  if (!isSafeBrowseShSegment(hostname)) return null;
  return { hostname, task };
}

/**
 * Extract a top-level scalar field from minimal YAML frontmatter. Only handles
 * plain `key: value` lines (quoted or unquoted) — arrays / block scalars are
 * not parsed. Returns undefined when missing.
 */
function extractFrontmatterField(skillMd: string, field: string): string | undefined {
  const fmMatch = skillMd.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fmMatch) return undefined;
  for (const line of fmMatch[1].split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (!m || m[1] !== field) continue;
    let value = m[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    return value || undefined;
  }
  return undefined;
}

/**
 * Build the SLICC adapter preamble inserted below the upstream frontmatter.
 * Same wording for every browse.sh skill regardless of `recommendedMethod` —
 * only the slug and `updated` date vary per skill.
 */
function buildBrowseShPreamble(detail: BrowseShDetail, slug: string): string {
  const updated = detail.updated ? ` · updated ${detail.updated}` : '';
  return [
    `> [!NOTE] **Imported from browse.sh** — original slug: \`${slug}\``,
    `>`,
    `> **SLICC adaptation:** use \`playwright-cli\` — you are running inside the user's real browser session, so the bot-detection workarounds the upstream skill assumes are usually unnecessary.`,
    `>`,
    `> Source: <https://browse.sh/skills/${slug}>${updated}`,
  ].join('\n');
}

/**
 * Insert the SLICC adapter preamble immediately below the upstream YAML
 * frontmatter. The upstream frontmatter and body MUST round-trip byte-identical
 * around the preamble — we splice `\n<preamble>\n\n` between the closing `---`
 * fence and whatever bytes followed it.
 */
function insertBrowseShPreamble(skillMd: string, preamble: string): string {
  const fmMatch = skillMd.match(/^(---\r?\n[\s\S]*?\r?\n---)(\r?\n|$)/);
  if (!fmMatch) {
    // No frontmatter — emit the preamble as the file header so downstream
    // skill loading still sees the SLICC adaptation note.
    return `${preamble}\n\n${skillMd}`;
  }
  const frontmatter = fmMatch[1];
  const afterFence = fmMatch[2] || '\n';
  const rest = skillMd.slice(fmMatch[0].length);
  return `${frontmatter}${afterFence}\n${preamble}\n\n${rest}`;
}

/**
 * Install a single browse.sh skill into `/workspace/skills/browse-{hostname}-{name}/`.
 *
 * - GETs the detail endpoint for `skillMd`/`skillMdUrl`.
 * - Prefers the Vercel Blob URL (CORS-safe) for the raw markdown body; falls
 *   back to the inline `skillMd` field if the blob fetch fails or is absent.
 * - Honors `force` for collision overwrites.
 * - Writes a single `SKILL.md` with the SLICC adapter preamble inserted below
 *   the upstream YAML frontmatter.
 */
async function installFromBrowseSh(
  hostname: string,
  task: string,
  fs: VirtualFS,
  fetch: SecureFetch,
  force: boolean = false
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const slug = `${hostname}/${task}`;
  const detailUrl = `${BROWSE_SH_API}/${hostname}/${task}`;

  let detail: BrowseShDetail;
  try {
    const response = await fetch(detailUrl, { headers: { Accept: 'application/json' } });
    if (response.status === 404) {
      return {
        stdout: '',
        stderr: `upskill: browse.sh skill "${slug}" not found\n`,
        exitCode: 1,
      };
    }
    if (response.status !== 200) {
      return {
        stdout: '',
        stderr: `upskill: browse.sh returned HTTP ${response.status} for "${slug}"\n`,
        exitCode: 1,
      };
    }
    detail = parseFetchJson<BrowseShDetail>(response.body);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      stdout: '',
      stderr: `upskill: failed to fetch browse.sh skill "${slug}": ${msg}\n`,
      exitCode: 1,
    };
  }

  let skillMd: string | undefined;
  if (detail.skillMdUrl) {
    try {
      const blobResponse = await fetch(detail.skillMdUrl, { headers: { Accept: 'text/plain' } });
      if (blobResponse.status === 200) {
        skillMd = decodeFetchBody(blobResponse.body);
      }
    } catch {
      // fall through to inline
    }
  }
  if (!skillMd && detail.skillMd) {
    skillMd = detail.skillMd;
  }
  if (!skillMd) {
    return {
      stdout: '',
      stderr: `upskill: browse.sh skill "${slug}" has no SKILL.md content\n`,
      exitCode: 1,
    };
  }

  // Derive install dir name. Prefer `name` parsed from the upstream
  // frontmatter; fall back to `task` with a trailing `-xxxxxx` suffix
  // stripped (browse.sh appends a short hash to disambiguate variants).
  const frontmatterName = extractFrontmatterField(skillMd, 'name');
  const fallbackName = task.replace(/-[A-Za-z0-9]{4,8}$/, '');
  const skillName = frontmatterName || fallbackName || task;
  // `hostname` and `task` here came through `parseBrowseShRef`, but `skillName`
  // can be sourced from untrusted upstream frontmatter — constrain it to the
  // same safe-segment allowlist before composing the install path. Reject
  // anything that could escape `/workspace/skills/` (path separators, `.` /
  // `..` segments, NUL, shell metachars).
  if (!isSafeBrowseShSegment(skillName) || skillName.length > 64) {
    return {
      stdout: '',
      stderr: `upskill: refusing to install browse.sh skill with unsafe name "${skillName}"\n`,
      exitCode: 1,
    };
  }
  // Defense in depth: re-validate the hostname segment too. parseBrowseShRef
  // already guarantees this, but install paths are sensitive enough that we
  // shouldn't trust the call site.
  if (!isSafeBrowseShSegment(hostname)) {
    return {
      stdout: '',
      stderr: `upskill: refusing to install browse.sh skill with unsafe hostname "${hostname}"\n`,
      exitCode: 1,
    };
  }
  const dirName = `browse-${hostname}-${skillName}`;
  const destDir = `${SKILLS_DIR}/${dirName}`;

  try {
    await fs.stat(destDir);
    if (!force) {
      return {
        stdout: '',
        stderr: `upskill: skill "${dirName}" already exists (use --force to overwrite)\n`,
        exitCode: 1,
      };
    }
    await fs.rm(destDir, { recursive: true });
  } catch {
    // doesn't exist, continue
  }

  const preamble = buildBrowseShPreamble(detail, slug);
  const fileContent = insertBrowseShPreamble(skillMd, preamble);

  await fs.mkdir(destDir, { recursive: true });
  await fs.writeFile(`${destDir}/SKILL.md`, fileContent);

  await runPostInstallHooks();

  return {
    stdout: `Installed skill "${dirName}" from browse.sh (${slug})\n`,
    stderr: '',
    exitCode: 0,
  };
}

/**
 * Search registries for skills, merge and paginate results.
 *
 * Structured as a list of registry fetchers so additional backends (e.g.
 * browse.sh) can plug in alongside Tessl without restructuring the merge,
 * pagination, or error-handling logic below.
 */
const SEARCH_PAGE_SIZE = 10;

interface RegistrySource {
  label: string;
  fetch: (query: string, fetch: SecureFetch) => Promise<UnifiedSearchResult[]>;
}

const REGISTRY_SOURCES: RegistrySource[] = [
  { label: 'Tessl', fetch: fetchTesslResults },
  { label: 'browse.sh', fetch: fetchBrowseShResults },
];

/**
 * Round-robin interleave per-source result lists, preserving within-source
 * order. Take the first hit from each source in order, then the second from
 * each, etc., skipping any source that has been exhausted. This gives each
 * registry visibility in the top page of results rather than burying browse.sh
 * behind Tessl (or vice versa).
 */
function interleaveResults(perSource: UnifiedSearchResult[][]): UnifiedSearchResult[] {
  const merged: UnifiedSearchResult[] = [];
  const maxLen = perSource.reduce((m, list) => Math.max(m, list.length), 0);
  for (let i = 0; i < maxLen; i++) {
    for (const list of perSource) {
      if (i < list.length) merged.push(list[i]);
    }
  }
  return merged;
}

async function searchRegistries(
  query: string,
  fetch: SecureFetch,
  page: number = 1
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const settled = await Promise.allSettled(REGISTRY_SOURCES.map((src) => src.fetch(query, fetch)));

  const perSource = settled.map((s) => (s.status === 'fulfilled' ? s.value : []));
  const allFailed = settled.every((s) => s.status === 'rejected');
  const merged: UnifiedSearchResult[] = interleaveResults(perSource);

  if (merged.length === 0) {
    const stderr = allFailed ? 'upskill: registries failed to respond\n' : '';
    return {
      stdout: `No skills found for "${query}"\n\nTry a different search term or browse the registries at https://tessl.io/registry or https://browse.sh\n`,
      stderr,
      exitCode: stderr ? 1 : 0,
    };
  }

  const totalResults = merged.length;
  const totalPages = Math.ceil(totalResults / SEARCH_PAGE_SIZE);
  const safePage = Math.max(1, Math.min(page, totalPages));
  const startIdx = (safePage - 1) * SEARCH_PAGE_SIZE;
  const pageResults = merged.slice(startIdx, startIdx + SEARCH_PAGE_SIZE);

  let output = `Search results for "${query}" (page ${safePage}/${totalPages}, ${totalResults} total):\n\n`;

  for (const skill of pageResults) {
    const scoreStr = skill.qualityScore != null ? String(skill.qualityScore).padStart(3) : '   ';
    const tag = `[${skill.source}]`;
    const repoStr = skill.sourceRepo ? `  ${skill.sourceRepo}` : '';
    output += `  ${skill.name.padEnd(30)} ${scoreStr} ${tag.padEnd(10)}${repoStr}\n`;
    if (skill.summary) {
      output += `    ${skill.summary}\n`;
    }
    output += '\n';
  }

  if (safePage < totalPages) {
    output += `Showing ${startIdx + 1}-${startIdx + pageResults.length} of ${totalResults}. `;
    output += `Next page: upskill search ${query} --page ${safePage + 1}\n\n`;
  }

  output += `To install:\n`;
  output += `  From Tessl:    upskill <owner/repo> --skill <name>\n`;
  output += `  From browse.sh: upskill browse:<hostname>/<task>\n`;

  return { stdout: output, stderr: '', exitCode: 0 };
}

/**
 * Parse Tessl reference (tessl:name) and resolve to GitHub source.
 */
async function resolveTesslRef(
  name: string,
  fetch: SecureFetch
): Promise<
  { owner: string; repo: string; skillPath: string; skillName: string } | { error: string }
> {
  const url = `${TESSL_API}/experimental/search?q=${encodeURIComponent(name)}&contentType=skills&page%5Bsize%5D=5`;
  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
  });
  if (response.status !== 200) {
    return { error: `Tessl search failed (HTTP ${response.status})` };
  }
  const data = parseFetchJson<TesslSearchResponse>(response.body);
  // Find exact name match among skills
  const match = data.data?.find((item) => item.type === 'skill' && item.attributes.name === name);
  if (!match) {
    return { error: `skill "${name}" not found on Tessl registry` };
  }
  const gh = parseGitHubUrl(match.attributes.sourceUrl);
  if (!gh) {
    return { error: `skill "${name}" has no GitHub source URL` };
  }
  // Derive skill directory path (parent of SKILL.md)
  const skillDir = match.attributes.path.replace(/\/SKILL\.md$/i, '');
  return { owner: gh.owner, repo: gh.repo, skillPath: skillDir, skillName: name };
}

type ZipResult =
  | { status: 'ok'; files: Record<string, Uint8Array> }
  | { status: 'error'; message: string };

/**
 * Download and cache a repo ZIP archive from codeload.github.com (not rate-limited).
 */
async function fetchRepoZip(
  owner: string,
  repo: string,
  fetch: SecureFetch,
  branch: string = 'main'
): Promise<ZipResult> {
  const url = `https://codeload.github.com/${owner}/${repo}/zip/refs/heads/${branch}`;
  const response = await fetch(url, {
    headers: { 'User-Agent': 'slicc-upskill' },
  });
  if (response.status === 404) {
    // Try 'master' branch as fallback
    if (branch === 'main') {
      return fetchRepoZip(owner, repo, fetch, 'master');
    }
    return { status: 'error', message: 'codeload returned HTTP 404' };
  }
  if (response.status !== 200) {
    return { status: 'error', message: `codeload returned HTTP ${response.status}` };
  }

  let zipBytes = consumeCachedBinaryByUrl(url);
  if (!zipBytes) {
    zipBytes = getFetchBodyBytes(response.body);
  }

  try {
    return { status: 'ok', files: unzipSync(zipBytes) };
  } catch (e) {
    return {
      status: 'error',
      message: `failed to unzip: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/**
 * Strip the top-level directory prefix from zip entries (e.g. "repo-main/foo" → "foo").
 */
function stripZipPrefix(files: Record<string, Uint8Array>): Record<string, Uint8Array> {
  const result: Record<string, Uint8Array> = {};
  for (const [path, content] of Object.entries(files)) {
    const slashIdx = path.indexOf('/');
    if (slashIdx < 0) continue; // top-level entry (the directory itself)
    const stripped = path.slice(slashIdx + 1);
    if (stripped) result[stripped] = content;
  }
  return result;
}

/**
 * List skills in a GitHub repository.
 * Tries the codeload ZIP first (not rate-limited), falls back to the Contents API.
 */
async function listGitHubSkills(
  owner: string,
  repo: string,
  github: GitHubRequestContext,
  subPath?: string,
  fetch?: SecureFetch,
  branch?: string
): Promise<{ skills: Array<{ name: string; path: string }>; error?: string }> {
  // Try ZIP-based discovery first (no rate limit)
  if (fetch) {
    const zip = await fetchRepoZip(owner, repo, fetch, branch);
    if (zip.status === 'ok') {
      const files = stripZipPrefix(zip.files);
      const skills: Array<{ name: string; path: string }> = [];
      const prefix = subPath ? subPath.replace(/^\/|\/$/g, '') + '/' : '';

      for (const path of Object.keys(files)) {
        if (!path.startsWith(prefix)) continue;
        const basename = path.split('/').pop() || '';
        if (basename === 'SKILL.md') {
          const skillPath = path.replace(/\/SKILL\.md$/, '');
          const skillName = skillPath.split('/').pop() || skillPath;
          skills.push({ name: skillName, path: skillPath });
        }
      }
      return { skills };
    }
    // zip.status === 'error' — fall through to API
  }

  // Fallback: Contents API (rate-limited for anonymous users)
  const skills: Array<{ name: string; path: string }> = [];

  async function scanDir(path: string): Promise<void> {
    const base = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
    const url = branch ? `${base}?ref=${encodeURIComponent(branch)}` : base;
    const response = await github.request(url);

    if (response.status !== 200) {
      throw new Error(
        formatGitHubFailure(response, `${owner}/${repo}${path ? `/${path}` : ''}`, github.hasToken)
      );
    }

    const contents = parseFetchJson<GitHubContent[]>(response.body);

    for (const item of contents) {
      if (item.type === 'file' && item.name === 'SKILL.md') {
        const skillPath = item.path.replace('/SKILL.md', '');
        const skillName = skillPath.split('/').pop() || skillPath;
        skills.push({ name: skillName, path: skillPath });
      } else if (item.type === 'dir') {
        await scanDir(item.path);
      }
    }
  }

  try {
    await scanDir(subPath || '');
    return { skills };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { skills: [], error: msg };
  }
}

/**
 * Install a skill from GitHub repository.
 * Tries ZIP-based install first (not rate-limited), falls back to the Contents API.
 */
async function installFromGitHub(
  owner: string,
  repo: string,
  skillPath: string,
  skillName: string,
  fs: VirtualFS,
  github: GitHubRequestContext,
  force: boolean = false,
  fetch?: SecureFetch,
  branch?: string
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    // Check if skill already exists
    const destDir = `${SKILLS_DIR}/${skillName}`;
    try {
      await fs.stat(destDir);
      if (!force) {
        return {
          stdout: '',
          stderr: `upskill: skill "${skillName}" already exists (use --force to overwrite)\n`,
          exitCode: 1,
        };
      }
      await fs.rm(destDir, { recursive: true });
    } catch {
      // Doesn't exist, continue
    }

    // Try ZIP-based install first (no rate limit)
    if (fetch) {
      const zip = await fetchRepoZip(owner, repo, fetch, branch);
      if (zip.status === 'ok') {
        const files = stripZipPrefix(zip.files);
        const prefix = skillPath.replace(/^\/|\/$/g, '') + '/';

        await fs.mkdir(destDir, { recursive: true });
        let fileCount = 0;

        for (const [path, content] of Object.entries(files)) {
          if (!path.startsWith(prefix)) continue;
          const relativePath = path.slice(prefix.length);
          if (!relativePath || path.endsWith('/')) continue;

          const filePath = `${destDir}/${relativePath}`;
          const parentDir = filePath.substring(0, filePath.lastIndexOf('/'));
          if (parentDir !== destDir) {
            await fs.mkdir(parentDir, { recursive: true });
          }

          await fs.writeFile(filePath, content);
          fileCount++;
        }

        if (fileCount > 0) {
          await refreshSprinklesAfterInstall();
          await reloadSkillsAfterInstall();
          return {
            stdout: `Installed skill "${skillName}" from ${owner}/${repo}\n`,
            stderr: '',
            exitCode: 0,
          };
        }
        // No files found under path — fall through to API
      }
    }

    // Fallback: Contents API
    const base = `https://api.github.com/repos/${owner}/${repo}/contents/${skillPath}`;
    const url = branch ? `${base}?ref=${encodeURIComponent(branch)}` : base;
    const response = await github.request(url);

    if (response.status !== 200) {
      return {
        stdout: '',
        stderr: `upskill: ${formatGitHubFailure(response, `${owner}/${repo}/${skillPath}`, github.hasToken)}\n`,
        exitCode: 1,
      };
    }

    const contents = parseFetchJson<GitHubContent[]>(response.body);

    await fs.mkdir(destDir, { recursive: true });

    async function downloadDir(items: GitHubContent[], destBase: string): Promise<void> {
      for (const item of items) {
        if (item.type === 'file' && item.download_url) {
          const fileResponse = await github.request(item.download_url, '*/*');
          if (fileResponse.status !== 200) {
            throw new Error(
              formatGitHubFailure(fileResponse, `${owner}/${repo}/${item.path}`, github.hasToken)
            );
          }
          const cached = consumeCachedBinaryByUrl(item.download_url);
          await fs.writeFile(`${destBase}/${item.name}`, cached ?? fileResponse.body);
        } else if (item.type === 'dir') {
          const subBase = `https://api.github.com/repos/${owner}/${repo}/contents/${item.path}`;
          const subUrl = branch ? `${subBase}?ref=${encodeURIComponent(branch)}` : subBase;
          const subResponse = await github.request(subUrl);
          if (subResponse.status !== 200) {
            throw new Error(
              formatGitHubFailure(subResponse, `${owner}/${repo}/${item.path}`, github.hasToken)
            );
          }
          const subContents = parseFetchJson<GitHubContent[]>(subResponse.body);
          await fs.mkdir(`${destBase}/${item.name}`, { recursive: true });
          await downloadDir(subContents, `${destBase}/${item.name}`);
        }
      }
    }

    try {
      await downloadDir(contents, destDir);
    } catch (downloadErr) {
      try {
        await fs.rm(destDir, { recursive: true });
      } catch {
        /* best-effort */
      }
      throw downloadErr;
    }

    await runPostInstallHooks();
    return {
      stdout: `Installed skill "${skillName}" from ${owner}/${repo}\n`,
      stderr: '',
      exitCode: 0,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      stdout: '',
      stderr: `upskill: failed to install from GitHub: ${msg}\n`,
      exitCode: 1,
    };
  }
}

/** Run all post-install hooks: refresh sprinkles + reload skills. */
async function runPostInstallHooks(): Promise<void> {
  await refreshSprinklesAfterInstall();
  await reloadSkillsAfterInstall();
}

/**
 * Install a single skill from an already-downloaded and stripped ZIP archive.
 * Skips post-install hooks so batch callers can run them once at the end.
 */
async function installSkillFromZip(
  skillPath: string,
  skillName: string,
  files: Record<string, Uint8Array>,
  fs: VirtualFS,
  force: boolean = false
): Promise<{ ok: boolean; error?: string }> {
  const destDir = `${SKILLS_DIR}/${skillName}`;
  try {
    await fs.stat(destDir);
    if (!force) {
      return { ok: false, error: `skill "${skillName}" already exists (use --force to overwrite)` };
    }
    await fs.rm(destDir, { recursive: true });
  } catch {
    // Doesn't exist, continue
  }

  const normalizedSkillPath = skillPath.replace(/^\/|\/$/g, '');
  const prefix = normalizedSkillPath ? normalizedSkillPath + '/' : '';
  await fs.mkdir(destDir, { recursive: true });
  let fileCount = 0;

  try {
    for (const [path, content] of Object.entries(files)) {
      if (!path.startsWith(prefix)) continue;
      const relativePath = path.slice(prefix.length);
      if (!relativePath || path.endsWith('/')) continue;

      const filePath = `${destDir}/${relativePath}`;

      // Zip-slip protection: reject paths that escape destDir
      const normalizedPath = filePath.replace(/\/+/g, '/');
      if (
        normalizedPath.includes('/../') ||
        normalizedPath.includes('/..') ||
        !normalizedPath.startsWith(destDir + '/')
      ) {
        continue; // skip malicious entry
      }

      const parentDir = filePath.substring(0, filePath.lastIndexOf('/'));
      if (parentDir !== destDir) {
        await fs.mkdir(parentDir, { recursive: true });
      }

      await fs.writeFile(filePath, content);
      fileCount++;
    }
  } catch (err) {
    await fs.rm(destDir, { recursive: true }).catch(() => {});
    throw err;
  }

  if (fileCount === 0) {
    await fs.rm(destDir, { recursive: true }).catch(() => {});
    return { ok: false, error: `no files found for skill "${skillName}" in ZIP` };
  }
  return { ok: true };
}

/** After a successful install, reload skills on all active agent contexts. */
async function reloadSkillsAfterInstall(): Promise<void> {
  try {
    // CLI mode: direct window hook (check both window and globalThis for testability)
    const global = typeof window !== 'undefined' ? window : globalThis;
    const hook = (global as unknown as Record<string, unknown>).__slicc_reloadSkills;
    if (typeof hook === 'function') {
      await (hook as () => Promise<void>)();
      return;
    }
    // Extension mode: send message to offscreen document
    if (typeof chrome !== 'undefined' && chrome?.runtime?.sendMessage) {
      chrome.runtime.sendMessage({
        source: 'panel',
        payload: { type: 'reload-skills' },
      });
    }
  } catch {
    /* best-effort */
  }
}

/**
 * Parse GitHub repo reference.
 *
 * Accepts either:
 * - bare `owner/repo` or `owner/repo@branch`
 * - full URL `https://github.com/owner/repo[.git][/tree/<branch>[/<subpath>]][/]`
 *
 * For URL form, `/tree/<branch>/<path>` decomposes into `branch` plus an
 * implicit `path`. The caller decides precedence with any explicit `--branch`
 * / `--path` flags.
 *
 * URL form is **https-only and host-anchored** — `http://`, hosts that merely
 * contain `github.com` as a path segment (`evil.com/github.com/...`), and
 * suffix typosquats (`github.com.evil.com`, `github.co`) are rejected.
 */
export function parseGitHubRef(
  ref: string
): { owner: string; repo: string; branch?: string; path?: string } | null {
  // URL form: https://github.com/owner/repo[.git][/tree/<branch>[/<subpath>]][/]
  // Anchored: scheme MUST be https; host MUST be exactly `github.com`.
  const url = ref.match(
    /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/tree\/([^/]+?)(?:\/(.+?))?)?\/?$/
  );
  if (url) {
    return { owner: url[1], repo: url[2], branch: url[3], path: url[4] };
  }
  // Handle owner/repo or owner/repo@branch format
  const match = ref.match(/^([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_.-]+)(?:@([a-zA-Z0-9_./-]+))?$/);
  if (match) {
    return { owner: match[1], repo: match[2], branch: match[3] };
  }
  return null;
}

/** After a successful install, refresh sprinkle manager and auto-open new sprinkles. */
async function refreshSprinklesAfterInstall(): Promise<void> {
  try {
    // Read from `globalThis` so the lookup works in both the page
    // realm (real `SprinkleManager`) and the kernel-worker realm
    // (BroadcastChannel-backed proxy).
    const mgr = (globalThis as Record<string, unknown>).__slicc_sprinkleManager;
    if (mgr && typeof (mgr as Record<string, unknown>).openNewAutoOpenSprinkles === 'function') {
      await (mgr as { openNewAutoOpenSprinkles: () => Promise<void> }).openNewAutoOpenSprinkles();
    }
  } catch {
    /* best-effort */
  }
}

/**
 * Coerce a (possibly partial / loosely-typed) profile into the shape
 * `scoreSkills` expects. `scoreSkills` calls `.includes()` on `apps`
 * and `tasks` and dereferences `role`/`purpose`/`name`, so missing
 * fields default to safe empties rather than throwing.
 */
function normalizeProfile(profile: Partial<UserProfile>): UserProfile {
  return {
    purpose: profile.purpose ?? '',
    role: profile.role ?? '',
    tasks: Array.isArray(profile.tasks) ? profile.tasks : [],
    apps: Array.isArray(profile.apps) ? profile.apps : [],
    name: profile.name ?? '',
    company: typeof profile.company === 'string' ? profile.company : undefined,
  };
}

/**
 * Slugify a company name for use as a catalog filename component, e.g.
 * `"Adobe"` → `"adobe"`, `"Acme Inc."` → `"acme-inc"`. Accepts `unknown`
 * so a corrupted/manually-edited `/home/<user>/.welcome.json` (e.g.
 * `company: 42`) can never throw — returns `null` for non-strings or
 * anything that slugs to an empty string.
 */
function slugifyCompany(company: unknown): string | null {
  if (typeof company !== 'string' || !company) return null;
  const slug = company
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-+|-+$)/g, '');
  return slug || null;
}

/**
 * Fetch the per-company skill catalog (`/skills/<slug>.json`). Returns `[]`
 * on any failure — a missing or broken company catalog must not block the
 * primary recommendation flow.
 */
async function fetchCompanyCatalog(
  fetchFn: SecureFetch,
  company: unknown
): Promise<CatalogSkill[]> {
  try {
    const slug = slugifyCompany(company);
    if (!slug) return [];
    const response = await fetchFn(`${SKILL_CATALOG_BASE_URL}${slug}.json`, {
      headers: { Accept: 'application/json' },
    });
    if (response.status !== 200) return [];
    const data = parseFetchJson<{ data: RemoteCatalogRow[] }>(response.body);
    return parseRemoteCatalog(data.data);
  } catch {
    return [];
  }
}

/**
 * Merge a base catalog with a company-specific catalog, deduping by skill
 * name. Company-specific entries take precedence so a company can override
 * affinity / priority of a globally-listed skill.
 */
function mergeCatalogs(base: CatalogSkill[], company: CatalogSkill[]): CatalogSkill[] {
  if (company.length === 0) return base;
  const companyNames = new Set(company.map((s) => s.name));
  return [...base.filter((s) => !companyNames.has(s.name)), ...company];
}

/**
 * Result of {@link installRecommendedSkills}.
 *
 * - `installedNames`: skills that successfully landed under `/workspace/skills/`.
 * - `errors`: human-readable failure lines (one per failed skill / repo).
 * - `skipped`: present when the install was a non-error no-op:
 *     - `'no-profile'`     — `/home/<name>/.welcome.json` is missing.
 *     - `'all-installed'`  — every recommended skill was already on disk.
 *     - `'catalog-fetch'`  — the catalog HTTP request failed; details in `errors`.
 *
 * The shell command (`upskill recommendations --install`) and the onboarding
 * orchestrator both consume this — the shell renders it into stdout/stderr;
 * the orchestrator just logs it and moves on.
 */
export interface InstallRecommendationsResult {
  installedNames: string[];
  errors: string[];
  skipped: 'no-profile' | 'all-installed' | 'catalog-fetch' | null;
  /** Per-skill install log, ready to print verbatim into stdout. */
  log: string;
  /** Total wall-clock seconds for the install pass. */
  elapsedSeconds: number;
}

/**
 * Install all recommended skills for the current user profile, bypassing
 * the shell. Used both by `upskill recommendations --install` and by the
 * onboarding orchestrator (which fires this in the background after the
 * welcome wizard completes).
 *
 * When called from the orchestrator, the in-memory profile is passed
 * directly via `profileOverride` to avoid racing with the parallel
 * `persistProfile` write — the install otherwise lands before the
 * `/home/<user>/.welcome.json` file exists on disk and skips with
 * `skipped: 'no-profile'`.
 *
 * Errors are collected into the result; this function does not throw.
 * Post-install hooks (`__slicc_reloadSkills`, sprinkle refresh) run iff
 * at least one skill was installed successfully.
 */
export async function installRecommendedSkills(
  fs: VirtualFS,
  fetchFn: SecureFetch,
  profileOverride?: Partial<UserProfile> | null
): Promise<InstallRecommendationsResult> {
  const startTime = Date.now();
  const empty = (
    skipped: InstallRecommendationsResult['skipped'],
    errors: string[] = []
  ): InstallRecommendationsResult => ({
    installedNames: [],
    errors,
    skipped,
    log: '',
    elapsedSeconds: (Date.now() - startTime) / 1000,
  });

  let profile: UserProfile | null = null;

  // Fast path — caller (orchestrator) supplied the freshly-collected
  // profile so we don't have to wait for the parallel persistProfile()
  // write to land on disk.
  if (profileOverride) {
    profile = normalizeProfile(profileOverride);
  } else {
    // Fallback path — read from disk (`upskill recommendations --install`
    // shell command, or any caller that doesn't have the profile in hand).
    try {
      const homeDirs = await fs.readDir('/home');
      for (const entry of homeDirs) {
        try {
          const raw = await fs.readTextFile(`/home/${entry.name}/.welcome.json`);
          profile = normalizeProfile(JSON.parse(raw) as Partial<UserProfile>);
          break;
        } catch {
          // no .welcome.json in this dir
        }
      }
    } catch {
      // /home doesn't exist
    }
  }

  if (!profile) return empty('no-profile');

  // Fetch catalog, optional company catalog, and installed names in parallel.
  // The company catalog (when profile.company is set) is best-effort — its
  // failure is silently ignored so an unrecognized company never blocks
  // recommendations from the global catalog.
  let catalogSkills: CatalogSkill[];
  let installed: Set<string>;
  try {
    const [catalogResult, companyResult, installedResult] = await Promise.all([
      (async () => {
        const response = await fetchFn(SKILL_CATALOG_URL, {
          headers: { Accept: 'application/json' },
        });
        if (response.status !== 200) {
          throw new Error(`HTTP ${response.status}`);
        }
        const data = parseFetchJson<{ data: RemoteCatalogRow[] }>(response.body);
        return parseRemoteCatalog(data.data);
      })(),
      fetchCompanyCatalog(fetchFn, profile.company),
      getInstalledSkillNames(fs),
    ]);
    catalogSkills = mergeCatalogs(catalogResult, companyResult);
    installed = installedResult;
  } catch (err) {
    return empty('catalog-fetch', [
      `upskill: failed to fetch skill catalog from ${SKILL_CATALOG_URL}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    ]);
  }

  const scored = scoreSkills(catalogSkills, profile).filter((s) => !installed.has(s.entry.name));
  if (scored.length === 0) return empty('all-installed');

  // Group scored entries by repo so each ZIP is downloaded only once
  const repoGroups = new Map<string, ScoredSkill[]>();
  for (const rec of scored) {
    const repoKey = rec.entry.source.repo;
    const group = repoGroups.get(repoKey);
    if (group) group.push(rec);
    else repoGroups.set(repoKey, [rec]);
  }

  const totalSkills = scored.length;
  let completedSkills = 0;
  let output = '';
  const errors: string[] = [];
  const installedNames: string[] = [];

  // Process repos in parallel, skills within each repo sequentially (shared ZIP)
  const repoResults = await Promise.allSettled(
    Array.from(repoGroups.entries()).map(async ([repoKey, recs]) => {
      const [owner, repo] = repoKey.split('/');
      const zip = await fetchRepoZip(owner, repo, fetchFn);
      if (zip.status === 'error') {
        // ZIP unavailable — fall back to Contents API per skill/bundle
        const github = await createGitHubRequestContext(fetchFn);
        const results: Array<{ ok: boolean; name: string; error?: string }> = [];
        for (const rec of recs) {
          const src = rec.entry.source;
          completedSkills++;
          const eta =
            completedSkills < totalSkills
              ? ` (~${Math.round(((totalSkills - completedSkills) * (Date.now() - startTime)) / completedSkills / 1000)}s remaining)`
              : '';
          if (src.installAll && src.path) {
            const listResult = await listGitHubSkills(owner, repo, github, src.path);
            if (listResult.error) {
              results.push({ ok: false, name: rec.entry.name, error: listResult.error });
              output += `[${completedSkills}/${totalSkills}] Failed "${rec.entry.name}" bundle from ${repoKey}: ${listResult.error}${eta}\n`;
              continue;
            }
            const bundleStart = Date.now();
            let bundleSuccess = 0;
            let bundleFailed = 0;
            for (const skill of listResult.skills) {
              if (installed.has(skill.name)) continue;
              const r = await installFromGitHub(
                owner,
                repo,
                skill.path,
                skill.name,
                fs,
                github,
                false
              );
              if (r.exitCode === 0) {
                results.push({ ok: true, name: skill.name });
                bundleSuccess++;
              } else {
                results.push({ ok: false, name: skill.name, error: r.stderr.trim() });
                bundleFailed++;
              }
            }
            const bundleDuration = ((Date.now() - bundleStart) / 1000).toFixed(1);
            if (bundleSuccess === 0 && bundleFailed === 0) {
              output += `[${completedSkills}/${totalSkills}] Skipped "${rec.entry.name}" bundle from ${repoKey}: all sub-skills already installed${eta}\n`;
            } else if (bundleFailed === 0) {
              output += `[${completedSkills}/${totalSkills}] Installed "${rec.entry.name}" bundle (${bundleSuccess} skill(s)) from ${repoKey} (${bundleDuration}s)${eta}\n`;
            } else {
              output += `[${completedSkills}/${totalSkills}] Installed "${rec.entry.name}" bundle (${bundleSuccess}/${bundleSuccess + bundleFailed} skill(s)) from ${repoKey} (${bundleDuration}s)${eta}\n`;
            }
            continue;
          }
          const skillPath = src.path ? src.path.replace(/^\/|\/$/g, '') : rec.entry.name;
          const skillName = src.skill || rec.entry.name;
          const r = await installFromGitHub(owner, repo, skillPath, skillName, fs, github, false);
          if (r.exitCode === 0) {
            output += `[${completedSkills}/${totalSkills}] Installed "${skillName}" from ${repoKey}${eta}\n`;
            results.push({ ok: true, name: skillName });
          } else {
            output += `[${completedSkills}/${totalSkills}] Failed "${skillName}" from ${repoKey}: ${r.stderr.trim()}${eta}\n`;
            results.push({ ok: false, name: skillName, error: r.stderr.trim() });
          }
        }
        return { errors: [], results };
      }

      const files = stripZipPrefix(zip.files);
      const results: Array<{ ok: boolean; name: string; error?: string }> = [];

      // Precompute skill index: map skillName → path for all SKILL.md entries
      const skillIndex = new Map<string, string>();
      for (const p of Object.keys(files)) {
        if (p.endsWith('/SKILL.md')) {
          const skillDir = p.replace(/\/SKILL\.md$/, '');
          const name = skillDir.split('/').pop() || skillDir;
          skillIndex.set(name, skillDir);
        }
      }

      for (const rec of recs) {
        const src = rec.entry.source;

        // Bundle install: install ALL skills under src.path. The catalog
        // entry's `name` / `skill` is the primary identifier (used for
        // dedup against an already-installed bundle), but the actual
        // install fans out across every SKILL.md found under the path.
        if (src.installAll && src.path) {
          const pathPrefix = src.path.replace(/^\/|\/$/g, '');
          const targets: Array<{ name: string; path: string }> = [];
          for (const [name, p] of skillIndex) {
            if (p === pathPrefix || p.startsWith(pathPrefix + '/')) {
              targets.push({ name, path: p });
            }
          }
          completedSkills++;
          const bundleEta =
            completedSkills < totalSkills
              ? ` (~${Math.round(((totalSkills - completedSkills) * (Date.now() - startTime)) / completedSkills / 1000)}s remaining)`
              : '';

          if (targets.length === 0) {
            const error = `no skills found under "${src.path}" in ${repoKey}`;
            results.push({ ok: false, name: rec.entry.name, error });
            output += `[${completedSkills}/${totalSkills}] Failed "${rec.entry.name}" bundle from ${repoKey}: ${error}${bundleEta}\n`;
            continue;
          }

          const bundleStart = Date.now();
          let bundleSuccess = 0;
          let bundleFailed = 0;
          for (const target of targets) {
            // Per-sub-skill dedup so a partially-installed bundle still
            // gets the missing companions filled in.
            if (installed.has(target.name)) continue;
            const subResult = await installSkillFromZip(target.path, target.name, files, fs, false);
            if (subResult.ok) {
              results.push({ ok: true, name: target.name });
              bundleSuccess++;
            } else {
              results.push({ ok: false, name: target.name, error: subResult.error });
              bundleFailed++;
            }
          }
          const bundleDuration = ((Date.now() - bundleStart) / 1000).toFixed(1);
          if (bundleSuccess === 0 && bundleFailed === 0) {
            output += `[${completedSkills}/${totalSkills}] Skipped "${rec.entry.name}" bundle from ${repoKey}: all sub-skills already installed${bundleEta}\n`;
          } else if (bundleFailed === 0) {
            output += `[${completedSkills}/${totalSkills}] Installed "${rec.entry.name}" bundle (${bundleSuccess} skill(s)) from ${repoKey} (${bundleDuration}s)${bundleEta}\n`;
          } else {
            output += `[${completedSkills}/${totalSkills}] Installed "${rec.entry.name}" bundle (${bundleSuccess}/${bundleSuccess + bundleFailed} skill(s)) from ${repoKey} (${bundleDuration}s)${bundleEta}\n`;
          }
          continue;
        }

        let skillPath: string;
        let skillName: string;

        if (src.skill) {
          const indexedPath = skillIndex.get(src.skill);
          if (indexedPath) {
            skillPath = indexedPath;
            skillName = src.skill;
          } else if (src.path) {
            skillPath = src.path.replace(/^\/|\/$/g, '');
            skillName = src.skill;
          } else {
            const error = `skill "${src.skill}" not found in ${repoKey}`;
            results.push({ ok: false, name: rec.entry.name, error });
            completedSkills++;
            const eta =
              completedSkills < totalSkills
                ? ` (~${Math.round(((totalSkills - completedSkills) * (Date.now() - startTime)) / completedSkills / 1000)}s remaining)`
                : '';
            output += `[${completedSkills}/${totalSkills}] Failed "${rec.entry.name}" from ${repoKey}: ${error}${eta}\n`;
            continue;
          }
        } else if (src.path) {
          skillPath = src.path.replace(/^\/|\/$/g, '');
          skillName = rec.entry.name;
        } else {
          const indexedPath = skillIndex.get(rec.entry.name);
          if (indexedPath) {
            skillPath = indexedPath;
            skillName = rec.entry.name;
          } else {
            const error = `skill "${rec.entry.name}" not found in ${repoKey} and no explicit path provided`;
            results.push({ ok: false, name: rec.entry.name, error });
            completedSkills++;
            const eta =
              completedSkills < totalSkills
                ? ` (~${Math.round(((totalSkills - completedSkills) * (Date.now() - startTime)) / completedSkills / 1000)}s remaining)`
                : '';
            output += `[${completedSkills}/${totalSkills}] Failed "${rec.entry.name}" from ${repoKey}: ${error}${eta}\n`;
            continue;
          }
        }

        const skillStart = Date.now();
        const result = await installSkillFromZip(skillPath, skillName, files, fs, false);
        completedSkills++;

        const skillDuration = ((Date.now() - skillStart) / 1000).toFixed(1);
        const avgTime = (Date.now() - startTime) / completedSkills;
        const remaining = Math.round(((totalSkills - completedSkills) * avgTime) / 1000);
        const eta = completedSkills < totalSkills ? ` (~${remaining}s remaining)` : '';

        if (result.ok) {
          results.push({ ok: true, name: skillName });
          output += `[${completedSkills}/${totalSkills}] Installed "${skillName}" from ${repoKey} (${skillDuration}s)${eta}\n`;
        } else {
          results.push({ ok: false, name: skillName, error: result.error });
          output += `[${completedSkills}/${totalSkills}] Failed "${skillName}" from ${repoKey}: ${result.error}${eta}\n`;
        }
      }

      return { errors: [] as string[], results };
    })
  );

  for (const settled of repoResults) {
    if (settled.status === 'rejected') {
      errors.push(`upskill: unexpected error: ${settled.reason}`);
      continue;
    }
    for (const e of settled.value.errors) errors.push(e);
    for (const r of settled.value.results) {
      if (r.ok) installedNames.push(r.name);
      else if (r.error) errors.push(`upskill: ${r.error}`);
    }
  }

  if (installedNames.length > 0) {
    await runPostInstallHooks();
  }

  const elapsedSeconds = (Date.now() - startTime) / 1000;
  if (installedNames.length > 0) {
    output += `\nInstalled ${installedNames.length} recommended skill(s) in ${elapsedSeconds.toFixed(1)}s\n`;
  }

  return {
    installedNames,
    errors,
    skipped: null,
    log: output,
    elapsedSeconds,
  };
}

// ── upskill tabs ──

/**
 * Normalize a hostname for catalog matching: lowercases and strips a single
 * leading `www.`. Exported so the browse.sh skill install dispatch can
 * reuse the exact same matching contract this subcommand surfaces to users.
 */
export function normalizeHostname(host: string): string {
  const lower = host.toLowerCase();
  return lower.startsWith('www.') ? lower.slice(4) : lower;
}

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

/**
 * Build the install-hint shell line for an origin-advertised upskill rel.
 * Mirrors the dispatch contract the cone's handoff SKILL renders, so the
 * line we print to the terminal is exactly what the user (or the cone, if
 * they pipe it) should run.
 */
function buildOriginInstallHint(target: string, branch?: string, path?: string): string {
  let cmd = `upskill ${target}`;
  if (branch) cmd += ` --branch ${branch}`;
  if (path) cmd += ` --path ${path}`;
  return cmd;
}

/**
 * Fetch a single tab's URL, parse Link headers, and surface every
 * origin-advertised `upskill` rel. Failures are returned in the result's
 * `failures` array (matches `discoverLinks`' contract) rather than thrown
 * so one bad tab doesn't sink the whole listing.
 */
async function discoverTabUpskill(
  url: string,
  fetchFn: SecureFetch
): Promise<{ links: TabUpskillLink[]; failures: TabUpskillResult['failures'] }> {
  const failures: TabUpskillResult['failures'] = [];
  let response: Awaited<ReturnType<SecureFetch>>;
  try {
    response = await fetchFn(url, { method: 'GET' });
  } catch (err) {
    failures.push({
      rel: UPSKILL_REL,
      href: url,
      error: err instanceof Error ? err.message : String(err),
    });
    return { links: [], failures };
  }

  const linkValues: string[] = [];
  for (const [name, value] of Object.entries(response.headers || {})) {
    if (name.toLowerCase() === 'link' && typeof value === 'string' && value.length > 0) {
      linkValues.push(value);
    }
  }
  if (linkValues.length === 0) return { links: [], failures };

  const parsed = parseLinkHeader(linkValues, url);
  const links: TabUpskillLink[] = [];
  // Surface every upskill rel on the page (extractHandoff returns only the
  // first match — for the tabs listing we want each one so users can choose).
  for (const link of parsed) {
    if (!link.rel.includes(UPSKILL_REL)) continue;
    const single = extractHandoff([link]);
    if (single?.verb !== 'upskill') continue;
    links.push({
      target: single.target,
      branch: single.branch,
      path: single.path,
      instruction: single.instruction,
      installHint: buildOriginInstallHint(single.target, single.branch, single.path),
    });
  }
  return { links, failures };
}

/**
 * Handle the `upskill tabs` subcommand.
 */
async function handleTabs(
  fs: VirtualFS,
  fetchFn: SecureFetch,
  browser: BrowserAPI | undefined,
  jsonMode: boolean
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  if (!browser) {
    return {
      stdout: '',
      stderr: 'upskill: browser APIs unavailable in this environment\n',
      exitCode: 1,
    };
  }

  let pages: PageInfo[];
  try {
    pages = await browser.listPages();
  } catch {
    try {
      pages = await browser.listAllTargets();
    } catch (err) {
      return {
        stdout: '',
        stderr: `upskill: failed to list browser tabs: ${err instanceof Error ? err.message : String(err)}\n`,
        exitCode: 1,
      };
    }
  }

  if (pages.length === 0) {
    if (jsonMode) {
      return { stdout: JSON.stringify({ tabs: [] }, null, 2) + '\n', stderr: '', exitCode: 0 };
    }
    return {
      stdout: 'No open browser tabs.\n',
      stderr: '',
      exitCode: 0,
    };
  }

  // Browse.sh catalog fetch — non-fatal. If it fails, we still surface
  // origin-advertised rels and log a warning to stderr.
  let catalog: BrowseShSkillSummary[] = [];
  let catalogWarning = '';
  try {
    catalog = await fetchBrowseShCatalog(fetchFn);
  } catch (err) {
    catalogWarning = `upskill: warning: browse.sh catalog unavailable: ${err instanceof Error ? err.message : String(err)}\n`;
  }

  const installed = await getInstalledSkillNames(fs);

  const results: TabUpskillResult[] = [];
  for (const page of pages) {
    let host = '';
    try {
      host = new URL(page.url).hostname;
    } catch {
      // Non-HTTP URLs (chrome://, about:, etc.) — skip discovery/catalog match.
    }
    const normalized = host ? normalizeHostname(host) : '';

    let origin: TabUpskillLink[] = [];
    let failures: TabUpskillResult['failures'] = [];
    if (host && /^https?:/i.test(page.url)) {
      const discovered = await discoverTabUpskill(page.url, fetchFn);
      origin = discovered.links;
      failures = discovered.failures;
    }

    const catalogMatches: TabCatalogMatch[] = [];
    if (normalized && catalog.length > 0) {
      for (const s of catalog) {
        if (!s.hostname) continue;
        if (normalizeHostname(s.hostname) !== normalized) continue;
        // Mirror `installFromBrowseSh`'s dirname rule: prefer the catalog's
        // `name` (parsed from upstream frontmatter at publish time) and
        // only strip the trailing `-xxxxxx` disambiguation hash when we
        // have to fall back to `task`.
        const skillName = s.name || s.task.replace(/-[A-Za-z0-9]{4,8}$/, '') || s.task;
        const dirName = `browse-${s.hostname}-${skillName}`;
        catalogMatches.push({
          slug: s.slug,
          hostname: s.hostname,
          task: s.task,
          title: s.title || s.name || s.task,
          description: s.description,
          installed: installed.has(dirName),
          installHint: `upskill browse:${s.hostname}/${s.task}`,
        });
      }
    }

    results.push({
      targetId: page.targetId,
      title: page.title,
      url: page.url,
      hostname: normalized,
      active: page.active,
      origin,
      catalog: catalogMatches,
      failures,
    });
  }

  if (jsonMode) {
    return {
      stdout: JSON.stringify({ tabs: results }, null, 2) + '\n',
      stderr: catalogWarning,
      exitCode: 0,
    };
  }

  let output = '';
  for (const tab of results) {
    const activeMark = tab.active ? ' [active]' : '';
    output += `${tab.title || '(untitled)'}${activeMark}\n`;
    output += `  ${tab.url}\n`;

    if (tab.origin.length > 0) {
      output += `  Origin-advertised:\n`;
      for (const link of tab.origin) {
        output += `    ${link.installHint}`;
        if (link.instruction) output += `   # ${link.instruction}`;
        output += '\n';
      }
    }

    if (tab.catalog.length > 0) {
      output += `  Browse.sh catalog:\n`;
      for (const match of tab.catalog) {
        const marker = match.installed ? '✓' : ' ';
        output += `    ${marker} ${match.title.padEnd(40)} ${match.installHint}\n`;
      }
    }

    if (tab.origin.length === 0 && tab.catalog.length === 0 && !tab.failures.length) {
      output += `  No skill suggestions for this tab.\n`;
    }

    if (tab.failures.length > 0) {
      for (const f of tab.failures) {
        output += `  (discovery failed: ${f.error})\n`;
      }
    }
    output += '\n';
  }

  return { stdout: output, stderr: catalogWarning, exitCode: 0 };
}

/**
 * Handle the `upskill recommendations` subcommand.
 */
async function handleRecommendations(
  fs: VirtualFS,
  fetchFn: SecureFetch,
  install: boolean
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  if (install) {
    const result = await installRecommendedSkills(fs, fetchFn);

    if (result.skipped === 'no-profile') {
      return {
        stdout: '',
        stderr:
          'upskill: no user profile found. Complete the welcome onboarding first, or create /home/<name>/.welcome.json manually.\n',
        exitCode: 1,
      };
    }
    if (result.skipped === 'catalog-fetch') {
      return {
        stdout: '',
        stderr: result.errors.map((e) => `${e}\n`).join(''),
        exitCode: 1,
      };
    }
    if (result.skipped === 'all-installed') {
      return {
        stdout: 'No new skill recommendations — all matching skills are already installed.\n',
        stderr: '',
        exitCode: 0,
      };
    }
    return {
      stdout: result.log,
      stderr: result.errors.map((e) => `${e}\n`).join(''),
      exitCode: result.errors.length > 0 ? 1 : 0,
    };
  }

  // Display-only path (no install) — keep the original recommendation listing.
  let profile: UserProfile | null = null;
  try {
    const homeDirs = await fs.readDir('/home');
    for (const entry of homeDirs) {
      try {
        const raw = await fs.readTextFile(`/home/${entry.name}/.welcome.json`);
        profile = JSON.parse(raw) as UserProfile;
        break;
      } catch {
        // no .welcome.json in this dir
      }
    }
  } catch {
    // /home doesn't exist
  }

  if (!profile) {
    return {
      stdout: '',
      stderr:
        'upskill: no user profile found. Complete the welcome onboarding first, or create /home/<name>/.welcome.json manually.\n',
      exitCode: 1,
    };
  }

  let catalogSkills: CatalogSkill[];
  let installed: Set<string>;
  try {
    const [catalogResult, companyResult, installedResult] = await Promise.all([
      (async () => {
        const response = await fetchFn(SKILL_CATALOG_URL, {
          headers: { Accept: 'application/json' },
        });
        if (response.status !== 200) {
          throw new Error(`HTTP ${response.status}`);
        }
        const data = parseFetchJson<{ data: RemoteCatalogRow[] }>(response.body);
        return parseRemoteCatalog(data.data);
      })(),
      fetchCompanyCatalog(fetchFn, profile.company),
      getInstalledSkillNames(fs),
    ]);
    catalogSkills = mergeCatalogs(catalogResult, companyResult);
    installed = installedResult;
  } catch (err) {
    return {
      stdout: '',
      stderr: `upskill: failed to fetch skill catalog from ${SKILL_CATALOG_URL}: ${err instanceof Error ? err.message : String(err)}\n`,
      exitCode: 1,
    };
  }

  const scored = scoreSkills(catalogSkills, profile).filter((s) => !installed.has(s.entry.name));

  if (scored.length === 0) {
    return {
      stdout: 'No new skill recommendations — all matching skills are already installed.\n',
      stderr: '',
      exitCode: 0,
    };
  }

  // Display recommendations
  let output = 'Recommended skills for you:\n\n';
  let idx = 0;
  for (const rec of scored) {
    idx++;
    const installCmd = buildInstallCmd(rec.entry.source);
    output += `  ${idx}. ${rec.entry.displayName.padEnd(35)} score: ${Math.round(rec.score)}\n`;
    output += `     ${rec.entry.description}\n`;
    output += `     Match: ${rec.matchReasons.join(', ')}\n`;
    output += `     Install: ${installCmd}\n\n`;
  }

  output += 'To install all recommended: upskill recommendations --install\n';
  return { stdout: output, stderr: '', exitCode: 0 };
}

/**
 * Create the upskill command with access to the virtual filesystem.
 *
 * @param browser Optional BrowserAPI used by the `tabs` subcommand. When
 *   omitted (e.g. headless tests or pre-CDP boot), `upskill tabs` exits
 *   non-zero with a clear "browser APIs unavailable" message.
 */
export function createUpskillCommand(
  fs: VirtualFS,
  fetchFn: SecureFetch,
  browser?: BrowserAPI
): Command {
  return defineCommand('upskill', async (args, _ctx: CommandContext) => {
    if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
      return upskillHelp();
    }

    // `upskill tabs [--json]` — surface skill suggestions for open browser
    // tabs. Handled up-front so the rest of the arg parser doesn't try to
    // interpret `tabs` as a GitHub `owner/repo` ref.
    if (args[0] === 'tabs') {
      const jsonMode = args.includes('--json');
      return handleTabs(fs, fetchFn, browser, jsonMode);
    }

    // Parse arguments
    const selectedSkills: string[] = [];
    let subPath: string | undefined;
    let listOnly = false;
    let installAll = false;
    let force = false;
    let sourceRef = '';
    let branch: string | undefined;
    let searchQuery = '';
    let page = 1;

    let i = 0;
    while (i < args.length) {
      const arg = args[i];

      if (arg === 'search') {
        // Collect the search query (excluding --page flag)
        const rest = args.slice(i + 1);
        const pageIdx = rest.indexOf('--page');
        if (pageIdx >= 0) {
          page = parseInt(rest[pageIdx + 1], 10) || 1;
          rest.splice(pageIdx, 2);
        }
        searchQuery = rest.join(' ');
        break;
      } else if (arg === 'recommendations') {
        const installFlag = args.includes('--install');
        return handleRecommendations(fs, fetchFn, installFlag);
      } else if (arg === 'list') {
        // List local skills
        const skills = await import('../../skills/index.js');
        const discovered = await skills.discoverSkills(fs);

        if (discovered.length === 0) {
          return {
            stdout: `No discoverable local skills found.\n\n${formatDiscoveryScope()}`,
            stderr: '',
            exitCode: 0,
          };
        }

        return {
          stdout: formatDiscoveredSkills(discovered, 'Discoverable local skills'),
          stderr: '',
          exitCode: 0,
        };
      } else if (arg === 'info' || arg === 'read') {
        // Delegate to skills module
        const skillName = args[i + 1];
        if (!skillName) {
          return {
            stdout: '',
            stderr: `upskill: ${arg} requires a skill name\n`,
            exitCode: 1,
          };
        }

        const skills = await import('../../skills/index.js');
        if (arg === 'info') {
          const skill = await skills.getSkillInfo(fs, skillName);
          if (!skill) {
            return {
              stdout: '',
              stderr: `upskill: skill "${skillName}" not found\n`,
              exitCode: 1,
            };
          }

          return { stdout: formatSkillInfo(skill), stderr: '', exitCode: 0 };
        } else {
          const instructions = await skills.readSkillInstructions(fs, skillName);
          if (instructions === null) {
            return {
              stdout: '',
              stderr: `upskill: no SKILL.md found for "${skillName}"\n`,
              exitCode: 1,
            };
          }
          return { stdout: instructions + '\n', stderr: '', exitCode: 0 };
        }
      } else if (arg === '--skill') {
        selectedSkills.push(args[++i]);
      } else if (arg === '--path' || arg === '-p') {
        const val = args[++i];
        // Defense-in-depth: even though `handoff-link.ts` already drops
        // unsafe Link-param values before they reach the cone, re-validate
        // here so a future dispatch path (or a hand-typed CLI invocation
        // that splices unsanitized input) still cannot smuggle shell
        // metachars past argv. The allowlist matches the one in
        // `handoff-link.ts` — keep them in sync.
        if (typeof val !== 'string' || !isSafeUpskillPath(val)) {
          return {
            stdout: '',
            stderr:
              'upskill: --path must be a repo-relative sub-path of [A-Za-z0-9._/-]+ with no "..", leading "-"/"/", or shell metacharacters\n',
            exitCode: 1,
          };
        }
        subPath = val;
      } else if (arg === '--list') {
        listOnly = true;
      } else if (arg === '--all') {
        installAll = true;
      } else if (arg === '--force') {
        force = true;
      } else if (arg === '--branch' || arg === '-b') {
        const val = args[i + 1];
        if (!val || val.startsWith('-')) {
          return { stdout: '', stderr: 'upskill: --branch requires a value\n', exitCode: 1 };
        }
        // Defense-in-depth: see comment on --path above. Branch names
        // must satisfy `git check-ref-format`-style allowlist so a
        // mis-quoted splice from a Link header cannot inject commands.
        if (!isSafeUpskillBranch(val)) {
          return {
            stdout: '',
            stderr:
              'upskill: --branch must be a git ref of [A-Za-z0-9._/-]+ with no "..", leading "-"/"/", trailing "/" or ".lock", or shell metacharacters\n',
            exitCode: 1,
          };
        }
        branch = args[++i];
      } else if (!arg.startsWith('-')) {
        sourceRef = arg;
      }
      i++;
    }

    // Handle search
    if (searchQuery) {
      return searchRegistries(searchQuery, fetchFn, page);
    }

    if (!sourceRef) {
      return upskillHelp();
    }

    // Check if it's a Tessl reference (tessl:name)
    if (sourceRef.startsWith('tessl:')) {
      const tesslName = sourceRef.slice(6);
      if (!tesslName) {
        return { stdout: '', stderr: 'upskill: tessl: requires a skill name\n', exitCode: 1 };
      }
      const resolved = await resolveTesslRef(tesslName, fetchFn);
      if ('error' in resolved) {
        return { stdout: '', stderr: `upskill: ${resolved.error}\n`, exitCode: 1 };
      }
      const github = await createGitHubRequestContext(fetchFn);
      return installFromGitHub(
        resolved.owner,
        resolved.repo,
        resolved.skillPath,
        resolved.skillName,
        fs,
        github,
        force,
        fetchFn
      );
    }

    // Check if it's a browse.sh reference (browse:<hostname>/<task> or URL form)
    const browseShRef = parseBrowseShRef(sourceRef);
    if (browseShRef) {
      return installFromBrowseSh(browseShRef.hostname, browseShRef.task, fs, fetchFn, force);
    }

    // Check if it's a GitHub reference
    const githubRef = parseGitHubRef(sourceRef);
    if (githubRef) {
      const { owner, repo } = githubRef;
      // --branch flag takes precedence over @branch / URL /tree/<branch>
      const effectiveBranch = branch ?? githubRef.branch;
      // --path/-p takes precedence over implicit subpath from URL /tree/<branch>/<path>
      const effectiveSubPath = subPath ?? githubRef.path;
      const github = await createGitHubRequestContext(fetchFn);

      // List skills in the repository
      const result = await listGitHubSkills(
        owner,
        repo,
        github,
        effectiveSubPath,
        fetchFn,
        effectiveBranch
      );

      if (result.error) {
        return {
          stdout: '',
          stderr: `upskill: failed to list skills: ${result.error}\n`,
          exitCode: 1,
        };
      }

      if (result.skills.length === 0) {
        return {
          stdout: `No skills found in ${owner}/${repo}${effectiveSubPath ? '/' + effectiveSubPath : ''}\n`,
          stderr: '',
          exitCode: 0,
        };
      }

      // Just list if --list flag
      if (listOnly) {
        let output = `Available skills in ${owner}/${repo}:\n\n`;
        for (const skill of result.skills) {
          output += `  ${skill.name.padEnd(30)} ${skill.path}\n`;
        }
        output += `\nFound ${result.skills.length} skill(s)\n`;
        output += `\nTo install: upskill ${sourceRef} --skill <name>\n`;
        output += `To install all: upskill ${sourceRef} --all\n`;
        return { stdout: output, stderr: '', exitCode: 0 };
      }

      // Determine which skills to install
      let skillsToInstall = result.skills;

      if (selectedSkills.length > 0) {
        skillsToInstall = result.skills.filter((s) => selectedSkills.includes(s.name));

        // Check for missing skills
        for (const name of selectedSkills) {
          if (!result.skills.find((s) => s.name === name)) {
            return {
              stdout: '',
              stderr: `upskill: skill "${name}" not found in ${owner}/${repo}\n`,
              exitCode: 1,
            };
          }
        }
      } else if (!installAll) {
        // No selection made - show list and prompt
        let output = `Available skills in ${owner}/${repo}:\n\n`;
        for (const skill of result.skills) {
          output += `  ${skill.name.padEnd(30)} ${skill.path}\n`;
        }
        output += `\nFound ${result.skills.length} skill(s)\n`;
        output += `\nTo install specific skills: upskill ${sourceRef} --skill <name>\n`;
        output += `To install all: upskill ${sourceRef} --all\n`;
        return { stdout: output, stderr: '', exitCode: 0 };
      }

      // Install selected skills — download ZIP once, extract all skills from it
      let output = '';
      let errors = '';
      let successCount = 0;
      const totalSkills = skillsToInstall.length;
      const startTime = Date.now();

      // For batch installs (--all or multiple --skill), use ZIP and skip per-skill hooks
      if (totalSkills > 1) {
        const zip = await fetchRepoZip(owner, repo, fetchFn, effectiveBranch);
        if (zip.status === 'ok') {
          const files = stripZipPrefix(zip.files);

          for (let si = 0; si < skillsToInstall.length; si++) {
            const skill = skillsToInstall[si];
            const result = await installSkillFromZip(skill.path, skill.name, files, fs, force);
            const idx = si + 1;
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
            const avgTime = (Date.now() - startTime) / idx;
            const remaining = Math.round(((totalSkills - idx) * avgTime) / 1000);
            const eta = idx < totalSkills ? ` (~${remaining}s remaining)` : '';

            if (result.ok) {
              output += `[${idx}/${totalSkills}] Installed "${skill.name}" from ${owner}/${repo} (${elapsed}s)${eta}\n`;
              successCount++;
            } else {
              output += `[${idx}/${totalSkills}] Failed "${skill.name}": ${result.error}${eta}\n`;
              errors += `upskill: ${result.error}\n`;
            }
          }
        } else {
          // ZIP unavailable — fall back to Contents API per skill
          for (let si = 0; si < skillsToInstall.length; si++) {
            const skill = skillsToInstall[si];
            const installResult = await installFromGitHub(
              owner,
              repo,
              skill.path,
              skill.name,
              fs,
              github,
              force,
              undefined,
              effectiveBranch
            );
            const idx = si + 1;
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
            const avgTime = (Date.now() - startTime) / idx;
            const remaining = Math.round(((totalSkills - idx) * avgTime) / 1000);
            const eta = idx < totalSkills ? ` (~${remaining}s remaining)` : '';

            if (installResult.exitCode === 0) {
              output += `[${idx}/${totalSkills}] Installed "${skill.name}" from ${owner}/${repo} (${elapsed}s)${eta}\n`;
              successCount++;
            } else {
              output += `[${idx}/${totalSkills}] Failed "${skill.name}": ${installResult.stderr.trim()}${eta}\n`;
              errors += installResult.stderr;
            }
          }
        }
      } else {
        // Single skill — use the existing installFromGitHub path
        for (const skill of skillsToInstall) {
          const installResult = await installFromGitHub(
            owner,
            repo,
            skill.path,
            skill.name,
            fs,
            github,
            force,
            fetchFn,
            effectiveBranch
          );

          if (installResult.exitCode === 0) {
            output += installResult.stdout;
            successCount++;
          } else {
            errors += installResult.stderr;
          }
        }
      }

      const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(1);

      if (successCount > 0) {
        output += `\nInstalled ${successCount} skill(s)${totalSkills > 1 ? ` in ${totalElapsed}s` : ''}\n`;
        await runPostInstallHooks();
      }

      return {
        stdout: output,
        stderr: errors,
        exitCode: errors ? 1 : 0,
      };
    }

    // Unknown source format
    return {
      stdout: '',
      stderr: `upskill: unrecognized source "${sourceRef}"\n\nExpected: owner/repo, tessl:<name>, or browse:<hostname>/<task>\n`,
      exitCode: 1,
    };
  });
}

/**
 * Create skill command as an alias for upskill with local operations only.
 */
export function createSkillCommand(fs: VirtualFS): Command {
  return defineCommand('skill', async (args, _ctx: CommandContext) => {
    if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
      return {
        stdout: `usage: skill <command> [options]

Commands:
  list                   List discoverable skills
  info <name>            Show details about a skill
  read <name>            Read the SKILL.md instructions

${formatDiscoveryScope()}
For installing skills from registries or GitHub, use 'upskill':
  upskill search "query"           Search registries (Tessl + browse.sh)
  upskill owner/repo --list        List skills in GitHub repo
  upskill owner/repo --all         Install from GitHub
  upskill tessl:<name>             Install from Tessl registry
  upskill browse:<host>/<task>     Install from browse.sh catalog

Examples:
  skill list
  skill info bluebubbles
  skill read bluebubbles
`,
        stderr: '',
        exitCode: 0,
      };
    }

    const subcommand = args[0];
    const skills = await import('../../skills/index.js');

    try {
      switch (subcommand) {
        case 'list': {
          const discovered = await skills.discoverSkills(fs);

          if (discovered.length === 0) {
            return {
              stdout: `No discoverable skills found.\n\n${formatDiscoveryScope()}Install skills with: upskill owner/repo --all\n`,
              stderr: '',
              exitCode: 0,
            };
          }

          return {
            stdout: formatDiscoveredSkills(discovered, 'Discoverable skills'),
            stderr: '',
            exitCode: 0,
          };
        }

        case 'info': {
          const name = args[1];
          if (!name) {
            return { stdout: '', stderr: 'skill: info requires a skill name\n', exitCode: 1 };
          }

          const skill = await skills.getSkillInfo(fs, name);
          if (!skill) {
            return { stdout: '', stderr: `skill: "${name}" not found\n`, exitCode: 1 };
          }

          return { stdout: formatSkillInfo(skill), stderr: '', exitCode: 0 };
        }

        case 'read': {
          const name = args[1];
          if (!name) {
            return { stdout: '', stderr: 'skill: read requires a skill name\n', exitCode: 1 };
          }

          const instructions = await skills.readSkillInstructions(fs, name);
          if (instructions === null) {
            return { stdout: '', stderr: `skill: no SKILL.md found for "${name}"\n`, exitCode: 1 };
          }

          return { stdout: instructions + '\n', stderr: '', exitCode: 0 };
        }

        default:
          return { stdout: '', stderr: `skill: unknown command "${subcommand}"\n`, exitCode: 1 };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { stdout: '', stderr: `skill: ${msg}\n`, exitCode: 1 };
    }
  });
}
