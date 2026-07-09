/**
 * `git rebase <upstream>` — replay the linear range `upstream..HEAD` onto
 * `<upstream>` as a sequence of conflict-aware cherry-picks, plus a
 * `--continue` / `--abort` / `--skip` state machine.
 *
 * There is no native isomorphic-git rebase, so this composes lower-level APIs:
 * `findMergeBase` + `log` compute the range, then each commit is replayed with
 * native `cherryPick` through the shared `makeMergeDriver` (author preserved,
 * committer refreshed — exactly the cherry-pick path). A divergent overlap
 * stops the replay with standard markers (exit 1); the remaining todo, the
 * stopped commit, the onto target, and the original HEAD are persisted under
 * `.git/rebase-merge/` so a later invocation can resume, skip, or abort.
 * Interactive rebase, `--onto`, `--rebase-merges`, autosquash, and rebasing
 * merge commits are out of scope and rejected clearly.
 */

import * as git from 'isomorphic-git';
import { parseArgs } from '../../shell/arg-parser.js';
import { makeMergeDriver } from './merge-driver.js';
import { expandGitError, GIT_FLAG_SPECS } from './shared.js';
import type { GitCommandContext, GitCommandResult } from './types.js';

/** Coerce an mri flag value (string | string[] | undefined) to a string[]. */
function asStringArray(value: unknown): string[] {
  if (value === undefined) return [];
  return (Array.isArray(value) ? value : [value]).map((v) => String(v));
}

interface RebaseState {
  onto: string;
  origHead: string;
  headName: string;
  branch: string;
  current?: string;
  todo: string[];
  favor?: 'ours' | 'theirs' | 'union';
  diff3?: boolean;
}

const STATE_SUBDIR = '.git/rebase-merge';

export async function rebase(
  ctx: GitCommandContext,
  cwd: string,
  args: string[]
): Promise<GitCommandResult> {
  const { flags, positionals } = parseArgs(args, GIT_FLAG_SPECS.rebase);

  for (const unsupported of ['interactive', 'onto', 'rebase-merges', 'autosquash'] as const) {
    if (flags[unsupported]) {
      return {
        stdout: '',
        stderr: `fatal: git rebase --${unsupported} is not supported\n`,
        exitCode: 128,
      };
    }
  }

  try {
    if (flags.abort) return await abortRebase(ctx, cwd);
    if (flags.continue) return await continueRebase(ctx, cwd);
    if (flags.skip) return await skipRebase(ctx, cwd);
    return await startRebase(ctx, cwd, positionals[0], flags);
  } catch (err: unknown) {
    return { stdout: '', stderr: `fatal: ${expandGitError(err)}\n`, exitCode: 128 };
  }
}

