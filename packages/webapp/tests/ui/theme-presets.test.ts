// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { PRESETS } from '../../src/ui/theme-presets.js';

describe('theme presets', () => {
  it('has exactly 6 presets', () => {
    expect(PRESETS).toHaveLength(6);
  });

  it('each preset has required fields and at least 10 token overrides', () => {
    for (const preset of PRESETS) {
      expect(preset.id).toMatch(/^[a-z-]+$/);
      expect(preset.name.length).toBeGreaterThan(0);
      expect(['dark', 'light']).toContain(preset.base);
      expect(Object.keys(preset.tokens).length).toBeGreaterThanOrEqual(10);
      for (const key of Object.keys(preset.tokens)) {
        expect(key).toMatch(/^--/);
      }
    }
  });

  it('has the expected preset ids', () => {
    const ids = PRESETS.map((p) => p.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        'vanilla',
        'midnight-scoop',
        'matcha-float',
        'berry-cone',
        'caramel-swirl',
        'sorbet',
      ])
    );
  });

  it('all preset ids are unique', () => {
    const ids = PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
