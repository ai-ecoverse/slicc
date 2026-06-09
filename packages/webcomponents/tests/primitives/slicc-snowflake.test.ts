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

  it('renders the ❄ glyph by default via the slot fallback', () => {
    const el = mount();
    const glyph = el.shadowRoot?.querySelector('.glyph') as HTMLElement;
    expect(glyph?.textContent).toBe('❄');
    expect(glyph?.getAttribute('part')).toBe('glyph');
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

  // --- attribute ↔ property reflection -------------------------------------

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

  it('reflects the svg property to the attribute and back', () => {
    const el = mount();
    expect(el.svg).toBe(false);
    el.svg = true;
    expect(el.hasAttribute('svg')).toBe(true);
    el.removeAttribute('svg');
    expect(el.svg).toBe(false);
  });

  // --- frozen / idle appearance (real Chromium) ----------------------------

  it('is a fixed 28×28 circular ghost-fill badge with a 1px line border (frozen)', () => {
    const el = mount();
    const host = getComputedStyle(el);
    expect(host.width).toBe('28px');
    expect(host.height).toBe('28px');

    const badge = getComputedStyle(badgeOf(el));
    expect(badge.width).toBe('28px');
    expect(badge.height).toBe('28px');
    expect(badge.borderRadius).toBe('50%');
    // --ghost (#ececef) fill, --line (#e5e5e5) 1px border, --txt-2 (#737373) glyph.
    expect(badge.backgroundColor).toBe('rgb(236, 236, 239)');
    expect(badge.borderTopWidth).toBe('1px');
    expect(badge.borderTopColor).toBe('rgb(229, 229, 229)');
    expect(badge.color).toBe('rgb(115, 115, 115)');
  });

  // --- thawing flash (real Chromium) ---------------------------------------

  it('flips to the rose flash with a #b91c4d glyph when thawed', () => {
    const el = mount((node) => {
      node.thawed = true;
    });
    const badge = getComputedStyle(badgeOf(el));
    // Glyph becomes the prototype's exact #b91c4d.
    expect(badge.color).toBe('rgb(185, 28, 77)');
    // Border + fill pick up rose tint, so they differ from the frozen tokens.
    expect(badge.borderTopColor).not.toBe('rgb(229, 229, 229)');
    expect(badge.backgroundColor).not.toBe('rgb(236, 236, 239)');
    // Rose-tinted fill is red-dominant. Chromium serializes color-mix() as a
    // `color(srgb r g b)` triple (channels in 0–1), so parse the float channels.
    const [r, , b] = (badge.backgroundColor.match(/[\d.]+/g) ?? []).map(Number);
    expect(r).toBeGreaterThan(b);
  });

  it('toggling thawed off restores the frozen appearance', () => {
    const el = mount((node) => {
      node.thawed = true;
    });
    expect(getComputedStyle(badgeOf(el)).color).toBe('rgb(185, 28, 77)');
    el.thawed = false;
    expect(getComputedStyle(badgeOf(el)).color).toBe('rgb(115, 115, 115)');
  });

  // --- glyph vs crisp inline SVG (real Chromium) ---------------------------

  it('hides the inline SVG and shows the ❄ glyph by default', () => {
    const el = mount();
    const svg = el.shadowRoot?.querySelector('.ic') as SVGElement;
    const slot = el.shadowRoot?.querySelector('.glyphslot') as HTMLElement;
    expect(svg).toBeTruthy();
    expect(getComputedStyle(svg).display).toBe('none');
    expect(getComputedStyle(slot).display).not.toBe('none');
  });

  it('shows the crisp inline six-point SVG and hides the ❄ glyph in svg mode', () => {
    const el = mount((node) => {
      node.svg = true;
    });
    const svg = el.shadowRoot?.querySelector('.ic') as SVGElement;
    const slot = el.shadowRoot?.querySelector('.glyphslot') as HTMLElement;
    expect(svg.querySelectorAll('path').length).toBeGreaterThanOrEqual(6);
    expect(getComputedStyle(svg).display).toBe('block');
    expect(getComputedStyle(slot).display).toBe('none');
  });

  it('inherits the rose glyph color into the inline SVG when thawed', () => {
    const el = mount((node) => {
      node.svg = true;
      node.thawed = true;
    });
    const svg = el.shadowRoot?.querySelector('.ic') as SVGElement;
    // stroke="currentColor" resolves to the badge's #b91c4d in the thawed state.
    expect(getComputedStyle(svg).color).toBe('rgb(185, 28, 77)');
  });
});
