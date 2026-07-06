/** `git clone` plus its target-dir error formatter. */

import * as git from 'isomorphic-git';
import { parseArgs } from '../../shell/arg-parser.js';
import { gitHttp } from '../git-http.js';
import { flagString, GIT_FLAG_SPECS } from './shared.js';
import type { GitCommandContext, GitCommandResult } from './types.js';

export async function clone(
  ctx: GitCommandContext,
  cwd: string,
  args: string[]
): Promise<GitCommandResult> {
  if (args.length === 0) {
    return {
      stdout: '',
      stderr: 'fatal: You must specify a repository to clone.\n',
      exitCode: 128,
    };
  }

  const url = args[0];
  let dir = args[1];

  // Extract repo name from URL if dir not specified
  if (!dir) {
    const match = url.match(/\/([^/]+?)(\.git)?$/);
    dir = match ? match[1] : 'repo';
  }

  const targetDir = dir.startsWith('/') ? dir : `${cwd}/${dir}`;
  const { flags } = parseArgs(args, GIT_FLAG_SPECS.clone);
  const depth = flagString(flags, 'depth');
  const branch = flagString(flags, 'branch');
  const singleBranch = flags['single-branch'] !== false;

  let output = `Cloning into '${dir}'...\n`;

  // Use a shared cache for the clone operation
  const cache = {};

  try {
    await git.clone({
      fs: ctx.lfs,
      http: gitHttp,
      dir: targetDir,
      url,
      corsProxy: ctx.corsProxy,
      depth: depth ? parseInt(depth, 10) : 1, // Default to depth 1 for faster clones
      ref: branch,
      singleBranch,
      noCheckout: false, // Let clone handle checkout
      cache,
      onAuth: ctx.getOnAuth(),
      onProgress: (event) => {
        if (event.phase === 'Receiving objects') {
          output += `Receiving objects: ${event.loaded}/${event.total}\n`;
        }
      },
    });
  } catch (err: unknown) {
    // #1033-1: surface the real target dir, never the literal `<path>`
    // placeholder that bubbles up from the OPFS backend.
    return formatCloneError(err, targetDir);
  }

  // List files that were checked out
  try {
    const files = await git.listFiles({ fs: ctx.lfs, dir: targetDir });
    if (files.length > 0) {
      output += `Checked out ${files.length} files.\n`;
    }
  } catch {
    // Ignore errors listing files
  }

  return {
    stdout: output + 'done.\n',
    stderr: '',
    exitCode: 0,
  };
}

/**
 * Format a clone failure: interpolates the real target dir in place of the
 * OPFS internal placeholder so the user sees the path they asked for, never
 * the literal `<path>` token from the backend (#1033-1).
 */
function formatCloneError(err: unknown, targetDir: string): GitCommandResult {
  const raw = err instanceof Error ? err.message : String(err);
  const scrubbed = raw
    .replace(/'\/__opfs__\/[^']*<path>'/g, `'${targetDir}'`)
    .replace(/\/__opfs__\/[^\s'"<]*<path>/g, targetDir)
    .replace(/<path>/g, targetDir);
  return {
    stdout: '',
    stderr: `fatal: ${scrubbed}\n`,
    exitCode: 128,
  };
}
