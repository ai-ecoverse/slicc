/** `git log` plus its all-branches, formatting, and per-commit stat helpers. */

import * as git from 'isomorphic-git';
import { parseArgs } from '../../shell/arg-parser.js';
import { diffCommits, diffInitialCommit } from './diff.js';
import { logAllBranches, walkAllBranches } from './log-walk.js';
import { flagString, GIT_FLAG_SPECS, type GitParsedFlags } from './shared.js';
import type { GitCommandContext, GitCommandResult } from './types.js';

export async function log(
  ctx: GitCommandContext,
  cwd: string,
  args: string[]
): Promise<GitCommandResult> {
  const { flags: rawFlags, positionals, doubleDashRest } = parseArgs(args, GIT_FLAG_SPECS.log);
  const flags = rawFlags as GitParsedFlags;
  const depth = flagString(flags, 'max-count');
  const oneline = flags.oneline === true;
  const showStat = flags.stat === true;
  const reverse = flags.reverse === true;
  const all = flags.all === true;
  const format = flagString(flags, 'format');
  const authorFilter = flagString(flags, 'author');
  const grepFilter = flagString(flags, 'grep');
  const followFile = flagString(flags, 'follow');

  let commits = await selectCommits(ctx, cwd, {
    all,
    maxCount: depth ? parseInt(depth, 10) : undefined,
    revision: positionals[0],
    pathspecs: doubleDashRest,
    followFile,
  });

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

  const stdout = await renderLog(ctx, cwd, commits, { format, oneline, showStat });
  return { stdout, stderr: '', exitCode: 0 };
}

interface LogSelection {
  all: boolean;
  maxCount?: number;
  revision?: string;
  pathspecs: string[];
  followFile?: string;
}

async function selectCommits(
  ctx: GitCommandContext,
  cwd: string,
  selection: LogSelection
): Promise<Awaited<ReturnType<typeof git.log>>> {
  const range = selection.revision ? splitLogRange(selection.revision) : null;
  const ref = range?.[1] ?? selection.revision;
  const caches = createPathspecCaches(ctx.cache);
  // Historic default for the filtered forms: `git log` itself is unbounded, but
  // the pathspec/range paths have always capped at 10 entries.
  const limit = selection.maxCount ?? 10;

  // Fast path for `log [<ref>] -- <path>…`: isomorphic-git resolves the
  // pathspec component-wise in each commit tree and stops walking as soon as
  // `depth` matching commits are found, so `-n 5` on a 9k-commit branch reads a
  // handful of trees instead of the whole history (#2714).
  if (selection.pathspecs.length > 0 && !selection.all && !range && !selection.followFile) {
    return await logPathspecs(ctx, cwd, { ref, pathspecs: selection.pathspecs, limit, caches });
  }

  // `--all -- <path>…`: filter the traversal AS IT RUNS. Materializing a
  // bounded candidate window first would silently drop a match that a busy
  // branch pushed past the window (#2749 review).
  if (selection.all && selection.pathspecs.length > 0) {
    return await logAllBranchesPathspec(ctx, cwd, {
      pathspecs: selection.pathspecs,
      limit,
      caches,
      exclude: range ? await rangeExclusions(ctx, cwd, range[0], caches) : undefined,
    });
  }

  let commits = selection.all
    ? await logAllBranches(ctx, cwd, {
        limit: selection.maxCount ?? ALL_BRANCHES_DEFAULT_LIMIT,
        cache: caches.git,
      })
    : await git.log({
        fs: ctx.lfs,
        dir: cwd,
        cache: caches.git,
        ...(ref ? { ref } : {}),
        ...(!range && selection.pathspecs.length === 0 ? { depth: selection.maxCount ?? 10 } : {}),
        ...(selection.followFile ? { filepath: selection.followFile, follow: true } : {}),
      });
  if (range) {
    const excludedOids = await rangeExclusions(ctx, cwd, range[0], caches);
    commits = commits.filter((entry) => !excludedOids.has(entry.oid));
  }
  if (selection.pathspecs.length > 0) {
    return await filterByPathspec(ctx, cwd, commits, selection.pathspecs, limit, caches);
  }
  return range ? commits.slice(0, limit) : commits;
}

