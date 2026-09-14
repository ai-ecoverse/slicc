import { describe, expect, it } from 'vitest';
import { isSliccTemplate } from '../src/substrates/e2b.js';

describe('isSliccTemplate (e2b list alias filter)', () => {
  it('matches the production slicc alias', () => {
    expect(isSliccTemplate('slicc')).toBe(true);
  });

  it('matches isolated test aliases (slicc-test) so they list instead of showing dead', () => {
    expect(isSliccTemplate('slicc-test')).toBe(true);
    expect(isSliccTemplate('slicc-pr-1108')).toBe(true);
  });

  it('rejects unrelated team templates', () => {
    expect(isSliccTemplate('base')).toBe(false);
    expect(isSliccTemplate('not-slicc')).toBe(false);
  });

  it('rejects a nameless sandbox without throwing', () => {
    expect(isSliccTemplate(undefined)).toBe(false);
  });
});
