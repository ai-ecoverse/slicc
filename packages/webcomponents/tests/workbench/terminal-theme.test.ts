import { describe, expect, it } from 'vitest';
import {
  buildTerminalTheme,
  TERM_SURFACE_ID,
  TERMINAL_THEME_DEFAULTS,
} from '../../src/workbench/terminal-theme.js';

describe('terminal-theme', () => {
  it('exports the reserved term surface id', () => {
    expect(TERM_SURFACE_ID).toBe('term');
  });

  it('keeps a dark background and light foreground with empty CSS vars', () => {
    const theme = buildTerminalTheme(() => '');
    expect(theme.background).toBe(TERMINAL_THEME_DEFAULTS.background);
    expect(theme.foreground).toBe(TERMINAL_THEME_DEFAULTS.foreground);
    expect(theme.black).toBe(theme.background);
    expect(theme.white).toBe(theme.foreground);
  });

  it('never swaps to page canvas/ink even when those vars are present', () => {
    const vars: Record<string, string> = {
      '--canvas': '#fffdf8',
      '--ink': '#1a1008',
      '--bg': '#f5f0e8',
    };
    const theme = buildTerminalTheme((name) => vars[name] ?? '');
    expect(theme.background).toBe(TERMINAL_THEME_DEFAULTS.background);
    expect(theme.foreground).toBe(TERMINAL_THEME_DEFAULTS.foreground);
  });

  it('propagates theme accent / ANSI preferences into the palette', () => {
    const vars: Record<string, string> = {
      '--ctx': '#a0522d',
      '--rose': '#c45c26',
      '--cyan': '#2a9d8f',
      '--violet': '#7b4b94',
      '--amber': '#d2691e',
      '--s2-positive': '#2d9d78',
      '--term-bg': '#0c0c0e',
      '--term-fg': '#e7e7ea',
    };
    const theme = buildTerminalTheme((name) => vars[name] ?? '');
    expect(theme.background).toBe('#0c0c0e');
    expect(theme.foreground).toBe('#e7e7ea');
    expect(theme.cursor).toBe('#a0522d');
    expect(theme.red).toBe('#c45c26');
    expect(theme.cyan).toBe('#2a9d8f');
    expect(theme.magenta).toBe('#7b4b94');
    expect(theme.yellow).toBe('#d2691e');
    expect(theme.green).toBe('#2d9d78');
    expect(theme.blue).toBe('#a0522d');
  });

  it('prefers explicit --term-* overrides over page palette tokens', () => {
    const vars: Record<string, string> = {
      '--rose': '#ff0000',
      '--term-red': '#aa1122',
      '--ctx': '#0000ff',
      '--term-cursor': '#112233',
    };
    const theme = buildTerminalTheme((name) => vars[name] ?? '');
    expect(theme.red).toBe('#aa1122');
    expect(theme.cursor).toBe('#112233');
  });
});
