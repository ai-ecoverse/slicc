import { beforeEach, describe, expect, it } from 'vitest';
import { SliccTheme } from '../../src/theme/slicc-theme.js';
import { ensureGlobalTokens, followSystemTheme, getTheme } from '../../src/theme/tokens.js';

describe('slicc-theme', () => {
  beforeEach(() => {
    ensureGlobalTokens();
    document.body.replaceChildren();
  });

  it('registers the custom element', () => {
    expect(customElements.get('slicc-theme')).toBe(SliccTheme);
  });

  it('is a light-DOM element (no shadow root) and adds the scoped host class', () => {
    const el = document.createElement('slicc-theme');
    document.body.appendChild(el);
    expect(el.shadowRoot).toBeNull();
    expect(el.classList.contains('slicc-theme')).toBe(true);
  });

  it('slots its children unchanged (light DOM)', () => {
    const el = document.createElement('slicc-theme');
    const child = document.createElement('span');
    child.textContent = 'hi';
    el.appendChild(child);
    document.body.appendChild(el);
    expect(el.querySelector('span')?.textContent).toBe('hi');
  });

  it('defaults to light and reflects the attribute to the property', () => {
    const el = document.createElement('slicc-theme');
    document.body.appendChild(el);
    expect(el.theme).toBe('light');
    expect(el.getAttribute('data-theme')).toBe('light');
    expect(el.classList.contains('dark')).toBe(false);
  });

  it('reflects the property to the attribute', () => {
    const el = document.createElement('slicc-theme');
    document.body.appendChild(el);
    el.theme = 'dark';
    expect(el.getAttribute('theme')).toBe('dark');
    expect(el.classList.contains('dark')).toBe(true);
    expect(el.getAttribute('data-theme')).toBe('dark');
  });

  it('reflects the attribute to the property', () => {
    const el = document.createElement('slicc-theme');
    el.setAttribute('theme', 'dark');
    document.body.appendChild(el);
    expect(el.theme).toBe('dark');
  });

  it('treats unknown theme values as light', () => {
    const el = document.createElement('slicc-theme');
    el.setAttribute('theme', 'neon');
    document.body.appendChild(el);
    expect(el.theme).toBe('light');
  });

  it('applies the light prototype surface tokens to itself', () => {
    const el = document.createElement('slicc-theme');
    document.body.appendChild(el);
    const cs = getComputedStyle(el);
    // Prototype :root — --canvas:#fff, --ink:#0a0a0a.
    expect(cs.getPropertyValue('--canvas').trim()).toBe('#fff');
    expect(cs.getPropertyValue('--ink').trim()).toBe('#0a0a0a');
  });

  it('applies the dark prototype surface tokens to itself', () => {
    const el = document.createElement('slicc-theme');
    el.setAttribute('theme', 'dark');
    document.body.appendChild(el);
    const cs = getComputedStyle(el);
    // Prototype body.dark — --canvas:#161618, --ink:#f5f5f2.
    expect(cs.getPropertyValue('--canvas').trim()).toBe('#161618');
    expect(cs.getPropertyValue('--ink').trim()).toBe('#f5f5f2');
  });

  it('keeps hue tokens and the rainbow gradient fixed across themes', () => {
    const light = document.createElement('slicc-theme');
    const dark = document.createElement('slicc-theme');
    dark.setAttribute('theme', 'dark');
    document.body.append(light, dark);
    const lightCs = getComputedStyle(light);
    const darkCs = getComputedStyle(dark);
    // Hue tokens are theme-invariant.
    expect(darkCs.getPropertyValue('--violet').trim()).toBe(
      lightCs.getPropertyValue('--violet').trim()
    );
    expect(darkCs.getPropertyValue('--rose').trim()).toBe(
      lightCs.getPropertyValue('--rose').trim()
    );
    // --rainbow stays a gradient in both themes.
    expect(lightCs.getPropertyValue('--rainbow')).toContain('gradient');
    expect(darkCs.getPropertyValue('--rainbow').trim()).toBe(
      lightCs.getPropertyValue('--rainbow').trim()
    );
  });

  it('themes a nested light-DOM descendant via inherited tokens', () => {
    const el = document.createElement('slicc-theme');
    el.setAttribute('theme', 'dark');
    const surface = document.createElement('div');
    surface.style.background = 'var(--canvas)';
    el.appendChild(surface);
    document.body.appendChild(el);
    // #161618 → rgb(22, 22, 24).
    expect(getComputedStyle(surface).backgroundColor).toBe('rgb(22, 22, 24)');
  });

  it('themes a nested SHADOW-DOM descendant via inherited tokens', () => {
    const el = document.createElement('slicc-theme');
    el.setAttribute('theme', 'dark');
    const host = document.createElement('div');
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = '<div class="surface" style="background:var(--canvas);">x</div>';
    el.appendChild(host);
    document.body.appendChild(el);
    const surface = root.querySelector('.surface') as HTMLElement;
    expect(getComputedStyle(surface).backgroundColor).toBe('rgb(22, 22, 24)');
  });

  it('emits a composed, bubbling slicc-theme-change event on connect', () => {
    const el = document.createElement('slicc-theme');
    el.setAttribute('theme', 'dark');
    let detail: { theme: string } | null = null;
    let composed = false;
    let bubbles = false;
    document.body.addEventListener(
      'slicc-theme-change',
      (e) => {
        const ev = e as CustomEvent<{ theme: string }>;
        detail = ev.detail;
        composed = ev.composed;
        bubbles = ev.bubbles;
      },
      { once: true }
    );
    document.body.appendChild(el);
    expect(detail).toEqual({ theme: 'dark' });
    expect(composed).toBe(true);
    expect(bubbles).toBe(true);
  });

  it('emits slicc-theme-change when the theme changes after connect', () => {
    const el = document.createElement('slicc-theme');
    document.body.appendChild(el);
    const themes: string[] = [];
    el.addEventListener('slicc-theme-change', (e) => {
      themes.push((e as CustomEvent<{ theme: string }>).detail.theme);
    });
    el.theme = 'dark';
    el.theme = 'light';
    expect(themes).toEqual(['dark', 'light']);
  });

  it('does not re-emit when the theme attribute is set to its current value', () => {
    const el = document.createElement('slicc-theme');
    el.setAttribute('theme', 'dark');
    document.body.appendChild(el);
    let count = 0;
    el.addEventListener('slicc-theme-change', () => count++);
    el.setAttribute('theme', 'dark');
    expect(count).toBe(0);
  });
});

