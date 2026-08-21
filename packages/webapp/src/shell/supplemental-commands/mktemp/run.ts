/**
 * `mktemp` — hand back a scratch path the caller is actually allowed to write
 * (#2267).
 *
 * Loaded on FIRST USE by the registration stub in `../mktemp-command.ts`, not
 * at registration: `supplemental-commands/index.ts` sits in the kernel
 * worker's boot-critical graph (see `packages/webapp/first-load-budget.json`).
 *
 * OVERLAY, NOT A HOME. This command belongs in `just-bash` next to
 * `mkdir`/`touch`/`rm`, and it is implemented there in
 * [vercel-labs/just-bash#377](https://github.com/vercel-labs/just-bash/pull/377).
 * That PR is still open, so this file is that implementation ported onto the
 * supplemental-command surface rather than a second design: same flags, same
 * parse order, same diagnostics, same `--version` string. The port is
 * deliberate — when the builtin lands, deleting this file must not change what
 * any caller sees.
 *
 * `tests/shell/supplemental-commands/mktemp-builtin-tripwire.test.ts` fails the
 * moment a `just-bash` bump ships the builtin, and carries the removal steps.
 *
 * Two things here are ours rather than upstream's, and both are load-bearing:
 *
 * 1. The default directory comes from {@link scratchDir}, so it follows this
 *    runtime's per-unit `$TMPDIR` pin (`/tmp/<cone>` for a cone,
 *    `/tmp/<cone>/<scoop>` for a scoop) instead of a bare `/tmp`. Upstream
 *    reads `$TMPDIR` too and falls back to `/tmp`; `scratchDir` is that rule
 *    with this repo's blank-value handling, so the two agree.
 * 2. Creation is best-effort rather than atomic — see {@link createExclusive}.
 *    This is the one behavioural gap, and it closes when the builtin arrives.
 */

import type { CommandContext, IFileSystem } from 'just-bash';
import { scratchDir } from '../../tmpdir-env.js';

/**
 * Verbatim from upstream. just-bash emulates the GNU coreutils surface, so the
 * number names the coreutils release whose behaviour is followed — not the
 * package version. Matching it exactly is the point: a script that reads this
 * string keeps working across the swap.
 */
const MKTEMP_VERSION = 'mktemp (just-bash) 9.4\n';

/** GNU default template when none is given. */
const DEFAULT_TEMPLATE = 'tmp.XXXXXXXXXX';

/** GNU requires at least this many trailing X characters. */
const MIN_X = 3;

/**
 * Bounded retries so a crowded directory cannot spin forever. A collision-retry
 * invariant of name generation (GNU caps attempts the same way), not a resource
 * ceiling a caller should tune: each attempt is one existence check, and with a
 * 62^3 floor on the name space collisions are vanishing.
 */
const MAX_ATTEMPTS = 100;

/** Characters GNU mktemp draws the random part from. */
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** Largest multiple of ALPHABET.length that fits in a byte (rejection sampling). */
const REJECT_AT = 256 - (256 % ALPHABET.length);

/** Web Crypto refuses `getRandomValues` buffers larger than this. */
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

Files are created with mode 0600 and directories with mode 0700.

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
  /** `-p DIR` / `--tmpdir[=DIR]`; `''` means "use the default temp dir". */
  tmpdir?: string;
  suffix?: string;
  template?: string;
}

/** Boolean short options and the `Options` field each one sets. */
const SHORT_BOOLEANS: Readonly<Record<string, 'directory' | 'dryRun' | 'quiet' | 'legacyT'>> = {
  d: 'directory',
  u: 'dryRun',
  q: 'quiet',
  t: 'legacyT',
};

/** Every short option, including `-p` (takes a value) and `-h`. */
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

function fail(message: string): Result {
  return { stdout: '', stderr: `mktemp: ${message}\n`, exitCode: 1 };
}

function isResult(value: unknown): value is Result {
  return typeof value === 'object' && value !== null && 'exitCode' in value;
}

