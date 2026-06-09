import { beforeEach, describe, expect, it } from 'vitest';
// A sibling element we compose by tag at runtime; importing it here registers
// it so the cloned chips upgrade during the test (allowed for composed siblings).
import '../../src/pill/slicc-pill.js';
import {
  SliccScoopOverflow,
  type SliccScoopOverflowItem,
} from '../../src/switcher/slicc-scoop-overflow.js';
import { ensureGlobalTokens } from '../../src/theme/tokens.js';

const ITEMS: SliccScoopOverflowItem[] = [
  { id: 'researcher', label: 'researcher', color: '#06b6d4' },
  { id: 'designer', label: 'designer', color: '#8b5cf6' },
  { id: 'tester', label: 'tester', color: '#f59e0b', eyes: 'dead' },
];

function mount(setup?: (el: SliccScoopOverflow) => void): SliccScoopOverflow {
  const el = document.createElement('slicc-scoop-overflow') as SliccScoopOverflow;
  setup?.(el);
  document.body.appendChild(el);
  return el;
}

/** The "⋯" trigger button inside the shadow root. */
function moreBtn(el: SliccScoopOverflow): HTMLButtonElement {
  return el.shadowRoot?.querySelector('.morebtn') as HTMLButtonElement;
}

/** The `.switcher-more` wrap inside the shadow root. */
function wrap(el: SliccScoopOverflow): HTMLElement {
  return el.shadowRoot?.querySelector('.switcher-more') as HTMLElement;
}

/** The `.pop` dropdown inside the shadow root. */
function pop(el: SliccScoopOverflow): HTMLElement {
  return el.shadowRoot?.querySelector('.pop') as HTMLElement;
}

/** The cloned overflow pills inside the popup. */
function pills(el: SliccScoopOverflow): HTMLElement[] {
  return Array.from(el.shadowRoot?.querySelectorAll('slicc-pill') ?? []) as HTMLElement[];
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
  });

  it('exposes a slotted "⋯" trigger glyph and an empty slot', () => {
    const el = mount();
    expect(el.shadowRoot?.querySelector('slot[name="more"]')).toBeTruthy();
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

    it('renders one full-width cloned pill per item, carrying the descriptor', () => {
      const el = mount((e) => {
        e.items = ITEMS;
      });
      const chips = pills(el);
      expect(chips).toHaveLength(3);
      expect(chips[0].getAttribute('label')).toBe('researcher');
      expect(chips[0].getAttribute('color')).toBe('#06b6d4');
      expect(chips[0].dataset.k).toBe('researcher');
      // Default eye-state is none; tester overrides to dead.
      expect(chips[0].getAttribute('eyes')).toBe('none');
      expect(chips[2].getAttribute('eyes')).toBe('dead');
    });

    it('escapes interpolated descriptor text', () => {
      const el = mount((e) => {
        e.items = [{ id: 'x"><img>', label: '<script>1</script>' }];
      });
      // No injected nodes leaked into the shadow tree.
      expect(el.shadowRoot?.querySelector('img')).toBeNull();
      expect(el.shadowRoot?.querySelector('script')).toBeNull();
      const chip = pills(el)[0];
      expect(chip.getAttribute('label')).toBe('<script>1</script>');
      expect(chip.dataset.k).toBe('x"><img>');
    });

    it('falls back to id when no label is supplied', () => {
      const el = mount((e) => {
        e.items = [{ id: 'solo' }];
      });
      expect(pills(el)[0].getAttribute('label')).toBe('solo');
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

    it('stretches cloned pills to full width via --pill-w:100%', () => {
      const el = mount((e) => {
        e.items = ITEMS;
      });
      el.show();
      const chip = pills(el)[0];
      expect(getComputedStyle(chip).display).toBe('block');
      expect(getComputedStyle(chip).getPropertyValue('--pill-w').trim()).toBe('100%');
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

    it('emits slicc-scoop-select (composed, bubbling) and closes on chip click', () => {
      const el = mount((e) => {
        e.items = ITEMS;
      });
      el.show();
      let detail: { id: string; label: string } | null = null;
      el.addEventListener('slicc-scoop-select', (e) => {
        detail = (e as CustomEvent).detail;
      });
      pills(el)[1].dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
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
      pills(el)[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
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
