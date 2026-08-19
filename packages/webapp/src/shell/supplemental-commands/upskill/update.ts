/**
 * upskill — `update` / `upgrade` subcommand.
 *
 * Refreshes an installed skill from the source recorded in its `.upskill`
 * provenance file, so refreshing no longer means "remember the repo and run
 * `--force`" (which deleted the skill's credentials along with its files).
 *
 * Every path is classified with the same vocabulary `upgrade apply` uses for
 * bundled workspace files — `unchanged`, `updated`, `added`, `removed`,
 * `kept-local` — so the two commands read as one system. `--dry-run` reports
 * the classification and writes nothing.
 */

import type { SecureFetch } from 'just-bash';
import type { VirtualFS } from '../../../fs/index.js';
import { isSafeUpskillBranch } from '../../../net/handoff-link.js';
import { hasDotSegment, listSkillFiles } from './dotfiles.js';
import { createGitHubRequestContext } from './github/github-auth.js';
import { fetchGitHubDirFiles, fetchRepoZip, stripZipPrefix } from './github/github-zip.js';
import { runPostInstallHooks } from './install-pipeline.js';
import type { UpskillProvenance } from './provenance.js';
import {
  listProvenancedSkills,
  readProvenance,
  resolveCommitSha,
  writeProvenance,
} from './provenance.js';
import { prepareBrowseShSkill } from './registries/browse-sh.js';
import type { GitHubRequestContext } from './types.js';
import { SKILLS_DIR } from './types.js';

/** Per-path outcome. Mirrors `upgrade apply`'s classification vocabulary. */
export type UpdateStatus = 'unchanged' | 'updated' | 'added' | 'removed' | 'kept-local';

export interface UpdateChange {
  path: string;
  status: UpdateStatus;
}

export interface SkillUpdateResult {
  skill: string;
  source: string;
  ref?: string;
  /** Recorded commit sha before the update. */
  from?: string;
  /** Resolved commit sha after the update. */
  to?: string;
  /** `current` when nothing upstream differs; `error` when the refresh failed. */
  outcome: 'current' | 'updated' | 'error';
  changes: UpdateChange[];
  error?: string;
}

interface ParsedUpdateArgs {
  skills: string[];
  dryRun: boolean;
  branch?: string;
  json: boolean;
  error?: string;
}

function parseUpdateArgs(args: string[]): ParsedUpdateArgs {
  const parsed: ParsedUpdateArgs = { skills: [], dryRun: false, json: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--dry-run' || arg === '-n') {
      parsed.dryRun = true;
    } else if (arg === '--json') {
      parsed.json = true;
    } else if (arg === '--branch' || arg === '-b') {
      const value = args[++i];
      if (!value || value.startsWith('-') || !isSafeUpskillBranch(value)) {
        parsed.error =
          'upskill: --branch must be a git ref of [A-Za-z0-9._/-]+ with no "..", leading "-"/"/", trailing "/" or ".lock", or shell metacharacters';
        return parsed;
      }
      parsed.branch = value;
    } else if (arg.startsWith('-')) {
      parsed.error = `upskill: unknown option "${arg}" for update`;
      return parsed;
    } else {
      parsed.skills.push(arg);
    }
  }
  return parsed;
}

function bytesEqual(a: Uint8Array | undefined, b: Uint8Array | undefined): boolean {
  if (!a || !b || a.byteLength !== b.byteLength) return false;
  return a.every((byte, index) => byte === b[index]);
}

async function readLocal(fs: VirtualFS, path: string): Promise<Uint8Array | undefined> {
  try {
    const value = await fs.readFile(path, { encoding: 'binary' });
    return value instanceof Uint8Array ? value : new TextEncoder().encode(String(value));
  } catch {
    return undefined;
  }
}

interface UpdatePlan {
  changes: UpdateChange[];
  writes: Array<{ path: string; content: Uint8Array }>;
  removals: string[];
}

