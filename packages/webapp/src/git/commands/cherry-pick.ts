/**
 * `git cherry-pick <commit>` — apply the changes of an existing commit onto the
 * current branch as a new commit, preserving the original author.
 *
 * Wraps isomorphic-git's native `cherryPick` with the shared `makeMergeDriver`
 * so a divergent overlap leaves standard conflict markers in the working tree
 * and a conflicted index (exit 1) instead of aborting. Merge and root commits
 * are rejected natively by `cherryPick`; we format those into git-style errors.
 */

import * as git from 'isomorphic-git';
import { parseArgs } from '../../shell/arg-parser.js';
import { makeMergeDriver } from './merge-driver.js';
import { expandGitError, GIT_FLAG_SPECS } from './shared.js';
import type { GitCommandContext, GitCommandResult } from './types.js';

export async function cherryPick(
  ctx: GitCommandContext,
  cwd: string,
  args: string[]
): Promise<GitCommandResult> {
  const { flags, positionals } = parseArgs(args, GIT_FLAG_SPECS['cherry-pick']);
  const noCommit = flags['no-commit'] === true;
  const appendOrigin = flags.x === true;
  const ref = positionals[0];

  if (!ref) {
    return { stdout: '', stderr: 'error: empty commit set passed\n', exitCode: 128 };
  }

  // Resolve <commit> to a full oid: try refs first, then a short/full oid.
  let oid: string;
  try {
    oid = await git.resolveRef({ fs: ctx.lfs, dir: cwd, ref });
  } catch {
    try {
      oid = await git.expandOid({ fs: ctx.lfs, dir: cwd, oid: ref });
    } catch {
      return { stdout: '', stderr: `fatal: bad revision '${ref}'\n`, exitCode: 128 };
    }
  }

  try {
    const newOid = await git.cherryPick({
      fs: ctx.lfs,
      dir: cwd,
      oid,
      abortOnConflict: false,
      noUpdateBranch: noCommit,
      committer: await ctx.resolveAuthor(cwd),
      mergeDriver: makeMergeDriver(),
    });

    // --no-commit: changes are applied to the tree/index; the branch pointer
    // is left untouched and no commit output is printed (matches real git).
    if (noCommit) {
      return { stdout: '', stderr: '', exitCode: 0 };
    }

    let headOid = newOid;
    const { commit } = await git.readCommit({ fs: ctx.lfs, dir: cwd, oid: newOid });

    // `-x`: annotate the message with the source commit (full oid), like git.
    if (appendOrigin) {
      const body = commit.message.replace(/\s+$/, '');
      headOid = await git.commit({
        fs: ctx.lfs,
        dir: cwd,
        message: `${body}\n\n(cherry picked from commit ${oid})\n`,
        author: commit.author,
        committer: await ctx.resolveAuthor(cwd),
        amend: true,
      });
    }

    const branch = await git.currentBranch({ fs: ctx.lfs, dir: cwd });
    const subject = commit.message.split('\n')[0];
    return {
      stdout: `[${branch ?? 'HEAD'} ${headOid.slice(0, 7)}] ${subject}\n`,
      stderr: '',
      exitCode: 0,
    };
  } catch (err: unknown) {
    return handleCherryPickError(err, oid);
  }
}

/** Format cherry-pick failures into git-style CLI output. */
function handleCherryPickError(err: unknown, oid: string): GitCommandResult {
  const short = oid.slice(0, 7);

  if (err instanceof Error && err.name === 'MergeConflictError') {
    const data = (err as Error & { data?: { filepaths?: string[] } }).data;
    const files = data?.filepaths ?? [];
    let output = '';
    for (const f of files) {
      output += `CONFLICT (content): Merge conflict in ${f}\n`;
    }
    output += `error: could not apply ${short}...\n`;
    output += "hint: after resolving the conflicts, mark them with 'git add <paths>',\n";
    output += 'hint: then commit the result.\n';
    return { stdout: '', stderr: output, exitCode: 1 };
  }

  if (err instanceof Error && err.name === 'CherryPickMergeCommitError') {
    return {
      stdout: '',
      stderr: `error: commit ${oid} is a merge but no -m option was given.\nfatal: cherry-pick failed\n`,
      exitCode: 128,
    };
  }

  if (err instanceof Error && err.name === 'CherryPickRootCommitError') {
    return {
      stdout: '',
      stderr: `error: ${err.message}\nfatal: cherry-pick failed\n`,
      exitCode: 128,
    };
  }

  return { stdout: '', stderr: `fatal: ${expandGitError(err)}\n`, exitCode: 128 };
}
