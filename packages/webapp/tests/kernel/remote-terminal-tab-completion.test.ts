import { describe, it, expect } from 'vitest';
import {
  bashSingleQuote,
  buildCompgenPlan,
  buildCompgenDirCheck,
  longestCommonPrefix,
} from '../../src/kernel/remote-terminal-view.js';

describe('bashSingleQuote', () => {
  it("wraps empty input as `''` so compgen still has a token", () => {
    expect(bashSingleQuote('')).toBe(`''`);
  });

  it('wraps a plain word', () => {
    expect(bashSingleQuote('foo')).toBe(`'foo'`);
  });

  it("escapes embedded single quotes with the exhaustive '\\'' form", () => {
    // `won't` → `'won'\''t'` — bash concatenates 'won' + \' + 't'.
    expect(bashSingleQuote(`won't`)).toBe(`'won'\\''t'`);
  });

  it('leaves other special characters untouched (they are safe inside single quotes)', () => {
    expect(bashSingleQuote('$HOME/some dir/file*.txt')).toBe(`'$HOME/some dir/file*.txt'`);
  });
});

describe('buildCompgenPlan', () => {
  it('uses command completion when the cursor is in the first word', () => {
    expect(buildCompgenPlan('we')).toEqual({
      currentWord: 'we',
      isFirstWord: true,
      compgenCmd: `compgen -A command -- 'we'`,
    });
  });

  it('treats leading whitespace + one token as first-word still', () => {
    expect(buildCompgenPlan('  we').isFirstWord).toBe(true);
  });

  it('uses file completion for every subsequent word', () => {
    const plan = buildCompgenPlan('cat src/some-fi');
    expect(plan.currentWord).toBe('src/some-fi');
    expect(plan.isFirstWord).toBe(false);
    expect(plan.compgenCmd).toBe(`compgen -f -- 'src/some-fi'`);
  });

  it('returns an empty current word when the line ends in whitespace', () => {
    // User typed `cat ` and is asking for any file. compgen still
    // works with an empty prefix.
    const plan = buildCompgenPlan('cat ');
    expect(plan.currentWord).toBe('');
    expect(plan.isFirstWord).toBe(false);
    expect(plan.compgenCmd).toBe(`compgen -f -- ''`);
  });

  it('safely escapes single quotes in the prefix', () => {
    const plan = buildCompgenPlan(`ls won't-st`);
    expect(plan.compgenCmd).toBe(`compgen -f -- 'won'\\''t-st'`);
  });
});

describe('buildCompgenDirCheck', () => {
  it('quotes the completion and asks compgen -d', () => {
    expect(buildCompgenDirCheck('src')).toBe(`compgen -d -- 'src'`);
  });

  it('escapes embedded single quotes in the completion', () => {
    expect(buildCompgenDirCheck("with' space")).toBe(`compgen -d -- 'with'\\'' space'`);
  });
});

describe('longestCommonPrefix', () => {
  it('returns empty for empty input', () => {
    expect(longestCommonPrefix([])).toBe('');
  });

  it('returns the only match when there is exactly one', () => {
    expect(longestCommonPrefix(['screencapture'])).toBe('screencapture');
  });

  it('shrinks the prefix to the longest shared run', () => {
    expect(longestCommonPrefix(['screen', 'screencap', 'screencapture'])).toBe('screen');
  });

  it('returns empty when the first characters diverge', () => {
    expect(longestCommonPrefix(['alpha', 'beta'])).toBe('');
  });

  it('handles paths correctly (no special treatment of /)', () => {
    expect(longestCommonPrefix(['src/foo.ts', 'src/foo-bar.ts'])).toBe('src/foo');
  });
});
