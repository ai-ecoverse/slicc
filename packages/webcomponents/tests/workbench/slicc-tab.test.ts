import { beforeEach, describe, expect, it } from 'vitest';
import { ensureGlobalTokens } from '../../src/theme/tokens.js';
import { SliccTab } from '../../src/workbench/slicc-tab.js';

function mount(setup?: (el: SliccTab) => void): SliccTab {
  const el = document.createElement('slicc-tab') as SliccTab;
  setup?.(el);
  document.body.appendChild(el);
  return el;
}

/** The tab button inside the shadow root. */
function tab(el: SliccTab): HTMLElement {
  return el.shadowRoot?.querySelector('.tab') as HTMLElement;
}

describe('slicc-tab', () => {
  beforeEach(() => {
    ensureGlobalTokens();
    document.body.replaceChildren();
  });

  it('registers the custom element', () => {
    expect(customElements.get('slicc-tab')).toBe(SliccTab);
  });

  it('renders the tab button with ::part hooks in the shadow root', () => {
    const el = mount();
    expect(el.shadowRoot).toBeTruthy();
    expect(el.shadowRoot?.querySelector('[part="tab"]')).toBeTruthy();
    expect(tab(el).tagName).toBe('BUTTON');
  });

  describe('attribute ↔ property reflection', () => {
    it('reflects tab-id into data-t on the button', () => {
      const el = mount((e) => {
        e.tabId = 'hero';
      });
      expect(el.getAttribute('tab-id')).toBe('hero');
      expect(tab(el).getAttribute('data-t')).toBe('hero');
      el.tabId = null;
      expect(el.hasAttribute('tab-id')).toBe(false);
      expect(tab(el).hasAttribute('data-t')).toBe(false);
    });

    it('reflects kind (default tool)', () => {
      const el = mount();
      expect(el.kind).toBe('tool');
      expect(tab(el).classList.contains('sp')).toBe(false);
      el.kind = 'sprinkle';
      expect(el.getAttribute('kind')).toBe('sprinkle');
      expect(tab(el).classList.contains('sp')).toBe(true);
      // Anything non-sprinkle normalizes to tool.
      el.setAttribute('kind', 'bogus');
      expect(el.kind).toBe('tool');
    });

    it('reflects active into the .on class', () => {
      const el = mount();
      expect(el.active).toBe(false);
      expect(tab(el).classList.contains('on')).toBe(false);
      el.active = true;
      expect(el.hasAttribute('active')).toBe(true);
      expect(tab(el).classList.contains('on')).toBe(true);
      el.active = false;
      expect(el.hasAttribute('active')).toBe(false);
    });

    it('reflects closable into the close affordance', () => {
      const el = mount();
      expect(el.closable).toBe(false);
      expect(el.shadowRoot?.querySelector('.x')).toBeNull();
      el.closable = true;
      expect(el.shadowRoot?.querySelector('[part="close"]')).toBeTruthy();
      el.closable = false;
      expect(el.shadowRoot?.querySelector('.x')).toBeNull();
    });

    it('reflects badge and glyph getters/setters', () => {
      const el = mount();
      el.badge = '★';
      expect(el.getAttribute('badge')).toBe('★');
      el.badge = null;
      expect(el.hasAttribute('badge')).toBe(false);
      el.glyph = '>_';
      expect(el.getAttribute('glyph')).toBe('>_');
      el.glyph = null;
      expect(el.hasAttribute('glyph')).toBe(false);
    });

    it('renders the label (escaped) and falls back to a slot when absent', () => {
      const el = mount();
      expect(tab(el).querySelector('slot')).toBeTruthy();

      el.label = 'Hero studio';
      expect(tab(el).textContent).toContain('Hero studio');

      el.label = '<script>x</script>';
      expect(el.shadowRoot?.querySelector('.tab script')).toBeNull();
      expect(tab(el).textContent).toContain('<script>x</script>');
    });
  });

  describe('tool variant', () => {
    it('idle tool tab is a transparent ghost chip (no sp/on)', () => {
      const el = mount((e) => {
        e.label = 'Files';
      });
      const cs = getComputedStyle(tab(el));
      // transparent background + transparent border in the resting state.
      expect(cs.backgroundColor).toBe('rgba(0, 0, 0, 0)');
      expect(cs.color).toBe('rgb(115, 115, 115)'); // --txt-2 #737373
    });

    it('renders an optional .gl glyph with the --txt-3 color', () => {
      const el = mount((e) => {
        e.label = 'Terminal';
        e.glyph = '>_';
      });
      const gl = el.shadowRoot?.querySelector('.gl') as HTMLElement;
      expect(gl).toBeTruthy();
      expect(gl.getAttribute('part')).toBe('glyph');
      expect(gl.textContent).toBe('>_');
      // --txt-3 #a1a1a1
      expect(getComputedStyle(gl).color).toBe('rgb(161, 161, 161)');
    });

    it('active tool tab uses --ink text on the --ghost fill', () => {
      const el = mount((e) => {
        e.label = 'Files';
        e.active = true;
      });
      const cs = getComputedStyle(tab(el));
      expect(cs.color).toBe('rgb(10, 10, 10)'); // --ink #0a0a0a
      expect(cs.backgroundColor).toBe('rgb(236, 236, 239)'); // --ghost #ececef
    });

    it('does not render a sprinkle badge for tool tabs', () => {
      const el = mount((e) => {
        e.label = 'Files';
      });
      expect(el.shadowRoot?.querySelector('.sg')).toBeNull();
    });
  });

  describe('sprinkle variant', () => {
    it('idle sprinkle tab is a defined --canvas chip with --line border', () => {
      const el = mount((e) => {
        e.kind = 'sprinkle';
        e.label = 'Hero studio';
      });
      const cs = getComputedStyle(tab(el));
      expect(cs.backgroundColor).toBe('rgb(255, 255, 255)'); // --canvas #fff
      expect(cs.borderTopColor).toBe('rgb(229, 229, 229)'); // --line #e5e5e5
      expect(cs.color).toBe('rgb(10, 10, 10)'); // --ink
    });

    it('renders the rainbow .sg sparkle badge (default ✦) at 14x14', () => {
      const el = mount((e) => {
        e.kind = 'sprinkle';
        e.label = 'Hero studio';
      });
      const sg = el.shadowRoot?.querySelector('.sg') as HTMLElement;
      expect(sg).toBeTruthy();
      expect(sg.getAttribute('part')).toBe('badge');
      expect(sg.textContent).toBe('✦');
      const cs = getComputedStyle(sg);
      expect(cs.width).toBe('14px');
      expect(cs.height).toBe('14px');
    });

    it('honors a custom badge glyph', () => {
      const el = mount((e) => {
        e.kind = 'sprinkle';
        e.badge = '✸';
        e.label = 'palette';
      });
      expect((el.shadowRoot?.querySelector('.sg') as HTMLElement).textContent).toBe('✸');
    });

    it('active sprinkle tab tints the fill and border toward violet', () => {
      const el = mount((e) => {
        e.kind = 'sprinkle';
        e.label = 'Hero studio';
        e.active = true;
      });
      const cs = getComputedStyle(tab(el));
      // color-mix(violet 9%, canvas#fff) is a faint violet wash — not pure white,
      // and not the idle --line border.
      expect(cs.backgroundColor).not.toBe('rgb(255, 255, 255)');
      expect(cs.borderTopColor).not.toBe('rgb(229, 229, 229)');
      // The blue channel dominates a violet wash over white.
      const m = cs.backgroundColor.match(/\d+/g)?.map(Number) ?? [];
      expect(m[2]).toBeGreaterThanOrEqual(m[0]); // b >= r
    });
  });

  describe('close affordance', () => {
    it('renders a 15x15 .x with data-close when closable', () => {
      const el = mount((e) => {
        e.kind = 'sprinkle';
        e.label = 'Hero studio';
        e.closable = true;
      });
      const x = el.shadowRoot?.querySelector('.x') as HTMLElement;
      expect(x).toBeTruthy();
      expect(x.hasAttribute('data-close')).toBe(true);
      expect(x.getAttribute('part')).toBe('close');
      const cs = getComputedStyle(x);
      expect(cs.width).toBe('15px');
      expect(cs.height).toBe('15px');
    });
  });

  describe('events', () => {
    it('emits a composed, bubbling select with tabId on tab-body click', () => {
      const el = mount((e) => {
        e.tabId = 'hero';
        e.label = 'Hero studio';
      });
      let detail: { tabId: string | null } | null = null;
      let composed = false;
      let bubbles = false;
      el.addEventListener('select', (e) => {
        const ev = e as CustomEvent<{ tabId: string | null }>;
        detail = ev.detail;
        composed = ev.composed;
        bubbles = ev.bubbles;
      });
      tab(el).click();
      expect(detail).toEqual({ tabId: 'hero' });
      expect(composed).toBe(true);
      expect(bubbles).toBe(true);
    });

    it('emits close (not select) and stops propagation when the X is clicked', () => {
      const el = mount((e) => {
        e.tabId = 'palette';
        e.label = 'palette';
        e.kind = 'sprinkle';
        e.closable = true;
      });
      let selectFired = false;
      let closeDetail: { tabId: string | null } | null = null;
      el.addEventListener('select', () => {
        selectFired = true;
      });
      el.addEventListener('close', (e) => {
        closeDetail = (e as CustomEvent<{ tabId: string | null }>).detail;
      });

      // A parent listener must NOT see the click bubble past the stopped close event.
      let parentSawBubble = false;
      document.body.addEventListener('click', () => {
        parentSawBubble = true;
      });

      const x = el.shadowRoot?.querySelector('.x') as HTMLElement;
      x.click();

      expect(closeDetail).toEqual({ tabId: 'palette' });
      expect(selectFired).toBe(false);
      expect(parentSawBubble).toBe(false);
    });

    it('select bubbles to an ancestor (composes through the shadow boundary)', () => {
      const host = document.createElement('div');
      document.body.appendChild(host);
      const el = document.createElement('slicc-tab') as SliccTab;
      el.tabId = 'files';
      host.appendChild(el);

      let seen: string | null = null;
      host.addEventListener('select', (e) => {
        seen = (e as CustomEvent<{ tabId: string | null }>).detail.tabId;
      });
      tab(el).click();
      expect(seen).toBe('files');
    });
  });

  describe('lifecycle', () => {
    it('stops dispatching after disconnect', () => {
      const el = mount((e) => {
        e.tabId = 'files';
      });
      const button = tab(el);
      el.remove();
      let fired = false;
      el.addEventListener('select', () => {
        fired = true;
      });
      // The detached shadow click handler is removed; clicking the orphan button
      // must not dispatch a select.
      button.click();
      expect(fired).toBe(false);
    });
  });
});
