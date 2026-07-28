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
import { matchesPathspec, resolveRevision } from './revision.js';
import { GIT_FLAG_SPECS } from './shared.js';
import type { GitCommandContext, GitCommandResult } from './types.js';

type FileChange = { filepath: string; oldContent: string; newContent: string };

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

/** Collect staged changes by comparing HEAD tree vs index. */
async function diffStagedChanges(
  ctx: GitCommandContext,
  cwd: string,
  pathspecs: string[] = []
): Promise<FileChange[]> {
  const changes: FileChange[] = [];

  await git.walk({
    fs: ctx.lfs,
    dir: cwd,
    trees: [git.TREE({ ref: 'HEAD' }), git.STAGE()],
    map: async (filepath, [headEntry, stageEntry]) => {
      if (filepath === '.' || filepath.startsWith('.git')) return undefined;
      if (!matchesPathspec(filepath, pathspecs)) return undefined;
      const headType = headEntry ? await headEntry.type() : undefined;
      const stageType = stageEntry ? await stageEntry.type() : undefined;
      if (headType === 'tree' || stageType === 'tree') return undefined;

      const headOid = headEntry ? await headEntry.oid() : undefined;
      const stageOid = stageEntry ? await stageEntry.oid() : undefined;
      if (headOid === stageOid) return undefined;

      const oldText = await readBlobText(ctx, cwd, headOid);
      const newText = await readBlobText(ctx, cwd, stageOid);

      changes.push({ filepath, oldContent: oldText, newContent: newText });
      return undefined;
    },
  });

  return changes;
}

/** Collect unstaged changes by comparing index vs workdir. */
async function diffWorkdirChanges(
  ctx: GitCommandContext,
  cwd: string,
  pathspecs: string[] = []
): Promise<FileChange[]> {
  const changes: FileChange[] = [];

  // Collect all index entries with their OIDs
  const indexEntries = new Map<string, string>();
  await git.walk({
    fs: ctx.lfs,
    dir: cwd,
    trees: [git.STAGE()],
    map: async (filepath, [entry]) => {
      if (filepath === '.' || filepath.startsWith('.git') || !entry) return undefined;
      const type = await entry.type();
      if (type !== 'blob') return undefined;
      const oid = await entry.oid();
      if (oid) indexEntries.set(filepath, oid);
      return undefined;
    },
  });

  // Compare each index entry with workdir content directly
  for (const [file, stageOid] of indexEntries) {
    if (!matchesPathspec(file, pathspecs)) continue;
    const oldText = await readBlobText(ctx, cwd, stageOid);

    let newText = '';
    try {
      newText = await ctx.fs.readTextFile(`${cwd}/${file}`);
    } catch {
      /* file deleted in workdir */
    }

    if (oldText !== newText) {
      changes.push({ filepath: file, oldContent: oldText, newContent: newText });
    }
  }

  return changes;
}

/** Read a blob as text by OID, returning empty string if OID is undefined or unreadable. */
async function readBlobText(
  ctx: GitCommandContext,
  cwd: string,
  oid: string | undefined
): Promise<string> {
  if (!oid) return '';
  try {
    const { blob } = await git.readBlob({ fs: ctx.lfs, dir: cwd, oid });
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
    trees: [git.TREE({ ref: resolvedRef1 }), git.TREE({ ref: resolvedRef2 })],
    map: async (filepath, [entry1, entry2]) => {
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
  const tracked = new Set(await git.listFiles({ fs: ctx.lfs, dir: cwd }));
  const changes: FileChange[] = [];
  await git.walk({
    fs: ctx.lfs,
    dir: cwd,
    trees: [git.TREE({ ref: resolved }), git.WORKDIR()],
    map: async (filepath, [oldEntry, workEntry]) => {
      if (!oldEntry && !tracked.has(filepath)) return undefined;
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
