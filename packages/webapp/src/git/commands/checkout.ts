/** `git checkout` — switch branches, create branches, or restore files. */

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

  // Detect file restoration mode: git checkout [<commit>] -- <file>...
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
    // Check for optional commit ref before --
    const preArgs = args.slice(0, ddIdx).filter((a) => !a.startsWith('-'));
    const commitRef = preArgs[0]; // e.g., git checkout abc123 -- file.txt
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
        checkout: true,
        force,
      });
    } catch (err: unknown) {
      return formatCheckoutError(err, ref);
    }
    return {
      stdout: `Switched to a new branch '${ref}'\n`,
      stderr: '',
      exitCode: 0,
    };
  }

  try {
    await git.checkout({ fs: ctx.lfs, dir: cwd, ref, force });
  } catch (err: unknown) {
    return formatCheckoutError(err, ref);
  }
  return {
    stdout: `Switched to branch '${ref}'\n`,
    stderr: '',
    exitCode: 0,
  };
}

/**
 * Format a checkout failure. `MultipleGitError` from isomorphic-git carries
 * a `.data.errors[]` array of per-file failures; surface each underlying
 * message (via {@link expandGitError}) instead of the cosmetic "There are
 * multiple errors..." noise (#1033-5). Anything else is rethrown so
 * `execute()`'s outer catch still handles it uniformly.
 */
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

/**
 * Restore files from a commit (or HEAD if no commit specified).
 * Reads the blob from the commit tree and writes it to the working directory.
 */
async function checkoutFiles(
  ctx: GitCommandContext,
  cwd: string,
  filePaths: string[],
  commitRef?: string
): Promise<GitCommandResult> {
  const ref = commitRef ?? 'HEAD';
  const oid = await git.resolveRef({ fs: ctx.lfs, dir: cwd, ref });

  for (const filepath of filePaths) {
    const { blob } = await git.readBlob({ fs: ctx.lfs, dir: cwd, oid, filepath });
    // Ensure parent directory exists
    const slashIdx = filepath.lastIndexOf('/');
    if (slashIdx !== -1) {
      await ctx.fs.mkdir(`${cwd}/${filepath.slice(0, slashIdx)}`, { recursive: true });
    }
    await ctx.fs.writeFile(`${cwd}/${filepath}`, blob);
    // Also update the index to match
    await git.add({ fs: ctx.lfs, dir: cwd, filepath });
  }

  return { stdout: '', stderr: '', exitCode: 0 };
}
