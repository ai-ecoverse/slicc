/**
 * `git diff` and the shared commit-diff helpers.
 *
 * `diffCommits` and `diffInitialCommit` are exported because `log`, `show`, and
 * `stash` all render diffs against a commit; the workdir/staged collectors and
 * the stat formatter stay module-local.
 */

import * as git from 'isomorphic-git';
import { diffStat, unifiedDiff } from '../diff.js';
import type { GitCommandContext, GitCommandResult } from './types.js';

export async function diff(
  ctx: GitCommandContext,
  cwd: string,
  args: string[]
): Promise<GitCommandResult> {
  const staged = args.includes('--staged') || args.includes('--cached');
  const nameOnly = args.includes('--name-only');
  const showStat = args.includes('--stat');

  // Check for commit-to-commit diff: git diff <commit1> <commit2>
  const nonFlags = args.filter((a) => !a.startsWith('-'));
  if (nonFlags.length >= 2) {
    return diffCommits(ctx, cwd, nonFlags[0], nonFlags[1], { nameOnly, stat: showStat });
  }

  const changes = staged ? await diffStagedChanges(ctx, cwd) : await diffWorkdirChanges(ctx, cwd);

  if (changes.length === 0) {
    return { stdout: '', stderr: '', exitCode: 0 };
  }

  if (nameOnly) {
    const output = changes.map((c) => c.filepath).join('\n') + '\n';
    return { stdout: output, stderr: '', exitCode: 0 };
  }

  if (showStat) {
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
  cwd: string
): Promise<{ filepath: string; oldContent: string; newContent: string }[]> {
  const changes: { filepath: string; oldContent: string; newContent: string }[] = [];

  await git.walk({
    fs: ctx.lfs,
    dir: cwd,
    trees: [git.TREE({ ref: 'HEAD' }), git.STAGE()],
    map: async (filepath, [headEntry, stageEntry]) => {
      if (filepath === '.' || filepath.startsWith('.git')) return undefined;
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
  cwd: string
): Promise<{ filepath: string; oldContent: string; newContent: string }[]> {
  const changes: { filepath: string; oldContent: string; newContent: string }[] = [];

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
  opts: { nameOnly: boolean; stat: boolean }
): Promise<GitCommandResult> {
  // Resolve short SHAs to full OIDs
  let resolvedRef1 = ref1;
  let resolvedRef2 = ref2;
  try {
    resolvedRef1 = await git.expandOid({ fs: ctx.lfs, dir: cwd, oid: ref1 });
  } catch {
    // Not a short OID, try as branch/tag ref
    try {
      resolvedRef1 = await git.resolveRef({ fs: ctx.lfs, dir: cwd, ref: ref1 });
    } catch {
      /* use as-is */
    }
  }
  try {
    resolvedRef2 = await git.expandOid({ fs: ctx.lfs, dir: cwd, oid: ref2 });
  } catch {
    try {
      resolvedRef2 = await git.resolveRef({ fs: ctx.lfs, dir: cwd, ref: ref2 });
    } catch {
      /* use as-is */
    }
  }

  type FileChange = {
    filepath: string;
    oldContent: string;
    newContent: string;
  };

  const changes: FileChange[] = [];

  await git.walk({
    fs: ctx.lfs,
    dir: cwd,
    trees: [git.TREE({ ref: resolvedRef1 }), git.TREE({ ref: resolvedRef2 })],
    map: async (filepath, [entry1, entry2]) => {
      if (filepath === '.') return undefined;

      const type1 = entry1 ? await entry1.type() : undefined;
      const type2 = entry2 ? await entry2.type() : undefined;

      if (type1 === 'tree' || type2 === 'tree') return undefined;

      const oid1 = entry1 ? await entry1.oid() : undefined;
      const oid2 = entry2 ? await entry2.oid() : undefined;

      if (oid1 === oid2) return undefined;

      const content1 = entry1 ? await entry1.content() : undefined;
      const content2 = entry2 ? await entry2.content() : undefined;

      const oldText = content1 ? new TextDecoder().decode(content1) : '';
      const newText = content2 ? new TextDecoder().decode(content2) : '';

      changes.push({ filepath, oldContent: oldText, newContent: newText });
      return undefined;
    },
  });

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
