import * as git from 'isomorphic-git';
import { threeWayMerge } from '../merge-file-core.js';
import { diffCommits } from './diff.js';
import type { GitCommandContext, GitCommandResult } from './types.js';

const EMPTY_BYTES = new Uint8Array(0);

async function readWorkdirBytes(ctx: GitCommandContext, path: string): Promise<Uint8Array> {
  return (await ctx.fs.readFile(path, { encoding: 'binary' })) as Uint8Array;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a === b) return true;
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function decodeMergeableText(bytes: Uint8Array): string | undefined {
  if (bytes.includes(0x00)) return undefined;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

export async function stash(
  ctx: GitCommandContext,
  cwd: string,
  args: string[]
): Promise<GitCommandResult> {
  const subcommand = args[0];

  if (!subcommand || subcommand.startsWith('-')) {
    return stashPush(ctx, cwd, args);
  }

  switch (subcommand) {
    case 'push':
    case 'save':
      return stashPush(ctx, cwd, args.slice(1));
    case 'pop':
      return stashPop(ctx, cwd);
    case 'apply':
      return stashApply(ctx, cwd);
    case 'list':
      return stashList(ctx, cwd);
    case 'drop':
      return stashDrop(ctx, cwd, args.slice(1));
    case 'show':
      return stashShow(ctx, cwd);
    default:
      return { stdout: '', stderr: `error: unknown subcommand: ${subcommand}\n`, exitCode: 1 };
  }
}

async function stashPush(
  ctx: GitCommandContext,
  cwd: string,
  _args: string[]
): Promise<GitCommandResult> {
  const branch = (await git.currentBranch({ fs: ctx.lfs, dir: cwd })) ?? 'HEAD';
  let headOid: string;
  try {
    headOid = await git.resolveRef({ fs: ctx.lfs, dir: cwd, ref: 'HEAD' });
  } catch {
    return { stdout: '', stderr: 'fatal: cannot stash without a HEAD commit\n', exitCode: 128 };
  }

  const headFiles = await git.listFiles({ fs: ctx.lfs, cache: ctx.cache, dir: cwd, ref: 'HEAD' });
  const indexFiles = await git.listFiles({ fs: ctx.lfs, cache: ctx.cache, dir: cwd });
  const allTracked = new Set([...headFiles, ...indexFiles]);

  const matrix = await git.statusMatrix({ fs: ctx.lfs, cache: ctx.cache, dir: cwd });
  for (const [file, head, , stage] of matrix) {
    if (head === 0 && stage !== 0) allTracked.add(file);
  }

  const { dirtyFiles, indexEntries } = await stashCollectDirty(
    ctx,
    cwd,
    headOid,
    allTracked,
    headFiles
  );

  if (dirtyFiles.length === 0) {
    return { stdout: '', stderr: 'No local changes to save\n', exitCode: 1 };
  }

  const treeOid = await buildTreeFromEntries(ctx, cwd, indexEntries);

  const parents: string[] = [headOid];
  try {
    const prevStash = await git.resolveRef({ fs: ctx.lfs, dir: cwd, ref: 'refs/stash' });
    parents.push(prevStash);
  } catch {}

  const { commit: headCommit } = await git.readCommit({
    fs: ctx.lfs,
    cache: ctx.cache,
    dir: cwd,
    oid: headOid,
  });
  const message = `WIP on ${branch}: ${headOid.slice(0, 7)} ${headCommit.message.split('\n')[0]}`;
  const author = await ctx.resolveAuthor(cwd);
  const timestamp = Math.floor(Date.now() / 1000);
  const stashOid = await git.writeCommit({
    fs: ctx.lfs,
    dir: cwd,
    commit: {
      tree: treeOid,
      parent: parents,
      author: { ...author, timestamp, timezoneOffset: 0 },
      committer: { ...author, timestamp, timezoneOffset: 0 },
      message,
    },
  });

  await git.writeRef({ fs: ctx.lfs, dir: cwd, ref: 'refs/stash', value: stashOid, force: true });

  await stashRestoreWorkdir(ctx, cwd, headOid, dirtyFiles);

  return {
    stdout: `Saved working directory and index state ${message}\n`,
    stderr: '',
    exitCode: 0,
  };
}

async function stashCollectDirty(
  ctx: GitCommandContext,
  cwd: string,
  headOid: string,
  allTracked: Set<string>,
  headFiles: string[]
): Promise<{
  dirtyFiles: { file: string; inHead: boolean; existsInWorkdir: boolean }[];
  indexEntries: { filepath: string; oid: string }[];
}> {
  const dirtyFiles: { file: string; inHead: boolean; existsInWorkdir: boolean }[] = [];
  const indexEntries: { filepath: string; oid: string }[] = [];

  for (const filepath of allTracked) {
    const inHead = headFiles.includes(filepath);

    let workdirBytes: Uint8Array | undefined;
    try {
      workdirBytes = await readWorkdirBytes(ctx, `${cwd}/${filepath}`);
    } catch {}

    if (inHead) {
      const { blob } = await git.readBlob({
        fs: ctx.lfs,
        cache: ctx.cache,
        dir: cwd,
        oid: headOid,
        filepath,
      });

      if (workdirBytes === undefined) {
        dirtyFiles.push({ file: filepath, inHead: true, existsInWorkdir: false });
      } else if (!bytesEqual(workdirBytes, blob)) {
        dirtyFiles.push({ file: filepath, inHead: true, existsInWorkdir: true });
        const oid = await git.writeBlob({ fs: ctx.lfs, dir: cwd, blob: workdirBytes });
        indexEntries.push({ filepath, oid });
      } else {
        const blobOid = await git.writeBlob({ fs: ctx.lfs, dir: cwd, blob });
        indexEntries.push({ filepath, oid: blobOid });
      }
    } else if (workdirBytes !== undefined) {
      dirtyFiles.push({ file: filepath, inHead: false, existsInWorkdir: true });
      const oid = await git.writeBlob({ fs: ctx.lfs, dir: cwd, blob: workdirBytes });
      indexEntries.push({ filepath, oid });
    }
  }

  return { dirtyFiles, indexEntries };
}

async function stashRestoreWorkdir(
  ctx: GitCommandContext,
  cwd: string,
  headOid: string,
  dirtyFiles: { file: string; inHead: boolean; existsInWorkdir: boolean }[]
): Promise<void> {
  for (const dirty of dirtyFiles) {
    if (!dirty.inHead) {
      try {
        await ctx.fs.rm(`${cwd}/${dirty.file}`);
      } catch {}
      try {
        await git.remove({ fs: ctx.lfs, cache: ctx.cache, dir: cwd, filepath: dirty.file });
      } catch {}
    } else {
      const { blob } = await git.readBlob({
        fs: ctx.lfs,
        cache: ctx.cache,
        dir: cwd,
        oid: headOid,
        filepath: dirty.file,
      });
      await ctx.fs.writeFile(`${cwd}/${dirty.file}`, blob);
      await git.resetIndex({
        fs: ctx.lfs,
        cache: ctx.cache,
        dir: cwd,
        filepath: dirty.file,
        ref: headOid,
      });
    }
  }
}

async function buildTreeFromEntries(
  ctx: GitCommandContext,
  cwd: string,
  entries: { filepath: string; oid: string }[]
): Promise<string> {
  type TreeNode =
    | { type: 'blob'; oid: string; mode: string }
    | { type: 'tree'; children: Map<string, TreeNode> };
  const root = new Map<string, TreeNode>();

  for (const { filepath, oid } of entries) {
    const parts = filepath.split('/');
    let current = root;
    for (let i = 0; i < parts.length - 1; i++) {
      let node = current.get(parts[i]);
      if (node?.type !== 'tree') {
        node = { type: 'tree', children: new Map() };
        current.set(parts[i], node);
      }
      current = node.children;
    }
    current.set(parts[parts.length - 1], { type: 'blob', oid, mode: '100644' });
  }

  const writeTree = async (nodes: Map<string, TreeNode>): Promise<string> => {
    const treeEntries: { mode: string; path: string; oid: string; type: 'blob' | 'tree' }[] = [];
    for (const [name, node] of nodes) {
      if (node.type === 'blob') {
        treeEntries.push({ mode: node.mode, path: name, oid: node.oid, type: 'blob' });
      } else {
        const subtreeOid = await writeTree(node.children);
        treeEntries.push({ mode: '040000', path: name, oid: subtreeOid, type: 'tree' });
      }
    }
    return await git.writeTree({ fs: ctx.lfs, dir: cwd, tree: treeEntries });
  };

  return writeTree(root);
}

async function stashPop(ctx: GitCommandContext, cwd: string): Promise<GitCommandResult> {
  return stashRestore(ctx, cwd, true);
}

async function stashApply(ctx: GitCommandContext, cwd: string): Promise<GitCommandResult> {
  return stashRestore(ctx, cwd, false);
}

async function stashRestore(
  ctx: GitCommandContext,
  cwd: string,
  drop: boolean
): Promise<GitCommandResult> {
  let stashOid: string;
  try {
    stashOid = await git.resolveRef({ fs: ctx.lfs, dir: cwd, ref: 'refs/stash' });
  } catch {
    return { stdout: '', stderr: 'error: No stash entries found.\n', exitCode: 1 };
  }

  const { commit: stashCommit } = await git.readCommit({
    fs: ctx.lfs,
    cache: ctx.cache,
    dir: cwd,
    oid: stashOid,
  });
  const headOid = await git.resolveRef({ fs: ctx.lfs, dir: cwd, ref: 'HEAD' });

  const baseOid = stashCommit.parent[0] ?? headOid;

  const { conflicts, warnings } = await mergeStashTree(ctx, cwd, stashCommit.tree, baseOid);

  if (conflicts.length > 0) {
    const stdout = conflicts
      .map((filepath) => `CONFLICT (content): Merge conflict in ${filepath}\n`)
      .join('');
    const kept = drop ? 'The stash entry is kept in case you need it again.\n' : '';
    return { stdout, stderr: warnings.join('') + kept, exitCode: 1 };
  }

  if (!drop) {
    return { stdout: '', stderr: '', exitCode: 0 };
  }

  if (stashCommit.parent.length > 1) {
    await git.writeRef({
      fs: ctx.lfs,
      dir: cwd,
      ref: 'refs/stash',
      value: stashCommit.parent[1],
      force: true,
    });
  } else {
    await deleteRef(ctx, cwd, 'refs/stash');
  }

  return {
    stdout: `Dropped refs/stash@{0} (${stashOid.slice(0, 7)})\n`,
    stderr: '',
    exitCode: 0,
  };
}

async function mergeStashTree(
  ctx: GitCommandContext,
  cwd: string,
  treeOid: string,
  baseOid: string
): Promise<{ conflicts: string[]; warnings: string[] }> {
  const stashFiles = new Map<string, Uint8Array>();

  const walkTree = async (oid: string, prefix: string): Promise<void> => {
    const { tree } = await git.readTree({ fs: ctx.lfs, cache: ctx.cache, dir: cwd, oid });
    for (const entry of tree) {
      const filepath = prefix ? `${prefix}/${entry.path}` : entry.path;
      if (entry.type === 'blob') {
        const { blob } = await git.readBlob({
          fs: ctx.lfs,
          cache: ctx.cache,
          dir: cwd,
          oid: entry.oid,
        });
        stashFiles.set(filepath, blob);
      } else if (entry.type === 'tree') {
        await walkTree(entry.oid, filepath);
      }
    }
  };
  await walkTree(treeOid, '');

  const baseFileSet = new Set<string>();
  try {
    const baseFiles = await git.listFiles({
      fs: ctx.lfs,
      cache: ctx.cache,
      dir: cwd,
      ref: baseOid,
    });
    for (const f of baseFiles) baseFileSet.add(f);
  } catch {}

  const conflicts: string[] = [];
  const warnings: string[] = [];

  for (const [filepath, theirs] of stashFiles) {
    const base = baseFileSet.has(filepath)
      ? await readBaseBytes(ctx, cwd, baseOid, filepath)
      : EMPTY_BYTES;

    let ours: Uint8Array | undefined;
    try {
      ours = await readWorkdirBytes(ctx, `${cwd}/${filepath}`);
    } catch {}

    const { merged, conflicted, binary } = resolveStashedFile(ours, base, theirs);

    const slashIdx = filepath.lastIndexOf('/');
    if (slashIdx !== -1) {
      await ctx.fs.mkdir(`${cwd}/${filepath.slice(0, slashIdx)}`, { recursive: true });
    }
    await ctx.fs.writeFile(`${cwd}/${filepath}`, merged);

    if (binary) {
      warnings.push(
        `warning: Cannot merge binary files: ${filepath} (Updated upstream vs Stashed changes)\n`
      );
    }
    if (conflicted) {
      conflicts.push(filepath);
    } else if (!bytesEqual(merged, base)) {
      await git.add({ fs: ctx.lfs, cache: ctx.cache, dir: cwd, filepath });
    }
  }

  for (const filepath of baseFileSet) {
    if (!stashFiles.has(filepath)) {
      try {
        await ctx.fs.rm(`${cwd}/${filepath}`);
      } catch {}
      await git.remove({ fs: ctx.lfs, cache: ctx.cache, dir: cwd, filepath });
    }
  }

  return { conflicts, warnings };
}

function resolveStashedFile(
  ours: Uint8Array | undefined,
  base: Uint8Array,
  theirs: Uint8Array
): { merged: Uint8Array; conflicted: boolean; binary: boolean } {
  if (ours === undefined || bytesEqual(ours, theirs) || bytesEqual(ours, base)) {
    return { merged: theirs, conflicted: false, binary: false };
  }

  if (bytesEqual(theirs, base)) {
    return { merged: ours, conflicted: false, binary: false };
  }

  const oursText = decodeMergeableText(ours);
  const baseText = decodeMergeableText(base);
  const theirsText = decodeMergeableText(theirs);
  if (oursText === undefined || baseText === undefined || theirsText === undefined) {
    return { merged: ours, conflicted: true, binary: true };
  }

  const merge = threeWayMerge(oursText, baseText, theirsText, {
    labels: { current: 'Updated upstream', base: 'stash base', other: 'Stashed changes' },
  });
  return {
    merged: new TextEncoder().encode(merge.content),
    conflicted: merge.conflicts > 0,
    binary: false,
  };
}

async function readBaseBytes(
  ctx: GitCommandContext,
  cwd: string,
  baseOid: string,
  filepath: string
): Promise<Uint8Array> {
  try {
    const { blob } = await git.readBlob({
      fs: ctx.lfs,
      cache: ctx.cache,
      dir: cwd,
      oid: baseOid,
      filepath,
    });
    return blob;
  } catch {
    return EMPTY_BYTES;
  }
}

async function stashList(ctx: GitCommandContext, cwd: string): Promise<GitCommandResult> {
  let output = '';
  let index = 0;

  try {
    let currentRef = await git.resolveRef({ fs: ctx.lfs, dir: cwd, ref: 'refs/stash' });

    while (currentRef) {
      const { commit } = await git.readCommit({
        fs: ctx.lfs,
        cache: ctx.cache,
        dir: cwd,
        oid: currentRef,
      });
      output += `stash@{${index}}: ${commit.message}\n`;
      index++;

      if (commit.parent.length > 1) {
        currentRef = commit.parent[1];
      } else {
        break;
      }
    }
  } catch {}

  return { stdout: output, stderr: '', exitCode: 0 };
}

async function stashDrop(
  ctx: GitCommandContext,
  cwd: string,
  args: string[]
): Promise<GitCommandResult> {
  let index = 0;
  const stashRef = args.find((a) => a.startsWith('stash@{'));
  if (stashRef) {
    const match = stashRef.match(/stash@\{(\d+)\}/);
    if (match) index = parseInt(match[1], 10);
  }

  let topOid: string;
  try {
    topOid = await git.resolveRef({ fs: ctx.lfs, dir: cwd, ref: 'refs/stash' });
  } catch {
    return { stdout: '', stderr: 'error: No stash entries found.\n', exitCode: 1 };
  }

  if (index === 0) {
    const { commit } = await git.readCommit({
      fs: ctx.lfs,
      cache: ctx.cache,
      dir: cwd,
      oid: topOid,
    });
    if (commit.parent.length > 1) {
      await git.writeRef({
        fs: ctx.lfs,
        dir: cwd,
        ref: 'refs/stash',
        value: commit.parent[1],
        force: true,
      });
    } else {
      await deleteRef(ctx, cwd, 'refs/stash');
    }
    return {
      stdout: `Dropped refs/stash@{0} (${topOid.slice(0, 7)})\n`,
      stderr: '',
      exitCode: 0,
    };
  }

  const chain: { oid: string; commit: git.CommitObject }[] = [];
  let current = topOid;
  for (let i = 0; i < index; i++) {
    const { commit } = await git.readCommit({
      fs: ctx.lfs,
      cache: ctx.cache,
      dir: cwd,
      oid: current,
    });
    chain.push({ oid: current, commit });
    if (commit.parent.length <= 1) {
      return { stdout: '', stderr: `error: stash@{${index}} not found\n`, exitCode: 1 };
    }
    current = commit.parent[1];
  }

  const dropOid = current;
  const { commit: droppedCommit } = await git.readCommit({
    fs: ctx.lfs,
    cache: ctx.cache,
    dir: cwd,
    oid: dropOid,
  });
  const nextStash = droppedCommit.parent.length > 1 ? droppedCommit.parent[1] : undefined;

  let newChild = nextStash;
  for (let i = chain.length - 1; i >= 0; i--) {
    const entry = chain[i];
    const newParents = [entry.commit.parent[0]];
    if (newChild) newParents.push(newChild);
    newChild = await git.writeCommit({
      fs: ctx.lfs,
      dir: cwd,
      commit: { ...entry.commit, parent: newParents },
    });
  }

  if (newChild) {
    await git.writeRef({
      fs: ctx.lfs,
      dir: cwd,
      ref: 'refs/stash',
      value: newChild,
      force: true,
    });
  } else {
    await deleteRef(ctx, cwd, 'refs/stash');
  }

  return {
    stdout: `Dropped refs/stash@{${index}} (${dropOid.slice(0, 7)})\n`,
    stderr: '',
    exitCode: 0,
  };
}

async function stashShow(ctx: GitCommandContext, cwd: string): Promise<GitCommandResult> {
  let stashOid: string;
  try {
    stashOid = await git.resolveRef({ fs: ctx.lfs, dir: cwd, ref: 'refs/stash' });
  } catch {
    return { stdout: '', stderr: 'error: No stash entries found.\n', exitCode: 1 };
  }

  const { commit: stashCommit } = await git.readCommit({
    fs: ctx.lfs,
    cache: ctx.cache,
    dir: cwd,
    oid: stashOid,
  });
  const baseOid = stashCommit.parent[0];

  return diffCommits(ctx, cwd, baseOid, stashOid, { nameOnly: false, stat: true });
}

async function deleteRef(ctx: GitCommandContext, cwd: string, ref: string): Promise<void> {
  try {
    await ctx.lfs.unlink(`${cwd}/.git/${ref}`);
  } catch {}
}
