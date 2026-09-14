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
  /**
   * ISO-8601 timestamp of the last install or update — i.e. when this record
   * was written, which is what "how current is this skill" actually asks.
   */
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
    // `record` is spread FIRST. Update callers pass `{ ...provenance, … }`,
    // which still carries the on-disk `version` and `installed`; spreading it
    // last would let a stale record veto both stamps — pinning `installed` to
    // the original install forever and making `PROVENANCE_VERSION` unable to
    // migrate an existing file, which is the one job a version field has.
    // (Excess-property checking does not catch this: the fields arrive via a
    // spread, so `Omit<…, 'version' | 'installed'>` cannot reject them.)
    const full: UpskillProvenance = {
      ...record,
      version: PROVENANCE_VERSION,
      installed: new Date().toISOString(),
    };
    await fs.writeFile(provenancePath(skillName), `${JSON.stringify(full, null, 2)}\n`);
  } catch {
    /* best-effort */
  }
}

export interface SkillProvenanceScan {
  /** Installed skills carrying a provenance record, name-sorted. */
  provenanced: Array<{ name: string; provenance: UpskillProvenance }>;
  /**
   * Installed skills with no readable record, name-sorted. Runtime-bundled
   * skills legitimately land here; so does anything hand-installed. Reported
   * rather than dropped, so a no-argument `upskill update` cannot claim to have
   * checked a skill it never looked at.
   */
  unattributed: string[];
}

/** Partition the installed skills by whether they carry a provenance record. */
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

/** Every installed skill that carries a provenance record, name-sorted. */
export async function listProvenancedSkills(
  fs: VirtualFS
): Promise<Array<{ name: string; provenance: UpskillProvenance }>> {
  return (await scanSkillProvenance(fs)).provenanced;
}

/**
 * Resolve a ref (and optional repo-relative `path`) to its commit sha.
 *
 * With `path`, this is the latest commit that touched that path — the value
 * `navigate·upskill` compares against the recorded install sha, so a skill
 * whose files have not moved does not raise a card when a sibling path did.
 * Without `path`, this is the ref's head.
 *
 * `upskill update` and install provenance both pass `allowAnonymous`: one
 * ~200-byte commits response is what makes "already current" exact. The
 * Contents API stays off the zip install path; this lookup is bookkeeping.
 */
export async function resolveCommitSha(
  owner: string,
  repo: string,
  ref: string | undefined,
  github: GitHubRequestContext,
  allowAnonymous = false,
  path?: string
): Promise<string | undefined> {
  if (!github.hasToken && !allowAnonymous) return undefined;
  try {
    const target = ref || 'HEAD';
    const normalizedPath = path?.replace(/^\/+|\/+$/g, '');
    if (normalizedPath) {
      const params = new URLSearchParams({
        path: normalizedPath,
        sha: target,
        per_page: '1',
      });
      const response = await github.request(
        `https://api.github.com/repos/${owner}/${repo}/commits?${params.toString()}`
      );
      if (response.status !== 200) return undefined;
      const commits = parseFetchJson<Array<{ sha?: string }>>(response.body);
      const sha = Array.isArray(commits) ? commits[0]?.sha : undefined;
      return typeof sha === 'string' ? sha : undefined;
    }
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
