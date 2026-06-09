import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SliccMemtag } from '../../src/memory/slicc-memtag.js';
import { ensureGlobalTokens } from '../../src/theme/tokens.js';

function mount(setup?: (el: SliccMemtag) => void): SliccMemtag {
  const el = document.createElement('slicc-memtag') as SliccMemtag;
  setup?.(el);
  document.body.appendChild(el);
  return el;
}

/** The inner `.mtag` pill in the shadow root. */
function tag(el: SliccMemtag): HTMLElement {
  return el.shadowRoot?.querySelector('.mtag') as HTMLElement;
}

describe('slicc-memtag', () => {
  beforeEach(() => {
    ensureGlobalTokens();
    document.body.replaceChildren();
  });

  afterEach(() => {
    // Reset the theme scope between dark-mode assertions.
    document.documentElement.removeAttribute('data-theme');
    document.body.classList.remove('dark');
  });

  it('registers the custom element', () => {
    expect(customElements.get('slicc-memtag')).toBe(SliccMemtag);
  });

  it('renders a shadow root with the ::part tag hook', () => {
    const el = mount();
    expect(el.shadowRoot).toBeTruthy();
    expect(el.shadowRoot?.querySelector('[part="tag"]')).toBeTruthy();
    expect(tag(el).classList.contains('mtag')).toBe(true);
  });

  describe('attribute ↔ property reflection', () => {
    it('defaults to the user type', () => {
      const el = mount();
      expect(el.type).toBe('user');
    });

    it('reflects type and normalizes unknown values to user', () => {
      const el = mount();
      el.type = 'project';
      expect(el.getAttribute('type')).toBe('project');
      expect(el.type).toBe('project');
      el.setAttribute('type', 'bogus');
      expect(el.type).toBe('user');
    });

    it('reflects label and clears it on null', () => {
      const el = mount((e) => {
        e.label = 'review';
      });
      expect(el.getAttribute('label')).toBe('review');
      expect(el.label).toBe('review');
      el.label = null;
      expect(el.hasAttribute('label')).toBe(false);
    });
  });

  describe('per-type default label', () => {
    it('user → "user"', () => {
      const el = mount((e) => {
        e.type = 'user';
      });
      expect(tag(el).textContent).toBe('user');
    });

    it('feedback → "feedback"', () => {
      const el = mount((e) => {
        e.type = 'feedback';
      });
      expect(tag(el).textContent).toBe('feedback');
    });

    it('project → "project"', () => {
      const el = mount((e) => {
        e.type = 'project';
      });
      expect(tag(el).textContent).toBe('project');
    });

    it('falls back to a default <slot> when no label attribute is set', () => {
      const el = mount();
      expect(el.shadowRoot?.querySelector('.mtag slot')).toBeTruthy();
    });
  });

  describe('label override (escaped)', () => {
    it('overrides the per-type label with the label attribute', () => {
      const el = mount((e) => {
        e.type = 'project';
        e.label = 'design';
      });
      expect(tag(el).textContent).toBe('design');
      // The attribute label replaces the slot.
      expect(el.shadowRoot?.querySelector('.mtag slot')).toBeNull();
    });

    it('escapes interpolated label text (no markup injection)', () => {
      const el = mount((e) => {
        e.label = '<script>x</script>';
      });
      expect(el.shadowRoot?.querySelector('.mtag script')).toBeNull();
      expect(tag(el).textContent).toBe('<script>x</script>');
    });
  });

  describe('hue variants (real Chromium getComputedStyle)', () => {
    // Resolved prototype tokens: --rose #f43f5e, --cyan #06b6d4, --violet #8b5cf6.
    const CASES: Array<[SliccMemtag['type'], string]> = [
      ['user', 'rgb(244, 63, 94)'],
      ['feedback', 'rgb(6, 182, 212)'],
      ['project', 'rgb(139, 92, 246)'],
    ];

    for (const [type, color] of CASES) {
      it(`${type} text color is the matching hue`, () => {
        const el = mount((e) => {
          e.type = type;
        });
        expect(getComputedStyle(tag(el)).color).toBe(color);
      });
    }

    it('user tint fills with a rose-over-canvas mix (not transparent)', () => {
      const el = mount((e) => {
        e.type = 'user';
      });
      const bg = getComputedStyle(tag(el)).backgroundColor;
      // 12% rose over white #fff → a pale pink, opaque. Chromium serializes the
      // color-mix as color(srgb …) rather than rgb(…).
      expect(bg).not.toBe('rgba(0, 0, 0, 0)');
      expect(bg).toMatch(/^(rgb|color)\(/);
    });

    it('renders the prototype pill geometry (radius 26px, 10px font)', () => {
      const el = mount();
      const cs = getComputedStyle(tag(el));
      expect(cs.borderTopLeftRadius).toBe('26px');
      expect(cs.fontSize).toBe('10px');
    });
  });

  describe('dark-mode deepening (mix over var(--canvas))', () => {
    it('deepens the user fill toward canvas under a [data-theme=dark] scope', () => {
      const light = mount((e) => {
        e.type = 'user';
      });
      const lightBg = getComputedStyle(tag(light)).backgroundColor;

      document.documentElement.setAttribute('data-theme', 'dark');
      const dark = mount((e) => {
        e.type = 'user';
      });
      const darkBg = getComputedStyle(tag(dark)).backgroundColor;

      // The dark fill mixes 22% rose over the dark canvas (#161618), so it must
      // differ from the light 12%-over-#fff fill.
      expect(darkBg).not.toBe(lightBg);
      expect(darkBg).toMatch(/^(rgb|color)\(/);
    });

    it('keeps the hue text color in dark mode', () => {
      document.body.classList.add('dark');
      const el = mount((e) => {
        e.type = 'project';
      });
      // Violet text is unchanged by the dark deepening.
      expect(getComputedStyle(tag(el)).color).toBe('rgb(139, 92, 246)');
    });
  });

  describe('presentational (no events)', () => {
    it('does not emit a select/click custom event when clicked', () => {
      const el = mount();
      let fired = false;
      el.addEventListener('select', () => {
        fired = true;
      });
      tag(el).click();
      expect(fired).toBe(false);
    });
  });
});
