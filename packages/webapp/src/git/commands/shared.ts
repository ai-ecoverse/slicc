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
/**
 * Flag spec for `git clean`. Exported so the subcommand module reuses the same
 * definition it registers here for position-aware `--help` handling.
 */
export const CLEAN_SPEC: ArgSpec = {
  boolean: ['dry-run', 'force', 'd', 'x', 'X', 'quiet'],
  alias: { n: 'dry-run', f: 'force', q: 'quiet' },
};

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
    '--': true,
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
  clean: CLEAN_SPEC,
  diff: {
    string: ['format', 'diff-filter'],
    boolean: ['staged', 'cached', 'name-only', 'stat'],
    alias: { pretty: 'format' },
    '--': true,
  },
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
  rebase: {
    string: ['onto', 'strategy', 'strategy-option'],
    boolean: ['continue', 'abort', 'skip', 'interactive', 'rebase-merges', 'autosquash'],
    alias: { i: 'interactive', s: 'strategy', X: 'strategy-option' },
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
    boolean: ['force', 'set-upstream', 'quiet', 'verbose', 'dry-run', 'tags', 'progress'],
    alias: { f: 'force', u: 'set-upstream', q: 'quiet', v: 'verbose' },
  },
  'symbolic-ref': {
    string: ['m'],
    boolean: ['delete', 'quiet', 'short', 'recurse'],
    alias: { d: 'delete', q: 'quiet' },
  },
  'ls-tree': {
    boolean: ['r', 'd', 'name-only'],
  },
  'ls-remote': {
    boolean: ['heads', 'tags', 'symref', 'exit-code'],
    alias: { h: 'heads', t: 'tags' },
  },
};

/** Scalar value mri may store for a parsed CLI flag. */
export type GitFlagScalar = string | number | boolean;

/**
 * Parsed git subcommand flags from `parseArgs` / mri. Each flag is a
 * {@link GitFlagScalar}, a repeated array of them, or absent (`undefined`).
 * This is the explicit boundary type callers cast the opaque
 * `Record<string, unknown>` from `parseArgs` to; {@link flagString} narrows a
 * single value at read time.
 */
export interface GitParsedFlags {
  readonly [flag: string]: GitFlagScalar | readonly GitFlagScalar[] | undefined;
}

/** Read a value-flag as a string, treating empty (`--flag` with no value) as undefined. */
export function flagString(flags: GitParsedFlags, name: string): string | undefined {
  const value = flags[name];
  if (value === undefined) return undefined;
  const str = Array.isArray(value) ? String(value[value.length - 1]) : String(value);
  return str === '' ? undefined : str;
}

/**
 * Rewrite isomorphic-git's two packfile `InternalError`s into something a user
 * can act on.
 *
 * When `fs.read` on a `.pack` returns nothing, isomorphic-git reports "Could
 * not read packfile at <path>. The file may be missing, corrupted, or too
 * large to read into memory." — accurate, but it never names the one cause
 * that actually fires over a `--mount`ed checkout: the pack is bigger than the
 * hostfs bridge's whole-file body cap, so EVERY git command in that repo fails
 * and nothing in the message points at the mount (issue #2711). The second
 * form ("Could not read packfile data.") does not even carry the path.
 *
 * Returns `null` for anything else, so the caller keeps the original message.
 */
function packfileReadHint(message: string): string | null {
  // Lazy up to the first `.` that ends a sentence — a pack path is full of
  // dots (`.git`, `pack-<sha>.pack`), so a greedy or dot-excluding match
  // truncates it.
  const named = /Could not read packfile at (.+?)\.(?:\s|$)/.exec(message);
  if (named) {
    return `unable to read the packfile ${named[1]}: it could not be loaded in one piece — it may be missing or corrupted, or larger than the 100 MB hostfs whole-file limit if this repo is a --mount`;
  }
  if (message.startsWith('Could not read packfile data.')) {
    return 'unable to read packfile data: a packfile could not be loaded in one piece — it may be missing or corrupted, or larger than the 100 MB hostfs whole-file limit if this repo is a --mount';
  }
  return null;
}

