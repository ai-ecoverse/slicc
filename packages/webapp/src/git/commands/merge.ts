/** `git merge` and its error formatter. */

import * as git from 'isomorphic-git';
import type { GitCommandContext, GitCommandResult } from './types.js';

export async function merge(
  ctx: GitCommandContext,
  cwd: string,
  args: string[]
): Promise<GitCommandResult> {
  const noFf = args.includes('--no-ff');
  const ffOnly = args.includes('--ff-only');
  const theirs = args.find((a) => !a.startsWith('-'));

  if (!theirs) {
    return {
      stdout: '',
      stderr: 'fatal: No branch specified to merge.\n',
      exitCode: 128,
    };
  }

  try {
    const result = await git.merge({
      fs: ctx.lfs,
      dir: cwd,
      ours: (await git.currentBranch({ fs: ctx.lfs, dir: cwd })) ?? undefined,
      theirs,
      fastForward: !noFf,
      fastForwardOnly: ffOnly,
      author: await ctx.resolveAuthor(cwd),
      abortOnConflict: true,
    });

    if (result.alreadyMerged) {
      return { stdout: 'Already up to date.\n', stderr: '', exitCode: 0 };
    }

    if (result.fastForward) {
      // Fast-forward: update the working directory to match the new HEAD
      await git.checkout({
        fs: ctx.lfs,
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
      // Merge commit created — checkout the working directory
      await git.checkout({
        fs: ctx.lfs,
        dir: cwd,
        ref: (await git.currentBranch({ fs: ctx.lfs, dir: cwd })) ?? 'HEAD',
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

/** Handle merge errors and return appropriate GitCommandResult, or rethrow. */
function handleMergeError(err: unknown): GitCommandResult {
  if (err instanceof Error && err.name === 'MergeConflictError') {
    const data = (err as Error & { data?: { filepaths?: string[] } }).data;
    const files = data?.filepaths ?? [];
    let output = 'Auto-merging failed. Fix conflicts and then commit the result.\n';
    if (files.length > 0) {
      output += 'CONFLICT (content): Merge conflict in:\n';
      for (const f of files) {
        output += `  ${f}\n`;
      }
    }
    return { stdout: '', stderr: output, exitCode: 1 };
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
