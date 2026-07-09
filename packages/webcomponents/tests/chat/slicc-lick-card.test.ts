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

    it('gives every webapp lick channel a fitting glyph (no bell fallbacks)', () => {
      const expectations: ReadonlyArray<[string, string]> = [
        ['session-reload', 'rotate-ccw'],
        ['navigate', 'compass'],
        ['upgrade', 'circle-arrow-up'],
        ['sprinkle', 'sparkles'],
        ['fswatch', 'eye'],
        ['scoop-notify', 'bell-ring'],
        ['scoop-idle', 'moon'],
        ['scoop-wait', 'hourglass'],
      ];
      for (const [kind, icon] of expectations) {
        const el = mount((e) => {
          e.kind = kind;
        });
        expect(bellSvg(el).innerHTML, `kind=${kind}`).toBe(iconShape(icon));
      }
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

  describe('collation count', () => {
    function pill(el: SliccLickCard): HTMLElement {
      return el.shadowRoot?.querySelector('.lk') as HTMLElement;
    }

    it('annotates the event pill with ×N at count 2+', () => {
      const el = mount((e) => {
        e.setAttribute('event-label', 'session-reload');
        e.setAttribute('count', '2');
      });
      expect(pill(el).textContent).toBe('session-reload ×2');
    });

    it('keeps the plain label at count 1 / invalid counts, and reflects the property', () => {
      const el = mount((e) => {
        e.setAttribute('event-label', 'deploy');
      });
      expect(pill(el).textContent).toBe('deploy');
      expect(el.count).toBe(1);

      el.setAttribute('count', 'bogus');
      expect(el.count).toBe(1);
      expect(pill(el).textContent).toBe('deploy');

      el.count = 3;
      expect(el.getAttribute('count')).toBe('3');
      expect(pill(el).textContent).toBe('deploy ×3');

      el.count = 1;
      expect(el.hasAttribute('count')).toBe(false);
    });
  });

  describe('result state (confirm / dismiss)', () => {
    function statusSvg(el: SliccLickCard): SVGSVGElement | null {
      return el.shadowRoot?.querySelector('.status svg') as SVGSVGElement | null;
    }

    it('renders no status glyph by default (pending)', () => {
      const el = mount();
      expect(el.state).toBe('pending');
      expect(el.shadowRoot?.querySelector('.status')).toBeNull();
      expect(el.shadowRoot?.querySelector('[part="status"]')).toBeNull();
    });

    it('renders the green circle-check glyph when confirmed', () => {
      const el = mount((e) => {
        e.state = 'confirmed';
      });
      expect(el.getAttribute('state')).toBe('confirmed');
      expect(el.shadowRoot?.querySelector('[part="status"]')).toBeTruthy();
      expect(statusSvg(el)?.innerHTML).toBe(iconShape('circle-check'));
    });

    it('renders the red circle-x glyph when dismissed', () => {
      const el = mount((e) => {
        e.state = 'dismissed';
      });
      expect(el.getAttribute('state')).toBe('dismissed');
      expect(statusSvg(el)?.innerHTML).toBe(iconShape('circle-x'));
    });

    it('mutes the whole card (reduced opacity) only when dismissed', () => {
      // no-animate so the lickIn entrance (which starts at opacity:0) doesn't
      // race the static result-state opacity we want to measure.
      const el = mount((e) => {
        e.noAnimate = true;
        e.state = 'dismissed';
      });
      expect(Number(getComputedStyle(card(el)).opacity)).toBeLessThan(1);
      // confirmed cards keep full opacity (no muting).
      el.state = 'confirmed';
      expect(Number(getComputedStyle(card(el)).opacity)).toBe(1);
    });

    it('tints the glyph green when confirmed and red when dismissed', () => {
      const el = mount((e) => {
        e.state = 'confirmed';
      });
      const status = () => el.shadowRoot?.querySelector('.status') as HTMLElement;
      // --lick-confirm #16a34a → rgb(22, 163, 74).
      expect(getComputedStyle(status()).color).toBe('rgb(22, 163, 74)');
      el.state = 'dismissed';
      // --lick-dismiss #dc2626 → rgb(220, 38, 38).
      expect(getComputedStyle(status()).color).toBe('rgb(220, 38, 38)');
    });

    it('swaps the status glyph live as the state changes', () => {
      const el = mount((e) => {
        e.state = 'confirmed';
      });
      expect(statusSvg(el)?.innerHTML).toBe(iconShape('circle-check'));
      el.state = 'dismissed';
      expect(statusSvg(el)?.innerHTML).toBe(iconShape('circle-x'));
      el.state = 'pending';
      expect(el.shadowRoot?.querySelector('.status')).toBeNull();
    });

    it('reflects state (confirmed|dismissed retained; pending/null clears)', () => {
      const el = mount();
      expect(el.state).toBe('pending');
      el.state = 'confirmed';
      expect(el.getAttribute('state')).toBe('confirmed');
      el.state = 'pending';
      expect(el.hasAttribute('state')).toBe(false);
      el.state = 'dismissed';
      expect(el.getAttribute('state')).toBe('dismissed');
      el.state = null;
      expect(el.hasAttribute('state')).toBe(false);
      // Unrecognized attribute values read back as pending.
      el.setAttribute('state', 'bogus');
      expect(el.state).toBe('pending');
    });
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
    it('paints the amber-tinted light card and amber-derived header', () => {
      const el = mount((e) => {
        e.kind = 'webhook';
      });
      const csCard = getComputedStyle(card(el));
      // amber 9% over #fff resolves to an opaque, warm, very-light fill.
      expect(csCard.backgroundColor).not.toBe('rgba(0, 0, 0, 0)');
      // color-mix(in srgb, #f59e0b 65%, #000) for the light header text.
      expect(getComputedStyle(header(el)).color).toBe('color(srgb 0.62451 0.402745 0.0280392)');
    });

    it('paints the amber .lk pill and its amber-derived dark text', () => {
      const el = mount();
      const cs = getComputedStyle(el.shadowRoot?.querySelector('.lk') as HTMLElement);
      // --amber #f59e0b → rgb(245, 158, 11).
      expect(cs.backgroundColor).toBe('rgb(245, 158, 11)');
      // color-mix(in srgb, #f59e0b 40%, #000) for pill ink.
      expect(cs.color).toBe('color(srgb 0.384314 0.247843 0.0172549)');
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

    it('adjusts the header color under theme="dark"', () => {
      const el = mount((e) => {
        e.kind = 'webhook';
        e.theme = 'dark';
      });
      // color-mix(in srgb, #f59e0b 75%, #0a0a0a) — no .dark ancestor so --ink stays light-mode value.
      expect(getComputedStyle(header(el)).color).toBe('color(srgb 0.730392 0.47451 0.0421569)');
    });

    it('adjusts the header color via an ancestor .dark scope (:host-context)', () => {
      const wrap = document.createElement('div');
      wrap.className = 'dark';
      document.body.appendChild(wrap);
      const el = document.createElement('slicc-lick-card') as SliccLickCard;
      el.kind = 'webhook';
      wrap.appendChild(el);
      // color-mix(in srgb, #f59e0b 75%, #f5f5f2) — .dark flips --ink to near-white.
      expect(getComputedStyle(header(el)).color).toBe('color(srgb 0.960784 0.704902 0.269608)');
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

describe('scoop-accent hue', () => {
  it('tints the event pill with the hue and clears back to amber', () => {
    const el = document.createElement('slicc-lick-card');
    el.setAttribute('kind', 'scoop-idle');
    el.setAttribute('event-label', 'blame-roulette');
    el.setAttribute('hue', '#06b6d4');
    document.body.appendChild(el);
    const pill = el.shadowRoot?.querySelector('.lk') as HTMLElement;
    const cs = getComputedStyle(pill);
    // Cyan pill with white ink (scoop identity), not the amber default.
    expect(cs.backgroundColor).toBe('rgb(6, 182, 212)');
    expect(cs.color).toBe('rgb(255, 255, 255)');

    el.removeAttribute('hue');
    // Attribute changes re-render the shadow content — re-query the pill.
    const fresh = el.shadowRoot?.querySelector('.lk') as HTMLElement;
    // color-mix(in srgb, #f59e0b 40%, #000) when hue reverts to --amber default.
    expect(getComputedStyle(fresh).color).toBe('color(srgb 0.384314 0.247843 0.0172549)');
    el.remove();
  });
});
