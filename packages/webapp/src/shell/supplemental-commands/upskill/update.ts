/**
 * upskill — `update` / `upgrade` / `outdated` subcommands.
 *
 * Refreshes an installed skill from its recorded `.upskill` provenance instead
 * of making the caller re-type the original install command with `--force`.
 *
 * Per-path classification reuses the `upgrade` command's vocabulary so the two
 * commands read as one system:
 *
 *   `unchanged`   local bytes already match upstream
 *   `updated`     upstream bytes differ; the local file is replaced
 *   `added`       upstream ships a file the skill directory did not have
 *   `removed`     upstream no longer ships a file the skill directory has
 *   `kept-local`  a protected dotfile upstream would otherwise clobber or delete
 *
 * `--dry-run` computes the exact same plan and writes nothing at all.
 */

import type { SecureFetch } from 'just-bash';
import type { VirtualFS } from '../../../fs/index.js';
import { isSafeUpskillBranch, isSafeUpskillPath } from '../../../net/handoff-link.js';
import { createGitHubRequestContext } from './github/github-auth.js';
import { fetchRepoZip, stripZipPrefix } from './github/github-zip.js';
import { runPostInstallHooks } from './install-pipeline.js';
import type { UpskillProvenance } from './provenance.js';
import {
  isDotPath,
  listInstalledSkillDirs,
  listSkillFiles,
  PROVENANCE_FILE,
  readProvenance,
  resolveCommitSha,
  skillDir,
  writeProvenance,
} from './provenance.js';

export const UPDATE_CLASSIFICATIONS = [
  'unchanged',
  'updated',
  'added',
  'removed',
  'kept-local',
] as const;

export type UpdateClassification = (typeof UPDATE_CLASSIFICATIONS)[number];

interface PathPlan {
  path: string;
  classification: UpdateClassification;
  content?: Uint8Array;
}

type SkillOutcome =
  | { skill: string; state: 'already-current'; sha?: string }
  | { skill: string; state: 'updated'; sha?: string; plans: PathPlan[] }
  | { skill: string; state: 'planned'; sha?: string; plans: PathPlan[] }
  | { skill: string; state: 'no-provenance' }
  | { skill: string; state: 'unsupported'; reason: string }
  | { skill: string; state: 'error'; reason: string };

