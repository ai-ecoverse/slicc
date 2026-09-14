import * as git from 'isomorphic-git';
import { parseArgs } from '../../shell/arg-parser.js';
import { flagString, GIT_FLAG_SPECS, type GitParsedFlags } from './shared.js';
import type { GitCommandContext, GitCommandResult } from './types.js';

export async function init(
  ctx: GitCommandContext,
  cwd: string,
  args: string[]
): Promise<GitCommandResult> {
  const flags = parseArgs(args, GIT_FLAG_SPECS.init).flags as GitParsedFlags;

  const defaultBranch =
    flagString(flags, 'initial-branch') ??
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
