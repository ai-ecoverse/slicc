// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { SliccTheme } from '../../src/ui/theme-types.js';
import { TOKEN_GROUPS } from '../../src/ui/theme-types.js';

describe('theme-types', () => {
  it('TOKEN_GROUPS covers all expected categories', () => {
    expect(Object.keys(TOKEN_GROUPS)).toEqual(
      expect.arrayContaining(['surfaces', 'text', 'accents', 'semantic', 'chrome'])
    );
  });

  it('every TOKEN_GROUPS entry is a non-empty array of CSS variable names', () => {
    for (const [, tokens] of Object.entries(TOKEN_GROUPS)) {
      expect(tokens.length).toBeGreaterThan(0);
      for (const t of tokens) {
        expect(t).toMatch(/^--/);
      }
    }
  });

  it('SliccTheme shape is exportable and usable', () => {
    const theme: SliccTheme = {
      id: 'test',
      name: 'Test',
      base: 'dark',
      tokens: { '--s2-gray-25': '#000' },
    };
    expect(theme.id).toBe('test');
  });
});
