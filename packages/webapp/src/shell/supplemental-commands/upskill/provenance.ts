/**
 * upskill — install provenance (`.upskill`) plus the dotfile-protection rule.
 *
 * Two coupled concerns live here because neither works without the other:
 *
 * 1. **Provenance.** `upskill update` needs to know where a skill came from.
 *    `upskill info` only ever reported the discovery *root kind* (`native`,
 *    `.agents`, …), never the origin, so a refresh required the caller to
 *    remember the repo, ref and sub-path. Installs now drop a `.upskill` JSON
 *    file in the skill directory recording the source kind, coordinates, the
 *    ref and the *resolved commit sha* — the sha is what makes "already
 *    current" a single API call instead of a whole-tree diff.
 *
 * 2. **Dotfile protection.** A skill's credentials live in a dotfile inside its
 *    own directory (`scripts/.config` for the `bb`, `gmail` and `fastly`
 *    skills), and the pre-existing `--force` path did `rm -rf` on the skill
 *    directory, so refreshing a skill silently revoked its credentials. The
 *    same `rm -rf` would also delete `.upskill`, i.e. the provenance file is
 *    destroyed by the very command that has to read it. Hence the rule:
 *
 *      **upskill never overwrites and never deletes a dotfile that already
 *      exists in a skill directory.**
 *
 *    Creating a dotfile that is *absent* locally is still allowed — some skills
 *    legitimately ship `.gitignore` / `.config.example` upstream, and a
 *    literal "never write a dotfile" would make those files uninstallable.
 *    Creation cannot destroy anything; overwriting and deleting can.
 */

import type { FileContent, VirtualFS } from '../../../fs/index.js';
import { parseFetchJson } from '../../fetch-body.js';
import type { GitHubRequestContext } from './types.js';
import { SKILLS_DIR } from './types.js';

/** Filename of the per-skill provenance record, relative to the skill dir. */
export const PROVENANCE_FILE = '.upskill';

/** Where a skill was installed from. */
export type UpskillSourceKind = 'github' | 'tessl' | 'browse.sh';

export interface UpskillProvenance {
  /** Record format version, so a future reader can migrate rather than guess. */
  version: 1;
  kind: UpskillSourceKind;
  /** GitHub owner — set for `github` and `tessl` (Tessl resolves to a repo). */
  owner?: string;
  /** GitHub repo name. */
  repo?: string;
  /** Repo-relative directory the skill was installed from. */
  path?: string;
  /** The ref requested at install time (branch/tag). Undefined means default. */
  ref?: string;
  /** The commit sha `ref` resolved to, when it could be resolved. */
  sha?: string;
  /** `hostname/task` slug, for `browse.sh` installs. */
  slug?: string;
  /** ISO-8601 install (or last-update) timestamp. */
  installedAt: string;
}

/**
 * True when any segment of a skill-relative path starts with a dot.
 *
 * Segment-wise rather than basename-wise on purpose: `scripts/.config` is the
 * real credential path, and everything under a dot-directory (`.git/`) is just
 * as much "not upstream content we may clobber".
 */
export function isDotPath(relativePath: string): boolean {
  return relativePath.split('/').some((segment) => segment.startsWith('.'));
}

/** Absolute path of a skill's directory. */
export function skillDir(skillName: string): string {
  return `${SKILLS_DIR}/${skillName}`;
}