/** Begin a fresh rebase of the current branch onto `<upstream>`. */
async function startRebase(
  ctx: GitCommandContext,
  cwd: string,
  upstream: string | undefined,
  flags: Record<string, unknown>
): Promise<GitCommandResult> {
  if (!upstream) {
    return { stdout: '', stderr: 'fatal: No upstream specified.\n', exitCode: 128 };
  }
  if (await stateExists(ctx, cwd)) {
    return {
      stdout: '',
      stderr:
        'fatal: It seems that there is already a rebase-merge directory,\nand I wonder if you are in the middle of another rebase.\n',
      exitCode: 128,
    };
  }

  const branch = await git.currentBranch({ fs: ctx.lfs, dir: cwd });
  if (!branch) {
    return { stdout: '', stderr: 'fatal: no such branch/commit (detached HEAD)\n', exitCode: 128 };
  }

  const ontoOid = await resolveCommit(ctx, cwd, upstream);
  if (!ontoOid) {
    return { stdout: '', stderr: `fatal: invalid upstream '${upstream}'\n`, exitCode: 128 };
  }
  const headOid = await git.resolveRef({ fs: ctx.lfs, dir: cwd, ref: 'HEAD' });

  // Native git refuses to rebase over uncommitted work; do the same before any
  // ref/working-tree mutation (both the fast-forward and replay paths below
  // force-checkout, which would silently clobber tracked edits). Autostash is
  // out of scope.
  const dirty = await assertCleanWorktree(ctx, cwd);
  if (dirty) return dirty;

  const [mergeBase] = await git.findMergeBase({ fs: ctx.lfs, dir: cwd, oids: [headOid, ontoOid] });

  if (mergeBase === headOid) {
    await resetHard(ctx, cwd, branch, ontoOid);
    return {
      stdout: `Fast-forwarded ${branch} to ${upstream}.\n`,
      stderr: '',
      exitCode: 0,
    };
  }
  if (mergeBase === ontoOid) {
    return { stdout: `Current branch ${branch} is up to date.\n`, stderr: '', exitCode: 0 };
  }

  const entries = await collectRange(ctx, cwd, headOid, mergeBase);
  const mergeCommit = entries.find((e) => e.parents > 1);
  if (mergeCommit) {
    return {
      stdout: '',
      stderr: `error: commit ${mergeCommit.oid} is a merge but no -m option was given.\nfatal: rebase failed\n`,
      exitCode: 128,
    };
  }

  // -X/--strategy-option → merge-driver favor + diff3 knobs (mirrors merge.ts).
  let favor: 'ours' | 'theirs' | 'union' | undefined;
  let diff3 = false;
  for (const opt of asStringArray(flags['strategy-option'])) {
    if (opt === 'ours' || opt === 'theirs' || opt === 'union') favor = opt;
    else if (opt === 'diff3') diff3 = true;
  }

  await resetHard(ctx, cwd, branch, ontoOid);
  const state: RebaseState = {
    onto: ontoOid,
    origHead: headOid,
    headName: `refs/heads/${branch}`,
    branch,
    todo: entries.map((e) => e.oid),
    favor,
    diff3,
  };
  return replay(ctx, cwd, state);
}

/** Resume after conflict resolution: commit the stopped commit, replay the rest. */
async function continueRebase(ctx: GitCommandContext, cwd: string): Promise<GitCommandResult> {
  const state = await readState(ctx, cwd);
  if (!state) return noRebaseInProgress();

  if (state.current) {
    const { commit } = await git.readCommit({ fs: ctx.lfs, dir: cwd, oid: state.current });
    await git.commit({
      fs: ctx.lfs,
      dir: cwd,
      message: commit.message,
      author: commit.author,
      committer: await ctx.resolveAuthor(cwd),
    });
    state.current = undefined;
  }
  return replay(ctx, cwd, state);
}

/** Drop the stopped commit and replay the rest. */
async function skipRebase(ctx: GitCommandContext, cwd: string): Promise<GitCommandResult> {
  const state = await readState(ctx, cwd);
  if (!state) return noRebaseInProgress();
  // Discard the conflicted working tree + index back to the current tip.
  await git.checkout({ fs: ctx.lfs, dir: cwd, ref: state.branch, force: true });
  state.current = undefined;
  return replay(ctx, cwd, state);
}

/** Restore the original branch tip and clear the rebase state. */
async function abortRebase(ctx: GitCommandContext, cwd: string): Promise<GitCommandResult> {
  const state = await readState(ctx, cwd);
  if (!state) return noRebaseInProgress();
  await resetHard(ctx, cwd, state.branch, state.origHead);
  await clearState(ctx, cwd);
  return { stdout: '', stderr: '', exitCode: 0 };
}

/**
 * Replay `state.todo` (oldest first) via `cherryPick`. On conflict, persist the
 * stopped commit + remaining todo and return git-style status (exit 1). On
 * completion, clear the state and report success.
 */
async function replay(
  ctx: GitCommandContext,
  cwd: string,
  state: RebaseState
): Promise<GitCommandResult> {
  while (state.todo.length > 0) {
    const oid = state.todo[0];
    const { commit } = await git.readCommit({ fs: ctx.lfs, dir: cwd, oid });
    const subject = commit.message.split('\n')[0];
    try {
      await git.cherryPick({
        fs: ctx.lfs,
        dir: cwd,
        oid,
        abortOnConflict: false,
        committer: await ctx.resolveAuthor(cwd),
        mergeDriver: makeMergeDriver({ favor: state.favor, diff3: state.diff3 }),
      });
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'MergeConflictError') {
        const files = (err as Error & { data?: { filepaths?: string[] } }).data?.filepaths ?? [];
        state.current = oid;
        state.todo = state.todo.slice(1);
        await writeState(ctx, cwd, state);
        return conflictResult(oid, subject, files);
      }
      throw err;
    }
    state.todo = state.todo.slice(1);
  }
  await clearState(ctx, cwd);
  return {
    stdout: `Successfully rebased and updated ${state.headName}.\n`,
    stderr: '',
    exitCode: 0,
  };
}

