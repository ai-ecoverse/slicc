import * as git from 'isomorphic-git';
import type { GitCommandContext, GitCommandResult } from './types.js';

export async function reset(
  ctx: GitCommandContext,
  cwd: string,
  args: string[]
): Promise<GitCommandResult> {
  const soft = args.includes('--soft');
  const hard = args.includes('--hard');
  const mixed = args.includes('--mixed');

  const positional = args.filter((a) => !a.startsWith('-'));
  const hasMode = soft || hard || mixed;

  if (!hasMode && positional.length === 0) {
    const matrix = await git.statusMatrix({ fs: ctx.lfs, cache: ctx.cache, dir: cwd });
    for (const [file, head, , stage] of matrix) {
      if (stage !== head) {
        await git.resetIndex({ fs: ctx.lfs, cache: ctx.cache, dir: cwd, filepath: file });
      }
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  }

  if (!hasMode) {
    const files = positional.filter((a) => a !== 'HEAD');
    if (files.length === 0) {
      const matrix = await git.statusMatrix({ fs: ctx.lfs, cache: ctx.cache, dir: cwd });
      for (const [file, head, , stage] of matrix) {
        if (stage !== head) {
          await git.resetIndex({ fs: ctx.lfs, cache: ctx.cache, dir: cwd, filepath: file });
        }
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    }
    for (const file of files) {
      await git.resetIndex({ fs: ctx.lfs, cache: ctx.cache, dir: cwd, filepath: file });
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  }

  const targetRef = positional[0] ?? 'HEAD';
  const targetOid = await git.resolveRef({ fs: ctx.lfs, dir: cwd, ref: targetRef });
  const branch = await git.currentBranch({ fs: ctx.lfs, dir: cwd, fullname: true });

  if (!branch) {
    return {
      stdout: '',
      stderr: 'fatal: not on a branch, cannot reset\n',
      exitCode: 128,
    };
  }

  await git.writeRef({
    fs: ctx.lfs,
    dir: cwd,
    ref: branch,
    value: targetOid,
    force: true,
  });

  if (soft) {
    return { stdout: `HEAD is now at ${targetOid.slice(0, 7)}\n`, stderr: '', exitCode: 0 };
  }

  const previouslyTracked = new Set(
    await git.listFiles({ fs: ctx.lfs, cache: ctx.cache, dir: cwd })
  );
  for (const file of previouslyTracked) {
    await git.remove({ fs: ctx.lfs, cache: ctx.cache, dir: cwd, filepath: file });
  }
  await resetIndexToCommit(ctx, cwd, targetOid);

  if (!hard) {
    return { stdout: `HEAD is now at ${targetOid.slice(0, 7)}\n`, stderr: '', exitCode: 0 };
  }

  await resetWorkdirToCommit(ctx, cwd, targetOid, previouslyTracked);

  return { stdout: `HEAD is now at ${targetOid.slice(0, 7)}\n`, stderr: '', exitCode: 0 };
}

async function resetIndexToCommit(ctx: GitCommandContext, cwd: string, oid: string): Promise<void> {
  const { tree } = await git.readTree({ fs: ctx.lfs, cache: ctx.cache, dir: cwd, oid });
  await addTreeToIndex(ctx, cwd, oid, tree, '');
}

async function addTreeToIndex(
  ctx: GitCommandContext,
  cwd: string,
  commitOid: string,
  tree: Array<{ mode: string; path: string; oid: string; type: string }>,
  prefix: string
): Promise<void> {
  for (const entry of tree) {
    const filepath = prefix ? `${prefix}/${entry.path}` : entry.path;
    if (entry.type === 'blob') {
      await git.resetIndex({ fs: ctx.lfs, cache: ctx.cache, dir: cwd, filepath, ref: commitOid });
    } else if (entry.type === 'tree') {
      const { tree: subtree } = await git.readTree({
        fs: ctx.lfs,
        cache: ctx.cache,
        dir: cwd,
        oid: entry.oid,
      });
      await addTreeToIndex(ctx, cwd, commitOid, subtree, filepath);
    }
  }
}

async function resetWorkdirToCommit(
  ctx: GitCommandContext,
  cwd: string,
  oid: string,
  previouslyTracked: Set<string>
): Promise<void> {
  const targetFiles = new Set<string>();
  const { tree } = await git.readTree({ fs: ctx.lfs, cache: ctx.cache, dir: cwd, oid });
  await collectTreeFiles(ctx, cwd, tree, '', targetFiles);

  for (const filepath of targetFiles) {
    const { blob } = await git.readBlob({ fs: ctx.lfs, cache: ctx.cache, dir: cwd, oid, filepath });
    const slashIdx = filepath.lastIndexOf('/');
    if (slashIdx !== -1) {
      await ctx.fs.mkdir(`${cwd}/${filepath.slice(0, slashIdx)}`, { recursive: true });
    }
    await ctx.fs.writeFile(`${cwd}/${filepath}`, blob);
  }

  for (const file of previouslyTracked) {
    if (!targetFiles.has(file)) {
      try {
        await ctx.fs.rm(`${cwd}/${file}`);
      } catch {}
    }
  }
}

async function collectTreeFiles(
  ctx: GitCommandContext,
  cwd: string,
  tree: Array<{ mode: string; path: string; oid: string; type: string }>,
  prefix: string,
  files: Set<string>
): Promise<void> {
  for (const entry of tree) {
    const filepath = prefix ? `${prefix}/${entry.path}` : entry.path;
    if (entry.type === 'blob') {
      files.add(filepath);
    } else if (entry.type === 'tree') {
      const { tree: subtree } = await git.readTree({
        fs: ctx.lfs,
        cache: ctx.cache,
        dir: cwd,
        oid: entry.oid,
      });
      await collectTreeFiles(ctx, cwd, subtree, filepath, files);
    }
  }
}