/**
 * Commits `--all` materializes when `-n` is absent. The per-branch walk it
 * replaced read 50 commits per branch and returned every one of them; 50 total
 * is the same window for a one-branch repo and a bounded one for 29 (#2712).
 */
const ALL_BRANCHES_DEFAULT_LIMIT = 50;

/**
 * How many commits `--all -- <path>…` pulls off the traversal before running a
 * round of pathspec matching. Purely a batching knob — the walk continues
 * until `limit` matches are found or every branch is exhausted — but a batch
 * lets the filter prime its `commit oid -> tree oid` memo from the whole batch,
 * so a commit's first parent is usually resolved without re-reading it.
 */
const ALL_BRANCHES_PATHSPEC_BATCH = 64;

/** The oids `a..b` excludes: everything reachable from `a`. */
async function rangeExclusions(
  ctx: GitCommandContext,
  cwd: string,
  from: string,
  caches: PathspecCaches
): Promise<ReadonlySet<string>> {
  const excluded = await git.log({ fs: ctx.lfs, dir: cwd, cache: caches.git, ref: from });
  return new Set(excluded.map((entry) => entry.oid));
}

/**
 * `git log --all -- <path>…`: filter the all-branches traversal as it runs,
 * stopping at `limit` matches or when every branch is exhausted.
 *
 * There is deliberately NO cap on how many commits get examined. Capping the
 * candidate pool — as both the per-branch `depth: 50` loop and this function's
 * first version did — makes the answer depend on how busy the OTHER branches
 * are: 500 commits on one branch would push another branch's matching tip out
 * of the window and the match would vanish with no diagnostic. Real `git log`
 * walks until it has the matches too.
 */
async function logAllBranchesPathspec(
  ctx: GitCommandContext,
  cwd: string,
  opts: {
    pathspecs: string[];
    limit: number;
    caches: PathspecCaches;
    exclude?: ReadonlySet<string>;
  }
): Promise<Awaited<ReturnType<typeof git.log>>> {
  const matched: Awaited<ReturnType<typeof git.log>> = [];
  let batch: Awaited<ReturnType<typeof git.log>> = [];
  /** Match one batch; true once `limit` matches have been collected. */
  const drain = async (): Promise<boolean> => {
    if (batch.length > 0) {
      const remaining = opts.limit - matched.length;
      matched.push(
        ...(await filterByPathspec(ctx, cwd, batch, opts.pathspecs, remaining, opts.caches))
      );
      batch = [];
    }
    return matched.length >= opts.limit;
  };

  for await (const entry of walkAllBranches(ctx, cwd, { cache: opts.caches.git })) {
    if (opts.exclude?.has(entry.oid)) continue;
    batch.push(entry);
    if (batch.length >= ALL_BRANCHES_PATHSPEC_BATCH && (await drain())) return matched;
  }
  await drain();
  return matched;
}

/**
 * Normalize a pathspec the way `matchesPathspec` (revision.ts) does — strip a
 * leading `./` and any trailing slashes — and additionally fold a bare `.`
 * into the match-everything form. An empty result matches every path.
 */
