// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import {
  applyThemeOverrides,
  clearActiveTheme,
  deleteCustomTheme,
  deriveTokens,
  exportTheme,
  getActiveThemeId,
  getCustomThemes,
  importTheme,
  saveCustomTheme,
  setActiveTheme,
} from '../../src/ui/theme-engine.js';
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

describe('theme storage', () => {
  beforeEach(() => {
    localStorage.clear();
    document.getElementById('slicc-theme-overrides')?.remove();
  });

  it('getActiveThemeId returns null when no theme is set', () => {
    expect(getActiveThemeId()).toBeNull();
  });

  it('setActiveTheme stores the id and applyThemeOverrides injects a style element', () => {
    const theme: SliccTheme = {
      id: 'test-theme',
      name: 'Test',
      base: 'dark',
      tokens: { '--s2-gray-25': '#112233' },
    };
    saveCustomTheme(theme);
    setActiveTheme('test-theme');
    expect(getActiveThemeId()).toBe('test-theme');
    applyThemeOverrides();
    const styleEl = document.getElementById('slicc-theme-overrides');
    expect(styleEl).not.toBeNull();
    expect(styleEl!.textContent).toContain('--s2-gray-25: #112233');
  });

  it('clearActiveTheme removes the override style', () => {
    const theme: SliccTheme = {
      id: 'x',
      name: 'X',
      base: 'dark',
      tokens: { '--s2-accent': '#ff0000' },
    };
    saveCustomTheme(theme);
    setActiveTheme('x');
    applyThemeOverrides();
    expect(document.getElementById('slicc-theme-overrides')).not.toBeNull();
    clearActiveTheme();
    applyThemeOverrides();
    expect(document.getElementById('slicc-theme-overrides')).toBeNull();
  });

  it('getCustomThemes returns saved themes', () => {
    const theme: SliccTheme = { id: 'a', name: 'A', base: 'light', tokens: {} };
    saveCustomTheme(theme);
    expect(getCustomThemes()).toEqual([theme]);
  });

  it('deleteCustomTheme removes a theme and clears active if it was active', () => {
    const theme: SliccTheme = { id: 'del', name: 'Del', base: 'dark', tokens: {} };
    saveCustomTheme(theme);
    setActiveTheme('del');
    deleteCustomTheme('del');
    expect(getCustomThemes()).toEqual([]);
    expect(getActiveThemeId()).toBeNull();
  });
});

describe('import/export', () => {
  it('exportTheme returns a JSON string of the SliccTheme', () => {
    const theme: SliccTheme = {
      id: 'exp',
      name: 'Export',
      base: 'dark',
      tokens: { '--x': '#abc' },
    };
    const json = exportTheme(theme);
    expect(JSON.parse(json)).toEqual(theme);
  });

  it('importTheme parses valid JSON and returns the theme', () => {
    const theme: SliccTheme = { id: 'imp', name: 'Import', base: 'light', tokens: {} };
    const result = importTheme(JSON.stringify(theme));
    expect(result).toEqual(theme);
  });

  it('importTheme throws on invalid shape', () => {
    expect(() => importTheme('{"foo": "bar"}')).toThrow();
    expect(() => importTheme('not json')).toThrow();
  });
});

describe('full theme flow integration', () => {
  beforeEach(() => {
    localStorage.clear();
    document.getElementById('slicc-theme-overrides')?.remove();
  });

  it('preset → apply → switch to custom → export → import → delete flow', () => {
    // Apply a preset
    setActiveTheme('midnight-scoop');
    applyThemeOverrides();
    let style = document.getElementById('slicc-theme-overrides');
    expect(style).not.toBeNull();
    expect(style!.textContent).toContain('--s2-gray-25');

    // Create and save a custom theme
    const custom: SliccTheme = {
      id: 'my-custom',
      name: 'My Custom',
      base: 'dark',
      tokens: deriveTokens(
        {
          background: '#1a1a2e',
          surface: '#25254a',
          text: '#e8e8e8',
          accent: '#ff6600',
          border: '#3a3a5a',
          success: '#00ff00',
          error: '#ff0000',
        },
        'dark'
      ),
    };
    saveCustomTheme(custom);
    setActiveTheme('my-custom');
    applyThemeOverrides();
    style = document.getElementById('slicc-theme-overrides');
    expect(style!.textContent).toContain('--s2-accent: #ff6600');

    // Export and reimport
    const json = exportTheme(custom);
    const reimported = importTheme(json);
    expect(reimported.id).toBe('my-custom');
    expect(reimported.tokens['--s2-accent']).toBe('#ff6600');

    // Delete
    deleteCustomTheme('my-custom');
    expect(getCustomThemes()).toEqual([]);
    expect(getActiveThemeId()).toBeNull();
    applyThemeOverrides();
    expect(document.getElementById('slicc-theme-overrides')).toBeNull();
  });
});
