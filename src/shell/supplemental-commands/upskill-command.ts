import { defineCommand } from 'just-bash';
import type { Command, CommandContext, SecureFetch } from 'just-bash';
import type { VirtualFS } from '../../fs/index.js';
import { VirtualFS as SharedVirtualFS } from '../../fs/index.js';
import { unzipSync } from 'fflate';
import { consumeCachedBinaryByUrl } from '../binary-cache.js';

// ClawHub uses a Convex backend - this is the actual API endpoint
const CLAWHUB_API = 'https://wry-manatee-359.convex.site/api/v1';
const TESSL_API = 'https://api.tessl.io';
const SKILLS_DIR = '/workspace/skills';
const GITHUB_GLOBAL_DB = 'slicc-fs-global';
const GITHUB_TOKEN_PATH = '/workspace/.git/github-token';
const GITHUB_API_ACCEPT = 'application/vnd.github.v3+json';

interface ClawHubSearchResult {
  slug: string;
  displayName: string;
  summary: string;
  version: string | null;
  updatedAt: number;
  score?: number;
}

interface ClawHubSearchResponse {
  results: ClawHubSearchResult[];
}

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
  source: 'clawhub' | 'tessl';
  qualityScore: number | null;
  installHint: string;
  featured?: boolean;
  sourceRepo?: string;
}

// ── Skill Catalog types ──

