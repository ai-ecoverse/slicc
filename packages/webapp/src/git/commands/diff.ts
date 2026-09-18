import * as git from 'isomorphic-git';
import type { ArgFlagValue } from '../../shell/arg-parser.js';
import { parseArgs } from '../../shell/arg-parser.js';
import { formatDiffStatText, unifiedDiff } from '../diff.js';
import { diffNoIndex } from './diff-no-index.js';
import { matchesPathspec, pathspecCouldMatch, resolveRevision } from './revision.js';
import { GIT_FLAG_SPECS, NO_INDEX_REFRESH, rejectUnknownGitFlags } from './shared.js';
import type { GitCommandContext, GitCommandResult } from './types.js';

type FileChange = {
  filepath: string;
  oldContent: string;
  newContent: string;

  oldPresent?: boolean;

  newPresent?: boolean;
};

interface DiffFormatOptions {
  nameOnly: boolean;
  nameStatus?: boolean;
  stat: boolean;
  pathspecs?: string[];

  context?: number;
}

type KeepChild = (filepath: string, present: readonly boolean[]) => boolean;

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
  const normalized = normalizeUnifiedFlag(args);
  const unknown = rejectUnknownGitFlags(normalized, GIT_FLAG_SPECS.diff);
  if (unknown) return unknown;

  const { flags, positionals, doubleDashRest } = parseArgs(normalized, GIT_FLAG_SPECS.diff);
  const staged = flags.staged === true || flags.cached === true;
  const extraPathspecs = positionals.length >= 2 ? positionals.slice(2) : [];
  const opts: DiffFormatOptions = {
    nameOnly: flags['name-only'] === true,
    nameStatus: flags['name-status'] === true,
    stat: flags.stat === true,
    pathspecs: [...extraPathspecs, ...doubleDashRest],
    context: parseContext(flags.unified),
  };

  if (flags['no-index'] === true || flags.index === false) {
    return diffNoIndex(ctx, cwd, positionals, opts);
  }

  if (positionals.length >= 2) {
    return diffCommits(ctx, cwd, positionals[0], positionals[1], opts);
  }
  if (positionals.length === 1) {
    const threeDot = splitThreeDotRange(positionals[0]);
    if (threeDot) return diffThreeDot(ctx, cwd, threeDot[0], threeDot[1], opts);
    const range = splitTwoDotRange(positionals[0]);
    if (range) return diffCommits(ctx, cwd, range[0], range[1], opts);
    if (staged) return diffCommitIndex(ctx, cwd, positionals[0], opts);
    return diffCommitWorkdir(ctx, cwd, positionals[0], opts);
  }

  const changes = staged
    ? await diffStagedChanges(ctx, cwd, opts.pathspecs)
    : await diffWorkdirChanges(ctx, cwd, opts.pathspecs);
  return formatChanges(ctx, changes, opts);
}

async function diffStagedChanges(
  ctx: GitCommandContext,
  cwd: string,
  pathspecs: string[] = [],
  ref = 'HEAD'
): Promise<FileChange[]> {
  const changes: FileChange[] = [];

  await git.walk({
    fs: ctx.lfs,
    cache: ctx.cache,
    dir: cwd,
    trees: [git.TREE({ ref }), git.STAGE()],

    iterate: pruningIterate((filepath) => pathspecCouldMatch(filepath, pathspecs)),
    map: async (filepath, [headEntry, stageEntry]) => {
      if (filepath === '.' || filepath === '.git' || filepath.startsWith('.git/')) return undefined;
      if (!matchesPathspec(filepath, pathspecs)) return undefined;
      const headType = headEntry ? await headEntry.type() : undefined;
      const stageType = stageEntry ? await stageEntry.type() : undefined;
      if (headType === 'tree' || stageType === 'tree') return undefined;

      const headOid = headEntry ? await headEntry.oid() : undefined;
      const stageOid = stageEntry ? await stageEntry.oid() : undefined;

      if (headOid === stageOid) return undefined;

      const oldText = await readBlobText(ctx, cwd, headOid);
      const newText = await readBlobText(ctx, cwd, stageOid);

      changes.push({
        filepath,
        oldContent: oldText,
        newContent: newText,
        oldPresent: Boolean(headOid),
        newPresent: Boolean(stageOid),
      });
      return undefined;
    },
  });

  return changes;
}

