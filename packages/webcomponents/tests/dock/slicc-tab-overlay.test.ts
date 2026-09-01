import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SliccTabOverlay,
  type TabDescriptor,
  type TabOverlayCloseReason,
} from '../../src/dock/slicc-tab-overlay.js';
import { ensureGlobalTokens } from '../../src/theme/tokens.js';

const TABS: TabDescriptor[] = [
  {
    id: 't1',
    title: 'First',
    url: 'a.example',
    screenshot: 'data:image/png;base64,AAAA',
    active: true,
  },
  { id: 't2', title: 'Second', url: 'b.example' },
  { id: 't3', title: 'Third' },
];

function mount(setup?: (el: SliccTabOverlay) => void): SliccTabOverlay {
  const el = document.createElement('slicc-tab-overlay') as SliccTabOverlay;
  setup?.(el);
  document.body.appendChild(el);
  return el;
}

/** The rendered tab cards inside the grid. */
function cards(el: SliccTabOverlay): HTMLElement[] {
  return [...(el.shadowRoot?.querySelectorAll<HTMLElement>('.card') ?? [])];
}

describe('slicc-tab-overlay', () => {
  beforeEach(() => {
    ensureGlobalTokens();
    document.body.replaceChildren();
  });

  it('registers the custom element', () => {
    expect(customElements.get('slicc-tab-overlay')).toBe(SliccTabOverlay);
  });

  it('keeps its CSS in a constructable adopted stylesheet (no <style> node)', () => {
    const el = mount();
    expect(el.shadowRoot?.querySelector('style')).toBeNull();
    expect((el.shadowRoot as ShadowRoot).adoptedStyleSheets.length).toBe(1);
  });

  it('is hidden until open (the host display flips with the attribute)', () => {
    const el = mount();
    expect(getComputedStyle(el).display).toBe('none');
    el.show();
    expect(el.hasAttribute('open')).toBe(true);
    expect(getComputedStyle(el).display).toBe('block');
  });

  it('builds the overlay scrim + header bar with parts', () => {
    const el = mount();
    expect(el.shadowRoot?.querySelector('.overlay[part="overlay"]')).not.toBeNull();
    expect(el.shadowRoot?.querySelector('.bar[part="bar"]')).not.toBeNull();
    expect(el.shadowRoot?.querySelector('.close[part="close"]')).not.toBeNull();
  });

  it('reflects the heading (defaulting to "Open tabs") into the header', () => {
    const el = mount();
    expect(el.shadowRoot?.querySelector('.title')?.textContent).toBe('Open tabs');
    el.heading = 'Switch tab';
    expect(el.getAttribute('heading')).toBe('Switch tab');
    expect(el.shadowRoot?.querySelector('.title')?.textContent).toBe('Switch tab');
    el.heading = null;
    expect(el.hasAttribute('heading')).toBe(false);
  });

  it('renders one card per tab with the live count', () => {
    const el = mount((o) => (o.tabs = TABS));
    expect(cards(el)).toHaveLength(3);
    expect(el.shadowRoot?.querySelector('.count')?.textContent).toBe('3');
    expect(el.shadowRoot?.querySelector('.grid[part="grid"]')).not.toBeNull();
  });

  it('shows the empty state (no cards) when there are no tabs', () => {
    const el = mount((o) => (o.tabs = []));
    expect(cards(el)).toHaveLength(0);
    expect(el.shadowRoot?.querySelector('.empty')?.textContent).toBe('No open tabs.');
    expect(el.shadowRoot?.querySelector('.count')?.textContent).toBe('0');
  });

  it('renders a screenshot img when present, else a globe placeholder', () => {
    const el = mount((o) => (o.tabs = TABS));
    const [first, , third] = cards(el);
    expect(first.querySelector('img.shot')?.getAttribute('src')).toBe('data:image/png;base64,AAAA');
    expect(third.querySelector('.shot.ph svg')).toBeInstanceOf(SVGSVGElement);
  });

  it('marks the active tab with the .on ring and aria-current', () => {
    const el = mount((o) => (o.tabs = TABS));
    const active = cards(el).filter((c) => c.classList.contains('on'));
    expect(active).toHaveLength(1);
    expect(active[0].getAttribute('data-tab-id')).toBe('t1');
    expect(active[0].getAttribute('aria-current')).toBe('true');
  });

  it('falls back to the id as the card title when no title is set', () => {
    const el = mount((o) => (o.tabs = [{ id: 'bare' }]));
    expect(el.shadowRoot?.querySelector('.name')?.textContent).toBe('bare');
  });

  it('escapes interpolated title text (no injection surface)', () => {
    const el = mount((o) => (o.tabs = [{ id: 'x', title: '<img src=x>' }]));
    expect(el.shadowRoot?.querySelector('.name')?.textContent).toBe('<img src=x>');
    expect(el.shadowRoot?.querySelector('img')).toBeNull();
  });

  // ── The overlay's own keyboard: digits pick a tab, `p` arms peek ──

  /** Press a key at the document, the way the overlay listens for it. */
  function key(init: KeyboardEventInit): boolean {
    const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
    document.dispatchEvent(event);
    return event.defaultPrevented;
  }

  describe('the digit keys', () => {
    it('activates the nth tab, with 9 always the last', () => {
      const el = mount((e) => {
        e.tabs = TABS;
      });
      const seen: string[] = [];
      el.addEventListener('tab-activate', (e) =>
        seen.push((e as CustomEvent<{ id: string }>).detail.id)
      );
      el.show();
      key({ key: '2', code: 'Digit2' });
      key({ key: '9', code: 'Digit9' });
      expect(seen).toEqual(['t2', 't3']);
    });

    it('does nothing past the end of the list', () => {
      const el = mount((e) => {
        e.tabs = [TABS[0]];
      });
      const seen: string[] = [];
      el.addEventListener('tab-activate', () => seen.push('x'));
      el.show();
      key({ key: '3', code: 'Digit3' });
      expect(seen).toEqual([]);
    });

    /**
     * The shell's keyboard mode is listening on the same document. A digit the
     * overlay took must not also register there, or one press would read as
     * two.
     */
    it('swallows the keys it takes', () => {
      const el = mount((e) => {
        e.tabs = TABS;
      });
      el.show();
      expect(key({ key: '1', code: 'Digit1' })).toBe(true);
      expect(key({ key: 'p', code: 'KeyP' })).toBe(true);
    });

    it('is deaf while closed', () => {
      const el = mount((e) => {
        e.tabs = TABS;
      });
      const seen: string[] = [];
      el.addEventListener('tab-activate', () => seen.push('x'));
      key({ key: '1', code: 'Digit1' });
      expect(seen).toEqual([]);
    });

    /** The number a key selects is drawn on the card, not left to be counted. */
    it('badges each card with the digit that selects it', () => {
      const el = mount((e) => {
        e.tabs = TABS;
      });
      el.show();
      expect(cards(el).map((c) => c.querySelector('.num')?.textContent)).toEqual(['1', '2', '9']);
    });

    it('leaves the unreachable middle of a long list unbadged', () => {
      const el = mount((e) => {
        e.tabs = Array.from({ length: 12 }, (_, i) => ({ id: `t${i}` }));
      });
      el.show();
      const badges = cards(el).map((c) => c.querySelector('.num')?.textContent ?? null);
      expect(badges.slice(0, 8)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8']);
      // 9 is the LAST card, so the ninth through eleventh are keyless.
      expect(badges.slice(8, 11)).toEqual([null, null, null]);
      expect(badges.at(-1)).toBe('9');
    });
  });

  describe('peek', () => {
    it('p arms it, and the next digit peeks instead of switching', () => {
      const el = mount((e) => {
        e.tabs = TABS;
      });
      const peeks: string[] = [];
      const activates: string[] = [];
      el.addEventListener('tab-peek', (e) =>
        peeks.push((e as CustomEvent<{ id: string }>).detail.id)
      );
      el.addEventListener('tab-activate', (e) =>
        activates.push((e as CustomEvent<{ id: string }>).detail.id)
      );
      el.show();
      key({ key: 'p', code: 'KeyP' });
      key({ key: '1', code: 'Digit1' });
      expect(peeks).toEqual(['t1']);
      expect(activates).toEqual([]);
    });

    it('applies to a click too — it is the activation that changes, not the key', () => {
      const el = mount((e) => {
        e.tabs = TABS;
      });
      const peeks: string[] = [];
      el.addEventListener('tab-peek', (e) =>
        peeks.push((e as CustomEvent<{ id: string }>).detail.id)
      );
      el.show();
      el.peeking = true;
      cards(el)[1].click();
      expect(peeks).toEqual(['t2']);
    });

    /** An armed modifier nobody can see is a trap. */
    it('shows a chip in the header while it is armed', () => {
      const el = mount((e) => {
        e.tabs = TABS;
      });
      el.show();
      expect(el.hasAttribute('data-peek')).toBe(false);
      key({ key: 'p', code: 'KeyP' });
      expect(el.hasAttribute('data-peek')).toBe(true);
      expect(el.shadowRoot?.querySelector('.peek')?.textContent).toContain('Peek');
    });

    it('p toggles back off', () => {
      const el = mount((e) => {
        e.tabs = TABS;
      });
      el.show();
      key({ key: 'p', code: 'KeyP' });
      key({ key: 'p', code: 'KeyP' });
      expect(el.peeking).toBe(false);
    });

    it('disarms when the overlay closes, so it never survives into the next visit', () => {
      const el = mount((e) => {
        e.tabs = TABS;
      });
      el.show();
      el.peeking = true;
      el.hide();
      expect(el.peeking).toBe(false);
      expect(el.hasAttribute('data-peek')).toBe(false);
    });
  });

  it('emits tab-activate (composed + bubbling) when a card is clicked', () => {
    const el = mount((o) => (o.tabs = TABS));
    const seen = vi.fn();
    document.body.addEventListener('tab-activate', (e) =>
      seen((e as CustomEvent<{ id: string }>).detail.id)
    );
    cards(el)[1].click();
    expect(seen).toHaveBeenCalledWith('t2');
    document.body.removeEventListener('tab-activate', seen);
  });

  it('activates a card via the Enter / Space keys', () => {
    const el = mount((o) => (o.tabs = TABS));
    const seen = vi.fn();
    el.addEventListener('tab-activate', (e) => seen((e as CustomEvent<{ id: string }>).detail.id));
    cards(el)[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    cards(el)[2].dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    expect(seen).toHaveBeenNthCalledWith(1, 't1');
    expect(seen).toHaveBeenNthCalledWith(2, 't3');
  });

  it('emits tab-close (not tab-activate) when a card ✕ is clicked', () => {
    const el = mount((o) => (o.tabs = TABS));
    const close = vi.fn();
    const activate = vi.fn();
    el.addEventListener('tab-close', (e) => close((e as CustomEvent<{ id: string }>).detail.id));
    el.addEventListener('tab-activate', activate);
    (cards(el)[1].querySelector('.x') as HTMLButtonElement).click();
    expect(close).toHaveBeenCalledWith('t2');
    expect(activate).not.toHaveBeenCalled();
  });

  it('returns a defensive copy from the tabs getter', () => {
    const el = mount((o) => (o.tabs = TABS));
    const got = el.tabs;
    got[0].title = 'mutated';
    expect(el.tabs[0].title).toBe('First');
  });

  it('tolerates a non-array assignment by clearing the tabs', () => {
    const el = mount((o) => (o.tabs = TABS));
    // @ts-expect-error — exercising the runtime guard.
    el.tabs = null;
    expect(cards(el)).toHaveLength(0);
  });

  /** Collect the `reason` from every `overlay-close` an open overlay emits. */
  function closeReasons(el: SliccTabOverlay): TabOverlayCloseReason[] {
    const reasons: TabOverlayCloseReason[] = [];
    el.addEventListener('overlay-close', (e) =>
      reasons.push((e as CustomEvent<{ reason: TabOverlayCloseReason }>).detail.reason)
    );
    return reasons;
  }

  it('closes with reason "close-button" when the header ✕ is clicked', () => {
    const el = mount((o) => o.show());
    const reasons = closeReasons(el);
    (el.shadowRoot?.querySelector('.close') as HTMLButtonElement).click();
    expect(el.open).toBe(false);
    expect(reasons).toEqual(['close-button']);
  });

  it('closes with reason "backdrop" on a scrim mousedown (but not on a card)', () => {
    const el = mount((o) => {
      o.tabs = TABS;
      o.show();
    });
    const reasons = closeReasons(el);
    cards(el)[0].dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(reasons).toEqual([]);
    const overlay = el.shadowRoot?.querySelector('.overlay') as HTMLElement;
    overlay.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(reasons).toEqual(['backdrop']);
  });

  it('closes with reason "escape" on the Escape key while open', () => {
    const el = mount((o) => o.show());
    const reasons = closeReasons(el);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(reasons).toEqual(['escape']);
    expect(el.open).toBe(false);
  });

  it('hide() closes with reason "api"; show() is idempotent', () => {
    const el = mount((o) => o.show());
    const reasons = closeReasons(el);
    el.show();
    el.hide();
    expect(reasons).toEqual(['api']);
  });

  it('drops the document Escape listener on disconnect', () => {
    const el = mount((o) => o.show());
    const reasons = closeReasons(el);
    el.remove();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(reasons).toEqual([]);
  });

  it('lays the scrim out fixed and full-viewport (real Chromium)', () => {
    const el = mount((o) => o.show());
    const overlay = el.shadowRoot?.querySelector('.overlay') as HTMLElement;
    const cs = getComputedStyle(overlay);
    expect(cs.position).toBe('fixed');
    expect(cs.flexDirection).toBe('column');
  });

  /** A 1×1 PNG — enough for Chromium to lay out a real `<img>` thumbnail. */
  const PIXEL =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

  /** `n` uniform tabs, each with a screenshot, so card heights are comparable. */
  function manyTabs(n: number): TabDescriptor[] {
    return Array.from({ length: n }, (_, i) => ({
      id: `t${i}`,
      title: `Tab ${i}`,
      url: `https://example.com/${i}`,
      screenshot: PIXEL,
    }));
  }

  /** Open an overlay with `n` tabs and measure its first card (real Chromium). */
  function measure(n: number): { cardH: number; shotRatio: number; scrolls: boolean } {
    const el = mount((o) => {
      o.tabs = manyTabs(n);
      o.show();
    });
    const grid = el.shadowRoot?.querySelector('.grid') as HTMLElement;
    const card = cards(el)[0].getBoundingClientRect();
    const shot = (cards(el)[0].querySelector('img.shot') as HTMLElement).getBoundingClientRect();
    // Read every layout value while the overlay is still connected — a detached
    // grid reports 0 for both scrollHeight and clientHeight.
    const scrolls = grid.scrollHeight > grid.clientHeight;
    el.remove();
    return { cardH: card.height, shotRatio: shot.width / shot.height, scrolls };
  }

  it('scrolls a long tab list instead of squashing the cards (real Chromium)', () => {
    // Regression: the grid's implicit rows were the initial `auto`, which lets
    // the track sizing algorithm shrink rows below their content once they stop
    // fitting the grid's definite height. A long list therefore compressed every
    // card (220px → ~66px, thumbnail cropped to a sliver) and never overflowed,
    // so the scroll container had nothing to scroll.
    const few = measure(3);
    const many = measure(40);
    expect(few.scrolls).toBe(false);
    expect(many.scrolls).toBe(true);
    expect(many.cardH).toBe(few.cardH);
    expect(many.shotRatio).toBeCloseTo(16 / 10, 1);
  });
});
