/**
 * Theme engine — derives a full CSS token override map from 7 simplified color slots.
 * Pure HSL math, no external dependencies.
 */

import { PRESETS } from './theme-presets.js';
import type { SimplifiedSlots, SliccTheme } from './theme-types.js';

/** Convert hex (#rrggbb) to [h, s, l] where h is 0-360, s and l are 0-1. */
export function hexToHsl(hex: string): [number, number, number] {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;

  if (max === min) return [0, 0, l];

  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);

  let h: number;
  if (max === r) {
    h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
  } else if (max === g) {
    h = ((b - r) / d + 2) * 60;
  } else {
    h = ((r - g) / d + 4) * 60;
  }

  return [h, s, l];
}

/** Convert HSL (h 0-360, s 0-1, l 0-1) back to hex (#rrggbb). */
export function hslToHex(h: number, s: number, l: number): string {
  const hue2rgb = (p: number, q: number, t: number): number => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };

  let r: number, g: number, b: number;
  if (s === 0) {
    r = g = b = l;
  } else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    const hNorm = h / 360;
    r = hue2rgb(p, q, hNorm + 1 / 3);
    g = hue2rgb(p, q, hNorm);
    b = hue2rgb(p, q, hNorm - 1 / 3);
  }

  const toHex = (v: number) =>
    Math.round(v * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

/** Shift lightness by delta (clamped 0-1). */
export function adjustLightness(hex: string, delta: number): string {
  const [h, s, l] = hexToHsl(hex);
  return hslToHex(h, s, Math.max(0, Math.min(1, l + delta)));
}

/** Shift saturation by delta (clamped 0-1). */
export function adjustSaturation(hex: string, delta: number): string {
  const [h, s, l] = hexToHsl(hex);
  return hslToHex(h, Math.max(0, Math.min(1, s + delta)), l);
}

/**
 * Derive a full CSS token override map from 7 simplified color slots.
 * Returns ~30 CSS variable overrides keyed by `--s2-*` / `--slicc-*` names.
 */
export function deriveTokens(
  slots: SimplifiedSlots,
  base: 'dark' | 'light'
): Record<string, string> {
  const isDark = base === 'dark';
  const step = isDark ? 0.03 : -0.02;

  const tokens: Record<string, string> = {};

  // Surfaces
  tokens['--s2-gray-25'] = slots.background;
  tokens['--s2-bg-base'] = slots.background;
  tokens['--s2-gray-50'] = adjustLightness(slots.background, step);
  tokens['--s2-gray-75'] = adjustLightness(slots.background, step * 2);
  tokens['--s2-gray-100'] = adjustLightness(slots.background, step * 3);
  tokens['--s2-gray-200'] = adjustLightness(slots.background, step * 5);
  tokens['--s2-bg-sunken'] = adjustLightness(slots.background, isDark ? -0.02 : 0.02);
  tokens['--s2-bg-layer-1'] = adjustLightness(slots.background, step);
  tokens['--s2-bg-layer-2'] = adjustLightness(slots.background, step * 2);
  tokens['--s2-bg-elevated'] = adjustLightness(slots.background, step * 3);

  // Surface slot directly
  tokens['--s2-gray-300'] = slots.surface;

  // Text
  tokens['--s2-gray-900'] = slots.text;
  tokens['--s2-gray-1000'] = isDark ? '#ffffff' : '#000000';
  tokens['--s2-gray-800'] = adjustLightness(slots.text, isDark ? -0.05 : 0.05);
  tokens['--s2-content-default'] = slots.text;
  tokens['--s2-content-secondary'] = adjustLightness(slots.text, isDark ? -0.1 : 0.1);
  tokens['--s2-content-tertiary'] = adjustLightness(slots.text, isDark ? -0.2 : 0.2);
  tokens['--s2-content-disabled'] = adjustLightness(slots.text, isDark ? -0.3 : 0.3);

  // Accents
  tokens['--s2-accent'] = slots.accent;
  tokens['--s2-accent-hover'] = adjustLightness(slots.accent, isDark ? 0.08 : -0.06);
  tokens['--s2-accent-down'] = adjustLightness(slots.accent, isDark ? -0.06 : 0.08);
  tokens['--slicc-accent'] = slots.accent;
  tokens['--slicc-cone'] = slots.accent;
  tokens['--slicc-scoop-blue'] = adjustSaturation(slots.accent, 0.1);
  tokens['--slicc-scoop-purple'] = adjustLightness(slots.accent, 0.05);
  tokens['--slicc-scoop-teal'] = adjustLightness(slots.accent, -0.05);

  // Semantic
  tokens['--s2-positive'] = slots.success;
  tokens['--s2-negative'] = slots.error;
  tokens['--s2-informative'] = slots.accent;
  tokens['--s2-notice'] = adjustLightness(slots.accent, isDark ? 0.1 : -0.1);

  // Chrome
  tokens['--s2-border-default'] = slots.border;
  tokens['--s2-border-subtle'] = adjustLightness(slots.border, isDark ? -0.03 : 0.03);
  tokens['--s2-border-focus'] = slots.accent;
  tokens['--s2-shadow-elevated'] = isDark ? 'rgba(0, 0, 0, 0.4)' : 'rgba(0, 0, 0, 0.1)';
  tokens['--s2-shadow-container'] = isDark ? 'rgba(0, 0, 0, 0.2)' : 'rgba(0, 0, 0, 0.05)';

  // WC shell tokens (webcomponents library uses these, not --s2-*)
  tokens['--canvas'] = slots.background;
  tokens['--bg'] = adjustLightness(slots.background, isDark ? -0.02 : 0.02);
  tokens['--ghost'] = adjustLightness(slots.background, step * 2);
  tokens['--desk'] = adjustLightness(slots.background, step * 2);
  tokens['--ink'] = slots.text;
  tokens['--deep'] = slots.text;
  tokens['--txt-2'] = adjustLightness(slots.text, isDark ? -0.2 : 0.2);
  tokens['--txt-3'] = adjustLightness(slots.text, isDark ? -0.35 : 0.35);
  tokens['--line'] = slots.border;
  tokens['--ctx'] = slots.accent;
  tokens['--waffle'] = slots.accent;
  tokens['--shaderbg'] = slots.background;

  return tokens;
}

// --- Storage, application, and import/export ---

const STORAGE_THEMES = 'slicc-themes';
const STORAGE_ACTIVE = 'slicc-active-theme';
const STYLE_ID = 'slicc-theme-overrides';

export function getActiveThemeId(): string | null {
  return localStorage.getItem(STORAGE_ACTIVE) || null;
}

export function setActiveTheme(id: string): void {
  localStorage.setItem(STORAGE_ACTIVE, id);
}

export function clearActiveTheme(): void {
  localStorage.removeItem(STORAGE_ACTIVE);
}

export function getCustomThemes(): SliccTheme[] {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_THEMES) || '[]');
  } catch {
    return [];
  }
}

