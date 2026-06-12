import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SliccPaneTag } from '../../src/primitives/slicc-pane-tag.js';
import { ensureGlobalTokens } from '../../src/theme/tokens.js';

/**
 * Parse a computed color into 0–255 RGB channels. Chromium serializes
 * `color-mix(... srgb ...)` results as `color(srgb r g b)` with 0–1 floats, but
 * plain token colors as `rgb(r g b)` with 0–255 ints — normalize both.
 */
function rgb(value: string): [number, number, number] {
  const nums = value.match(/-?\d*\.?\d+/g);
  if (!nums || nums.length < 3) throw new Error(`not a color: ${value}`);
  const parsed = nums.slice(0, 3).map(Number) as [number, number, number];
  const isFloat = /^color\(/.test(value.trim());
  return parsed.map((n) => (isFloat ? Math.round(n * 255) : n)) as [number, number, number];
}

describe('slicc-pane-tag', () => {
  beforeEach(() => {
    ensureGlobalTokens();
    document.body.classList.remove('dark');
    document.body.removeAttribute('data-theme');
    document.body.replaceChildren();
  });

  afterEach(() => {
    document.body.classList.remove('dark');
    document.body.removeAttribute('data-theme');
  });

  it('registers the custom element', () => {
    expect(customElements.get('slicc-pane-tag')).toBe(SliccPaneTag);
  });

  it('renders the pill inside its shadow root', () => {
    const el = document.createElement('slicc-pane-tag');
    el.setAttribute('kind', 'tool');
    document.body.appendChild(el);
    const tag = el.shadowRoot?.querySelector('.ptag');
    expect(tag).not.toBeNull();
    expect(tag?.getAttribute('part')).toBe('tag');
  });

  it('reflects kind attribute ↔ property', () => {
    const el = document.createElement('slicc-pane-tag');
    el.kind = 'sprinkle';
    document.body.appendChild(el);
    expect(el.getAttribute('kind')).toBe('sprinkle');
    expect(el.kind).toBe('sprinkle');

    el.removeAttribute('kind');
    expect(el.kind).toBeNull();
  });

  it('treats unrecognized kind values as null', () => {
    const el = document.createElement('slicc-pane-tag');
    el.setAttribute('kind', 'bogus');
    document.body.appendChild(el);
    expect(el.kind).toBeNull();
  });

  it('shows the "tool" label and pill', () => {
    const el = document.createElement('slicc-pane-tag');
    el.setAttribute('kind', 'tool');
    document.body.appendChild(el);
    expect(el.shadowRoot?.textContent).toContain('tool');
    expect(getComputedStyle(el).display).toBe('inline-block');
  });

  it('shows the "sprinkle" label and pill', () => {
    const el = document.createElement('slicc-pane-tag');
    el.setAttribute('kind', 'sprinkle');
    document.body.appendChild(el);
    expect(el.shadowRoot?.textContent).toContain('sprinkle');
    expect(getComputedStyle(el).display).toBe('inline-block');
  });

  it('stays hidden until a recognized kind is set', () => {
    const el = document.createElement('slicc-pane-tag');
    document.body.appendChild(el);
    expect(getComputedStyle(el).display).toBe('none');

    el.kind = 'tool';
    expect(getComputedStyle(el).display).toBe('inline-block');

    el.removeAttribute('kind');
    expect(getComputedStyle(el).display).toBe('none');
  });

  it('hides when kind is set to an unrecognized value', () => {
    const el = document.createElement('slicc-pane-tag');
    el.setAttribute('kind', 'tool');
    document.body.appendChild(el);
    expect(getComputedStyle(el).display).toBe('inline-block');

    el.setAttribute('kind', 'mystery');
    expect(getComputedStyle(el).display).toBe('none');
  });

  it('prefers slotted content over the default kind label', () => {
    const el = document.createElement('slicc-pane-tag');
    el.setAttribute('kind', 'tool');
    el.textContent = 'custom';
    document.body.appendChild(el);
    const slot = el.shadowRoot?.querySelector('slot') as HTMLSlotElement;
    expect(
      slot
        .assignedNodes()
        .map((n) => n.textContent)
        .join('')
    ).toBe('custom');
  });

  it('renders the violet pill geometry from the prototype (light)', () => {
    const el = document.createElement('slicc-pane-tag');
    el.setAttribute('kind', 'tool');
    document.body.appendChild(el);
    const tag = el.shadowRoot?.querySelector('.ptag') as HTMLElement;
    const cs = getComputedStyle(tag);

    expect(cs.borderRadius).toBe('26px');
    expect(cs.borderTopWidth).toBe('1px');
    expect(cs.fontSize).toBe('10px');
    expect(cs.paddingTop).toBe('2px');
    expect(cs.paddingLeft).toBe('9px');

    // Text resolves to the violet token (#8b5cf6 → rgb(139, 92, 246)).
    expect(rgb(cs.color)).toEqual([139, 92, 246]);

    // Light background is violet mixed over white → lighter than dark canvas.
    const [r, g, b] = rgb(cs.backgroundColor);
    expect(r).toBeGreaterThan(220);
    expect(g).toBeGreaterThan(200);
    expect(b).toBeGreaterThan(220);
  });

  it('re-bases the violet tint off --canvas in dark mode', () => {
    const lightEl = document.createElement('slicc-pane-tag');
    lightEl.setAttribute('kind', 'tool');
    document.body.appendChild(lightEl);
    const lightBg = rgb(
      getComputedStyle(lightEl.shadowRoot?.querySelector('.ptag') as HTMLElement).backgroundColor
    );

    document.body.classList.add('dark');

    const darkEl = document.createElement('slicc-pane-tag');
    darkEl.setAttribute('kind', 'tool');
    document.body.appendChild(darkEl);
    const darkBg = rgb(
      getComputedStyle(darkEl.shadowRoot?.querySelector('.ptag') as HTMLElement).backgroundColor
    );

    // Dark re-bases over the dark canvas (#161618) → much darker pill.
    expect(darkBg[0]).toBeLessThan(lightBg[0]);
    expect(darkBg[1]).toBeLessThan(lightBg[1]);
    expect(darkBg[2]).toBeLessThan(lightBg[2]);
    expect(darkBg[0]).toBeLessThan(120);
  });
});
