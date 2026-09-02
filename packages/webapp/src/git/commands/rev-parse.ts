/** `git rev-parse`. */

import * as git from '../cached-isomorphic-git.js';
import { resolveRevision } from './revision.js';
import type { GitCommandContext, GitCommandResult } from './types.js';

export async function revParse(
  ctx: GitCommandContext,
  cwd: string,
  args: string[]
): Promise<GitCommandResult> {
  if (args.includes('--show-toplevel')) {
    try {
      const root = await git.findRoot({ fs: ctx.lfs, filepath: cwd });
      return { stdout: `${root}\n`, stderr: '', exitCode: 0 };
    } catch {
      return {
        stdout: '',
        stderr: 'fatal: not a git repository\n',
        exitCode: 128,
      };
    }
  }

  if (args.includes('--is-inside-work-tree')) {
    try {
      await git.findRoot({ fs: ctx.lfs, filepath: cwd });
      return { stdout: 'true\n', stderr: '', exitCode: 0 };
    } catch {
      return { stdout: 'false\n', stderr: '', exitCode: 0 };
    }
  }

  const ref = args.find((a) => !a.startsWith('-')) ?? 'HEAD';
  try {
    if (args.includes('--abbrev-ref')) {
      if (ref === 'HEAD') {
        const current = await git.currentBranch({ fs: ctx.lfs, dir: cwd });
        return { stdout: `${current ?? 'HEAD'}\n`, stderr: '', exitCode: 0 };
      }
      return {
        stdout: `${ref.replace(/^refs\/(?:heads|tags|remotes)\//, '')}\n`,
        stderr: '',
        exitCode: 0,
      };
    }
    const oid = await resolveRevision(ctx, cwd, ref);
    const shortArg = args.find((a) => a === '--short' || a.startsWith('--short='));
    const length = shortArg?.includes('=') ? Number(shortArg.split('=')[1]) : 7;
    return {
      stdout: `${shortArg ? oid.slice(0, Number.isFinite(length) ? length : 7) : oid}\n`,
      stderr: '',
      exitCode: 0,
    };
  } catch {
    return {
      stdout: '',
      stderr: `fatal: ambiguous argument '${ref}'\n`,
      exitCode: 128,
    };
  }
}
