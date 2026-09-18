import type { CommandContext, IFileSystem } from 'just-bash';
import { scratchDir } from '../../tmpdir-env.js';

const MKTEMP_VERSION = 'mktemp (just-bash) 9.4\n';

const DEFAULT_TEMPLATE = 'tmp.XXXXXXXXXX';

const MIN_X = 3;

const MAX_ATTEMPTS = 100;

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

const REJECT_AT = 256 - (256 % ALPHABET.length);

const MAX_RANDOM_BYTES = 65536;

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

const HELP = `Usage: mktemp [OPTION]... [TEMPLATE]
Create a temporary file or directory and print its name.

Create a uniquely named temporary file (or directory with -d) and write its
name to standard output. TEMPLATE must end in at least three 'X's, which are
replaced with random characters; it defaults to tmp.XXXXXXXXXX. Without
-p/-t/--tmpdir a bare TEMPLATE is relative to the current directory, while the
default template is placed in $TMPDIR (or /tmp).

What you get back is a UNIQUE name, not a private one. Local VFS entries
store 0600/0700 modes, but access follows SLICC path policy and /tmp is
readable by every unit. Do not put secrets in a shared mktemp file.

  -d, --directory        create a directory, not a file
  -u, --dry-run          do not create anything, merely print a name
  -q, --quiet            suppress diagnostics about creation failure
      --suffix=SUFF      append SUFF to TEMPLATE (must not contain a slash)
  -p DIR, --tmpdir[=DIR] interpret TEMPLATE relative to DIR
                         (defaults to $TMPDIR, or /tmp when unset)
  -t                     interpret TEMPLATE as a single file name component,
                         relative to the temporary directory
  -h, --help             display this help and exit
      --version          output version information and exit

Examples:
  mktemp
  mktemp -d
  mktemp /tmp/build-XXXXXX
  mktemp --suffix=.txt fileXXXXXX
`;

type Result = { stdout: string; stderr: string; exitCode: number };

interface Options {
  directory: boolean;
  dryRun: boolean;
  quiet: boolean;
  legacyT: boolean;

  tmpdir?: string;
  suffix?: string;
  template?: string;
}

const SHORT_BOOLEANS: Readonly<Record<string, 'directory' | 'dryRun' | 'quiet' | 'legacyT'>> = {
  d: 'directory',
  u: 'dryRun',
  q: 'quiet',
  t: 'legacyT',
};

const SHORT_FLAGS = new Set([...Object.keys(SHORT_BOOLEANS), 'p', 'h']);

const LONG_FLAGS = new Set([
  'directory',
  'dry-run',
  'quiet',
  'tmpdir',
  'suffix',
  'help',
  'version',
]);

const NO_ARG_LONG_FLAGS = new Set(['directory', 'dry-run', 'quiet', 'help', 'version']);

function fail(message: string): Result {
  return { stdout: '', stderr: `mktemp: ${message}\n`, exitCode: 1 };
}

function isResult(value: unknown): value is Result {
  return typeof value === 'object' && value !== null && 'exitCode' in value;
}

function eachArg(args: readonly string[], visit: (arg: string, isOption: boolean) => void): void {
  let expectValue = false;
  let stopParsing = false;

  for (const arg of args) {
    if (stopParsing || expectValue) {
      visit(arg, false);
      expectValue = false;
      continue;
    }
    if (arg === '--') {
      stopParsing = true;
      visit(arg, false);
      continue;
    }

    if (!arg.startsWith('-') || arg === '-') {
      visit(arg, false);
      continue;
    }

    if (arg === '--suffix' || arg === '--tmpdir' || /^-[a-z]*p$/.test(arg)) {
      expectValue = arg !== '--tmpdir';
    }
    visit(arg, true);
  }
}

type MetaFlag = 'help' | 'version' | `no-arg:${string}`;

function metaFromLong(arg: string): MetaFlag | 'stop' | null {
  const eq = arg.indexOf('=');
  const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
  if (name === 'help' || name === 'version') {
    return eq === -1 ? name : `no-arg:${name}`;
  }
  if (!LONG_FLAGS.has(name)) return 'stop';

  return eq === -1 || !NO_ARG_LONG_FLAGS.has(name) ? null : 'stop';
}

function metaFromShortCluster(arg: string): MetaFlag | 'stop' | null {
  for (const char of arg.slice(1)) {
    if (char === 'h') return 'help';
    if (!SHORT_FLAGS.has(char)) return 'stop';

    if (char === 'p') return null;
  }
  return null;
}

