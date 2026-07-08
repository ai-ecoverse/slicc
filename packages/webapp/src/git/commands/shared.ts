/**
 * Shared per-subcommand flag specifications and small flag helpers used by the
 * git command modules. `GLOBAL_SPEC` (leading global flags) stays in
 * git-commands.ts since it is only consumed by `stripGlobalFlags`, which runs
 * before dispatch.
 */

import type { ArgSpec } from '../../shell/arg-parser.js';

/**
 * Single source of truth for per-subcommand flag parsing. Each entry declares
 * the value-taking flags (`string`), the boolean flags, and the short/long
 * aliases. The shared parser uses this for positional extraction, value
 * lookup, boolean/`--no-` flags, AND the position-aware `--help` / `-h`
 * short-circuit (a bare `--help` is only a help request when it isn't the
 * value of a preceding value-flag or a token after `--`). Subcommands that
 * read their flags via `args.includes(...)` (e.g. `branch` / `checkout` /
 * `diff` / `merge`) still list their value-flags here so help-detection stays
 * position-aware. Commands absent from this map take the empty spec.
 */
export const GIT_FLAG_SPECS: Record<string, ArgSpec> = {
  init: { string: ['initial-branch'], alias: { b: 'initial-branch' } },
  clone: {
    string: ['branch', 'depth', 'origin', 'upload-pack'],
    boolean: ['single-branch'],
    alias: { b: 'branch', o: 'origin' },
    default: { 'single-branch': true },
  },
  commit: {
    string: ['message', 'author', 'date', 'reuse-message', 'reedit-message', 'file', 'cleanup'],
    boolean: ['amend', 'all', 'allow-empty'],
    alias: { m: 'message', a: 'all', C: 'reuse-message', c: 'reedit-message', F: 'file' },
  },
  log: {
    string: [
      'max-count',
      'format',
      'author',
      'committer',
      'grep',
      'since',
      'until',
      'skip',
      'follow',
    ],
    boolean: ['oneline', 'stat', 'reverse', 'all'],
    alias: { n: 'max-count', pretty: 'format' },
  },
  branch: {
    string: [
      'list',
      'set-upstream-to',
      'track',
      'contains',
      'no-contains',
      'merged',
      'no-merged',
      'points-at',
    ],
    alias: { l: 'list', u: 'set-upstream-to', t: 'track' },
  },
  checkout: { string: ['b', 'B', 'orphan', 'track', 'start-point', 'conflict'], '--': true },
  diff: { string: ['format', 'diff-filter'], alias: { pretty: 'format' } },
  show: { string: ['format'], boolean: ['stat'], alias: { pretty: 'format' } },
  merge: {
    string: ['message', 'strategy', 'strategy-option'],
    alias: { m: 'message', s: 'strategy', X: 'strategy-option' },
  },
  'cherry-pick': {
    boolean: ['no-commit', 'x'],
    alias: { n: 'no-commit' },
  },
  revert: {
    boolean: ['no-commit'],
    alias: { n: 'no-commit' },
  },
  'merge-file': {
    string: ['L'],
    boolean: ['stdout', 'quiet', 'diff3', 'ours', 'theirs', 'union'],
    alias: { p: 'stdout', q: 'quiet' },
  },
  tag: {
    string: ['message', 'file', 'list', 'contains', 'points-at'],
    boolean: ['delete', 'annotate', 'force'],
    alias: { m: 'message', F: 'file', l: 'list', d: 'delete', a: 'annotate', f: 'force' },
  },
  fetch: {
    string: ['depth', 'o', 'refmap', 'upload-pack', 'negotiation-tip', 'server-option'],
    boolean: ['prune'],
    alias: { p: 'prune' },
  },
  pull: {
    string: ['depth', 's', 'strategy', 'X', 'strategy-option', 'upload-pack'],
    boolean: ['ff-only', 'ff'],
  },
  push: {
    string: ['o', 'push-option', 'receive-pack', 'repo', 'exec', 'signed', '4', '6'],
    boolean: ['force', 'set-upstream'],
    alias: { f: 'force', u: 'set-upstream' },
  },
};

/** Read a value-flag as a string, treating empty (`--flag` with no value) as undefined. */
export function flagString(flags: Record<string, unknown>, name: string): string | undefined {
  const value = flags[name];
  if (value === undefined) return undefined;
  const str = Array.isArray(value) ? String(value[value.length - 1]) : String(value);
  return str === '' ? undefined : str;
}

/**
 * Unpack an isomorphic-git error into a human-readable message. `MultipleGitError`
 * (and native `AggregateError`) hide the real per-operation failures behind the
 * cosmetic "There are multiple errors..." text, carrying them in an `.errors[]`
 * (or `.data.errors[]`) array; surface each underlying message instead (#1033-5).
 * Nested wrappers are expanded recursively; an empty errors array falls back to
 * the wrapper's own message. Plain errors return `.message`; non-Errors stringify.
 */
export function expandGitError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const data = err as Error & { errors?: unknown; data?: { errors?: unknown } };
  const isMultiple =
    err.name === 'MultipleGitError' ||
    err.name === 'AggregateError' ||
    (typeof AggregateError !== 'undefined' && err instanceof AggregateError);
  if (isMultiple) {
    const errorsList = Array.isArray(data.errors)
      ? data.errors
      : Array.isArray(data.data?.errors)
        ? (data.data?.errors as unknown[])
        : [];
    if (errorsList.length > 0) {
      return errorsList.map((inner) => expandGitError(inner)).join('\n');
    }
  }
  return err.message;
}