/** Classify one upstream path against what is on disk. */
async function classifyUpstream(
  fs: VirtualFS,
  target: string,
  relative: string,
  content: Uint8Array
): Promise<{ status: UpdateStatus; write: boolean }> {
  const local = await readLocal(fs, target);
  // Dotfiles are never modified after first install — they carry the skill's
  // credentials and its provenance record.
  if (hasDotSegment(relative)) {
    return local ? { status: 'kept-local', write: false } : { status: 'added', write: true };
  }
  if (!local) return { status: 'added', write: true };
  if (bytesEqual(local, content)) return { status: 'unchanged', write: false };
  return { status: 'updated', write: true };
}

/**
 * Classify every upstream and local path without writing anything. `--dry-run`
 * stops here; a real update replays the plan.
 */
async function planUpdate(
  fs: VirtualFS,
  destDir: string,
  upstream: Map<string, Uint8Array>,
  provenance: UpskillProvenance
): Promise<UpdatePlan> {
  const plan: UpdatePlan = { changes: [], writes: [], removals: [] };

  for (const [relative, content] of upstream) {
    const target = `${destDir}/${relative}`;
    const { status, write } = await classifyUpstream(fs, target, relative, content);
    plan.changes.push({ path: relative, status });
    if (write) plan.writes.push({ path: target, content });
  }

  // Local files upstream no longer ships. Only files this command previously
  // installed are removable — anything the user added is kept, since nothing
  // records it as ours.
  const managed = new Set(provenance.files ?? []);
  for (const relative of await listSkillFiles(fs, destDir)) {
    if (upstream.has(relative)) continue;
    const removable = managed.has(relative);
    plan.changes.push({ path: relative, status: removable ? 'removed' : 'kept-local' });
    if (removable) plan.removals.push(`${destDir}/${relative}`);
  }

  plan.changes.sort((a, b) => a.path.localeCompare(b.path));
  return plan;
}

/**
 * Plan a GitHub-sourced skill refresh, then apply it unless `dryRun`.
 */
async function updateGitHubSkill(
  fs: VirtualFS,
  fetchFn: SecureFetch,
  skill: string,
  provenance: UpskillProvenance,
  branchOverride: string | undefined,
  dryRun: boolean
): Promise<SkillUpdateResult> {
  const base: SkillUpdateResult = {
    skill,
    source: `${provenance.kind}:${provenance.source}`,
    ref: branchOverride ?? provenance.ref,
    from: provenance.sha,
    outcome: 'current',
    changes: [],
  };
  const [owner, repo] = provenance.source.split('/');
  if (!owner || !repo) {
    return { ...base, outcome: 'error', error: `unusable source "${provenance.source}"` };
  }

  const upstreamPath = (provenance.path ?? '').replace(/^\/|\/$/g, '');
  const github = await createGitHubRequestContext(fetchFn);
  const fetched = await fetchUpstream(owner, repo, upstreamPath, base.ref, fetchFn, github);
  if ('error' in fetched) {
    return { ...base, outcome: 'error', error: fetched.error };
  }
  const upstream = fetched.files;
  if (upstream.size === 0) {
    return {
      ...base,
      outcome: 'error',
      error: `no files at ${owner}/${repo}${upstreamPath ? `/${upstreamPath}` : ''} — the skill may have moved or been removed upstream`,
    };
  }

  const destDir = `${SKILLS_DIR}/${skill}`;
  const { changes, writes, removals } = await planUpdate(fs, destDir, upstream, provenance);
  const changed = writes.length > 0 || removals.length > 0;
  if (dryRun) {
    return { ...base, outcome: changed ? 'updated' : 'current', changes };
  }

  const sha = (await resolveCommitSha(owner, repo, base.ref, github)) ?? provenance.sha;
  if (changed) await applyPlan(fs, { changes, writes, removals });
  // The provenance record is refreshed either way, so an unchanged run still
  // moves the sha forward and the next one can report an exact "already current".
  await writeProvenance(fs, skill, {
    ...provenance,
    ref: base.ref,
    sha,
    files: [...upstream.keys()].sort(),
  });
  return { ...base, to: sha, outcome: changed ? 'updated' : 'current', changes };
}

/**
 * Read the upstream skill directory: codeload ZIP first (not rate-limited),
 * falling back to the authenticated Contents API. The fallback matters because
 * the install path has one too — a private repo, or one whose default branch
 * is neither `main` nor `master`, installs fine through the API and would
 * otherwise be permanently un-updatable.
 */
