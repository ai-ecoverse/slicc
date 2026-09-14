import { beforeEach, describe, expect, it } from 'vitest';
import { SliccSnowflake } from '../../src/primitives/slicc-snowflake.js';
import { ensureGlobalTokens } from '../../src/theme/tokens.js';

function mount(setup?: (el: SliccSnowflake) => void): SliccSnowflake {
  const el = document.createElement('slicc-snowflake');
  setup?.(el);
  document.body.appendChild(el);
  return el;
}

const badgeOf = (el: SliccSnowflake) => el.shadowRoot?.querySelector('.snow') as HTMLElement;
const glyphOf = (el: SliccSnowflake) => el.shadowRoot?.querySelector('.ic') as SVGElement;

describe('slicc-snowflake', () => {
  beforeEach(() => {
    ensureGlobalTokens();
    document.body.replaceChildren();
  });

  it('registers the custom element', () => {
    expect(customElements.get('slicc-snowflake')).toBe(SliccSnowflake);
  });

  it('renders a circular badge in its shadow root', () => {
    const el = mount();
    const badge = badgeOf(el);
    expect(badge).toBeTruthy();
    expect(badge.getAttribute('part')).toBe('badge');
  });

  it('renders the lucide snowflake as an inline <svg>, not an emoji', () => {
    const el = mount();
    const svg = glyphOf(el);
    expect(svg).toBeTruthy();
    expect(svg.tagName.toLowerCase()).toBe('svg');

    expect(svg.querySelectorAll('path, line').length).toBeGreaterThanOrEqual(6);
    expect(svg.getAttribute('part')).toBe('glyph');
    expect(svg.getAttribute('width')).toBe('14');
    expect(svg.getAttribute('height')).toBe('14');
  });

  it('exposes the glyph via the ::part(glyph) hook', () => {
    const el = mount();
    const glyph = el.shadowRoot?.querySelector('[part="glyph"]');
    expect(glyph).toBe(glyphOf(el));
  });

  it('contains no ❄ (or any emoji) glyph anywhere in its shadow root', () => {
    const el = mount();
    const html = el.shadowRoot?.innerHTML ?? '';

    const FORBIDDEN = ['❄', '❅', '❆', '☀', '✦', '🔔', '🌙'];
    expect(FORBIDDEN.some((g) => html.includes(g))).toBe(false);
  });

  it('exposes a default slot so the glyph can be overridden', () => {
    const el = mount((node) => {
      node.textContent = '*';
    });
    const slot = el.shadowRoot?.querySelector('slot') as HTMLSlotElement;
    expect(slot).toBeTruthy();
    expect(
      slot
        .assignedNodes()
        .map((n) => n.textContent)
        .join('')
    ).toBe('*');
  });

  it('reflects the thawed property to the attribute and back', () => {
    const el = mount();
    expect(el.thawed).toBe(false);
    el.thawed = true;
    expect(el.hasAttribute('thawed')).toBe(true);
    el.thawed = false;
    expect(el.hasAttribute('thawed')).toBe(false);

    el.setAttribute('thawed', '');
    expect(el.thawed).toBe(true);
  });

  it('is a fixed 28×28 circular ghost-fill badge with a 1px line border (frozen)', () => {
    const el = mount();
    const host = getComputedStyle(el);
    expect(host.width).toBe('28px');
    expect(host.height).toBe('28px');

    const badge = getComputedStyle(badgeOf(el));
    expect(badge.width).toBe('28px');
    expect(badge.height).toBe('28px');
    expect(badge.borderRadius).toBe('50%');

    expect(badge.backgroundColor).toBe('rgb(236, 236, 239)');
    expect(badge.borderTopWidth).toBe('1px');
    expect(badge.borderTopColor).toBe('rgb(229, 229, 229)');
    expect(badge.color).toBe('rgb(115, 115, 115)');
  });

  it('tints the lucide glyph with the frozen --txt-2 color (currentColor)', () => {
    const el = mount();

    expect(getComputedStyle(glyphOf(el)).color).toBe('rgb(115, 115, 115)');
  });

  it('flips to the rose flash with a #b91c4d glyph when thawed', () => {
    const el = mount((node) => {
      node.thawed = true;
    });
    const badge = getComputedStyle(badgeOf(el));

    expect(badge.color).toBe('rgb(185, 28, 77)');

    expect(badge.borderTopColor).not.toBe('rgb(229, 229, 229)');
    expect(badge.backgroundColor).not.toBe('rgb(236, 236, 239)');

    const [r, , b] = (badge.backgroundColor.match(/[\d.]+/g) ?? []).map(Number);
    expect(r).toBeGreaterThan(b);
  });

  it('inherits the rose glyph color into the lucide SVG when thawed', () => {
    const el = mount((node) => {
      node.thawed = true;
    });

    expect(getComputedStyle(glyphOf(el)).color).toBe('rgb(185, 28, 77)');
  });

  it('toggling thawed off restores the frozen appearance', () => {
    const el = mount((node) => {
      node.thawed = true;
    });
    expect(getComputedStyle(badgeOf(el)).color).toBe('rgb(185, 28, 77)');
    el.thawed = false;
    expect(getComputedStyle(badgeOf(el)).color).toBe('rgb(115, 115, 115)');
  });
});
