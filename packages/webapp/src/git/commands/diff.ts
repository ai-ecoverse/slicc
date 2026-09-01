/**
 * `git diff` and the shared commit-diff helpers.
 *
 * `diffCommits` and `diffInitialCommit` are exported because `log`, `show`, and
 * `stash` all render diffs against a commit; the workdir/staged collectors and
 * the stat formatter stay module-local.
 */

import * as git from 'isomorphic-git';
import { parseArgs } from '../../shell/arg-parser.js';
import { diffStat, unifiedDiff } from '../diff.js';
import { matchesPathspec, pathspecCouldMatch, resolveRevision } from './revision.js';
import { GIT_FLAG_SPECS, NO_INDEX_REFRESH } from './shared.js';
import type { GitCommandContext, GitCommandResult } from './types.js';

type FileChange = { filepath: string; oldContent: string; newContent: string };

/**
 * Decides whether a walk should descend into a child path.
 *
 * `present[i]` says whether tree `i` of the walk has that path at all, so a
 * caller can drop e.g. everything the index does not know about.
 */
type KeepChild = (filepath: string, present: readonly boolean[]) => boolean;

/**
 * A `walk({ iterate })` hook that drops subtrees *before* isomorphic-git
 * constructs their entries.
 *
 * Pruning from `map` is too late: `walk()` calls `readdir()` on every child —
 * which for the WORKDIR walker means an `lstat` (one hostfs round trip on a
 * mounted repo) — and only *then* calls `map`. Filtering here, from the path
 * string alone, means an excluded subtree costs nothing at all (#2719).
 *
 * `children` yields one raw path per walk tree (undefined where that tree has
 * no such entry); the entries are only constructed inside `walk`.
 */
function pruningIterate(keep: KeepChild): git.WalkerIterate {
  return (walk, children) => {
    const walked: Promise<unknown>[] = [];
    for (const child of children as unknown as Iterable<unknown[]>) {
      const filepath = child.find((path): path is string => typeof path === 'string');
      const present = child.map((path) => typeof path === 'string');
      if (filepath === undefined || keep(filepath, present)) {
        walked.push(walk(child as unknown as git.WalkerEntry[]));
      }
    }
    return Promise.all(walked);
  };
}

export async function diff(
  ctx: GitCommandContext,
  cwd: string,
  args: string[]
): Promise<GitCommandResult> {
  const { flags, positionals, doubleDashRest } = parseArgs(args, GIT_FLAG_SPECS.diff);
  const staged = flags.staged === true || flags.cached === true;
  const opts = {
    nameOnly: flags['name-only'] === true,
    stat: flags.stat === true,
    pathspecs: doubleDashRest,
  };

  if (positionals.length >= 2) {
    return diffCommits(ctx, cwd, positionals[0], positionals[1], opts);
  }
  if (positionals.length === 1) {
    const range = splitTwoDotRange(positionals[0]);
    if (range) return diffCommits(ctx, cwd, range[0], range[1], opts);
    if (staged) return diffCommitIndex(ctx, cwd, positionals[0], opts);
    return diffCommitWorkdir(ctx, cwd, positionals[0], opts);
  }

  const changes = staged
    ? await diffStagedChanges(ctx, cwd, opts.pathspecs)
    : await diffWorkdirChanges(ctx, cwd, opts.pathspecs);

  if (changes.length === 0) {
    return { stdout: '', stderr: '', exitCode: 0 };
  }

  if (opts.nameOnly) {
    const output = changes.map((c) => c.filepath).join('\n') + '\n';
    return { stdout: output, stderr: '', exitCode: 0 };
  }

  if (opts.stat) {
    return formatDiffStat(changes);
  }

  // Full unified diff
  let output = '';
  for (const change of changes) {
    output += unifiedDiff({
      oldContent: change.oldContent,
      newContent: change.newContent,
      oldName: change.filepath,
      newName: change.filepath,
    });
  }

  return { stdout: output, stderr: '', exitCode: 0 };
}

/** Collect staged changes by comparing a commit tree vs index. */
async function diffStagedChanges(
  ctx: GitCommandContext,
  cwd: string,
  pathspecs: string[] = [],
  ref = 'HEAD'
): Promise<FileChange[]> {
  const changes: FileChange[] = [];
  const cache = {};

  await git.walk({
    fs: ctx.lfs,
    dir: cwd,
    cache,
    trees: [git.TREE({ ref }), git.STAGE()],
    // A pathspec-excluded subtree is dropped before its tree object is read.
    iterate: pruningIterate((filepath) => pathspecCouldMatch(filepath, pathspecs)),
    map: async (filepath, [headEntry, stageEntry]) => {
      // `.git` itself is never tracked; a tracked `.gitignore` is.
      if (filepath === '.' || filepath === '.git' || filepath.startsWith('.git/')) return undefined;
      if (!matchesPathspec(filepath, pathspecs)) return undefined;
      const headType = headEntry ? await headEntry.type() : undefined;
      const stageType = stageEntry ? await stageEntry.type() : undefined;
      if (headType === 'tree' || stageType === 'tree') return undefined;

      const headOid = headEntry ? await headEntry.oid() : undefined;
      const stageOid = stageEntry ? await stageEntry.oid() : undefined;
      // Unchanged between the tree and the index: no object read at all.
      if (headOid === stageOid) return undefined;

      const oldText = await readBlobText(ctx, cwd, headOid, cache);
      const newText = await readBlobText(ctx, cwd, stageOid, cache);

      changes.push({ filepath, oldContent: oldText, newContent: newText });
      return undefined;
    },
  });

  return changes;
}

