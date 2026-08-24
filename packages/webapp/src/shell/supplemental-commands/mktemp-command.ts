/**
 * `mktemp` — hand back a scratch path the caller is actually allowed to write
 * (#2267).
 *
 * INTERIM SHIM. The generic POSIX half of this command belongs in `just-bash`
 * next to `mkdir`/`touch`/`rm`, and a matching upstream implementation has
 * been prepared (see the PR for #2267). Delete this file and its test once a
 * `just-bash` bump carries `mktemp`; the part that is genuinely SLICC's is
 * the `$TMPDIR` pinning in `buildScoopShellEnv` / the headless shell's
 * initial env, which stays either way.
 *
 * The interesting part is not the template expansion, it is which directory
 * the default lands in. A hardcoded `/tmp` is wrong here: the cone can write
 * `/tmp`, but a scoop's RestrictedFS normally cannot, so returning
 * `/tmp/tmp.abc123` to a scoop just moves the EACCES one step later, into
 * whatever writes to the returned path. Resolution order is therefore:
 *
 * 1. `$TMPDIR` when set and non-empty — pinned per shell
 *    (`buildScoopShellEnv` for scoops, the headless shell's initial env for
 *    the cone), so `echo $TMPDIR` is the discoverable answer.
 * 2. Otherwise the caller's own temp root, derived from the pinned `$HOME`:
 *    a scoop home of `/scoops/<folder>/home` implies `/scoops/<folder>/tmp`,
 *    which `ensureDirectoryStructure` already creates and which sits inside
 *    the default scoop `writablePaths` of `/scoops/<folder>/`.
 * 3. `/tmp` for everyone else (the cone).
 */

import type { Command, CommandContext } from 'just-bash';
import { defineCommand } from 'just-bash';

const HELP = `Usage: mktemp [OPTION]... [TEMPLATE]
Create a temporary file or directory and print its name.

TEMPLATE must end in at least three consecutive 'X's, which are replaced with
random characters; the default template is tmp.XXXXXXXXXX. A TEMPLATE is
created relative to the current directory unless -p/--tmpdir is given.

  -d, --directory      create a directory, not a file
  -u, --dry-run        print a name, but create nothing
  -q, --quiet          suppress diagnostics about creation failure
  -p DIR, --tmpdir[=DIR]
                       place the entry under DIR; without a value the default
                       temp directory is used
  -h, --help           display this help and exit

The default temp directory is $TMPDIR when set, otherwise the caller's own
temp root: /scoops/<folder>/tmp inside a scoop, /tmp for the cone.

Unrecognized options are an error rather than being ignored, so a script never
receives a path whose requested shape was silently dropped.
`;

/** GNU's default template. */
const DEFAULT_TEMPLATE = 'tmp.XXXXXXXXXX';
/** GNU's alphabet for the replaced X's. */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
/** Distinct candidates tried before giving up on a collision. */
const MAX_ATTEMPTS = 32;

type Result = { stdout: string; stderr: string; exitCode: number };

interface Options {
  directory: boolean;
  dryRun: boolean;
  quiet: boolean;
  /** Explicit -p / --tmpdir value; `''` means "use the default temp dir". */
  tmpdir?: string;
  template?: string;
}

const BOOLEAN_FLAGS: Readonly<Record<string, 'directory' | 'dryRun' | 'quiet'>> = {
  '-d': 'directory',
  '--directory': 'directory',
  '-u': 'dryRun',
  '--dry-run': 'dryRun',
  '-q': 'quiet',
  '--quiet': 'quiet',
};

function usageError(message: string): Result {
  return {
    stdout: '',
    stderr: `mktemp: ${message}\nTry 'mktemp --help' for more information.\n`,
    exitCode: 1,
  };
}

/** Recognize the -p / --tmpdir family; `null` when `args[index]` is not one. */
function readTmpdirOption(
  args: readonly string[],
  index: number
): { value: string; next: number } | Result | null {
  const arg = args[index];
  if (arg === '--tmpdir') return { value: '', next: index };
  if (arg.startsWith('--tmpdir=')) return { value: arg.slice('--tmpdir='.length), next: index };
  if (arg === '-p') {
    const value = args[index + 1];
    if (value === undefined) return usageError("option requires an argument -- 'p'");
    return { value, next: index + 1 };
  }
  if (arg.startsWith('-p') && arg.length > 2) return { value: arg.slice(2), next: index };
  return null;
}

/**
 * Take `arg` as the (single) TEMPLATE operand. Anything unrecognized is a hard
 * error (#2255): a `mktemp` that ignored `--suffix` and printed a path anyway
 * would be a fresh source of silent breakage.
 */
function takeTemplate(options: Options, arg: string): Result | null {
  if (arg.startsWith('-') && arg !== '-') return usageError(`unrecognized option '${arg}'`);
  if (options.template !== undefined) return usageError('too many templates');
  options.template = arg;
  return null;
}

