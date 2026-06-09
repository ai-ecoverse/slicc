import { beforeEach, describe, expect, it } from 'vitest';
import { SliccGooglyEyes } from '../../src/primitives/slicc-googly-eyes.js';
import { ensureGlobalTokens } from '../../src/theme/tokens.js';

function mount(setup?: (el: SliccGooglyEyes) => void): SliccGooglyEyes {
  const el = document.createElement('slicc-googly-eyes') as SliccGooglyEyes;
  setup?.(el);
  document.body.appendChild(el);
  return el;
}

function eyes(el: SliccGooglyEyes): HTMLElement[] {
  return Array.from(el.shadowRoot?.querySelectorAll<HTMLElement>('.eye') ?? []);
}

describe('slicc-googly-eyes', () => {
  beforeEach(() => {
    ensureGlobalTokens();
    document.body.replaceChildren();
  });

  it('registers the custom element', () => {
    expect(customElements.get('slicc-googly-eyes')).toBe(SliccGooglyEyes);
  });

  it('renders two eyes inside the shadow root', () => {
    const el = mount();
    expect(el.shadowRoot).toBeTruthy();
    expect(eyes(el)).toHaveLength(2);
    expect(el.shadowRoot?.querySelector('.eyes')).toBeTruthy();
  });

  it('exposes ::part hooks on the container and each eye', () => {
    const el = mount();
    expect(el.shadowRoot?.querySelector('[part="eyes"]')).toBeTruthy();
    const eyeParts = Array.from(el.shadowRoot?.querySelectorAll('[part~="eye"]') ?? []);
    expect(eyeParts).toHaveLength(2);
    expect(el.shadowRoot?.querySelector('[part~="eye-left"]')).toBeTruthy();
    expect(el.shadowRoot?.querySelector('[part~="eye-right"]')).toBeTruthy();
  });

  describe('attribute ↔ property reflection', () => {
    it('reflects inverted', () => {
      const el = mount();
      expect(el.inverted).toBe(false);
      el.inverted = true;
      expect(el.hasAttribute('inverted')).toBe(true);
      el.inverted = false;
      expect(el.hasAttribute('inverted')).toBe(false);
    });

    it('reflects tracking (default on)', () => {
      const el = mount();
      expect(el.tracking).toBe(true);
      el.tracking = false;
      expect(el.getAttribute('tracking')).toBe('off');
      expect(el.tracking).toBe(false);
      el.tracking = true;
      expect(el.tracking).toBe(true);
    });

    it('reflects eyes', () => {
      const el = mount();
      expect(el.eyes).toBe('open');
      el.eyes = 'dead';
      expect(el.getAttribute('eyes')).toBe('dead');
      expect(el.eyes).toBe('dead');
    });

    it('reflects size with a 9px fallback', () => {
      const el = mount();
      expect(el.size).toBe(9);
      el.size = 32;
      expect(el.getAttribute('size')).toBe('32');
      expect(el.size).toBe(32);
      el.setAttribute('size', 'bogus');
      expect(el.size).toBe(9);
    });
  });

  describe('variants and states', () => {
    it('default: white sclera, black pupil, ~1.3px black border', () => {
      const el = mount();
      const [eye] = eyes(el);
      const cs = getComputedStyle(eye);
      expect(cs.backgroundColor).toBe('rgb(255, 255, 255)');
      expect(cs.borderColor).toBe('rgb(0, 0, 0)');
      // Declared 1.3px (prototype). getComputedStyle reports the device-pixel
      // rounded value, so assert a thin, non-zero border rather than the exact
      // sub-pixel width.
      const border = Number.parseFloat(cs.borderTopWidth);
      expect(border).toBeGreaterThan(0);
      expect(border).toBeLessThanOrEqual(2);
      // The declared (un-rounded) value lives on the inline custom property.
      const container = el.shadowRoot?.querySelector('.eyes') as HTMLElement;
      expect(container.style.getPropertyValue('--_border')).toBe('1.3px');
      const pupil = getComputedStyle(eye, '::after');
      expect(pupil.backgroundColor).toBe('rgb(0, 0, 0)');
      // 9px circle.
      expect(Number.parseFloat(cs.width)).toBeCloseTo(9, 1);
    });

    it('inverted: white border + white pupil', () => {
      const el = mount((e) => {
        e.inverted = true;
      });
      const [eye] = eyes(el);
      const cs = getComputedStyle(eye);
      expect(cs.borderColor).toBe('rgb(255, 255, 255)');
      const pupil = getComputedStyle(eye, '::after');
      expect(pupil.backgroundColor).toBe('rgb(255, 255, 255)');
    });

    it('dead: renders an X glyph per eye and hides the pupil', () => {
      const el = mount((e) => {
        e.eyes = 'dead';
      });
      const glyphs = el.shadowRoot?.querySelectorAll('.x');
      expect(glyphs).toHaveLength(2);
      expect(glyphs?.[0].textContent).toBe('×');
      const [eye] = eyes(el);
      expect(getComputedStyle(eye, '::after').display).toBe('none');
    });

    it('size scales the eye diameter and border', () => {
      const el = mount((e) => {
        e.size = 36;
      });
      const [eye] = eyes(el);
      const cs = getComputedStyle(eye);
      expect(Number.parseFloat(cs.width)).toBeCloseTo(36, 0);
      // Border scales proportionally: 1.3 / 9 * 36 = 5.2px (declared on --_border;
      // computed width is device-pixel rounded so allow a half-pixel tolerance).
      const container = el.shadowRoot?.querySelector('.eyes') as HTMLElement;
      expect(container.style.getPropertyValue('--_border')).toBe('5.2px');
      expect(Number.parseFloat(cs.borderTopWidth)).toBeCloseTo(5.2, 0);
    });

    it('container is a flex row with a 3px gap', () => {
      const el = mount();
      const container = el.shadowRoot?.querySelector('.eyes') as HTMLElement;
      const cs = getComputedStyle(container);
      // Declared inline-flex; Chromium blockifies it to `flex` because the
      // container is itself a flex item of :host. Either spelling is fine.
      expect(cs.display).toMatch(/^(inline-)?flex$/);
      expect(cs.columnGap).toBe('3px');
    });
  });

  describe('tracking behavior', () => {
    it('updates --px/--py on mousemove toward the cursor', () => {
      const el = mount();
      const [eye] = eyes(el);
      const r = eye.getBoundingClientRect();
      // Cursor far to the lower-right of the eye centre → +px, +py.
      document.dispatchEvent(
        new MouseEvent('mousemove', {
          clientX: r.left + r.width / 2 + 500,
          clientY: r.top + r.height / 2 + 500,
        })
      );
      const px = Number.parseFloat(eye.style.getPropertyValue('--px'));
      const py = Number.parseFloat(eye.style.getPropertyValue('--py'));
      expect(px).toBeGreaterThan(0);
      expect(py).toBeGreaterThan(0);
      // Clamped: cos(45°)*3 ≈ 2.12 is the max per axis at this diagonal.
      expect(px).toBeLessThanOrEqual(3);
      expect(py).toBeLessThanOrEqual(3);
    });

    it('points the pupil left for a cursor to the left', () => {
      const el = mount();
      const [eye] = eyes(el);
      const r = eye.getBoundingClientRect();
      document.dispatchEvent(
        new MouseEvent('mousemove', {
          clientX: r.left + r.width / 2 - 500,
          clientY: r.top + r.height / 2,
        })
      );
      expect(Number.parseFloat(eye.style.getPropertyValue('--px'))).toBeLessThan(0);
    });

    it('idle (tracking off) keeps pupils centred on mousemove', () => {
      const el = mount((e) => {
        e.tracking = false;
      });
      const [eye] = eyes(el);
      document.dispatchEvent(new MouseEvent('mousemove', { clientX: 999, clientY: 999 }));
      expect(eye.style.getPropertyValue('--px')).toBe('0px');
      expect(eye.style.getPropertyValue('--py')).toBe('0px');
    });

    it('dead eyes do not track', () => {
      const el = mount((e) => {
        e.eyes = 'dead';
      });
      const [eye] = eyes(el);
      document.dispatchEvent(new MouseEvent('mousemove', { clientX: 999, clientY: 999 }));
      expect(eye.style.getPropertyValue('--px') || '0px').toBe('0px');
    });

    it('re-centres when tracking is turned off after tracking', () => {
      const el = mount();
      const [eye] = eyes(el);
      const r = eye.getBoundingClientRect();
      document.dispatchEvent(
        new MouseEvent('mousemove', { clientX: r.left + 500, clientY: r.top + 500 })
      );
      expect(eye.style.getPropertyValue('--px')).not.toBe('0px');
      el.tracking = false;
      expect(eye.style.getPropertyValue('--px')).toBe('0px');
      expect(eye.style.getPropertyValue('--py')).toBe('0px');
    });

    it('removes the document listener on disconnect', () => {
      const el = mount();
      el.remove();
      const [eye] = eyes(el);
      document.dispatchEvent(new MouseEvent('mousemove', { clientX: 999, clientY: 999 }));
      // Detached node should not receive further updates.
      expect(eye.style.getPropertyValue('--px') || '0px').toBe('0px');
    });
  });

  it('renders default-slot content between the eyes', () => {
    const el = mount((e) => {
      const nose = document.createElement('span');
      nose.textContent = '.';
      e.appendChild(nose);
    });
    const slot = el.shadowRoot?.querySelector('slot') as HTMLSlotElement;
    expect(slot).toBeTruthy();
    expect(slot.assignedNodes().length).toBeGreaterThan(0);
  });
});
