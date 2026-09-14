import type { SecureFetch } from 'just-bash';
import type { VirtualFS } from '../../../../fs/index.js';
import { decodeFetchBody, parseFetchJson } from '../../../fetch-body.js';
import { clearSkillDirPreservingDotfiles } from '../dotfiles.js';
import { describeFetchError } from '../fetch-error.js';
import { managedFiles, runPostInstallHooks } from '../install-pipeline.js';
import { writeProvenance } from '../provenance.js';
import type { BrowseShDetail, BrowseShSkillSummary, UnifiedSearchResult } from '../types.js';
import { BROWSE_SH_API, SKILLS_DIR } from '../types.js';

export function normalizeHostname(host: string): string {
  const lower = host.toLowerCase();
  return lower.startsWith('www.') ? lower.slice(4) : lower;
}

let cachedBrowseShCatalog: BrowseShSkillSummary[] | undefined;
let cachedBrowseShCatalogPromise: Promise<BrowseShSkillSummary[]> | undefined;

export function _resetBrowseShCatalogCache(): void {
  cachedBrowseShCatalog = undefined;
  cachedBrowseShCatalogPromise = undefined;
}

export async function fetchBrowseShCatalog(fetch: SecureFetch): Promise<BrowseShSkillSummary[]> {
  if (cachedBrowseShCatalog) return cachedBrowseShCatalog;

  if (cachedBrowseShCatalogPromise !== undefined) return cachedBrowseShCatalogPromise;
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

function isSafeBrowseShSegment(seg: string): boolean {
  if (!seg) return false;
  if (seg === '.' || seg === '..') return false;
  return BROWSE_SH_SEGMENT_RE.test(seg);
}

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

  if (!isSafeBrowseShSegment(hostname)) return null;
  return { hostname, task };
}

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

export function stripBrowseShPreamble(content: string): string {
  const preamble = /(?:^|\n)> \[!NOTE\] \*\*Imported from browse\.sh\*\*[\s\S]*?(?:\n\n|$)/;
  return content.replace(preamble, '\n');
}

function insertBrowseShPreamble(skillMd: string, preamble: string): string {
  const fmMatch = skillMd.match(/^(---\r?\n[\s\S]*?\r?\n---)(\r?\n|$)/);
  if (!fmMatch) {
    return `${preamble}\n\n${skillMd}`;
  }
  const frontmatter = fmMatch[1];
  const afterFence = fmMatch[2] || '\n';
  const rest = skillMd.slice(fmMatch[0].length);
  return `${frontmatter}${afterFence}\n${preamble}\n\n${rest}`;
}

export async function prepareBrowseShSkill(
  hostname: string,
  task: string,
  fetch: SecureFetch
): Promise<
  { ok: true; dirName: string; slug: string; content: string } | { ok: false; error: string }
> {
  const slug = `${hostname}/${task}`;
  const detailUrl = `${BROWSE_SH_API}/${hostname}/${task}`;

  let detail: BrowseShDetail;
  try {
    const response = await fetch(detailUrl, { headers: { Accept: 'application/json' } });
    if (response.status === 404) {
      return { ok: false, error: `browse.sh skill "${slug}" not found` };
    }
    if (response.status !== 200) {
      return { ok: false, error: `browse.sh returned HTTP ${response.status} for "${slug}"` };
    }
    detail = parseFetchJson<BrowseShDetail>(response.body);
  } catch (err) {
    const msg = describeFetchError(err, detailUrl);
    return { ok: false, error: `failed to fetch browse.sh skill "${slug}": ${msg}` };
  }

  let skillMd: string | undefined;
  if (detail.skillMdUrl) {
    try {
      const blobResponse = await fetch(detail.skillMdUrl, { headers: { Accept: 'text/plain' } });
      if (blobResponse.status === 200) {
        skillMd = decodeFetchBody(blobResponse.body);
      }
    } catch {}
  }
  if (!skillMd && detail.skillMd) {
    skillMd = detail.skillMd;
  }
  if (!skillMd) {
    return { ok: false, error: `browse.sh skill "${slug}" has no SKILL.md content` };
  }

  const frontmatterName = extractFrontmatterField(skillMd, 'name');
  const fallbackName = task.replace(/-[A-Za-z0-9]{4,8}$/, '');
  const skillName = frontmatterName || fallbackName || task;

  if (!isSafeBrowseShSegment(skillName) || skillName.length > 64) {
    return {
      ok: false,
      error: `refusing to install browse.sh skill with unsafe name "${skillName}"`,
    };
  }

  if (!isSafeBrowseShSegment(hostname)) {
    return {
      ok: false,
      error: `refusing to install browse.sh skill with unsafe hostname "${hostname}"`,
    };
  }

  const preamble = buildBrowseShPreamble(detail, slug);
  return {
    ok: true,
    dirName: `browse-${hostname}-${skillName}`,
    slug,
    content: insertBrowseShPreamble(skillMd, preamble),
  };
}

export async function installFromBrowseSh(
  hostname: string,
  task: string,
  fs: VirtualFS,
  fetch: SecureFetch,
  force: boolean = false
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const prepared = await prepareBrowseShSkill(hostname, task, fetch);
  if (!prepared.ok) {
    return { stdout: '', stderr: `upskill: ${prepared.error}\n`, exitCode: 1 };
  }
  const { dirName, slug, content } = prepared;
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

    await clearSkillDirPreservingDotfiles(fs, destDir, await managedFiles(fs, dirName));
  } catch {}

  await fs.mkdir(destDir, { recursive: true });
  await fs.writeFile(`${destDir}/SKILL.md`, content);
  await writeProvenance(fs, dirName, {
    kind: 'browse.sh',
    source: slug,
    skill: dirName,
    files: ['SKILL.md'],
  });

  await runPostInstallHooks();

  return {
    stdout: `Installed skill "${dirName}" from browse.sh (${slug})\n`,
    stderr: '',
    exitCode: 0,
  };
}
