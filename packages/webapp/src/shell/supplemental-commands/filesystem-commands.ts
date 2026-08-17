import type { Command, CommandContext, ExecResult, FsStat } from 'just-bash';
import { defineCommand } from 'just-bash';

function resolve(ctx: CommandContext, path: string): string {
  return ctx.fs.resolvePath(ctx.cwd, path);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function removePath(
  path: string,
  ctx: CommandContext,
  options: { recursive: boolean; force: boolean; verbose: boolean }
): Promise<ExecResult> {
  const resolved = resolve(ctx, path);
  try {
    const stat = await ctx.fs.lstat(resolved);
    if (stat.isDirectory && !stat.isSymbolicLink && !options.recursive) {
      return { stdout: '', stderr: `rm: cannot remove '${path}': Is a directory\n`, exitCode: 1 };
    }
    await ctx.fs.rm(resolved, { recursive: options.recursive, force: options.force });
    return {
      stdout: options.verbose ? `removed '${path}'\n` : '',
      stderr: '',
      exitCode: 0,
    };
  } catch (error) {
    if (options.force && errorText(error).includes('ENOENT')) {
      return { stdout: '', stderr: '', exitCode: 0 };
    }
    const message = errorText(error).includes('ENOENT')
      ? 'No such file or directory'
      : errorText(error);
    return { stdout: '', stderr: `rm: cannot remove '${path}': ${message}\n`, exitCode: 1 };
  }
}

interface RmArgs {
  recursive: boolean;
  force: boolean;
  verbose: boolean;
  paths: string[];
}

function applyRmFlag(parsed: RmArgs, flag: string): string | null {
  if (flag === 'r' || flag === 'R') parsed.recursive = true;
  else if (flag === 'f') parsed.force = true;
  else if (flag === 'v') parsed.verbose = true;
  else return flag;
  return null;
}

function rmFlags(arg: string): string {
  const longFlags: Record<string, string> = {
    '--recursive': 'r',
    '--force': 'f',
    '--verbose': 'v',
  };
  return longFlags[arg] ?? arg.slice(1);
}

function parseRmArgs(args: string[]): RmArgs | string {
  const parsed: RmArgs = { recursive: false, force: false, verbose: false, paths: [] };
  let parsingOptions = true;
  for (const arg of args) {
    if (arg === '--' && parsingOptions) {
      parsingOptions = false;
      continue;
    }
    if (!parsingOptions || !arg.startsWith('-') || arg === '-') {
      parsed.paths.push(arg);
      continue;
    }
    for (const flag of rmFlags(arg)) {
      const invalid = applyRmFlag(parsed, flag);
      if (invalid) return invalid;
    }
  }
  return parsed;
}

async function removePaths(parsed: RmArgs, ctx: CommandContext): Promise<ExecResult> {
  let stdout = '';
  let stderr = '';
  let exitCode = 0;
  for (const path of parsed.paths) {
    const result = await removePath(path, ctx, parsed);
    stdout += result.stdout;
    stderr += result.stderr;
    if (result.exitCode !== 0) exitCode = result.exitCode;
  }
  return { stdout, stderr, exitCode };
}

export function createRmCommand(): Command {
  return defineCommand('rm', async (args, ctx) => {
    const parsed = parseRmArgs(args);
    if (typeof parsed === 'string') {
      return { stdout: '', stderr: `rm: invalid option -- '${parsed}'\n`, exitCode: 1 };
    }
    if (parsed.paths.length > 0) return removePaths(parsed, ctx);
    return parsed.force
      ? { stdout: '', stderr: '', exitCode: 0 }
      : { stdout: '', stderr: 'rm: missing operand\n', exitCode: 1 };
  });
}

export function createUnlinkCommand(): Command {
  return defineCommand('unlink', async (args, ctx) => {
    if (args.length !== 1) {
      return {
        stdout: '',
        stderr: args.length === 0 ? 'unlink: missing operand\n' : 'unlink: extra operand\n',
        exitCode: 1,
      };
    }
    const path = args[0];
    try {
      const resolved = resolve(ctx, path);
      const stat = await ctx.fs.lstat(resolved);
      if (stat.isDirectory && !stat.isSymbolicLink) {
        return {
          stdout: '',
          stderr: `unlink: cannot unlink '${path}': Is a directory\n`,
          exitCode: 1,
        };
      }
      await ctx.fs.rm(resolved, { recursive: false, force: false });
      return { stdout: '', stderr: '', exitCode: 0 };
    } catch (error) {
      return {
        stdout: '',
        stderr: `unlink: cannot unlink '${path}': ${errorText(error)}\n`,
        exitCode: 1,
      };
    }
  });
}

export function createRmdirCommand(): Command {
  return defineCommand('rmdir', async (args, ctx) => {
    const paths = args.filter((arg) => arg !== '--');
    if (paths.length === 0) {
      return { stdout: '', stderr: 'rmdir: missing operand\n', exitCode: 1 };
    }
    let stderr = '';
    let exitCode = 0;
    for (const path of paths) {
      try {
        const resolved = resolve(ctx, path);
        const stat = await ctx.fs.lstat(resolved);
        if (!stat.isDirectory || stat.isSymbolicLink) {
          stderr += `rmdir: failed to remove '${path}': Not a directory\n`;
          exitCode = 1;
          continue;
        }
        await ctx.fs.rm(resolved, { recursive: false, force: false });
      } catch (error) {
        stderr += `rmdir: failed to remove '${path}': ${errorText(error)}\n`;
        exitCode = 1;
      }
    }
    return { stdout: '', stderr, exitCode };
  });
}

function fileType(stat: FsStat): string {
  if (stat.isSymbolicLink) return 'symbolic link';
  if (stat.isDirectory) return 'directory';
  return 'regular file';
}

interface StatArgs {
  follow: boolean;
  format: string | null;
  paths: string[];
}

function parseStatArgs(args: string[]): StatArgs | ExecResult {
  const parsed: StatArgs = { follow: false, format: null, paths: [] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-L' || arg === '--dereference') parsed.follow = true;
    else if (arg === '-c' || arg === '--format') parsed.format = args[++i] ?? '';
    else if (arg.startsWith('--format=')) parsed.format = arg.slice('--format='.length);
    else if (arg === '--') {
      parsed.paths.push(...args.slice(i + 1));
      break;
    } else if (arg.startsWith('-')) {
      return { stdout: '', stderr: `stat: invalid option -- '${arg}'\n`, exitCode: 1 };
    } else parsed.paths.push(arg);
  }
  return parsed;
}

function formatStat(path: string, stat: FsStat, format: string | null): string {
  if (format === null) return `  File: ${path}\n  Size: ${stat.size}\n  Type: ${fileType(stat)}\n`;
  return `${format
    .replace(/%n/g, path)
    .replace(/%N/g, `'${path}'`)
    .replace(/%s/g, String(stat.size))
    .replace(/%F/g, fileType(stat))}\n`;
}

async function statPaths(parsed: StatArgs, ctx: CommandContext): Promise<ExecResult> {
  let stdout = '';
  let stderr = '';
  let exitCode = 0;
  for (const path of parsed.paths) {
    try {
      const resolved = resolve(ctx, path);
      const stat = parsed.follow ? await ctx.fs.stat(resolved) : await ctx.fs.lstat(resolved);
      stdout += formatStat(path, stat, parsed.format);
    } catch {
      stderr += `stat: cannot stat '${path}': No such file or directory\n`;
      exitCode = 1;
    }
  }
  return { stdout, stderr, exitCode };
}

export function createStatCommand(): Command {
  return defineCommand('stat', async (args, ctx) => {
    const parsed = parseStatArgs(args);
    if ('exitCode' in parsed) return parsed;
    if (parsed.paths.length > 0) return statPaths(parsed, ctx);
    return { stdout: '', stderr: 'stat: missing operand\n', exitCode: 1 };
  });
}
