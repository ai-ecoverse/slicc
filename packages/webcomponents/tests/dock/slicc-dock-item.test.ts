import { beforeEach, describe, expect, it } from 'vitest';
import { SliccDockItem } from '../../src/dock/slicc-dock-item.js';
import { ensureGlobalTokens } from '../../src/theme/tokens.js';

function mount(attrs: Record<string, string | boolean> = {}): SliccDockItem {
  const el = document.createElement('slicc-dock-item') as SliccDockItem;
  for (const [k, v] of Object.entries(attrs)) {
    if (typeof v === 'boolean') el.toggleAttribute(k, v);
    else el.setAttribute(k, v);
  }
  document.body.appendChild(el);
  return el;
}

/** The inner `.di` button inside the shadow root. */
function di(el: SliccDockItem): HTMLElement {
  return el.shadowRoot?.querySelector('.di') as HTMLElement;
}

describe('slicc-dock-item', () => {
  beforeEach(() => {
    ensureGlobalTokens();
    document.body.replaceChildren();
  });

  it('registers the custom element', () => {
    expect(customElements.get('slicc-dock-item')).toBe(SliccDockItem);
  });

  it('renders the inner button with ::part hooks in the shadow root', () => {
    const el = mount({ glyph: '◳', tip: 'Browser · CDP' });
    expect(el.shadowRoot).toBeTruthy();
    const button = el.shadowRoot?.querySelector('[part="button"]') as HTMLElement;
    expect(button).toBeTruthy();
    expect(button.classList.contains('di')).toBe(true);
    expect(el.shadowRoot?.querySelector('[part="glyph"]')).toBeTruthy();
    expect(el.shadowRoot?.querySelector('[part="tip"]')).toBeTruthy();
  });

  describe('attribute ↔ property reflection', () => {
    it('reflects item-id', () => {
      const el = mount();
      expect(el.itemId).toBeNull();
      el.itemId = 'browser';
      expect(el.getAttribute('item-id')).toBe('browser');
      expect(el.itemId).toBe('browser');
      el.itemId = null;
      expect(el.hasAttribute('item-id')).toBe(false);
    });

    it('reflects kind (default tool, only sprinkle accepted otherwise)', () => {
      const el = mount();
      expect(el.kind).toBe('tool');
      el.kind = 'sprinkle';
      expect(el.getAttribute('kind')).toBe('sprinkle');
      expect(el.kind).toBe('sprinkle');
      el.setAttribute('kind', 'bogus');
      expect(el.kind).toBe('tool');
    });

    it('reflects hue into the --h custom property on the button', () => {
      const el = mount();
      expect(di(el).style.getPropertyValue('--h')).toBe('');
      el.hue = '#8b5cf6';
      expect(el.getAttribute('hue')).toBe('#8b5cf6');
      expect(di(el).style.getPropertyValue('--h')).toBe('#8b5cf6');
      el.hue = null;
      expect(el.hasAttribute('hue')).toBe(false);
    });

    it('reflects glyph into the glyph slot', () => {
      const el = mount();
      expect(el.shadowRoot?.querySelector('.glyph slot')).toBeTruthy();
      el.glyph = '＋';
      expect(el.getAttribute('glyph')).toBe('＋');
      expect((el.shadowRoot?.querySelector('.glyph') as HTMLElement).textContent).toBe('＋');
    });

    it('reflects tip into the tooltip (escaped) and the aria-label', () => {
      const el = mount({ tip: 'Terminal' });
      expect((el.shadowRoot?.querySelector('.tip') as HTMLElement).textContent).toBe('Terminal');
      expect(di(el).getAttribute('aria-label')).toBe('Terminal');

      el.tip = '<script>x</script>';
      expect(el.shadowRoot?.querySelector('.tip script')).toBeNull();
      expect((el.shadowRoot?.querySelector('.tip') as HTMLElement).textContent).toBe(
        '<script>x</script>'
      );
    });

    it('reflects active', () => {
      const el = mount();
      expect(el.active).toBe(false);
      el.active = true;
      expect(el.hasAttribute('active')).toBe(true);
      expect(di(el).classList.contains('on')).toBe(true);
      expect(di(el).getAttribute('aria-pressed')).toBe('true');
      el.active = false;
      expect(el.hasAttribute('active')).toBe(false);
      expect(di(el).classList.contains('on')).toBe(false);
    });

    it('reflects lit', () => {
      const el = mount();
      expect(el.lit).toBe(false);
      el.lit = true;
      expect(el.hasAttribute('lit')).toBe(true);
      expect(di(el).classList.contains('lit')).toBe(true);
      el.lit = false;
      expect(el.hasAttribute('lit')).toBe(false);
      expect(di(el).classList.contains('lit')).toBe(false);
    });
  });

  describe('variants & states (real Chromium computed style)', () => {
    it('idle item is a transparent 34×34 rounded button with the muted glyph color', () => {
      const el = mount({ glyph: '◳', tip: 'Browser' });
      const cs = getComputedStyle(di(el));
      expect(cs.width).toBe('34px');
      expect(cs.height).toBe('34px');
      expect(cs.borderTopLeftRadius).toBe('9px');
      // transparent surface, no glow.
      expect(cs.backgroundColor).toBe('rgba(0, 0, 0, 0)');
      expect(cs.boxShadow).toBe('none');
      // --txt-2 → #737373 → rgb(115, 115, 115).
      expect(cs.color).toBe('rgb(115, 115, 115)');
    });

    it('tool item has no sprinkle status dot', () => {
      const el = mount({ glyph: '◳' });
      // ::after content is "none" for a plain tool (no .sp rule).
      const after = getComputedStyle(di(el), '::after');
      expect(after.content).toBe('none');
    });

    it('sprinkle item carries the .sp class and a status dot in --h', () => {
      const el = mount({ kind: 'sprinkle', glyph: '✦', hue: '#f59e0b' });
      expect(di(el).classList.contains('sp')).toBe(true);
      const after = getComputedStyle(di(el), '::after');
      // The status dot renders (content is a quoted empty string) ...
      expect(after.content).toBe('""');
      // ... filled with the --h hue: #f59e0b → rgb(245, 158, 11).
      expect(after.backgroundColor).toBe('rgb(245, 158, 11)');
    });

    it('sprinkle status dot falls back to violet when no hue is set', () => {
      const el = mount({ kind: 'sprinkle', glyph: '✦' });
      const after = getComputedStyle(di(el), '::after');
      // var(--h, var(--violet)) → --violet → #8b5cf6 → rgb(139, 92, 246).
      expect(after.backgroundColor).toBe('rgb(139, 92, 246)');
    });

    it('active item (.di.on) gains the ctx-tinted fill, ink glyph and outer glow', () => {
      const el = mount({ glyph: '⌗', active: true });
      const cs = getComputedStyle(di(el));
      // ctx-tinted fill is no longer fully transparent.
      expect(cs.backgroundColor).not.toBe('rgba(0, 0, 0, 0)');
      // --ink → #0a0a0a → rgb(10, 10, 10).
      expect(cs.color).toBe('rgb(10, 10, 10)');
      // ring + glow → a non-empty box-shadow referencing the ctx accent.
      expect(cs.boxShadow).not.toBe('none');
    });

    it('lit item (.di.lit) shows the kind-hue ring and a tint over the canvas', () => {
      const el = mount({ glyph: '◉', lit: true, hue: '#f59e0b' });
      const cs = getComputedStyle(di(el));
      // ring present.
      expect(cs.boxShadow).not.toBe('none');
      // tint mixes --h (amber) over var(--canvas) (white) → opaque, non-transparent.
      expect(cs.backgroundColor).not.toBe('rgba(0, 0, 0, 0)');
      expect(cs.backgroundColor).not.toBe('rgb(255, 255, 255)');
    });

    it('lit tint re-bases over the inherited canvas in dark mode', () => {
      const wrap = document.createElement('div');
      wrap.classList.add('dark');
      const el = document.createElement('slicc-dock-item') as SliccDockItem;
      el.setAttribute('lit', '');
      el.setAttribute('hue', '#8b5cf6');
      wrap.appendChild(el);
      document.body.appendChild(wrap);
      const bg = getComputedStyle(di(el)).backgroundColor;
      // Dark canvas (#161618) mixed with violet → a dark, opaque surface, NOT
      // the light-mode mix and NOT transparent.
      expect(bg).not.toBe('rgba(0, 0, 0, 0)');
      // The blue channel should dominate red (violet over near-black), and the
      // whole color should be dark (no channel near 255). Normalize from either
      // rgb()/rgba() (0-255) or Chromium's color(srgb …) (0-1) serialization.
      const nums = bg.match(/[\d.]+/g)?.map(Number) ?? [];
      const scale = bg.startsWith('color(') ? 255 : 1;
      const [r, g, b] = [nums[0] * scale, nums[1] * scale, nums[2] * scale];
      expect(Math.max(r, g, b)).toBeLessThan(120);
      expect(b).toBeGreaterThan(r);
    });

    it('positions the tooltip to the left of the button without reflowing', () => {
      const el = mount({ tip: 'Terminal' });
      const tip = el.shadowRoot?.querySelector('.tip') as HTMLElement;
      const cs = getComputedStyle(tip);
      expect(cs.position).toBe('absolute');
      // idle tooltip is hidden and non-interactive.
      expect(cs.opacity).toBe('0');
      expect(cs.pointerEvents).toBe('none');
    });
  });

  describe('behavior & events', () => {
    it('clicking an idle item emits a composed, bubbling select with the item id', () => {
      const el = mount({ 'item-id': 'browser', glyph: '◳' });
      let detail: { id: string | null } | undefined;
      let composed = false;
      let bubbles = false;
      let collapses = 0;
      document.body.addEventListener('select', (e) => {
        const ce = e as CustomEvent<{ id: string | null }>;
        detail = ce.detail;
        composed = ce.composed;
        bubbles = ce.bubbles;
      });
      document.body.addEventListener('collapse', () => {
        collapses += 1;
      });
      di(el).click();
      expect(detail).toEqual({ id: 'browser' });
      expect(composed).toBe(true);
      expect(bubbles).toBe(true);
      expect(collapses).toBe(0);
    });

    it('clicking an already-active item emits collapse instead of select', () => {
      const el = mount({ 'item-id': 'files', glyph: '⌗', active: true });
      let collapseId: string | null | undefined;
      let selects = 0;
      document.body.addEventListener('collapse', (e) => {
        collapseId = (e as CustomEvent<{ id: string | null }>).detail.id;
      });
      document.body.addEventListener('select', () => {
        selects += 1;
      });
      di(el).click();
      expect(collapseId).toBe('files');
      expect(selects).toBe(0);
    });

    it('escapes a malicious hue value rather than injecting markup', () => {
      const el = mount({ glyph: '◳' });
      el.hue = '"></button><img src=x onerror=alert(1)>';
      // A single button survives — no injected element broke out of the attribute.
      expect(el.shadowRoot?.querySelectorAll('button').length).toBe(1);
      expect(el.shadowRoot?.querySelector('img')).toBeNull();
    });
  });
});
