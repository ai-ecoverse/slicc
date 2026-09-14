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

function activeSlot(el: SliccThemeToggle): HTMLSlotElement {
  const slots = Array.from(el.shadowRoot?.querySelectorAll('slot') ?? []);
  return slots.find((s) => !s.hasAttribute('hidden')) as HTMLSlotElement;
}

function visibleGlyphSlot(el: SliccThemeToggle): string | null {
  return activeSlot(el)?.getAttribute('name') ?? null;
}

function visibleSvg(el: SliccThemeToggle): SVGSVGElement | null {
  return activeSlot(el)?.querySelector('svg') ?? null;
}

const FORBIDDEN_GLYPHS = ['🌙', '☀', '☀️', '🌞', '🌜'];

function shadowText(el: SliccThemeToggle): string {
  return el.shadowRoot?.textContent ?? '';
}

describe('slicc-theme-toggle', () => {
  beforeEach(() => {
    ensureGlobalTokens();
    document.body.replaceChildren();

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

    expect(visibleGlyphSlot(el)).toBe('glyph-light');
    expect(visibleSvg(el)).toBeInstanceOf(SVGSVGElement);
    expect(document.body.classList.contains('dark')).toBe(false);
  });

  it('honours an explicit dark theme attribute on connect (sun glyph, pressed)', () => {
    const el = mount('dark');
    expect(el.theme).toBe('dark');
    expect(el.pressed).toBe(true);
    expect(button(el).getAttribute('aria-pressed')).toBe('true');

    expect(visibleGlyphSlot(el)).toBe('glyph-dark');
    expect(visibleSvg(el)).toBeInstanceOf(SVGSVGElement);
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

    expect(visibleGlyphSlot(el)).toBe('glyph-dark');
    expect(visibleSvg(el)).toBeInstanceOf(SVGSVGElement);
    expect(document.body.classList.contains('dark')).toBe(true);

    btn.click();
    expect(el.theme).toBe('light');
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    expect(btn.title).toBe('Switch to dark mode');

    expect(visibleGlyphSlot(el)).toBe('glyph-light');
    expect(visibleSvg(el)).toBeInstanceOf(SVGSVGElement);
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

  it('forwards the resolved theme to slicc-add-menu peers', () => {
    const menu = document.createElement('slicc-add-menu');
    document.body.append(menu);

    const el = mount();

    expect(menu.getAttribute('theme')).toBe('light');

    button(el).click();
    expect(menu.getAttribute('theme')).toBe('dark');
  });

  it('tolerates peers that do not exist yet (no throw)', () => {
    const el = mount();
    expect(() => button(el).click()).not.toThrow();
  });

  it('renders lucide <svg> glyphs (not emoji) in both slots', () => {
    const el = mount();
    const slots = Array.from(el.shadowRoot?.querySelectorAll('slot') ?? []);
    const light = slots.find((s) => s.getAttribute('name') === 'glyph-light');
    const dark = slots.find((s) => s.getAttribute('name') === 'glyph-dark');

    expect(light?.querySelector('svg')).toBeInstanceOf(SVGSVGElement);
    expect(dark?.querySelector('svg')).toBeInstanceOf(SVGSVGElement);

    expect(light?.querySelector('svg circle')).toBeNull();
    expect(light?.querySelector('svg path')).toBeTruthy();
    expect(dark?.querySelector('svg circle')).toBeTruthy();
  });

  it('renders the lucide glyph at the requested 16px size', () => {
    const el = mount();
    const svg = visibleSvg(el);
    expect(svg?.getAttribute('width')).toBe('16');
    expect(svg?.getAttribute('height')).toBe('16');
  });

  it('contains no emoji / unicode-symbol glyph in the shadow text (light or dark)', () => {
    const el = mount();
    for (const g of FORBIDDEN_GLYPHS) expect(shadowText(el)).not.toContain(g);

    el.theme = 'dark';
    for (const g of FORBIDDEN_GLYPHS) expect(shadowText(el)).not.toContain(g);

    expect(activeSlot(el)?.textContent?.trim()).toBe('');
  });

  it('tints the glyph via currentColor / inherited --ink (real Chromium)', () => {
    const el = mount();
    const svg = visibleSvg(el) as SVGSVGElement;

    expect(svg.getAttribute('stroke')).toBe('currentColor');
    expect(getComputedStyle(svg).color).not.toBe('');
  });

  it('renders a circular var(--ctl-h) square with token surface (real Chromium)', () => {
    const el = mount();
    const btn = button(el);
    const cs = getComputedStyle(btn);

    expect(cs.width).toBe('30px');
    expect(cs.height).toBe('30px');

    expect(Number.parseFloat(cs.borderTopLeftRadius)).toBeGreaterThanOrEqual(15);

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

    expect(lightBg).toBe('rgb(236, 236, 239)');
    expect(darkBg).toBe('rgb(31, 31, 34)');
    expect(darkBg).not.toBe(lightBg);
  });

  it('cleans up its click listener on disconnect', () => {
    const el = mount();
    const btn = button(el);
    el.remove();

    document.body.classList.remove('dark');
    btn.click();
    expect(document.body.classList.contains('dark')).toBe(false);
  });
});
