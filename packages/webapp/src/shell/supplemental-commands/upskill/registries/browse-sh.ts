/**
 * upskill — browse.sh registry backend.
 *
 * Extracted verbatim from `upskill-command.ts`. Owns the browse.sh catalog
 * cache, ref parsing, and single-skill install. All network I/O routes through
 * the injected `fetch: SecureFetch`.
 *
 * `normalizeHostname` lives here (rather than the monolith) so `parseBrowseShRef`
 * can use it without importing the monolith back — mirroring the `fetch-error.js`
 * cycle break from Wave 1. The monolith re-exports it for `discover.ts` and the
 * tabs subcommand until it moves to `tabs.ts` in Wave 3.
 */

import type { SecureFetch } from 'just-bash';
import type { VirtualFS } from '../../../../fs/index.js';
import { decodeFetchBody, parseFetchJson } from '../../../fetch-body.js';
import { describeFetchError } from '../fetch-error.js';
import { runPostInstallHooks } from '../install-pipeline.js';
import type { BrowseShDetail, BrowseShSkillSummary, UnifiedSearchResult } from '../types.js';
import { BROWSE_SH_API, SKILLS_DIR } from '../types.js';

/**
 * Normalize a hostname for catalog matching: lowercases and strips a single
 * leading `www.`. Exported so the browse.sh skill install dispatch can
 * reuse the exact same matching contract this subcommand surfaces to users.
 */
export function normalizeHostname(host: string): string {
  const lower = host.toLowerCase();
  return lower.startsWith('www.') ? lower.slice(4) : lower;
}

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
    let response;
    try {
      response = await fetch(BROWSE_SH_API, { headers: { Accept: 'application/json' } });
    } catch (err) {
      throw new Error(describeFetchError(err, BROWSE_SH_API));
    }
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
export async function fetchBrowseShResults(
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
export async function installFromBrowseSh(
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
    const msg = describeFetchError(err, detailUrl);
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
