/**
 * upskill — install provenance (`.upskill`).
 *
 * Every successful install records where the skill came from so
 * `upskill update` needs no arguments and `upskill info` can name the source
 * repo instead of just the root kind. The record is a dotfile, so
 * `dotfiles.ts` preserves it across reinstalls — this module is the one writer
 * allowed to overwrite it.
 */

import type { VirtualFS } from '../../../fs/index.js';
import { parseFetchJson } from '../../fetch-body.js';
import type { GitHubRequestContext } from './types.js';
import { SKILLS_DIR } from './types.js';

export const PROVENANCE_FILE = '.upskill';
export const PROVENANCE_VERSION = 1;

export interface UpskillProvenance {
  version: number;
  /** Registry the skill was installed from. */
  kind: 'github' | 'browse.sh';
  /** `owner/repo` for GitHub, `hostname/task` for browse.sh. */
  source: string;
  /** Installed skill directory name (may differ from the upstream folder). */
  skill: string;
  /** Git ref the install resolved against (GitHub only). */
  ref?: string;
  /** Repo-relative directory the skill files came from (GitHub only). */
  path?: string;
  /** Resolved commit sha, when the API call succeeded. */
  sha?: string;
  /** ISO-8601 install timestamp. */
  installed: string;
  /** Skill-relative paths written by the install (dotfiles excluded). */
  files?: string[];
}

export function provenancePath(skillName: string): string {
  return `${SKILLS_DIR}/${skillName}/${PROVENANCE_FILE}`;
}

/** Read a skill's provenance record. Returns null when absent or unreadable. */
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

/**
 * Write a skill's provenance record. Best-effort: a failure here must never
 * fail an otherwise successful install.
 */
export async function writeProvenance(
  fs: VirtualFS,
  skillName: string,
  record: Omit<UpskillProvenance, 'version' | 'installed'> & { installed?: string }
): Promise<void> {
  try {
    const full: UpskillProvenance = {
      version: PROVENANCE_VERSION,
      installed: record.installed ?? new Date().toISOString(),
      ...record,
    };
    await fs.writeFile(provenancePath(skillName), `${JSON.stringify(full, null, 2)}\n`);
  } catch {
    /* best-effort */
  }
}

/** Every installed skill that carries a provenance record, name-sorted. */
export async function listProvenancedSkills(
  fs: VirtualFS
): Promise<Array<{ name: string; provenance: UpskillProvenance }>> {
  let entries: Array<{ name: string; type: 'file' | 'directory' }>;
  try {
    entries = (await fs.readDir(SKILLS_DIR)) as Array<{ name: string; type: 'file' | 'directory' }>;
  } catch {
    return [];
  }
  const found: Array<{ name: string; provenance: UpskillProvenance }> = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.type !== 'directory') continue;
    const provenance = await readProvenance(fs, entry.name);
    if (provenance) found.push({ name: entry.name, provenance });
  }
  return found;
}

/**
 * Resolve a ref to its commit sha, but only when a GitHub token is configured.
 *
 * The install path deliberately prefers codeload (not rate-limited) over the
 * API, so an anonymous install must not spend its one rate-limited request on
 * bookkeeping. Without a token the record simply carries no sha — `upskill
 * update` still classifies exactly, it just compares content instead of
 * short-circuiting on the sha.
 */
export async function resolveCommitSha(
  owner: string,
  repo: string,
  ref: string | undefined,
  github: GitHubRequestContext
): Promise<string | undefined> {
  if (!github.hasToken) return undefined;
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

/** Format a provenance record for `upskill info`. */
export function formatProvenance(provenance: UpskillProvenance): string {
  let output = `Installed from: ${provenance.kind}:${provenance.source}\n`;
  if (provenance.ref) output += `Ref: ${provenance.ref}\n`;
  if (provenance.path) output += `Upstream path: ${provenance.path}\n`;
  if (provenance.sha) output += `Commit: ${provenance.sha}\n`;
  output += `Installed at: ${provenance.installed}\n`;
  return output;
}