/**
 * Walk argv the way the parser will, reporting for each token whether it sits
 * in an option position — before any `--` terminator, and not being consumed as
 * the value of the preceding option.
 *
 * Both callers below need this. Scanning argv naively would misread
 * `mktemp -p --help` (where `--help` is the directory) and `mktemp -- --help`
 * (where it is the template) as requests for help.
 */
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
    // An operand, not an option. Without this a template is scanned as a short
    // cluster, so `mktemp chartXXXX` reads its "h" as -h. Scanning continues
    // past operands because GNU permutes: `mktemp fooXXXX --help` still reaches
    // the option.
    if (!arg.startsWith('-') || arg === '-') {
      visit(arg, false);
      continue;
    }
    // Long or short options whose value arrives as the next argument.
    if (arg === '--suffix' || arg === '--tmpdir' || /^-[a-z]*p$/.test(arg)) {
      expectValue = arg !== '--tmpdir';
    }
    visit(arg, true);
  }
}

type MetaFlag = 'help' | 'version' | `no-arg:${string}`;

/** Scan a long option for `--help` / `--version`; `'stop'` ends the scan. */
function metaFromLong(arg: string): MetaFlag | 'stop' | null {
  const eq = arg.indexOf('=');
  const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
  if (name === 'help' || name === 'version') {
    // GNU rejects an attached value on options that take none.
    return eq === -1 ? name : `no-arg:${name}`;
  }
  return LONG_FLAGS.has(name) ? null : 'stop';
}

/** Scan a short cluster for `-h`; `'stop'` ends the scan at the first unknown. */
function metaFromShortCluster(arg: string): MetaFlag | 'stop' | null {
  for (const char of arg.slice(1)) {
    if (char === 'h') return 'help';
    if (!SHORT_FLAGS.has(char)) return 'stop';
    // A value-taking short option swallows the rest of the token as its value,
    // so `-ph` is -p with the directory "h", not -p followed by -h.
    if (char === 'p') return null;
  }
  return null;
}

/**
 * Find a *reached* `--help`/`-h` or `--version`, scanning in the order the
 * parser will.
 *
 * GNU short-circuits when it reaches one of these, so anything invalid before
 * it still wins: `mktemp --bad --help` reports the bad option, while
 * `mktemp --help --bad` prints help. The scan stops at the first unrecognized
 * option and lets the parser produce that diagnostic, keeping one source of
 * truth for what is valid.
 */
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

/** Read `--long` / `--long=value` into `options`; a Result is a hard error. */
function applyLongFlag(
  options: Options,
  args: readonly string[],
  index: number
): { next: number } | Result {
  const arg = args[index];
  const eq = arg.indexOf('=');
  const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
  const attached = eq === -1 ? undefined : arg.slice(eq + 1);

  if (name === 'directory') options.directory = true;
  else if (name === 'dry-run') options.dryRun = true;
  else if (name === 'quiet') options.quiet = true;
  // `--tmpdir`'s argument is optional; a bare one means "the default dir" and
  // must not swallow the following template.
  else if (name === 'tmpdir') options.tmpdir = attached ?? '';
  else if (name === 'suffix') {
    // `--suffix`'s argument, unlike `--tmpdir`'s, is mandatory.
    const value = attached ?? args[index + 1];
    if (value === undefined) return fail(`option '--suffix' requires an argument`);
    options.suffix = value;
    return { next: attached === undefined ? index + 1 : index };
  } else return fail(`unrecognized option '${arg}'`);

  return { next: index };
}

