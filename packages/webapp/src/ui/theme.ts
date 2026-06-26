/**
 * Theme manager — reads/writes theme preference to localStorage
 * and applies .theme-light class on <html> for CSS variable switching.
 */

import { applyThemeOverrides, getActiveThemeId, getCustomThemes } from './theme-engine.js';
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

/**
 * Whether the app is currently in light mode. Two theming schemes coexist:
 * the legacy shell set `.theme-light` on `<html>`, while the WC shell themes
 * `<body>` through the `@slicc/webcomponents` token system (`body.dark` /
 * `body[data-theme]`). Dips and sprinkles default to the DARK `:root` token
 * set and only flip light when this returns true, so it must honor whichever
 * scheme is active — otherwise the WC shell (which never sets `.theme-light`)
 * leaves every embedded surface stuck dark.
 */
export function isThemeLight(): boolean {
  if (document.documentElement.classList.contains('theme-light')) return true;
  const body = document.body;
  if (body) {
    if (body.classList.contains('dark') || body.getAttribute('data-theme') === 'dark') {
      return false;
    }
    if (body.getAttribute('data-theme') === 'light') return true;
  }
  // No explicit marker yet (very early boot): fall back to the OS preference,
  // the same source `followSystemTheme()` resolves the default theme from.
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ?? false;
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

function getActiveOverrides(): Record<string, string> | null {
  const id = getActiveThemeId();
  if (!id) return null;
  const theme = PRESETS.find((p) => p.id === id) ?? getCustomThemes().find((t) => t.id === id);
  return theme?.tokens ?? null;
}

function broadcastTheme(): void {
  const isLight = isThemeLight();
  const overrides = getActiveOverrides();
  for (const w of sprinkleWindows) {
    try {
      w.postMessage({ type: 'slicc-theme', isLight, overrides }, '*');
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
  applyThemeOverrides();
  broadcastTheme();
}

let sprinkleThemeWatching = false;

/**
 * Keep embedded surfaces (dip + sprinkle iframes) in step with the WC
 * shell's live theme. The WC token system retoggles `body.dark` /
 * `body[data-theme]` when the OS scheme flips (and `followSystemTheme`
 * re-applies with no reload); observe `<body>` for those changes and an OS
 * media-query change directly, re-broadcasting each time. Idempotent — safe
 * to call from every WC boot path. (The legacy `initTheme` observed `<html>`
 * for `.theme-light`, which the WC shell never touches.)
 */
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
