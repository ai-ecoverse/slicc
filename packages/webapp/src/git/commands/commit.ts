/** `git commit` plus auto-staging and combined-flag expansion helpers. */

import * as git from 'isomorphic-git';
import { parseArgs } from '../../shell/arg-parser.js';
import { flagString, GIT_FLAG_SPECS } from './shared.js';
import type { GitCommandContext, GitCommandResult } from './types.js';

export async function commit(
  ctx: GitCommandContext,
  cwd: string,
  args: string[]
): Promise<GitCommandResult> {
  // Handle combined -am "message" form: expand to -a -m "message"
  const expandedArgs = expandCombinedFlags(args);
  const { flags } = parseArgs(expandedArgs, GIT_FLAG_SPECS.commit);

  const message = flagString(flags, 'message');

  if (!message) {
    return {
      stdout: '',
      stderr: 'error: switch `m` requires a value\n',
      exitCode: 1,
    };
  }

  const amend = flags.amend === true;
  const autoStage = flags.all === true;
  const allowEmpty = flags['allow-empty'] === true;

  // Auto-stage tracked modified files before committing
  if (autoStage) {
    await stageTrackedChanges(ctx, cwd);
  }

  // Check for empty commit if --allow-empty is not set
  if (!allowEmpty && !amend) {
    const matrix = await git.statusMatrix({ fs: ctx.lfs, dir: cwd });
    const hasStaged = matrix.some(([, head, , stage]) => stage !== head);
    if (!hasStaged) {
      return {
        stdout: '',
        stderr: 'nothing to commit, working tree clean\n',
        exitCode: 1,
      };
    }
  }

  const sha = await git.commit({
    fs: ctx.lfs,
    dir: cwd,
    message,
    author: await ctx.resolveAuthor(cwd),
    amend,
    noUpdateBranch: undefined,
  });

  const shortSha = sha.slice(0, 7);
  const branch = await git.currentBranch({ fs: ctx.lfs, dir: cwd });

  return {
    stdout: `[${branch ?? 'HEAD'} ${shortSha}] ${message}\n`,
    stderr: '',
    exitCode: 0,
  };
}

/**
 * Stage all tracked files that have been modified or deleted (like `git add -u`).
 */
async function stageTrackedChanges(ctx: GitCommandContext, cwd: string): Promise<void> {
  const matrix = await git.statusMatrix({ fs: ctx.lfs, dir: cwd });
  for (const [file, head, workdir, stage] of matrix) {
    if (head === 0) continue; // Skip untracked files
    if (workdir === stage) continue; // Skip unchanged
    if (workdir === 0) {
      await git.remove({ fs: ctx.lfs, dir: cwd, filepath: file });
    } else {
      await git.add({ fs: ctx.lfs, dir: cwd, filepath: file });
    }
  }
}

/**
 * Expand combined single-char flags like -am into -a -m.
 * Preserves the value that follows -m.
 */
function expandCombinedFlags(args: string[]): string[] {
  const result: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    // Match combined flags like -am, -avm, etc. (single dash, multiple letters)
    // Skip args containing '=' (e.g., -m=msg) to avoid corrupting them
    if (arg.startsWith('-') && !arg.startsWith('--') && arg.length > 2 && !arg.includes('=')) {
      const flags = arg.slice(1);
      for (const ch of flags) {
        result.push(`-${ch}`);
      }
    } else {
      result.push(arg);
    }
  }
  return result;
}