/** Format the "stopped on conflict" status the way real git rebase does. */
function conflictResult(oid: string, subject: string, files: string[]): GitCommandResult {
  const short = oid.slice(0, 7);
  let out = '';
  for (const f of files) out += `CONFLICT (content): Merge conflict in ${f}\n`;
  out += `error: could not apply ${short}... ${subject}\n`;
  out += 'hint: Resolve all conflicts manually, mark them as resolved with\n';
  out += 'hint: "git add/rm <conflicted_files>", then run "git rebase --continue".\n';
  out += 'hint: You can instead skip this commit: run "git rebase --skip".\n';
  out +=
    'hint: To abort and get back to the state before "git rebase", run "git rebase --abort".\n';
  return { stdout: '', stderr: out, exitCode: 1 };
}

function noRebaseInProgress(): GitCommandResult {
  return { stdout: '', stderr: 'fatal: No rebase in progress?\n', exitCode: 128 };
}

/** Resolve `<upstream>` to a full oid (ref first, then short/full oid). */
async function resolveCommit(
  ctx: GitCommandContext,
  cwd: string,
  ref: string
): Promise<string | undefined> {
  try {
    return await git.resolveRef({ fs: ctx.lfs, dir: cwd, ref });
  } catch {
    try {
      return await git.expandOid({ fs: ctx.lfs, dir: cwd, oid: ref });
    } catch {
      return undefined;
    }
  }
}

/**
 * Collect the commits reachable from `headOid` but not `baseOid`, oldest first.
 * `parents` is carried so the caller can reject merge commits before replaying.
 */
async function collectRange(
  ctx: GitCommandContext,
  cwd: string,
  headOid: string,
  baseOid: string
): Promise<Array<{ oid: string; parents: number }>> {
  const log = await git.log({ fs: ctx.lfs, dir: cwd, ref: headOid });
  const out: Array<{ oid: string; parents: number }> = [];
  for (const entry of log) {
    if (entry.oid === baseOid) break;
    out.push({ oid: entry.oid, parents: entry.commit.parent.length });
  }
  return out.reverse();
}

/**
 * Refuse a fresh rebase when the working tree or index carries tracked changes,
 * matching native git (which will not rebase over uncommitted work). Each
 * `statusMatrix` row is `[filepath, head, workdir, stage]`; purely untracked new
 * files (`head === 0 && stage === 0`) are allowed, exactly as native git does.
 * Returns a git-style error result to abort with, or `undefined` when clean.
 */
async function assertCleanWorktree(
  ctx: GitCommandContext,
  cwd: string
): Promise<GitCommandResult | undefined> {
  const matrix = await git.statusMatrix({ fs: ctx.lfs, dir: cwd });
  let hasUnstaged = false;
  let hasStaged = false;
  for (const [, head, workdir, stage] of matrix) {
    if (head === 0 && stage === 0) continue; // untracked new file — allowed
    if (workdir !== stage) hasUnstaged = true;
    else if (head !== stage) hasStaged = true;
  }
  if (hasUnstaged) {
    return {
      stdout: '',
      stderr:
        'error: cannot rebase: You have unstaged changes.\nerror: Please commit or stash them.\n',
      exitCode: 128,
    };
  }
  if (hasStaged) {
    return {
      stdout: '',
      stderr:
        'error: cannot rebase: Your index contains uncommitted changes.\nerror: Please commit or stash them.\n',
      exitCode: 128,
    };
  }
  return undefined;
}

