import { describe, expect, it } from 'vitest';
import { flagString, type GitParsedFlags } from '../../src/git/commands/shared.js';

describe('flagString', () => {
  it('returns undefined for a missing flag', () => {
    const flags: GitParsedFlags = {};
    expect(flagString(flags, 'message')).toBeUndefined();
  });

  it('coerces a string value', () => {
    expect(flagString({ message: 'hello' }, 'message')).toBe('hello');
  });

  it('coerces a numeric value', () => {
    expect(flagString({ depth: 3 }, 'depth')).toBe('3');
  });

  it('uses the last repeated value from an array', () => {
    expect(flagString({ message: ['first', 'second'] }, 'message')).toBe('second');
  });

  it('treats an empty string as undefined', () => {
    expect(flagString({ message: '' }, 'message')).toBeUndefined();
  });

  it('treats an empty array element as undefined', () => {
    expect(flagString({ message: [''] }, 'message')).toBeUndefined();
  });
});
