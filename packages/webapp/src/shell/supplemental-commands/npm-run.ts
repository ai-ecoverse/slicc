/**
 * `npm run` (a.k.a. `ipk run` / `npm run-script`) — run a `scripts` entry from
 * the nearest `package.json` through the jsh shell.
 *
 * Semantics kept faithful to npm where it is observable:
 *   - the manifest is the NEAREST `package.json` walking up from the cwd, and
 *     scripts run with that package's directory as cwd (not the caller's cwd);
 *   - `pre<script>` and `post<script>` run around the script, and a failing
 *     `pre` aborts before the main body;
 *   - args after the script name (and after an optional `--`) are appended to
 *     the main script body, shell-quoted;
 *   - `npm_lifecycle_event` / `npm_lifecycle_script` / `npm_package_name` /
 *     `npm_package_version` are exported, and every reachable
 *     `node_modules/.bin` is prepended to `$PATH`;
 *   - `npm run` with no script name lists what is available.
 *
 * Bare bin words in a script body (`vitest run`, `tsc -p .`) are not resolvable
 * by the shell — `$PATH` lookup covers `.jsh`/`.bsh` scripts, not the
 * `node_modules/.bin` JS shims `ipk` writes. A command-position word that names
 * no registered command but does have a `.bin` shim is therefore rewritten to
 * `ipx <word>`, which is the runner that can execute those shims. Nothing else
 * is rewritten: an unknown word stays unknown (no implicit install), so a typo
 * still fails as a typo.
 */

import type { CommandContext, ExecResult } from 'just-bash';
import type { VirtualFS } from '../../fs/index.js';
import { joinPath, normalizePath, splitPath } from '../../fs/path-utils.js';
import { stdinAsLatin1 } from '../just-bash-compat.js';

/** Subcommands that mean "run a script from package.json". */
export const RUN_ALIASES: ReadonlySet<string> = new Set(['run', 'run-script']);

/** npm lifecycle shortcuts: `npm test` is `npm run test`. */
export const LIFECYCLE_SHORTCUTS: ReadonlySet<string> = new Set([
  'test',
  'start',
  'stop',
  'restart',
]);

export interface NpmRunDeps {
  fs: VirtualFS;
}

interface ScriptHost {
  /** Directory holding the package.json (also the cwd scripts run in). */
  dir: string;
  name?: string;
  version?: string;
  scripts: Record<string, string>;
}

interface RunFlags {
  silent: boolean;
  ifPresent: boolean;
}

const WORD_BREAK = new Set([' ', '\t', '\n', ';', '|', '&', '(', ')', '{', '}', '<', '>']);
/** Chars that put the parser back at a command position. */
const COMMAND_RESET = new Set([';', '|', '&', '(', ')', '{', '\n']);
const ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;
const PLAIN_WORD_RE = /^[@A-Za-z0-9._-]+$/;
const SHELL_KEYWORDS = new Set([
  'if',
  'then',
  'else',
  'elif',
  'fi',
  'for',
  'while',
  'until',
  'do',
  'done',
  'case',
  'esac',
  'function',
  'time',
  '!',
]);
/** Runners that already know how to execute a `.bin` shim. */
const BIN_RUNNERS = new Set(['ipx', 'npx']);

function quoteArg(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

async function readText(fs: VirtualFS, path: string): Promise<string> {
  const content = await fs.readFile(path);
  return typeof content === 'string' ? content : new TextDecoder().decode(content);
}

/** Yield each `<dir>` from `cwd` up to the filesystem root. */
function* ancestorDirs(cwd: string): Generator<string> {
  let dir = normalizePath(cwd);
  while (true) {
    yield dir;
    if (dir === '/') break;
    dir = splitPath(dir).dir;
  }
}

/** The three `package.json` fields `run` reads, before validation. */
interface RawManifest {
  name?: unknown;
  version?: unknown;
  scripts?: unknown;
}

function toScripts(raw: unknown): Record<string, string> {
  if (raw === null || typeof raw !== 'object') return {};
  const scripts: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string') scripts[key] = value;
  }
  return scripts;
}

function toOptionalString(raw: unknown): string | undefined {
  return typeof raw === 'string' ? raw : undefined;
}

/**
 * Nearest `package.json` walking up from `cwd`. Returns `null` when none
 * exists; throws when the nearest one is not parseable JSON (a silent walk
 * past a broken manifest would run the wrong package's script).
 */
