import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SliccDip } from '../../src/chat/slicc-dip.js';
// Swatch cells composed by tag — import so they register when tests run.
import '../../src/memory/slicc-palette-cell.js';
import { ensureGlobalTokens } from '../../src/theme/tokens.js';

function mount(attrs: Record<string, string> = {}): SliccDip {
  const el = document.createElement('slicc-dip');
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  document.body.appendChild(el);
  return el as SliccDip;
}

describe('slicc-dip', () => {
  beforeEach(() => {
    ensureGlobalTokens();
    document.body.replaceChildren();
  });
  afterEach(() => document.body.replaceChildren());

  it('registers and renders the card structure (header/body/footer parts)', () => {
    expect(customElements.get('slicc-dip')).toBe(SliccDip);
    const el = mount();
    const r = el.shadowRoot;
    expect(r?.querySelector('[part="header"] [part="glyph"]')?.textContent).toBe('✦');
    expect(r?.querySelector('[part="tag"]')?.textContent).toContain('sprinkle');
    expect(r?.querySelector('[part="grid-canvas"]')).not.toBeNull();
    expect(r?.querySelector('[part="grid-accent"]')).not.toBeNull();
    expect(r?.querySelector('[part="apply"]')).not.toBeNull();
    expect(r?.querySelector('canvas.sprk')).not.toBeNull();
  });

  it('defaults the filename and reflects/escapes name + hue + prompt', () => {
    const el = mount();
    expect(el.shadowRoot?.querySelector('[part="name"]')?.textContent).toBe('palette.shtml');
    el.name = '<x>.shtml';
    expect(el.shadowRoot?.querySelector('[part="name"]')?.querySelector('x')).toBeNull();
    expect(el.shadowRoot?.querySelector('[part="name"]')?.textContent).toBe('<x>.shtml');
    el.hue = '#06b6d4';
    expect(
      (el.shadowRoot?.querySelector('[part="header"]') as HTMLElement).style.getPropertyValue('--c')
    ).toBe('#06b6d4');
  });

  it('composes the default swatch cells by tag (4 canvas + 4 accent)', () => {
    const el = mount();
    expect(el.querySelectorAll('slicc-palette-cell[slot="canvas"]')).toHaveLength(4);
    expect(el.querySelectorAll('slicc-palette-cell[slot="accent"]')).toHaveLength(4);
  });

  it('pre-selects paper + cone and reflects them via the getters and note', () => {
    const el = mount();
    expect(el.selectedCanvas).toEqual({ color: '#faf6f1', label: 'paper' });
    expect(el.selectedAccent).toEqual({ color: '#ef7000', label: 'cone' });
    expect(el.shadowRoot?.querySelector('[part="note"]')?.textContent).toBe('paper · cone');
  });

  it('emits slicc-dip-apply with the chosen { canvas, accent } on Apply', () => {
    const el = mount();
    let detail: { canvas: unknown; accent: unknown } | null = null;
    el.addEventListener('slicc-dip-apply', (e) => {
      detail = (e as CustomEvent).detail;
    });
    (el.shadowRoot?.querySelector('[part="apply"]') as HTMLButtonElement).click();
    expect(detail).toEqual({
      canvas: { color: '#faf6f1', label: 'paper' },
      accent: { color: '#ef7000', label: 'cone' },
    });
  });

  it('keeps two dips on the same page independent (per-instance group ids)', () => {
    const a = mount();
    const b = mount();
    const aGroup = a.querySelector('slicc-palette-cell[slot="canvas"]')?.getAttribute('group');
    const bGroup = b.querySelector('slicc-palette-cell[slot="canvas"]')?.getAttribute('group');
    expect(aGroup).not.toBe(bGroup);
  });

  it('tears down its particle field cleanly on disconnect', () => {
    const el = mount();
    expect(() => el.remove()).not.toThrow();
  });
});
