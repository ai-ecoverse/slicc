import { describe, expect, it } from 'vitest';
import { layoutCommandForSkill } from '../../src/scoops/skills.js';

describe('layoutCommandForSkill', () => {
  it('returns a layout set command for a known preset', () => {
    expect(layoutCommandForSkill({ layout: 'focus' })).toBe('layout set focus');
  });
  it('ignores unknown presets', () => {
    expect(layoutCommandForSkill({ layout: 'bogus' })).toBeNull();
  });
  it('returns null when no layout declared', () => {
    expect(layoutCommandForSkill({})).toBeNull();
  });
});
