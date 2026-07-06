/** `git rev-parse`. */

import * as git from 'isomorphic-git';
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
    const oid = await git.resolveRef({ fs: ctx.lfs, dir: cwd, ref });
    return { stdout: `${oid}\n`, stderr: '', exitCode: 0 };
  } catch {
    return {
      stdout: '',
      stderr: `fatal: ambiguous argument '${ref}'\n`,
      exitCode: 128,
    };
  }
}