describe('followSystemTheme', () => {
  it('applies the OS scheme to a scope and tracks live changes until unsubscribed', () => {
    const scope = document.createElement('div');
    document.body.appendChild(scope);
    let changeListener: (() => void) | null = null;
    const query = {
      matches: true,
      addEventListener: (_type: string, fn: () => void) => {
        changeListener = fn;
      },
      removeEventListener: () => {
        changeListener = null;
      },
    };
    const original = window.matchMedia;
    Object.defineProperty(window, 'matchMedia', { value: () => query, configurable: true });
    try {
      const unsubscribe = followSystemTheme(scope);
      expect(getTheme(scope)).toBe('dark');

      // System day/night switch retints live — no reload.
      query.matches = false;
      (changeListener as unknown as () => void)?.();
      expect(getTheme(scope)).toBe('light');

      unsubscribe();
      expect(changeListener).toBeNull();
    } finally {
      Object.defineProperty(window, 'matchMedia', { value: original, configurable: true });
      scope.remove();
    }
  });

  it('is a safe no-op where matchMedia is unavailable', () => {
    const original = window.matchMedia;
    Object.defineProperty(window, 'matchMedia', { value: undefined, configurable: true });
    try {
      expect(() => followSystemTheme()()).not.toThrow();
    } finally {
      Object.defineProperty(window, 'matchMedia', { value: original, configurable: true });
    }
  });
});
