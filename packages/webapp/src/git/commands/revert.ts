/**
 * `git revert <commit>` — apply the inverse of an existing commit onto the
 * current branch as a new commit.
 *
 * isomorphic-git has no `revert`, so this is a manual reverse three-way merge:
 * for the target commit C (single parent P) and HEAD H, every file in the union
 * of the three trees is merged with `threeWayMerge(current = H, base = C,
 * other = P)`. Using C as the merge base and P as "theirs" inverts the commit's
 * P→C patch, so the result is H with C's changes undone. Clean files are written
 * to the working tree + index and committed as `Revert "<subject>"` (unless
 * `-n`); a divergent overlap leaves standard conflict markers and exits 1
 * without committing. Merge commits are rejected like real git.
 */

import * as git from 'isomorphic-git';
import { parseArgs } from '../../shell/arg-parser.js';
import { threeWayMerge } from '../merge-file-core.js';
import { expandGitError, GIT_FLAG_SPECS } from './shared.js';
import type { GitCommandContext, GitCommandResult } from './types.js';

export async function revert(
  ctx: GitCommandContext,
  cwd: string,
  args: string[]
): Promise<GitCommandResult> {
  const { flags, positionals } = parseArgs(args, GIT_FLAG_SPECS.revert);
  const noCommit = flags['no-commit'] === true;
  const ref = positionals[0];

  if (!ref) {
    return { stdout: '', stderr: 'error: empty commit set passed\n', exitCode: 128 };
  }

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

  let headOid: string;
  try {
    headOid = await git.resolveRef({ fs: ctx.lfs, dir: cwd, ref: 'HEAD' });
  } catch {
    return {
      stdout: '',
      stderr: 'fatal: your current branch does not have any commits yet\n',
      exitCode: 128,
    };
  }

  const { commit } = await git.readCommit({ fs: ctx.lfs, dir: cwd, oid });
  if (commit.parent.length !== 1) {
    return {
      stdout: '',
      stderr: `error: commit ${oid} is a merge but no -m option was given.\nfatal: revert failed\n`,
      exitCode: 128,
    };
  }
  const parentOid = commit.parent[0];
  const subject = commit.message.split('\n')[0];
  const short = oid.slice(0, 7);
  const branch = (await git.currentBranch({ fs: ctx.lfs, dir: cwd })) ?? 'HEAD';

  try {
    const conflicts = await applyReverse(ctx, cwd, headOid, oid, parentOid, {
      current: branch,
      base: short,
      other: `parent of ${short} (${subject})`,
    });

    if (conflicts.length > 0) {
      let output = '';
      for (const f of conflicts) output += `CONFLICT (content): Merge conflict in ${f}\n`;
      output += `error: could not revert ${short}... ${subject}\n`;
      output += "hint: after resolving the conflicts, mark them with 'git add <paths>',\n";
      output += 'hint: then commit the result.\n';
      return { stdout: '', stderr: output, exitCode: 1 };
    }

    if (noCommit) {
      return { stdout: '', stderr: '', exitCode: 0 };
    }

    const author = await ctx.resolveAuthor(cwd);
    const message = `Revert "${subject}"\n\nThis reverts commit ${oid}.\n`;
    const newOid = await git.commit({ fs: ctx.lfs, dir: cwd, message, author, committer: author });

    return {
      stdout: `[${branch} ${newOid.slice(0, 7)}] Revert "${subject}"\n`,
      stderr: '',
      exitCode: 0,
    };
  } catch (err: unknown) {
    return { stdout: '', stderr: `fatal: ${expandGitError(err)}\n`, exitCode: 128 };
  }
}

/**
 * Reverse three-way merge every file the target commit touched onto HEAD.
 * Writes clean results to the working tree + index (removing files the revert
 * deletes) and returns the list of files left with conflict markers.
 */
async function applyReverse(
  ctx: GitCommandContext,
  cwd: string,
  headOid: string,
  commitOid: string,
  parentOid: string,
  labels: { current: string; base: string; other: string }
): Promise<string[]> {
  const [hFiles, cFiles, pFiles] = await Promise.all([
    git.listFiles({ fs: ctx.lfs, dir: cwd, ref: headOid }),
    git.listFiles({ fs: ctx.lfs, dir: cwd, ref: commitOid }),
    git.listFiles({ fs: ctx.lfs, dir: cwd, ref: parentOid }),
  ]);
  const union = new Set([...hFiles, ...cFiles, ...pFiles]);

  const encoder = new TextEncoder();
  const conflicts: string[] = [];

  for (const filepath of union) {
    const c = await readAt(ctx, cwd, commitOid, filepath);
    const p = await readAt(ctx, cwd, parentOid, filepath);
    if (c === p) continue; // commit did not touch this file — nothing to revert

    const h = (await readAt(ctx, cwd, headOid, filepath)) ?? '';
    let mergedText: string;
    let conflicted = false;
    if (h === (c ?? '')) {
      mergedText = p ?? ''; // HEAD matches the committed version — take the parent verbatim
    } else {
      const merge = threeWayMerge(h, c ?? '', p ?? '', { labels });
      mergedText = merge.content;
      conflicted = merge.conflicts > 0;
    }

    if (!conflicted && p === undefined && mergedText === '') {
      // The commit added this file; reverting removes it.
      await removeFile(ctx, cwd, filepath);
      continue;
    }

    // writeFile creates parent directories automatically.
    await ctx.fs.writeFile(`${cwd}/${filepath}`, encoder.encode(mergedText));

    if (conflicted) conflicts.push(filepath);
    else await git.add({ fs: ctx.lfs, dir: cwd, filepath });
  }

  return conflicts;
}

/** Read a file's blob at a commit as text, or `undefined` when it is absent. */
async function readAt(
  ctx: GitCommandContext,
  cwd: string,
  oid: string,
  filepath: string
): Promise<string | undefined> {
  try {
    const { blob } = await git.readBlob({ fs: ctx.lfs, dir: cwd, oid, filepath });
    return new TextDecoder().decode(blob);
  } catch {
    return undefined;
  }
}

/** Delete a file from the working tree and stage its removal. */
async function removeFile(ctx: GitCommandContext, cwd: string, filepath: string): Promise<void> {
  try {
    await ctx.fs.rm(`${cwd}/${filepath}`);
  } catch {
    /* already gone */
  }
  try {
    await git.remove({ fs: ctx.lfs, dir: cwd, filepath });
  } catch {
    /* not in index */
  }
}
