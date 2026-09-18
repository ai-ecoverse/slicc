import * as git from 'isomorphic-git';
import type { GitCommandContext } from './types.js';

const MERGE_FILES = ['MERGE_HEAD', 'MERGE_MSG', 'MERGE_MODE', 'AUTO_MERGE'] as const;

async function gitDir(ctx: GitCommandContext, cwd: string): Promise<string> {
  const root = await git.findRoot({ fs: ctx.lfs, filepath: cwd });
  return `${root}/.git`;
}

async function readGitFile(ctx: GitCommandContext, path: string): Promise<string | undefined> {
  try {
    return (await ctx.fs.readTextFile(path)).trim();
  } catch {
    return undefined;
  }
}

async function removeIfPresent(ctx: GitCommandContext, path: string): Promise<void> {
  try {
    await ctx.fs.rm(path);
  } catch {}
}

export async function readMergeHead(
  ctx: GitCommandContext,
  cwd: string
): Promise<string | undefined> {
  try {
    return await readGitFile(ctx, `${await gitDir(ctx, cwd)}/MERGE_HEAD`);
  } catch {
    return undefined;
  }
}

export async function mergeInProgress(ctx: GitCommandContext, cwd: string): Promise<boolean> {
  return (await readMergeHead(ctx, cwd)) !== undefined;
}

export async function readMergeMsg(
  ctx: GitCommandContext,
  cwd: string
): Promise<string | undefined> {
  try {
    return await readGitFile(ctx, `${await gitDir(ctx, cwd)}/MERGE_MSG`);
  } catch {
    return undefined;
  }
}

export async function writeOrigHead(
  ctx: GitCommandContext,
  cwd: string,
  oid: string
): Promise<void> {
  const dir = await gitDir(ctx, cwd);
  await ctx.fs.writeFile(`${dir}/ORIG_HEAD`, `${oid}\n`);
}

export async function writeMergeState(
  ctx: GitCommandContext,
  cwd: string,
  theirsOid: string,
  message: string
): Promise<void> {
  const dir = await gitDir(ctx, cwd);
  await ctx.fs.writeFile(`${dir}/MERGE_HEAD`, `${theirsOid}\n`);
  await ctx.fs.writeFile(`${dir}/MERGE_MSG`, message.endsWith('\n') ? message : `${message}\n`);
}

export async function clearMergeState(ctx: GitCommandContext, cwd: string): Promise<void> {
  let dir: string;
  try {
    dir = await gitDir(ctx, cwd);
  } catch {
    return;
  }
  await Promise.all(MERGE_FILES.map((name) => removeIfPresent(ctx, `${dir}/${name}`)));
}

export async function conflictedWorktreePaths(
  ctx: GitCommandContext,
  cwd: string
): Promise<string[]> {
  const files = await git.listFiles({ fs: ctx.lfs, cache: ctx.cache, dir: cwd });
  const out: string[] = [];
  for (const file of files) {
    try {
      const content = await ctx.fs.readTextFile(`${cwd}/${file}`);
      if (content.includes('<<<<<<<')) out.push(file);
    } catch {}
  }
  return out;
}
