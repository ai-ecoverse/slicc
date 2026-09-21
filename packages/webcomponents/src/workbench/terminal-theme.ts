export const TERM_SURFACE_ID = 'term';

export const TERMINAL_THEME_DEFAULTS = {
  background: '#0c0c0e',
  foreground: '#e7e7ea',
  cursor: '#f59e0b',
  cursorAccent: '#0c0c0e',
  selectionBackground: '#8b5cf64d',
  selectionForeground: '#ffffff',
  black: '#0c0c0e',
  red: '#f43f5e',
  green: '#5bd17b',
  yellow: '#f59e0b',
  blue: '#3b82f6',
  magenta: '#8b5cf6',
  cyan: '#06b6d4',
  white: '#e7e7ea',
  brightBlack: '#8a8a93',
  brightRed: '#fb7185',
  brightGreen: '#86efac',
  brightYellow: '#fbbf24',
  brightBlue: '#60a5fa',
  brightMagenta: '#a78bfa',
  brightCyan: '#22d3ee',
  brightWhite: '#ffffff',
  border: '#232329',
} as const;

export type TerminalXtermTheme = {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  selectionForeground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
};

type CssVarReader = (name: string) => string;

function firstColor(read: CssVarReader, names: readonly string[], fallback: string): string {
  for (const name of names) {
    const value = read(name).trim();

    if (value && !value.startsWith('var(')) return value;
  }
  return fallback;
}

export function buildTerminalTheme(read: CssVarReader): TerminalXtermTheme {
  const d = TERMINAL_THEME_DEFAULTS;

  const background = firstColor(read, ['--term-bg'], d.background);
  const foreground = firstColor(read, ['--term-fg'], d.foreground);
  const accent = firstColor(read, ['--term-cursor', '--ctx', '--s2-accent', '--amber'], d.cursor);
  const red = firstColor(read, ['--term-red', '--rose', '--s2-negative', '--red'], d.red);
  const green = firstColor(read, ['--term-green', '--s2-positive', '--green'], d.green);
  const yellow = firstColor(read, ['--term-yellow', '--amber'], d.yellow);
  const blue = firstColor(read, ['--term-blue', '--ctx', '--s2-accent', '--waffle'], d.blue);
  const magenta = firstColor(read, ['--term-magenta', '--violet'], d.magenta);
  const cyan = firstColor(read, ['--term-cyan', '--cyan'], d.cyan);

  return {
    background,
    foreground,
    cursor: accent,
    cursorAccent: background,
    selectionBackground: firstColor(read, ['--term-selection'], `${accent}4d`),
    selectionForeground: d.selectionForeground,
    black: background,
    red,
    green,
    yellow,
    blue,
    magenta,
    cyan,
    white: foreground,
    brightBlack: firstColor(read, ['--term-bright-black', '--txt-3'], d.brightBlack),
    brightRed: firstColor(read, ['--term-bright-red'], d.brightRed),
    brightGreen: firstColor(read, ['--term-bright-green'], d.brightGreen),
    brightYellow: firstColor(read, ['--term-bright-yellow'], d.brightYellow),
    brightBlue: firstColor(read, ['--term-bright-blue'], d.brightBlue),
    brightMagenta: firstColor(read, ['--term-bright-magenta'], d.brightMagenta),
    brightCyan: firstColor(read, ['--term-bright-cyan'], d.brightCyan),
    brightWhite: d.brightWhite,
  };
}

export function resolveTerminalTheme(el?: Element | null): TerminalXtermTheme & { border: string } {
  const target = el ?? (typeof document !== 'undefined' ? document.documentElement : null);
  const style = target ? getComputedStyle(target) : null;
  const read: CssVarReader = (name) => (style ? style.getPropertyValue(name) : '');
  const theme = buildTerminalTheme(read);
  const border = firstColor(read, ['--term-border'], TERMINAL_THEME_DEFAULTS.border);
  return { ...theme, border };
}

export function watchTerminalThemeScope(el: Element, onChange: () => void): () => void {
  if (typeof MutationObserver !== 'function' || typeof document === 'undefined') {
    return () => {};
  }
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['class', 'data-theme', 'style'],
  });
  if (document.body) {
    observer.observe(document.body, {
      attributes: true,
      attributeFilter: ['class', 'data-theme'],
    });
  }

  const frame = el.closest('.wcui-frame');
  if (frame) {
    observer.observe(frame, {
      attributes: true,
      attributeFilter: ['style', 'class', 'data-theme'],
    });
  }
  return () => observer.disconnect();
}