async function diffCommitIndex(
  ctx: GitCommandContext,
  cwd: string,
  ref: string,
  opts: { nameOnly: boolean; stat: boolean; pathspecs?: string[] }
): Promise<GitCommandResult> {
  let resolved: string;
  try {
    resolved = await resolveRevision(ctx, cwd, ref);
  } catch {
    return ambiguousRevision(ref);
  }
  const changes = await diffStagedChanges(ctx, cwd, opts.pathspecs, resolved);
  return formatChanges(changes, opts);
}

/**
 * Collect unstaged changes by comparing index vs workdir.
 *
 * The workdir bytes of a tracked file are read exactly once and hashed with
 * `git.hashBlob`; the object store is only touched for paths whose hash differs
 * from the index OID. A clean working tree therefore reads zero blobs — the
 * previous implementation pulled *every* tracked blob out of the packfile and
 * compared the decoded strings (#2719).
 *
 * Untracked and pathspec-excluded subtrees are dropped by `iterate` before the
 * workdir walker can `lstat` them, so `node_modules` / `.git` are never
 * enumerated and `git diff -- <path>` costs what that path costs.
 * `NO_INDEX_REFRESH` keeps this read-only command from rewriting `.git/index`
 * (#2708).
 */
async function diffWorkdirChanges(
  ctx: GitCommandContext,
  cwd: string,
  pathspecs: string[] = []
): Promise<FileChange[]> {
  const changes: FileChange[] = [];
  const cache = {};

  await git.walk({
    fs: ctx.lfs,
    dir: cwd,
    cache,
    trees: [git.STAGE(), git.WORKDIR(NO_INDEX_REFRESH)],
    // Untracked paths (`.git`, `node_modules`, …) and anything a pathspec
    // rules out are dropped here, before the workdir walker would `lstat`
    // them: `git diff -- one/file.txt` must not stat the whole tree.
    iterate: pruningIterate(
      (filepath, [inIndex]) => inIndex === true && pathspecCouldMatch(filepath, pathspecs)
    ),
    map: async (filepath, [stageEntry, workEntry]) => {
      if (filepath === '.') return undefined;
      if (!stageEntry) return null;
      const stageType = await stageEntry.type();
      if (stageType === 'tree') return undefined;
      // Gitlinks and other non-blob entries have no text to diff.
      if (stageType !== 'blob') return null;
      // Pathspecs are applied before any I/O.
      if (!matchesPathspec(filepath, pathspecs)) return null;

      const stageOid = await stageEntry.oid();
      const workBytes = await readWorkdirBytes(workEntry);
      // Unmodified: the workdir hash matches the index OID, so the blob never
      // has to be read out of the pack.
      if (workBytes && stageOid && (await git.hashBlob({ object: workBytes })).oid === stageOid) {
        return null;
      }

      const oldContent = await readBlobText(ctx, cwd, stageOid, cache);
      const newContent = workBytes ? new TextDecoder().decode(workBytes) : '';
      if (oldContent !== newContent) changes.push({ filepath, oldContent, newContent });
      return null;
    },
  });

  // The walk visits siblings concurrently; sort so the output is stable.
  changes.sort((a, b) => (a.filepath < b.filepath ? -1 : a.filepath > b.filepath ? 1 : 0));
  return changes;
}

/**
 * Workdir bytes for a walker entry, or undefined when the path is gone,
 * unreadable, or not a file (`git diff` renders those as a deletion).
 */
async function readWorkdirBytes(entry: git.WalkerEntry | null): Promise<Uint8Array | undefined> {
  if (!entry) return undefined;
  try {
    if ((await entry.type()) !== 'blob') return undefined;
    return (await entry.content()) ?? undefined;
  } catch {
    return undefined;
  }
}

/** Read a blob as text by OID, returning empty string if OID is undefined or unreadable. */
async function readBlobText(
  ctx: GitCommandContext,
  cwd: string,
  oid: string | undefined,
  cache?: object
): Promise<string> {
  if (!oid) return '';
  try {
    const { blob } = await git.readBlob({ fs: ctx.lfs, dir: cwd, oid, cache });
    return new TextDecoder().decode(blob);
  } catch {
    return '';
  }
}

