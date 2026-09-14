import type { SecureFetch } from 'just-bash';
import type { VirtualFS } from '../../../fs/index.js';
import { isSafeUpskillBranch, isSafeUpskillPath } from '../../../net/handoff-link.js';
import { hasDotSegment, listSkillFiles } from './dotfiles.js';
import { createGitHubRequestContext } from './github/github-auth.js';
import { parseGitHubRef } from './github/github-install.js';
import { fetchGitHubDirFiles, fetchRepoZip, stripZipPrefix } from './github/github-zip.js';
import { runPostInstallHooks } from './install-pipeline.js';
import type { UpskillProvenance } from './provenance.js';
import {
  readProvenance,
  resolveCommitSha,
  scanSkillProvenance,
  writeProvenance,
} from './provenance.js';
import { prepareBrowseShSkill, stripBrowseShPreamble } from './registries/browse-sh.js';
import { isSafeSkillRelativePath } from './skill-paths.js';
import type { GitHubRequestContext } from './types.js';
import { SKILLS_DIR } from './types.js';

export type UpdateStatus = 'unchanged' | 'updated' | 'added' | 'removed' | 'kept-local';

export interface UpdateChange {
  path: string;
  status: UpdateStatus;
}

export interface SkillUpdateResult {
  skill: string;
  source: string;
  ref?: string;

  from?: string;

  to?: string;

  outcome: 'current' | 'updated' | 'error';
  changes: UpdateChange[];
  error?: string;
}

interface ParsedUpdateArgs {
  skills: string[];
  dryRun: boolean;
  branch?: string;

  from?: string;

  path?: string;
  json: boolean;
  error?: string;
}

const UPDATE_VALUE_FLAGS: Array<{
  names: string[];
  validate: (value: string) => boolean;
  error: string;
  apply: (parsed: ParsedUpdateArgs, value: string) => void;
}> = [
  {
    names: ['--branch', '-b'],
    validate: (value) => !value.startsWith('-') && isSafeUpskillBranch(value),
    error:
      'upskill: --branch must be a git ref of [A-Za-z0-9._/-]+ with no "..", leading "-"/"/", trailing "/" or ".lock", or shell metacharacters',
    apply: (parsed, value) => {
      parsed.branch = value;
    },
  },
  {
    names: ['--from'],
    validate: (value) => parseGitHubRef(value) !== null,
    error:
      'upskill: --from requires a GitHub source (owner/repo, owner/repo@branch, or a github.com URL)',
    apply: (parsed, value) => {
      parsed.from = value;
    },
  },
  {
    names: ['--path', '-p'],
    validate: (value) => isSafeUpskillPath(value),
    error:
      'upskill: --path must be a repo-relative sub-path of [A-Za-z0-9._/-]+ with no "..", leading "-"/"/", or shell metacharacters',
    apply: (parsed, value) => {
      parsed.path = value;
    },
  },
];