async function diffCommitIndex(
  ctx: GitCommandContext,
  cwd: string,
  ref: string,
  opts: DiffFormatOptions
): Promise<GitCommandResult> {
  let resolved: string;
  try {
    resolved = await resolveRevision(ctx, cwd, ref);
  } catch {
    return ambiguousRevision(ref);
  }
  const changes = await diffStagedChanges(ctx, cwd, opts.pathspecs, resolved);
  return formatChanges(ctx, changes, opts);
}

async function diffWorkdirChanges(
  ctx: GitCommandContext,
  cwd: string,
  pathspecs: string[] = []
): Promise<FileChange[]> {
  const changes: FileChange[] = [];

  await git.walk({
    fs: ctx.lfs,
    cache: ctx.cache,
    dir: cwd,
    trees: [git.STAGE(), git.WORKDIR(NO_INDEX_REFRESH)],

    iterate: pruningIterate(
      (filepath, [inIndex]) => inIndex === true && pathspecCouldMatch(filepath, pathspecs)
    ),
    map: async (filepath, [stageEntry, workEntry]) => {
      if (filepath === '.') return undefined;
      if (!stageEntry) return null;
      const stageType = await stageEntry.type();
      if (stageType === 'tree') return undefined;

      if (stageType !== 'blob') return null;

      if (!matchesPathspec(filepath, pathspecs)) return null;

      const stageOid = await stageEntry.oid();
      const workBytes = await readWorkdirBytes(workEntry);

      if (workBytes && stageOid && (await git.hashBlob({ object: workBytes })).oid === stageOid) {
        return null;
      }

      const oldContent = await readBlobText(ctx, cwd, stageOid);
      const newContent = workBytes ? new TextDecoder().decode(workBytes) : '';
      if (oldContent !== newContent) {
        changes.push({
          filepath,
          oldContent,
          newContent,
          oldPresent: Boolean(stageOid),
          newPresent: Boolean(workBytes),
        });
      }
      return null;
    },
  });

  changes.sort((a, b) => (a.filepath < b.filepath ? -1 : a.filepath > b.filepath ? 1 : 0));
  return changes;
}

async function readWorkdirBytes(entry: git.WalkerEntry | null): Promise<Uint8Array | undefined> {
  if (!entry) return undefined;
  try {
    if ((await entry.type()) !== 'blob') return undefined;
    return (await entry.content()) ?? undefined;
  } catch {
    return undefined;
  }
}