export interface ParsedUpdateArgs {
  skills: string[];
  dryRun: boolean;
  branch?: string;
  /** `<owner>/<repo>` supplied for a skill that has no recorded provenance. */
  from?: string;
  /** Repo-relative skill directory, paired with `--from`. */
  path?: string;
  error?: string;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

async function readLocalBytes(fs: VirtualFS, path: string): Promise<Uint8Array | undefined> {
  try {
    const value = await fs.readFile(path, { encoding: 'binary' });
    return value instanceof Uint8Array ? value : new TextEncoder().encode(String(value));
  } catch {
    return undefined;
  }
}

/**
 * Collect the upstream file set for a skill from an already-stripped ZIP.
 *
 * `.upskill` is filtered out unconditionally: it is upskill's own bookkeeping,
 * so an upstream copy must never masquerade as provenance for a local install.
 */
function upstreamFiles(
  files: Record<string, Uint8Array>,
  skillPath: string
): Map<string, Uint8Array> {
  const normalized = skillPath.replace(/^\/|\/$/g, '');
  const prefix = normalized ? `${normalized}/` : '';
  const out = new Map<string, Uint8Array>();
  for (const [path, content] of Object.entries(files)) {
    if (!path.startsWith(prefix)) continue;
    const relative = path.slice(prefix.length);
    if (!relative || path.endsWith('/')) continue;
    if (relative.split('/').includes('..') || relative.startsWith('/')) continue;
    if (relative === PROVENANCE_FILE) continue;
    out.set(relative, content);
  }
  return out;
}

async function buildPlans(
  fs: VirtualFS,
  dir: string,
  upstream: Map<string, Uint8Array>
): Promise<PathPlan[]> {
  const localPaths = await listSkillFiles(fs, dir);
  const plans: PathPlan[] = [];

  for (const [relative, content] of upstream) {
    const local = await readLocalBytes(fs, `${dir}/${relative}`);
    if (local === undefined) {
      plans.push({ path: relative, classification: 'added', content });
      continue;
    }
    if (bytesEqual(local, content)) {
      plans.push({ path: relative, classification: 'unchanged' });
      continue;
    }
    // Protected: an existing dotfile is never overwritten, however far the
    // upstream copy has moved on. `.config` credentials live here.
    plans.push({
      path: relative,
      classification: isDotPath(relative) ? 'kept-local' : 'updated',
      ...(isDotPath(relative) ? {} : { content }),
    });
  }

  for (const relative of localPaths) {
    if (upstream.has(relative)) continue;
    if (relative === PROVENANCE_FILE) continue;
    // Protected: an existing dotfile is never deleted either.
    plans.push({
      path: relative,
      classification: isDotPath(relative) ? 'kept-local' : 'removed',
    });
  }

  return plans.sort((a, b) => a.path.localeCompare(b.path));
}

async function commitPlans(fs: VirtualFS, dir: string, plans: PathPlan[]): Promise<void> {
  for (const plan of plans) {
    if (plan.classification === 'added' || plan.classification === 'updated') {
      const target = `${dir}/${plan.path}`;
      const parent = target.slice(0, target.lastIndexOf('/'));
      if (parent && parent !== dir) await fs.mkdir(parent, { recursive: true });
      await fs.writeFile(target, plan.content as Uint8Array);
    } else if (plan.classification === 'removed') {
      await fs.rm(`${dir}/${plan.path}`).catch(() => {});
    }
  }
}

function hasWrites(plans: PathPlan[]): boolean {
  return plans.some((plan) => plan.classification !== 'unchanged');
}

/**
 * Update (or plan an update for) a single skill from its recorded provenance.
 */
async function updateOneSkill(
  fs: VirtualFS,
  fetchFn: SecureFetch,
  skill: string,
  options: { dryRun: boolean; branch?: string; override?: UpskillProvenance }
): Promise<SkillOutcome> {
  const provenance = options.override ?? (await readProvenance(fs, skill));
  if (!provenance) return { skill, state: 'no-provenance' };
  if (provenance.kind === 'browse.sh') {
    return {
      skill,
      state: 'unsupported',
      reason: `installed from browse.sh (${provenance.slug ?? 'unknown slug'}) — refresh with: upskill browse:${provenance.slug ?? '<hostname>/<task>'} --force`,
    };
  }
  if (!provenance.owner || !provenance.repo) {
    return { skill, state: 'unsupported', reason: 'recorded source has no owner/repo' };
  }

  const { owner, repo } = provenance;
  const ref = options.branch ?? provenance.ref;
  const github = await createGitHubRequestContext(fetchFn);
  const headSha = await resolveCommitSha(owner, repo, ref, github);

  // Fast path: the recorded sha still matches the tip of the tracked ref, so
  // there is nothing upstream to compare against. Only valid when the ref was
  // not overridden — a different ref means a different tree.
  if (
    options.branch === undefined &&
    headSha !== undefined &&
    provenance.sha !== undefined &&
    headSha === provenance.sha
  ) {
    return { skill, state: 'already-current', sha: headSha };
  }

  const zip = await fetchRepoZip(owner, repo, fetchFn, ref);
  if (zip.status !== 'ok') {
    return { skill, state: 'error', reason: `failed to fetch ${owner}/${repo}: ${zip.message}` };
  }
  const upstream = upstreamFiles(stripZipPrefix(zip.files), provenance.path ?? '');
  if (upstream.size === 0) {
    return {
      skill,
      state: 'error',
      reason: `no files found at ${owner}/${repo}/${provenance.path ?? ''}`,
    };
  }

  const dir = skillDir(skill);
  const plans = await buildPlans(fs, dir, upstream);

  if (options.dryRun) return { skill, state: 'planned', sha: headSha, plans };

  if (!hasWrites(plans)) {
    // Content matches even though the sha moved (or was never recorded).
    // Refresh the record so the cheap sha check works next time.
    await writeProvenance(fs, skill, {
      ...provenance,
      version: 1,
      ref,
      sha: headSha,
      installedAt: new Date().toISOString(),
    });
    return { skill, state: 'already-current', sha: headSha };
  }

  await commitPlans(fs, dir, plans);
  await writeProvenance(fs, skill, {
    ...provenance,
    version: 1,
    ref,
    sha: headSha,
    installedAt: new Date().toISOString(),
  });
  return { skill, state: 'updated', sha: headSha, plans };
}

function formatPlans(plans: PathPlan[]): string {
  let out = '';
  for (const plan of plans) {
    if (plan.classification === 'unchanged') continue;
    out += `    ${plan.classification.padEnd(11)} ${plan.path}\n`;
  }
  const unchanged = plans.filter((p) => p.classification === 'unchanged').length;
  if (unchanged > 0) out += `    unchanged   (${unchanged} file(s))\n`;
  return out;
}

function shortSha(sha: string | undefined): string {
  return sha ? sha.slice(0, 7) : 'unknown';
}

function formatOutcome(outcome: SkillOutcome, dryRun: boolean): string {
  switch (outcome.state) {
    case 'already-current':
      return `  ${outcome.skill}: already current (${shortSha(outcome.sha)})\n`;
    case 'planned': {
      if (!hasWrites(outcome.plans)) {
        return `  ${outcome.skill}: already current (${shortSha(outcome.sha)})\n`;
      }
      return `  ${outcome.skill}: would update to ${shortSha(outcome.sha)}\n${formatPlans(outcome.plans)}`;
    }
    case 'updated':
      return `  ${outcome.skill}: updated to ${shortSha(outcome.sha)}\n${formatPlans(outcome.plans)}`;
    case 'no-provenance':
      return `  ${outcome.skill}: no recorded source — pass owner/repo once, e.g. upskill update ${outcome.skill} --from <owner>/<repo>${dryRun ? ' --dry-run' : ''}\n`;
    case 'unsupported':
      return `  ${outcome.skill}: skipped — ${outcome.reason}\n`;
    case 'error':
      return `  ${outcome.skill}: failed — ${outcome.reason}\n`;
  }
}

interface ValueFlag {
  field: 'branch' | 'from' | 'path';
  valid: (value: string) => boolean;
  error: string;
}

const BRANCH_FLAG: ValueFlag = {
  field: 'branch',
  // Same allowlist the install path uses — a ref spliced from an untrusted
  // source must not be able to smuggle shell metacharacters into a URL.
  valid: isSafeUpskillBranch,
  error: 'upskill: --branch requires a safe git ref value',
};
const PATH_FLAG: ValueFlag = {
  field: 'path',
  valid: isSafeUpskillPath,
  error: 'upskill: --path must be a repo-relative sub-path with no ".." or metacharacters',
};

/** Value-taking flags, keyed by spelling, so the parser stays a flat loop. */
const VALUE_FLAGS = new Map<string, ValueFlag>([
  ['--branch', BRANCH_FLAG],
  ['-b', BRANCH_FLAG],
  ['--path', PATH_FLAG],
  ['-p', PATH_FLAG],
  [
    '--from',
    {
      field: 'from',
      valid: (value) => !value.startsWith('-'),
      error: 'upskill: --from requires an <owner>/<repo> value',
    },
  ],
]);

/** Parse `update` / `upgrade` argv (everything after the subcommand word). */
export function parseUpdateArgs(args: string[]): ParsedUpdateArgs {
  const parsed: ParsedUpdateArgs = { skills: [], dryRun: false };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const flag = VALUE_FLAGS.get(arg);
    if (flag) {
      const value = args[i + 1];
      if (!value || !flag.valid(value)) return { ...parsed, error: flag.error };
      parsed[flag.field] = value;
      i += 1;
    } else if (arg === '--dry-run' || arg === '-n') {
      parsed.dryRun = true;
    } else if (arg.startsWith('-')) {
      return { ...parsed, error: `upskill: unknown option "${arg}" for update` };
    } else {
      parsed.skills.push(arg);
    }
  }
  return parsed;
}

