import * as git from 'isomorphic-git';
import { joinPath, normalizePath } from '../../fs/path-utils.js';
import { parseArgs } from '../../shell/arg-parser.js';
import { gitHttp } from '../git-http.js';
import { expandGitError, flagString, GIT_FLAG_SPECS, type GitParsedFlags } from './shared.js';
import type { GitCommandContext, GitCommandResult } from './types.js';

export async function clone(
  ctx: GitCommandContext,
  cwd: string,
  args: string[]
): Promise<GitCommandResult> {
  const { flags: rawFlags, positionals } = parseArgs(args, GIT_FLAG_SPECS.clone);
  const flags = rawFlags as GitParsedFlags;

  if (positionals.length === 0) {
    return {
      stdout: '',
      stderr: 'fatal: You must specify a repository to clone.\n',
      exitCode: 128,
    };
  }

  const url = positionals[0];
  let dir = positionals[1];

  if (!dir) {
    const match = url.match(/\/([^/]+?)(\.git)?$/);
    dir = match ? match[1] : 'repo';
  }

  const targetDir = normalizePath(dir.startsWith('/') ? dir : `${cwd}/${dir}`);
  const depth = flagString(flags, 'depth');
  const branch = flagString(flags, 'branch');
  const singleBranch = flags['single-branch'] !== false;

  let output = `Cloning into '${dir}'...\n`;

  const local = localCloneSource(url, cwd);
  if (local) return cloneLocal(ctx, local, targetDir, url, dir, output, branch);

  try {
    await git.clone({
      fs: ctx.lfs,
      cache: ctx.cache,
      http: gitHttp,
      dir: targetDir,
      url,
      corsProxy: ctx.corsProxy,
      depth: depth ? parseInt(depth, 10) : 1,
      ref: branch,
      singleBranch,
      noCheckout: false,
      onAuth: ctx.getOnAuth(),
      onAuthFailure: ctx.getOnAuthFailure(),
      onProgress: (event) => {
        if (event.phase === 'Receiving objects') {
          output += `Receiving objects: ${event.loaded}/${event.total}\n`;
        }
      },
    });
  } catch (err: unknown) {
    return formatCloneError(err, targetDir, url);
  }

  await ctx.fs.flush();

  try {
    const files = await git.listFiles({ fs: ctx.lfs, cache: ctx.cache, dir: targetDir });
    if (files.length > 0) {
      output += `Checked out ${files.length} files.\n`;
    }
  } catch {}

  return {
    stdout: output + 'done.\n',
    stderr: '',
    exitCode: 0,
  };
}

function localCloneSource(url: string, cwd: string): string | null {
  if (url.startsWith('file://')) {
    try {
      return normalizePath(decodeURIComponent(new URL(url).pathname));
    } catch {
      return null;
    }
  }
  if (url.startsWith('/')) return normalizePath(url);
  if (url.startsWith('./') || url.startsWith('../')) return normalizePath(joinPath(cwd, url));
  return null;
}

async function cloneLocal(
  ctx: GitCommandContext,
  sourceDir: string,
  targetDir: string,
  sourceUrl: string,
  displayDir: string,
  output: string,
  requestedBranch?: string
): Promise<GitCommandResult> {
  if (targetDir === sourceDir || targetDir.startsWith(`${sourceDir}/`)) {
    return formatCloneError(new Error('destination is inside the source repository'), targetDir);
  }
  try {
    await ctx.lfs.stat(`${sourceDir}/.git`);
    try {
      const existing = await ctx.lfs.readdir(targetDir);
      if (existing.length > 0) {
        return formatCloneError(
          new Error(
            `destination path '${displayDir}' already exists and is not an empty directory.`
          ),
          targetDir
        );
      }
    } catch {
      await ctx.lfs.mkdir(targetDir, { recursive: true });
    }
    const branch = requestedBranch ?? (await git.currentBranch({ fs: ctx.lfs, dir: sourceDir }));
    await copyLocalTree(ctx, `${sourceDir}/.git`, `${targetDir}/.git`);
    if (branch)
      await git.checkout({
        fs: ctx.lfs,
        cache: ctx.cache,
        dir: targetDir,
        ref: branch,
        force: true,
      });
    await git.addRemote({
      fs: ctx.lfs,
      dir: targetDir,
      remote: 'origin',
      url: sourceUrl,
      force: true,
    });
    await ctx.fs.flush();
    const files = await git.listFiles({ fs: ctx.lfs, cache: ctx.cache, dir: targetDir });
    if (files.length > 0) output += `Checked out ${files.length} files.\n`;
    return { stdout: `${output}done.\n`, stderr: '', exitCode: 0 };
  } catch (err) {
    return formatCloneError(err, targetDir, sourceUrl);
  }
}

async function copyLocalTree(
  ctx: GitCommandContext,
  source: string,
  target: string
): Promise<void> {
  const stat = await ctx.lfs.lstat(source);
  if (stat.isDirectory()) {
    await ctx.lfs.mkdir(target, { recursive: true });
    for (const name of await ctx.lfs.readdir(source)) {
      await copyLocalTree(ctx, `${source}/${name}`, `${target}/${name}`);
    }
  } else if (stat.isSymbolicLink()) {
    await ctx.lfs.symlink(await ctx.lfs.readlink(source), target);
  } else {
    await ctx.lfs.writeFile(target, await ctx.lfs.readFile(source));
  }
}

function formatCloneError(err: unknown, targetDir: string, remoteUrl?: string): GitCommandResult {
  const raw = expandGitError(err, remoteUrl);
  const scrubbed = raw
    .replace(/'\/__opfs__\/[^']*<path>'/g, `'${targetDir}'`)
    .replace(/\/__opfs__\/[^\s'"<]*<path>/g, targetDir)
    .replace(/<path>/g, targetDir);
  return {
    stdout: '',
    stderr: `fatal: ${scrubbed}\n`,
    exitCode: 128,
  };
}
