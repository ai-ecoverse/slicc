import type { ExecResult, IFileSystem, ResolvedCommandContext } from 'just-bash';
import { stdinAsLatin1 } from '../../just-bash-compat.js';

export const RG_BINARY_PEEK_BYTES = 8192;

export function searchableInputLimit(limits: {
  maxLiveBytes: number;
  maxInputBytes: number;
}): number {
  return Math.min(limits.maxInputBytes, Math.floor(limits.maxLiveBytes / 2));
}

const VALUE_SHORT = new Set(['g', 't', 'T', 'm', 'e', 'f', 'r', 'd', 'j', 'A', 'B', 'C']);
const VALUE_LONG = new Set([
  'glob',
  'iglob',
  'type',
  'type-not',
  'type-add',
  'type-clear',
  'max-count',
  'regexp',
  'file',
  'replace',
  'max-depth',
  'max-filesize',
  'context-separator',
  'threads',
  'ignore-file',
  'pre',
  'pre-glob',
  'sort',
]);
const FILE_SELECT_SHORT = new Set(['g', 't', 'T', 'd', 'L', 'u', 'z']);
const FILE_SELECT_LONG = new Set([
  'glob',
  'iglob',
  'glob-case-insensitive',
  'type',
  'type-not',
  'type-add',
  'type-clear',
  'max-depth',
  'max-filesize',
  'hidden',
  'no-ignore',
  'no-ignore-dot',
  'no-ignore-vcs',
  'follow',
  'unrestricted',
  'ignore-file',
  'search-zip',
]);
const PATTERN_SHORT = new Set(['e', 'f']);
const PATTERN_LONG = new Set(['regexp', 'file']);

interface ParsedRg {
  help: boolean;
  typeList: boolean;
  filesMode: boolean;
  searchBinary: boolean;
  hasPatternOption: boolean;
  unrestricted: number;
  endOfOptions: boolean;
  nullSeparated: boolean;
  noFilename: boolean;
  withFilename: boolean;
  countMode: boolean;
  includeZero: boolean;
  flagTokens: string[];
  fileSelectArgs: string[];
  positionals: string[];
}

function emptyParsed(): ParsedRg {
  return {
    help: false,
    typeList: false,
    filesMode: false,
    searchBinary: false,
    hasPatternOption: false,
    unrestricted: 0,
    endOfOptions: false,
    nullSeparated: false,
    noFilename: false,
    withFilename: false,
    countMode: false,
    includeZero: false,
    flagTokens: [],
    fileSelectArgs: [],
    positionals: [],
  };
}

function longName(token: string): string | null {
  if (!token.startsWith('--') || token === '--') return null;
  const eq = token.indexOf('=');
  return eq === -1 ? token.slice(2) : token.slice(2, eq);
}

function takeNext(args: string[], i: number): { value: string; next: number } | null {
  if (i + 1 >= args.length) return null;
  return { value: args[i + 1]!, next: i + 1 };
}

function isFileSelectValue(
  name: string,
  patternNames: Set<string>,
  fileNames: Set<string>
): boolean {
  return fileNames.has(name) && !patternNames.has(name);
}

function noteMeta(parsed: ParsedRg, arg: string): void {
  if (arg === '--help') parsed.help = true;
  if (arg === '--type-list') parsed.typeList = true;
  if (arg === '--files') parsed.filesMode = true;
  if (arg === '--text' || arg === '-a') parsed.searchBinary = true;
  if (arg === '--null' || arg === '-0') parsed.nullSeparated = true;
  if (arg === '--no-filename' || arg === '-h') parsed.noFilename = true;
  if (arg === '--with-filename' || arg === '-H') parsed.withFilename = true;
  if (arg === '--count' || arg === '--count-matches') parsed.countMode = true;
  if (arg === '--include-zero') parsed.includeZero = true;
}

function recordLong(parsed: ParsedRg, arg: string, args: string[], i: number): number {
  const long = longName(arg);
  if (!long) return i;
  parsed.flagTokens.push(arg);
  if (long === 'count' || long === 'count-matches') parsed.countMode = true;
  if (long === 'include-zero') parsed.includeZero = true;
  if (PATTERN_LONG.has(long)) parsed.hasPatternOption = true;
  const attached = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : undefined;
  if (VALUE_LONG.has(long)) {
    if (attached !== undefined) {
      if (isFileSelectValue(long, PATTERN_LONG, FILE_SELECT_LONG)) parsed.fileSelectArgs.push(arg);
      return i;
    }
    const taken = takeNext(args, i);
    if (!taken) return i;
    parsed.flagTokens.push(taken.value);
    if (isFileSelectValue(long, PATTERN_LONG, FILE_SELECT_LONG)) {
      parsed.fileSelectArgs.push(`--${long}`, taken.value);
    }
    return taken.next;
  }
  if (FILE_SELECT_LONG.has(long)) parsed.fileSelectArgs.push(arg);
  if (long === 'unrestricted') parsed.unrestricted += 1;
  return i;
}

