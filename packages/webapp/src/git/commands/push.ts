/** `git push`. */

import * as git from 'isomorphic-git';
import { parseArgs } from '../../shell/arg-parser.js';
import { gitHttp } from '../git-http.js';
import { GIT_FLAG_SPECS } from './shared.js';
import type { GitCommandContext, GitCommandResult } from './types.js';

export async function push(
  ctx: GitCommandContext,
  cwd: string,
  args: string[]
): Promise<GitCommandResult> {
  // Extract positional args, skipping flag VALUES (`--push-option <opt>` etc.).
  const { flags, positionals } = parseArgs(args, GIT_FLAG_SPECS.push);
  const force = flags.force === true;
  const setUpstream = flags['set-upstream'] === true;
  const remote = positionals[0] ?? 'origin';
  const branch = positionals[1] ?? (await git.currentBranch({ fs: ctx.lfs, dir: cwd }));

  let output = `Pushing to ${remote}...\n`;

  const result = await git.push({
    fs: ctx.lfs,
    http: gitHttp,
    dir: cwd,
    remote,
    ref: branch ?? undefined,
    corsProxy: ctx.corsProxy,
    force,
    onAuth: ctx.getOnAuth(),
    onProgress: (event) => {
      output += `${event.phase}: ${event.loaded}/${event.total}\n`;
    },
  });

  if (result.ok) {
    output += `To ${remote}\n`;
    output += `   ${branch} -> ${branch}\n`;

    // Set upstream tracking if -u/--set-upstream was specified
    if (setUpstream && branch) {
      await git.setConfig({
        fs: ctx.lfs,
        dir: cwd,
        path: `branch.${branch}.remote`,
        value: remote,
      });
      await git.setConfig({
        fs: ctx.lfs,
        dir: cwd,
        path: `branch.${branch}.merge`,
        value: `refs/heads/${branch}`,
      });
      output += `Branch '${branch}' set up to track remote branch '${branch}' from '${remote}'.\n`;
    }
  } else {
    return {
      stdout: '',
      stderr: `error: failed to push to '${remote}': ${result.error}\n`,
      exitCode: 1,
    };
  }

  return { stdout: output, stderr: '', exitCode: 0 };
}