async function findScriptHost(fs: VirtualFS, cwd: string): Promise<ScriptHost | null> {
  for (const dir of ancestorDirs(cwd)) {
    const manifestPath = joinPath(dir, 'package.json');
    if (!(await fs.exists(manifestPath))) continue;
    let manifest: RawManifest;
    try {
      manifest = JSON.parse(await readText(fs, manifestPath)) as RawManifest;
    } catch (err) {
      throw new Error(
        `${manifestPath} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    return {
      dir,
      name: toOptionalString(manifest.name),
      version: toOptionalString(manifest.version),
      scripts: toScripts(manifest.scripts),
    };
  }
  return null;
}

interface ScannedWord {
  start: number;
  end: number;
  text: string;
}

/** Read one word starting at `start`, honoring quotes and backslash escapes. */
function readWord(script: string, start: number): ScannedWord {
  let i = start;
  let quote = '';
  while (i < script.length) {
    const ch = script[i];
    if (quote !== '') {
      if (ch === '\\' && quote === '"') i++;
      else if (ch === quote) quote = '';
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      i++;
      continue;
    }
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (WORD_BREAK.has(ch)) break;
    i++;
  }
  return { start, end: i, text: script.slice(start, i) };
}

/** Words sitting in command position (start of the script or after `; | && (`). */
function scanCommandWords(script: string): ScannedWord[] {
  const found: ScannedWord[] = [];
  let i = 0;
  let atCommand = true;
  while (i < script.length) {
    const ch = script[i];
    if (ch === ' ' || ch === '\t') {
      i++;
      continue;
    }
    if (COMMAND_RESET.has(ch)) {
      atCommand = true;
      i++;
      continue;
    }
    const word = readWord(script, i);
    if (word.end === word.start) {
      i++;
      continue;
    }
    // `FOO=bar cmd` — assignments precede the command word.
    if (atCommand && !ASSIGNMENT_RE.test(word.text)) {
      found.push(word);
      atCommand = false;
    }
    i = word.end;
  }
  return found;
}

export interface BinRewriteHooks {
  /** Whether a `node_modules/.bin/<word>` shim is reachable from the package dir. */
  hasLocalBin: (word: string) => Promise<boolean>;
  /** Whether the shell already has a command registered under that name. */
  isRegistered: (word: string) => boolean;
}

function isRewriteCandidate(text: string, hooks: BinRewriteHooks): boolean {
  if (!PLAIN_WORD_RE.test(text)) return false;
  if (SHELL_KEYWORDS.has(text) || BIN_RUNNERS.has(text)) return false;
  return !hooks.isRegistered(text);
}

/**
 * Prefix `ipx` onto command-position words that only exist as a
 * `node_modules/.bin` shim, so `"build": "tsup src"` runs the installed bin.
 */
export async function rewriteLocalBins(script: string, hooks: BinRewriteHooks): Promise<string> {
  const candidates = scanCommandWords(script).filter((w) => isRewriteCandidate(w.text, hooks));
  if (candidates.length === 0) return script;

  const rewritable: ScannedWord[] = [];
  for (const word of candidates) {
    if (await hooks.hasLocalBin(word.text)) rewritable.push(word);
  }
  if (rewritable.length === 0) return script;

  let out = script;
  for (const word of [...rewritable].reverse()) {
    out = `${out.slice(0, word.start)}ipx ${out.slice(word.start)}`;
  }
  return out;
}

function binDirsFor(dir: string): string[] {
  const dirs: string[] = [];
  for (const ancestor of ancestorDirs(dir)) {
    dirs.push(joinPath(ancestor, 'node_modules', '.bin'));
  }
  return dirs;
}

function buildRunEnv(
  host: ScriptHost,
  event: string,
  body: string,
  ctx: CommandContext
): Record<string, string> {
  const parentPath = ctx.env.get('PATH') ?? '';
  const path = [...binDirsFor(host.dir), parentPath].filter((p) => p !== '').join(':');
  const env: Record<string, string> = {
    PATH: path,
    npm_lifecycle_event: event,
    npm_lifecycle_script: body,
  };
  if (host.name !== undefined) env.npm_package_name = host.name;
  if (host.version !== undefined) env.npm_package_version = host.version;
  return env;
}

function packageLabel(host: ScriptHost): string {
  if (host.name === undefined) return host.dir;
  return host.version === undefined ? host.name : `${host.name}@${host.version}`;
}

function formatScriptList(name: string, host: ScriptHost): string {
  const entries = Object.entries(host.scripts);
  if (entries.length === 0) {
    return `${name}: no scripts defined in ${joinPath(host.dir, 'package.json')}\n`;
  }
  const lines = [`Scripts available in ${packageLabel(host)} via \`${name} run\`:`];
  for (const [script, body] of entries) {
    lines.push(`  ${script}`);
    lines.push(`    ${body}`);
  }
  return `${lines.join('\n')}\n`;
}

function parseRunFlags(args: string[]): { flags: RunFlags; rest: string[] } {
  const flags: RunFlags = { silent: false, ifPresent: false };
  let i = 0;
  for (; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--silent' || arg === '-s') flags.silent = true;
    else if (arg === '--if-present') flags.ifPresent = true;
    else break;
  }
  return { flags, rest: args.slice(i) };
}

/** Extra argv for the script body: everything after the name, minus one `--`. */
function extraArgsOf(rest: string[]): string[] {
  const extra = rest.slice(1);
  return extra[0] === '--' ? extra.slice(1) : extra;
}

function failure(name: string, message: string): ExecResult {
  return { stdout: '', stderr: `${name}: ${message}\n`, exitCode: 1 };
}

interface Stage {
  event: string;
  body: string;
}

/** `pre<script>`, `<script>` (with extra args), `post<script>`. */
function buildStages(host: ScriptHost, script: string, extraArgs: string[]): Stage[] {
  const suffix = extraArgs.length > 0 ? ` ${extraArgs.map(quoteArg).join(' ')}` : '';
  const stages: Stage[] = [];
  const pre = host.scripts[`pre${script}`];
  if (pre !== undefined) stages.push({ event: `pre${script}`, body: pre });
  stages.push({ event: script, body: `${host.scripts[script]}${suffix}` });
  const post = host.scripts[`post${script}`];
  if (post !== undefined) stages.push({ event: `post${script}`, body: post });
  return stages;
}

function makeHooks(fs: VirtualFS, host: ScriptHost, ctx: CommandContext): BinRewriteHooks {
  const registered = new Set(ctx.getRegisteredCommands?.() ?? []);
  return {
    isRegistered: (word) => registered.has(word),
    hasLocalBin: async (word) => {
      for (const binDir of binDirsFor(host.dir)) {
        if (await fs.exists(joinPath(binDir, word))) return true;
      }
      return false;
    },
  };
}

async function runStages(
  name: string,
  host: ScriptHost,
  stages: Stage[],
  flags: RunFlags,
  ctx: CommandContext,
  deps: NpmRunDeps
): Promise<ExecResult> {
  const exec = ctx.exec;
  if (!exec) {
    return failure(name, 'run requires shell exec support, which this context does not provide');
  }
  const hooks = makeHooks(deps.fs, host, ctx);
  const label = packageLabel(host);
  let stdout = '';
  let stderr = '';

  for (const stage of stages) {
    if (!flags.silent) {
      stdout += `\n> ${label} ${stage.event}\n> ${stage.body}\n\n`;
    }
    const command = await rewriteLocalBins(stage.body, hooks);
    const result = await exec(command, {
      cwd: host.dir,
      env: buildRunEnv(host, stage.event, stage.body, ctx),
      stdin: stdinAsLatin1(ctx.stdin),
      stdinKind: 'bytes',
    });
    stdout += result.stdout;
    stderr += result.stderr;
    if (result.exitCode !== 0) {
      stderr += `${name}: script '${stage.event}' exited with code ${result.exitCode}\n`;
      return { stdout, stderr, exitCode: result.exitCode };
    }
  }
  return { stdout, stderr, exitCode: 0 };
}

/**
 * Entry point for `npm run [flags] [<script> [-- args...]]`. `args` excludes the
 * `run` token itself; lifecycle shortcuts pass `['test']` and friends.
 */
export async function runNpmScript(
  name: string,
  args: string[],
  ctx: CommandContext,
  deps: NpmRunDeps
): Promise<ExecResult> {
  let host: ScriptHost | null;
  try {
    host = await findScriptHost(deps.fs, ctx.cwd);
  } catch (err) {
    return failure(name, err instanceof Error ? err.message : String(err));
  }
  if (!host) {
    return failure(
      name,
      `no package.json found in ${ctx.cwd} or any parent directory — nothing to run`
    );
  }

  const { flags, rest } = parseRunFlags(args);
  if (rest.length === 0) {
    return { stdout: formatScriptList(name, host), stderr: '', exitCode: 0 };
  }

  const script = rest[0];
  if (host.scripts[script] === undefined) {
    if (flags.ifPresent) return { stdout: '', stderr: '', exitCode: 0 };
    const available = Object.keys(host.scripts);
    const hint =
      available.length > 0
        ? ` (available: ${available.join(', ')})`
        : ` (${joinPath(host.dir, 'package.json')} defines no scripts)`;
    return failure(name, `missing script: ${script}${hint}`);
  }

  return runStages(name, host, buildStages(host, script, extraArgsOf(rest)), flags, ctx, deps);
}
