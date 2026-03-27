/**
 * Theme manager — reads/writes theme preference to localStorage
 * and applies .theme-light class on <html> for CSS variable switching.
 */

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

export function applyTheme(): void {
  const pref = getThemePreference();
  let isLight = pref === 'light';
  if (pref === 'system') {
    isLight = window.matchMedia?.('(prefers-color-scheme: light)').matches ?? false;
  }
  document.documentElement.classList.toggle('theme-light', isLight);
}

let mediaQuery: MediaQueryList | undefined;

export function initTheme(): void {
  applyTheme();
  mediaQuery = window.matchMedia?.('(prefers-color-scheme: light)');
  mediaQuery?.addEventListener?.('change', () => {
    if (getThemePreference() === 'system') applyTheme();
  });
}
