/** `git remote` — add, remove, or list remotes. */

import * as git from 'isomorphic-git';
import type { GitCommandContext, GitCommandResult } from './types.js';

export async function remote(
  ctx: GitCommandContext,
  cwd: string,
  args: string[]
): Promise<GitCommandResult> {
  const [subcommand, ...rest] = args;

  if (subcommand === 'add' && rest.length >= 2) {
    const [name, url] = rest;
    await git.addRemote({ fs: ctx.lfs, dir: cwd, remote: name, url });
    return { stdout: '', stderr: '', exitCode: 0 };
  }

  if (subcommand === 'remove' || subcommand === 'rm') {
    const name = rest[0];
    if (name) {
      await git.deleteRemote({ fs: ctx.lfs, dir: cwd, remote: name });
      return { stdout: '', stderr: '', exitCode: 0 };
    }
  }

  // List remotes
  const verbose = args.includes('-v') || args.includes('--verbose');
  const remotes = await git.listRemotes({ fs: ctx.lfs, dir: cwd });

  let output = '';
  for (const { remote, url } of remotes) {
    if (verbose) {
      output += `${remote}\t${url} (fetch)\n`;
      output += `${remote}\t${url} (push)\n`;
    } else {
      output += `${remote}\n`;
    }
  }

  return { stdout: output, stderr: '', exitCode: 0 };
}
