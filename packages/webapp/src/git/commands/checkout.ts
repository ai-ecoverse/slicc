import * as git from 'isomorphic-git';
import { expandGitError } from './shared.js';
import type { GitCommandContext, GitCommandResult } from './types.js';

export async function checkout(
  ctx: GitCommandContext,
  cwd: string,
  args: string[]
): Promise<GitCommandResult> {
  const createBranch = args.includes('-b');
  const force = args.includes('-f') || args.includes('--force');

  const ddIdx = args.indexOf('--');
  if (ddIdx !== -1) {
    const filePaths = args.slice(ddIdx + 1);
    if (filePaths.length === 0) {
      return {
        stdout: '',
        stderr: 'error: you must specify path(s) to restore\n',
        exitCode: 1,
      };
    }

    const preArgs = args.slice(0, ddIdx).filter((a) => !a.startsWith('-'));
    const commitRef = preArgs[0];
    return checkoutFiles(ctx, cwd, filePaths, commitRef);
  }

  const ref = args.find((a) => !a.startsWith('-'));

  if (!ref) {
    return {
      stdout: '',
      stderr: 'error: you must specify path(s) or a branch to checkout\n',
      exitCode: 1,
    };
  }

  if (createBranch) {
    const bIdx = args.indexOf('-b');
    const afterB = args.slice(bIdx + 1).filter((a) => !a.startsWith('-'));
    const startPoint = afterB.length > 1 ? afterB[1] : undefined;
    try {
      await git.branch({
        fs: ctx.lfs,
        dir: cwd,
        ref,
        object: startPoint,
        checkout: false,
        force,
      });
    } catch (err: unknown) {
      return formatCheckoutError(err, ref);
    }
    try {
      await checkoutRef(ctx, cwd, ref, force);
    } catch (err: unknown) {
      if (!force) {
        try {
          await git.deleteBranch({ fs: ctx.lfs, dir: cwd, ref });
        } catch {}
      }
      return formatCheckoutError(err, ref);
    }
    await ctx.fs.flush();
    return {
      stdout: `Switched to a new branch '${ref}'\n`,
      stderr: '',
      exitCode: 0,
    };
  }

  try {
    await checkoutRef(ctx, cwd, ref, force);
  } catch (err: unknown) {
    return formatCheckoutError(err, ref);
  }

  await ctx.fs.flush();
  return {
    stdout: `Switched to branch '${ref}'\n`,
    stderr: '',
    exitCode: 0,
  };
}

async function checkoutRef(
  ctx: GitCommandContext,
  cwd: string,
  ref: string,
  force: boolean
): Promise<void> {
  let previousHead: string | undefined;
  try {
    previousHead = await git.resolveRef({ fs: ctx.lfs, dir: cwd, ref: 'HEAD' });
  } catch {
    previousHead = undefined;
  }
  const previous = new Set(await git.listFiles({ fs: ctx.lfs, cache: ctx.cache, dir: cwd }));
  await git.checkout({ fs: ctx.lfs, cache: ctx.cache, dir: cwd, ref, force });
  const targetOid = await git.resolveRef({ fs: ctx.lfs, dir: cwd, ref });
  const target = new Set(
    await git.listFiles({ fs: ctx.lfs, cache: ctx.cache, dir: cwd, ref: targetOid })
  );
  await dropPathsAbsentFromTarget(ctx, cwd, previous, target);

  if (!force && previousHead === targetOid) return;
  await materializeWorktree(ctx, cwd, targetOid, previous, target);
}

async function dropPathsAbsentFromTarget(
  ctx: GitCommandContext,
  cwd: string,
  previous: Set<string>,
  target: Set<string>
): Promise<void> {
  for (const filepath of previous) {
    if (target.has(filepath)) continue;
    try {
      await git.remove({ fs: ctx.lfs, cache: ctx.cache, dir: cwd, filepath });
    } catch {}
    try {
      await ctx.fs.rm(`${cwd}/${filepath}`);
    } catch {}
  }
}

async function materializeWorktree(
  ctx: GitCommandContext,
  cwd: string,
  oid: string,
  previous: Set<string>,
  files: Set<string>
): Promise<void> {
  for (const filepath of files) {
    if (!previous.has(filepath)) continue;
    const full = `${cwd}/${filepath}`;
    try {
      const st = await ctx.fs.lstat(full);
      if (st.type === 'symlink' || st.type === 'directory') continue;
    } catch {
      continue;
    }
    const { blob } = await git.readBlob({
      fs: ctx.lfs,
      cache: ctx.cache,
      dir: cwd,
      oid,
      filepath,
    });
    const slashIdx = filepath.lastIndexOf('/');
    if (slashIdx !== -1) {
      await ctx.fs.mkdir(`${cwd}/${filepath.slice(0, slashIdx)}`, { recursive: true });
    }
    await ctx.fs.writeFile(full, blob);
    await git.resetIndex({ fs: ctx.lfs, cache: ctx.cache, dir: cwd, filepath, ref: oid });
  }
}

function formatCheckoutError(err: unknown, ref: string): GitCommandResult {
  if (err instanceof Error && err.name === 'MultipleGitError') {
    const body = expandGitError(err)
      .split('\n')
      .map((line) => `  ${line}`)
      .join('\n');
    return { stdout: '', stderr: `error: unable to checkout '${ref}':\n${body}\n`, exitCode: 1 };
  }
  throw err;
}

async function checkoutFiles(
  ctx: GitCommandContext,
  cwd: string,
  filePaths: string[],
  commitRef?: string
): Promise<GitCommandResult> {
  const ref = commitRef ?? 'HEAD';
  const oid = await git.resolveRef({ fs: ctx.lfs, dir: cwd, ref });

  for (const filepath of filePaths) {
    const { blob } = await git.readBlob({ fs: ctx.lfs, cache: ctx.cache, dir: cwd, oid, filepath });

    const slashIdx = filepath.lastIndexOf('/');
    if (slashIdx !== -1) {
      await ctx.fs.mkdir(`${cwd}/${filepath.slice(0, slashIdx)}`, { recursive: true });
    }
    await ctx.fs.writeFile(`${cwd}/${filepath}`, blob);

    await git.add({ fs: ctx.lfs, cache: ctx.cache, dir: cwd, filepath });
  }

  await ctx.fs.flush();
  return { stdout: '', stderr: '', exitCode: 0 };
}