function parseArgs(args: readonly string[]): Options | Result {
  const options: Options = { directory: false, dryRun: false, quiet: false };
  for (let index = 0; index < args.length; index++) {
    const flag = BOOLEAN_FLAGS[args[index]];
    if (flag) {
      options[flag] = true;
      continue;
    }
    const tmpdir = readTmpdirOption(args, index);
    if (tmpdir && 'exitCode' in tmpdir) return tmpdir;
    if (tmpdir) {
      options.tmpdir = tmpdir.value;
      index = tmpdir.next;
      continue;
    }
    const error = takeTemplate(options, args[index]);
    if (error) return error;
  }
  return options;
}

function stripTrailingSlashes(path: string): string {
  const stripped = path.replace(/\/+$/, '');
  return stripped === '' ? '/' : stripped;
}

/**
 * The caller's own temp root. See the file header for why this is not just
 * `/tmp`. `$HOME` is the pinned per-scoop home rather than a guess at the
 * caller's identity — `buildScoopShellEnv` sets it for every non-cone shell.
 */
export function resolveDefaultTmpDir(env: Map<string, string>): string {
  const fromEnv = env.get('TMPDIR')?.trim();
  if (fromEnv) return stripTrailingSlashes(fromEnv);
  const scoopHome = /^\/scoops\/([^/]+)\/home\/*$/.exec(env.get('HOME') ?? '');
  return scoopHome ? `/scoops/${scoopHome[1]}/tmp` : '/tmp';
}

function randomSuffix(length: number): string {
  const bytes = new Uint8Array(length);
  const webCrypto = globalThis.crypto;
  if (webCrypto?.getRandomValues) webCrypto.getRandomValues(bytes);
  else for (let index = 0; index < length; index++) bytes[index] = Math.floor(Math.random() * 256);
  // 62 does not divide 256, so the modulo is very slightly biased. That is
  // fine for a scratch name — collisions are retried, not fatal.
  let out = '';
  for (const byte of bytes) out += ALPHABET[byte % ALPHABET.length];
  return out;
}

/** Split a template into its directory part and its name part. */
function splitTemplate(template: string): { dir: string | null; name: string } {
  const slash = template.lastIndexOf('/');
  if (slash === -1) return { dir: null, name: template };
  return { dir: template.slice(0, slash) || '/', name: template.slice(slash + 1) };
}

/** The run of trailing X's in the name part, or null when there are < 3. */
function trailingXs(name: string): number | null {
  const match = /X+$/.exec(name);
  return match && match[0].length >= 3 ? match[0].length : null;
}

/**
 * Resolve the directory the entry goes in. `-p DIR` wins; otherwise a template
 * is relative to the cwd (GNU behavior) and only the implicit default template
 * lands in the default temp dir.
 */
function resolveTargetDir(
  ctx: CommandContext,
  options: Options,
  templateDir: string | null
): string {
  if (options.tmpdir !== undefined) {
    const base = options.tmpdir.trim() === '' ? resolveDefaultTmpDir(ctx.env) : options.tmpdir;
    const joined = templateDir ? `${stripTrailingSlashes(base)}/${templateDir}` : base;
    return ctx.fs.resolvePath(ctx.cwd, joined);
  }
  if (templateDir) return ctx.fs.resolvePath(ctx.cwd, templateDir);
  return options.template === undefined ? resolveDefaultTmpDir(ctx.env) : ctx.cwd;
}

/** Create the entry, or report `false` when the name is already taken. */
async function createEntry(
  ctx: CommandContext,
  path: string,
  directory: boolean
): Promise<boolean> {
  if (await ctx.fs.exists(path)) return false;
  if (directory) await ctx.fs.mkdir(path, { recursive: false });
  else await ctx.fs.writeFile(path, '');
  return true;
}

async function createUnique(
  ctx: CommandContext,
  options: Options,
  spec: { base: string; name: string; xs: number; template: string }
): Promise<Result> {
  const { base, name, xs, template } = spec;
  let lastError = '';
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const candidate = `${base}/${name.slice(0, name.length - xs)}${randomSuffix(xs)}`;
    if (options.dryRun) return { stdout: `${candidate}\n`, stderr: '', exitCode: 0 };
    try {
      if (await createEntry(ctx, candidate, options.directory)) {
        return { stdout: `${candidate}\n`, stderr: '', exitCode: 0 };
      }
      lastError = 'File exists';
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      break;
    }
  }
  const what = options.directory ? 'directory' : 'file';
  const stderr = `mktemp: failed to create ${what} via template '${template}': ${lastError}\n`;
  return { stdout: '', stderr: options.quiet ? '' : stderr, exitCode: 1 };
}

export function createMktempCommand(): Command {
  return defineCommand('mktemp', async (args, ctx) => {
    if (args.includes('-h') || args.includes('--help')) {
      return { stdout: HELP, stderr: '', exitCode: 0 };
    }
    const parsed = parseArgs(args);
    if ('exitCode' in parsed) return parsed;

    const template = parsed.template ?? DEFAULT_TEMPLATE;
    const { dir, name } = splitTemplate(template);
    const xs = trailingXs(name);
    if (xs === null) return usageError(`too few X's in template '${template}'`);

    const targetDir = stripTrailingSlashes(resolveTargetDir(ctx, parsed, dir));
    return createUnique(ctx, parsed, {
      base: targetDir === '/' ? '' : targetDir,
      name,
      xs,
      template,
    });
  });
}