/** Point `<branch>` at `oid` and sync the index + working tree to it. */
async function resetHard(
  ctx: GitCommandContext,
  cwd: string,
  branch: string,
  oid: string
): Promise<void> {
  await git.writeRef({
    fs: ctx.lfs,
    dir: cwd,
    ref: `refs/heads/${branch}`,
    value: oid,
    force: true,
  });
  await git.checkout({ fs: ctx.lfs, dir: cwd, ref: branch, force: true });
}

/** Whether a rebase state directory is present. */
async function stateExists(ctx: GitCommandContext, cwd: string): Promise<boolean> {
  return ctx.fs.exists(`${cwd}/${STATE_SUBDIR}/onto`);
}

/** Read a single state file, trimmed, or undefined when absent. */
async function readStateFile(
  ctx: GitCommandContext,
  cwd: string,
  name: string
): Promise<string | undefined> {
  try {
    return (await ctx.fs.readTextFile(`${cwd}/${STATE_SUBDIR}/${name}`)).trim();
  } catch {
    return undefined;
  }
}

/** Rebuild the in-memory state from `.git/rebase-merge/`. */
async function readState(ctx: GitCommandContext, cwd: string): Promise<RebaseState | undefined> {
  const onto = await readStateFile(ctx, cwd, 'onto');
  const origHead = await readStateFile(ctx, cwd, 'orig-head');
  const headName = await readStateFile(ctx, cwd, 'head-name');
  if (!onto || !origHead || !headName) return undefined;
  const todoRaw = (await readStateFile(ctx, cwd, 'git-rebase-todo')) ?? '';
  const todo = todoRaw
    .split('\n')
    .map((line) => line.replace(/^pick\s+/, '').trim())
    .filter((line) => line.length > 0);
  const optsRaw = (await readStateFile(ctx, cwd, 'strategy-opts')) ?? '';
  let favor: 'ours' | 'theirs' | 'union' | undefined;
  let diff3 = false;
  for (const opt of optsRaw.split(/\s+/).filter((o) => o.length > 0)) {
    if (opt === 'ours' || opt === 'theirs' || opt === 'union') favor = opt;
    else if (opt === 'diff3') diff3 = true;
  }
  return {
    onto,
    origHead,
    headName,
    branch: headName.replace(/^refs\/heads\//, ''),
    current: await readStateFile(ctx, cwd, 'stopped-sha'),
    todo,
    favor,
    diff3,
  };
}

/** Persist the state to `.git/rebase-merge/`. */
async function writeState(ctx: GitCommandContext, cwd: string, state: RebaseState): Promise<void> {
  const dir = `${cwd}/${STATE_SUBDIR}`;
  await ctx.fs.mkdir(dir, { recursive: true });
  await ctx.fs.writeFile(`${dir}/onto`, `${state.onto}\n`);
  await ctx.fs.writeFile(`${dir}/orig-head`, `${state.origHead}\n`);
  await ctx.fs.writeFile(`${dir}/head-name`, `${state.headName}\n`);
  await ctx.fs.writeFile(
    `${dir}/git-rebase-todo`,
    `${state.todo.map((oid) => `pick ${oid}`).join('\n')}\n`
  );
  if (state.current) await ctx.fs.writeFile(`${dir}/stopped-sha`, `${state.current}\n`);
  else await removeIfPresent(ctx, `${dir}/stopped-sha`);
  const opts: string[] = [];
  if (state.favor) opts.push(state.favor);
  if (state.diff3) opts.push('diff3');
  if (opts.length > 0) await ctx.fs.writeFile(`${dir}/strategy-opts`, `${opts.join(' ')}\n`);
  else await removeIfPresent(ctx, `${dir}/strategy-opts`);
}

/** Delete the whole rebase state directory. */
async function clearState(ctx: GitCommandContext, cwd: string): Promise<void> {
  try {
    await ctx.fs.rm(`${cwd}/${STATE_SUBDIR}`, { recursive: true });
  } catch {
    /* nothing to clear */
  }
}

async function removeIfPresent(ctx: GitCommandContext, path: string): Promise<void> {
  try {
    await ctx.fs.rm(path);
  } catch {
    /* already absent */
  }
}
