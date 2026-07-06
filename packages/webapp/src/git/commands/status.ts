/** `git status` (long and short/porcelain forms). */

import * as git from 'isomorphic-git';
import type { GitCommandContext, GitCommandResult } from './types.js';

export async function status(
  ctx: GitCommandContext,
  cwd: string,
  args: string[]
): Promise<GitCommandResult> {
  const short = args.includes('--short') || args.includes('-s');
  const porcelain = args.includes('--porcelain');

  if (short || porcelain) {
    return statusShort(ctx, cwd);
  }

  let output = '';

  try {
    const branch = await git.currentBranch({ fs: ctx.lfs, dir: cwd });
    output += `On branch ${branch ?? '(no branch)'}\n\n`;
  } catch {
    output += 'Not on any branch.\n\n';
  }

  const matrix = await git.statusMatrix({ fs: ctx.lfs, dir: cwd });
  const { staged, unstaged, untracked } = classifyStatusMatrix(matrix);

  output += formatStatusLong(staged, unstaged, untracked);

  return { stdout: output, stderr: '', exitCode: 0 };
}

/** Classify status matrix entries into staged, unstaged, and untracked buckets. */
function classifyStatusMatrix(matrix: [string, number, number, number][]): {
  staged: string[];
  unstaged: string[];
  untracked: string[];
} {
  const staged: string[] = [];
  const unstaged: string[] = [];
  const untracked: string[] = [];

  for (const [file, head, workdir, stage] of matrix) {
    if (head === 0 && workdir === 2 && stage === 0) {
      untracked.push(file);
    } else if (stage === 2 || (head === 1 && stage === 0 && workdir === 0)) {
      staged.push(file);
    } else if (workdir !== stage && workdir !== 0) {
      unstaged.push(file);
    } else if (head === 1 && workdir === 0 && stage === 1) {
      unstaged.push(file + ' (deleted)');
    }
  }

  return { staged, unstaged, untracked };
}

/** Format long-form status output from classified file lists. */
function formatStatusLong(staged: string[], unstaged: string[], untracked: string[]): string {
  let output = '';

  if (staged.length > 0) {
    output += 'Changes to be committed:\n';
    output += '  (use "git restore --staged <file>..." to unstage)\n\n';
    for (const file of staged) {
      output += `\t\x1b[32m${file}\x1b[0m\n`;
    }
    output += '\n';
  }

  if (unstaged.length > 0) {
    output += 'Changes not staged for commit:\n';
    output += '  (use "git add <file>..." to update what will be committed)\n\n';
    for (const file of unstaged) {
      output += `\t\x1b[31m${file}\x1b[0m\n`;
    }
    output += '\n';
  }

  if (untracked.length > 0) {
    output += 'Untracked files:\n';
    output += '  (use "git add <file>..." to include in what will be committed)\n\n';
    for (const file of untracked) {
      output += `\t\x1b[31m${file}\x1b[0m\n`;
    }
    output += '\n';
  }

  if (staged.length === 0 && unstaged.length === 0 && untracked.length === 0) {
    output += 'nothing to commit, working tree clean\n';
  }

  return output;
}

/**
 * Output status in short/porcelain format: `XY filename`
 * X = index status, Y = workdir status
 */
async function statusShort(ctx: GitCommandContext, cwd: string): Promise<GitCommandResult> {
  const matrix = await git.statusMatrix({ fs: ctx.lfs, dir: cwd });
  let output = '';

  for (const [file, head, workdir, stage] of matrix) {
    const codes = shortStatusCodes(head, workdir, stage);
    if (!codes) continue;
    output += `${codes[0]}${codes[1]} ${file}\n`;
  }

  return { stdout: output, stderr: '', exitCode: 0 };
}

/** Return [indexCode, workdirCode] for a status matrix entry, or null to skip. */
function shortStatusCodes(head: number, workdir: number, stage: number): [string, string] | null {
  if (head === 0 && workdir === 2 && stage === 0) return ['?', '?'];
  if (head === 0 && workdir === 2 && stage === 2) return ['A', ' '];
  if (head === 0 && workdir === 2 && stage === 3) return ['A', 'M'];
  if (head === 1 && workdir === 2 && stage === 1) return [' ', 'M'];
  if (head === 1 && workdir === 2 && stage === 2) return ['M', ' '];
  if (head === 1 && workdir === 2 && stage === 3) return ['M', 'M'];
  if (head === 1 && workdir === 0 && stage === 0) return ['D', ' '];
  if (head === 1 && workdir === 0 && stage === 1) return [' ', 'D'];
  if (head === 1 && workdir === 1 && stage === 1) return null;
  return null;
}
