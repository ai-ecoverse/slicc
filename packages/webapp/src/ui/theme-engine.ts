import { createLogger } from '../base/logger.js';
import { PRESETS } from './theme-presets.js';
import type {
  SimplifiedSlots,
  SliccTheme,
  ThemeComponent,
  ThemeComponents,
} from './theme-types.js';

const log = createLogger('theme-engine');

const UNSAFE_CSS_PATTERN = /url\s*\(|@import|expression\s*\(|javascript:|[<>]/i;

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

  'linear-gradient',
  'radial-gradient',
  'conic-gradient',
]);

function isSafeCssValue(value: string): boolean {
  if (typeof value !== 'string' || value.length === 0 || value.length > 200) return false;
  if (UNSAFE_CSS_PATTERN.test(value)) return false;
  if (!SAFE_CSS_VALUE.test(value)) return false;
  for (const match of value.matchAll(CSS_FUNCTION_CALL)) {
    if (!SAFE_CSS_FUNCTION_NAMES.has(match[1].toLowerCase())) return false;
  }
  return true;
}

function sanitizeTokens(tokens: Record<string, string>): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const [key, value] of Object.entries(tokens)) {
    const normalized = key.startsWith('--') ? key : `--${key}`;
    if (isSafeCssValue(value)) safe[normalized] = value;
    else log.warn('dropping unsafe theme token value', { key });
  }
  return safe;
}

const SAFE_FONT_FAMILY = /^[a-zA-Z0-9\s,'"-]{1,200}$/;

function sanitizeComponent(component: ThemeComponent): ThemeComponent {
  const safe: ThemeComponent = {};
  for (const [key, value] of Object.entries(component) as [keyof ThemeComponent, string][]) {
    const ok = key === 'fontFamily' ? SAFE_FONT_FAMILY.test(value) : isSafeCssValue(value);
    if (ok) safe[key] = value;
    else log.warn('dropping unsafe theme component property', { key });
  }
  return safe;
}

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

export function sanitizeTheme(theme: SliccTheme): SliccTheme {
  return {
    ...theme,
    tokens: sanitizeTokens(theme.tokens),
    css: sanitizeCustomCss(theme.css),
    components: theme.components ? sanitizeComponents(theme.components) : undefined,
  };
}

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

export function adjustLightness(hex: string, delta: number): string {
  const [h, s, l] = hexToHsl(hex);
  return hslToHex(h, s, Math.max(0, Math.min(1, l + delta)));
}

export function adjustSaturation(hex: string, delta: number): string {
  const [h, s, l] = hexToHsl(hex);
  return hslToHex(h, Math.max(0, Math.min(1, s + delta)), l);
}

export function deriveTokens(
  slots: SimplifiedSlots,
  base: 'dark' | 'light'
): Record<string, string> {
  const isDark = base === 'dark';
  const step = isDark ? 0.03 : -0.02;

  const tokens: Record<string, string> = {};

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

  tokens['--s2-gray-300'] = slots.surface;

  tokens['--s2-gray-900'] = slots.text;
  tokens['--s2-gray-1000'] = isDark ? '#ffffff' : '#000000';
  tokens['--s2-gray-800'] = adjustLightness(slots.text, isDark ? -0.05 : 0.05);
  tokens['--s2-content-default'] = slots.text;
  tokens['--s2-content-secondary'] = adjustLightness(slots.text, isDark ? -0.1 : 0.1);
  tokens['--s2-content-tertiary'] = adjustLightness(slots.text, isDark ? -0.2 : 0.2);
  tokens['--s2-content-disabled'] = adjustLightness(slots.text, isDark ? -0.3 : 0.3);

  tokens['--s2-accent'] = slots.accent;
  tokens['--s2-accent-hover'] = adjustLightness(slots.accent, isDark ? 0.08 : -0.06);
  tokens['--s2-accent-down'] = adjustLightness(slots.accent, isDark ? -0.06 : 0.08);
  tokens['--slicc-accent'] = slots.accent;
  tokens['--slicc-cone'] = slots.accent;
  tokens['--slicc-scoop-blue'] = adjustSaturation(slots.accent, 0.1);
  tokens['--slicc-scoop-purple'] = adjustLightness(slots.accent, 0.05);
  tokens['--slicc-scoop-teal'] = adjustLightness(slots.accent, -0.05);

  tokens['--s2-positive'] = slots.success;
  tokens['--s2-negative'] = slots.error;
  tokens['--s2-informative'] = slots.accent;
  tokens['--s2-notice'] = adjustLightness(slots.accent, isDark ? 0.1 : -0.1);

  tokens['--s2-border-default'] = slots.border;
  tokens['--s2-border-subtle'] = adjustLightness(slots.border, isDark ? -0.03 : 0.03);
  tokens['--s2-border-focus'] = slots.accent;
  tokens['--s2-shadow-elevated'] = isDark ? 'rgba(0, 0, 0, 0.4)' : 'rgba(0, 0, 0, 0.1)';
  tokens['--s2-shadow-container'] = isDark ? 'rgba(0, 0, 0, 0.2)' : 'rgba(0, 0, 0, 0.05)';

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

  tokens['--amber'] = slots.accent;
  tokens['--violet'] = adjustLightness(slots.accent, isDark ? 0.08 : -0.06);
  tokens['--cyan'] = adjustLightness(slots.accent, isDark ? -0.06 : 0.08);
  tokens['--rose'] = adjustSaturation(slots.accent, 0.1);
  const gradA = adjustLightness(slots.accent, isDark ? -0.06 : 0.04);
  const gradB = adjustLightness(slots.accent, isDark ? 0.1 : -0.08);
  tokens['--rainbow'] = `linear-gradient(90deg, ${gradA} 0%, ${slots.accent} 50%, ${gradB} 100%)`;

  return tokens;
}

const STORAGE_THEMES = 'slicc-themes';
const STORAGE_ACTIVE = 'slicc-active-theme';

const STORAGE_PAIR = 'slicc-theme-pair';

const STORAGE_SCHEME = 'slicc-theme';
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

export function getSelectedThemeIds(): string[] {
  const raw = storage()?.getItem(STORAGE_PAIR);
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        const ids = parsed.filter((id): id is string => typeof id === 'string' && id.length > 0);
        if (ids.length > 0) return ids.slice(0, 2);
      }
    } catch {}
  }
  const single = storage()?.getItem(STORAGE_ACTIVE);
  return single ? [single] : [];
}

