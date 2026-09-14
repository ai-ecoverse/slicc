import { describe, expect, it } from 'vitest';
import { slugify } from '../src/slugify.js';

describe('slugify', () => {
  it('transliterates accented letters via NFKD (Café Ölçü → cafe-olcu)', () => {
    expect(slugify('Café Ölçü')).toBe('cafe-olcu');
  });

  it('collapses non-alnum runs and trims every leading/trailing hyphen', () => {
    expect(slugify('--foo--')).toBe('foo');
    expect(slugify('---foo---bar---')).toBe('foo-bar');
    expect(slugify('  Hello  World  ')).toBe('hello-world');
  });

  it('caps length after trim when maxLen is set', () => {
    expect(slugify('x'.repeat(80), { maxLen: 40 })).toHaveLength(40);
    expect(slugify('hello-world', { maxLen: 5 })).toBe('hello');
  });

  it('returns the empty-fallback when nothing usable remains', () => {
    expect(slugify('')).toBe('');
    expect(slugify('!!!')).toBe('');
    expect(slugify('***', { fallback: 'cone' })).toBe('cone');
    expect(slugify('', { fallback: 'session' })).toBe('session');
  });

  it('defaults normalize to true and can opt out', () => {
    expect(slugify('Café', { normalize: false })).toBe('caf');
    expect(slugify('Café')).toBe('cafe');
  });
});