async function readBlobText(
  ctx: GitCommandContext,
  cwd: string,
  oid: string | undefined
): Promise<string> {
  if (!oid) return '';
  try {
    const { blob } = await git.readBlob({ fs: ctx.lfs, dir: cwd, oid, cache: ctx.cache });
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
  opts: DiffFormatOptions
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

async function diffThreeDot(
  ctx: GitCommandContext,
  cwd: string,
  ref1: string,
  ref2: string,
  opts: DiffFormatOptions
): Promise<GitCommandResult> {
  const left = ref1 || 'HEAD';
  const right = ref2 || 'HEAD';
  try {
    const oidA = await resolveRevision(ctx, cwd, left);
    const oidB = await resolveRevision(ctx, cwd, right);
    const bases = await git.findMergeBase({
      fs: ctx.lfs,
      cache: ctx.cache,
      dir: cwd,
      oids: [oidA, oidB],
    });
    if (!bases[0]) {
      return {
        stdout: '',
        stderr: `fatal: '${left}...${right}' has no merge base\n`,
        exitCode: 128,
      };
    }
    return await diffResolvedTrees(ctx, cwd, bases[0], oidB, opts);
  } catch {
    const invalid = await firstInvalidRef(ctx, cwd, [left, right]);
    return ambiguousRevision(invalid ?? left);
  }
}

async function diffResolvedTrees(
  ctx: GitCommandContext,
  cwd: string,
  resolvedRef1: string,
  resolvedRef2: string,
  opts: DiffFormatOptions
): Promise<GitCommandResult> {
  const changes: FileChange[] = [];

  await git.walk({
    fs: ctx.lfs,
    cache: ctx.cache,
    dir: cwd,
    trees: [git.TREE({ ref: resolvedRef1 }), git.TREE({ ref: resolvedRef2 })],
    iterate: pruningIterate((filepath) => pathspecCouldMatch(filepath, opts.pathspecs ?? [])),
    map: async (filepath, [entry1, entry2]) => {
      if (await isIdenticalSubtree(entry1, entry2)) return null;
      const change = await compareWalkerEntries(filepath, entry1, entry2, opts.pathspecs ?? []);
      if (change) changes.push(change);
      return undefined;
    },
  });

  return formatChanges(ctx, changes, opts);
}

async function diffCommitWorkdir(
  ctx: GitCommandContext,
  cwd: string,
  ref: string,
  opts: DiffFormatOptions
): Promise<GitCommandResult> {
  let resolved: string;
  try {
    resolved = await resolveRevision(ctx, cwd, ref);
  } catch {
    return ambiguousRevision(ref);
  }
  const tracked = new Set<string>(await git.listFiles({ fs: ctx.lfs, dir: cwd, cache: ctx.cache }));
  const trackedDirs = ancestorDirs(tracked);
  const changes: FileChange[] = [];
  await git.walk({
    fs: ctx.lfs,
    cache: ctx.cache,
    dir: cwd,

    trees: [git.TREE({ ref: resolved }), git.WORKDIR(NO_INDEX_REFRESH)],

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
  return formatChanges(ctx, changes, opts);
}

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
    oldPresent: Boolean(oldOid),
    newPresent: Boolean(newOid),
  };
}

function formatChanges(
  ctx: GitCommandContext,
  changes: FileChange[],
  opts: DiffFormatOptions
): GitCommandResult {
  if (changes.length === 0) return { stdout: '', stderr: '', exitCode: 0 };
  if (opts.nameStatus) {
    const lines = changes.map((c) => {
      const oldPresent = c.oldPresent ?? c.oldContent !== '';
      const newPresent = c.newPresent ?? c.newContent !== '';
      const status = !oldPresent ? 'A' : !newPresent ? 'D' : 'M';
      return `${status}\t${c.filepath}`;
    });
    return { stdout: `${lines.join('\n')}\n`, stderr: '', exitCode: 0 };
  }
  if (opts.nameOnly) {
    return { stdout: `${changes.map((c) => c.filepath).join('\n')}\n`, stderr: '', exitCode: 0 };
  }
  if (opts.stat) return formatDiffStat(changes, ctx.useColor);
  const stdout = changes
    .map((change) =>
      unifiedDiff({
        oldContent: change.oldContent,
        newContent: change.newContent,
        oldName: change.filepath,
        newName: change.filepath,
        context: opts.context,
        color: ctx.useColor,
      })
    )
    .join('');
  return { stdout, stderr: '', exitCode: 0 };
}

function normalizeUnifiedFlag(args: readonly string[]): string[] {
  const terminator = args.indexOf('--');
  return args.map((arg, i) =>
    (terminator === -1 || i < terminator) && /^-U\d+$/.test(arg) ? `--unified=${arg.slice(2)}` : arg
  );
}

function parseContext(value: ArgFlagValue | undefined): number | undefined {
  const raw = Array.isArray(value) ? value[value.length - 1] : value;
  if (raw === undefined || typeof raw === 'boolean' || raw === '') return undefined;
  const parsed = Number.parseInt(String(raw), 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function splitThreeDotRange(value: string): [string, string] | null {
  const idx = value.indexOf('...');
  if (idx === -1) return null;
  return [value.slice(0, idx), value.slice(idx + 3)];
}

function splitTwoDotRange(value: string): [string, string] | null {
  if (value.includes('...')) return null;
  const match = /^(.+)\.\.([^.]*)$/.exec(value);
  return match?.[1] !== undefined && match[2] !== undefined ? [match[1], match[2]] : null;
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
  changes: { filepath: string; oldContent: string; newContent: string }[],
  color = false
): GitCommandResult {
  const stdout = formatDiffStatText(
    changes.map((c) => ({ name: c.filepath, oldContent: c.oldContent, newContent: c.newContent })),
    { color }
  );
  return { stdout, stderr: '', exitCode: 0 };
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
    cache: ctx.cache,
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
    return formatDiffStat(changes, ctx.useColor).stdout;
  }

  let output = '';
  for (const file of files) {
    output += unifiedDiff({
      oldContent: '',
      newContent: file.content,
      oldName: file.filepath,
      newName: file.filepath,
      color: ctx.useColor,
    });
  }
  return output;
}
