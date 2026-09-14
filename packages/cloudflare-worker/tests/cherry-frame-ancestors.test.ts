import { describe, expect, it } from 'vitest';
import { resolveCherryFrameAncestors } from '../src/index.js';

describe('resolveCherryFrameAncestors — extension origins survive a wildcard', () => {
  it("empty → 'none'", () => {
    expect(resolveCherryFrameAncestors('')).toBe("'none'");
  });
  it('wildcard alone → *', () => {
    expect(resolveCherryFrameAncestors('*')).toBe('*');
  });
  it('wildcard + extension origin → keeps both', () => {
    expect(resolveCherryFrameAncestors('* chrome-extension://abc')).toBe(
      '* chrome-extension://abc'
    );
  });
  it('explicit origins pass through unchanged', () => {
    expect(resolveCherryFrameAncestors('https://a.example chrome-extension://abc')).toBe(
      'https://a.example chrome-extension://abc'
    );
  });
});
