/** `git show-ref` — list branch and tag references. */

import * as git from 'isomorphic-git';
import type { GitCommandContext, GitCommandResult } from './types.js';

export async function showRef(
  ctx: GitCommandContext,
  cwd: string,
  args: string[]
): Promise<GitCommandResult> {
  const headsOnly = args.includes('--heads');
  const tagsOnly = args.includes('--tags');
  const pattern = args.find((a) => !a.startsWith('-'));

  let output = '';

  if (!tagsOnly) {
    const branches = await git.listBranches({ fs: ctx.lfs, dir: cwd });
    for (const branch of branches) {
      const oid = await git.resolveRef({ fs: ctx.lfs, dir: cwd, ref: branch });
      const refPath = `refs/heads/${branch}`;
      if (pattern && !refPath.includes(pattern)) continue;
      output += `${oid} ${refPath}\n`;
    }
  }

  if (!headsOnly) {
    const tags = await git.listTags({ fs: ctx.lfs, dir: cwd });
    for (const tag of tags) {
      const oid = await git.resolveRef({ fs: ctx.lfs, dir: cwd, ref: tag });
      const refPath = `refs/tags/${tag}`;
      if (pattern && !refPath.includes(pattern)) continue;
      output += `${oid} ${refPath}\n`;
    }
  }

  return { stdout: output, stderr: '', exitCode: 0 };
}
