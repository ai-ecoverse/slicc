import { beforeEach, describe, expect, it } from 'vitest';
import { SliccPane } from '../../src/primitives/slicc-pane.js';
import { ensureGlobalTokens } from '../../src/theme/tokens.js';

function surfaceOf(el: SliccPane): HTMLElement {
  return el.querySelector('.slicc-pane__surface') as HTMLElement;
}

describe('slicc-pane', () => {
  beforeEach(() => {
    ensureGlobalTokens();
    document.body.replaceChildren();
  });

  it('registers the custom element', () => {
    expect(customElements.get('slicc-pane')).toBe(SliccPane);
  });

  it('renders into light DOM (no shadow root) with a surface part', () => {
    const el = document.createElement('slicc-pane');
    document.body.appendChild(el);
    expect(el.shadowRoot).toBeNull();
    const surface = surfaceOf(el);
    expect(surface).not.toBeNull();
    expect(surface.getAttribute('part')).toBe('surface');
    expect(el.querySelector('[part="header"]')).not.toBeNull();
    expect(el.querySelector('[part="body"]')).not.toBeNull();
  });

  it('relocates slot="header" children into the header region and the rest into the body', () => {
    const el = document.createElement('slicc-pane');
    const head = document.createElement('div');
    head.setAttribute('slot', 'header');
    head.textContent = 'title';
    const content = document.createElement('p');
    content.textContent = 'hello';
    el.append(head, content);
    document.body.appendChild(el);

    const header = el.querySelector('[part="header"]') as HTMLElement;
    const body = el.querySelector('[part="body"]') as HTMLElement;
    expect(header.contains(head)).toBe(true);
    expect(body.contains(content)).toBe(true);
  });

  it('reflects the elevated attribute to the property and back', () => {
    const el = document.createElement('slicc-pane');
    document.body.appendChild(el);
    expect(el.elevated).toBe(false);

    el.elevated = true;
    expect(el.hasAttribute('elevated')).toBe(true);

    el.removeAttribute('elevated');
    expect(el.elevated).toBe(false);

    el.setAttribute('elevated', '');
    expect(el.elevated).toBe(true);
  });

  it('paints the default pane chrome from the prototype tokens', () => {
    const el = document.createElement('slicc-pane');
    document.body.appendChild(el);
    const cs = getComputedStyle(surfaceOf(el));
    // border-radius:14px, 1px var(--line) border, var(--canvas) #fff surface.
    expect(cs.borderTopLeftRadius).toBe('14px');
    expect(cs.borderTopWidth).toBe('1px');
    expect(cs.borderTopStyle).toBe('solid');
    expect(cs.backgroundColor).toBe('rgb(255, 255, 255)');
    expect(cs.overflow).toBe('hidden');
    expect(cs.display).toBe('flex');
    expect(cs.flexDirection).toBe('column');
    // Single-layer var(--shadow-pane) — exactly one shadow.
    expect(cs.boxShadow).not.toBe('none');
    expect(cs.boxShadow.split('rgba').length - 1).toBe(1);
  });

  it('applies the heavier two-layer shadow when elevated', () => {
    const base = document.createElement('slicc-pane');
    const elevated = document.createElement('slicc-pane');
    elevated.setAttribute('elevated', '');
    document.body.append(base, elevated);

    const baseShadow = getComputedStyle(surfaceOf(base)).boxShadow;
    const elevatedShadow = getComputedStyle(surfaceOf(elevated)).boxShadow;
    expect(elevatedShadow).not.toBe(baseShadow);
    // Two stacked rgba layers in the elevated variant.
    expect(elevatedShadow.split('rgba').length - 1).toBe(2);
  });

  it('flips the surface to the dark canvas under a dark scope', () => {
    const wrap = document.createElement('div');
    wrap.className = 'dark';
    const el = document.createElement('slicc-pane');
    wrap.appendChild(el);
    document.body.appendChild(wrap);
    const cs = getComputedStyle(surfaceOf(el));
    expect(cs.backgroundColor).toBe('rgb(22, 22, 24)');
  });

  it('fires a composed, bubbling slicc-pane-change event on variant change', () => {
    const el = document.createElement('slicc-pane');
    document.body.appendChild(el);
    let detail: { elevated: boolean } | null = null;
    document.body.addEventListener('slicc-pane-change', (e) => {
      detail = (e as CustomEvent<{ elevated: boolean }>).detail;
    });
    el.elevated = true;
    expect(detail).toEqual({ elevated: true });

    detail = null;
    el.elevated = false;
    expect(detail).toEqual({ elevated: false });
  });

  it('hosts a scrollable body at constrained height', () => {
    const el = document.createElement('slicc-pane');
    el.style.height = '80px';
    const body = document.createElement('div');
    body.style.height = '400px';
    el.appendChild(body);
    document.body.appendChild(el);
    const bodyRegion = el.querySelector('[part="body"]') as HTMLElement;
    expect(bodyRegion.scrollHeight).toBeGreaterThan(bodyRegion.clientHeight);
    expect(getComputedStyle(bodyRegion).overflow).toBe('auto');
  });
});
