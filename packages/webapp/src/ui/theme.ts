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

export function isThemeLight(): boolean {
  return document.documentElement.classList.contains('theme-light');
}

/**
 * Sprinkle iframes register their contentWindow so theme changes can be
 * broadcast to them — CSS variables inside iframes don't auto-flip when
 * the parent's `.theme-light` class toggles because they're a separate
 * document. Iframe bridges listen for `{type:'slicc-theme', isLight}`
 * and mirror the class on their own <html>.
 */
const sprinkleWindows = new Set<Window>();

export function registerSprinkleWindow(w: Window | null | undefined): void {
  if (w) sprinkleWindows.add(w);
}

export function unregisterSprinkleWindow(w: Window | null | undefined): void {
  if (w) sprinkleWindows.delete(w);
}

function broadcastTheme(): void {
  const isLight = isThemeLight();
  for (const w of sprinkleWindows) {
    try {
      w.postMessage({ type: 'slicc-theme', isLight }, '*');
    } catch {
      // Window likely detached — drop silently.
      sprinkleWindows.delete(w);
    }
  }
}

export function applyTheme(): void {
  const pref = getThemePreference();
  let isLight = pref === 'light';
  if (pref === 'system') {
    isLight = window.matchMedia?.('(prefers-color-scheme: light)').matches ?? false;
  }
  document.documentElement.classList.toggle('theme-light', isLight);
  broadcastTheme();
}

let mediaQuery: MediaQueryList | undefined;
let classObserver: MutationObserver | undefined;

export function initTheme(): void {
  applyTheme();
  mediaQuery = window.matchMedia?.('(prefers-color-scheme: light)');
  mediaQuery?.addEventListener?.('change', () => {
    if (getThemePreference() === 'system') applyTheme();
  });
  // Any path that toggles `.theme-light` on <html> — including direct DOM
  // manipulation or future UI controls — should propagate to sprinkle iframes.
  if (typeof MutationObserver !== 'undefined' && !classObserver) {
    classObserver = new MutationObserver(() => broadcastTheme());
    classObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    });
  }
}
