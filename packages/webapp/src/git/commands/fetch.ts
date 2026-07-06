/** `git fetch`. */

import * as git from 'isomorphic-git';
import { parseArgs } from '../../shell/arg-parser.js';
import { gitHttp } from '../git-http.js';
import { flagString, GIT_FLAG_SPECS } from './shared.js';
import type { GitCommandContext, GitCommandResult } from './types.js';

export async function fetch(
  ctx: GitCommandContext,
  cwd: string,
  args: string[]
): Promise<GitCommandResult> {
  // Positional ref must round-trip: `fetch --depth 1 origin main` →
  // remote=origin, ref=main (NOT remote=1) — #1033-3.
  const { flags, positionals } = parseArgs(args, GIT_FLAG_SPECS.fetch);
  const remote = positionals[0] ?? 'origin';
  const ref = positionals[1];
  const prune = flags.prune === true;
  const depth = flagString(flags, 'depth');

  let output = `Fetching ${remote}\n`;

  const result = await git.fetch({
    fs: ctx.lfs,
    http: gitHttp,
    dir: cwd,
    remote,
    ref,
    corsProxy: ctx.corsProxy,
    prune,
    depth: depth ? parseInt(depth, 10) : undefined,
    onAuth: ctx.getOnAuth(),
    onProgress: (event) => {
      output += `${event.phase}: ${event.loaded}/${event.total}\n`;
    },
  });

  if (result.fetchHead) {
    output += `From ${remote}\n`;
    output += `   ${result.fetchHead.slice(0, 7)}..${result.fetchHeadDescription ?? ''}\n`;
  }

  return { stdout: output, stderr: '', exitCode: 0 };
}
