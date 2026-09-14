import {
  applyThemeOverrides,
  getActiveThemeId,
  getCustomThemes,
  sanitizeTheme,
} from './theme-engine.js';
import { PRESETS } from './theme-presets.js';

export type ThemePreference = 'dark' | 'light' | 'system';

const STORAGE_KEY = 'slicc-theme';
const VALID: Set<string> = new Set(['dark', 'light', 'system']);

export function getThemePreference(): ThemePreference {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored && VALID.has(stored)) return stored as ThemePreference;
  return 'system';
}

export function setThemePreference(pref: ThemePreference): void {
  localStorage.setItem(STORAGE_KEY, pref);
  applyTheme();
}

export function isThemeLight(): boolean {
  if (document.documentElement.classList.contains('theme-light')) return true;
  const body = document.body;
  if (body) {
    if (body.classList.contains('dark') || body.getAttribute('data-theme') === 'dark') {
      return false;
    }
    if (body.getAttribute('data-theme') === 'light') return true;
  }

  return window.matchMedia?.('(prefers-color-scheme: light)').matches ?? false;
}

const sprinkleWindows = new Set<Window>();

export function registerSprinkleWindow(w: Window | null | undefined): void {
  if (!w) return;
  sprinkleWindows.add(w);

  syncSprinkleTheme(w);
}

export function unregisterSprinkleWindow(w: Window | null | undefined): void {
  if (w) sprinkleWindows.delete(w);
}

function getActiveOverrides(): Record<string, string> | null {
  const id = getActiveThemeId();
  if (!id) return null;
  const theme = PRESETS.find((p) => p.id === id) ?? getCustomThemes().find((t) => t.id === id);

  return theme ? sanitizeTheme(theme).tokens : null;
}

function getSprinkleOverrideCss(): string {
  const style = document.getElementById?.('slicc-theme-overrides') as HTMLStyleElement | null;
  const rules: string[] = [];
  for (const rule of style?.sheet?.cssRules ?? []) {
    if (
      'selectorText' in rule &&
      typeof rule.selectorText === 'string' &&
      (rule.selectorText.includes('.sprinkle-') || rule.selectorText.includes('.fill'))
    ) {
      rules.push(rule.cssText);
    }
  }
  return rules.join('\n');
}

function syncSprinkleTheme(w: Window): void {
  try {
    w.postMessage(
      {
        type: 'slicc-theme',
        isLight: isThemeLight(),
        overrides: getActiveOverrides(),
        css: getSprinkleOverrideCss(),
      },
      '*'
    );
  } catch {
    sprinkleWindows.delete(w);
  }
}

function broadcastTheme(): void {
  for (const w of sprinkleWindows) syncSprinkleTheme(w);
}

export function applyTheme(): void {
  const pref = getThemePreference();
  let isLight = pref === 'light';
  if (pref === 'system') {
    isLight = window.matchMedia?.('(prefers-color-scheme: light)').matches ?? false;
  }
  document.documentElement.classList.toggle('theme-light', isLight);
  applyThemeOverrides();
  broadcastTheme();
}

let sprinkleThemeWatching = false;

export function watchSprinkleThemeBroadcast(): void {
  if (sprinkleThemeWatching) return;
  sprinkleThemeWatching = true;
  if (typeof MutationObserver !== 'undefined' && document.body) {
    new MutationObserver(() => broadcastTheme()).observe(document.body, {
      attributes: true,
      attributeFilter: ['class', 'data-theme'],
    });
  }
  window
    .matchMedia?.('(prefers-color-scheme: dark)')
    ?.addEventListener?.('change', () => broadcastTheme());
}

let mediaQuery: MediaQueryList | undefined;
let classObserver: MutationObserver | undefined;

export function initTheme(): void {
  applyTheme();
  mediaQuery = window.matchMedia?.('(prefers-color-scheme: light)');
  mediaQuery?.addEventListener?.('change', () => {
    if (getThemePreference() === 'system') applyTheme();
  });

  if (typeof MutationObserver !== 'undefined' && !classObserver) {
    classObserver = new MutationObserver(() => broadcastTheme());
    classObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    });
  }
}
