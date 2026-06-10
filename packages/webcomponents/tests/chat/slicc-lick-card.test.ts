import { beforeEach, describe, expect, it } from 'vitest';
import { SliccLickCard } from '../../src/chat/slicc-lick-card.js';
import { iconEl } from '../../src/internal/icons.js';
import { ensureGlobalTokens } from '../../src/theme/tokens.js';

function mount(setup?: (el: SliccLickCard) => void): SliccLickCard {
  const el = document.createElement('slicc-lick-card') as SliccLickCard;
  setup?.(el);
  document.body.appendChild(el);
  return el;
}

/** Inner shape markup of a lucide icon at the header's 14px size, for comparison. */
function iconShape(name: string): string {
  return iconEl(name, { size: 14 }).innerHTML;
}

/** The outer `.lick` card inside the shadow root. */
function card(el: SliccLickCard): HTMLElement {
  return el.shadowRoot?.querySelector('.lick') as HTMLElement;
}

/** The `.lh` header row inside the shadow root. */
function header(el: SliccLickCard): HTMLElement {
  return el.shadowRoot?.querySelector('.lh') as HTMLElement;
}

describe('slicc-lick-card', () => {
  beforeEach(() => {
    ensureGlobalTokens();
    document.body.replaceChildren();
  });

  it('registers the custom element', () => {
    expect(customElements.get('slicc-lick-card')).toBe(SliccLickCard);
  });

  it('renders the prototype structure with ::part hooks', () => {
    const el = mount((e) => {
      e.kind = 'webhook';
    });
    const root = el.shadowRoot;
    expect(root).toBeTruthy();
    expect(root?.querySelector('[part="card"]')).toBeTruthy();
    expect(root?.querySelector('[part="header"]')).toBeTruthy();
    expect(root?.querySelector('[part="bell"]')).toBeTruthy();
    expect(root?.querySelector('[part="kind"]')).toBeTruthy();
    expect(root?.querySelector('[part="event"]')).toBeTruthy();
    expect(root?.querySelector('[part="body"]')).toBeTruthy();
    // The prototype class names survive the lift.
    expect(root?.querySelector('.lick .lh .bell')).toBeTruthy();
    expect(root?.querySelector('.lick .lk')).toBeTruthy();
    expect(root?.querySelector('.lick .lb')).toBeTruthy();
  });

  it('renders a lucide header <svg> (not the 🔔 emoji) and the "lick · <kind>" header wording', () => {
    const el = mount((e) => {
      e.kind = 'webhook';
    });
    const bell = el.shadowRoot?.querySelector('.bell') as HTMLElement;
    // The header affordance is now a lucide <svg>, never the 🔔 emoji glyph.
    const svg = bell.querySelector('svg');
    expect(svg).toBeTruthy();
    expect(svg?.namespaceURI).toBe('http://www.w3.org/2000/svg');
    // lucide renders path geometry (not an empty fallback <svg>).
    expect(svg?.querySelector('path')).toBeTruthy();
    // Requested 14px size flows through to the rendered icon.
    expect(svg?.getAttribute('width')).toBe('14');
    expect(svg?.getAttribute('height')).toBe('14');
    // No 🔔 character survives anywhere in the bell span (or the header).
    expect(bell.textContent ?? '').not.toContain('🔔');
    const kindEl = el.shadowRoot?.querySelector('.kind') as HTMLElement;
    expect(kindEl.textContent?.replace(/\s+/g, ' ').trim()).toBe('lick · webhook');
  });

  describe('header icon by lick kind', () => {
    function bellSvg(el: SliccLickCard): SVGSVGElement {
      return el.shadowRoot?.querySelector('.bell svg') as SVGSVGElement;
    }

    it('uses the webhook glyph for a webhook lick', () => {
      const el = mount((e) => {
        e.kind = 'webhook';
      });
      expect(bellSvg(el).innerHTML).toBe(iconShape('webhook'));
    });

    it('uses the clock glyph for a cron lick', () => {
      const el = mount((e) => {
        e.kind = 'cron';
      });
      expect(bellSvg(el).innerHTML).toBe(iconShape('clock'));
    });

    it('uses the workflow glyph for a workflow lick', () => {
      const el = mount((e) => {
        e.kind = 'workflow';
      });
      expect(bellSvg(el).innerHTML).toBe(iconShape('workflow'));
    });

    it('falls back to the bell glyph for an unknown / unset kind', () => {
      const unknown = mount((e) => {
        e.kind = 'mystery';
      });
      expect(bellSvg(unknown).innerHTML).toBe(iconShape('bell'));
      const unset = mount();
      expect(bellSvg(unset).innerHTML).toBe(iconShape('bell'));
    });

    it('is case-insensitive on the kind', () => {
      const el = mount((e) => {
        e.kind = 'Webhook';
      });
      expect(bellSvg(el).innerHTML).toBe(iconShape('webhook'));
    });

    it('swaps the glyph live when the kind changes', () => {
      const el = mount((e) => {
        e.kind = 'webhook';
      });
      el.kind = 'cron';
      expect(bellSvg(el).innerHTML).toBe(iconShape('clock'));
    });
  });

  it('keeps the entire shadow root free of the 🔔 emoji glyph', () => {
    const el = mount((e) => {
      e.kind = 'webhook';
    });
    expect(el.shadowRoot?.innerHTML ?? '').not.toContain('🔔');
  });

  it('defaults the event pill to "event"', () => {
    const el = mount();
    expect((el.shadowRoot?.querySelector('.lk') as HTMLElement).textContent).toBe('event');
  });

  describe('attribute ↔ property reflection', () => {
    it('reflects kind', () => {
      const el = mount();
      expect(el.kind).toBeNull();
      el.kind = 'cron';
      expect(el.getAttribute('kind')).toBe('cron');
      const kindEl = el.shadowRoot?.querySelector('.kind') as HTMLElement;
      expect(kindEl.textContent?.replace(/\s+/g, ' ').trim()).toBe('lick · cron');
      el.kind = null;
      expect(el.hasAttribute('kind')).toBe(false);
    });

    it('reflects event-label into the .lk pill', () => {
      const el = mount((e) => {
        e.eventLabel = 'done';
      });
      expect(el.getAttribute('event-label')).toBe('done');
      expect((el.shadowRoot?.querySelector('.lk') as HTMLElement).textContent).toBe('done');
      el.eventLabel = null;
      expect(el.hasAttribute('event-label')).toBe(false);
      expect((el.shadowRoot?.querySelector('.lk') as HTMLElement).textContent).toBe('event');
    });

    it('reflects body text (escaped) into the .lb body', () => {
      const el = mount((e) => {
        e.body = 'plain body';
      });
      const lb = el.shadowRoot?.querySelector('.lb') as HTMLElement;
      expect(lb.textContent).toBe('plain body');

      el.body = '<script>x</script>';
      expect(el.shadowRoot?.querySelector('.lb script')).toBeNull();
      expect((el.shadowRoot?.querySelector('.lb') as HTMLElement).textContent).toBe(
        '<script>x</script>'
      );
      el.body = null;
      expect(el.hasAttribute('body')).toBe(false);
    });

    it('reflects no-animate / collapsible / collapsed booleans', () => {
      const el = mount();
      expect(el.noAnimate).toBe(false);
      el.noAnimate = true;
      expect(el.hasAttribute('no-animate')).toBe(true);

      expect(el.collapsible).toBe(false);
      el.collapsible = true;
      expect(el.hasAttribute('collapsible')).toBe(true);

      expect(el.collapsed).toBe(false);
      el.collapsed = true;
      expect(el.hasAttribute('collapsed')).toBe(true);
      el.collapsed = false;
      expect(el.hasAttribute('collapsed')).toBe(false);
    });

    it('reflects theme (only light|dark accepted)', () => {
      const el = mount();
      expect(el.theme).toBeNull();
      el.theme = 'dark';
      expect(el.getAttribute('theme')).toBe('dark');
      expect(el.theme).toBe('dark');
      el.setAttribute('theme', 'bogus');
      expect(el.theme).toBeNull();
      el.theme = null;
      expect(el.hasAttribute('theme')).toBe(false);
    });
  });

  describe('body source', () => {
    it('falls back to a <slot> when no body attribute is set', () => {
      const el = mount();
      expect(el.shadowRoot?.querySelector('.lb slot')).toBeTruthy();
    });

    it('projects rich slotted markup with <b> emphasis', () => {
      const el = mount((e) => {
        e.innerHTML = 'A <b>lick</b> arrives';
      });
      const slot = el.shadowRoot?.querySelector('.lb slot') as HTMLSlotElement;
      // The light-DOM children are assigned into the body slot.
      const assigned = slot.assignedNodes({ flatten: true });
      expect(assigned.length).toBeGreaterThan(0);
      const bold = el.querySelector('b');
      expect(bold).toBeTruthy();
      expect((bold as HTMLElement).textContent).toBe('lick');
    });

    it('drops the slot once a body attribute is supplied', () => {
      const el = mount((e) => {
        e.body = 'now plain';
      });
      expect(el.shadowRoot?.querySelector('.lb slot')).toBeNull();
      expect((el.shadowRoot?.querySelector('.lb') as HTMLElement).textContent).toBe('now plain');
    });
  });

  describe('appearance (real Chromium)', () => {
    it('paints the amber-tinted light card and #9a6300 header', () => {
      const el = mount((e) => {
        e.kind = 'webhook';
      });
      const csCard = getComputedStyle(card(el));
      // amber 9% over #fff resolves to an opaque, warm, very-light fill.
      expect(csCard.backgroundColor).not.toBe('rgba(0, 0, 0, 0)');
      // #9a6300 → rgb(154, 99, 0) for the light header text.
      expect(getComputedStyle(header(el)).color).toBe('rgb(154, 99, 0)');
    });

    it('paints the amber .lk pill and its dark-brown text', () => {
      const el = mount();
      const cs = getComputedStyle(el.shadowRoot?.querySelector('.lk') as HTMLElement);
      // --amber #f59e0b → rgb(245, 158, 11).
      expect(cs.backgroundColor).toBe('rgb(245, 158, 11)');
      // #3a2600 → rgb(58, 38, 0).
      expect(cs.color).toBe('rgb(58, 38, 0)');
    });

    it('renders rounded card geometry', () => {
      const el = mount();
      const cs = getComputedStyle(card(el));
      expect(cs.borderTopLeftRadius).toBe('12px');
      expect(card(el).offsetWidth).toBeGreaterThan(0);
    });

    it('right-aligns the card in the chat column (host flex, end-justified)', () => {
      const el = mount();
      const cs = getComputedStyle(el);
      expect(cs.display).toBe('flex');
      expect(cs.justifyContent).toBe('flex-end');
    });

    it('keeps the card pinned to the right edge across collapse / expand', () => {
      const wrap = document.createElement('div');
      wrap.style.width = '500px';
      document.body.appendChild(wrap);
      const el = document.createElement('slicc-lick-card') as SliccLickCard;
      el.kind = 'webhook';
      el.collapsible = true;
      el.body =
        'A long lick body that, when expanded, makes the card wider than its collapsed header.';
      wrap.appendChild(el);

      const rightWhenExpanded = card(el).getBoundingClientRect().right;
      el.collapsed = true;
      const rightWhenCollapsed = card(el).getBoundingClientRect().right;
      // The right edge stays put even though the card width shrinks when collapsed.
      expect(Math.abs(rightWhenExpanded - rightWhenCollapsed)).toBeLessThanOrEqual(1);
    });

    it('lightens the header to #e5b35a under theme="dark"', () => {
      const el = mount((e) => {
        e.kind = 'webhook';
        e.theme = 'dark';
      });
      // #e5b35a → rgb(229, 179, 90).
      expect(getComputedStyle(header(el)).color).toBe('rgb(229, 179, 90)');
    });

    it('lightens the header via an ancestor .dark scope (:host-context)', () => {
      const wrap = document.createElement('div');
      wrap.className = 'dark';
      document.body.appendChild(wrap);
      const el = document.createElement('slicc-lick-card') as SliccLickCard;
      el.kind = 'webhook';
      wrap.appendChild(el);
      expect(getComputedStyle(header(el)).color).toBe('rgb(229, 179, 90)');
    });
  });

  describe('entrance animation', () => {
    it('plays lickIn by default and suppresses it under no-animate', () => {
      const animated = mount();
      expect(getComputedStyle(card(animated)).animationName).toBe('lickIn');

      const still = mount((e) => {
        e.noAnimate = true;
      });
      expect(getComputedStyle(card(still)).animationName).toBe('none');
    });
  });

  describe('collapsible behavior', () => {
    it('is not interactive unless collapsible', () => {
      const el = mount();
      const h = header(el);
      expect(h.getAttribute('role')).toBeNull();
      expect(h.hasAttribute('tabindex')).toBe(false);
      // toggle() is a no-op when not collapsible.
      el.toggle();
      expect(el.collapsed).toBe(false);
    });

    it('exposes the header as a button when collapsible', () => {
      const el = mount((e) => {
        e.collapsible = true;
      });
      const h = header(el);
      expect(h.getAttribute('role')).toBe('button');
      expect(h.getAttribute('tabindex')).toBe('0');
      expect(h.getAttribute('aria-expanded')).toBe('true');
    });

    it('hides the body when collapsed', () => {
      const el = mount((e) => {
        e.collapsible = true;
        e.collapsed = true;
      });
      expect(getComputedStyle(el.shadowRoot?.querySelector('.lb') as HTMLElement).display).toBe(
        'none'
      );
      expect(header(el).getAttribute('aria-expanded')).toBe('false');
    });

    it('toggles + emits a composed slicc-lick-toggle on header click', () => {
      const el = mount((e) => {
        e.collapsible = true;
      });
      let detail: { collapsed: boolean } | null = null;
      let composed = false;
      el.addEventListener('slicc-lick-toggle', (ev) => {
        detail = (ev as CustomEvent).detail;
        composed = (ev as CustomEvent).composed;
      });
      header(el).dispatchEvent(new MouseEvent('click', { bubbles: true }));
      expect(el.collapsed).toBe(true);
      expect(detail).toEqual({ collapsed: true });
      expect(composed).toBe(true);

      // A second click re-expands.
      header(el).dispatchEvent(new MouseEvent('click', { bubbles: true }));
      expect(el.collapsed).toBe(false);
    });

    it('toggles on Enter and Space keydown', () => {
      const el = mount((e) => {
        e.collapsible = true;
      });
      header(el).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      expect(el.collapsed).toBe(true);
      header(el).dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
      expect(el.collapsed).toBe(false);
    });

    it('does not throw on keydown after disconnect', () => {
      const el = mount((e) => {
        e.collapsible = true;
      });
      const h = header(el);
      el.remove();
      expect(() =>
        h.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      ).not.toThrow();
    });
  });
});
