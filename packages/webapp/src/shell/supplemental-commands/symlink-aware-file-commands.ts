import type { Command, CommandContext, FsStat } from 'just-bash';
import { defineCommand } from 'just-bash';

function errorDetail(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/ENOENT|no such file/i.test(message)) return 'No such file or directory';
  if (/ENOTEMPTY|not empty/i.test(message)) return 'Directory not empty';
  return message.replace(/^\w+:\s*/, '');
}

async function lstat(ctx: CommandContext, path: string): Promise<FsStat> {
  return ctx.fs.lstat ? ctx.fs.lstat(path) : ctx.fs.stat(path);
}

function hasShortFlag(args: string[], flag: string): boolean {
  return args.some((arg) => /^-[^-]/.test(arg) && arg.slice(1).includes(flag));
}

interface RmOptions {
  force: boolean;
  recursive: boolean;
  verbose: boolean;
}

async function removePath(
  ctx: CommandContext,
  operand: string,
  options: RmOptions
): Promise<{ stdout: string; stderr: string }> {
  const path = ctx.fs.resolvePath(ctx.cwd, operand);
  try {
    const stat = await lstat(ctx, path);
    if (stat.isDirectory && !stat.isSymbolicLink && !options.recursive) {
      return { stdout: '', stderr: `rm: cannot remove '${operand}': Is a directory\n` };
    }
    await ctx.fs.rm(path, { recursive: options.recursive, force: options.force });
    return { stdout: options.verbose ? `removed '${operand}'\n` : '', stderr: '' };
  } catch (error) {
    return {
      stdout: '',
      stderr: options.force ? '' : `rm: cannot remove '${operand}': ${errorDetail(error)}\n`,
    };
  }
}

export function createRmCommand(): Command {
  return defineCommand('rm', async (args, ctx) => {
    const options: RmOptions = {
      recursive: hasShortFlag(args, 'r') || hasShortFlag(args, 'R') || args.includes('--recursive'),
      force: hasShortFlag(args, 'f') || args.includes('--force'),
      verbose: hasShortFlag(args, 'v') || args.includes('--verbose'),
    };
    const paths = args.filter((arg) => !arg.startsWith('-'));
    if (paths.length === 0) {
      return options.force
        ? { stdout: '', stderr: '', exitCode: 0 }
        : { stdout: '', stderr: 'rm: missing operand\n', exitCode: 1 };
    }
    const results = await Promise.all(paths.map((path) => removePath(ctx, path, options)));
    const stdout = results.map((result) => result.stdout).join('');
    const stderr = results.map((result) => result.stderr).join('');
    return { stdout, stderr, exitCode: stderr ? 1 : 0 };
  });
}

function formatStat(format: string, operand: string, stat: FsStat): string {
  const type = stat.isSymbolicLink
    ? 'symbolic link'
    : stat.isDirectory
      ? 'directory'
      : 'regular file';
  return format
    .replace(/%n/g, operand)
    .replace(/%N/g, `'${operand}'`)
    .replace(/%s/g, String(stat.size))
    .replace(/%F/g, type)
    .replace(/%a/g, stat.mode.toString(8));
}

interface StatArgs {
  format?: string;
  follow: boolean;
  paths: string[];
}

function parseStatArgs(args: string[]): StatArgs {
  const parsed: StatArgs = { follow: false, paths: [] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-L' || arg === '--dereference') parsed.follow = true;
    else if (arg === '-c' && args[i + 1]) parsed.format = args[++i];
    else if (arg.startsWith('--format=')) parsed.format = arg.slice(9);
    else if (!arg.startsWith('-')) parsed.paths.push(arg);
  }
  return parsed;
}

async function statOperand(
  ctx: CommandContext,
  operand: string,
  options: StatArgs
): Promise<{ stdout: string; stderr: string }> {
  try {
    const path = ctx.fs.resolvePath(ctx.cwd, operand);
    const stat = options.follow ? await ctx.fs.stat(path) : await lstat(ctx, path);
    const stdout = options.format
      ? `${formatStat(options.format, operand, stat)}\n`
      : `  File: ${operand}\n  Size: ${stat.size}\n`;
    return { stdout, stderr: '' };
  } catch {
    return { stdout: '', stderr: `stat: cannot stat '${operand}': No such file or directory\n` };
  }
}

export function createStatCommand(): Command {
  return defineCommand('stat', async (args, ctx) => {
    const options = parseStatArgs(args);
    if (options.paths.length === 0) {
      return { stdout: '', stderr: 'stat: missing operand\n', exitCode: 1 };
    }
    const results = await Promise.all(options.paths.map((path) => statOperand(ctx, path, options)));
    const stdout = results.map((result) => result.stdout).join('');
    const stderr = results.map((result) => result.stderr).join('');
    return { stdout, stderr, exitCode: stderr ? 1 : 0 };
  });
}

function parentPath(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  const slash = trimmed.lastIndexOf('/');
  return slash <= 0 ? '/' : trimmed.slice(0, slash);
}

async function removeDirectory(
  ctx: CommandContext,
  operand: string,
  parents: boolean,
  verbose: boolean
): Promise<{ stdout: string; stderr: string }> {
  let path = ctx.fs.resolvePath(ctx.cwd, operand);
  let stdout = '';
  for (;;) {
    try {
      const stat = await lstat(ctx, path);
      if (!stat.isDirectory || stat.isSymbolicLink) throw new Error('Not a directory');
      await ctx.fs.rm(path, { recursive: false, force: false });
      if (verbose) stdout += `rmdir: removing directory, '${path}'\n`;
    } catch (error) {
      return { stdout, stderr: `rmdir: failed to remove '${operand}': ${errorDetail(error)}\n` };
    }
    if (!parents || path === '/') return { stdout, stderr: '' };
    path = parentPath(path);
  }
}

export function createRmdirCommand(): Command {
  return defineCommand('rmdir', async (args, ctx) => {
    const parents = args.some((arg) => arg === '-p' || arg === '--parents');
    const verbose = args.some((arg) => arg === '-v' || arg === '--verbose');
    const paths = args.filter((arg) => !arg.startsWith('-'));
    if (paths.length === 0) {
      return { stdout: '', stderr: 'rmdir: missing operand\n', exitCode: 1 };
    }
    const results = await Promise.all(
      paths.map((path) => removeDirectory(ctx, path, parents, verbose))
    );
    const stdout = results.map((result) => result.stdout).join('');
    const stderr = results.map((result) => result.stderr).join('');
    return { stdout, stderr, exitCode: stderr ? 1 : 0 };
  });
}
