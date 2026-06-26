// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { deriveTokens } from '../../src/ui/theme-engine.js';
import type { SimplifiedSlots, SliccTheme } from '../../src/ui/theme-types.js';
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

describe('deriveTokens', () => {
  const darkSlots: SimplifiedSlots = {
    background: '#1a1a2e',
    surface: '#25254a',
    text: '#e8e8e8',
    accent: '#3562ff',
    border: '#3a3a5a',
    success: '#2d9d78',
    error: '#e34850',
  };

  it('returns a Record<string, string> with CSS variable keys', () => {
    const tokens = deriveTokens(darkSlots, 'dark');
    expect(typeof tokens).toBe('object');
    for (const key of Object.keys(tokens)) {
      expect(key).toMatch(/^--/);
    }
  });

  it('maps background slot to --s2-gray-25 and --s2-bg-base', () => {
    const tokens = deriveTokens(darkSlots, 'dark');
    expect(tokens['--s2-gray-25']).toBe('#1a1a2e');
    expect(tokens['--s2-bg-base']).toBe('#1a1a2e');
  });

  it('maps accent slot to --s2-accent and derives hover/down states', () => {
    const tokens = deriveTokens(darkSlots, 'dark');
    expect(tokens['--s2-accent']).toBe('#3562ff');
    expect(tokens['--s2-accent-hover']).toBeDefined();
    expect(tokens['--s2-accent-down']).toBeDefined();
    expect(tokens['--s2-accent-hover']).not.toBe(tokens['--s2-accent']);
    expect(tokens['--s2-accent-down']).not.toBe(tokens['--s2-accent']);
  });

  it('maps semantic slots directly', () => {
    const tokens = deriveTokens(darkSlots, 'dark');
    expect(tokens['--s2-positive']).toBe('#2d9d78');
    expect(tokens['--s2-negative']).toBe('#e34850');
  });

  it('generates surface variants from background via lightness shifts', () => {
    const tokens = deriveTokens(darkSlots, 'dark');
    expect(tokens['--s2-gray-50']).toBeDefined();
    expect(tokens['--s2-gray-75']).toBeDefined();
    expect(tokens['--s2-gray-50']).not.toBe(tokens['--s2-gray-25']);
  });

  it('works with light base', () => {
    const lightSlots: SimplifiedSlots = {
      background: '#ffffff',
      surface: '#f8f8f8',
      text: '#131313',
      accent: '#3b63fb',
      border: '#dadada',
      success: '#05834e',
      error: '#d92361',
    };
    const tokens = deriveTokens(lightSlots, 'light');
    expect(tokens['--s2-gray-25']).toBe('#ffffff');
    expect(tokens['--s2-content-default']).toBeDefined();
  });
});