function reachedHelpOrVersion(args: readonly string[]): MetaFlag | null {
  let result: MetaFlag | null = null;
  let stopped = false;

  eachArg(args, (arg, isOption) => {
    if (stopped || result || !isOption) return;
    const found = arg.startsWith('--') ? metaFromLong(arg) : metaFromShortCluster(arg);
    if (found === 'stop') stopped = true;
    else if (found) result = found;
  });

  return result;
}

function applyLongFlag(
  options: Options,
  args: readonly string[],
  index: number
): { next: number } | Result {
  const arg = args[index];
  const eq = arg.indexOf('=');
  const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
  const attached = eq === -1 ? undefined : arg.slice(eq + 1);

  if (NO_ARG_LONG_FLAGS.has(name) && attached !== undefined) {
    return fail(`option '--${name}' doesn't allow an argument`);
  }

  if (name === 'directory') options.directory = true;
  else if (name === 'dry-run') options.dryRun = true;
  else if (name === 'quiet') options.quiet = true;
  else if (name === 'tmpdir') options.tmpdir = attached ?? '';
  else if (name === 'suffix') {
    const value = attached ?? args[index + 1];
    if (value === undefined) return fail(`option '--suffix' requires an argument`);
    options.suffix = value;
    return { next: attached === undefined ? index + 1 : index };
  } else return fail(`unrecognized option '${arg}'`);

  return { next: index };
}

function applyShortCluster(
  options: Options,
  args: readonly string[],
  index: number
): { next: number } | Result {
  const arg = args[index];
  for (let pos = 1; pos < arg.length; pos++) {
    const char = arg[pos];
    if (char === 'p') {
      const inline = arg.slice(pos + 1);
      if (inline) {
        options.tmpdir = inline;
        return { next: index };
      }
      const value = args[index + 1];
      if (value === undefined) return fail(`option requires an argument -- 'p'`);
      options.tmpdir = value;
      return { next: index + 1 };
    }
    const flag = SHORT_BOOLEANS[char];

    if (!flag) return fail(`invalid option -- '${char}'`);
    options[flag] = true;
  }
  return { next: index };
}

function parseArgs(args: readonly string[]): Options | Result {
  const options: Options = { directory: false, dryRun: false, quiet: false, legacyT: false };
  let stopParsing = false;

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (!stopParsing && arg === '--') {
      stopParsing = true;
      continue;
    }
    if (!stopParsing && arg.startsWith('--')) {
      const applied = applyLongFlag(options, args, index);
      if (isResult(applied)) return applied;
      index = applied.next;
      continue;
    }
    if (!stopParsing && arg.startsWith('-') && arg !== '-') {
      const applied = applyShortCluster(options, args, index);
      if (isResult(applied)) return applied;
      index = applied.next;
      continue;
    }
    if (options.template !== undefined) return fail('too many templates');
    options.template = arg;
  }
  return options;
}

interface TemplateParts {
  stem: string;

  xCount: number;

  suffix: string;
}

function splitTemplate(
  template: string,
  explicitSuffix: string | undefined
): TemplateParts | Result {
  let stem = template;
  let suffix = explicitSuffix ?? '';

  if (explicitSuffix === undefined) {
    const lastX = template.lastIndexOf('X');
    if (lastX !== -1) {
      stem = template.slice(0, lastX + 1);
      suffix = template.slice(lastX + 1);
    }
  } else if (!template.endsWith('X')) {
    return fail(`with --suffix, template '${template}' must end in X`);
  }

  if (suffix.includes('/')) {
    return fail(`invalid suffix '${suffix}', contains directory separator`);
  }

  let xCount = 0;
  while (xCount < stem.length && stem[stem.length - 1 - xCount] === 'X') xCount++;
  if (xCount < MIN_X) return fail(`too few X's in template '${template}'`);

  return { stem, xCount, suffix };
}

function randomChars(count: number): string {
  const bytes = new Uint8Array(Math.min(count, MAX_RANDOM_BYTES));
  let result = '';
  while (result.length < count) {
    crypto.getRandomValues(bytes);
    for (const byte of bytes) {
      if (byte >= REJECT_AT) continue;
      result += ALPHABET[byte % ALPHABET.length];
      if (result.length === count) break;
    }
  }
  return result;
}

