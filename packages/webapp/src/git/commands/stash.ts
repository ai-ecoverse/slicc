/**
 * `git stash` — push / pop / list / drop / show, implemented over refs/stash
 * as a chained commit history (each stash's second parent is the previous one).
 */

import * as git from 'isomorphic-git';
import { diffCommits } from './diff.js';
import type { GitCommandContext, GitCommandResult } from './types.js';

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

  // Detect dirty files by directly comparing HEAD content with VFS content.
  const headFiles = await git.listFiles({ fs: ctx.lfs, dir: cwd, ref: 'HEAD' });
  const indexFiles = await git.listFiles({ fs: ctx.lfs, dir: cwd });
  const allTracked = new Set([...headFiles, ...indexFiles]);

  // Also detect newly staged files via statusMatrix
  const matrix = await git.statusMatrix({ fs: ctx.lfs, dir: cwd });
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
  } catch {
    /* no previous stash */
  }

  const { commit: headCommit } = await git.readCommit({ fs: ctx.lfs, dir: cwd, oid: headOid });
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

  // Restore workdir to HEAD state
  await stashRestoreWorkdir(ctx, cwd, headOid, dirtyFiles);

  return {
    stdout: `Saved working directory and index state ${message}\n`,
    stderr: '',
    exitCode: 0,
  };
}

/** Collect dirty files and build index entries for stash. */
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

    let workdirContent: string | undefined;
    try {
      workdirContent = await ctx.fs.readTextFile(`${cwd}/${filepath}`);
    } catch {
      /* file doesn't exist in workdir */
    }

    if (inHead) {
      const { blob } = await git.readBlob({ fs: ctx.lfs, dir: cwd, oid: headOid, filepath });
      const headContent = new TextDecoder().decode(blob);

      if (workdirContent === undefined) {
        dirtyFiles.push({ file: filepath, inHead: true, existsInWorkdir: false });
      } else if (workdirContent !== headContent) {
        dirtyFiles.push({ file: filepath, inHead: true, existsInWorkdir: true });
        const oid = await git.writeBlob({
          fs: ctx.lfs,
          dir: cwd,
          blob: new TextEncoder().encode(workdirContent),
        });
        indexEntries.push({ filepath, oid });
      } else {
        const blobOid = await git.writeBlob({ fs: ctx.lfs, dir: cwd, blob });
        indexEntries.push({ filepath, oid: blobOid });
      }
    } else if (workdirContent !== undefined) {
      dirtyFiles.push({ file: filepath, inHead: false, existsInWorkdir: true });
      const oid = await git.writeBlob({
        fs: ctx.lfs,
        dir: cwd,
        blob: new TextEncoder().encode(workdirContent),
      });
      indexEntries.push({ filepath, oid });
    }
  }

  return { dirtyFiles, indexEntries };
}

