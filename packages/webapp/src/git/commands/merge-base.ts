/** `git merge-base` and `--is-ancestor`. */

import * as git from 'isomorphic-git';
import { resolveRevision } from './revision.js';
import type { GitCommandContext, GitCommandResult } from './types.js';

export async function mergeBase(
  ctx: GitCommandContext,
  cwd: string,
  args: string[]
): Promise<GitCommandResult> {
  const isAncestor = args.includes('--is-ancestor');
  const refs = args.filter((arg) => !arg.startsWith('-'));
  if (refs.length < 2) {
    return { stdout: '', stderr: 'usage: git merge-base <commit> <commit>\n', exitCode: 129 };
  }
  try {
    const oids = await Promise.all(refs.slice(0, 2).map((ref) => resolveRevision(ctx, cwd, ref)));
    if (isAncestor) {
      if (oids[0] === oids[1]) return { stdout: '', stderr: '', exitCode: 0 };
      const yes = await git.isDescendent({
        fs: ctx.lfs,
        cache: ctx.cache,
        dir: cwd,
        oid: oids[1],
        ancestor: oids[0],
        depth: -1,
      });
      return { stdout: '', stderr: '', exitCode: yes ? 0 : 1 };
    }
    const bases = await git.findMergeBase({ fs: ctx.lfs, cache: ctx.cache, dir: cwd, oids });
    return { stdout: bases[0] ? `${bases[0]}\n` : '', stderr: '', exitCode: bases[0] ? 0 : 1 };
  } catch {
    return { stdout: '', stderr: 'fatal: Not a valid object name\n', exitCode: 128 };
  }
}
