import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SliccPaletteCell } from '../../src/memory/slicc-palette-cell.js';
import { ensureGlobalTokens, setTheme } from '../../src/theme/tokens.js';

function mount(setup?: (el: SliccPaletteCell) => void): SliccPaletteCell {
  const el = document.createElement('slicc-palette-cell') as SliccPaletteCell;
  setup?.(el);
  document.body.appendChild(el);
  return el;
}

/** The 38px color chip inside the shadow root. */
function chip(el: SliccPaletteCell): HTMLElement {
  return el.shadowRoot?.querySelector('.ch') as HTMLElement;
}

/** The caption row inside the shadow root. */
function caption(el: SliccPaletteCell): HTMLElement {
  return el.shadowRoot?.querySelector('.cl') as HTMLElement;
}

describe('slicc-palette-cell', () => {
  beforeEach(() => {
    ensureGlobalTokens();
    setTheme('light');
    document.body.replaceChildren();
  });

  it('registers the custom element', () => {
    expect(customElements.get('slicc-palette-cell')).toBe(SliccPaletteCell);
  });

  it('renders the chip + label with ::part hooks in the shadow root', () => {
    const el = mount((e) => {
      e.color = '#faf6f1';
      e.label = 'paper';
    });
    expect(el.shadowRoot).toBeTruthy();
    expect(el.shadowRoot?.querySelector('[part="chip"]')).toBeTruthy();
    expect(el.shadowRoot?.querySelector('[part="label"]')).toBeTruthy();
    expect(caption(el).textContent).toBe('paper');
  });

  it('exposes role + tabindex for keyboard accessibility', () => {
    const el = mount();
    expect(el.getAttribute('role')).toBe('button');
    expect(el.getAttribute('tabindex')).toBe('0');
  });

  describe('attribute ↔ property reflection', () => {
    it('reflects color into the chip background', () => {
      const el = mount((e) => {
        e.color = '#8b5cf6';
      });
      expect(el.getAttribute('color')).toBe('#8b5cf6');
      expect(chip(el).style.background).toBe('rgb(139, 92, 246)');
      el.color = null;
      expect(el.hasAttribute('color')).toBe(false);
    });

    it('reflects label into the caption (escaped)', () => {
      const el = mount((e) => {
        e.label = 'violet';
      });
      expect(caption(el).textContent).toBe('violet');

      el.label = '<script>x</script>';
      expect(el.shadowRoot?.querySelector('.cl script')).toBeNull();
      expect(caption(el).textContent).toBe('<script>x</script>');
    });

    it('falls back to a <slot> when no label attribute is set', () => {
      const el = mount();
      expect(el.shadowRoot?.querySelector('.cl slot')).toBeTruthy();
    });

    it('reflects group', () => {
      const el = mount();
      expect(el.group).toBeNull();
      el.group = 'accent';
      expect(el.getAttribute('group')).toBe('accent');
      expect(el.group).toBe('accent');
      el.group = null;
      expect(el.hasAttribute('group')).toBe(false);
    });

    it('reflects selected and mirrors aria-pressed', () => {
      const el = mount();
      expect(el.selected).toBe(false);
      expect(el.getAttribute('aria-pressed')).toBe('false');
      el.selected = true;
      expect(el.hasAttribute('selected')).toBe(true);
      expect(el.getAttribute('aria-pressed')).toBe('true');
      el.selected = false;
      expect(el.getAttribute('aria-pressed')).toBe('false');
    });
  });

  describe('variants / states (computed appearance)', () => {
    it('idle has a 1px line border and no selection ring', () => {
      const el = mount((e) => {
        e.color = '#faf6f1';
        e.label = 'paper';
      });
      const cs = getComputedStyle(el);
      expect(cs.borderTopWidth).toBe('1px');
      expect(cs.borderRadius).toBe('9px');
      // No box-shadow ring when idle.
      expect(cs.boxShadow === 'none' || cs.boxShadow === '').toBe(true);
    });

    it('keeps the chip a fixed 38px tall', () => {
      const el = mount((e) => {
        e.color = '#ef7000';
      });
      expect(getComputedStyle(chip(el)).height).toBe('38px');
    });

    it('selected draws the violet double-ring (2px #fff inner, 4px violet outer)', () => {
      const el = mount((e) => {
        e.color = '#ef7000';
        e.selected = true;
      });
      const shadow = getComputedStyle(el).boxShadow;
      // Two stacked rings; inner #fff (255,255,255), outer violet (139,92,246).
      expect(shadow).toContain('rgb(255, 255, 255)');
      expect(shadow).toContain('rgb(139, 92, 246)');
    });

    it('renders the canvas-mix host surface with the 10px --ui label color', () => {
      const el = mount((e) => {
        e.color = '#fff7ed';
        e.label = 'cream';
      });
      const csLabel = getComputedStyle(caption(el));
      expect(csLabel.fontSize).toBe('10px');
      // --txt-2 light = #737373 → rgb(115, 115, 115).
      expect(csLabel.color).toBe('rgb(115, 115, 115)');
    });
  });

  describe('dark mode', () => {
    it('keeps the inner ring band #fff while the label color follows the dark token', () => {
      setTheme('dark');
      const el = mount((e) => {
        e.color = '#8b5cf6';
        e.label = 'violet';
        e.selected = true;
      });
      const shadow = getComputedStyle(el).boxShadow;
      expect(shadow).toContain('rgb(255, 255, 255)');
      // --txt-2 dark = #9b9ba1 → rgb(155, 155, 161).
      expect(getComputedStyle(caption(el)).color).toBe('rgb(155, 155, 161)');
    });
  });

  describe('behavior / events', () => {
    it('emits a composed, bubbling palette-select with color/label/group on click', () => {
      const el = mount((e) => {
        e.color = '#06b6d4';
        e.label = 'cyan';
        e.group = 'accent';
      });
      const onSelect = vi.fn();
      document.addEventListener('palette-select', onSelect);
      el.click();
      document.removeEventListener('palette-select', onSelect);

      expect(onSelect).toHaveBeenCalledTimes(1);
      const ev = onSelect.mock.calls[0][0] as CustomEvent;
      expect(ev.bubbles).toBe(true);
      expect(ev.composed).toBe(true);
      expect(ev.detail).toEqual({ color: '#06b6d4', label: 'cyan', group: 'accent' });
      expect(el.selected).toBe(true);
    });

    it('activates on Enter and Space via keyboard', () => {
      const el = mount((e) => {
        e.color = '#f43f5e';
      });
      const onSelect = vi.fn();
      el.addEventListener('palette-select', onSelect);
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
      expect(onSelect).toHaveBeenCalledTimes(2);
      expect(el.selected).toBe(true);
    });

    it('single-selects within a group, clearing same-group siblings', () => {
      const a = mount((e) => {
        e.color = '#8b5cf6';
        e.label = 'violet';
        e.group = 'accent';
        e.selected = true;
      });
      const b = mount((e) => {
        e.color = '#f43f5e';
        e.label = 'rose';
        e.group = 'accent';
      });
      b.select();
      expect(b.selected).toBe(true);
      expect(a.selected).toBe(false);
    });

    it('does not affect cells in a different group', () => {
      const canvas = mount((e) => {
        e.color = '#faf6f1';
        e.label = 'paper';
        e.group = 'canvas';
        e.selected = true;
      });
      const accent = mount((e) => {
        e.color = '#8b5cf6';
        e.label = 'violet';
        e.group = 'accent';
      });
      accent.select();
      // Cross-group selection is independent.
      expect(accent.selected).toBe(true);
      expect(canvas.selected).toBe(true);
    });

    it('ungrouped cells select independently (no coordination)', () => {
      const a = mount((e) => {
        e.color = '#06b6d4';
        e.selected = true;
      });
      const b = mount((e) => {
        e.color = '#f59e0b';
      });
      b.select();
      expect(b.selected).toBe(true);
      // No group → no sibling clearing.
      expect(a.selected).toBe(true);
    });

    it('stops listening after disconnect', () => {
      const el = mount((e) => {
        e.color = '#06b6d4';
      });
      el.remove();
      const onSelect = vi.fn();
      el.addEventListener('palette-select', onSelect);
      el.click();
      expect(onSelect).not.toHaveBeenCalled();
    });
  });
});
