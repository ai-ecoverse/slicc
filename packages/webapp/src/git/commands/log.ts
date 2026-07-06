/** `git log` plus its all-branches, formatting, and per-commit stat helpers. */

import * as git from 'isomorphic-git';
import { parseArgs } from '../../shell/arg-parser.js';
import { diffCommits, diffInitialCommit } from './diff.js';
import { flagString, GIT_FLAG_SPECS } from './shared.js';
import type { GitCommandContext, GitCommandResult } from './types.js';

export async function log(
  ctx: GitCommandContext,
  cwd: string,
  args: string[]
): Promise<GitCommandResult> {
  const { flags } = parseArgs(args, GIT_FLAG_SPECS.log);
  const depth = flagString(flags, 'max-count');
  const oneline = flags.oneline === true;
  const showStat = flags.stat === true;
  const reverse = flags.reverse === true;
  const all = flags.all === true;
  const format = flagString(flags, 'format');
  const authorFilter = flagString(flags, 'author');
  const grepFilter = flagString(flags, 'grep');
  const followFile = flagString(flags, 'follow');

  let commits: Awaited<ReturnType<typeof git.log>>;

  if (all) {
    commits = await logAllBranches(ctx, cwd, depth ? parseInt(depth, 10) : undefined);
  } else {
    commits = await git.log({
      fs: ctx.lfs,
      dir: cwd,
      depth: depth ? parseInt(depth, 10) : 10,
      ...(followFile ? { filepath: followFile, follow: true } : {}),
    });
  }

  // Apply --author filter
  if (authorFilter) {
    commits = commits.filter((e) => e.commit.author.name.includes(authorFilter));
  }

  // Apply --grep filter
  if (grepFilter) {
    commits = commits.filter((e) => e.commit.message.includes(grepFilter));
  }

  if (reverse) {
    commits = commits.slice().reverse();
  }

  let output = '';
  for (const entry of commits) {
    const { commit, oid } = entry;
    if (format) {
      output += formatLogEntry(oid, commit, format) + '\n';
    } else if (oneline) {
      output += `\x1b[33m${oid.slice(0, 7)}\x1b[0m ${commit.message.split('\n')[0]}\n`;
    } else {
      output += `\x1b[33mcommit ${oid}\x1b[0m\n`;
      output += `Author: ${commit.author.name} <${commit.author.email}>\n`;
      output += `Date:   ${new Date(commit.author.timestamp * 1000).toLocaleString()}\n\n`;
      output += `    ${commit.message.replace(/\n/g, '\n    ')}\n\n`;
    }

    if (showStat) {
      output += await logStatForCommit(ctx, cwd, entry);
    }
  }

  return { stdout: output, stderr: '', exitCode: 0 };
}

/**
 * Collect commits from all local branches, dedup by oid, sorted by date descending.
 */
async function logAllBranches(
  ctx: GitCommandContext,
  cwd: string,
  maxCount?: number
): Promise<Awaited<ReturnType<typeof git.log>>> {
  const branches = await git.listBranches({ fs: ctx.lfs, dir: cwd });
  const seen = new Set<string>();
  const allCommits: Awaited<ReturnType<typeof git.log>> = [];

  for (const branch of branches) {
    try {
      const branchCommits = await git.log({
        fs: ctx.lfs,
        dir: cwd,
        ref: branch,
        depth: maxCount ?? 50,
      });
      for (const entry of branchCommits) {
        if (!seen.has(entry.oid)) {
          seen.add(entry.oid);
          allCommits.push(entry);
        }
      }
    } catch {
      // Skip branches that can't be read
    }
  }

  // Sort by timestamp descending (newest first)
  allCommits.sort((a, b) => b.commit.author.timestamp - a.commit.author.timestamp);

  if (maxCount) {
    return allCommits.slice(0, maxCount);
  }
  return allCommits;
}

/**
 * Format a log entry using a format string with placeholders.
 */
function formatLogEntry(oid: string, commit: git.CommitObject, format: string): string {
  const date = new Date(commit.author.timestamp * 1000);
  return format
    .replace(/%H/g, oid)
    .replace(/%h/g, oid.slice(0, 7))
    .replace(/%s/g, commit.message.split('\n')[0])
    .replace(/%an/g, commit.author.name)
    .replace(/%ae/g, commit.author.email)
    .replace(/%ad/g, date.toLocaleString())
    .replace(/%ar/g, relativeDate(date));
}

/**
 * Compute a human-readable relative date string like "2 hours ago".
 */
function relativeDate(date: Date): string {
  const now = Date.now();
  const diffMs = now - date.getTime();
  const seconds = Math.floor(diffMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  const weeks = Math.floor(days / 7);
  const months = Math.floor(days / 30);
  const years = Math.floor(days / 365);

  if (seconds < 60) return `${seconds} seconds ago`;
  if (minutes < 60) return `${minutes} minute${minutes !== 1 ? 's' : ''} ago`;
  if (hours < 24) return `${hours} hour${hours !== 1 ? 's' : ''} ago`;
  if (days < 7) return `${days} day${days !== 1 ? 's' : ''} ago`;
  if (weeks < 4) return `${weeks} week${weeks !== 1 ? 's' : ''} ago`;
  if (months < 12) return `${months} month${months !== 1 ? 's' : ''} ago`;
  return `${years} year${years !== 1 ? 's' : ''} ago`;
}

/**
 * Produce --stat output for a single commit by diffing against its parent.
 */
async function logStatForCommit(
  ctx: GitCommandContext,
  cwd: string,
  entry: Awaited<ReturnType<typeof git.log>>[0]
): Promise<string> {
  const { commit, oid } = entry;
  const parentOid = commit.parent.length > 0 ? commit.parent[0] : undefined;

  if (parentOid) {
    const result = await diffCommits(ctx, cwd, parentOid, oid, { nameOnly: false, stat: true });
    return result.stdout;
  }

  // Initial commit: diff against empty tree
  return await diffInitialCommit(ctx, cwd, oid, true);
}
