/** `git show` — commit details and diff, or `<commit>:<path>` file content. */

import * as git from 'isomorphic-git';
import { parseArgs } from '../../shell/arg-parser.js';
import { diffCommits, diffInitialCommit } from './diff.js';
import { flagString, GIT_FLAG_SPECS } from './shared.js';
import type { GitCommandContext, GitCommandResult } from './types.js';

export async function show(
  ctx: GitCommandContext,
  cwd: string,
  args: string[]
): Promise<GitCommandResult> {
  const { flags, positionals } = parseArgs(args, GIT_FLAG_SPECS.show);
  const stat = flags.stat === true;
  const format = flagString(flags, 'format');
  const ref = positionals[0];

  // Handle <commit>:<path> syntax — show file content at a commit
  if (ref?.includes(':')) {
    return await showFileAtCommit(ctx, cwd, ref);
  }

  const commitRef = ref ?? 'HEAD';
  let oid: string;
  try {
    oid = await git.resolveRef({ fs: ctx.lfs, dir: cwd, ref: commitRef });
  } catch {
    // Try expanding as a short OID
    try {
      oid = await git.expandOid({ fs: ctx.lfs, dir: cwd, oid: commitRef });
    } catch {
      return {
        stdout: '',
        stderr: `fatal: bad object ${commitRef}\n`,
        exitCode: 128,
      };
    }
  }

  const { commit } = await git.readCommit({ fs: ctx.lfs, dir: cwd, oid });

  let output = formatShowHeader(oid, commit, format);

  // Compute diff against parent
  const parentOid = commit.parent.length > 0 ? commit.parent[0] : undefined;

  if (parentOid) {
    const diffResult = await diffCommits(ctx, cwd, parentOid, oid, { nameOnly: false, stat });
    output += diffResult.stdout;
  } else {
    // Initial commit: diff against empty tree
    const diffResult = await diffInitialCommit(ctx, cwd, oid, stat);
    output += diffResult;
  }

  return { stdout: output, stderr: '', exitCode: 0 };
}

async function showFileAtCommit(
  ctx: GitCommandContext,
  cwd: string,
  refPath: string
): Promise<GitCommandResult> {
  const colonIdx = refPath.indexOf(':');
  const commitRef = refPath.slice(0, colonIdx) || 'HEAD';
  const filepath = refPath.slice(colonIdx + 1);
  const oid = await git.resolveRef({ fs: ctx.lfs, dir: cwd, ref: commitRef });
  const result = await git.readBlob({ fs: ctx.lfs, dir: cwd, oid, filepath });
  const content = new TextDecoder().decode(result.blob);
  return { stdout: content, stderr: '', exitCode: 0 };
}

function formatShowHeader(oid: string, commit: git.CommitObject, format?: string): string {
  if (format) {
    return (
      format
        .replace(/%H/g, oid)
        .replace(/%h/g, oid.slice(0, 7))
        .replace(/%s/g, commit.message.split('\n')[0])
        .replace(/%an/g, commit.author.name)
        .replace(/%ae/g, commit.author.email)
        .replace(/%ad/g, new Date(commit.author.timestamp * 1000).toLocaleString()) + '\n'
    );
  }
  let output = `\x1b[33mcommit ${oid}\x1b[0m\n`;
  output += `Author: ${commit.author.name} <${commit.author.email}>\n`;
  output += `Date:   ${new Date(commit.author.timestamp * 1000).toLocaleString()}\n\n`;
  output += `    ${commit.message.replace(/\n/g, '\n    ')}\n\n`;
  return output;
}
