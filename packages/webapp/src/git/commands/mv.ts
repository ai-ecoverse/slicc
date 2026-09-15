/** `git mv` — move or rename a file. */

import * as git from 'isomorphic-git';
import { sameFileIdentity } from '../../fs/same-file-identity.js';
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

  let srcStat;
  try {
    srcStat = await ctx.fs.stat(srcPath);
  } catch {
    return {
      stdout: '',
      stderr: `fatal: bad source, source=${src}, destination=${dst}\n`,
      exitCode: 128,
    };
  }
  if (srcStat.type === 'directory') {
    return {
      stdout: '',
      stderr: `fatal: bad source, source=${src}, destination=${dst}\n`,
      exitCode: 128,
    };
  }

  try {
    const dstStat = await ctx.fs.stat(dstPath);
    // Same inode (case / NFC-NFD): write+rm would truncate then delete (#3107).
    if (sameFileIdentity(srcStat, dstStat)) {
      return { stdout: '', stderr: '', exitCode: 0 };
    }
  } catch {
    /* dest missing */
  }

  const dstSlash = dstPath.lastIndexOf('/');
  if (dstSlash !== -1) {
    await ctx.fs.mkdir(dstPath.slice(0, dstSlash), { recursive: true });
  }

  // Native rename is hostfs-only. Picker/S3/DA/AEM mounts live outside
  // LightningFS, so VirtualFS.rename throws there — keep the historical
  // read/write/remove fallback after the same-file check (#3107).
  try {
    await ctx.fs.rename(srcPath, dstPath);
  } catch {
    const content = await ctx.fs.readFile(srcPath, { encoding: 'binary' });
    await ctx.fs.writeFile(dstPath, content);
    await ctx.fs.rm(srcPath);
  }
  await git.add({ fs: ctx.lfs, cache: ctx.cache, dir: cwd, filepath: dst });
  await git.remove({ fs: ctx.lfs, cache: ctx.cache, dir: cwd, filepath: src });

  return { stdout: '', stderr: '', exitCode: 0 };
}
