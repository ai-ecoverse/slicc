import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SliccThemeToggle } from '../../src/theme/slicc-theme-toggle.js';
import { ensureGlobalTokens } from '../../src/theme/tokens.js';

function mount(theme?: 'light' | 'dark'): SliccThemeToggle {
  const el = document.createElement('slicc-theme-toggle');
  if (theme) el.setAttribute('theme', theme);
  document.body.appendChild(el);
  return el;
}

function button(el: SliccThemeToggle): HTMLButtonElement {
  return el.shadowRoot?.querySelector('button.themetgl') as HTMLButtonElement;
}

function visibleGlyph(el: SliccThemeToggle): string {
  // The slot whose `hidden` attribute is absent is the active glyph.
  const slots = Array.from(el.shadowRoot?.querySelectorAll('slot') ?? []);
  const active = slots.find((s) => !s.hasAttribute('hidden'));
  return (active?.textContent ?? '').trim();
}

describe('slicc-theme-toggle', () => {
  beforeEach(() => {
    ensureGlobalTokens();
    document.body.replaceChildren();
    // The control owns body.dark; reset it so each test starts from light.
    document.body.classList.remove('dark');
    document.body.removeAttribute('data-theme');
  });

  afterEach(() => {
    document.body.classList.remove('dark');
    document.body.removeAttribute('data-theme');
  });

  it('registers the custom element', () => {
    expect(customElements.get('slicc-theme-toggle')).toBe(SliccThemeToggle);
  });

  it('renders a circular button with the part hook in shadow DOM', () => {
    const el = mount();
    const btn = button(el);
    expect(btn).toBeTruthy();
    expect(btn.getAttribute('part')).toBe('button');
    expect(btn.type).toBe('button');
  });

  it('defaults to light on connect (moon glyph, not pressed, body not dark)', () => {
    const el = mount();
    expect(el.theme).toBe('light');
    expect(el.pressed).toBe(false);
    expect(button(el).getAttribute('aria-pressed')).toBe('false');
    expect(visibleGlyph(el)).toBe('🌙');
    expect(document.body.classList.contains('dark')).toBe(false);
  });

  it('honours an explicit dark theme attribute on connect (sun glyph, pressed)', () => {
    const el = mount('dark');
    expect(el.theme).toBe('dark');
    expect(el.pressed).toBe(true);
    expect(button(el).getAttribute('aria-pressed')).toBe('true');
    expect(visibleGlyph(el)).toBe('☀');
    expect(document.body.classList.contains('dark')).toBe(true);
  });

  it('reflects the theme attribute to the property and back', () => {
    const el = mount();
    expect(el.theme).toBe('light');
    expect(el.getAttribute('theme')).toBe('light');

    el.theme = 'dark';
    expect(el.getAttribute('theme')).toBe('dark');
    expect(el.pressed).toBe(true);

    el.setAttribute('theme', 'light');
    expect(el.theme).toBe('light');
    expect(button(el).getAttribute('aria-pressed')).toBe('false');
  });

  it('toggles light → dark on click, flipping glyph, title, aria, and body', () => {
    const el = mount();
    const btn = button(el);

    btn.click();
    expect(el.theme).toBe('dark');
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    expect(btn.title).toBe('Switch to light mode');
    expect(visibleGlyph(el)).toBe('☀');
    expect(document.body.classList.contains('dark')).toBe(true);

    btn.click();
    expect(el.theme).toBe('light');
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    expect(btn.title).toBe('Switch to dark mode');
    expect(visibleGlyph(el)).toBe('🌙');
    expect(document.body.classList.contains('dark')).toBe(false);
  });

  it('emits a composed, bubbling slicc-theme-change event on click', () => {
    const el = mount();
    const themes: string[] = [];
    let composed = false;
    let bubbles = false;
    document.body.addEventListener('slicc-theme-change', (e) => {
      const ce = e as CustomEvent<{ theme: string }>;
      themes.push(ce.detail.theme);
      composed = ce.composed;
      bubbles = ce.bubbles;
    });

    button(el).click();
    button(el).click();

    expect(themes).toEqual(['dark', 'light']);
    expect(composed).toBe(true);
    expect(bubbles).toBe(true);
  });

  it('does not emit on the silent default-to-light connect path', () => {
    let fired = false;
    document.body.addEventListener('slicc-theme-change', () => {
      fired = true;
    });
    mount();
    expect(fired).toBe(false);
  });

  it('forwards the resolved theme to slicc-pill and slicc-add-menu peers', () => {
    const pill = document.createElement('slicc-pill');
    const menu = document.createElement('slicc-add-menu');
    document.body.append(pill, menu);

    const el = mount();
    // Default-to-light connect already stamps the peers.
    expect(pill.getAttribute('theme')).toBe('light');
    expect(menu.getAttribute('theme')).toBe('light');

    button(el).click();
    expect(pill.getAttribute('theme')).toBe('dark');
    expect(menu.getAttribute('theme')).toBe('dark');
  });

  it('tolerates peers that do not exist yet (no throw)', () => {
    const el = mount();
    expect(() => button(el).click()).not.toThrow();
  });

  it('renders a circular var(--ctl-h) square with token surface (real Chromium)', () => {
    const el = mount();
    const btn = button(el);
    const cs = getComputedStyle(btn);
    // --ctl-h is 30px in the light token set.
    expect(cs.width).toBe('30px');
    expect(cs.height).toBe('30px');
    // Pill radius — large enough to render a circle.
    expect(Number.parseFloat(cs.borderTopLeftRadius)).toBeGreaterThanOrEqual(15);
    // --ghost light surface (#ececef) and 1px --line border.
    expect(cs.backgroundColor).toBe('rgb(236, 236, 239)');
    expect(cs.borderTopWidth).toBe('1px');
    expect(cs.display).toBe('grid');
  });

  it('flips the button surface tokens between light and dark (real Chromium)', () => {
    const el = mount();
    const btn = button(el);
    const lightBg = getComputedStyle(btn).backgroundColor;

    el.theme = 'dark';
    const darkBg = getComputedStyle(btn).backgroundColor;

    // --ghost light (#ececef) vs dark (#1f1f22) — the surface must change.
    expect(lightBg).toBe('rgb(236, 236, 239)');
    expect(darkBg).toBe('rgb(31, 31, 34)');
    expect(darkBg).not.toBe(lightBg);
  });

  it('cleans up its click listener on disconnect', () => {
    const el = mount();
    const btn = button(el);
    el.remove();
    // After removal the listener is gone; clicking must not toggle the body.
    document.body.classList.remove('dark');
    btn.click();
    expect(document.body.classList.contains('dark')).toBe(false);
  });
});
