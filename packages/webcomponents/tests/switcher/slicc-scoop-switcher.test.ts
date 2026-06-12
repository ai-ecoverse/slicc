import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../../src/pill/slicc-pill.js';
// Sibling composed BY TAG by the switcher; imported here so it registers and the
// overflow popup's `items` property exists when the reflow feeds it.
import { SliccScoopOverflow } from '../../src/switcher/slicc-scoop-overflow.js';
import {
  type ScoopDescriptor,
  type ScoopSelectDetail,
  SliccScoopSwitcher,
} from '../../src/switcher/slicc-scoop-switcher.js';
import { ensureGlobalTokens } from '../../src/theme/tokens.js';

const ROSTER: ScoopDescriptor[] = [
  { key: 'cone', type: 'cone', color: '#b07823', label: 'Sliccy', eyes: 'open' },
  { key: 'researcher', type: 'scoop', color: '#06b6d4', label: 'researcher', eyes: 'none' },
  { key: 'designer', type: 'scoop', color: '#8b5cf6', label: 'designer', eyes: 'none' },
  { key: 'tester', type: 'scoop', color: '#f59e0b', label: 'tester', eyes: 'dead' },
];

/** Mount a switcher with the given roster and (optionally) active key. */
function mount(scoops: ScoopDescriptor[] = ROSTER, active?: string): SliccScoopSwitcher {
  const el = document.createElement('slicc-scoop-switcher') as SliccScoopSwitcher;
  el.scoops = scoops;
  if (active) el.active = active;
  document.body.appendChild(el);
  return el;
}

/** The rendered chip `slicc-pill`s inside the row. */
function chips(el: SliccScoopSwitcher): HTMLElement[] {
  return [...el.querySelectorAll<HTMLElement>('slicc-pill.scoop')];
}

/** The composed overflow sibling (created lazily after the row), if present. */
function overflow(el: SliccScoopSwitcher): SliccScoopOverflow | null {
  return el.nextElementSibling instanceof SliccScoopOverflow ? el.nextElementSibling : null;
}

