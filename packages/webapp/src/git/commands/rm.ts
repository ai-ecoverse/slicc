/** `git rm` — remove files from the working tree and index. */

import * as git from 'isomorphic-git';
import type { GitCommandContext, GitCommandResult } from './types.js';

export async function rm(
  ctx: GitCommandContext,
  cwd: string,
  args: string[]
): Promise<GitCommandResult> {
  const cached = args.includes('--cached');
  const recursive = args.includes('-r') || args.includes('-R') || args.includes('--recursive');

  const paths = args.filter((a) => !a.startsWith('-'));

  if (paths.length === 0) {
    return {
      stdout: '',
      stderr: 'fatal: No pathspec given. Which files should I remove?\n',
      exitCode: 128,
    };
  }

  for (const filepath of paths) {
    const result = await rmOne(ctx, cwd, filepath, cached, recursive);
    if (result) return result;
  }

  return { stdout: '', stderr: '', exitCode: 0 };
}

/** Remove a single path from index (and optionally workdir). Returns error result or null. */
async function rmOne(
  ctx: GitCommandContext,
  cwd: string,
  filepath: string,
  cached: boolean,
  recursive: boolean
): Promise<GitCommandResult | null> {
  const fullPath = filepath.startsWith('/') ? filepath : `${cwd}/${filepath}`;

  let isDir = false;
  try {
    const stat = await ctx.fs.stat(fullPath);
    isDir = stat.type === 'directory';
  } catch {
    /* file might not exist in workdir */
  }

  if (isDir) {
    if (!recursive) {
      return {
        stdout: '',
        stderr: `fatal: not removing '${filepath}' recursively without -r\n`,
        exitCode: 128,
      };
    }
    const indexFiles = await git.listFiles({ fs: ctx.lfs, dir: cwd });
    const matchingFiles = indexFiles.filter((f) => f === filepath || f.startsWith(filepath + '/'));

    for (const file of matchingFiles) {
      await git.remove({ fs: ctx.lfs, dir: cwd, filepath: file });
      if (!cached) {
        try {
          await ctx.fs.rm(`${cwd}/${file}`);
        } catch {
          /* ignore */
        }
      }
    }
  } else {
    await git.remove({ fs: ctx.lfs, dir: cwd, filepath });
    if (!cached) {
      try {
        await ctx.fs.rm(fullPath);
      } catch {
        /* ignore */
      }
    }
  }

  return null;
}