/** Restore workdir to HEAD state after stash. */
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
      } catch {
        /* ignore */
      }
      try {
        await git.remove({ fs: ctx.lfs, dir: cwd, filepath: dirty.file });
      } catch {
        /* ignore */
      }
    } else {
      const { blob } = await git.readBlob({
        fs: ctx.lfs,
        dir: cwd,
        oid: headOid,
        filepath: dirty.file,
      });
      await ctx.fs.writeFile(`${cwd}/${dirty.file}`, blob);
      await git.resetIndex({ fs: ctx.lfs, dir: cwd, filepath: dirty.file, ref: headOid });
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
  let stashOid: string;
  try {
    stashOid = await git.resolveRef({ fs: ctx.lfs, dir: cwd, ref: 'refs/stash' });
  } catch {
    return { stdout: '', stderr: 'error: No stash entries found.\n', exitCode: 1 };
  }

  const { commit: stashCommit } = await git.readCommit({ fs: ctx.lfs, dir: cwd, oid: stashOid });
  const headOid = await git.resolveRef({ fs: ctx.lfs, dir: cwd, ref: 'HEAD' });

  await restoreStashTree(ctx, cwd, stashCommit.tree, headOid);

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

async function restoreStashTree(
  ctx: GitCommandContext,
  cwd: string,
  treeOid: string,
  headOid: string
): Promise<void> {
  const stashFiles = new Map<string, Uint8Array>();

  const walkTree = async (oid: string, prefix: string): Promise<void> => {
    const { tree } = await git.readTree({ fs: ctx.lfs, dir: cwd, oid });
    for (const entry of tree) {
      const filepath = prefix ? `${prefix}/${entry.path}` : entry.path;
      if (entry.type === 'blob') {
        const { blob } = await git.readBlob({ fs: ctx.lfs, dir: cwd, oid: entry.oid });
        stashFiles.set(filepath, blob);
      } else if (entry.type === 'tree') {
        await walkTree(entry.oid, filepath);
      }
    }
  };
  await walkTree(treeOid, '');

  const headFileSet = new Set<string>();
  try {
    const headFiles = await git.listFiles({ fs: ctx.lfs, dir: cwd, ref: 'HEAD' });
    for (const f of headFiles) headFileSet.add(f);
  } catch {
    /* no HEAD */
  }

  for (const [filepath, blob] of stashFiles) {
    const slashIdx = filepath.lastIndexOf('/');
    if (slashIdx !== -1) {
      await ctx.fs.mkdir(`${cwd}/${filepath.slice(0, slashIdx)}`, { recursive: true });
    }
    await ctx.fs.writeFile(`${cwd}/${filepath}`, blob);
    // Restore index state: stage files that differ from HEAD
    const blobText = new TextDecoder().decode(blob);
    let headText: string | undefined;
    if (headFileSet.has(filepath)) {
      try {
        const { blob: headBlob } = await git.readBlob({
          fs: ctx.lfs,
          dir: cwd,
          oid: headOid,
          filepath,
        });
        headText = new TextDecoder().decode(headBlob);
      } catch {
        /* not in HEAD */
      }
    }
    if (headText !== blobText) {
      await git.add({ fs: ctx.lfs, dir: cwd, filepath });
    }
  }

  for (const filepath of headFileSet) {
    if (!stashFiles.has(filepath)) {
      try {
        await ctx.fs.rm(`${cwd}/${filepath}`);
      } catch {
        /* ignore */
      }
      await git.remove({ fs: ctx.lfs, dir: cwd, filepath });
    }
  }
}

async function stashList(ctx: GitCommandContext, cwd: string): Promise<GitCommandResult> {
  let output = '';
  let index = 0;

  try {
    let currentRef = await git.resolveRef({ fs: ctx.lfs, dir: cwd, ref: 'refs/stash' });

    while (currentRef) {
      const { commit } = await git.readCommit({ fs: ctx.lfs, dir: cwd, oid: currentRef });
      output += `stash@{${index}}: ${commit.message}\n`;
      index++;

      if (commit.parent.length > 1) {
        currentRef = commit.parent[1];
      } else {
        break;
      }
    }
  } catch {
    /* no stash ref */
  }

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
    const { commit } = await git.readCommit({ fs: ctx.lfs, dir: cwd, oid: topOid });
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

  // Collect the stash chain from top to the entry just before the dropped one
  const chain: { oid: string; commit: git.CommitObject }[] = [];
  let current = topOid;
  for (let i = 0; i < index; i++) {
    const { commit } = await git.readCommit({ fs: ctx.lfs, dir: cwd, oid: current });
    chain.push({ oid: current, commit });
    if (commit.parent.length <= 1) {
      return { stdout: '', stderr: `error: stash@{${index}} not found\n`, exitCode: 1 };
    }
    current = commit.parent[1];
  }

  // `current` is now the stash entry to drop
  const dropOid = current;
  const { commit: droppedCommit } = await git.readCommit({
    fs: ctx.lfs,
    dir: cwd,
    oid: dropOid,
  });
  const nextStash = droppedCommit.parent.length > 1 ? droppedCommit.parent[1] : undefined;

  // Rewrite the chain from the entry just before the drop backwards to the top
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

  // newChild is now the rewritten top stash entry
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

  const { commit: stashCommit } = await git.readCommit({ fs: ctx.lfs, dir: cwd, oid: stashOid });
  const baseOid = stashCommit.parent[0];

  return diffCommits(ctx, cwd, baseOid, stashOid, { nameOnly: false, stat: true });
}

async function deleteRef(ctx: GitCommandContext, cwd: string, ref: string): Promise<void> {
  try {
    await ctx.lfs.unlink(`${cwd}/.git/${ref}`);
  } catch {
    /* ignore */
  }
}
