import { beforeEach, describe, expect, it } from 'vitest';
import { SliccPill } from '../../src/pill/slicc-pill.js';
import { ensureGlobalTokens } from '../../src/theme/tokens.js';

function mount(setup?: (el: SliccPill) => void): SliccPill {
  const el = document.createElement('slicc-pill') as SliccPill;
  setup?.(el);
  document.body.appendChild(el);
  return el;
}

/** The outer pill button inside the shadow root. */
function pill(el: SliccPill): HTMLElement {
  return el.shadowRoot?.querySelector('.pill') as HTMLElement;
}

describe('slicc-pill', () => {
  beforeEach(() => {
    ensureGlobalTokens();
    document.body.replaceChildren();
  });

  it('registers the custom element', () => {
    expect(customElements.get('slicc-pill')).toBe(SliccPill);
  });

  it('renders the pill button with ::part hooks in the shadow root', () => {
    const el = mount();
    expect(el.shadowRoot).toBeTruthy();
    expect(el.shadowRoot?.querySelector('[part="pill"]')).toBeTruthy();
    expect(el.shadowRoot?.querySelector('[part="icon"]')).toBeTruthy();
  });

  describe('attribute ↔ property reflection', () => {
    it('reflects type (default scoop)', () => {
      const el = mount();
      expect(el.type).toBe('scoop');
      el.type = 'cone';
      expect(el.getAttribute('type')).toBe('cone');
      expect(el.type).toBe('cone');
      // Anything non-cone normalizes to scoop.
      el.setAttribute('type', 'bogus');
      expect(el.type).toBe('scoop');
    });

    it('reflects color into the --accent custom property', () => {
      const el = mount((e) => {
        e.color = '#8b5cf6';
      });
      expect(el.getAttribute('color')).toBe('#8b5cf6');
      expect(pill(el).style.getPropertyValue('--accent')).toBe('#8b5cf6');
      el.color = null;
      expect(el.hasAttribute('color')).toBe(false);
    });

    it('reflects eyes (default open)', () => {
      const el = mount();
      expect(el.eyeState).toBe('open');
      el.eyeState = 'none';
      expect(el.getAttribute('eyes')).toBe('none');
      expect(el.eyeState).toBe('none');
      el.eyeState = 'dead';
      expect(el.eyeState).toBe('dead');
    });

    it('reflects active', () => {
      const el = mount();
      expect(el.active).toBe(false);
      el.active = true;
      expect(el.hasAttribute('active')).toBe(true);
      expect(pill(el).classList.contains('active')).toBe(true);
      el.active = false;
      expect(el.hasAttribute('active')).toBe(false);
    });

    it('reflects label into the shadow tree (escaped)', () => {
      const el = mount((e) => {
        e.label = 'researcher';
      });
      const labelEl = el.shadowRoot?.querySelector('.label') as HTMLElement;
      expect(labelEl.textContent).toBe('researcher');

      el.label = '<script>x</script>';
      expect(el.shadowRoot?.querySelector('.label script')).toBeNull();
      expect((el.shadowRoot?.querySelector('.label') as HTMLElement).textContent).toBe(
        '<script>x</script>'
      );
    });

    it('falls back to a <slot> when no label attribute is set', () => {
      const el = mount();
      expect(el.shadowRoot?.querySelector('.label slot')).toBeTruthy();
    });

    it('reflects theme (only light|dark accepted)', () => {
      const el = mount();
      expect(el.theme).toBeNull();
      el.theme = 'dark';
      expect(el.getAttribute('theme')).toBe('dark');
      expect(el.theme).toBe('dark');
      el.theme = 'light';
      expect(el.theme).toBe('light');
      el.theme = null;
      expect(el.hasAttribute('theme')).toBe(false);
    });
  });

  describe('glyph swap by type', () => {
    it('cone draws a glyph with the cone viewBox', () => {
      const el = mount((e) => {
        e.type = 'cone';
      });
      const glyph = el.shadowRoot?.querySelector('.glyph') as SVGElement;
      expect(glyph.getAttribute('viewBox')).toBe('70 330 440 570');
    });

    it('scoop draws a glyph with the scoop viewBox', () => {
      const el = mount((e) => {
        e.type = 'scoop';
      });
      const glyph = el.shadowRoot?.querySelector('.glyph') as SVGElement;
      expect(glyph.getAttribute('viewBox')).toBe('0 0 580 470');
    });

    it('derives the glyph fill from the color attribute', () => {
      const el = mount((e) => {
        e.type = 'scoop';
        e.color = '#ff0000';
      });
      const path = el.shadowRoot?.querySelector('.glyph path') as SVGPathElement;
      expect(path.getAttribute('fill')).toBe('#ff0000');
    });
  });

  describe('eye modes', () => {
    it('open renders live pupils (cursor-tracking on the cone)', () => {
      const el = mount();
      expect(el.shadowRoot?.querySelector('.pupil-l')).toBeTruthy();
      expect(el.shadowRoot?.querySelector('.pupil-r')).toBeTruthy();
      expect(el.shadowRoot?.querySelectorAll('line')).toHaveLength(0);
    });

    it('dead renders crossed eyes (no pupils)', () => {
      const el = mount((e) => {
        e.eyeState = 'dead';
      });
      expect(el.shadowRoot?.querySelector('.pupil-l')).toBeNull();
      // Two X glyphs = four lines.
      expect(el.shadowRoot?.querySelectorAll('.eyes-svg line')).toHaveLength(4);
    });

    it('none renders no eyes svg at all', () => {
      const el = mount((e) => {
        e.eyeState = 'none';
      });
      expect(el.shadowRoot?.querySelector('.eyes-svg')).toBeNull();
      expect(el.shadowRoot?.querySelector('.pupil-l')).toBeNull();
    });
  });

  describe('pupil dilation', () => {
    it('grows the pupil radius as fill increases', () => {
      const flat = mount((e) => {
        e.setAttribute('fill', '0');
      });
      const full = mount((e) => {
        e.setAttribute('fill', '100');
      });
      const rFlat = Number.parseFloat(
        (flat.shadowRoot?.querySelector('.pupil-l circle') as SVGCircleElement).getAttribute('r') ??
          '0'
      );
      const rFull = Number.parseFloat(
        (full.shadowRoot?.querySelector('.pupil-l circle') as SVGCircleElement).getAttribute('r') ??
          '0'
      );
      expect(rFull).toBeGreaterThan(rFlat);
    });

    it('explicit pupil scale wins over fill and clamps to [0.3, 2.4]', () => {
      const el = mount((e) => {
        e.setAttribute('pupil', '99');
        e.setAttribute('fill', '0');
      });
      expect(el.pupilScale).toBe(2.4);
    });
  });

  describe('active fill', () => {
    it('paints the pill background with the accent when active', () => {
      const el = mount((e) => {
        e.color = '#168a35';
        e.active = true;
      });
      const cs = getComputedStyle(pill(el));
      // #168a35 → rgb(22, 138, 53).
      expect(cs.backgroundColor).toBe('rgb(22, 138, 53)');
    });

    it('is transparent when idle', () => {
      const el = mount((e) => {
        e.color = '#168a35';
      });
      const cs = getComputedStyle(pill(el));
      expect(cs.backgroundColor).toBe('rgba(0, 0, 0, 0)');
    });
  });

  describe('theme tokens', () => {
    it('dark theme yields a light label color', () => {
      const el = mount((e) => {
        e.label = 'x';
        e.theme = 'dark';
      });
      const label = el.shadowRoot?.querySelector('.label') as HTMLElement;
      // --label: #eef1f6 → rgb(238, 241, 246).
      expect(getComputedStyle(label).color).toBe('rgb(238, 241, 246)');
    });

    it('light theme yields a dark label color', () => {
      const el = mount((e) => {
        e.label = 'x';
        e.theme = 'light';
      });
      const label = el.shadowRoot?.querySelector('.label') as HTMLElement;
      // --label: #1b2030 → rgb(27, 32, 48).
      expect(getComputedStyle(label).color).toBe('rgb(27, 32, 48)');
    });
  });

  describe('cursor-tracking listener lifecycle', () => {
    // Only the cone tracks the cursor; scoop chips render open eyes statically.
    it('moves both pupils toward the cursor on mousemove (cone only)', () => {
      const el = mount((e) => {
        e.type = 'cone';
        e.label = 'x';
      });
      const svg = el.shadowRoot?.querySelector('.eyes-svg') as SVGElement;
      const r = svg.getBoundingClientRect();
      document.dispatchEvent(
        new MouseEvent('mousemove', {
          clientX: r.left + r.width + 500,
          clientY: r.top + r.height + 500,
        })
      );
      const left = el.shadowRoot?.querySelector('.pupil-l') as SVGGElement;
      const right = el.shadowRoot?.querySelector('.pupil-r') as SVGGElement;
      expect(left.getAttribute('transform')).toMatch(/^translate\(/);
      expect(right.getAttribute('transform')).toMatch(/^translate\(/);
    });

    it('does not track the cursor for a scoop chip (only the cone tracks)', () => {
      const el = mount((e) => {
        e.type = 'scoop';
        e.label = 'researcher';
      });
      // Sanity: an open scoop chip still renders live pupils, just static ones.
      const left = el.shadowRoot?.querySelector('.pupil-l') as SVGGElement;
      expect(left).toBeTruthy();
      document.dispatchEvent(new MouseEvent('mousemove', { clientX: 800, clientY: 800 }));
      // No listener was attached, so the pupil transform is never written.
      expect(left.getAttribute('transform')).toBeNull();
    });

    it('removes the document listener on disconnect', () => {
      const el = mount((e) => {
        e.type = 'cone';
      });
      const left = el.shadowRoot?.querySelector('.pupil-l') as SVGGElement;
      el.remove();
      document.dispatchEvent(new MouseEvent('mousemove', { clientX: 999, clientY: 999 }));
      // Detached node should not receive a transform update.
      expect(left.getAttribute('transform')).toBeNull();
    });

    it('drops the listener when eyes switch away from open', () => {
      const el = mount((e) => {
        e.type = 'cone';
      });
      const left = el.shadowRoot?.querySelector('.pupil-l') as SVGGElement;
      // Sanity: tracking works while open.
      document.dispatchEvent(new MouseEvent('mousemove', { clientX: 800, clientY: 800 }));
      expect(left.getAttribute('transform')).toMatch(/^translate\(/);
      // Switch to none — the open pupil node is gone and tracking is detached.
      el.eyeState = 'none';
      expect(el.shadowRoot?.querySelector('.pupil-l')).toBeNull();
      // A subsequent mousemove must not throw or resurrect tracking.
      expect(() =>
        document.dispatchEvent(new MouseEvent('mousemove', { clientX: 10, clientY: 10 }))
      ).not.toThrow();
    });

    it('re-attaches the listener when eyes switch back to open', () => {
      const el = mount((e) => {
        e.type = 'cone';
        e.eyeState = 'none';
      });
      el.eyeState = 'open';
      const left = el.shadowRoot?.querySelector('.pupil-l') as SVGGElement;
      document.dispatchEvent(new MouseEvent('mousemove', { clientX: 700, clientY: 700 }));
      expect(left.getAttribute('transform')).toMatch(/^translate\(/);
    });

    it('does not attach a tracking listener for non-open eyes', () => {
      const el = mount((e) => {
        e.eyeState = 'dead';
      });
      // No pupil to move; mousemove is inert and must not throw.
      expect(() =>
        document.dispatchEvent(new MouseEvent('mousemove', { clientX: 5, clientY: 5 }))
      ).not.toThrow();
      expect(el.shadowRoot?.querySelector('.pupil-l')).toBeNull();
    });
  });

  describe('compact (icon-only + hover title)', () => {
    it('reflects the compact property to the attribute and back', () => {
      const el = mount((e) => {
        e.label = 'researcher';
      });
      expect(el.compact).toBe(false);
      el.compact = true;
      expect(el.hasAttribute('compact')).toBe(true);
      el.compact = false;
      expect(el.hasAttribute('compact')).toBe(false);
    });

    it('hides the label and shows a hover .tip carrying it when compact', () => {
      const el = mount((e) => {
        e.label = 'researcher';
        e.setAttribute('compact', '');
      });
      const label = el.shadowRoot?.querySelector('.label') as HTMLElement;
      expect(getComputedStyle(label).display).toBe('none');
      const tip = el.shadowRoot?.querySelector('.tip') as HTMLElement;
      expect(tip).not.toBeNull();
      expect(tip.textContent).toBe('researcher');
      // The tip is present (display:block) in compact mode, faded out until hover.
      expect(getComputedStyle(tip).display).toBe('block');
      expect(getComputedStyle(tip).opacity).toBe('0');
    });

    it('keeps the full label (and no visible tip) when not compact', () => {
      const el = mount((e) => {
        e.label = 'researcher';
      });
      const label = el.shadowRoot?.querySelector('.label') as HTMLElement;
      expect(getComputedStyle(label).display).not.toBe('none');
      const tip = el.shadowRoot?.querySelector('.tip') as HTMLElement;
      expect(getComputedStyle(tip).display).toBe('none');
    });

    it('names the button for a11y even when the label is hidden', () => {
      const el = mount((e) => {
        e.label = 'researcher';
        e.setAttribute('compact', '');
      });
      expect(el.shadowRoot?.querySelector('.pill')?.getAttribute('aria-label')).toBe('researcher');
    });
  });
});
