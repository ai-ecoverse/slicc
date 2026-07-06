/** `git add` and its staging-mode helpers. */

import * as git from 'isomorphic-git';
import type { GitCommandContext, GitCommandResult } from './types.js';

export async function add(
  ctx: GitCommandContext,
  cwd: string,
  args: string[]
): Promise<GitCommandResult> {
  const allFlag = args.includes('-A') || args.includes('--all');
  const updateFlag = args.includes('-u') || args.includes('--update');
  const force = args.includes('-f') || args.includes('--force');

  // Filter out flags to get file paths
  const paths = args.filter((a) => !a.startsWith('-'));

  if (!allFlag && !updateFlag && paths.length === 0) {
    return {
      stdout: '',
      stderr: 'Nothing specified, nothing added.\n',
      exitCode: 0,
    };
  }

  if (allFlag) {
    await addAll(ctx, cwd, force);
  } else if (paths.includes('.')) {
    await addDot(ctx, cwd, force);
  } else if (updateFlag) {
    await addUpdate(ctx, cwd, force);
  } else {
    for (const filepath of paths) {
      await git.add({ fs: ctx.lfs, dir: cwd, filepath, force });
    }
  }

  return { stdout: '', stderr: '', exitCode: 0 };
}

/** Stage ALL changes (new, modified, deleted). */
async function addAll(ctx: GitCommandContext, cwd: string, force: boolean): Promise<void> {
  const matrix = await git.statusMatrix({ fs: ctx.lfs, dir: cwd });
  for (const [file, , workdir, stage] of matrix) {
    if (workdir === stage) continue;
    if (workdir === 0) {
      await git.remove({ fs: ctx.lfs, dir: cwd, filepath: file });
    } else {
      await git.add({ fs: ctx.lfs, dir: cwd, filepath: file, force });
    }
  }
}

/** Stage new and modified files, but NOT deletions (git add .). */
async function addDot(ctx: GitCommandContext, cwd: string, force: boolean): Promise<void> {
  const matrix = await git.statusMatrix({ fs: ctx.lfs, dir: cwd });
  for (const [file, , workdir, stage] of matrix) {
    if (workdir === stage) continue;
    if (workdir === 0) continue;
    await git.add({ fs: ctx.lfs, dir: cwd, filepath: file, force });
  }
}

/** Stage modifications and deletions of tracked files only (no new/untracked files). */
async function addUpdate(ctx: GitCommandContext, cwd: string, force: boolean): Promise<void> {
  const matrix = await git.statusMatrix({ fs: ctx.lfs, dir: cwd });
  for (const [file, head, workdir, stage] of matrix) {
    if (head === 0) continue;
    if (workdir === stage) continue;
    if (workdir === 0) {
      await git.remove({ fs: ctx.lfs, dir: cwd, filepath: file });
    } else {
      await git.add({ fs: ctx.lfs, dir: cwd, filepath: file, force });
    }
  }
}
