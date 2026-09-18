import * as git from 'isomorphic-git';
import { parseArgs } from '../../shell/arg-parser.js';
import { gitHttp } from '../git-http.js';
import { GIT_FLAG_SPECS, rejectUnknownGitFlags } from './shared.js';
import type { GitCommandContext, GitCommandResult } from './types.js';

export async function pull(
  ctx: GitCommandContext,
  cwd: string,
  args: string[]
): Promise<GitCommandResult> {
  const unknown = rejectUnknownGitFlags(args, GIT_FLAG_SPECS.pull);
  if (unknown) return unknown;

  const { flags, positionals } = parseArgs(args, GIT_FLAG_SPECS.pull);
  const remote = positionals[0] ?? 'origin';
  const ref = positionals[1];
  const ffOnly = flags['ff-only'] === true || args.includes('--ff-only');
  const noFf = flags.ff === false || args.includes('--no-ff');
  const quiet = flags.quiet === true;

  let output = quiet ? '' : `Pulling from ${remote}...\n`;

  await git.pull({
    fs: ctx.lfs,
    cache: ctx.cache,
    http: gitHttp,
    dir: cwd,
    remote,
    ref,
    corsProxy: ctx.corsProxy,
    author: await ctx.resolveAuthor(cwd),
    fastForwardOnly: ffOnly,
    fastForward: !noFf,
    onAuth: ctx.getOnAuth(),
    onAuthFailure: ctx.getOnAuthFailure(),
    onProgress: quiet
      ? undefined
      : (event) => {
          output += `${event.phase}: ${event.loaded}/${event.total}\n`;
        },
  });

  if (!quiet) output += 'Already up to date.\n';
  return { stdout: output, stderr: '', exitCode: 0 };
}
