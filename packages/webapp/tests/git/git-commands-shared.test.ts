import { describe, expect, it } from 'vitest';
import {
  firstUnknownGitFlag,
  flagString,
  GIT_FLAG_SPECS,
  type GitParsedFlags,
} from '../../src/git/commands/shared.js';

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

describe('firstUnknownGitFlag', () => {
  it('returns undefined when every flag is in the spec', () => {
    expect(firstUnknownGitFlag(['-q', 'origin', 'main'], GIT_FLAG_SPECS.fetch)).toBeUndefined();
    expect(firstUnknownGitFlag(['--name-status', 'a', 'b'], GIT_FLAG_SPECS.diff)).toBeUndefined();
  });

  it('names an unknown short switch and an unknown long option', () => {
    expect(firstUnknownGitFlag(['-z', 'origin'], GIT_FLAG_SPECS.fetch)).toBe('z');
    expect(firstUnknownGitFlag(['--bogus', 'origin'], GIT_FLAG_SPECS.clone)).toBe('bogus');
  });

  it('does not treat a pathspec after -- as a flag', () => {
    expect(
      firstUnknownGitFlag(['--name-only', '--', '--not-a-flag'], GIT_FLAG_SPECS.diff)
    ).toBeUndefined();
  });

  it('treats characters after a known short value flag as its value', () => {
    expect(firstUnknownGitFlag(['-bmain', 'url', 'dir'], GIT_FLAG_SPECS.clone)).toBeUndefined();
    expect(firstUnknownGitFlag(['-Xours', 'feature'], GIT_FLAG_SPECS.merge)).toBeUndefined();
  });
});