export async function diffCommits(
  ctx: GitCommandContext,
  cwd: string,
  ref1: string,
  ref2: string,
  opts: { nameOnly: boolean; stat: boolean; pathspecs?: string[] }
): Promise<GitCommandResult> {
  try {
    const resolvedRef1 = await resolveRevision(ctx, cwd, ref1);
    const resolvedRef2 = await resolveRevision(ctx, cwd, ref2);
    return await diffResolvedTrees(ctx, cwd, resolvedRef1, resolvedRef2, opts);
  } catch {
    const invalid = await firstInvalidRef(ctx, cwd, [ref1, ref2]);
    return ambiguousRevision(invalid ?? ref1);
  }
}

async function diffResolvedTrees(
  ctx: GitCommandContext,
  cwd: string,
  resolvedRef1: string,
  resolvedRef2: string,
  opts: { nameOnly: boolean; stat: boolean; pathspecs?: string[] }
): Promise<GitCommandResult> {
  const changes: FileChange[] = [];

  await git.walk({
    fs: ctx.lfs,
    dir: cwd,
    cache: {},
    trees: [git.TREE({ ref: resolvedRef1 }), git.TREE({ ref: resolvedRef2 })],
    iterate: pruningIterate((filepath) => pathspecCouldMatch(filepath, opts.pathspecs ?? [])),
    map: async (filepath, [entry1, entry2]) => {
      // Identical subtrees share an OID: prune instead of reading every tree
      // object below them.
      if (await isIdenticalSubtree(entry1, entry2)) return null;
      const change = await compareWalkerEntries(filepath, entry1, entry2, opts.pathspecs ?? []);
      if (change) changes.push(change);
      return undefined;
    },
  });

  return formatChanges(changes, opts);
}

async function diffCommitWorkdir(
  ctx: GitCommandContext,
  cwd: string,
  ref: string,
  opts: { nameOnly: boolean; stat: boolean; pathspecs?: string[] }
): Promise<GitCommandResult> {
  let resolved: string;
  try {
    resolved = await resolveRevision(ctx, cwd, ref);
  } catch {
    return ambiguousRevision(ref);
  }
  const cache = {};
  const tracked = new Set<string>(await git.listFiles({ fs: ctx.lfs, dir: cwd, cache }));
  const trackedDirs = ancestorDirs(tracked);
  const changes: FileChange[] = [];
  await git.walk({
    fs: ctx.lfs,
    dir: cwd,
    cache,
    // NO_INDEX_REFRESH: a read-only diff must not rewrite `.git/index` (#2708).
    trees: [git.TREE({ ref: resolved }), git.WORKDIR(NO_INDEX_REFRESH)],
    // Same pre-`lstat` pruning as `git diff`: untracked paths (nothing in the
    // commit and nothing in the index below them) and pathspec-excluded
    // subtrees never reach the workdir walker.
    iterate: pruningIterate(
      (filepath, [inCommit]) =>
        (inCommit === true || tracked.has(filepath) || trackedDirs.has(filepath)) &&
        pathspecCouldMatch(filepath, opts.pathspecs ?? [])
    ),
    map: async (filepath, [oldEntry, workEntry]) => {
      if (!oldEntry && !tracked.has(filepath) && !trackedDirs.has(filepath)) return null;
      const change = await compareWalkerEntries(
        filepath,
        oldEntry,
        workEntry,
        opts.pathspecs ?? []
      );
      if (change) changes.push(change);
      return undefined;
    },
  });
  return formatChanges(changes, opts);
}

/** Every directory that has at least one tracked file below it. */
function ancestorDirs(files: Iterable<string>): Set<string> {
  const dirs = new Set<string>();
  for (const file of files) {
    let slash = file.indexOf('/');
    while (slash > 0) {
      dirs.add(file.slice(0, slash));
      slash = file.indexOf('/', slash + 1);
    }
  }
  return dirs;
}

/** True when both entries are trees with the same OID (identical subtrees). */
async function isIdenticalSubtree(
  entry1: git.WalkerEntry | null,
  entry2: git.WalkerEntry | null
): Promise<boolean> {
  if (!entry1 || !entry2) return false;
  if ((await entry1.type()) !== 'tree' || (await entry2.type()) !== 'tree') return false;
  const oid1 = await entry1.oid();
  return Boolean(oid1) && oid1 === (await entry2.oid());
}

