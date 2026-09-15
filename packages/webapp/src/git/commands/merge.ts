/** `git merge` and its error formatter. */

import * as git from 'isomorphic-git';
import { parseArgs } from '../../shell/arg-parser.js';
import { makeMergeDriver } from './merge-driver.js';
import { clearMergeState, mergeInProgress, writeMergeState, writeOrigHead } from './merge-state.js';
import { tryResolveRevision } from './revision.js';
import { GIT_FLAG_SPECS, rejectUnknownGitFlags } from './shared.js';
import type { GitCommandContext, GitCommandResult } from './types.js';

/** Coerce an mri flag value (string | string[] | undefined) to a string[]. */
function asStringArray(value: unknown): string[] {
  if (value === undefined) return [];
  return (Array.isArray(value) ? value : [value]).map((v) => String(v));
}

function mergeFlags(
  parsed: ReturnType<typeof parseArgs>,
  args: string[]
): {
  noFf: boolean;
  ffOnly: boolean;
  favor: 'ours' | 'theirs' | 'union' | undefined;
  diff3: boolean;
} {
  let favor: 'ours' | 'theirs' | 'union' | undefined;
  let diff3 = false;
  for (const opt of asStringArray(parsed.flags['strategy-option'])) {
    if (opt === 'ours' || opt === 'theirs' || opt === 'union') favor = opt;
    else if (opt === 'diff3') diff3 = true;
  }
  return {
    noFf: parsed.flags.ff === false || args.includes('--no-ff'),
    ffOnly: parsed.flags['ff-only'] === true || args.includes('--ff-only'),
    favor,
    diff3,
  };
}

export async function merge(
  ctx: GitCommandContext,
  cwd: string,
  args: string[]
): Promise<GitCommandResult> {
  const unknown = rejectUnknownGitFlags(args, GIT_FLAG_SPECS.merge);
  if (unknown) return unknown;

  const parsed = parseArgs(args, GIT_FLAG_SPECS.merge);
  if (parsed.flags.abort === true) return abortMerge(ctx, cwd);

  const theirs = parsed.positionals[0];
  if (!theirs) {
    return {
      stdout: '',
      stderr: 'fatal: No branch specified to merge.\n',
      exitCode: 128,
    };
  }

  if (await mergeInProgress(ctx, cwd)) {
    return {
      stdout: '',
      stderr:
        'fatal: You have not concluded your merge (MERGE_HEAD exists).\n' +
        'Please, commit your changes before you merge.\n',
      exitCode: 128,
    };
  }

  const resolvedTheirs = await tryResolveRevision(ctx, cwd, theirs);
  if (!resolvedTheirs) {
    return {
      stdout: '',
      stderr: `fatal: Could not find ${theirs}.\n`,
      exitCode: 128,
    };
  }

  const { noFf, ffOnly, favor, diff3 } = mergeFlags(parsed, args);

  try {
    const ourOid = await git.resolveRef({ fs: ctx.lfs, dir: cwd, ref: 'HEAD' });
    await writeOrigHead(ctx, cwd, ourOid);

    const result = await git.merge({
      fs: ctx.lfs,
      cache: ctx.cache,
      dir: cwd,
      ours: (await git.currentBranch({ fs: ctx.lfs, dir: cwd })) ?? undefined,
      theirs: resolvedTheirs,
      fastForward: !noFf,
      fastForwardOnly: ffOnly,
      author: await ctx.resolveAuthor(cwd),
      abortOnConflict: false,
      mergeDriver: makeMergeDriver({ favor, diff3 }),
    });

    if (result.alreadyMerged) {
      return { stdout: 'Already up to date.\n', stderr: '', exitCode: 0 };
    }

    if (result.fastForward) {
      // Fast-forward: update the working directory to match the new HEAD
      await git.checkout({
        fs: ctx.lfs,
        cache: ctx.cache,
        dir: cwd,
        ref: (await git.currentBranch({ fs: ctx.lfs, dir: cwd })) ?? 'HEAD',
      });
      return {
        stdout: `Updating..${result.oid ? result.oid.slice(0, 7) : ''}\nFast-forward\n`,
        stderr: '',
        exitCode: 0,
      };
    }

    if (result.mergeCommit) {
      // Merge commit created. isomorphic-git staged the merged blobs into the
      // index (stage 0) but left the working tree on the pre-merge "ours"
      // content, so a plain checkout would see the file as locally modified and
      // skip it. `force` syncs the working tree to the merge result.
      await git.checkout({
        fs: ctx.lfs,
        cache: ctx.cache,
        dir: cwd,
        ref: (await git.currentBranch({ fs: ctx.lfs, dir: cwd })) ?? 'HEAD',
        force: true,
      });
      return {
        stdout: `Merge made by the 'ort' strategy.\n`,
        stderr: '',
        exitCode: 0,
      };
    }

    return { stdout: 'Merge complete.\n', stderr: '', exitCode: 0 };
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'MergeConflictError') {
      const branch = (await git.currentBranch({ fs: ctx.lfs, dir: cwd })) ?? 'HEAD';
      await writeMergeState(ctx, cwd, resolvedTheirs, `Merge branch '${theirs}' into ${branch}`);
    }
    return handleMergeError(err);
  }
}

/** `git merge --abort` — restore pre-merge HEAD and drop merge state. */
async function abortMerge(ctx: GitCommandContext, cwd: string): Promise<GitCommandResult> {
  if (!(await mergeInProgress(ctx, cwd))) {
    return {
      stdout: '',
      stderr: 'fatal: There is no merge to abort (MERGE_HEAD missing).\n',
      exitCode: 128,
    };
  }
  try {
    await git.abortMerge({ fs: ctx.lfs, cache: ctx.cache, dir: cwd, commit: 'HEAD' });
  } catch {
    // Index may already match HEAD; still restore the worktree and drop MERGE_HEAD.
  }
  await git.checkout({
    fs: ctx.lfs,
    cache: ctx.cache,
    dir: cwd,
    ref: (await git.currentBranch({ fs: ctx.lfs, dir: cwd })) ?? 'HEAD',
    force: true,
  });
  await clearMergeState(ctx, cwd);
  return { stdout: '', stderr: '', exitCode: 0 };
}

/** Handle merge errors and return appropriate GitCommandResult, or rethrow. */
function handleMergeError(err: unknown): GitCommandResult {
  if (err instanceof Error && err.name === 'MergeConflictError') {
    // abortOnConflict:false already wrote conflict markers + a conflicted index;
    // report each file the way real git does and exit 1 (a conflicted merge is
    // an expected outcome, not a fatal 128).
    const data = (err as Error & { data?: { filepaths?: string[] } }).data;
    const files = data?.filepaths ?? [];
    const stdout = files.map((f) => `CONFLICT (content): Merge conflict in ${f}\n`).join('');
    return {
      stdout,
      stderr: 'Automatic merge failed; fix conflicts and then commit the result.\n',
      exitCode: 1,
    };
  }
  if (err instanceof Error && err.name === 'MergeNotSupportedError') {
    return {
      stdout: '',
      stderr: 'fatal: merge is not possible because you have unmerged files.\n',
      exitCode: 128,
    };
  }
  if (err instanceof Error && err.name === 'FastForwardError') {
    return {
      stdout: '',
      stderr: 'fatal: Not possible to fast-forward, aborting.\n',
      exitCode: 128,
    };
  }
  throw err;
}
