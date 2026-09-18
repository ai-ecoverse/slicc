import * as git from 'isomorphic-git';
import { parseArgs } from '../../shell/arg-parser.js';
import { gitHttp } from '../git-http.js';
import {
  flagString,
  GIT_FLAG_SPECS,
  type GitParsedFlags,
  rejectUnknownGitFlags,
} from './shared.js';
import type { GitCommandContext, GitCommandResult } from './types.js';

export async function fetch(
  ctx: GitCommandContext,
  cwd: string,
  args: string[]
): Promise<GitCommandResult> {
  const unknown = rejectUnknownGitFlags(args, GIT_FLAG_SPECS.fetch);
  if (unknown) return unknown;

  const { flags: rawFlags, positionals } = parseArgs(args, GIT_FLAG_SPECS.fetch);
  const flags = rawFlags as GitParsedFlags;
  const remote = positionals[0] ?? 'origin';
  const ref = positionals[1];
  const prune = flags.prune === true;
  const quiet = flags.quiet === true;
  const depth = flagString(flags, 'depth');

  let output = quiet ? '' : `Fetching ${remote}\n`;

  const result = await git.fetch({
    fs: ctx.lfs,
    cache: ctx.cache,
    http: gitHttp,
    dir: cwd,
    remote,
    ref,
    corsProxy: ctx.corsProxy,
    prune,
    depth: depth ? parseInt(depth, 10) : undefined,
    onAuth: ctx.getOnAuth(),
    onAuthFailure: ctx.getOnAuthFailure(),
    onProgress: quiet
      ? undefined
      : (event) => {
          output += `${event.phase}: ${event.loaded}/${event.total}\n`;
        },
  });

  if (result.fetchHead) {
    await writeFetchHead(ctx, cwd, result.fetchHead, result.fetchHeadDescription);
    if (!quiet) {
      output += `From ${remote}\n`;
      output += `   ${result.fetchHead.slice(0, 7)}..${result.fetchHeadDescription ?? ''}\n`;
    }
  }

  return { stdout: output, stderr: '', exitCode: 0 };
}

async function writeFetchHead(
  ctx: GitCommandContext,
  cwd: string,
  oid: string,
  description: string | null | undefined
): Promise<void> {
  const root = await git.findRoot({ fs: ctx.lfs, filepath: cwd });
  const desc = description ?? '';
  await ctx.fs.writeFile(`${root}/.git/FETCH_HEAD`, `${oid}\t\t${desc}\n`);
}