async function compareWalkerEntries(
  filepath: string,
  oldEntry: git.WalkerEntry | null,
  newEntry: git.WalkerEntry | null,
  pathspecs: string[]
): Promise<FileChange | null> {
  if (filepath === '.' || !matchesPathspec(filepath, pathspecs)) return null;
  const oldType = oldEntry ? await oldEntry.type() : undefined;
  const newType = newEntry ? await newEntry.type() : undefined;
  if (oldType === 'tree' || newType === 'tree') return null;
  const oldOid = oldEntry ? await oldEntry.oid() : undefined;
  const newOid = newEntry ? await newEntry.oid() : undefined;
  if (oldOid === newOid) return null;
  const oldContent = oldEntry ? await oldEntry.content() : undefined;
  const newContent = newEntry ? await newEntry.content() : undefined;
  return {
    filepath,
    oldContent: oldContent ? new TextDecoder().decode(oldContent) : '',
    newContent: newContent ? new TextDecoder().decode(newContent) : '',
  };
}

function formatChanges(
  changes: FileChange[],
  opts: { nameOnly: boolean; stat: boolean }
): GitCommandResult {
  if (changes.length === 0) return { stdout: '', stderr: '', exitCode: 0 };
  if (opts.nameOnly) {
    return { stdout: `${changes.map((c) => c.filepath).join('\n')}\n`, stderr: '', exitCode: 0 };
  }
  if (opts.stat) return formatDiffStat(changes);
  const stdout = changes
    .map((change) =>
      unifiedDiff({
        oldContent: change.oldContent,
        newContent: change.newContent,
        oldName: change.filepath,
        newName: change.filepath,
      })
    )
    .join('');
  return { stdout, stderr: '', exitCode: 0 };
}

function splitTwoDotRange(value: string): [string, string] | null {
  const match = /^(.+)\.\.([^.]*)$/.exec(value);
  return match?.[2] ? [match[1], match[2]] : null;
}

async function firstInvalidRef(
  ctx: GitCommandContext,
  cwd: string,
  refs: string[]
): Promise<string | null> {
  for (const ref of refs) {
    try {
      await resolveRevision(ctx, cwd, ref);
    } catch {
      return ref;
    }
  }
  return null;
}

function ambiguousRevision(ref: string): GitCommandResult {
  return { stdout: '', stderr: `fatal: ambiguous argument '${ref}'\n`, exitCode: 128 };
}

function formatDiffStat(
  changes: { filepath: string; oldContent: string; newContent: string }[]
): GitCommandResult {
  const RED = '\x1b[31m';
  const GREEN = '\x1b[32m';
  const RESET = '\x1b[0m';

  let output = '';
  let totalInsertions = 0;
  let totalDeletions = 0;
  let maxNameLen = 0;

  const stats = changes.map((c) => {
    const s = diffStat(c.oldContent, c.newContent);
    if (c.filepath.length > maxNameLen) maxNameLen = c.filepath.length;
    totalInsertions += s.insertions;
    totalDeletions += s.deletions;
    return { filepath: c.filepath, ...s };
  });

  for (const s of stats) {
    const total = s.insertions + s.deletions;
    const bar = `${GREEN}${'+'.repeat(s.insertions)}${RESET}${RED}${'-'.repeat(s.deletions)}${RESET}`;
    output += ` ${s.filepath.padEnd(maxNameLen)} | ${String(total).padStart(4)} ${bar}\n`;
  }

  output += ` ${changes.length} file${changes.length !== 1 ? 's' : ''} changed`;
  if (totalInsertions > 0)
    output += `, ${totalInsertions} insertion${totalInsertions !== 1 ? 's' : ''}(+)`;
  if (totalDeletions > 0)
    output += `, ${totalDeletions} deletion${totalDeletions !== 1 ? 's' : ''}(-)`;
  output += '\n';

  return { stdout: output, stderr: '', exitCode: 0 };
}

export async function diffInitialCommit(
  ctx: GitCommandContext,
  cwd: string,
  commitOid: string,
  stat: boolean
): Promise<string> {
  type FileEntry = { filepath: string; content: string };
  const files: FileEntry[] = [];

  await git.walk({
    fs: ctx.lfs,
    dir: cwd,
    trees: [git.TREE({ ref: commitOid })],
    map: async (filepath, [entry]) => {
      if (filepath === '.' || !entry) return undefined;
      const type = await entry.type();
      if (type !== 'blob') return undefined;
      const content = await entry.content();
      if (!content) return undefined;
      files.push({ filepath, content: new TextDecoder().decode(content) });
      return undefined;
    },
  });

  if (files.length === 0) return '';

  if (stat) {
    const changes = files.map((f) => ({
      filepath: f.filepath,
      oldContent: '',
      newContent: f.content,
    }));
    return formatDiffStat(changes).stdout;
  }

  let output = '';
  for (const file of files) {
    output += unifiedDiff({
      oldContent: '',
      newContent: file.content,
      oldName: file.filepath,
      newName: file.filepath,
    });
  }
  return output;
}