export function setSelectedThemeIds(ids: string[]): void {
  const unique = [...new Set(ids.filter((id) => id.length > 0))].slice(0, 2);
  const store = storage();
  if (!store) return;
  if (unique.length === 0) {
    store.removeItem(STORAGE_PAIR);
    store.removeItem(STORAGE_ACTIVE);
    return;
  }
  if (unique.length === 1) {
    store.removeItem(STORAGE_PAIR);
    store.setItem(STORAGE_ACTIVE, unique[0]);
    return;
  }
  store.setItem(STORAGE_PAIR, JSON.stringify(unique));
  const resolved = resolvePairedThemeId(unique);
  if (resolved) store.setItem(STORAGE_ACTIVE, resolved);
}

export function toggleSelectedTheme(id: string): void {
  const current = getSelectedThemeIds();
  if (current.includes(id)) {
    setSelectedThemeIds(current.filter((existing) => existing !== id));
    return;
  }
  if (current.length < 2) {
    setSelectedThemeIds([...current, id]);
    return;
  }
  setSelectedThemeIds([current[1], id]);
}

export function getActiveThemeId(): string | null {
  const ids = getSelectedThemeIds();
  if (ids.length === 0) return null;
  if (ids.length === 1) return ids[0];
  return resolvePairedThemeId(ids);
}

export function setActiveTheme(id: string): void {
  storage()?.removeItem(STORAGE_PAIR);
  storage()?.setItem(STORAGE_ACTIVE, id);
}

export function clearActiveTheme(): void {
  storage()?.removeItem(STORAGE_PAIR);
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
  const selected = getSelectedThemeIds();
  if (selected.includes(id)) setSelectedThemeIds(selected.filter((existing) => existing !== id));
}

function resolveTheme(id: string): SliccTheme | undefined {
  return PRESETS.find((p) => p.id === id) ?? getCustomThemes().find((t) => t.id === id);
}

function wantsLightAppearance(): boolean {
  const pref = storage()?.getItem(STORAGE_SCHEME);
  if (pref === 'light') return true;
  if (pref === 'dark') return false;
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ?? false;
}

function backgroundLuminance(theme: SliccTheme): number | null {
  const raw =
    theme.tokens['--canvas'] ||
    theme.tokens['--s2-bg-base'] ||
    theme.tokens['--s2-gray-25'] ||
    theme.tokens['--bg'];
  if (!raw) return null;
  const hex = raw.trim();
  const match = /^#([\da-fA-F]{3}|[\da-fA-F]{6})$/.exec(hex);
  if (!match) return null;
  const body = match[1];
  const expanded =
    body.length === 3
      ? body
          .split('')
          .map((c) => c + c)
          .join('')
      : body;
  const channels = [0, 2, 4].map((i) => Number.parseInt(expanded.slice(i, i + 2), 16) / 255);
  const linear = channels.map((s) => (s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4));
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function brightnessScore(theme: SliccTheme): number {
  return backgroundLuminance(theme) ?? (theme.base === 'light' ? 1 : 0);
}

function orderByBrightness(themes: SliccTheme[]): [SliccTheme, SliccTheme] {
  const [a, b] = themes;
  return brightnessScore(a) <= brightnessScore(b) ? [a, b] : [b, a];
}

function resolvePairedThemeId(ids: string[]): string | null {
  const themes = ids
    .map((id) => resolveTheme(id))
    .filter((theme): theme is SliccTheme => theme !== undefined);
  if (themes.length === 0) return null;
  if (themes.length === 1) return themes[0].id;
  const [darker, brighter] = orderByBrightness([themes[0], themes[1]]);
  return wantsLightAppearance() ? brighter.id : darker.id;
}

export function pairedThemeRole(id: string): 'darker' | 'brighter' | null {
  const ids = getSelectedThemeIds();
  if (ids.length !== 2 || !ids.includes(id)) return null;
  const themes = ids
    .map((existing) => resolveTheme(existing))
    .filter((theme): theme is SliccTheme => theme !== undefined);
  if (themes.length !== 2) return null;
  const [darker, brighter] = orderByBrightness(themes);
  if (darker.id === id) return 'darker';
  if (brighter.id === id) return 'brighter';
  return null;
}

export function getActiveThemeJson(): string | null {
  const id = getActiveThemeId();
  if (!id || id === '__preview') return null;
  const theme = resolveTheme(id);
  return theme ? exportTheme(theme) : null;
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

  const paired = getSelectedThemeIds().length === 2;
  syncBodyThemeMode(paired ? (wantsLightAppearance() ? 'light' : 'dark') : theme.base);
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
