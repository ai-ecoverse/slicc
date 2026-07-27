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
import { delimiter, join } from 'node:path';
import { argv, env, exit, stderr } from 'node:process';
import { pathToFileURL } from 'node:url';

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
 * Resolve `binary` against a PATH-shaped string.
 *
 * A binary containing a path separator is treated as a path and checked
 * directly, matching how a shell resolves `./foo` versus `foo`.
 *
 * @param {string} binary
 * @param {string} [pathEnv]
 * @returns {string | null} Absolute-or-given path, or null when not found.
 */
export function findOnPath(binary, pathEnv = env['PATH'] ?? '') {
  if (!binary) return null;
  if (binary.includes('/')) return isExecutableFile(binary) ? binary : null;
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, binary);
    if (isExecutableFile(candidate)) return candidate;
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
  const result = spawnSync(resolved, rest, { stdio: 'inherit' });
  return result.status ?? 1;
}

if (import.meta.url === pathToFileURL(argv[1] ?? '').href) exit(run(argv.slice(2)));
