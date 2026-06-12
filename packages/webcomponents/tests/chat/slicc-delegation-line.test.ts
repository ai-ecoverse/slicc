import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SliccDelegationLine } from '../../src/chat/slicc-delegation-line.js';
import { ensureGlobalTokens } from '../../src/theme/tokens.js';

function mount(setup?: (el: SliccDelegationLine) => void): SliccDelegationLine {
  const el = document.createElement('slicc-delegation-line') as SliccDelegationLine;
  setup?.(el);
  document.body.appendChild(el);
  return el;
}

/** The leading glyph span inside the shadow root. */
function arrow(el: SliccDelegationLine): HTMLElement {
  return el.shadowRoot?.querySelector('[part="arrow"]') as HTMLElement;
}

describe('slicc-delegation-line', () => {
  beforeEach(() => {
    ensureGlobalTokens();
    document.body.replaceChildren();
    document.body.classList.remove('dark');
    document.body.removeAttribute('data-theme');
  });

  afterEach(() => {
    document.body.classList.remove('dark');
    document.body.removeAttribute('data-theme');
  });

  it('registers the custom element', () => {
    expect(customElements.get('slicc-delegation-line')).toBe(SliccDelegationLine);
  });

  it('renders the line structure with ::part hooks in the shadow root', () => {
    const el = mount((e) => {
      e.scoop = 'researcher';
    });
    expect(el.shadowRoot).toBeTruthy();
    expect(el.shadowRoot?.querySelector('[part="arrow"]')).toBeTruthy();
    expect(el.shadowRoot?.querySelector('[part="label"]')).toBeTruthy();
    expect(el.shadowRoot?.querySelector('[part="scoop"]')).toBeTruthy();
  });

  describe('attribute ↔ property reflection', () => {
    it('reflects kind (default feed)', () => {
      const el = mount();
      expect(el.kind).toBe('feed');
      el.kind = 'sprinkle';
      expect(el.getAttribute('kind')).toBe('sprinkle');
      expect(el.kind).toBe('sprinkle');
      // Anything non-sprinkle normalizes to feed.
      el.setAttribute('kind', 'bogus');
      expect(el.kind).toBe('feed');
    });

    it('reflects hue into the inherited --c custom property', () => {
      const el = mount((e) => {
        e.hue = '#06b6d4';
      });
      expect(el.getAttribute('hue')).toBe('#06b6d4');
      expect(el.style.getPropertyValue('--c')).toBe('#06b6d4');
      el.hue = null;
      expect(el.hasAttribute('hue')).toBe(false);
      expect(el.style.getPropertyValue('--c')).toBe('');
    });

    it('reflects verb / scoop / label / args', () => {
      const el = mount();
      el.verb = 'feed_scoop';
      el.scoop = 'designer';
      el.label = 'warm hero';
      el.args = 'hero.tsx';
      expect(el.getAttribute('verb')).toBe('feed_scoop');
      expect(el.getAttribute('scoop')).toBe('designer');
      expect(el.getAttribute('label')).toBe('warm hero');
      expect(el.getAttribute('args')).toBe('hero.tsx');
      el.verb = null;
      el.scoop = null;
      el.label = null;
      el.args = null;
      expect(el.hasAttribute('verb')).toBe(false);
      expect(el.hasAttribute('scoop')).toBe(false);
      expect(el.hasAttribute('label')).toBe(false);
      expect(el.hasAttribute('args')).toBe(false);
    });

    it('reflects source', () => {
      const el = mount();
      expect(el.source).toBe(false);
      el.source = true;
      expect(el.hasAttribute('source')).toBe(true);
      el.source = false;
      expect(el.hasAttribute('source')).toBe(false);
    });

    it('escapes interpolated text (no injection)', () => {
      const el = mount((e) => {
        e.scoop = '<img src=x onerror=alert(1)>';
      });
      expect(el.shadowRoot?.querySelector('[part="scoop"] img')).toBeNull();
      expect((el.shadowRoot?.querySelector('[part="scoop"]') as HTMLElement).textContent).toBe(
        '<img src=x onerror=alert(1)>'
      );
    });
  });

  describe('kind glyph + human-readable verb', () => {
    it('feed renders an arrow icon and the human-readable "Delegated to" verb', () => {
      const el = mount((e) => {
        e.kind = 'feed';
        e.scoop = 'researcher';
      });
      // The leading darrow is now a lucide <svg> (arrow-right), never a glyph char.
      expect(arrow(el).querySelector('svg')).not.toBeNull();
      expect(arrow(el).textContent?.trim()).toBe('');
      // The developer-coded "feed_scoop" is never shown — a friendly phrase is.
      expect(el.shadowRoot?.querySelector('.verb')?.textContent).toBe('Delegated to');
    });

    it('scoop renders the "Spun up" verb', () => {
      const el = mount((e) => {
        e.kind = 'scoop';
        e.scoop = 'researcher';
      });
      expect(el.shadowRoot?.querySelector('.verb')?.textContent).toBe('Spun up');
      expect(arrow(el).querySelector('svg')).not.toBeNull();
    });

    it('drop renders the "Wrapped up" verb', () => {
      const el = mount((e) => {
        e.kind = 'drop';
        e.scoop = 'tester';
      });
      expect(el.shadowRoot?.querySelector('.verb')?.textContent).toBe('Wrapped up');
      expect(arrow(el).querySelector('svg')).not.toBeNull();
    });

    it('maps a raw internal action name passed via verb to its friendly label', () => {
      const el = mount((e) => {
        e.verb = 'feed_scoop';
        e.scoop = 'designer';
      });
      // The attribute keeps the raw value, but the rendered text is humanized.
      expect(el.getAttribute('verb')).toBe('feed_scoop');
      expect(el.shadowRoot?.querySelector('.verb')?.textContent).toBe('Delegated to');
    });

    it('maps scoop_scoop / drop_scoop verbs to friendly labels', () => {
      const scoop = mount((e) => {
        e.verb = 'scoop_scoop';
        e.scoop = 'x';
      });
      expect(scoop.shadowRoot?.querySelector('.verb')?.textContent).toBe('Spun up');
      const drop = mount((e) => {
        e.verb = 'drop_scoop';
        e.scoop = 'x';
      });
      expect(drop.shadowRoot?.querySelector('.verb')?.textContent).toBe('Wrapped up');
    });

    it('sprinkle renders a sparkles icon and no default verb', () => {
      const el = mount((e) => {
        e.kind = 'sprinkle';
        e.scoop = 'designer';
        e.label = 'opened Hero studio';
      });
      expect(arrow(el).querySelector('svg')).not.toBeNull();
      expect(arrow(el).textContent?.trim()).toBe('');
      expect(el.shadowRoot?.querySelector('.verb')).toBeNull();
    });

    it('lets an explicit free-text verb pass through unchanged', () => {
      const el = mount((e) => {
        e.kind = 'sprinkle';
        e.verb = 'spawned';
        e.scoop = 'x';
      });
      expect(el.shadowRoot?.querySelector('.verb')?.textContent).toBe('spawned');
    });
  });

  describe('scoop name + hue', () => {
    it('renders the bold scoop name colored by the hue', () => {
      const el = mount((e) => {
        e.hue = '#8b5cf6';
        e.scoop = 'designer';
      });
      const b = el.shadowRoot?.querySelector('[part="scoop"]') as HTMLElement;
      expect(b.textContent).toBe('designer');
      // #8b5cf6 → rgb(139, 92, 246).
      expect(getComputedStyle(b).color).toBe('rgb(139, 92, 246)');
      expect(getComputedStyle(b).fontWeight).toBe('600');
    });

    it('omits the scoop node when no scoop is set', () => {
      const el = mount();
      expect(el.shadowRoot?.querySelector('[part="scoop"]')).toBeNull();
    });
  });

  describe('args chips', () => {
    it('splits comma-separated args into <code> chips (escaped)', () => {
      const el = mount((e) => {
        e.scoop = 'researcher';
        e.args = 'hero.tsx, tokens.css';
      });
      const chips = el.shadowRoot?.querySelectorAll('[part="code"]') as NodeListOf<HTMLElement>;
      expect(chips).toHaveLength(2);
      expect(chips[0].textContent).toBe('hero.tsx');
      expect(chips[1].textContent).toBe('tokens.css');
    });

    it('renders no chips when args is absent', () => {
      const el = mount((e) => {
        e.scoop = 'researcher';
      });
      expect(el.shadowRoot?.querySelectorAll('[part="code"]')).toHaveLength(0);
    });

    it('styles code chips with the mono font and ghost background', () => {
      const el = mount((e) => {
        e.scoop = 'r';
        e.args = 'hero.tsx';
      });
      const code = el.shadowRoot?.querySelector('[part="code"]') as HTMLElement;
      const cs = getComputedStyle(code);
      expect(cs.fontFamily).toContain('Mono');
      // --ghost light = #ececef → rgb(236, 236, 239).
      expect(cs.backgroundColor).toBe('rgb(236, 236, 239)');
    });
  });

  describe('source highlight (light)', () => {
    it('is transparent when idle', () => {
      const el = mount((e) => {
        e.hue = '#06b6d4';
        e.scoop = 'researcher';
      });
      const cs = getComputedStyle(el);
      expect(cs.backgroundColor).toBe('rgba(0, 0, 0, 0)');
    });

    it('paints a hue-tinted background + border when source is set', () => {
      const el = mount((e) => {
        e.hue = '#06b6d4';
        e.scoop = 'researcher';
        e.source = true;
      });
      const cs = getComputedStyle(el);
      // color-mix(#06b6d4 8%, #fff) is a light cyan tint — not transparent, not pure white.
      expect(cs.backgroundColor).not.toBe('rgba(0, 0, 0, 0)');
      expect(cs.backgroundColor).not.toBe('rgb(255, 255, 255)');
      // The border picks up the hue too (28% mix), so it differs from the idle transparent border.
      expect(cs.borderTopWidth).toBe('1px');
      expect(cs.borderTopColor).not.toBe('rgba(0, 0, 0, 0)');
    });
  });

  describe('source highlight (dark)', () => {
    it('re-bases the tint over --canvas under body.dark', () => {
      const light = mount((e) => {
        e.hue = '#06b6d4';
        e.scoop = 'researcher';
        e.source = true;
      });
      const lightBg = getComputedStyle(light).backgroundColor;

      document.body.classList.add('dark');
      const dark = mount((e) => {
        e.hue = '#06b6d4';
        e.scoop = 'researcher';
        e.source = true;
      });
      const darkBg = getComputedStyle(dark).backgroundColor;

      // Dark canvas (#161618) base + 16% hue is a near-black tint, distinct from
      // the light (#fff base, 8% hue) tint.
      expect(darkBg).not.toBe(lightBg);
      expect(darkBg).not.toBe('rgba(0, 0, 0, 0)');
    });
  });

  describe('layout', () => {
    it('is a wrapping flex row', () => {
      const el = mount((e) => {
        e.scoop = 'researcher';
      });
      const cs = getComputedStyle(el);
      expect(cs.display).toBe('flex');
      expect(cs.flexWrap).toBe('wrap');
    });

    it('greys the leading arrow with --txt-3', () => {
      const el = mount((e) => {
        e.scoop = 'researcher';
      });
      // --txt-3 light = #a1a1a1 → rgb(161, 161, 161).
      expect(getComputedStyle(arrow(el)).color).toBe('rgb(161, 161, 161)');
    });
  });

  describe('slot overrides', () => {
    it('exposes named slots for arrow, label, and args', () => {
      const el = mount((e) => {
        e.scoop = 'researcher';
      });
      expect(el.shadowRoot?.querySelector('slot[name="arrow"]')).toBeTruthy();
      expect(el.shadowRoot?.querySelector('slot[name="label"]')).toBeTruthy();
      expect(el.shadowRoot?.querySelector('slot[name="args"]')).toBeTruthy();
    });
  });
});
