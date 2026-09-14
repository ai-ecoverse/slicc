import type { Command, CommandContext } from 'just-bash';
import { defineCommand } from 'just-bash';
import { gunzip, gzip, readTar, type TarEntry, writeTar } from '../ipk/tar.js';
import { basename, dirname, ensureWithinRoot, joinPath } from './shared.js';

type TarMode = 'create' | 'extract' | 'list';

interface TarOptions {
  mode?: TarMode;
  archive?: string;
  gzip: boolean;
  verbose: boolean;
  directory: string;
  paths: string[];
}

interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function tarHelp(): CommandResult {
  return {
    stdout: 'usage: tar (-c|-x|-t) [-zv] -f <archive> [-C <dir>] [paths...]\n',
    stderr: '',
    exitCode: 0,
  };
}

function tarError(message: string): CommandResult {
  return { stdout: '', stderr: `tar: ${message}\n`, exitCode: 1 };
}

function setMode(options: TarOptions, mode: TarMode): CommandResult | undefined {
  if (options.mode) return tarError('exactly one of -c, -x, or -t is required');
  options.mode = mode;
}

function readFlagValue(
  args: string[],
  index: number,
  inline: string
): [string, number] | undefined {
  if (inline) return [inline, index];
  const value = args[index + 1];
  return value === undefined ? undefined : [value, index + 1];
}

interface FlagResult {
  nextIndex: number;
  consumedValue?: boolean;
  error?: CommandResult;
}

const MODE_FLAGS: Record<string, TarMode> = { c: 'create', x: 'extract', t: 'list' };

function applyTarFlag(
  flag: string,
  inline: string,
  args: string[],
  index: number,
  options: TarOptions
): FlagResult {
  const mode = MODE_FLAGS[flag];
  if (mode) return { nextIndex: index, error: setMode(options, mode) };
  if (flag === 'z') {
    options.gzip = true;
    return { nextIndex: index };
  }
  if (flag === 'v') {
    options.verbose = true;
    return { nextIndex: index };
  }
  if (flag !== 'f' && flag !== 'C') {
    return { nextIndex: index, error: tarError(`unsupported option -${flag}`) };
  }
  const value = readFlagValue(args, index, inline);
  if (!value) {
    return { nextIndex: index, error: tarError(`option -${flag} requires an argument`) };
  }
  if (flag === 'f') options.archive = value[0];
  else options.directory = value[0];
  return { nextIndex: value[1], consumedValue: true };
}

function parseTarOption(args: string[], index: number, options: TarOptions): FlagResult {
  const arg = args[index];
  for (let offset = 1; offset < arg.length; offset++) {
    const result = applyTarFlag(arg[offset], arg.slice(offset + 1), args, index, options);
    if (result.error || result.consumedValue) return result;
  }
  return { nextIndex: index };
}

function parseTarArgs(args: string[]): TarOptions | CommandResult {
  const options: TarOptions = { gzip: false, verbose: false, directory: '.', paths: [] };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (!arg.startsWith('-') || arg === '-') {
      options.paths.push(arg);
      continue;
    }
    if (arg.startsWith('--')) return tarError(`unsupported option ${arg}`);
    const result = parseTarOption(args, index, options);
    if (result.error) return result.error;
    index = result.nextIndex;
  }
  return options;
}

function archiveEntryRoot(input: string, resolved: string): string {
  const normalized = input
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/^(?:\.\/)+/, '');
  if (!normalized) return basename(resolved);
  return normalized === '.' ? '.' : normalized.replace(/\/+$/, '');
}

async function addPathToTar(
  ctx: CommandContext,
  fsPath: string,
  archivePath: string,
  entries: TarEntry[]
): Promise<void> {
  const stat = await ctx.fs.stat(fsPath);
  if (stat.isFile) {
    entries.push({ path: archivePath, bytes: await ctx.fs.readFileBuffer(fsPath) });
    return;
  }
  if (!stat.isDirectory) throw new Error(`unsupported file type: ${fsPath}`);
  const directoryPath = archivePath.endsWith('/') ? archivePath : `${archivePath}/`;
  entries.push({ path: directoryPath, bytes: new Uint8Array(0), directory: true });
  for (const name of await ctx.fs.readdir(fsPath)) {
    await addPathToTar(ctx, joinPath(fsPath, name), `${directoryPath}${name}`, entries);
  }
}

