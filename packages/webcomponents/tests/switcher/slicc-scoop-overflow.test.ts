import { beforeEach, describe, expect, it } from 'vitest';
import {
  SliccScoopOverflow,
  type SliccScoopOverflowItem,
} from '../../src/switcher/slicc-scoop-overflow.js';
import { ensureGlobalTokens } from '../../src/theme/tokens.js';

const ITEMS: SliccScoopOverflowItem[] = [
  { id: 'researcher', label: 'researcher', color: '#06b6d4', state: 'working', fill: 42 },
  { id: 'designer', label: 'designer', color: '#8b5cf6', state: 'idle', fill: 18 },
  { id: 'tester', label: 'tester', color: '#f59e0b', state: 'broken', fill: 90 },
];

function mount(setup?: (el: SliccScoopOverflow) => void): SliccScoopOverflow {
  const el = document.createElement('slicc-scoop-overflow') as SliccScoopOverflow;
  setup?.(el);
  document.body.appendChild(el);
  return el;
}

/** The status-grid trigger button inside the shadow root. */
function moreBtn(el: SliccScoopOverflow): HTMLButtonElement {
  return el.shadowRoot?.querySelector('.morebtn') as HTMLButtonElement;
}

/** The fixed overflow glyph grid inside the trigger. */
function grid(el: SliccScoopOverflow): HTMLElement {
  return el.shadowRoot?.querySelector('.overflow-grid') as HTMLElement;
}

/** The nine stable wells inside the overflow glyph. */
function gridCells(el: SliccScoopOverflow): HTMLElement[] {
  return Array.from(el.shadowRoot?.querySelectorAll('.overflow-grid-cell') ?? []) as HTMLElement[];
}

/** The `.switcher-more` wrap inside the shadow root. */
function wrap(el: SliccScoopOverflow): HTMLElement {
  return el.shadowRoot?.querySelector('.switcher-more') as HTMLElement;
}

/** The `.pop` dropdown inside the shadow root. */
function pop(el: SliccScoopOverflow): HTMLElement {
  return el.shadowRoot?.querySelector('.pop') as HTMLElement;
}

/** The vertical overflow rows inside the popup. */
function rows(el: SliccScoopOverflow): HTMLButtonElement[] {
  return Array.from(el.shadowRoot?.querySelectorAll<HTMLButtonElement>('.popup-row') ?? []);
}

