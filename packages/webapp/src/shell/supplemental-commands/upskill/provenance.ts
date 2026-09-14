import type { VirtualFS } from '../../../fs/index.js';
import { parseFetchJson } from '../../fetch-body.js';
import type { GitHubRequestContext } from './types.js';
import { SKILLS_DIR } from './types.js';

export const PROVENANCE_FILE = '.upskill';
export const PROVENANCE_VERSION = 1;

export interface UpskillProvenance {
  version: number;

  kind: 'github' | 'browse.sh';

  source: string;

  skill: string;

  ref?: string;

  path?: string;

  sha?: string;

  installed: string;

  files?: string[];
}

export function provenancePath(skillName: string): string {
  return `${SKILLS_DIR}/${skillName}/${PROVENANCE_FILE}`;
}

export async function readProvenance(
  fs: VirtualFS,
  skillName: string
): Promise<UpskillProvenance | null> {
  try {
    const raw = await fs.readTextFile(provenancePath(skillName));
    const parsed = JSON.parse(raw) as UpskillProvenance;
    if (!parsed || typeof parsed !== 'object' || !parsed.kind || !parsed.source) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function writeProvenance(
  fs: VirtualFS,
  skillName: string,
  record: Omit<UpskillProvenance, 'version' | 'installed'> & { installed?: string }
): Promise<void> {
  try {
    const full: UpskillProvenance = {
      ...record,
      version: PROVENANCE_VERSION,
      installed: new Date().toISOString(),
    };
    await fs.writeFile(provenancePath(skillName), `${JSON.stringify(full, null, 2)}\n`);
  } catch {}
}

export interface SkillProvenanceScan {
  provenanced: Array<{ name: string; provenance: UpskillProvenance }>;

  unattributed: string[];
}

export async function scanSkillProvenance(fs: VirtualFS): Promise<SkillProvenanceScan> {
  let entries: Array<{ name: string; type: 'file' | 'directory' }>;
  try {
    entries = (await fs.readDir(SKILLS_DIR)) as Array<{ name: string; type: 'file' | 'directory' }>;
  } catch {
    return { provenanced: [], unattributed: [] };
  }
  const scan: SkillProvenanceScan = { provenanced: [], unattributed: [] };
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.type !== 'directory') continue;
    const provenance = await readProvenance(fs, entry.name);
    if (provenance) scan.provenanced.push({ name: entry.name, provenance });
    else scan.unattributed.push(entry.name);
  }
  return scan;
}

export async function listProvenancedSkills(
  fs: VirtualFS
): Promise<Array<{ name: string; provenance: UpskillProvenance }>> {
  return (await scanSkillProvenance(fs)).provenanced;
}

export async function resolveCommitSha(
  owner: string,
  repo: string,
  ref: string | undefined,
  github: GitHubRequestContext,
  allowAnonymous = false
): Promise<string | undefined> {
  if (!github.hasToken && !allowAnonymous) return undefined;
  try {
    const target = ref || 'HEAD';
    const response = await github.request(
      `https://api.github.com/repos/${owner}/${repo}/commits/${encodeURIComponent(target)}`
    );
    if (response.status !== 200) return undefined;
    const commit = parseFetchJson<{ sha?: string }>(response.body);
    return typeof commit.sha === 'string' ? commit.sha : undefined;
  } catch {
    return undefined;
  }
}

export function formatProvenance(provenance: UpskillProvenance): string {
  let output = `Installed from: ${provenance.kind}:${provenance.source}\n`;
  if (provenance.ref) output += `Ref: ${provenance.ref}\n`;
  if (provenance.path) output += `Upstream path: ${provenance.path}\n`;
  if (provenance.sha) output += `Commit: ${provenance.sha}\n`;
  output += `Installed at: ${provenance.installed}\n`;
  return output;
}