function noteShortLetter(parsed: ParsedRg, ch: string): void {
  if (ch === 'a') parsed.searchBinary = true;
  if (ch === '0') parsed.nullSeparated = true;
  if (ch === 'h') parsed.noFilename = true;
  if (ch === 'H') parsed.withFilename = true;
  if (ch === 'c') parsed.countMode = true;
  if (ch === 'u') {
    parsed.unrestricted += 1;
    parsed.fileSelectArgs.push('-u');
  }
  if (PATTERN_SHORT.has(ch)) parsed.hasPatternOption = true;
}

function recordShortValue(
  parsed: ParsedRg,
  ch: string,
  rest: string,
  args: string[],
  i: number
): number {
  if (rest.length > 0) {
    if (isFileSelectValue(ch, PATTERN_SHORT, FILE_SELECT_SHORT)) {
      parsed.fileSelectArgs.push(`-${ch}`, rest);
    }
    return i;
  }
  const taken = takeNext(args, i);
  if (!taken) return i;
  parsed.flagTokens.push(taken.value);
  if (isFileSelectValue(ch, PATTERN_SHORT, FILE_SELECT_SHORT)) {
    parsed.fileSelectArgs.push(`-${ch}`, taken.value);
  }
  return taken.next;
}

function recordShort(parsed: ParsedRg, arg: string, args: string[], i: number): number {
  const body = arg.slice(1);
  if (body.length === 0) {
    parsed.positionals.push(arg);
    return i;
  }
  parsed.flagTokens.push(arg);
  for (let c = 0; c < body.length; c++) {
    const ch = body[c]!;
    noteShortLetter(parsed, ch);
    if (VALUE_SHORT.has(ch)) return recordShortValue(parsed, ch, body.slice(c + 1), args, i);
    if (FILE_SELECT_SHORT.has(ch) && ch !== 'u') parsed.fileSelectArgs.push(`-${ch}`);
  }
  return i;
}

function parseRgArgv(args: string[]): ParsedRg {
  const parsed = emptyParsed();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--') {
      parsed.endOfOptions = true;
      parsed.positionals.push(...args.slice(i + 1));
      break;
    }
    if (arg === '-' || !arg.startsWith('-')) {
      parsed.positionals.push(arg);
      continue;
    }
    noteMeta(parsed, arg);
    if (longName(arg)) {
      i = recordLong(parsed, arg, args, i);
      continue;
    }
    i = recordShort(parsed, arg, args, i);
  }

  if (parsed.unrestricted >= 3) parsed.searchBinary = true;
  return parsed;
}

function operandPaths(parsed: ParsedRg): string[] {
  return parsed.hasPatternOption ? parsed.positionals : parsed.positionals.slice(1);
}

function needsEndOfOptions(operands: string[]): boolean {
  return operands.some((operand) => operand.startsWith('-') && operand !== '-');
}

function listingArgs(parsed: ParsedRg): string[] {
  const out = ['--files'];
  if (parsed.nullSeparated) out.push('--null');
  out.push(...parsed.fileSelectArgs, ...operandPaths(parsed));
  return out;
}

function searchArgs(parsed: ParsedRg, files: string[], withFilename: boolean): string[] {
  const flags = [...parsed.flagTokens];
  if (withFilename && !parsed.noFilename && !parsed.withFilename) flags.push('-H');
  const pattern = parsed.hasPatternOption ? undefined : parsed.positionals[0];

  if (pattern !== undefined && (parsed.endOfOptions || needsEndOfOptions([pattern]))) {
    flags.push('-e', pattern);
    return [...flags, ...files];
  }
  return pattern === undefined ? [...flags, ...files] : [...flags, pattern, ...files];
}

function splitListedFiles(stdout: string, nullSeparated: boolean): string[] {
  const raw = nullSeparated ? stdout.split('\0') : stdout.split('\n');
  return raw.map((line) => line.trimEnd()).filter((line) => line.length > 0);
}

function bufferHasNul(bytes: Uint8Array, limit: number): boolean {
  const n = Math.min(bytes.byteLength, limit);
  for (let i = 0; i < n; i++) {
    if (bytes[i] === 0) return true;
  }
  return false;
}

interface RangeReadable {
  readFileRange?(path: string, start: number, end: number): Promise<Uint8Array>;
}