describe('slicc-scoop-overflow', () => {
  beforeEach(() => {
    ensureGlobalTokens();
    document.body.replaceChildren();
  });

  it('registers the custom element', () => {
    expect(customElements.get('slicc-scoop-overflow')).toBe(SliccScoopOverflow);
  });

  it('renders the wrap, trigger, and popup with ::part hooks', () => {
    const el = mount();
    expect(el.shadowRoot).toBeTruthy();
    expect(el.shadowRoot?.querySelector('[part="wrap"]')).toBeTruthy();
    expect(el.shadowRoot?.querySelector('[part="more"]')).toBeTruthy();
    expect(el.shadowRoot?.querySelector('[part="pop"]')).toBeTruthy();
    expect(el.shadowRoot?.querySelector('[part="row"]')).toBeNull();
  });

  it('exposes a slotted status-grid trigger glyph and an empty slot', () => {
    const el = mount();
    expect(el.shadowRoot?.querySelector('slot[name="more"]')).toBeTruthy();
    expect(gridCells(el)).toHaveLength(9);
    expect(moreBtn(el).textContent).not.toContain('⋯');
    // With no items the popup hosts the empty slot.
    expect(el.shadowRoot?.querySelector('.pop slot[name="empty"]')).toBeTruthy();
  });

  it('sets aria-haspopup on the trigger', () => {
    const el = mount();
    expect(moreBtn(el).getAttribute('aria-haspopup')).toBe('true');
  });

  describe('items property + overflow reflection', () => {
    it('reflects count and has-overflow from items', () => {
      const el = mount((e) => {
        e.items = ITEMS;
      });
      expect(el.count).toBe(3);
      expect(el.hasOverflow).toBe(true);
      expect(el.getAttribute('count')).toBe('3');
      expect(wrap(el).classList.contains('has-overflow')).toBe(true);
    });

    it('clears count / has-overflow when items is emptied', () => {
      const el = mount((e) => {
        e.items = ITEMS;
      });
      el.items = [];
      expect(el.count).toBe(0);
      expect(el.hasOverflow).toBe(false);
      expect(el.hasAttribute('count')).toBe(false);
      expect(wrap(el).classList.contains('has-overflow')).toBe(false);
    });

    it('coerces a non-array assignment to an empty list', () => {
      const el = mount((e) => {
        e.items = ITEMS;
      });
      // @ts-expect-error — defensive runtime coercion path.
      el.items = null;
      expect(el.items).toEqual([]);
      expect(el.count).toBe(0);
    });

    it('renders one R4 menu row per item with status glyph, label, and state text', () => {
      const el = mount((e) => {
        e.items = ITEMS;
      });
      const menuRows = rows(el);
      expect(menuRows).toHaveLength(3);
      expect(pop(el).getAttribute('role')).toBe('menu');
      expect(menuRows[0].getAttribute('role')).toBe('menuitem');
      expect(menuRows[0].getAttribute('part')).toBe('row');
      expect(menuRows[0].dataset.k).toBe('researcher');
      expect(menuRows[0].dataset.state).toBe('working');
      expect(menuRows[0].style.getPropertyValue('--hue')).toBe('#06b6d4');
      expect(menuRows[0].querySelector('.status-glyph')).toBeInstanceOf(SVGSVGElement);
      expect(menuRows[0].querySelector('.popup-label')?.textContent).toBe('researcher');
      expect(menuRows[0].querySelector('.popup-state')?.textContent).toBe('working · 42%');
      expect(menuRows[2].querySelectorAll('.broken-x')).toHaveLength(2);
    });

    it('does not render a legacy pill element in the popup', () => {
      const el = mount((e) => {
        e.items = ITEMS;
      });
      expect(pop(el).querySelector('slicc-pill')).toBeNull();
    });

    it('renders the initializing status glyph variant', () => {
      const el = mount((e) => {
        e.items = [{ id: 'triage', state: 'initializing', fill: 78 }];
      });
      const row = rows(el)[0];
      expect(row.querySelector('.initializing-ring')).toBeInstanceOf(SVGCircleElement);
      expect(row.querySelector('.glyph-base')).toBeNull();
      expect(row.querySelector('.glyph-arc')).toBeNull();
      expect(row.querySelector('.popup-state')?.textContent).toBe('initializing · 78%');
    });

    it('escapes interpolated descriptor text', () => {
      const el = mount((e) => {
        e.items = [{ id: 'x"><img>', label: '<script>1</script>' }];
      });
      // No injected nodes leaked into the shadow tree.
      expect(el.shadowRoot?.querySelector('img')).toBeNull();
      expect(el.shadowRoot?.querySelector('script')).toBeNull();
      const row = rows(el)[0];
      expect(row.querySelector('.popup-label')?.textContent).toBe('<script>1</script>');
      expect(row.dataset.k).toBe('x"><img>');
    });

    it('falls back to id when no label is supplied', () => {
      const el = mount((e) => {
        e.items = [{ id: 'solo' }];
      });
      expect(rows(el)[0].querySelector('.popup-label')?.textContent).toBe('solo');
      expect(rows(el)[0].querySelector('.popup-state')?.textContent).toBe('idle · 0%');
    });
  });

  describe('status-coded overflow grid', () => {
    it('severity-sorts states into the settled centre-out fill order', () => {
      const el = mount((e) => {
        e.items = [
          { id: 'idle', state: 'idle', fill: 10 },
          { id: 'working', state: 'working', fill: 40 },
          { id: 'near', state: 'initializing', fill: 75 },
          { id: 'broken', state: 'broken', fill: 90 },
        ];
      });
      expect(gridCells(el).map((cell) => cell.dataset.dotState ?? null)).toEqual([
        null,
        null,
        null,
        'working',
        'broken',
        'near-limit',
        null,
        'idle',
        null,
      ]);
    });

    it('maps each state to its settled design token', () => {
      const el = mount((e) => {
        e.items = ITEMS;
      });
      const adopted = el.shadowRoot?.adoptedStyleSheets[0] as CSSStyleSheet;
      const tokenByState = new Map([
        ['idle', 'var(--txt-3)'],
        ['broken', 'var(--red)'],
        ['working', 'var(--green)'],
        ['near-limit', 'var(--amber)'],
      ]);
      for (const [state, token] of tokenByState) {
        const rule = Array.from(adopted.cssRules).find(
          (entry): entry is CSSStyleRule =>
            entry instanceof CSSStyleRule &&
            entry.selectorText.includes(`data-dot-state="${state}"`)
        );
        expect(rule?.style.background).toBe(token);
      }
    });

    it('keeps broken ahead of near-limit when states collide with high fill', () => {
      const el = mount((e) => {
        e.items = [
          { id: 'working-near', state: 'working', fill: 95 },
          { id: 'broken-near', state: 'broken', fill: 90 },
        ];
      });
      const cells = gridCells(el);
      expect(cells[4].dataset.dotState).toBe('broken');
      expect(cells[5].dataset.dotState).toBe('near-limit');
    });

    it('renders faint empty wells so all nine cells remain mounted', () => {
      const el = mount((e) => {
        e.items = [{ id: 'solo' }];
      });
      const cells = gridCells(el);
      expect(cells).toHaveLength(9);
      expect(cells.filter((cell) => cell.hasAttribute('data-dot-state'))).toHaveLength(1);
      const emptyWell = cells.find((cell) => !cell.hasAttribute('data-dot-state')) as HTMLElement;
      expect(getComputedStyle(emptyWell).boxShadow).not.toBe('none');
    });

    it('uses dots through nine hidden items and a geometric plus above nine', () => {
      const el = mount((e) => {
        e.items = Array.from({ length: 9 }, (_, i) => ({ id: `scoop-${i}` }));
      });
      expect(el.shadowRoot?.querySelector('.overflow-grid-cell--plus')).toBeNull();

      el.items = Array.from({ length: 10 }, (_, i) => ({
        id: `scoop-${i}`,
        state: i === 9 ? ('broken' as const) : ('idle' as const),
      }));
      const cells = gridCells(el);
      expect(cells[4].dataset.dotState).toBe('broken');
      expect(cells[8].classList.contains('overflow-grid-cell--plus')).toBe(true);
      expect(cells[8].textContent).toBe('');
      const horizontal = cells[8].querySelector('.overflow-plus-bar--horizontal') as HTMLElement;
      const vertical = cells[8].querySelector('.overflow-plus-bar--vertical') as HTMLElement;
      expect(horizontal).toBeTruthy();
      expect(vertical).toBeTruthy();
      expect(getComputedStyle(horizontal).position).toBe('absolute');
      expect(horizontal.getBoundingClientRect().width).toBe(4);
      expect(horizontal.getBoundingClientRect().height).toBe(1);
      expect(vertical.getBoundingClientRect().width).toBe(1);
      expect(vertical.getBoundingClientRect().height).toBe(4);
    });

    it('keeps the glyph at 13×13px for one and nine hidden items', () => {
      const one = mount((e) => {
        e.items = [{ id: 'solo' }];
      });
      const nine = mount((e) => {
        e.items = Array.from({ length: 9 }, (_, i) => ({ id: `scoop-${i}` }));
      });
      const oneRect = grid(one).getBoundingClientRect();
      const nineRect = grid(nine).getBoundingClientRect();
      expect([oneRect.width, oneRect.height]).toEqual([13, 13]);
      expect([nineRect.width, nineRect.height]).toEqual([13, 13]);
    });

    it('names the hidden count and worst represented state accessibly', () => {
      const el = mount((e) => {
        e.items = [
          { id: 'working', state: 'working' },
          { id: 'broken', state: 'broken', fill: 99 },
        ];
      });
      expect(grid(el).getAttribute('aria-label')).toBe('2 hidden scoops; worst state broken');
      expect(moreBtn(el).getAttribute('aria-label')).toBe(
        '2 hidden scoops; worst state broken. Show hidden scoops'
      );
    });
  });

  describe('open ↔ attribute reflection', () => {
    it('reflects open as an attribute and onto the wrap + aria-expanded', () => {
      const el = mount((e) => {
        e.items = ITEMS;
      });
      expect(el.open).toBe(false);
      expect(moreBtn(el).getAttribute('aria-expanded')).toBe('false');

      el.open = true;
      expect(el.hasAttribute('open')).toBe(true);
      expect(wrap(el).classList.contains('open')).toBe(true);
      expect(moreBtn(el).getAttribute('aria-expanded')).toBe('true');

      el.open = false;
      expect(el.hasAttribute('open')).toBe(false);
      expect(wrap(el).classList.contains('open')).toBe(false);
      expect(moreBtn(el).getAttribute('aria-expanded')).toBe('false');
    });

    it('show()/close()/toggle() drive the open state', () => {
      const el = mount((e) => {
        e.items = ITEMS;
      });
      el.show();
      expect(el.open).toBe(true);
      el.show(); // idempotent
      expect(el.open).toBe(true);
      el.toggle();
      expect(el.open).toBe(false);
      el.toggle();
      expect(el.open).toBe(true);
      el.close();
      expect(el.open).toBe(false);
    });

    it('honors the open attribute set before connection', () => {
      const el = document.createElement('slicc-scoop-overflow') as SliccScoopOverflow;
      el.items = ITEMS;
      el.setAttribute('open', '');
      document.body.appendChild(el);
      expect(wrap(el).classList.contains('open')).toBe(true);
      expect(moreBtn(el).getAttribute('aria-expanded')).toBe('true');
    });

    it('force-closes when items drop to zero while open', () => {
      const el = mount((e) => {
        e.items = ITEMS;
      });
      el.show();
      expect(el.open).toBe(true);
      el.items = [];
      expect(el.open).toBe(false);
    });
  });

  describe('variant visibility (getComputedStyle)', () => {
    it('hides the trigger when there is no overflow', () => {
      const el = mount();
      expect(getComputedStyle(moreBtn(el)).display).toBe('none');
    });

    it('shows the trigger as an inline-flex pill when overflowing', () => {
      const el = mount((e) => {
        e.items = ITEMS;
      });
      const cs = getComputedStyle(moreBtn(el));
      expect(cs.display).toBe('inline-flex');
      // Pill-shaped: huge border-radius + a 1px line border.
      expect(cs.borderRadius).toBe('9999px');
      expect(cs.borderTopWidth).toBe('1px');
    });

    it('keeps the popup hidden when closed and shows it (flex column) when open', () => {
      const el = mount((e) => {
        e.items = ITEMS;
      });
      expect(getComputedStyle(pop(el)).display).toBe('none');

      el.show();
      const cs = getComputedStyle(pop(el));
      expect(cs.display).toBe('flex');
      expect(cs.flexDirection).toBe('column');
      // Absolutely positioned dropdown under the trigger.
      expect(cs.position).toBe('absolute');
    });

    it('renders each popup row at full width with the R4 surface', () => {
      const el = mount((e) => {
        e.items = ITEMS;
      });
      el.show();
      const row = rows(el)[0];
      const cs = getComputedStyle(row);
      expect(cs.display).toBe('flex');
      expect(cs.width).toBe('184px');
      expect(cs.minHeight).toBe('30px');
      expect(cs.borderTopWidth).toBe('1px');
    });

    it('reveals the opened popup frameless — no border, background, or shadow', () => {
      const el = mount((e) => {
        e.items = ITEMS;
      });
      el.show();
      const cs = getComputedStyle(pop(el));
      // The scoops appear directly underneath; the dropdown carries no chrome.
      expect(cs.borderStyle).toBe('none');
      expect(cs.borderTopWidth).toBe('0px');
      expect(cs.boxShadow).toBe('none');
      expect(['rgba(0, 0, 0, 0)', 'transparent']).toContain(cs.backgroundColor);
    });

    it('staggers popup rows via an incremental --i (and animation-delay)', () => {
      const el = mount((e) => {
        e.items = ITEMS;
      });
      el.show();
      const menuRows = rows(el);
      // Each row carries its index in --i, which drives the stagger.
      menuRows.forEach((row, i) => {
        expect(row.style.getPropertyValue('--i')).toBe(String(i));
      });
      // The entrance + per-item delay only exists when motion is allowed.
      const reduced =
        typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (!reduced) {
        const first = getComputedStyle(menuRows[0]);
        const last = getComputedStyle(menuRows[2]);
        expect(first.animationName).toBe('scoopReveal');
        expect(Number.parseFloat(last.animationDelay)).toBeGreaterThan(
          Number.parseFloat(first.animationDelay)
        );
      }
    });

    it('guards the staggered entrance behind prefers-reduced-motion (animation: none)', () => {
      // The @media guard is evaluated by the browser, not a JS matchMedia mock,
      // so assert the adopted stylesheet carries the reduced-motion override.
      const el = mount((e) => {
        e.items = ITEMS;
      });
      const adopted = el.shadowRoot?.adoptedStyleSheets[0] as CSSStyleSheet;
      let guarded = false;
      for (const rule of Array.from(adopted.cssRules)) {
        if (rule instanceof CSSMediaRule && rule.conditionText.includes('prefers-reduced-motion')) {
          for (const inner of Array.from(rule.cssRules)) {
            if (inner instanceof CSSStyleRule && inner.style.animationName === 'none') {
              guarded = true;
            }
          }
        }
      }
      expect(guarded).toBe(true);
    });
  });

  describe('behavior + events', () => {
    it('toggles open on trigger click and stops propagation', () => {
      const el = mount((e) => {
        e.items = ITEMS;
      });
      let bubbled = false;
      document.addEventListener('click', () => {
        bubbled = true;
      });
      moreBtn(el).dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
      expect(el.open).toBe(true);
      // stopPropagation in the handler must prevent the outside-click closer
      // (and our document listener) from seeing this same click.
      expect(bubbled).toBe(false);
    });

    it('closes on a click outside the element', () => {
      const el = mount((e) => {
        e.items = ITEMS;
      });
      el.show();
      expect(el.open).toBe(true);
      document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      expect(el.open).toBe(false);
    });

    it('stays open on a click inside the element', () => {
      const el = mount((e) => {
        e.items = ITEMS;
      });
      el.show();
      el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      expect(el.open).toBe(true);
    });

    it('emits slicc-scoop-select (composed, bubbling) and closes on row click', () => {
      const el = mount((e) => {
        e.items = ITEMS;
      });
      el.show();
      let detail: { id: string; label: string } | null = null;
      el.addEventListener('slicc-scoop-select', (e) => {
        detail = (e as CustomEvent).detail;
      });
      rows(el)[1].dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
      expect(detail).toEqual({ id: 'designer', label: 'designer' });
      expect(el.open).toBe(false);
    });

    it('emits the id as the label fallback when none was supplied', () => {
      const el = mount((e) => {
        e.items = [{ id: 'lonely' }];
      });
      let detail: { id: string; label: string } | null = null;
      el.addEventListener('slicc-scoop-select', (e) => {
        detail = (e as CustomEvent).detail;
      });
      rows(el)[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
      expect(detail).toEqual({ id: 'lonely', label: 'lonely' });
    });

    it('removes the document listener on disconnect (no leak)', () => {
      const el = mount((e) => {
        e.items = ITEMS;
      });
      el.show();
      el.remove();
      // A document click after removal must not throw and the (detached) element
      // keeps whatever state it had — nothing should resurrect the listener.
      expect(() =>
        document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      ).not.toThrow();
    });
  });
});