/**
 * `upskill update [<skill>…] [--dry-run] [--branch <ref>] [--from <owner>/<repo>] [--path <dir>]`
 */
export async function handleUpskillUpdate(
  fs: VirtualFS,
  fetchFn: SecureFetch,
  parsed: ParsedUpdateArgs
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  if (parsed.error) return { stdout: '', stderr: `${parsed.error}\n`, exitCode: 1 };

  let targets = parsed.skills;
  if (targets.length === 0) {
    const installed = await listInstalledSkillDirs(fs);
    targets = [];
    for (const name of installed) {
      if (await readProvenance(fs, name)) targets.push(name);
    }
    if (targets.length === 0) {
      return {
        stdout:
          'No skills with a recorded install source found.\n\nProvenance is recorded at install time in `<skill>/.upskill`. For a skill installed\nbefore that existed, record it once: upskill update <skill> --from <owner>/<repo>\n',
        stderr: '',
        exitCode: 0,
      };
    }
  }

  let override: UpskillProvenance | undefined;
  if (parsed.from) {
    const match = parsed.from.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
    if (!match) {
      return {
        stdout: '',
        stderr: `upskill: --from must be <owner>/<repo>, got "${parsed.from}"\n`,
        exitCode: 1,
      };
    }
    if (targets.length !== 1) {
      return {
        stdout: '',
        stderr: 'upskill: --from applies to exactly one skill\n',
        exitCode: 1,
      };
    }
    override = {
      version: 1,
      kind: 'github',
      owner: match[1],
      repo: match[2],
      path: parsed.path ?? `skills/${targets[0]}`,
      ref: parsed.branch,
      installedAt: new Date().toISOString(),
    };
  }

  let stdout = parsed.dryRun
    ? 'upskill update --dry-run (no files written):\n'
    : 'upskill update:\n';
  let stderr = '';
  let failures = 0;
  let changed = 0;

  for (const skill of targets) {
    if (!(await fs.exists(skillDir(skill)))) {
      stderr += `upskill: skill "${skill}" is not installed in /workspace/skills\n`;
      failures += 1;
      continue;
    }
    const outcome = await updateOneSkill(fs, fetchFn, skill, {
      dryRun: parsed.dryRun,
      branch: parsed.branch,
      override,
    });
    stdout += formatOutcome(outcome, parsed.dryRun);
    if (outcome.state === 'error') failures += 1;
    if (outcome.state === 'updated') changed += 1;
  }

  if (changed > 0) await runPostInstallHooks();

  return { stdout, stderr, exitCode: failures > 0 ? 1 : 0 };
}

