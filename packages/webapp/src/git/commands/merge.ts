import * as git from 'isomorphic-git';
import { parseArgs } from '../../shell/arg-parser.js';
import { makeMergeDriver } from './merge-driver.js';
import { GIT_FLAG_SPECS } from './shared.js';
import type { GitCommandContext, GitCommandResult } from './types.js';

function asStringArray(value: unknown): string[] {
  if (value === undefined) return [];
  return (Array.isArray(value) ? value : [value]).map((v) => String(v));
}

export async function merge(
  ctx: GitCommandContext,
  cwd: string,
  args: string[]
): Promise<GitCommandResult> {
  const noFf = args.includes('--no-ff');
  const ffOnly = args.includes('--ff-only');
  const parsed = parseArgs(args, GIT_FLAG_SPECS.merge);
  const theirs = parsed.positionals[0];

  if (!theirs) {
    return {
      stdout: '',
      stderr: 'fatal: No branch specified to merge.\n',
      exitCode: 128,
    };
  }

  let favor: 'ours' | 'theirs' | 'union' | undefined;
  let diff3 = false;
  for (const opt of asStringArray(parsed.flags['strategy-option'])) {
    if (opt === 'ours' || opt === 'theirs' || opt === 'union') favor = opt;
    else if (opt === 'diff3') diff3 = true;
  }

  try {
    const result = await git.merge({
      fs: ctx.lfs,
      cache: ctx.cache,
      dir: cwd,
      ours: (await git.currentBranch({ fs: ctx.lfs, dir: cwd })) ?? undefined,
      theirs,
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
    return handleMergeError(err);
  }
}

function handleMergeError(err: unknown): GitCommandResult {
  if (err instanceof Error && err.name === 'MergeConflictError') {
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
