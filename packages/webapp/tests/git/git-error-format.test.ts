/**
 * Unit coverage for `expandGitError` — the shared helper that unpacks
 * isomorphic-git's `MultipleGitError`/`AggregateError` wrappers into the real
 * underlying messages so the virtual git CLI never leaks the cosmetic
 * "There are multiple errors..." text (#1033-5).
 */
import { describe, expect, it } from 'vitest';
import { expandGitError } from '../../src/git/commands/shared.js';

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

  it('stringifies a non-Error value', () => {
    expect(expandGitError('boom')).toBe('boom');
    expect(expandGitError(42)).toBe('42');
  });
});
