/** `git ls-remote` — inspect advertised refs without fetching objects. */

import * as git from 'isomorphic-git';
import { gitHttp } from '../git-http.js';
import { annotateGitHubAuthFailure } from './shared.js';
import type { GitCommandContext, GitCommandResult } from './types.js';

export async function lsRemote(
  ctx: GitCommandContext,
  cwd: string,
  args: string[]
): Promise<GitCommandResult> {
  const heads = args.includes('--heads') || args.includes('-h');
  const tags = args.includes('--tags') || args.includes('-t');
  const showSymrefs = args.includes('--symref');
  const positionals = args.filter((arg) => !arg.startsWith('-'));
  const remoteArg = positionals[0] ?? 'origin';
  const patterns = positionals.slice(1);
  const remotes = await git.listRemotes({ fs: ctx.lfs, dir: cwd }).catch(() => []);
  const url = remotes.find((item) => item.remote === remoteArg)?.url ?? remoteArg;
  try {
    const prefix = heads && !tags ? 'refs/heads/' : tags && !heads ? 'refs/tags/' : undefined;
    const refs = await git.listServerRefs({
      http: gitHttp,
      url,
      corsProxy: ctx.corsProxy,
      onAuth: ctx.getOnAuth(),
      onAuthFailure: ctx.getOnAuthFailure(),
      prefix,
      symrefs: showSymrefs,
      peelTags: tags,
    });
    const selected = refs.filter((item) => matchesPatterns(item.ref, patterns));
    const stdout = selected
      .map(
        (item) =>
          `${showSymrefs && item.target ? `ref: ${item.target}\t${item.ref}\n` : ''}${item.oid}\t${item.ref}\n`
      )
      .join('');
    return { stdout, stderr: '', exitCode: args.includes('--exit-code') && !stdout ? 2 : 0 };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      stdout: '',
      stderr: `fatal: ${annotateGitHubAuthFailure(message, url)}\n`,
      exitCode: 128,
    };
  }
}

function matchesPatterns(ref: string, patterns: string[]): boolean {
  if (patterns.length === 0) return true;
  return patterns.some((pattern) => {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    return new RegExp(`^(?:refs/(?:heads|tags)/)?${escaped}$`).test(ref);
  });
}