function normalizePathspec(raw: string): string {
  const trimmed = raw.replace(/^\.\//, '').replace(/\/+$/, '');
  return trimmed === '.' ? '' : trimmed;
}

/** Dedup + normalize; `null` means "one of the specs matches every path". */
function normalizePathspecs(pathspecs: readonly string[]): string[] | null {
  const specs = [...new Set(pathspecs.map(normalizePathspec))];
  return specs.some((spec) => spec === '') ? null : specs;
}

/**
 * Smallest history window `logPathspecsOrdered` materializes per round. Doubles
 * until `limit` matches are found or the branch runs out, so the total commits
 * read stay within ~2x of the window that actually answered the query.
 */
const PATHSPEC_WINDOW_MIN = 32;

/**
 * `git log -- <path>…` on a single ref, bounded by `limit` instead of by the
 * length of the branch.
 */
async function logPathspecs(
  ctx: GitCommandContext,
  cwd: string,
  opts: { ref?: string; pathspecs: string[]; limit: number; caches: PathspecCaches }
): Promise<Awaited<ReturnType<typeof git.log>>> {
  const refArg = opts.ref ? { ref: opts.ref } : {};
  const specs = normalizePathspecs(opts.pathspecs);
  if (specs === null) {
    return await git.log({
      fs: ctx.lfs,
      dir: cwd,
      cache: opts.caches.git,
      ...refArg,
      depth: opts.limit,
    });
  }
  // One spec: hand the whole thing to isomorphic-git, whose own filepath walk
  // resolves the path per commit tree and breaks at `depth` matches. `force`
  // keeps a path that is missing (or deleted) at the tip from throwing, so
  // `log -- does-not-exist` stays empty output rather than an error.
  if (specs.length === 1) {
    const entries = await git.log({
      fs: ctx.lfs,
      dir: cwd,
      cache: opts.caches.git,
      ...refArg,
      filepath: specs[0],
      depth: opts.limit,
      force: true,
    });
    return entries.slice(0, opts.limit);
  }
  return await logPathspecsOrdered(ctx, cwd, {
    refArg,
    specs,
    limit: opts.limit,
    caches: opts.caches,
  });
}

/**
 * Several pathspecs: walk the ref ONCE and keep a commit when any spec's tree
 * entry differs from the first parent's. Unioning per-spec `filepath` walks and
 * re-sorting would be wrong — commit timestamps are not monotonic, and
 * same-second commits would fall back to pathspec-argument order, so
 * `log -- a b` could order (and with `-n`, select) differently from
 * `log -- b a`. The window grows instead of being materialized up front, so a
 * `-n` that is satisfied early never pays for the rest of the branch (#2714).
 */
async function logPathspecsOrdered(
  ctx: GitCommandContext,
  cwd: string,
  opts: { refArg: { ref?: string }; specs: string[]; limit: number; caches: PathspecCaches }
): Promise<Awaited<ReturnType<typeof git.log>>> {
  const matched: Awaited<ReturnType<typeof git.log>> = [];
  let examined = 0;
  let window = Math.max(opts.limit * 4, PATHSPEC_WINDOW_MIN);
  for (;;) {
    const entries = await git.log({
      fs: ctx.lfs,
      dir: cwd,
      cache: opts.caches.git,
      ...opts.refArg,
      depth: window,
    });
    for (const entry of entries) opts.caches.commitTrees.set(entry.oid, entry.commit.tree);
    for (const entry of entries.slice(examined)) {
      if (await commitTouchesPathspec(ctx, cwd, entry, opts.specs, opts.caches)) {
        matched.push(entry);
        if (matched.length >= opts.limit) return matched;
      }
    }
    // `git.log` returns exactly `depth` entries while history remains, so a
    // short answer means the branch is exhausted.
    if (entries.length < window) return matched;
    examined = entries.length;
    window *= 2;
  }
}

/**
 * Filter an already-materialized commit list (`--all`, `a..b`) by pathspec.
 * Sequential and short-circuiting: never fan thousands of tree reads out at
 * once, and stop as soon as `limit` matches are found (#2714).
 */
async function filterByPathspec(
  ctx: GitCommandContext,
  cwd: string,
  commits: Awaited<ReturnType<typeof git.log>>,
  pathspecs: string[],
  limit: number,
  caches: PathspecCaches
): Promise<Awaited<ReturnType<typeof git.log>>> {
  const specs = normalizePathspecs(pathspecs);
  if (specs === null) return commits.slice(0, limit);
  for (const entry of commits) caches.commitTrees.set(entry.oid, entry.commit.tree);
  const matched: Awaited<ReturnType<typeof git.log>> = [];
  for (const entry of commits) {
    if (await commitTouchesPathspec(ctx, cwd, entry, specs, caches)) matched.push(entry);
    if (matched.length >= limit) break;
  }
  return matched;
}

async function renderLog(
  ctx: GitCommandContext,
  cwd: string,
  commits: Awaited<ReturnType<typeof git.log>>,
  opts: { format?: string; oneline: boolean; showStat: boolean }
): Promise<string> {
  let output = '';
  for (const entry of commits) {
    const { commit, oid } = entry;
    if (opts.format) output += `${formatLogEntry(oid, commit, opts.format)}\n`;
    else if (opts.oneline) {
      output += `\x1b[33m${oid.slice(0, 7)}\x1b[0m ${commit.message.split('\n')[0]}\n`;
    } else {
      output += `\x1b[33mcommit ${oid}\x1b[0m\n`;
      output += `Author: ${commit.author.name} <${commit.author.email}>\n`;
      output += `Date:   ${new Date(commit.author.timestamp * 1000).toLocaleString()}\n\n`;
      output += `    ${commit.message.replace(/\n/g, '\n    ')}\n\n`;
    }
    if (opts.showStat) output += await logStatForCommit(ctx, cwd, entry);
  }
  return output;
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

function splitLogRange(value: string): [string, string] | null {
  const match = /^(.+)\.\.([^.]*)$/.exec(value);
  return match?.[2] ? [match[1], match[2]] : null;
}

/** Per-command memo tables for the pathspec tree lookups. */
interface PathspecCaches {
  /**
   * The instance-wide isomorphic-git object/pack cache (`ctx.cache`, #2710) —
   * shared across every call in this command AND across commands.
   */
  git: object;
  /** commit oid -> tree oid. */
  commitTrees: Map<string, string>;
  /** tree oid -> its entries. */
  trees: Map<string, git.TreeEntry[]>;
  /** `<tree oid>\0<pathspec>` -> the oid that path resolves to, if any. */
  entries: Map<string, string | undefined>;
}

function createPathspecCaches(gitCache: object): PathspecCaches {
  return { git: gitCache, commitTrees: new Map(), trees: new Map(), entries: new Map() };
}

async function readTreeCached(
  ctx: GitCommandContext,
  cwd: string,
  oid: string,
  caches: PathspecCaches
): Promise<git.TreeEntry[]> {
  const hit = caches.trees.get(oid);
  if (hit) return hit;
  const { tree } = await git.readTree({ fs: ctx.lfs, dir: cwd, oid, cache: caches.git });
  caches.trees.set(oid, tree);
  return tree;
}

async function commitTreeOid(
  ctx: GitCommandContext,
  cwd: string,
  oid: string,
  caches: PathspecCaches
): Promise<string> {
  const hit = caches.commitTrees.get(oid);
  if (hit) return hit;
  const { commit } = await git.readCommit({ fs: ctx.lfs, dir: cwd, oid, cache: caches.git });
  caches.commitTrees.set(oid, commit.tree);
  return commit.tree;
}

/**
 * Resolve a pathspec inside a tree one component at a time, returning the oid
 * the path points at (a blob oid for a file, a tree oid for a directory) or
 * `undefined` when the path is absent. Cheap compared to walking whole trees:
 * one `readTree` per path component, memoized across commits.
 */
async function pathEntryOid(
  ctx: GitCommandContext,
  cwd: string,
  treeOid: string,
  spec: string,
  caches: PathspecCaches
): Promise<string | undefined> {
  const key = `${treeOid}\u0000${spec}`;
  if (caches.entries.has(key)) return caches.entries.get(key);
  const parts = spec.split('/');
  let current: string | undefined = treeOid;
  let result: string | undefined;
  for (let i = 0; i < parts.length; i++) {
    if (current === undefined) break;
    const entries: git.TreeEntry[] = await readTreeCached(ctx, cwd, current, caches);
    const match = entries.find((item) => item.path === parts[i]);
    if (!match) break;
    if (i === parts.length - 1) {
      result = match.oid;
      break;
    }
    current = match.type === 'tree' ? match.oid : undefined;
  }
  caches.entries.set(key, result);
  return result;
}

/**
 * True when the commit changed anything under one of the pathspecs, decided by
 * comparing the pathspec's tree entry oid against the first parent's. A
 * directory's tree oid changes exactly when something below it changes, so this
 * matches the old whole-tree walk without reading the trees it did not need.
 */
async function commitTouchesPathspec(
  ctx: GitCommandContext,
  cwd: string,
  entry: Awaited<ReturnType<typeof git.log>>[0],
  specs: readonly string[],
  caches: PathspecCaches
): Promise<boolean> {
  const parent = entry.commit.parent[0];
  const parentTree = parent ? await commitTreeOid(ctx, cwd, parent, caches) : undefined;
  for (const spec of specs) {
    const current = await pathEntryOid(ctx, cwd, entry.commit.tree, spec, caches);
    const previous =
      parentTree === undefined ? undefined : await pathEntryOid(ctx, cwd, parentTree, spec, caches);
    if (current !== previous) return true;
  }
  return false;
}
