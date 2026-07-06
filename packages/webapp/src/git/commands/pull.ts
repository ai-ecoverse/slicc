/** `git pull`. */

import * as git from 'isomorphic-git';
import { parseArgs } from '../../shell/arg-parser.js';
import { gitHttp } from '../git-http.js';
import { GIT_FLAG_SPECS } from './shared.js';
import type { GitCommandContext, GitCommandResult } from './types.js';

export async function pull(
  ctx: GitCommandContext,
  cwd: string,
  args: string[]
): Promise<GitCommandResult> {
  // Same positional-ref bug class as fetch: skip flag values when picking
  // remote/ref out of `pull --ff-only origin main`.
  const { positionals } = parseArgs(args, GIT_FLAG_SPECS.pull);
  const remote = positionals[0] ?? 'origin';
  const ref = positionals[1];
  const ffOnly = args.includes('--ff-only');
  const noFf = args.includes('--no-ff');

  let output = `Pulling from ${remote}...\n`;

  await git.pull({
    fs: ctx.lfs,
    http: gitHttp,
    dir: cwd,
    remote,
    ref,
    corsProxy: ctx.corsProxy,
    author: await ctx.resolveAuthor(cwd),
    fastForwardOnly: ffOnly,
    fastForward: !noFf,
    onAuth: ctx.getOnAuth(),
    onProgress: (event) => {
      output += `${event.phase}: ${event.loaded}/${event.total}\n`;
    },
  });

  output += 'Already up to date.\n';
  return { stdout: output, stderr: '', exitCode: 0 };
}