async function fetchUpstream(
  owner: string,
  repo: string,
  upstreamPath: string,
  ref: string | undefined,
  fetchFn: SecureFetch,
  github: GitHubRequestContext
): Promise<{ files: Map<string, Uint8Array> } | { error: string }> {
  const zip = await fetchRepoZip(owner, repo, fetchFn, ref ?? 'main');
  if (zip.status === 'ok') {
    return { files: upstreamFiles(stripZipPrefix(zip.files), upstreamPath) };
  }
  try {
    const files = await fetchGitHubDirFiles(owner, repo, upstreamPath, ref, github);
    return { files: sortByPath(files) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: `${zip.message}; Contents API fallback failed: ${message}` };
  }
}

/** Stable path order, so reports and provenance file lists are deterministic. */
function sortByPath(files: Map<string, Uint8Array>): Map<string, Uint8Array> {
  return new Map([...files].sort(([a], [b]) => a.localeCompare(b)));
}

/** Select the ZIP entries under `upstreamPath`, keyed by skill-relative path. */
function upstreamFiles(
  files: Record<string, Uint8Array>,
  upstreamPath: string
): Map<string, Uint8Array> {
  const prefix = upstreamPath ? `${upstreamPath}/` : '';
  const upstream = new Map<string, Uint8Array>();
  for (const [path, content] of Object.entries(files)) {
    if (!path.startsWith(prefix) || path.endsWith('/')) continue;
    const relative = path.slice(prefix.length);
    if (relative) upstream.set(relative, content);
  }
  return sortByPath(upstream);
}

/** Replay a plan onto the VFS. */
async function applyPlan(fs: VirtualFS, plan: UpdatePlan): Promise<void> {
  for (const write of plan.writes) {
    const parent = write.path.slice(0, write.path.lastIndexOf('/'));
    await fs.mkdir(parent, { recursive: true });
    await fs.writeFile(write.path, write.content);
  }
  for (const removal of plan.removals) {
    await fs.rm(removal).catch(() => {});
  }
}

/** Refresh a browse.sh-sourced skill (a single generated `SKILL.md`). */
async function updateBrowseShSkill(
  fs: VirtualFS,
  fetchFn: SecureFetch,
  skill: string,
  provenance: UpskillProvenance,
  dryRun: boolean
): Promise<SkillUpdateResult> {
  const base: SkillUpdateResult = {
    skill,
    source: `${provenance.kind}:${provenance.source}`,
    outcome: 'current',
    changes: [],
  };
  const [hostname, task] = provenance.source.split('/');
  if (!hostname || !task) {
    return { ...base, outcome: 'error', error: `unusable source "${provenance.source}"` };
  }
  const prepared = await prepareBrowseShSkill(hostname, task, fetchFn);
  if (!prepared.ok) {
    return { ...base, outcome: 'error', error: prepared.error };
  }

  const target = `${SKILLS_DIR}/${skill}/SKILL.md`;
  const local = await readLocal(fs, target);
  const content = new TextEncoder().encode(prepared.content);
  if (bytesEqual(local, content)) {
    return { ...base, changes: [{ path: 'SKILL.md', status: 'unchanged' }] };
  }
  const status: UpdateStatus = local ? 'updated' : 'added';
  if (!dryRun) {
    await fs.mkdir(`${SKILLS_DIR}/${skill}`, { recursive: true });
    await fs.writeFile(target, content);
    await writeProvenance(fs, skill, { ...provenance, files: ['SKILL.md'] });
  }
  return { ...base, outcome: 'updated', changes: [{ path: 'SKILL.md', status }] };
}

