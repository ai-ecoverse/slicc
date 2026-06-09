import { beforeEach, describe, expect, it } from 'vitest';
import { SliccSwatch } from '../../src/primitives/slicc-swatch.js';
import { ensureGlobalTokens } from '../../src/theme/tokens.js';

function mount(attrs: Record<string, string | boolean> = {}): SliccSwatch {
  const el = document.createElement('slicc-swatch');
  for (const [k, v] of Object.entries(attrs)) {
    if (typeof v === 'boolean') el.toggleAttribute(k, v);
    else el.setAttribute(k, v);
  }
  document.body.appendChild(el);
  return el;
}

describe('slicc-swatch', () => {
  beforeEach(() => {
    ensureGlobalTokens();
    document.body.replaceChildren();
  });

  it('registers the custom element', () => {
    expect(customElements.get('slicc-swatch')).toBe(SliccSwatch);
  });

  it('renders an inner button with the part hook in its shadow root', () => {
    const el = mount({ color: '#faf6f1' });
    const button = el.shadowRoot?.querySelector('button');
    expect(button).not.toBeNull();
    expect(button?.getAttribute('part')).toBe('button');
    expect(button?.classList.contains('sw')).toBe(true);
    expect(el.shadowRoot?.querySelector('slot')).not.toBeNull();
  });

  describe('attribute ↔ property reflection', () => {
    it('reflects color', () => {
      const el = mount();
      el.color = '#8b5cf6';
      expect(el.getAttribute('color')).toBe('#8b5cf6');
      el.color = null;
      expect(el.hasAttribute('color')).toBe(false);
    });

    it('reflects hue', () => {
      const el = mount();
      expect(el.hue).toBe(false);
      el.hue = true;
      expect(el.hasAttribute('hue')).toBe(true);
      el.hue = false;
      expect(el.hasAttribute('hue')).toBe(false);
    });

    it('reflects selected', () => {
      const el = mount();
      expect(el.selected).toBe(false);
      el.selected = true;
      expect(el.hasAttribute('selected')).toBe(true);
      el.selected = false;
      expect(el.hasAttribute('selected')).toBe(false);
    });

    it('reflects label, falling back onto color for the aria-label', () => {
      const el = mount({ color: '#06b6d4' });
      expect(el.shadowRoot?.querySelector('button')?.getAttribute('aria-label')).toBe('#06b6d4');
      el.label = 'cyan';
      expect(el.getAttribute('label')).toBe('cyan');
      expect(el.shadowRoot?.querySelector('button')?.getAttribute('aria-label')).toBe('cyan');
    });
  });

  describe('variants & states (real Chromium computed style)', () => {
    it('canvas swatch is a 28×28 rounded bordered button filled with the color', () => {
      const el = mount({ color: '#faf6f1' });
      const button = el.shadowRoot?.querySelector('button') as HTMLElement;
      const cs = getComputedStyle(button);
      expect(cs.width).toBe('28px');
      expect(cs.height).toBe('28px');
      expect(cs.borderTopLeftRadius).toBe('8px');
      // 1px solid var(--line) border is present on the canvas variant.
      expect(cs.borderTopWidth).toBe('1px');
      expect(cs.borderTopStyle).toBe('solid');
      // #faf6f1 fill.
      expect(cs.backgroundColor).toBe('rgb(250, 246, 241)');
    });

    it('hue swatch drops the border so the hue fills edge to edge', () => {
      const el = mount({ color: '#8b5cf6', hue: true });
      const button = el.shadowRoot?.querySelector('button') as HTMLElement;
      const cs = getComputedStyle(button);
      expect(button.classList.contains('hue')).toBe(true);
      expect(cs.borderTopStyle).toBe('none');
      expect(cs.backgroundColor).toBe('rgb(139, 92, 246)');
    });

    it('selected swatch shows the violet double-ring via box-shadow', () => {
      const el = mount({ color: '#faf6f1', selected: true });
      const button = el.shadowRoot?.querySelector('button') as HTMLElement;
      expect(button.classList.contains('on')).toBe(true);
      const shadow = getComputedStyle(button).boxShadow;
      // white inner ring + violet (#8b5cf6 → rgb(139, 92, 246)) outer ring.
      expect(shadow).toContain('rgb(255, 255, 255)');
      expect(shadow).toContain('rgb(139, 92, 246)');
    });

    it('idle swatch has no double-ring box-shadow', () => {
      const el = mount({ color: '#faf6f1' });
      const button = el.shadowRoot?.querySelector('button') as HTMLElement;
      expect(button.classList.contains('on')).toBe(false);
      expect(getComputedStyle(button).boxShadow).toBe('none');
    });
  });

  describe('behavior & events', () => {
    it('click selects the swatch and emits a composed, bubbling select event with the color', () => {
      const el = mount({ color: '#ef7000', hue: true });
      let detail: { color: string | null } | undefined;
      let composed = false;
      let bubbles = false;
      document.body.addEventListener('select', (e) => {
        const ce = e as CustomEvent<{ color: string | null }>;
        detail = ce.detail;
        composed = ce.composed;
        bubbles = ce.bubbles;
      });
      const button = el.shadowRoot?.querySelector('button') as HTMLElement;
      button.click();
      expect(el.selected).toBe(true);
      expect(detail).toEqual({ color: '#ef7000' });
      expect(composed).toBe(true);
      expect(bubbles).toBe(true);
    });

    it('escapes a malicious color value rather than injecting markup', () => {
      const el = mount();
      el.color = '"></button><img src=x onerror=alert(1)>';
      const button = el.shadowRoot?.querySelector('button');
      // A single button survives — no injected element broke out of the attribute.
      expect(el.shadowRoot?.querySelectorAll('button').length).toBe(1);
      expect(el.shadowRoot?.querySelector('img')).toBeNull();
      expect(button).not.toBeNull();
    });
  });
});
