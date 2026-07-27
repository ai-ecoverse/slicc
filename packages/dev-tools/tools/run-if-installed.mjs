#!/usr/bin/env node
/**
 * Run a command only when its binary is installed, otherwise warn and succeed.
 *
 * Used by the root `lint-staged` config for the non-npm toolchains (SwiftLint,
 * gofmt). Those binaries are installed in CI but not by `npm ci`, so invoking
 * them directly would break `git commit` for a contributor who has never
 * touched Swift or Go. `lint-staged` already scopes a command to its matching
 * glob, so this wrapper only ever fires for someone who staged a `.swift` or
 * `.go` file — it turns a hard failure into an actionable warning.
 *
 * Usage: run-if-installed.mjs <binary> [args...]
 *
 * `lint-staged` appends the staged file paths after `args`.
 */
import { spawnSync } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { argv, env, exit, platform, stderr } from 'node:process';
import { pathToFileURL } from 'node:url';

const WINDOWS_DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests)
// ---------------------------------------------------------------------------

/**
 * Return true when `absPath` is an existing file with the execute bit set.
 * @param {string} absPath
 * @returns {boolean}
 */
export function isExecutableFile(absPath) {
  try {
    if (!statSync(absPath).isFile()) return false;
    accessSync(absPath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read an env var case-insensitively; Windows env var names are not case-sensitive.
 * @param {Record<string, string | undefined>} source
 * @param {string} name
 * @returns {string | undefined}
 */
function readEnv(source, name) {
  const entry = Object.entries(source).find(([key]) => key.toUpperCase() === name);
  return entry?.[1];
}

/**
 * The suffixes to append to an extensionless name, most-specific first.
 *
 * On Windows an installed toolchain is `gofmt.exe`, never bare `gofmt`, so a
 * bare-name-only lookup would report every Windows toolchain as missing.
 *
 * @param {{ platform?: string, env?: Record<string, string | undefined> }} [context]
 * @returns {string[]} Always starts with `''` (the name as given).
 */
export function executableSuffixes(context = {}) {
  const { platform: hostPlatform = platform, env: hostEnv = env } = context;
  if (hostPlatform !== 'win32') return [''];
  const raw = readEnv(hostEnv, 'PATHEXT') || WINDOWS_DEFAULT_PATHEXT;
  const suffixes = raw
    .split(';')
    .map((ext) => ext.trim())
    .filter(Boolean)
    .map((ext) => (ext.startsWith('.') ? ext : `.${ext}`));
  return ['', ...(suffixes.length > 0 ? suffixes : WINDOWS_DEFAULT_PATHEXT.split(';'))];
}

/**
 * Return true when `binary` should be checked directly instead of via PATH,
 * matching how a shell resolves `./foo` versus `foo`.
 *
 * @param {string} binary
 * @param {string} hostPlatform
 * @returns {boolean}
 */
export function isExplicitPath(binary, hostPlatform) {
  return binary.includes('/') || (hostPlatform === 'win32' && binary.includes('\\'));
}

/**
 * Resolve `binary` against a PATH-shaped string.
 *
 * @param {string} binary
 * @param {{
 *   path?: string,
 *   platform?: string,
 *   env?: Record<string, string | undefined>,
 * }} [context]
 * @returns {string | null} Absolute-or-given path, or null when not found.
 */
export function findOnPath(binary, context = {}) {
  if (!binary) return null;
  const { platform: hostPlatform = platform, env: hostEnv = env } = context;
  const pathEnv = context.path ?? readEnv(hostEnv, 'PATH') ?? '';
  const suffixes = extname(binary)
    ? ['']
    : executableSuffixes({ platform: hostPlatform, env: hostEnv });

  if (isExplicitPath(binary, hostPlatform)) {
    for (const suffix of suffixes) {
      if (isExecutableFile(binary + suffix)) return binary + suffix;
    }
    return null;
  }

  const pathDelimiter = hostPlatform === 'win32' ? ';' : ':';
  for (const dir of pathEnv.split(pathDelimiter)) {
    if (!dir) continue;
    for (const suffix of suffixes) {
      const candidate = join(dir, binary + suffix);
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * The warning printed when the binary is absent.
 * @param {string} binary
 * @returns {string}
 */
export function skipMessage(binary) {
  return (
    `run-if-installed: "${binary}" is not installed — skipping.\n` +
    `  Staged files were left unformatted; CI still lints them.\n` +
    `  See docs/development.md ("Pre-commit Hooks") for the install command.\n`
  );
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * cmd.exe is the only interpreter for `.bat`/`.cmd`, so those need a shell —
 * which in turn means quoting the staged paths ourselves.
 * @param {string} resolved
 * @param {string[]} args
 * @param {string} [hostPlatform]
 * @returns {{ command: string, args: string[], shell: boolean }}
 */
export function spawnPlan(resolved, args, hostPlatform = platform) {
  if (hostPlatform !== 'win32' || !/\.(?:bat|cmd)$/i.test(resolved)) {
    return { command: resolved, args, shell: false };
  }
  const quote = (value) => (/[\s&|<>^"]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value);
  return { command: quote(resolved), args: args.map(quote), shell: true };
}

/**
 * @param {string[]} args `[binary, ...commandArgs]`
 * @returns {number} process exit code
 */
export function run(args) {
  const [binary, ...rest] = args;
  if (!binary) {
    stderr.write('usage: run-if-installed.mjs <binary> [args...]\n');
    return 2;
  }
  const resolved = findOnPath(binary);
  if (!resolved) {
    stderr.write(skipMessage(binary));
    return 0;
  }
  const plan = spawnPlan(resolved, rest);
  const result = spawnSync(plan.command, plan.args, { stdio: 'inherit', shell: plan.shell });
  return result.status ?? 1;
}

if (import.meta.url === pathToFileURL(argv[1] ?? '').href) exit(run(argv.slice(2)));