describe('slicc-scoop-switcher', () => {
  beforeEach(() => {
    ensureGlobalTokens();
    document.body.replaceChildren();
  });

  it('registers the custom element', () => {
    expect(customElements.get('slicc-scoop-switcher')).toBe(SliccScoopSwitcher);
  });

  it('renders into light DOM (no shadow root) and carries the scoped host class + row part', () => {
    const el = mount();
    expect(el.shadowRoot).toBeNull();
    expect(el.classList.contains('slicc-scoop-switcher')).toBe(true);
    expect(el.getAttribute('part')).toBe('row');
  });

  it('injects its scoped stylesheet once', () => {
    mount();
    mount();
    expect(document.querySelectorAll('#slicc-scoop-switcher-style')).toHaveLength(1);
  });

  describe('chip composition', () => {
    it('renders one <slicc-pill> per scoop, cone first', () => {
      const el = mount();
      const cs = chips(el);
      expect(cs).toHaveLength(4);
      expect(cs[0].dataset.k).toBe('cone');
      expect(cs[0].getAttribute('type')).toBe('cone');
      expect(cs[1].dataset.k).toBe('researcher');
    });

    it('forwards color, label and eyes to each pill', () => {
      const el = mount();
      const researcher = chips(el)[1];
      expect(researcher.getAttribute('color')).toBe('#06b6d4');
      expect(researcher.getAttribute('label')).toBe('researcher');
      expect(researcher.getAttribute('eyes')).toBe('none');
    });

    it('forwards the context fill onto the pill (clamped 0-100), omitting it otherwise', () => {
      const el = mount([
        { key: 'cone', type: 'cone', label: 'sliccy', fill: 42 },
        { key: 'hot', type: 'scoop', label: 'hot', fill: 250 },
        { key: 'fresh', type: 'scoop', label: 'fresh' },
      ]);
      const byKey = (k: string) => chips(el).find((c) => c.dataset.k === k);
      expect(byKey('cone')?.getAttribute('fill')).toBe('42');
      expect(byKey('hot')?.getAttribute('fill')).toBe('100');
      expect(byKey('fresh')?.hasAttribute('fill')).toBe(false);
    });

    it('marks an ephemeral scoop chip with the ephemeral class', () => {
      const el = mount([
        ROSTER[0],
        { key: 'triage', type: 'scoop', color: '#10b981', label: 'triage', ephemeral: true },
      ]);
      const triage = chips(el).find((c) => c.dataset.k === 'triage');
      expect(triage?.classList.contains('ephemeral')).toBe(true);
    });

    it('escapes interpolated label/key text', () => {
      const el = mount([{ key: 'cone', type: 'cone', label: '<img src=x>' }]);
      // The label round-trips as an attribute value, not parsed markup.
      expect(chips(el)[0].getAttribute('label')).toBe('<img src=x>');
      expect(el.querySelector('img')).toBeNull();
    });
  });

  describe('scoops property', () => {
    it('returns a defensive copy (mutating the result does not affect state)', () => {
      const el = mount();
      const got = el.scoops;
      got[0].label = 'mutated';
      expect(el.scoops[0].label).toBe('Sliccy');
    });

    it('re-renders when the scoops list is replaced', () => {
      const el = mount();
      el.scoops = [{ key: 'cone', type: 'cone', label: 'Solo' }];
      expect(chips(el)).toHaveLength(1);
      expect(chips(el)[0].getAttribute('label')).toBe('Solo');
    });

    it('tolerates a non-array assignment by clearing the row', () => {
      const el = mount();
      // @ts-expect-error — exercising the runtime guard.
      el.scoops = null;
      expect(chips(el)).toHaveLength(0);
    });
  });

  describe('active reflection + state', () => {
    it('reflects the active attribute to the property', () => {
      const el = mount(ROSTER, 'researcher');
      expect(el.active).toBe('researcher');
      el.active = 'designer';
      expect(el.getAttribute('active')).toBe('designer');
      el.active = null;
      expect(el.hasAttribute('active')).toBe(false);
    });

    it('marks only the active chip with the active attribute/class', () => {
      const el = mount(ROSTER, 'cone');
      el.active = 'researcher';
      const active = chips(el).filter((c) => c.hasAttribute('active'));
      expect(active).toHaveLength(1);
      expect(active[0].dataset.k).toBe('researcher');
      expect(active[0].classList.contains('active')).toBe(true);
    });

    it('renders the active chip with the active attribute on initial paint', () => {
      const el = mount(ROSTER, 'designer');
      const designer = chips(el).find((c) => c.dataset.k === 'designer');
      expect(designer?.hasAttribute('active')).toBe(true);
    });

    it('keeps a dead-eyed scoop chip (the failed look) when it wears the eyes', () => {
      // Eyes show one-pair-at-a-time now: the dead look survives the gating
      // but only renders on the chip's turn (attention / hover).
      const el = mount();
      el.setAttribute('attention', 'tester');
      const tester = chips(el).find((c) => c.dataset.k === 'tester');
      expect(tester?.getAttribute('eyes')).toBe('dead');
    });
  });

  describe('data-k hue variants', () => {
    it('resolves each known data-k to its prototype hue token', () => {
      const el = mount([
        { key: 'cone', type: 'cone', label: 'c' },
        { key: 'researcher', type: 'scoop', label: 'r' },
        { key: 'designer', type: 'scoop', label: 'd' },
        { key: 'tester', type: 'scoop', label: 't' },
        { key: 'triage', type: 'scoop', label: 'g' },
      ]);
      const hue = (k: string) =>
        chips(el)
          .find((c) => c.dataset.k === k)
          ?.style.getPropertyValue('--h');
      expect(hue('cone')).toBe('var(--waffle)');
      expect(hue('researcher')).toBe('var(--cyan)');
      expect(hue('designer')).toBe('var(--violet)');
      expect(hue('tester')).toBe('var(--amber)');
      expect(hue('triage')).toBe('var(--green)');
    });

    it('falls back to --rose for an unknown data-k', () => {
      const el = mount([{ key: 'wildcard', type: 'scoop', label: 'w' }]);
      expect(chips(el)[0].style.getPropertyValue('--h')).toBe('var(--rose)');
    });
  });

  describe('selection events', () => {
    it('emits slicc-scoop-select with { id, key, label } when a chip is clicked', () => {
      const el = mount();
      const detail = vi.fn();
      el.addEventListener('slicc-scoop-select', (e) =>
        detail((e as CustomEvent<ScoopSelectDetail>).detail)
      );
      chips(el)[1].dispatchEvent(new MouseEvent('click', { bubbles: true }));
      expect(detail).toHaveBeenCalledWith({
        id: 'researcher',
        key: 'researcher',
        label: 'researcher',
      });
      expect(el.active).toBe('researcher');
    });

    it('bubbles + is composed so ancestors can listen', () => {
      const el = mount();
      const seen = vi.fn();
      document.body.addEventListener('slicc-scoop-select', seen);
      el.select('designer');
      expect(seen).toHaveBeenCalledTimes(1);
      document.body.removeEventListener('slicc-scoop-select', seen);
    });

    it('select() sets the active chip and emits', () => {
      const el = mount();
      const detail = vi.fn();
      el.addEventListener('slicc-scoop-select', (e) =>
        detail((e as CustomEvent<ScoopSelectDetail>).detail.key)
      );
      el.select('tester');
      expect(el.active).toBe('tester');
      expect(detail).toHaveBeenCalledWith('tester');
    });
  });

  describe('overflow reflow', () => {
    it('hides chips that do not fit and feeds them to the overflow popup (never the cone)', () => {
      const el = mount();
      // Force a tight row so only the cone fits.
      el.style.cssText = 'display:flex;width:120px;overflow:hidden;';
      el.reflow();
      const hidden = chips(el).filter((c) => c.classList.contains('hide'));
      const coneChip = chips(el).find((c) => c.dataset.k === 'cone');
      expect(coneChip?.classList.contains('hide')).toBe(false);
      expect(hidden.length).toBeGreaterThan(0);
      const ofl = overflow(el);
      expect(ofl).not.toBeNull();
      expect(ofl?.items.length).toBe(hidden.length);
      // Overflow items carry the prototype `id` (== key) + label.
      expect(ofl?.items.every((it) => typeof it.id === 'string' && it.id.length > 0)).toBe(true);
    });

    it('restores hidden chips and empties the popup when the row has room again', () => {
      const el = mount();
      el.style.cssText = 'display:flex;width:120px;overflow:hidden;';
      el.reflow();
      expect(overflow(el)?.items.length).toBeGreaterThan(0);
      // Widen so everything fits, reflow again.
      el.style.width = '2000px';
      el.reflow();
      expect(chips(el).some((c) => c.classList.contains('hide'))).toBe(false);
      expect(overflow(el)?.items.length).toBe(0);
    });

    it('un-hides chips when the flex CONTAINER grows (no manual reflow)', async () => {
      // The host's width is content-driven (flex: 0 1 auto): hiding chips
      // SHRINKS the host, so its own ResizeObserver goes quiet right when
      // surrounding space frees up (e.g. the freezer rail collapsing after
      // boot). The parent observation must retrigger the fit decision —
      // before it, a transient squeeze left "⋯" stuck despite a wide navbar.
      const container = document.createElement('div');
      container.style.cssText = 'display:flex;width:120px;overflow:hidden;';
      const el = document.createElement('slicc-scoop-switcher') as SliccScoopSwitcher;
      el.scoops = ROSTER;
      el.style.cssText = 'display:flex;flex:0 1 auto;overflow:hidden;min-width:0;';
      container.appendChild(el);
      document.body.appendChild(container);
      await vi.waitFor(() => {
        expect(chips(el).some((c) => c.classList.contains('hide'))).toBe(true);
      });

      container.style.width = '2000px';
      await vi.waitFor(() => {
        expect(chips(el).some((c) => c.classList.contains('hide'))).toBe(false);
        expect(overflow(el)?.items.length ?? 0).toBe(0);
      });
    });

    it('re-emits the overflow popup selection as the switcher select event', () => {
      const el = mount();
      el.style.cssText = 'display:flex;width:120px;overflow:hidden;';
      el.reflow();
      const ofl = overflow(el);
      expect(ofl).not.toBeNull();
      const detail = vi.fn();
      el.addEventListener('slicc-scoop-select', (e) =>
        detail((e as CustomEvent<ScoopSelectDetail>).detail.key)
      );
      // Simulate the popup emitting its own select for a hidden scoop.
      const hidden = ofl!.items[0];
      ofl!.dispatchEvent(
        new CustomEvent('slicc-scoop-select', {
          detail: { id: hidden.id, label: hidden.label ?? hidden.id },
          bubbles: true,
          composed: true,
        })
      );
      expect(detail).toHaveBeenCalledWith(hidden.id);
      expect(el.active).toBe(hidden.id);
    });
  });

  describe('eyes: one pair at a time (hover > attention)', () => {
    const EYED: ScoopDescriptor[] = [
      { key: 'cone', type: 'cone', color: '#b07823', label: 'Sliccy', eyes: 'open' },
      { key: 'researcher', type: 'scoop', color: '#06b6d4', label: 'researcher', eyes: 'open' },
      { key: 'tester', type: 'scoop', color: '#f59e0b', label: 'tester', eyes: 'dead' },
    ];
    const byKey = (el: SliccScoopSwitcher, k: string): HTMLElement =>
      chips(el).find((c) => c.dataset.k === k) as HTMLElement;

    it('only the attention chip wears eyes — blinking; everyone else goes eyeless', () => {
      const el = mount(EYED);
      el.setAttribute('attention', 'researcher');
      expect(byKey(el, 'researcher').getAttribute('eyes')).toBe('open');
      expect(byKey(el, 'researcher').hasAttribute('blink')).toBe(true);
      expect(byKey(el, 'cone').getAttribute('eyes')).toBe('none');
      expect(byKey(el, 'tester').getAttribute('eyes')).toBe('none');
    });

    it('the hovered chip wins with a steady gaze; pointerleave restores the blink', () => {
      const el = mount(EYED);
      el.setAttribute('attention', 'researcher');
      byKey(el, 'cone').dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
      expect(byKey(el, 'cone').getAttribute('eyes')).toBe('open');
      expect(byKey(el, 'cone').hasAttribute('blink')).toBe(false);
      expect(byKey(el, 'researcher').getAttribute('eyes')).toBe('none');

      el.dispatchEvent(new PointerEvent('pointerleave'));
      expect(byKey(el, 'cone').getAttribute('eyes')).toBe('none');
      expect(byKey(el, 'researcher').getAttribute('eyes')).toBe('open');
      expect(byKey(el, 'researcher').hasAttribute('blink')).toBe(true);
    });

    it('a dead chip keeps its X-eyes on its turn and never blinks', () => {
      const el = mount(EYED);
      el.setAttribute('attention', 'tester');
      expect(byKey(el, 'tester').getAttribute('eyes')).toBe('dead');
      expect(byKey(el, 'tester').hasAttribute('blink')).toBe(false);
    });

    it('with no attention and no hover, nobody wears eyes', () => {
      const el = mount(EYED);
      for (const k of ['cone', 'researcher', 'tester']) {
        expect(byKey(el, k).getAttribute('eyes')).toBe('none');
      }
    });
  });

  describe('slotted adoption', () => {
    it('adopts pre-existing slicc-pill children into the scoops list at connect', () => {
      const el = document.createElement('slicc-scoop-switcher') as SliccScoopSwitcher;
      el.innerHTML =
        '<slicc-pill data-k="cone" type="cone" color="#b07823" label="Sliccy" eyes="open"></slicc-pill>' +
        '<slicc-pill data-k="researcher" type="scoop" color="#06b6d4" label="researcher" eyes="none"></slicc-pill>';
      document.body.appendChild(el);
      expect(el.scoops.map((s) => s.key)).toEqual(['cone', 'researcher']);
      // The originals are rebuilt canonically (still two chips).
      expect(chips(el)).toHaveLength(2);
    });
  });

  describe('lifecycle', () => {
    it('drops the click listener on disconnect (no select after removal)', () => {
      const el = mount();
      const chip = chips(el)[1];
      el.remove();
      const detail = vi.fn();
      el.addEventListener('slicc-scoop-select', detail);
      chip.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      expect(detail).not.toHaveBeenCalled();
    });
  });

  describe('computed appearance (real Chromium)', () => {
    it('lays the row out as a non-wrapping flex row with the 6px gap', () => {
      const el = mount();
      const cs = getComputedStyle(el);
      expect(cs.display).toBe('flex');
      expect(cs.flexWrap).toBe('nowrap');
      expect(cs.columnGap).toBe('6px');
    });

    it('paints the active scoop pill with its accent fill', () => {
      const el = mount(ROSTER, 'researcher');
      const researcher = chips(el).find((c) => c.dataset.k === 'researcher') as HTMLElement;
      const pill = researcher.shadowRoot?.querySelector('.pill') as HTMLElement;
      // #06b6d4 → rgb(6, 182, 212).
      expect(getComputedStyle(pill).backgroundColor).toBe('rgb(6, 182, 212)');
    });

    it('hides an overflow-collapsed chip with display:none', () => {
      const el = mount();
      el.style.cssText = 'display:flex;width:120px;overflow:hidden;';
      el.reflow();
      const hidden = chips(el).find((c) => c.classList.contains('hide')) as HTMLElement;
      expect(hidden).toBeTruthy();
      expect(getComputedStyle(hidden).display).toBe('none');
    });
  });
});