interface CatalogSkillSource {
  repo: string;
  path?: string;
  skill?: string;
  flags?: string;
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

interface SkillCatalog {
  version: number;
  skills: CatalogSkill[];
}

interface UserProfile {
  purpose: string;
  role: string;
  tasks: string[];
  apps: string[];
  name: string;
}

interface ScoredSkill {
  entry: CatalogSkill;
  score: number;
  matchReasons: string[];
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
  if (source.skill) cmd += ` --skill ${source.skill}`;
  if (source.flags) cmd += ` ${source.flags}`;
  return cmd;
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
  cachedGlobalFsPromise = undefined;
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

function getGitHubErrorDetail(body: string): string | undefined {
  if (!body) return undefined;
  try {
    const parsed = JSON.parse(body) as GitHubErrorBody;
    if (typeof parsed.message === 'string' && parsed.message.trim()) {
      return parsed.message.trim();
    }
  } catch {
    // Not JSON — fall back to a trimmed text preview.
  }

  const trimmed = body.trim();
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

function upskillHelp(): { stdout: string; stderr: string; exitCode: number } {
  return {
    stdout: `usage: upskill <command> [options]

Install skills from GitHub repositories, ClawHub, or Tessl registry.

Commands:
  search <query>           Search ClawHub + Tessl for skills
  list                     List locally installed skills
  info <name>              Show details about a local skill
  read <name>              Read the SKILL.md instructions
  <owner/repo>             Install skill(s) from GitHub repository
  <clawhub-url>            Install skill from ClawHub URL
  tessl:<name>             Install skill from Tessl registry

GitHub Installation:
  upskill owner/repo                     List available skills in repo
  upskill owner/repo --skill name        Install specific skill
  upskill owner/repo --all               Install all skills from repo
  upskill owner/repo --path subdir       Restrict to subfolder

Recommendations:
  upskill recommendations                Show skills matching your profile
  upskill recommendations --install      Install all recommended skills

Registry Search:
  upskill search "pdf conversion"        Search all registries
  upskill https://clawhub.ai/user/skill  Install from ClawHub URL
  upskill clawhub:user/skill             Install from ClawHub shorthand
  upskill tessl:postgres-pro             Install from Tessl (via GitHub)

Options:
  --skill <name>           Install specific skill (repeatable)
  --all                    Install all skills from source
  --path <subfolder>       Only discover skills under this subfolder
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
  upskill https://clawhub.ai/arun-8687/tavily-search
  upskill tessl:postgres-pro
`,
    stderr: '',
    exitCode: 0,
  };
}

/**
 * Search ClawHub registry for skills, returning unified results.
 */
async function fetchClawHubResults(
  query: string,
  fetch: SecureFetch
): Promise<UnifiedSearchResult[]> {
  const url = `${CLAWHUB_API}/search?q=${encodeURIComponent(query)}`;
  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
  });
  if (response.status !== 200) throw new Error(`ClawHub returned HTTP ${response.status}`);
  const data = JSON.parse(response.body) as ClawHubSearchResponse;
  if (!data.results) return [];
  return data.results.map((r) => ({
    name: r.slug,
    displayName: r.displayName || r.slug,
    summary: r.summary || '',
    source: 'clawhub' as const,
    qualityScore: null,
    installHint: `upskill clawhub:${r.slug}`,
  }));
}

/**
 * Extract owner/repo from a GitHub URL.
 */
function parseGitHubUrl(url: string): { owner: string; repo: string } | null {
  const match = url.match(/github\.com\/([^\/?#]+)\/([^\/?#]+)/);
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
  const data = JSON.parse(response.body) as TesslSearchResponse;
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
    if (existing && existing.qualityScore != null && score != null && existing.qualityScore >= score) continue;
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

/**
 * Search both ClawHub and Tessl registries, interleave results.
 */
const SEARCH_PAGE_SIZE = 10;

async function searchRegistries(
  query: string,
  fetch: SecureFetch,
  page: number = 1
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const [clawHubResult, tesslResult] = await Promise.allSettled([
    fetchClawHubResults(query, fetch),
    fetchTesslResults(query, fetch),
  ]);

  const clawHub = clawHubResult.status === 'fulfilled' ? clawHubResult.value : [];
  const tessl = tesslResult.status === 'fulfilled' ? tesslResult.value : [];

  if (clawHub.length === 0 && tessl.length === 0) {
    let stderr = '';
    if (clawHubResult.status === 'rejected' && tesslResult.status === 'rejected') {
      stderr = 'upskill: both registries failed to respond\n';
    }
    return {
      stdout: `No skills found for "${query}"\n\nTry a different search term or browse https://clawhub.ai or https://tessl.io/registry\n`,
      stderr,
      exitCode: stderr ? 1 : 0,
    };
  }

  // Merge: lead with up to 3 Tessl results, then interleave
  const merged: UnifiedSearchResult[] = [];
  let ti = 0;
  let ci = 0;

  // Lead with Tessl (scored, higher signal)
  while (ti < tessl.length && ti < 3) {
    merged.push(tessl[ti++]);
  }

  // Interleave remaining
  while (ci < clawHub.length || ti < tessl.length) {
    if (ci < clawHub.length) merged.push(clawHub[ci++]);
    if (ti < tessl.length) merged.push(tessl[ti++]);
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
  if (clawHub.length > 0) output += `  From ClawHub:  upskill clawhub:<slug>\n`;
  if (tessl.length > 0) output += `  From Tessl:    upskill <owner/repo> --skill <name>\n`;

  return { stdout: output, stderr: '', exitCode: 0 };
}

/**
 * Install a skill from ClawHub (downloads as ZIP)
 */
async function installFromClawHub(
  slug: string,
  fs: VirtualFS,
  fetch: SecureFetch,
  force: boolean = false,
  registeredCommands?: string[]
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    // Check if skill already exists
    const skillDir = `${SKILLS_DIR}/${slug}`;
    try {
      await fs.stat(skillDir);
      if (!force) {
        return {
          stdout: '',
          stderr: `upskill: skill "${slug}" already exists (use --force to overwrite)\n`,
          exitCode: 1,
        };
      }
      // Remove existing skill
      await fs.rm(skillDir, { recursive: true });
    } catch {
      // Skill doesn't exist, good to proceed
    }

    // Download skill ZIP bundle from ClawHub
    const downloadUrl = `${CLAWHUB_API}/download?slug=${encodeURIComponent(slug)}`;
    const downloadResponse = await fetch(downloadUrl, {});

    if (downloadResponse.status === 404) {
      return {
        stdout: '',
        stderr: `upskill: skill "${slug}" not found on ClawHub\n`,
        exitCode: 1,
      };
    }

    if (downloadResponse.status !== 200) {
      return {
        stdout: '',
        stderr: `upskill: failed to download skill (HTTP ${downloadResponse.status})\n`,
        exitCode: 1,
      };
    }

    // The response body should be latin1-encoded by the fetch proxy for binary content.
    // Try to get the raw binary from the cache first (bypasses string encoding issues).
    const contentType = downloadResponse.headers['content-type'] || '';

    // Try to get cached binary data by URL first (most reliable - bypasses string encoding issues)
    let zipBytes = consumeCachedBinaryByUrl(downloadUrl);
    let badCharIdx = -1;
    let badCharCode = 0;

    if (!zipBytes) {
      // Fallback: Convert latin1 string to bytes - each char code maps directly to a byte
      zipBytes = new Uint8Array(downloadResponse.body.length);
      for (let i = 0; i < downloadResponse.body.length; i++) {
        const code = downloadResponse.body.charCodeAt(i);
        if (code > 255 && badCharIdx < 0) {
          badCharIdx = i;
          badCharCode = code;
        }
        zipBytes[i] = code & 0xff; // Mask to byte range
      }
    }

    // Unzip the bundle
    let files: ReturnType<typeof unzipSync>;
    try {
      files = unzipSync(zipBytes);
    } catch (unzipErr) {
      const msg = unzipErr instanceof Error ? unzipErr.message : String(unzipErr);
      // Debug info
      const hexPreview = Array.from(zipBytes.slice(0, 20))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join(' ');
      const badCharInfo = badCharIdx >= 0 ? `\nBad char at ${badCharIdx}: code ${badCharCode}` : '';
      return {
        stdout: '',
        stderr: `upskill: failed to unzip: ${msg}\nContent-Type: ${contentType}\nBody: ${downloadResponse.body.length} chars\nHex: ${hexPreview}${badCharInfo}\n`,
        exitCode: 1,
      };
    }

    // Create skill directory
    await fs.mkdir(skillDir, { recursive: true });

    // Extract files
    let fileCount = 0;
    for (const [entryPath, content] of Object.entries(files)) {
      const normalized = entryPath.replace(/\\/g, '/');
      if (!normalized || normalized.endsWith('/')) continue;

      // Skip _meta.json if present (ClawHub metadata)
      if (normalized === '_meta.json') continue;

      const filePath = `${skillDir}/${normalized}`;
      const parentDir = filePath.substring(0, filePath.lastIndexOf('/'));
      if (parentDir !== skillDir) {
        await fs.mkdir(parentDir, { recursive: true });
      }

      // Write file content (Uint8Array)
      await fs.writeFile(filePath, content);
      fileCount++;
    }

    // Check for required bins in SKILL.md frontmatter
    const binsWarning = checkRequiredBins(files, registeredCommands);

    await refreshSprinklesAfterInstall();
    return {
      stdout: `Installed skill "${slug}" from ClawHub (${fileCount} files)\n${binsWarning}`,
      stderr: '',
      exitCode: 0,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      stdout: '',
      stderr: `upskill: failed to install from ClawHub: ${msg}\n`,
      exitCode: 1,
    };
  }
}

/**
 * Parse SKILL.md frontmatter for openclaw/clawdis requires.bins and check availability.
 */
function checkRequiredBins(
  files: Record<string, Uint8Array>,
  registeredCommands?: string[]
): string {
  // Find SKILL.md in the extracted files
  let skillMdContent: string | undefined;
  for (const [path, content] of Object.entries(files)) {
    const basename = path.split('/').pop() || '';
    if (basename.toLowerCase() === 'skill.md') {
      skillMdContent = new TextDecoder().decode(content);
      break;
    }
  }
  if (!skillMdContent) return '';

  // Extract frontmatter
  const fmMatch = skillMdContent.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!fmMatch) return '';

  // Look for requires.bins in the metadata JSON block
  const frontmatter = fmMatch[1];
  const bins = extractRequiredBins(frontmatter);
  if (bins.length === 0) return '';

  if (!registeredCommands || registeredCommands.length === 0) {
    return `  Requires: ${bins.join(', ')}\n`;
  }

  const available = new Set(registeredCommands);
  const missing = bins.filter((b) => !available.has(b));

  if (missing.length === 0) {
    return `  Requires: ${bins.join(', ')} (all available)\n`;
  }

  return `  Requires: ${bins.join(', ')}\n  Missing: ${missing.join(', ')} -- this skill may not work in the SLICC shell\n`;
}

/**
 * Extract bins array from SKILL.md frontmatter metadata block.
 * Handles both JSON metadata blocks and YAML-ish patterns.
 */
function extractRequiredBins(frontmatter: string): string[] {
  // Try to find a JSON metadata block
  const metaMatch = frontmatter.match(/metadata:\s*\n\s*(\{[\s\S]*\})/);
  if (metaMatch) {
    try {
      const meta = JSON.parse(metaMatch[1]) as Record<string, unknown>;
      // Check openclaw.requires.bins or clawdis.requires.bins
      for (const key of ['openclaw', 'clawdis', 'clawdbot']) {
        const section = meta[key] as Record<string, unknown> | undefined;
        if (section?.requires && typeof section.requires === 'object') {
          const req = section.requires as Record<string, unknown>;
          if (Array.isArray(req.bins)) {
            return req.bins.filter((b): b is string => typeof b === 'string');
          }
        }
      }
    } catch {
      // JSON parse failed, try regex fallback
    }
  }

  // Regex fallback: look for "bins": ["python3", ...] anywhere in frontmatter
  const binsMatch = frontmatter.match(/"bins"\s*:\s*\[([^\]]*)\]/);
  if (binsMatch) {
    return binsMatch[1]
      .split(',')
      .map((s) => s.trim().replace(/^["']|["']$/g, ''))
      .filter(Boolean);
  }

  return [];
}

/**
 * Parse Tessl reference (tessl:name) and resolve to GitHub source.
 */
async function resolveTesslRef(
  name: string,
  fetch: SecureFetch
): Promise<{ owner: string; repo: string; skillPath: string; skillName: string } | { error: string }> {
  const url = `${TESSL_API}/experimental/search?q=${encodeURIComponent(name)}&contentType=skills&page%5Bsize%5D=5`;
  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
  });
  if (response.status !== 200) {
    return { error: `Tessl search failed (HTTP ${response.status})` };
  }
  const data = JSON.parse(response.body) as TesslSearchResponse;
  // Find exact name match among skills
  const match = data.data?.find(
    (item) => item.type === 'skill' && item.attributes.name === name
  );
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
  | { status: 'not_found' }
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
    return { status: 'not_found' };
  }
  if (response.status !== 200) {
    return { status: 'error', message: `codeload returned HTTP ${response.status}` };
  }

  let zipBytes = consumeCachedBinaryByUrl(url);
  if (!zipBytes) {
    zipBytes = new Uint8Array(response.body.length);
    for (let i = 0; i < response.body.length; i++) {
      zipBytes[i] = response.body.charCodeAt(i) & 0xff;
    }
  }

  try {
    return { status: 'ok', files: unzipSync(zipBytes) };
  } catch (e) {
    return { status: 'error', message: `failed to unzip: ${e instanceof Error ? e.message : String(e)}` };
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
  fetch?: SecureFetch
): Promise<{ skills: Array<{ name: string; path: string }>; error?: string }> {
  // Try ZIP-based discovery first (no rate limit)
  if (fetch) {
    const zip = await fetchRepoZip(owner, repo, fetch);
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
    if (zip.status === 'not_found') {
      return { skills: [], error: `repository ${owner}/${repo} not found` };
    }
    // zip.status === 'error' — fall through to API
  }

  // Fallback: Contents API (rate-limited for anonymous users)
  const skills: Array<{ name: string; path: string }> = [];

  async function scanDir(path: string): Promise<void> {
    const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
    const response = await github.request(url);

    if (response.status !== 200) {
      throw new Error(
        formatGitHubFailure(response, `${owner}/${repo}${path ? `/${path}` : ''}`, github.hasToken)
      );
    }

    const contents = JSON.parse(response.body) as GitHubContent[];

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
  fetch?: SecureFetch
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
      const zip = await fetchRepoZip(owner, repo, fetch);
      if (zip.status === 'not_found') {
        return {
          stdout: '',
          stderr: `upskill: repository ${owner}/${repo} not found\n`,
          exitCode: 1,
        };
      }
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
    const url = `https://api.github.com/repos/${owner}/${repo}/contents/${skillPath}`;
    const response = await github.request(url);

    if (response.status !== 200) {
      return {
        stdout: '',
        stderr: `upskill: ${formatGitHubFailure(response, `${owner}/${repo}/${skillPath}`, github.hasToken)}\n`,
        exitCode: 1,
      };
    }

    const contents = JSON.parse(response.body) as GitHubContent[];

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
          const subUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${item.path}`;
          const subResponse = await github.request(subUrl);
          if (subResponse.status !== 200) {
            throw new Error(
              formatGitHubFailure(subResponse, `${owner}/${repo}/${item.path}`, github.hasToken)
            );
          }
          const subContents = JSON.parse(subResponse.body) as GitHubContent[];
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

    await refreshSprinklesAfterInstall();
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

/**
 * Parse ClawHub URL or shorthand into a slug.
 * ClawHub URLs are: https://clawhub.ai/{owner}/{slug}
 * But the API only needs the slug (e.g., "tavily-search")
 */
function parseClawHubRef(ref: string): string | null {
  // Handle full URL: https://clawhub.ai/user/skill-slug
  const urlMatch = ref.match(/^https?:\/\/clawhub\.ai\/[^\/]+\/([^\/]+)/);
  if (urlMatch) {
    return urlMatch[1]; // Return just the slug, not owner/slug
  }

  // Handle shorthand: clawhub:slug or clawhub:owner/slug
  if (ref.startsWith('clawhub:')) {
    const rest = ref.slice(8);
    // If it contains a slash, take the second part (the slug)
    if (rest.includes('/')) {
      return rest.split('/')[1];
    }
    // Otherwise it's just the slug
    return rest;
  }

  return null;
}

/**
 * Parse GitHub repo reference
 */
function parseGitHubRef(ref: string): { owner: string; repo: string } | null {
  // Handle owner/repo format
  const match = ref.match(/^([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_.-]+)$/);
  if (match) {
    return { owner: match[1], repo: match[2] };
  }
  return null;
}

/** After a successful install, refresh sprinkle manager and auto-open new sprinkles. */
async function refreshSprinklesAfterInstall(): Promise<void> {
  try {
    if (typeof window === 'undefined') return;
    const mgr = (window as unknown as Record<string, unknown>).__slicc_sprinkleManager;
    if (mgr && typeof (mgr as Record<string, unknown>).openNewAutoOpenSprinkles === 'function') {
      await (mgr as { openNewAutoOpenSprinkles: () => Promise<void> }).openNewAutoOpenSprinkles();
    }
  } catch {
    /* best-effort */
  }
}

/**
 * Handle the `upskill recommendations` subcommand.
 */
async function handleRecommendations(
  fs: VirtualFS,
  fetchFn: SecureFetch,
  install: boolean
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  // Read user profile
  let profile: UserProfile | null = null;
  try {
    const raw = await fs.readTextFile('/home/user/.welcome.json');
    profile = JSON.parse(raw) as UserProfile;
  } catch {
    // not found
  }

  if (!profile) {
    return {
      stdout: '',
      stderr:
        'upskill: no user profile found. Complete the welcome onboarding first, or create /home/user/.welcome.json manually.\n',
      exitCode: 1,
    };
  }

  // Read skill catalog
  let catalog: SkillCatalog;
  try {
    const raw = await fs.readTextFile('/shared/skill-catalog.json');
    catalog = JSON.parse(raw) as SkillCatalog;
  } catch {
    return {
      stdout: '',
      stderr: 'upskill: skill catalog not found at /shared/skill-catalog.json\n',
      exitCode: 1,
    };
  }

  // Get already-installed skills
  const installed = new Set<string>();
  try {
    const skills = await import('../../skills/index.js');
    const discovered = await skills.discoverSkills(fs);
    for (const s of discovered) installed.add(s.name);
  } catch {
    /* best effort */
  }

  // Score and filter
  const scored = scoreSkills(catalog.skills, profile).filter((s) => !installed.has(s.entry.name));

  if (scored.length === 0) {
    return {
      stdout: 'No new skill recommendations — all matching skills are already installed.\n',
      stderr: '',
      exitCode: 0,
    };
  }

  if (install) {
    // Install all recommended skills
    let output = '';
    let errors = '';
    let successCount = 0;

    for (const rec of scored) {
      const src = rec.entry.source;
      const github = await createGitHubRequestContext(fetchFn);

      if (src.path && src.flags?.includes('--all')) {
        // Multi-skill install (e.g. AEM)
        const listResult = await listGitHubSkills(src.repo.split('/')[0], src.repo.split('/')[1], github, src.path, fetchFn);
        if (listResult.error) {
          errors += `upskill: failed to list ${rec.entry.name}: ${listResult.error}\n`;
          continue;
        }
        for (const skill of listResult.skills) {
          const result = await installFromGitHub(
            src.repo.split('/')[0], src.repo.split('/')[1],
            skill.path, skill.name, fs, github, false, fetchFn
          );
          if (result.exitCode === 0) {
            output += result.stdout;
            successCount++;
          } else {
            errors += result.stderr;
          }
        }
      } else if (src.skill) {
        // Single skill install
        const [owner, repo] = src.repo.split('/');
        const listResult = await listGitHubSkills(owner, repo, github, undefined, fetchFn);
        if (listResult.error) {
          errors += `upskill: failed to list ${rec.entry.name}: ${listResult.error}\n`;
          continue;
        }
        const match = listResult.skills.find((s) => s.name === src.skill);
        if (match) {
          const result = await installFromGitHub(owner, repo, match.path, match.name, fs, github, false, fetchFn);
          if (result.exitCode === 0) {
            output += result.stdout;
            successCount++;
          } else {
            errors += result.stderr;
          }
        }
      }
    }

    if (successCount > 0) {
      output += `\nInstalled ${successCount} recommended skill(s)\n`;
    }
    return { stdout: output, stderr: errors, exitCode: errors ? 1 : 0 };
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
 */
export function createUpskillCommand(fs: VirtualFS, fetchFn: SecureFetch): Command {
  return defineCommand('upskill', async (args, _ctx: CommandContext) => {
    if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
      return upskillHelp();
    }

    // Parse arguments
    const selectedSkills: string[] = [];
    let subPath: string | undefined;
    let listOnly = false;
    let installAll = false;
    let force = false;
    let sourceRef = '';
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
            stdout: 'No skills found in /workspace/skills/\n',
            stderr: '',
            exitCode: 0,
          };
        }

        let output = 'Installed skills:\n\n';
        for (const skill of discovered) {
          output += `  ${skill.name.padEnd(25)} ${skill.manifest.version.padEnd(10)}\n`;
          if (skill.manifest.description) {
            output += `    ${skill.manifest.description.slice(0, 60)}${skill.manifest.description.length > 60 ? '...' : ''}\n`;
          }
        }

        return { stdout: output, stderr: '', exitCode: 0 };
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

          let output = `Skill: ${skill.manifest.skill}\n`;
          output += `Version: ${skill.manifest.version}\n`;
          output += `Description: ${skill.manifest.description || '(none)'}\n`;
          return { stdout: output, stderr: '', exitCode: 0 };
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
        subPath = args[++i];
      } else if (arg === '--list') {
        listOnly = true;
      } else if (arg === '--all') {
        installAll = true;
      } else if (arg === '--force') {
        force = true;
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

    // Check if it's a ClawHub reference
    const clawHubSlug = parseClawHubRef(sourceRef);
    if (clawHubSlug) {
      const registeredCommands = _ctx.getRegisteredCommands?.() ?? [];
      return installFromClawHub(clawHubSlug, fs, fetchFn, force, registeredCommands);
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
      return installFromGitHub(resolved.owner, resolved.repo, resolved.skillPath, resolved.skillName, fs, github, force, fetchFn);
    }

    // Check if it's a GitHub reference
    const githubRef = parseGitHubRef(sourceRef);
    if (githubRef) {
      const { owner, repo } = githubRef;
      const github = await createGitHubRequestContext(fetchFn);

      // List skills in the repository
      const result = await listGitHubSkills(owner, repo, github, subPath, fetchFn);

      if (result.error) {
        return {
          stdout: '',
          stderr: `upskill: failed to list skills: ${result.error}\n`,
          exitCode: 1,
        };
      }

      if (result.skills.length === 0) {
        return {
          stdout: `No skills found in ${owner}/${repo}${subPath ? '/' + subPath : ''}\n`,
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

      // Install selected skills
      let output = '';
      let errors = '';
      let successCount = 0;

      for (const skill of skillsToInstall) {
        const installResult = await installFromGitHub(
          owner,
          repo,
          skill.path,
          skill.name,
          fs,
          github,
          force,
          fetchFn
        );

        if (installResult.exitCode === 0) {
          output += installResult.stdout;
          successCount++;
        } else {
          errors += installResult.stderr;
        }
      }

      if (successCount > 0) {
        output += `\nInstalled ${successCount} skill(s)\n`;
        await refreshSprinklesAfterInstall();
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
      stderr: `upskill: unrecognized source "${sourceRef}"\n\nExpected: owner/repo, clawhub:<slug>, tessl:<name>, or https://clawhub.ai/user/skill\n`,
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
  list                   List installed skills
  info <name>            Show details about a skill
  read <name>            Read the SKILL.md instructions
  install <name>         Install a local skill (apply manifest)
  uninstall <name>       Uninstall a skill

For installing skills from registries or GitHub, use 'upskill':
  upskill search "query"           Search ClawHub + Tessl
  upskill owner/repo --list        List skills in GitHub repo
  upskill owner/repo --all         Install from GitHub
  upskill tessl:<name>             Install from Tessl registry

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
              stdout:
                'No skills found in /workspace/skills/\n\nInstall skills with: upskill owner/repo --all\n',
              stderr: '',
              exitCode: 0,
            };
          }

          let output = 'Available skills:\n\n';
          output += '  NAME                 VERSION    STATUS\n';
          output += '  ────────────────────────────────────────\n';

          for (const skill of discovered) {
            const status = skill.installed ? `installed (v${skill.installedVersion})` : 'available';
            output += `  ${skill.name.padEnd(20)} ${skill.manifest.version.padEnd(10)} ${status}\n`;
          }

          return { stdout: output, stderr: '', exitCode: 0 };
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

          let output = `Skill: ${skill.manifest.skill}\n`;
          output += `Version: ${skill.manifest.version}\n`;
          output += `Description: ${skill.manifest.description || '(none)'}\n`;
          output += `Status: ${skill.installed ? `installed (v${skill.installedVersion})` : 'not installed'}\n`;

          return { stdout: output, stderr: '', exitCode: 0 };
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

        case 'install': {
          const name = args[1];
          if (!name) {
            return { stdout: '', stderr: 'skill: install requires a skill name\n', exitCode: 1 };
          }

          const result = await skills.applySkill(fs, name);
          if (result.success) {
            await refreshSprinklesAfterInstall();
            return {
              stdout: `Installed skill "${result.skill}" v${result.version}\n`,
              stderr: '',
              exitCode: 0,
            };
          }
          return { stdout: '', stderr: `skill: ${result.error}\n`, exitCode: 1 };
        }

        case 'uninstall': {
          const name = args[1];
          if (!name) {
            return { stdout: '', stderr: 'skill: uninstall requires a skill name\n', exitCode: 1 };
          }

          const result = await skills.uninstallSkill(fs, name);
          if (result.success) {
            return { stdout: `Uninstalled skill "${result.skill}"\n`, stderr: '', exitCode: 0 };
          }
          return { stdout: '', stderr: `skill: ${result.error}\n`, exitCode: 1 };
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