function parseUpdateArgs(args: string[]): ParsedUpdateArgs {
  const parsed: ParsedUpdateArgs = { skills: [], dryRun: false, json: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const flag = UPDATE_VALUE_FLAGS.find((candidate) => candidate.names.includes(arg));
    if (flag) {
      const value = args[++i];
      if (!value || !flag.validate(value)) {
        parsed.error = flag.error;
        return parsed;
      }
      flag.apply(parsed, value);
    } else if (arg === '--dry-run' || arg === '-n') {
      parsed.dryRun = true;
    } else if (arg === '--json') {
      parsed.json = true;
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

async function classifyUpstream(
  fs: VirtualFS,
  target: string,
  relative: string,
  content: Uint8Array
): Promise<{ status: UpdateStatus; write: boolean }> {
  const local = await readLocal(fs, target);

  if (hasDotSegment(relative)) {
    return local ? { status: 'kept-local', write: false } : { status: 'added', write: true };
  }
  if (!local) return { status: 'added', write: true };
  if (bytesEqual(local, content)) return { status: 'unchanged', write: false };
  return { status: 'updated', write: true };
}

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

  const headSha = await resolveCommitSha(owner, repo, base.ref, github, true);
  if (
    headSha &&
    provenance.sha === headSha &&
    (await recordedFilesPresent(fs, skill, provenance))
  ) {
    return { ...base, to: headSha, outcome: 'current', changes: [] };
  }

  const fetched = await fetchUpstream(owner, repo, upstreamPath, skill, base.ref, fetchFn, github);
  if ('error' in fetched) {
    return { ...base, outcome: 'error', error: fetched.error };
  }
  const upstream = fetched.files;

  const resolvedPath = fetched.path;
  if (upstream.size === 0) {
    return {
      ...base,
      outcome: 'error',
      error: `no files at ${owner}/${repo}${resolvedPath ? `/${resolvedPath}` : ''} — the skill may have moved or been removed upstream`,
    };
  }

  const destDir = `${SKILLS_DIR}/${skill}`;
  const { changes, writes, removals } = await planUpdate(fs, destDir, upstream, provenance);
  const changed = writes.length > 0 || removals.length > 0;
  if (dryRun) {
    return { ...base, outcome: changed ? 'updated' : 'current', changes };
  }

  const sha = headSha ?? provenance.sha;
  if (changed) await applyPlan(fs, { changes, writes, removals });

  await writeProvenance(fs, skill, {
    ...provenance,
    ref: base.ref,
    path: resolvedPath,
    sha,
    files: [...upstream.keys()].sort(),
  });
  return { ...base, to: sha, outcome: changed ? 'updated' : 'current', changes };
}

async function recordedFilesPresent(
  fs: VirtualFS,
  skill: string,
  provenance: UpskillProvenance
): Promise<boolean> {
  if (!provenance.files?.length) return false;
  for (const relative of provenance.files) {
    if (!(await fs.exists(`${SKILLS_DIR}/${skill}/${relative}`))) return false;
  }
  return true;
}

async function fetchUpstream(
  owner: string,
  repo: string,
  upstreamPath: string,
  skill: string,
  ref: string | undefined,
  fetchFn: SecureFetch,
  github: GitHubRequestContext
): Promise<{ files: Map<string, Uint8Array>; path: string } | { error: string }> {
  const zip = await fetchRepoZip(owner, repo, fetchFn, ref ?? 'main');
  if (zip.status === 'ok') {
    const files = stripZipPrefix(zip.files);

    const path = upstreamPath || discoverSkillPath(files, skill);
    if (path === null) {
      return {
        error: `could not find "${skill}/SKILL.md" in ${owner}/${repo} — pass --path <dir> to say where the skill lives`,
      };
    }
    return { files: upstreamFiles(files, path), path };
  }
  try {
    const files = await fetchGitHubDirFiles(owner, repo, upstreamPath, ref, github);
    return { files: sortByPath(onlySafePaths(files)), path: upstreamPath };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: `${zip.message}; Contents API fallback failed: ${message}` };
  }
}

export function discoverSkillPath(files: Record<string, Uint8Array>, skill: string): string | null {
  const candidates: string[] = [];
  for (const path of Object.keys(files)) {
    if (path === 'SKILL.md') candidates.push('');
    else if (path.endsWith(`/${skill}/SKILL.md`) || path === `${skill}/SKILL.md`) {
      candidates.push(path.slice(0, -'/SKILL.md'.length));
    }
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
  return candidates[0];
}

function onlySafePaths(files: Map<string, Uint8Array>): Map<string, Uint8Array> {
  return new Map([...files].filter(([path]) => isSafeSkillRelativePath(path)));
}

function sortByPath(files: Map<string, Uint8Array>): Map<string, Uint8Array> {
  return new Map([...files].sort(([a], [b]) => a.localeCompare(b)));
}

function upstreamFiles(
  files: Record<string, Uint8Array>,
  upstreamPath: string
): Map<string, Uint8Array> {
  const prefix = upstreamPath ? `${upstreamPath}/` : '';
  const upstream = new Map<string, Uint8Array>();
  for (const [path, content] of Object.entries(files)) {
    if (!path.startsWith(prefix) || path.endsWith('/')) continue;
    const relative = path.slice(prefix.length);

    if (!isSafeSkillRelativePath(relative)) continue;
    upstream.set(relative, content);
  }
  return sortByPath(upstream);
}

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

  const sameBody =
    local !== undefined &&
    stripBrowseShPreamble(new TextDecoder().decode(local)) ===
      stripBrowseShPreamble(prepared.content);
  if (bytesEqual(local, content) || sameBody) {
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

function provenanceFromFlag(
  skill: string,
  from: string,
  path: string | undefined,
  branch: string | undefined
): UpskillProvenance | null {
  const ref = parseGitHubRef(from);
  if (!ref) return null;
  return {
    version: 1,
    kind: 'github',
    source: `${ref.owner}/${ref.repo}`,
    skill,
    ref: branch ?? ref.branch,
    path: path ?? ref.path,
    installed: new Date().toISOString(),
  };
}

async function resolveTargets(
  fs: VirtualFS,
  names: string[],
  parsed: ParsedUpdateArgs
): Promise<{
  targets: Array<{ name: string; provenance: UpskillProvenance }>;
  missing: Array<{ name: string; reason: 'not-installed' | 'no-provenance' }>;
  skipped: string[];
}> {
  if (names.length === 0) {
    const scan = await scanSkillProvenance(fs);
    return { targets: scan.provenanced, missing: [], skipped: scan.unattributed };
  }
  const targets: Array<{ name: string; provenance: UpskillProvenance }> = [];
  const missing: Array<{ name: string; reason: 'not-installed' | 'no-provenance' }> = [];
  for (const name of names) {
    const provenance = await readProvenance(fs, name);
    if (provenance) {
      targets.push({ name, provenance });
      continue;
    }
    if (!(await fs.exists(`${SKILLS_DIR}/${name}`))) {
      missing.push({ name, reason: 'not-installed' });
      continue;
    }

    const supplied = parsed.from
      ? provenanceFromFlag(name, parsed.from, parsed.path, parsed.branch)
      : null;
    if (supplied) targets.push({ name, provenance: supplied });
    else missing.push({ name, reason: 'no-provenance' });
  }
  return { targets, missing, skipped: [] };
}

function missingMessage(entry: { name: string; reason: string }): string {
  if (entry.reason === 'not-installed') {
    return `upskill: no skill named "${entry.name}" is installed — check \`upskill list\`
`;
  }
  return `upskill: no install provenance for "${entry.name}" — re-run with --from <owner>/<repo> (optionally --path <dir>) to record its source, or reinstall it once
`;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function formatSkipped(skipped: string[]): string {
  return (
    `\nSkipped ${plural(skipped.length, 'skill')} with no install provenance — not checked:\n` +
    `  ${skipped.join(', ')}\n` +
    '  Runtime-bundled skills have no record by design; `upgrade apply` keeps those current.\n' +
    '  For the rest, record a source once with `upskill update <skill> --from <owner>/<repo> --dry-run`,\n' +
    '  after which a bare `upskill update` sweeps them too.\n'
  );
}

function formatReport(
  results: SkillUpdateResult[],
  dryRun: boolean,
  applied: boolean,
  clean: boolean,
  skipped: string[]
): string {
  let stdout = dryRun ? 'Skill update (dry run — nothing written):\n' : 'Skill update:\n';
  for (const result of results) stdout += formatResult(result, dryRun);
  if (skipped.length > 0) stdout += formatSkipped(skipped);
  if (!applied && clean && results.length > 0) {
    const scope =
      skipped.length > 0
        ? `all ${plural(results.length, 'skill')} with provenance ${results.length === 1 ? 'is' : 'are'}`
        : 'all skills are';
    stdout += dryRun
      ? `\n${scope.charAt(0).toUpperCase()}${scope.slice(1)} current.\n`
      : `\nNothing to update — ${scope} current.\n`;
  }
  return stdout;
}

export interface SkillUpdateRequest {
  skills: string[];
  dryRun: boolean;
  branch?: string;
  from?: string;
  path?: string;
}

export async function collectSkillUpdateResults(
  fs: VirtualFS,
  fetchFn: SecureFetch,
  parsed: SkillUpdateRequest
): Promise<{
  results: SkillUpdateResult[];
  skipped: string[];
  missing: Array<{ name: string; reason: 'not-installed' | 'no-provenance' }>;
}> {
  const { targets, missing, skipped } = await resolveTargets(fs, parsed.skills, {
    skills: parsed.skills,
    dryRun: parsed.dryRun,
    json: false,
    branch: parsed.branch,
    from: parsed.from,
    path: parsed.path,
  });
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
  return { results, skipped, missing };
}

export async function handleUpskillUpdate(
  args: string[],
  fs: VirtualFS,
  fetchFn: SecureFetch
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const parsed = parseUpdateArgs(args);
  if (parsed.error) {
    return { stdout: '', stderr: `${parsed.error}\n`, exitCode: 1 };
  }

  const { results, missing, skipped } = await collectSkillUpdateResults(fs, fetchFn, parsed);

  if (results.length === 0) {
    if (missing.length === 0 && skipped.length > 0) {
      return {
        stdout: parsed.json
          ? `${JSON.stringify({ ok: true, dryRun: parsed.dryRun, results: [], skipped })}\n`
          : formatReport([], parsed.dryRun, false, true, skipped),
        stderr: '',
        exitCode: 0,
      };
    }
    const stderr = missing.length
      ? missing.map(missingMessage).join('')
      : 'upskill: no skill has install provenance yet — reinstall a skill, or run `upskill update <skill> --from <owner>/<repo>`, to record its source\n';
    return { stdout: '', stderr, exitCode: 1 };
  }

  const failures = results.filter((r) => r.outcome === 'error');
  const applied = results.some((r) => r.outcome === 'updated');
  if (applied && !parsed.dryRun) {
    await runPostInstallHooks();
  }

  const stderr =
    missing.map(missingMessage).join('') +
    failures.map((r) => `upskill: ${r.skill}: ${r.error}\n`).join('');

  const clean = failures.length === 0 && missing.length === 0;
  if (parsed.json) {
    return {
      stdout: `${JSON.stringify({ ok: clean, dryRun: parsed.dryRun, results, skipped })}\n`,
      stderr,
      exitCode: clean ? 0 : 1,
    };
  }

  return {
    stdout: formatReport(results, parsed.dryRun, applied, clean, skipped),
    stderr,
    exitCode: clean ? 0 : 1,
  };
}
