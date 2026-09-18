import * as git from 'isomorphic-git';
import { sgr } from './color.js';
import type { GitCommandContext, GitCommandResult } from './types.js';

export async function branch(
  ctx: GitCommandContext,
  cwd: string,
  args: string[]
): Promise<GitCommandResult> {
  const deleteFlag = args.includes('-d') || args.includes('-D') || args.includes('--delete');
  const listAll = args.includes('-a') || args.includes('--all');

  if (args.includes('--show-current')) {
    const current = await git.currentBranch({ fs: ctx.lfs, dir: cwd });
    return { stdout: current ? `${current}\n` : '', stderr: '', exitCode: 0 };
  }

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
    await git.branch({ fs: ctx.lfs, dir: cwd, ref: branchName });
    return { stdout: '', stderr: '', exitCode: 0 };
  }

  const branches = await git.listBranches({ fs: ctx.lfs, dir: cwd });
  const current = await git.currentBranch({ fs: ctx.lfs, dir: cwd });

  let output = '';
  for (const branch of branches) {
    if (branch === current) {
      output += `* ${sgr(ctx.useColor, '32', branch)}\n`;
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
        output += `  ${sgr(ctx.useColor, '31', `remotes/origin/${branch}`)}\n`;
      }
    } catch {}
  }

  return { stdout: output, stderr: '', exitCode: 0 };
}