/**
 * Unpack an isomorphic-git error into a human-readable message. `MultipleGitError`
 * (and native `AggregateError`) hide the real per-operation failures behind the
 * cosmetic "There are multiple errors..." text, carrying them in an `.errors[]`
 * (or `.data.errors[]`) array; surface each underlying message instead (#1033-5).
 * Nested wrappers are expanded recursively; an empty errors array falls back to
 * the wrapper's own message. Plain errors return `.message` — unless it is one
 * of the packfile `InternalError`s {@link packfileReadHint} can say something
 * useful about; non-Errors stringify.
 */
export function expandGitError(err: unknown, remoteUrl?: string): string {
  if (!(err instanceof Error)) return annotateGitHubAuthFailure(String(err), remoteUrl);
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
      return errorsList.map((inner) => expandGitError(inner, remoteUrl)).join('\n');
    }
  }
  return annotateGitHubAuthFailure(packfileReadHint(err.message) ?? err.message, remoteUrl);
}

/**
 * True when `url` points at github.com (HTTPS, SSH, or git@ form). Used to
 * keep the stale-`github.token` hint off non-GitHub remotes (#2777 review).
 */
export function isGitHubRemoteUrl(url: string): boolean {
  const trimmed = url.trim();
  if (!trimmed) return false;
  try {
    const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)
      ? trimmed
      : trimmed.includes('@') && trimmed.includes(':')
        ? `ssh://${trimmed.replace(':', '/')}`
        : `https://${trimmed}`;
    const host = new URL(withScheme).hostname.toLowerCase();
    return host === 'github.com' || host.endsWith('.github.com');
  } catch {
    return /(?:^|[@/])github\.com(?:[/:]|$)/i.test(trimmed);
  }
}

/**
 * When a remote answers 401, the bare isomorphic-git message
 * (`HTTP Error: 401 Unauthorized`) leaves agents guessing. For GitHub remotes,
 * point them at the OAuth broker path that actually renews (#2777). For other
 * hosts, leave the message alone (or use a provider-neutral hint when the
 * host is unknown) so we do not send people to `oauth-token github` for a
 * GitLab/Bitbucket failure.
 */
export function annotateGitHubAuthFailure(message: string, remoteUrl?: string): string {
  if (!/\b401\b|Unauthorized/i.test(message)) return message;

  if (remoteUrl !== undefined) {
    if (!isGitHubRemoteUrl(remoteUrl)) return message;
  } else if (!/github\.com/i.test(message)) {
    return (
      `${message}\n` +
      'hint: Authentication failed (401). Check credentials for this remote. ' +
      'If this is GitHub, stored `git config github.token` may be a stale snapshot — ' +
      're-run `oauth-token github` (or Settings → Providers → GitHub).'
    );
  }

  return (
    `${message}\n` +
    'hint: GitHub returned 401. Stored `git config github.token` may be a stale ' +
    'snapshot — git renews the OAuth broker on network ops, but a hand-written ' +
    'token is not refreshed. Re-run `oauth-token github` (or Settings → Providers → ' +
    'GitHub). If you must set `github.token` manually, capture stdout only ' +
    '(never `2>&1`) and prefer leaving the bridge to the OAuth login.'
  );
}

/**
 * Spread into every `statusMatrix` / `WORKDIR` call made by a command that is
 * not supposed to mutate the repository.
 *
 * isomorphic-git's workdir walker defaults to `refresh: true`: whenever
 * `compareStats` says a file's cached stats are stale it re-hashes the file
 * and — if the oid still matches — calls `index.insert(...)` purely to warm
 * the stat cache. That marks the index dirty, so `GitIndexManager.acquire`
 * serializes and writes the WHOLE `.git/index` back, once per file.
 *
 * Over a `--mount`ed host checkout the stats can never match (the hostfs
 * bridge has no ctime/ino/uid/gid of its own to report), so a single
 * `git ls-files` rewrote the user's real index 3,485 times — 437 KB per PUT
 * — and left it in isomorphic-git's extension-less v2 form. A read-only
 * command must never write. See issue #2708.
 */
export const NO_INDEX_REFRESH = { refresh: false } as const;
