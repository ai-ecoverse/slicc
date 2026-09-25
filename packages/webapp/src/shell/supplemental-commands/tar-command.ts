import type { Command, CommandContext } from 'just-bash';
import { defineCommand } from 'just-bash';
import type { MetadataUpdate, VirtualFS } from '../../fs/index.js';
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

export interface TarCommandDeps {
  /**
   * Backing VFS for batched metadata writes. just-bash's per-exec umask
   * wrapper only forwards `IFileSystem` methods onto `ctx.fs`, so `tar x`
   * must call {@link VirtualFS.updateMetadataBatch} on this handle.
   */
  fs?: Pick<VirtualFS, 'updateMetadataBatch'>;
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

/** A first argument like `xzf` is the traditional dashless form of `-xzf`. */
const TRADITIONAL_BUNDLE = /^[cxtzvfC]+$/;

function parseTarArgs(rawArgs: string[]): TarOptions | CommandResult {
  const args =
    rawArgs.length > 0 && TRADITIONAL_BUNDLE.test(rawArgs[0])
      ? [`-${rawArgs[0]}`, ...rawArgs.slice(1)]
      : rawArgs;
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

/** A stat's mtime as whole epoch seconds, the tar header's unit. */
function mtimeOf(stat: { mtime?: Date }): { mtime?: number } {
  const ms = stat.mtime?.getTime();
  return ms === undefined || Number.isNaN(ms) ? {} : { mtime: Math.floor(ms / 1000) };
}

async function addPathToTar(
  ctx: CommandContext,
  fsPath: string,
  archivePath: string,
  entries: TarEntry[]
): Promise<void> {
  const stat = await ctx.fs.stat(fsPath);
  if (stat.isFile) {
    const bytes = await ctx.fs.readFileBuffer(fsPath);
    const mode = typeof stat.mode === 'number' ? stat.mode & 0o777 : undefined;
    entries.push({
      path: archivePath,
      bytes,
      ...(mode === undefined ? {} : { mode }),
      ...mtimeOf(stat),
    });
    return;
  }
  if (!stat.isDirectory) throw new Error(`unsupported file type: ${fsPath}`);
  const directoryPath = archivePath.endsWith('/') ? archivePath : `${archivePath}/`;
  const mode = typeof stat.mode === 'number' ? stat.mode & 0o777 : undefined;
  entries.push({
    path: directoryPath,
    bytes: new Uint8Array(0),
    directory: true,
    ...(mode === undefined ? {} : { mode }),
    ...mtimeOf(stat),
  });
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

/** Run a metadata change, tolerating a backend without it (a mount answers ENOSYS). */
async function bestEffortMetadata(change: () => Promise<void>): Promise<void> {
  try {
    await change();
  } catch (err) {
    const code = (err as { code?: unknown })?.code;
    if (code === 'ENOSYS' || code === 'ENOTSUP' || code === 'EOPNOTSUPP') return;
    throw err;
  }
}

type MetadataBatchFs = {
  updateMetadataBatch?(updates: readonly MetadataUpdate[]): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  utimes(path: string, atime: Date, mtime: Date): Promise<void>;
};

/**
 * Apply collected modes/times in one VFS sidecar write when a batch API is
 * available (the registered VirtualFS, not `ctx.fs` — just-bash's umask
 * wrapper omits non-IFileSystem methods); otherwise fall back to per-path
 * chmod/utimes (still best-effort for mounts). The batch API skips mount
 * members itself so a mixed VFS+mount extract still applies local metadata.
 */
async function applyMetadataBatch(
  ctx: CommandContext,
  modes: Array<[string, number]>,
  times: Array<[string, number]>,
  batchFs?: Pick<VirtualFS, 'updateMetadataBatch'>
): Promise<void> {
  const modeMap = new Map(modes);
  const timeMap = new Map(times);
  const paths = [...new Set([...modeMap.keys(), ...timeMap.keys()])];
  if (paths.length === 0) return;

  const updates: MetadataUpdate[] = paths.map((path) => {
    const mode = modeMap.get(path);
    const seconds = timeMap.get(path);
    const when = seconds === undefined ? undefined : new Date(seconds * 1000);
    return {
      path,
      ...(mode === undefined ? {} : { mode }),
      ...(when === undefined ? {} : { atime: when, mtime: when }),
    };
  });

  if (typeof batchFs?.updateMetadataBatch === 'function') {
    await bestEffortMetadata(() => batchFs.updateMetadataBatch!(updates));
    return;
  }

  const fs = ctx.fs as MetadataBatchFs;
  if (typeof fs.updateMetadataBatch === 'function') {
    await bestEffortMetadata(() => fs.updateMetadataBatch!(updates));
    return;
  }

  for (const [path, mode] of modes) {
    await bestEffortMetadata(() => fs.chmod(path, mode));
  }
  for (const [path, seconds] of times) {
    const when = new Date(seconds * 1000);
    await bestEffortMetadata(() => fs.utimes(path, when, when));
  }
}

/**
 * Write one entry. A directory's mode is queued for after the tree is
 * written (a read-only directory must still be filled); a file's mode is
 * queued too (applied in one sidecar write with mtimes after extract).
 */
async function extractEntry(
  ctx: CommandContext,
  outputPath: string,
  entry: TarEntry,
  dirModes: Array<[string, number]>,
  fileModes: Array<[string, number]>
): Promise<void> {
  const defaultMode = entry.directory ? 0o755 : 0o644;
  // An existing destination keeps its old mode, so the default must be set too.
  const resetsDefault = entry.mode === defaultMode && (await ctx.fs.exists(outputPath));
  const needsMode = entry.mode !== undefined && (entry.mode !== defaultMode || resetsDefault);
  if (entry.directory) {
    await ctx.fs.mkdir(outputPath, { recursive: true });
    if (needsMode) dirModes.push([outputPath, entry.mode as number]);
    return;
  }
  const parent = dirname(outputPath);
  if (parent !== '/') await ctx.fs.mkdir(parent, { recursive: true });
  await ctx.fs.writeFile(outputPath, entry.bytes);
  if (needsMode) fileModes.push([outputPath, entry.mode as number]);
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

/**
 * Reverse `list` (deepest paths first), keeping one entry per path: the LAST
 * archive member's, the one whose content extraction left in place. Reversing
 * alone would apply a duplicate path's earlier metadata last.
 */
function lastMemberWins(list: Array<[string, number]>): Array<[string, number]> {
  const seen = new Set<string>();
  const out: Array<[string, number]> = [];
  for (let i = list.length - 1; i >= 0; i--) {
    const [path, value] = list[i];
    if (seen.has(path)) continue;
    seen.add(path);
    out.push([path, value]);
  }
  return out;
}

async function readArchiveCommand(
  options: TarOptions,
  ctx: CommandContext,
  batchFs?: Pick<VirtualFS, 'updateMetadataBatch'>
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
  const fileModes: Array<[string, number]> = [];
  const dirModes: Array<[string, number]> = [];
  const mtimes: Array<[string, number]> = [];
  for (const entry of entries) {
    const outputPath = safeOutputPath(ctx, outputRoot, entry.path);
    if (!outputPath) return tarError(`blocked suspicious path ${entry.path}`);
    await extractEntry(ctx, outputPath, entry, dirModes, fileModes);
    if (entry.mtime !== undefined) mtimes.push([outputPath, entry.mtime]);
    extracted.push(entry.path);
  }
  // Modes deepest-first (restrictive parents after children are filled); times
  // last in the same batch so directory mtimes are not bumped by later writes.
  const modes = [...lastMemberWins(fileModes), ...lastMemberWins(dirModes)];
  await applyMetadataBatch(ctx, modes, lastMemberWins(mtimes), batchFs);
  return {
    stdout: options.verbose ? `${extracted.join('\n')}\n` : '',
    stderr: '',
    exitCode: 0,
  };
}

export function createTarCommand(deps: TarCommandDeps = {}): Command {
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
      : readArchiveCommand(options, ctx, deps.fs);
  });
}
