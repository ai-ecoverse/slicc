// @vitest-environment jsdom
/**
 * isThemeLight() must honor the WC shell's theming scheme (`body.dark` /
 * `body[data-theme]`), not just the legacy `<html>.theme-light` class —
 * otherwise dips and sprinkles stay stuck on the dark `:root` token set.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hasLocalStorage =
  typeof localStorage !== 'undefined' && typeof localStorage.getItem === 'function';
const describeWithStorage = hasLocalStorage ? describe : describe.skip;

import {
  applyTheme,
  isThemeLight,
  registerSprinkleWindow,
  watchSprinkleThemeBroadcast,
} from '../../src/ui/theme.js';

describe('isThemeLight (WC body scheme)', () => {
  beforeEach(() => {
    document.documentElement.className = '';
    document.body.className = '';
    document.body.removeAttribute('data-theme');
  });

  it('is light when the WC shell marks the body data-theme=light', () => {
    document.body.setAttribute('data-theme', 'light');
    expect(isThemeLight()).toBe(true);
  });

  it('is dark when the WC shell marks the body .dark / data-theme=dark', () => {
    document.body.classList.add('dark');
    document.body.setAttribute('data-theme', 'dark');
    expect(isThemeLight()).toBe(false);
  });

  it('still honors the legacy <html>.theme-light class', () => {
    document.documentElement.classList.add('theme-light');
    expect(isThemeLight()).toBe(true);
  });

  it('falls back to the OS preference when no marker is set yet', () => {
    // jsdom ships no matchMedia — install one we can flip.
    const original = window.matchMedia;
    window.matchMedia = vi.fn(() => ({ matches: true })) as unknown as typeof window.matchMedia;
    expect(isThemeLight()).toBe(true);
    window.matchMedia = vi.fn(() => ({ matches: false })) as unknown as typeof window.matchMedia;
    expect(isThemeLight()).toBe(false);
    window.matchMedia = original;
  });
});

describe('watchSprinkleThemeBroadcast', () => {
  afterEach(() => {
    document.body.className = '';
    document.body.removeAttribute('data-theme');
  });

  it('re-broadcasts the theme to registered dip windows when the body theme flips', async () => {
    const posts: Array<{ type: string; isLight: boolean; overrides?: unknown }> = [];
    const fakeWindow = {
      postMessage: (msg: { type: string; isLight: boolean; overrides?: unknown }) =>
        posts.push(msg),
    } as unknown as Window;
    registerSprinkleWindow(fakeWindow);
    watchSprinkleThemeBroadcast();

    document.body.setAttribute('data-theme', 'light');
    // MutationObserver callbacks are microtask-async.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(posts.at(-1)?.type).toBe('slicc-theme');
    expect(posts.at(-1)?.isLight).toBe(true);

    document.body.setAttribute('data-theme', 'dark');
    document.body.classList.add('dark');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(posts.at(-1)?.type).toBe('slicc-theme');
    expect(posts.at(-1)?.isLight).toBe(false);
  });
});

describeWithStorage('theme override integration', () => {
  beforeEach(() => {
    localStorage.removeItem('slicc-themes');
    localStorage.removeItem('slicc-active-theme');
    document.documentElement.className = '';
    document.body.className = '';
    document.body.removeAttribute('data-theme');
    document.getElementById('slicc-theme-overrides')?.remove();
  });

  it('applyTheme calls applyThemeOverrides and injects style when a theme is active', async () => {
    const { saveCustomTheme, setActiveTheme } = await import('../../src/ui/theme-engine.js');
    saveCustomTheme({
      id: 'hook-test',
      name: 'Hook',
      base: 'dark',
      tokens: { '--s2-accent': '#ff0000' },
    });
    setActiveTheme('hook-test');
    applyTheme();
    const style = document.getElementById('slicc-theme-overrides');
    expect(style).not.toBeNull();
    expect(style!.textContent).toContain('--s2-accent: #ff0000');
  });

  it('applyTheme removes overrides when no theme is active', async () => {
    const { saveCustomTheme, setActiveTheme, clearActiveTheme } = await import(
      '../../src/ui/theme-engine.js'
    );
    saveCustomTheme({
      id: 'rm-test',
      name: 'Rm',
      base: 'dark',
      tokens: { '--s2-accent': '#00ff00' },
    });
    setActiveTheme('rm-test');
    applyTheme();
    expect(document.getElementById('slicc-theme-overrides')).not.toBeNull();
    clearActiveTheme();
    applyTheme();
    expect(document.getElementById('slicc-theme-overrides')).toBeNull();
  });
});

describeWithStorage('theme override broadcast to sprinkles', () => {
  beforeEach(() => {
    localStorage.removeItem('slicc-themes');
    localStorage.removeItem('slicc-active-theme');
    document.getElementById('slicc-theme-overrides')?.remove();
  });

  it('broadcasts overrides to registered sprinkle windows', async () => {
    const { saveCustomTheme, setActiveTheme } = await import('../../src/ui/theme-engine.js');
    const posts: unknown[] = [];
    const fakeWindow = {
      postMessage: (msg: unknown) => posts.push(msg),
    } as unknown as Window;
    registerSprinkleWindow(fakeWindow);

    saveCustomTheme({
      id: 'bc-test',
      name: 'BC',
      base: 'dark',
      tokens: { '--s2-accent': '#abcdef' },
    });
    setActiveTheme('bc-test');
    applyTheme();

    const msg = posts.find((p: any) => p.type === 'slicc-theme') as any;
    expect(msg).toBeDefined();
    expect(msg.overrides).toBeDefined();
    expect(msg.overrides['--s2-accent']).toBe('#abcdef');
  });

  it('broadcasts null overrides when no theme is active', () => {
    const posts: unknown[] = [];
    const fakeWindow = {
      postMessage: (msg: unknown) => posts.push(msg),
    } as unknown as Window;
    registerSprinkleWindow(fakeWindow);

    applyTheme();

    const msg = posts.find((p: any) => p.type === 'slicc-theme') as any;
    expect(msg).toBeDefined();
    expect(msg.overrides).toBeNull();
  });
});