function formatResult(result: SkillUpdateResult, dryRun: boolean): string {
  if (result.outcome === 'error') {
    return `  ${result.skill}: failed — ${result.error}\n`;
  }
  const counts = new Map<UpdateStatus, number>();
  for (const change of result.changes) {
    counts.set(change.status, (counts.get(change.status) ?? 0) + 1);
  }
  const shaSuffix = result.to && result.to !== result.from ? ` → ${result.to.slice(0, 7)}` : '';
  if (result.outcome === 'current') {
    return `  ${result.skill}: already current (${result.source}${shaSuffix})\n`;
  }
  const verb = dryRun ? 'would update' : 'updated';
  let output = `  ${result.skill}: ${verb} from ${result.source}${shaSuffix}\n`;
  for (const change of result.changes) {
    if (change.status === 'unchanged') continue;
    output += `      ${change.status.padEnd(10)} ${change.path}\n`;
  }
  const kept = counts.get('kept-local') ?? 0;
  if (kept > 0) {
    output += `      (${kept} kept-local — dotfiles and local additions are never touched)\n`;
  }
  return output;
}

/** Resolve the skills to update: named ones, or every skill with provenance. */
async function resolveTargets(
  fs: VirtualFS,
  names: string[]
): Promise<{ targets: Array<{ name: string; provenance: UpskillProvenance }>; missing: string[] }> {
  if (names.length === 0) {
    return { targets: await listProvenancedSkills(fs), missing: [] };
  }
  const targets: Array<{ name: string; provenance: UpskillProvenance }> = [];
  const missing: string[] = [];
  for (const name of names) {
    const provenance = await readProvenance(fs, name);
    if (provenance) targets.push({ name, provenance });
    else missing.push(name);
  }
  return { targets, missing };
}

/**
 * `clean` gates the closing line: with a failed or unresolvable skill in the
 * batch, "all skills are current" would contradict the errors on stderr and
 * the non-zero exit.
 */
function formatReport(
  results: SkillUpdateResult[],
  dryRun: boolean,
  applied: boolean,
  clean: boolean
): string {
  let stdout = dryRun ? 'Skill update (dry run — nothing written):\n' : 'Skill update:\n';
  for (const result of results) stdout += formatResult(result, dryRun);
  if (!applied && clean) {
    stdout += dryRun
      ? '\nAll skills are current.\n'
      : '\nNothing to update — all skills are current.\n';
  }
  return stdout;
}

/**
 * `upskill update|upgrade [<skill>…] [--dry-run] [--branch <ref>] [--json]`
 */
export async function handleUpskillUpdate(
  args: string[],
  fs: VirtualFS,
  fetchFn: SecureFetch
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const parsed = parseUpdateArgs(args);
  if (parsed.error) {
    return { stdout: '', stderr: `${parsed.error}\n`, exitCode: 1 };
  }

  const { targets, missing } = await resolveTargets(fs, parsed.skills);

  if (targets.length === 0) {
    const stderr = missing.length
      ? missing
          .map(
            (name) =>
              `upskill: no install provenance for "${name}" — reinstall it once (upskill <source> --skill ${name} --force) to record where it came from\n`
          )
          .join('')
      : 'upskill: no skill has install provenance yet — reinstall a skill to record its source\n';
    return { stdout: '', stderr, exitCode: 1 };
  }

  const results: SkillUpdateResult[] = [];
  for (const target of targets) {
    results.push(
      target.provenance.kind === 'browse.sh'
        ? await updateBrowseShSkill(fs, fetchFn, target.name, target.provenance, parsed.dryRun)
        : await updateGitHubSkill(
            fs,
            fetchFn,
            target.name,
            target.provenance,
            parsed.branch,
            parsed.dryRun
          )
    );
  }

  const failures = results.filter((r) => r.outcome === 'error');
  const applied = results.some((r) => r.outcome === 'updated');
  if (applied && !parsed.dryRun) {
    await runPostInstallHooks();
  }

  const stderr =
    missing
      .map(
        (name) =>
          `upskill: no install provenance for "${name}" — reinstall it once to record where it came from\n`
      )
      .join('') + failures.map((r) => `upskill: ${r.skill}: ${r.error}\n`).join('');

  const clean = failures.length === 0 && missing.length === 0;
  if (parsed.json) {
    return {
      stdout: `${JSON.stringify({ ok: clean, dryRun: parsed.dryRun, results })}\n`,
      stderr,
      exitCode: clean ? 0 : 1,
    };
  }

  return {
    stdout: formatReport(results, parsed.dryRun, applied, clean),
    stderr,
    exitCode: clean ? 0 : 1,
  };
}