/** Read a short cluster (`-d`, `-dp DIR`, `-pDIR`); a Result is a hard error. */
function applyShortCluster(
  options: Options,
  args: readonly string[],
  index: number
): { next: number } | Result {
  const arg = args[index];
  for (let pos = 1; pos < arg.length; pos++) {
    const char = arg[pos];
    if (char === 'p') {
      // The rest of the token is the value when there is one, otherwise the
      // next argument: `-pDIR`, `-p DIR` and `-dp DIR` all work.
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
    // `-h` never reaches here: `reachedHelpOrVersion` short-circuits on it.
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
  /** Template up to and including the final run of X characters. */
  stem: string;
  /** Number of trailing X characters in `stem`. */
  xCount: number;
  /** Text appended after the random characters. */
  suffix: string;
}

/**
 * Split a template into stem, X-run and suffix. Without `--suffix`, GNU takes
 * everything after the LAST X as the suffix, so `fooXXXXbar` is a valid
 * template with a `bar` suffix rather than one with too few X's.
 */
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
  // A template's run of X can be arbitrarily long, so draw in bounded chunks
  // rather than asking for `count` bytes in one call.
  const bytes = new Uint8Array(Math.min(count, MAX_RANDOM_BYTES));
  let result = '';
  while (result.length < count) {
    crypto.getRandomValues(bytes);
    for (const byte of bytes) {
      if (byte >= REJECT_AT) continue; // avoid modulo bias
      result += ALPHABET[byte % ALPHABET.length];
      if (result.length === count) break;
    }
  }
  return result;
}

function joinPath(dir: string, name: string): string {
  return dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`;
}

/**
 * True when `error` reports the given errno.
 *
 * Backends throw either a Node `ErrnoException` carrying `code` or an Error
 * whose message starts with `"<CODE>: "`. The path is interpolated after that
 * prefix, so anchoring at the start keeps a crafted template from
 * impersonating an errno.
 */
function isErrno(error: unknown, code: string): boolean {
  if ((error as { code?: string } | null)?.code === code) return true;
  const message = error instanceof Error ? error.message : String(error);
  return message.startsWith(`${code}:`);
}

/**
 * True when anything already occupies `path`. Uses `lstat` rather than
 * `exists()` so a symlink — including a dangling one, which `exists()` reports
 * as absent — counts as taken instead of being followed to its target.
 */
async function pathIsTaken(fs: IFileSystem, path: string): Promise<boolean> {
  try {
    await fs.lstat(path);
    return true;
  } catch (error) {
    // Only "it is not there" means the name is free. An EACCES or ELOOP says
    // the name could not be inspected, and reporting an unverified path as
    // available is the failure this command exists to avoid.
    if (isErrno(error, 'ENOENT')) return false;
    throw error;
  }
}

/**
 * Create `path`, refusing to reuse an occupied name, with the mode applied as
 * soon as the backend allows.
 *
 * Upstream does this in a single `IFileSystem.createExclusive` call, added by
 * the same PR this file is ported from. That method does not exist in the
 * pinned `just-bash`, so the sequence here is probe-then-create, and it is
 * genuinely weaker: between the `lstat` and the write another writer can take
 * the name and have its entry truncated, and the entry is briefly readable at
 * the backend's default mode. The window is narrow in this runtime — one kernel
 * worker, no other OS processes sharing the VFS — but it is real, and it is the
 * strongest reason to delete this overlay the moment the builtin ships.
 *
 * @throws an EEXIST-coded error when the name is taken, so the caller retries.
 */
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
    // An entry left behind at a loose mode is worse than no entry: the caller
    // would treat the returned path as private. Take it back, then report.
    await fs.rm(path, { recursive: directory, force: true }).catch(() => {});
    throw error;
  }
}

/**
 * The directory the entry is created in, or `null` when the template stays
 * relative to the cwd (GNU's behaviour for a bare TEMPLATE without -p/-t).
 */
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
    // GNU prefers a non-empty $TMPDIR over -p for the deprecated -t form,
    // unlike every other branch, where -p wins.
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

/**
 * Reject a missing destination directory up front. Some backends create missing
 * parents on write; GNU mktemp does not. `--dry-run` never touches the
 * filesystem, so GNU still prints a candidate for a missing directory and this
 * check must not run for it.
 */
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
      // -u reports a name without creating anything, probing with lstat like
      // gnulib's GT_NOCREATE path: a symlink occupying the name counts as
      // taken, where a following stat would see through it.
      if (options.dryRun) {
        if (await pathIsTaken(ctx.fs, fullPath)) continue;
      } else {
        await createExclusive(ctx.fs, fullPath, options.directory);
      }
    } catch (error) {
      // Match the errno, not the message body: diagnostics embed the
      // caller-supplied path, so a template containing "EEXIST" would make
      // unrelated failures look like collisions and be retried silently.
      if (isErrno(error, 'EEXIST')) continue;
      return creationFailure(error instanceof Error ? error.message : String(error));
    }
    return { stdout: `${name}\n`, stderr: '', exitCode: 0 };
  }

  return creationFailure('File exists');
}

export async function runMktemp(args: string[], ctx: CommandContext): Promise<Result> {
  // Only when actually reached as an option: `mktemp -- --help` treats it as
  // a template, `mktemp -p --help` as the directory, and
  // `mktemp --bad --help` reports the invalid option first.
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
