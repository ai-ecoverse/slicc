import type { ArgSpec } from '../../shell/arg-parser.js';

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
    string: ['message', 'author', 'date', 'file', 'cleanup'],
    boolean: ['amend', 'all', 'allow-empty'],
    alias: { m: 'message', a: 'all', F: 'file' },
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
    string: ['format', 'diff-filter', 'unified'],

    boolean: ['staged', 'cached', 'name-only', 'stat', 'no-index'],
    alias: { pretty: 'format', U: 'unified' },
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

export type GitFlagScalar = string | number | boolean;

export interface GitParsedFlags {
  readonly [flag: string]: GitFlagScalar | readonly GitFlagScalar[] | undefined;
}

export function flagString(flags: GitParsedFlags, name: string): string | undefined {
  const value = flags[name];
  if (value === undefined) return undefined;
  const str = Array.isArray(value) ? String(value[value.length - 1]) : String(value);
  return str === '' ? undefined : str;
}

function packfileReadHint(message: string): string | null {
  const named = /Could not read packfile at (.+?)\.(?:\s|$)/.exec(message);
  if (named) {
    return `unable to read the packfile ${named[1]}: it could not be loaded in one piece — it may be missing or corrupted, or larger than the 100 MB hostfs whole-file limit if this repo is a --mount`;
  }
  if (message.startsWith('Could not read packfile data.')) {
    return 'unable to read packfile data: a packfile could not be loaded in one piece — it may be missing or corrupted, or larger than the 100 MB hostfs whole-file limit if this repo is a --mount';
  }
  return null;
}

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

export const NO_INDEX_REFRESH = { refresh: false } as const;