/** Read a skill's `.upskill` record, or null when absent/unparseable. */
export async function readProvenance(
  fs: VirtualFS,
  skillName: string
): Promise<UpskillProvenance | null> {
  try {
    const raw = await fs.readTextFile(`${skillDir(skillName)}/${PROVENANCE_FILE}`);
    const parsed = JSON.parse(raw) as UpskillProvenance;
    if (!parsed || typeof parsed !== 'object' || typeof parsed.kind !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Write a skill's `.upskill` record.
 *
 * `.upskill` is exempt from the dotfile rule above: upskill owns this file, it
 * is never sourced from upstream, and refusing to rewrite it would freeze the
 * recorded sha at its first value. Everything *else* dot-prefixed is protected.
 */
export async function writeProvenance(
  fs: VirtualFS,
  skillName: string,
  provenance: UpskillProvenance
): Promise<void> {
  const dir = skillDir(skillName);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(`${dir}/${PROVENANCE_FILE}`, `${JSON.stringify(provenance, null, 2)}\n`);
}

/** Best-effort `.upskill` write — install success must not hinge on this. */
export async function recordProvenance(
  fs: VirtualFS,
  skillName: string,
  provenance: Omit<UpskillProvenance, 'version' | 'installedAt'>
): Promise<void> {
  try {
    await writeProvenance(fs, skillName, {
      version: 1,
      ...provenance,
      installedAt: new Date().toISOString(),
    });
  } catch {
    /* best-effort — never fail an otherwise successful install */
  }
}

/**
 * Resolve a ref to a commit sha via the GitHub commits API.
 *
 * Best-effort: returns undefined on any failure. A missing sha only costs the
 * next `update` a full tree comparison, it does not break it.
 */
export async function resolveCommitSha(
  owner: string,
  repo: string,
  ref: string | undefined,
  github: GitHubRequestContext
): Promise<string | undefined> {
  const target = ref && ref.length > 0 ? ref : 'HEAD';
  try {
    const url = `https://api.github.com/repos/${owner}/${repo}/commits/${encodeURIComponent(target)}`;
    const response = await github.request(url);
    if (response.status !== 200) return undefined;
    const body = parseFetchJson<{ sha?: string }>(response.body);
    return typeof body.sha === 'string' && body.sha.length > 0 ? body.sha : undefined;
  } catch {
    return undefined;
  }
}

/** List installed skill directory names under `/workspace/skills`. */
export async function listInstalledSkillDirs(fs: VirtualFS): Promise<string[]> {
  try {
    const entries = await fs.readDir(SKILLS_DIR);
    return entries
      .filter((entry) => entry.type === 'directory' && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * Recursively collect skill-relative paths of every regular file in a skill
 * directory. Dot segments are included — callers need to *see* them in order to
 * classify them as protected.
 */
export async function listSkillFiles(fs: VirtualFS, dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(current: string, prefix: string): Promise<void> {
    let entries: Awaited<ReturnType<VirtualFS['readDir']>>;
    try {
      entries = await fs.readDir(current);
    } catch {
      return;
    }
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.type === 'directory') {
        await walk(`${current}/${entry.name}`, relative);
      } else {
        out.push(relative);
      }
    }
  }
  await walk(dir, '');
  return out.sort();
}

/**
 * Delete every *non-dot* file in a skill directory, leaving dotfiles (and
 * anything under a dot-directory) in place. Used instead of `rm -rf` when
 * replacing an existing skill so credentials and provenance survive.
 */
export async function pruneSkillDirPreservingDotfiles(fs: VirtualFS, dir: string): Promise<void> {
  for (const relative of await listSkillFiles(fs, dir)) {
    if (isDotPath(relative)) continue;
    await fs.rm(`${dir}/${relative}`).catch(() => {});
  }
}

/**
 * Write an upstream file into a skill directory, honouring the dotfile rule.
 *
 * Returns `'written'` when the bytes landed and `'kept-local'` when the target
 * is an existing dotfile that must not be clobbered.
 */
export async function writeSkillFileGuarded(
  fs: VirtualFS,
  dir: string,
  relativePath: string,
  content: FileContent
): Promise<'written' | 'kept-local'> {
  const target = `${dir}/${relativePath}`;
  if (isDotPath(relativePath) && (await fs.exists(target))) return 'kept-local';
  const parent = target.slice(0, target.lastIndexOf('/'));
  if (parent && parent !== dir) await fs.mkdir(parent, { recursive: true });
  await fs.writeFile(target, content);
  return 'written';
}