export async function peekBytes(
  fs: IFileSystem,
  path: string,
  limit: number,
  identity?: object
): Promise<Uint8Array> {
  for (const candidate of [fs, identity]) {
    if (!candidate || typeof candidate !== 'object') continue;
    const ranged = (candidate as RangeReadable).readFileRange;
    if (typeof ranged === 'function') return ranged.call(candidate, path, 0, limit);
  }
  const bytes = await fs.readFileBuffer(path);
  return bytes.byteLength > limit ? bytes.subarray(0, limit) : bytes;
}

async function fileIsBinary(fs: IFileSystem, path: string, identity?: object): Promise<boolean> {
  try {
    return bufferHasNul(
      await peekBytes(fs, path, RG_BINARY_PEEK_BYTES, identity),
      RG_BINARY_PEEK_BYTES
    );
  } catch {
    return false;
  }
}

async function classifyOperands(
  ctx: ResolvedCommandContext,
  paths: string[]
): Promise<{ missing: string[]; includeDirectory: boolean }> {
  if (paths.length === 0) return { missing: [], includeDirectory: true };
  const missing: string[] = [];
  let includeDirectory = false;
  for (const rel of paths) {
    try {
      const stat = await ctx.fs.stat(ctx.fs.resolvePath(ctx.cwd, rel));
      if (stat.isDirectory) includeDirectory = true;
    } catch {
      missing.push(rel);
    }
  }
  return { missing, includeDirectory };
}

function missingPathResult(paths: string[]): ExecResult {
  return {
    stdout: '',
    stderr: paths.map((path) => `rg: ${path}: No such file or directory\n`).join(''),
    exitCode: 2,
  };
}

function mergeListingFailure(listed: ExecResult, result: ExecResult): ExecResult {
  return {
    stdout: result.stdout,
    stderr: `${listed.stderr}${result.stderr}`,
    exitCode:
      result.exitCode === 0 || result.exitCode === 1
        ? Math.max(listed.exitCode, 2)
        : result.exitCode,
  };
}

async function searchableFiles(
  ctx: ResolvedCommandContext,
  listed: string[],
  searchBinary: boolean
): Promise<{ files: string[]; bytes: number }> {
  const files: string[] = [];
  let bytes = 0;
  for (const rel of listed) {
    const full = ctx.fs.resolvePath(ctx.cwd, rel);
    let size = 0;
    try {
      const stat = await ctx.fs.stat(full);
      if (!stat.isFile) continue;
      size = stat.size;
    } catch {
      continue;
    }
    if (!searchBinary && (await fileIsBinary(ctx.fs, full, ctx.fsIdentity))) continue;
    files.push(rel);
    bytes += size;
  }
  return { files, bytes };
}

function limitResult(enforced: number): ExecResult {
  return {
    stdout: '',
    stderr: `rg: searchable input size limit exceeded (${enforced} bytes)\n`,
    exitCode: 2,
  };
}

function omitImplicitStdinZeroCount(parsed: ParsedRg, result: ExecResult): ExecResult {
  if (!parsed.countMode || parsed.includeZero || result.exitCode !== 1) return result;
  if (result.stdout !== '0' && result.stdout !== '0\n') return result;
  return { ...result, stdout: '' };
}

export async function runRg(args: string[], ctx: ResolvedCommandContext): Promise<ExecResult> {
  if (!ctx.origCommand) {
    return { stdout: '', stderr: 'rg: command not found\n', exitCode: 127 };
  }
  const orig = ctx.origCommand;
  const parsed = parseRgArgv(args);

  if (parsed.help || parsed.typeList || parsed.filesMode) {
    return orig(args);
  }

  const stdinLen = stdinAsLatin1(ctx.stdin).length;
  const paths = operandPaths(parsed);
  if (paths.length === 0 && stdinLen > 0) {
    return omitImplicitStdinZeroCount(parsed, await orig(args));
  }

  const { missing, includeDirectory } = await classifyOperands(ctx, paths);
  const listed = await orig(listingArgs(parsed));
  const listingFailed = listed.exitCode !== 0 || missing.length > 0;
  const listingError =
    missing.length > 0 ? missingPathResult(missing) : listed.exitCode !== 0 ? listed : null;
  if (listingFailed && listed.stdout.length === 0) {
    return listingError ?? listed;
  }
  const names = splitListedFiles(listed.stdout, parsed.nullSeparated);
  const { files, bytes } = await searchableFiles(ctx, names, parsed.searchBinary);
  if (files.length === 0) {
    return listingError ?? { stdout: '', stderr: '', exitCode: 1 };
  }

  const enforced = searchableInputLimit(ctx.limits);
  if (bytes > enforced) {
    return limitResult(enforced);
  }
  const result = await orig(searchArgs(parsed, files, includeDirectory));
  return listingError ? mergeListingFailure(listingError, result) : result;
}