function joinPath(dir: string, name: string): string {
  return dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`;
}

function isErrno(error: unknown, code: string): boolean {
  if ((error as { code?: string } | null)?.code === code) return true;
  const message = error instanceof Error ? error.message : String(error);
  return message.startsWith(`${code}:`);
}

function isModeUnsupported(error: unknown): boolean {
  return isErrno(error, 'EOPNOTSUPP') || isErrno(error, 'ENOTSUP') || isErrno(error, 'ENOSYS');
}

async function pathIsTaken(fs: IFileSystem, path: string): Promise<boolean> {
  try {
    await fs.lstat(path);
    return true;
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return false;
    throw error;
  }
}

async function createExclusive(fs: IFileSystem, path: string, directory: boolean): Promise<void> {
  if (await pathIsTaken(fs, path)) {
    throw Object.assign(new Error(`EEXIST: file already exists, open '${path}'`), {
      code: 'EEXIST',
    });
  }
  if (directory) await fs.mkdir(path, { recursive: false });
  else await fs.writeFile(path, '');
  try {
    await fs.chmod(path, directory ? DIR_MODE : FILE_MODE);
  } catch (error) {
    if (isModeUnsupported(error)) return;

    await fs.rm(path, { recursive: directory, force: true }).catch(() => {});
    throw error;
  }
}

function resolveDestDir(
  ctx: CommandContext,
  options: Options,
  template: string
): string | null | Result {
  const envTmpdir = ctx.env.get('TMPDIR');

  if (options.legacyT) {
    if (template.includes('/')) {
      return fail(`invalid template, '${template}', contains directory separator`);
    }

    return envTmpdir?.trim() ? envTmpdir : options.tmpdir || scratchDir(ctx.env);
  }

  if (options.tmpdir !== undefined || options.template === undefined) {
    if (template.startsWith('/')) {
      return fail(`invalid template, '${template}'; with --tmpdir, it may not be absolute`);
    }
    return options.tmpdir || scratchDir(ctx.env);
  }

  return null;
}

async function parentIsDirectory(ctx: CommandContext, prefix: string): Promise<boolean> {
  const slash = prefix.lastIndexOf('/');
  const parentDir = ctx.fs.resolvePath(ctx.cwd, slash === -1 ? '.' : prefix.slice(0, slash) || '/');
  try {
    return (await ctx.fs.stat(parentDir)).isDirectory;
  } catch {
    return false;
  }
}

async function createUnique(
  ctx: CommandContext,
  options: Options,
  spec: { prefix: string; parts: TemplateParts; template: string }
): Promise<Result> {
  const { prefix, parts, template } = spec;
  const kind = options.directory ? 'directory' : 'file';
  const base = prefix.slice(0, prefix.length - parts.xCount);

  const creationFailure = (reason: string): Result => ({
    stdout: '',
    stderr: options.quiet
      ? ''
      : `mktemp: failed to create ${kind} via template '${template}': ${reason}\n`,
    exitCode: 1,
  });

  if (!options.dryRun && !(await parentIsDirectory(ctx, prefix))) {
    return creationFailure('No such file or directory');
  }

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const name = `${base}${randomChars(parts.xCount)}${parts.suffix}`;
    const fullPath = ctx.fs.resolvePath(ctx.cwd, name);
    try {
      if (options.dryRun) {
        if (await pathIsTaken(ctx.fs, fullPath)) continue;
      } else {
        await createExclusive(ctx.fs, fullPath, options.directory);
      }
    } catch (error) {
      if (isErrno(error, 'EEXIST')) continue;
      return creationFailure(error instanceof Error ? error.message : String(error));
    }
    return { stdout: `${name}\n`, stderr: '', exitCode: 0 };
  }

  return creationFailure('File exists');
}

export async function runMktemp(args: string[], ctx: CommandContext): Promise<Result> {
  const metaFlag = reachedHelpOrVersion(args);
  if (metaFlag === 'help') return { stdout: HELP, stderr: '', exitCode: 0 };
  if (metaFlag === 'version') return { stdout: MKTEMP_VERSION, stderr: '', exitCode: 0 };
  if (metaFlag?.startsWith('no-arg:')) {
    return fail(`option '--${metaFlag.slice('no-arg:'.length)}' doesn't allow an argument`);
  }

  const options = parseArgs(args);
  if (isResult(options)) return options;

  const template = options.template ?? DEFAULT_TEMPLATE;
  const parts = splitTemplate(template, options.suffix);
  if (isResult(parts)) return parts;

  const destDir = resolveDestDir(ctx, options, template);
  if (isResult(destDir)) return destDir;

  return createUnique(ctx, options, {
    prefix: destDir === null ? parts.stem : joinPath(destDir, parts.stem),
    parts,
    template,
  });
}
