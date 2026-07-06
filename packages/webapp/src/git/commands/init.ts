/** `git init`. */

import * as git from 'isomorphic-git';
import { parseArgs } from '../../shell/arg-parser.js';
import { flagString, GIT_FLAG_SPECS } from './shared.js';
import type { GitCommandContext, GitCommandResult } from './types.js';

export async function init(
  ctx: GitCommandContext,
  cwd: string,
  args: string[]
): Promise<GitCommandResult> {
  const { flags } = parseArgs(args, GIT_FLAG_SPECS.init);
  // Precedence (matches real git): explicit `--initial-branch`/`-b` flag
  // wins over a per-invocation `-c init.defaultBranch=…` override, which
  // wins over the built-in `main` default.
  const defaultBranch =
    flagString(flags, 'initial-branch') ??
    // Override keys are lowercased on insert (matches real git), so look up
    // the all-lowercase form here.
    ctx.getConfigOverrides()?.get('init.defaultbranch') ??
    'main';

  await git.init({
    fs: ctx.lfs,
    dir: cwd,
    defaultBranch,
  });

  return {
    stdout: `Initialized empty Git repository in ${cwd}/.git/\n`,
    stderr: '',
    exitCode: 0,
  };
}