/** `upskill outdated` — list installed skills whose recorded sha is behind. */
export async function handleUpskillOutdated(
  fs: VirtualFS,
  fetchFn: SecureFetch
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const installed = await listInstalledSkillDirs(fs);
  const github = await createGitHubRequestContext(fetchFn);
  const rows: string[] = [];
  let tracked = 0;

  for (const skill of installed) {
    const provenance = await readProvenance(fs, skill);
    if (!provenance?.owner || !provenance.repo) continue;
    tracked += 1;
    const headSha = await resolveCommitSha(
      provenance.owner,
      provenance.repo,
      provenance.ref,
      github
    );
    if (!headSha) {
      rows.push(`  ${skill.padEnd(28)} ${provenance.owner}/${provenance.repo}  (ref unresolved)`);
      continue;
    }
    if (provenance.sha === headSha) continue;
    rows.push(
      `  ${skill.padEnd(28)} ${provenance.owner}/${provenance.repo}  ${shortSha(provenance.sha)} → ${shortSha(headSha)}`
    );
  }

  if (tracked === 0) {
    return {
      stdout:
        'No skills with a recorded install source found.\n\nProvenance is recorded at install time in `<skill>/.upskill`.\n',
      stderr: '',
      exitCode: 0,
    };
  }
  if (rows.length === 0) {
    return {
      stdout: `All ${tracked} tracked skill(s) are current.\n`,
      stderr: '',
      exitCode: 0,
    };
  }
  return {
    stdout: `Outdated skills:\n\n${rows.join('\n')}\n\nRefresh with: upskill update [<skill>] [--dry-run]\n`,
    stderr: '',
    exitCode: 0,
  };
}