function readArchive(bytes: Uint8Array, gzipRequested: boolean): TarEntry[] {
  const gzipMagic = bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
  const tarBytes = gzipRequested || gzipMagic ? gunzip(bytes) : bytes;
  return readTar(tarBytes, {
    stripNpmPrefix: false,
    includeDirectories: true,
    preserveRawPaths: true,
  });
}

function safeOutputPath(ctx: CommandContext, root: string, entryPath: string): string | undefined {
  const normalized = entryPath.replace(/\\/g, '/');
  if (
    !normalized ||
    normalized.startsWith('/') ||
    /^[a-zA-Z]:\//.test(normalized) ||
    normalized.split('/').includes('..')
  ) {
    return undefined;
  }
  const outputPath = ctx.fs.resolvePath(root, normalized);
  return ensureWithinRoot(root, outputPath) ? outputPath : undefined;
}

async function createArchive(options: TarOptions, ctx: CommandContext): Promise<CommandResult> {
  if (options.paths.length === 0) return tarError('create mode requires at least one input path');
  const entries: TarEntry[] = [];
  const inputRoot = ctx.fs.resolvePath(ctx.cwd, options.directory);
  for (const input of options.paths) {
    const resolved = ctx.fs.resolvePath(inputRoot, input);
    await addPathToTar(ctx, resolved, archiveEntryRoot(input, resolved), entries);
  }
  const archivePath = ctx.fs.resolvePath(ctx.cwd, options.archive!);
  const bytes = writeTar(entries);
  await ctx.fs.writeFile(archivePath, options.gzip ? gzip(bytes) : bytes);
  return {
    stdout: options.verbose ? `${entries.map((entry) => entry.path).join('\n')}\n` : '',
    stderr: '',
    exitCode: 0,
  };
}

async function readArchiveCommand(
  options: TarOptions,
  ctx: CommandContext
): Promise<CommandResult> {
  if (options.paths.length > 0) return tarError(`${options.mode} mode does not accept input paths`);
  const archivePath = ctx.fs.resolvePath(ctx.cwd, options.archive!);
  const entries = readArchive(await ctx.fs.readFileBuffer(archivePath), options.gzip);
  if (options.mode === 'list') {
    const stdout = entries.map((entry) => entry.path).join('\n');
    return { stdout: stdout ? `${stdout}\n` : '', stderr: '', exitCode: 0 };
  }

  const outputRoot = ctx.fs.resolvePath(ctx.cwd, options.directory);
  await ctx.fs.mkdir(outputRoot, { recursive: true });
  const extracted: string[] = [];
  for (const entry of entries) {
    const outputPath = safeOutputPath(ctx, outputRoot, entry.path);
    if (!outputPath) return tarError(`blocked suspicious path ${entry.path}`);
    if (entry.directory) {
      await ctx.fs.mkdir(outputPath, { recursive: true });
    } else {
      const parent = dirname(outputPath);
      if (parent !== '/') await ctx.fs.mkdir(parent, { recursive: true });
      await ctx.fs.writeFile(outputPath, entry.bytes);
    }
    extracted.push(entry.path);
  }
  return {
    stdout: options.verbose ? `${extracted.join('\n')}\n` : '',
    stderr: '',
    exitCode: 0,
  };
}

export function createTarCommand(): Command {
  return defineCommand('tar', async (args, ctx) => {
    if (args.length === 0 || args.includes('--help') || args.includes('-h')) return tarHelp();
    const options = parseTarArgs(args);
    if ('exitCode' in options) return options;
    if (!options.mode) return tarError('exactly one of -c, -x, or -t is required');
    if (!options.archive) return tarError('option -f requires an archive path');
    if (options.mode === 'list' && options.directory !== '.') {
      return tarError('-C is only supported in create or extract mode');
    }
    return options.mode === 'create'
      ? createArchive(options, ctx)
      : readArchiveCommand(options, ctx);
  });
}
