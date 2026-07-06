/** `git mv` — move or rename a file. */

import * as git from 'isomorphic-git';
import type { GitCommandContext, GitCommandResult } from './types.js';

export async function mv(
  ctx: GitCommandContext,
  cwd: string,
  args: string[]
): Promise<GitCommandResult> {
  const paths = args.filter((a) => !a.startsWith('-'));

  if (paths.length < 2) {
    return { stdout: '', stderr: 'fatal: usage: git mv <source> <destination>\n', exitCode: 128 };
  }

  const src = paths[0];
  const dst = paths[1];
  const srcPath = src.startsWith('/') ? src : `${cwd}/${src}`;
  const dstPath = dst.startsWith('/') ? dst : `${cwd}/${dst}`;

  let content: string | Uint8Array;
  try {
    content = await ctx.fs.readFile(srcPath, { encoding: 'binary' });
  } catch {
    return {
      stdout: '',
      stderr: `fatal: bad source, source=${src}, destination=${dst}\n`,
      exitCode: 128,
    };
  }

  const dstSlash = dstPath.lastIndexOf('/');
  if (dstSlash !== -1) {
    await ctx.fs.mkdir(dstPath.slice(0, dstSlash), { recursive: true });
  }

  await ctx.fs.writeFile(dstPath, content);
  await ctx.fs.rm(srcPath);
  await git.add({ fs: ctx.lfs, dir: cwd, filepath: dst });
  await git.remove({ fs: ctx.lfs, dir: cwd, filepath: src });

  return { stdout: '', stderr: '', exitCode: 0 };
}