export function saveCustomTheme(theme: SliccTheme): void {
  const themes = getCustomThemes().filter((t) => t.id !== theme.id);
  themes.push(theme);
  localStorage.setItem(STORAGE_THEMES, JSON.stringify(themes));
}

export function deleteCustomTheme(id: string): void {
  const themes = getCustomThemes().filter((t) => t.id !== id);
  localStorage.setItem(STORAGE_THEMES, JSON.stringify(themes));
  if (getActiveThemeId() === id) clearActiveTheme();
}

function resolveTheme(id: string): SliccTheme | undefined {
  return PRESETS.find((p) => p.id === id) ?? getCustomThemes().find((t) => t.id === id);
}

let onThemeChanged: ((themeJson: string | null) => void) | null = null;

export function setThemeChangeListener(fn: ((themeJson: string | null) => void) | null): void {
  onThemeChanged = fn;
}

function notifyThemeChanged(theme: SliccTheme | undefined): void {
  if (!onThemeChanged) return;
  onThemeChanged(theme ? exportTheme(theme) : null);
}

export function applyThemeOverrides(): void {
  const id = getActiveThemeId();
  const existing = document.getElementById(STYLE_ID);
  if (!id) {
    existing?.remove();
    setShaderVisibility(true);
    syncNavAccent(undefined);
    nudgeThemeObservers();
    notifyThemeChanged(undefined);
    return;
  }
  const theme = resolveTheme(id);
  if (!theme || Object.keys(theme.tokens).length === 0) {
    existing?.remove();
    setShaderVisibility(true);
    syncNavAccent(undefined);
    nudgeThemeObservers();
    notifyThemeChanged(undefined);
    return;
  }
  const declarations = Object.entries(theme.tokens)
    .map(([k, v]) => `  ${k}: ${v};`)
    .join('\n');
  const shaderRule = theme.disableShader
    ? `\n.wcui-shader{display:none!important;}\nbody{background:${theme.tokens['--canvas'] || theme.tokens['--s2-gray-25'] || 'var(--canvas)'}!important;}`
    : '';
  const css = `:root {\n${declarations}\n}\n.dark, [data-theme="dark"] {\n${declarations}\n}${shaderRule}`;
  if (existing) {
    existing.textContent = css;
  } else {
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = css;
    document.head.appendChild(style);
  }
  setShaderVisibility(!theme.disableShader);
  syncNavAccent(theme);
  nudgeThemeObservers();
  notifyThemeChanged(theme);
}

function setShaderVisibility(visible: boolean): void {
  const shader = document.querySelector('.wcui-shader') as HTMLElement | null;
  if (shader) shader.style.display = visible ? '' : 'none';
}

function nudgeThemeObservers(): void {
  const html = document.documentElement;
  html.classList.toggle('slicc-theme-applied');
}

function syncNavAccent(theme: SliccTheme | undefined): void {
  const nav = document.querySelector('.slicc-nav') as HTMLElement | null;
  if (!nav) return;
  if (theme) {
    nav.style.setProperty('--ctx', theme.tokens['--ctx'] || theme.tokens['--waffle'] || '');
  } else {
    nav.style.setProperty('--ctx', 'var(--waffle)');
  }
}

export function exportTheme(theme: SliccTheme): string {
  return JSON.stringify(theme, null, 2);
}

export function importTheme(json: string): SliccTheme {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('Invalid JSON');
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !('id' in parsed) ||
    !('name' in parsed) ||
    !('base' in parsed) ||
    !('tokens' in parsed)
  ) {
    throw new Error('Invalid theme: missing required fields (id, name, base, tokens)');
  }
  const t = parsed as SliccTheme;
  if (t.base !== 'dark' && t.base !== 'light') {
    throw new Error('Invalid theme: base must be "dark" or "light"');
  }
  if (typeof t.tokens !== 'object' || t.tokens === null) {
    throw new Error('Invalid theme: tokens must be an object');
  }
  return t;
}
