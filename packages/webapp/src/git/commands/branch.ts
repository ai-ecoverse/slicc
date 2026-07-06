/** `git branch` — list, create, or delete branches. */

import * as git from 'isomorphic-git';
import type { GitCommandContext, GitCommandResult } from './types.js';

export async function branch(
  ctx: GitCommandContext,
  cwd: string,
  args: string[]
): Promise<GitCommandResult> {
  const deleteFlag = args.includes('-d') || args.includes('-D') || args.includes('--delete');
  const listAll = args.includes('-a') || args.includes('--all');

  // Filter out flags to get branch name
  const branchName = args.find((a) => !a.startsWith('-'));

  if (deleteFlag && branchName) {
    await git.deleteBranch({ fs: ctx.lfs, dir: cwd, ref: branchName });
    return {
      stdout: `Deleted branch ${branchName}\n`,
      stderr: '',
      exitCode: 0,
    };
  }

  if (branchName && !deleteFlag) {
    // Create new branch
    await git.branch({ fs: ctx.lfs, dir: cwd, ref: branchName });
    return { stdout: '', stderr: '', exitCode: 0 };
  }

  // List branches
  const branches = await git.listBranches({ fs: ctx.lfs, dir: cwd });
  const current = await git.currentBranch({ fs: ctx.lfs, dir: cwd });

  let output = '';
  for (const branch of branches) {
    if (branch === current) {
      output += `* \x1b[32m${branch}\x1b[0m\n`;
    } else {
      output += `  ${branch}\n`;
    }
  }

  if (listAll) {
    try {
      const remoteBranches = await git.listBranches({
        fs: ctx.lfs,
        dir: cwd,
        remote: 'origin',
      });
      for (const branch of remoteBranches) {
        output += `  \x1b[31mremotes/origin/${branch}\x1b[0m\n`;
      }
    } catch {
      // No remote branches
    }
  }

  return { stdout: output, stderr: '', exitCode: 0 };
}
