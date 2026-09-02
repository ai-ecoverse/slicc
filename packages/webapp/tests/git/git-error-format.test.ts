/**
 * Unit coverage for `expandGitError` — the shared helper that unpacks
 * isomorphic-git's `MultipleGitError`/`AggregateError` wrappers into the real
 * underlying messages so the virtual git CLI never leaks the cosmetic
 * "There are multiple errors..." text (#1033-5).
 */
import { describe, expect, it } from 'vitest';
import {
  annotateGitHubAuthFailure,
  expandGitError,
  isGitHubRemoteUrl,
} from '../../src/git/commands/shared.js';

class MultipleGitError extends Error {
  override name = 'MultipleGitError';
  errors?: unknown;
  data?: { errors?: unknown };
  constructor(message: string) {
    super(message);
  }
}

describe('expandGitError', () => {
  it('unpacks a MultipleGitError with a top-level .errors array', () => {
    const err = new MultipleGitError('There are multiple errors...');
    err.errors = [new Error('failure a'), new Error('failure b')];
    expect(expandGitError(err)).toBe('failure a\nfailure b');
  });

  it('unpacks a MultipleGitError that only carries .data.errors', () => {
    const err = new MultipleGitError('There are multiple errors...');
    err.data = { errors: [new Error('nested a'), new Error('nested b')] };
    expect(expandGitError(err)).toBe('nested a\nnested b');
  });

  it('recursively expands a nested MultipleGitError inside errors[]', () => {
    const inner = new MultipleGitError('There are multiple errors...');
    inner.errors = [new Error('leaf 1'), new Error('leaf 2')];
    const outer = new MultipleGitError('There are multiple errors...');
    outer.errors = [new Error('top'), inner];
    expect(expandGitError(outer)).toBe('top\nleaf 1\nleaf 2');
  });

  it('unpacks a native AggregateError', () => {
    const err = new AggregateError([new Error('agg a'), new Error('agg b')], 'wrapper');
    expect(expandGitError(err)).toBe('agg a\nagg b');
  });

  it('unpacks an AggregateError-shaped error matched by name', () => {
    const err = new Error('wrapper text') as Error & { errors?: unknown };
    err.name = 'AggregateError';
    err.errors = [new Error('by name a'), new Error('by name b')];
    expect(expandGitError(err)).toBe('by name a\nby name b');
  });

  it('falls back to the wrapper message when the errors array is empty', () => {
    const err = new MultipleGitError('There are multiple errors...');
    err.errors = [];
    expect(expandGitError(err)).toBe('There are multiple errors...');
  });

  it('returns .message for a plain Error', () => {
    expect(expandGitError(new Error('plain failure'))).toBe('plain failure');
  });

  it('annotates an unknown-host 401 with a provider-neutral hint (#2777)', () => {
    const message = expandGitError(new Error('HTTP Error: 401 Unauthorized'));
    expect(message).toContain('HTTP Error: 401 Unauthorized');
    expect(message).toContain('hint:');
    expect(message).toContain('Authentication failed (401)');
    expect(message).toContain('If this is GitHub');
  });

  it('uses the GitHub-specific hint when the remote URL is GitHub', () => {
    const message = expandGitError(
      new Error('HTTP Error: 401 Unauthorized'),
      'https://github.com/example/repo.git'
    );
    expect(message).toContain('GitHub returned 401');
    expect(message).toContain('oauth-token github');
    expect(message).toContain('stale');
  });

  it('does not blame GitHub OAuth for a non-GitHub remote 401', () => {
    const message = expandGitError(
      new Error('HTTP Error: 401 Unauthorized'),
      'https://gitlab.com/example/repo.git'
    );
    expect(message).toBe('HTTP Error: 401 Unauthorized');
  });

  it('annotates a non-Error unknown-host 401 string neutrally', () => {
    expect(expandGitError('HTTP Error: 401 Unauthorized')).toContain('Authentication failed (401)');
  });

  it('leaves non-auth failures alone', () => {
    expect(expandGitError(new Error('remote hung up unexpectedly'))).toBe(
      'remote hung up unexpectedly'
    );
  });

  it('stringifies a non-Error value', () => {
    expect(expandGitError('boom')).toBe('boom');
    expect(expandGitError(42)).toBe('42');
  });
});

describe('isGitHubRemoteUrl / annotateGitHubAuthFailure', () => {
  it('recognizes common GitHub remote forms', () => {
    expect(isGitHubRemoteUrl('https://github.com/o/r.git')).toBe(true);
    expect(isGitHubRemoteUrl('git@github.com:o/r.git')).toBe(true);
    expect(isGitHubRemoteUrl('ssh://git@github.com/o/r.git')).toBe(true);
    expect(isGitHubRemoteUrl('https://gitlab.com/o/r.git')).toBe(false);
  });

  it('keeps annotateGitHubAuthFailure silent for non-GitHub URLs', () => {
    expect(
      annotateGitHubAuthFailure('HTTP Error: 401 Unauthorized', 'https://bitbucket.org/o/r.git')
    ).toBe('HTTP Error: 401 Unauthorized');
  });
});

/**
 * isomorphic-git's packfile `InternalError`s are the only thing a user sees
 * when a repo's largest pack is bigger than the hostfs bridge's whole-file
 * body cap — and every git command in that repo fails, with nothing in the
 * text pointing at the mount (issue #2711).
 */
describe('expandGitError — packfile reads', () => {
  it('names the pack and the hostfs limit instead of "too large to read into memory"', () => {
    const err = new Error(
      'Could not read packfile at /mnt/slicc/.git/objects/pack/pack-abc.pack. ' +
        'The file may be missing, corrupted, or too large to read into memory.'
    );
    const message = expandGitError(err);
    expect(message).toContain('/mnt/slicc/.git/objects/pack/pack-abc.pack');
    expect(message).toContain('hostfs');
    expect(message).not.toContain('too large to read into memory');
  });

  it('explains the path-less variant too', () => {
    const err = new Error(
      'Could not read packfile data. The packfile may be missing, corrupted, ' +
        'or too large to read into memory.'
    );
    expect(expandGitError(err)).toContain('hostfs');
  });

  it('rewrites the same error when it arrives inside a MultipleGitError', () => {
    const wrapper = new MultipleGitError('There are multiple errors...');
    wrapper.errors = [
      new Error('Could not read packfile at /mnt/p/.git/objects/pack/pack-1.pack. Whatever.'),
    ];
    expect(expandGitError(wrapper)).toContain('/mnt/p/.git/objects/pack/pack-1.pack');
  });

  it('leaves an unrelated packfile error alone', () => {
    const err = new Error('Packfile trailer mismatch: expected abc, got def.');
    expect(expandGitError(err)).toBe('Packfile trailer mismatch: expected abc, got def.');
  });
});
