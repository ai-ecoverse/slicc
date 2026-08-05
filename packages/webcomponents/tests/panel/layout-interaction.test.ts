/**
 * Drag-to-move and drag-to-resize on `<slicc-layout>`.
 *
 * Real Chromium, real pointer events, real geometry — the point is that the GESTURE
 * works end to end, not that the zone bookkeeping is right (`zone-ops.test.ts`
 * covers that). They exist because the first cut of the panel system rendered
 * arrangements correctly but shipped no way to change one by hand.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LAYOUT_SCHEMA_VERSION, type LayoutDocument } from '../../src/panel/layout-schema.js';
import type { LayoutChangeDetail } from '../../src/panel/slicc-layout.js';
import { SliccLayout } from '../../src/panel/slicc-layout.js';
import { type PanelMeta, SliccPanel } from '../../src/panel/slicc-panel.js';

class TestPanel extends SliccPanel {
  static readonly panelMeta: PanelMeta = { id: 'test', title: 'Test' };
}
if (!customElements.get('interaction-test-panel')) {
  customElements.define('interaction-test-panel', TestPanel);
}

function doc(base: LayoutDocument['base'], over: Partial<LayoutDocument> = {}): LayoutDocument {
  return { version: LAYOUT_SCHEMA_VERSION, id: 'test', base, ...over };
}

function mount(ids: string[]): SliccLayout {
  // `new` rather than `createElement` + cast: every other reference to
  // `SliccLayout` here is a type position, so the import would be elided and the
  // element's `define()` side effect never run.
  const layout = new SliccLayout();
  layout.style.cssText = 'width:800px;height:600px;';
  for (const id of ids) {
    const panel = document.createElement('interaction-test-panel') as SliccPanel;
    panel.setAttribute('panel-id', id);
    layout.appendChild(panel);
  }
  document.body.appendChild(layout);
  return layout;
}

function slotOf(layout: SliccLayout, panelId: string): HTMLElement {
  return layout.querySelector(`.slicc-layout__slot[data-panel-id="${panelId}"]`) as HTMLElement;
}

function gripOf(layout: SliccLayout, panelId: string): HTMLElement | null {
  return slotOf(layout, panelId)?.querySelector('.slicc-layout__move') ?? null;
}

function targets(layout: SliccLayout): HTMLElement[] {
  return [...layout.querySelectorAll('.slicc-layout__target')] as HTMLElement[];
}

function targetFor(layout: SliccLayout, zone: string): HTMLElement {
  return targets(layout).find((t) => t.dataset.zone === zone) as HTMLElement;
}

function centerOf(el: HTMLElement): { x: number; y: number } {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

function pointer(type: string, x: number, y: number, target: EventTarget = window): void {
  target.dispatchEvent(
    new PointerEvent(type, {
      clientX: x,
      clientY: y,
      pointerId: 1,
      bubbles: true,
      cancelable: true,
    })
  );
}

/** Grab a panel's grip, leaving the drag in progress. */
function grab(layout: SliccLayout, panelId: string): HTMLElement {
  const grip = gripOf(layout, panelId);
  if (!grip) throw new Error(`no move button for "${panelId}"`);
  const from = centerOf(grip);
  pointer('pointerdown', from.x, from.y, grip);
  return grip;
}

/** Grab `panelId` and drop it on `zone`'s target. */
function dragToZone(layout: SliccLayout, panelId: string, zone: string): void {
  grab(layout, panelId);
  const c = centerOf(targetFor(layout, zone));
  pointer('pointermove', c.x, c.y);
  pointer('pointerup', c.x, c.y);
}

beforeEach(() => {
  document.body.replaceChildren();
});

describe('the move button', () => {
  it('is rendered on every unlocked panel in a zone', () => {
    const layout = mount(['chat', 'files']);
    layout.setLayout(doc({ zones: { center: ['chat'], right: ['files'] } }));
    expect(gripOf(layout, 'chat')).not.toBeNull();
    expect(gripOf(layout, 'files')).not.toBeNull();
  });

  it('is HIDDEN until the slot is hovered, so panels carry no permanent chrome', () => {
    const layout = mount(['chat']);
    layout.setLayout(doc({ zones: { center: ['chat'] } }));
    const grip = gripOf(layout, 'chat') as HTMLElement;
    expect(getComputedStyle(grip).opacity).toBe('0');
    expect(getComputedStyle(grip).pointerEvents).toBe('none');
  });

  it('sits ON ITS OWN PANEL, not in the layout’s corner', () => {
    // The slot must be the grip's containing block. Without `position: relative`
    // on it, `position: absolute` resolved against the layout ROOT — so every
    // panel's grip stacked at (4, 4) of the whole layout. Measured, because a
    // CSS-contract assertion would have passed straight through this.
    const layout = mount(['chat', 'files']);
    layout.setLayout(doc({ zones: { center: ['chat'], right: ['files'] } }));

    for (const id of ['chat', 'files']) {
      const slot = slotOf(layout, id).getBoundingClientRect();
      const grip = (gripOf(layout, id) as HTMLElement).getBoundingClientRect();
      expect(grip.left).toBeGreaterThanOrEqual(slot.left);
      expect(grip.top).toBeGreaterThanOrEqual(slot.top);
      expect(grip.right).toBeLessThanOrEqual(slot.right);
      expect(grip.bottom).toBeLessThanOrEqual(slot.bottom);
    }
    const a = (gripOf(layout, 'chat') as HTMLElement).getBoundingClientRect();
    const b = (gripOf(layout, 'files') as HTMLElement).getBoundingClientRect();
    expect(Math.abs(a.left - b.left)).toBeGreaterThan(100);
  });

  it('names the panel for assistive tech, since there is no visible label', () => {
    const layout = mount(['chat']);
    layout.setLayout(doc({ zones: { center: ['chat'] } }));
    expect((gripOf(layout, 'chat') as HTMLElement).getAttribute('aria-label')).toBe('Move chat');
  });

  it('is absent on a LOCKED panel — nothing to click, matching "cannot move"', () => {
    const layout = mount(['chat']);
    layout.setLayout(doc({ zones: { center: ['chat'] } }, { panels: { chat: { locked: true } } }));
    expect(gripOf(layout, 'chat')).toBeNull();
  });

  it('is absent everywhere under a document-wide lock (the Cherry case)', () => {
    const layout = mount(['chat', 'files']);
    layout.setLayout(doc({ zones: { center: ['chat'], right: ['files'] } }, { locked: true }));
    expect(layout.querySelectorAll('.slicc-layout__move')).toHaveLength(0);
  });

  it('is absent on panels in a locked ZONE', () => {
    const layout = mount(['chat', 'files']);
    layout.setLayout(doc({ zones: { center: ['chat'], top: ['files'], locked: ['top'] } }));
    expect(gripOf(layout, 'chat')).not.toBeNull();
    expect(gripOf(layout, 'files')).toBeNull();
  });

  it('is absent on DOCKED panels — the chrome has one correct position', () => {
    const layout = mount(['rail', 'chat']);
    layout.setLayout(
      doc({
        docks: [{ edge: 'left', size: '44px', panels: ['rail'] }],
        zones: { center: ['chat'] },
      })
    );
    expect(layout.querySelectorAll('.slicc-layout__move')).toHaveLength(1);
    expect(gripOf(layout, 'chat')).not.toBeNull();
  });
});

describe('the five zone drop targets', () => {
  it('shows NOTHING until a drag starts', () => {
    const layout = mount(['chat']);
    layout.setLayout(doc({ zones: { center: ['chat'] } }));
    expect(targets(layout)).toHaveLength(0);
  });

  it('shows exactly FIVE, whatever is open', () => {
    // The whole reason for the zone model: the previous design offered five
    // positions PER PANEL, so the number of choices grew with the screen.
    const layout = mount(['chat', 'a', 'b', 'c']);
    layout.setLayout(doc({ zones: { center: ['chat'], top: ['a'], right: ['b'], bottom: ['c'] } }));
    grab(layout, 'chat');
    expect(targets(layout)).toHaveLength(5);
    expect(targets(layout).map((t) => t.dataset.zone)).toEqual([
      'top',
      'left',
      'center',
      'right',
      'bottom',
    ]);
  });

  it('lays them out as a compass', () => {
    const layout = mount(['chat']);
    layout.setLayout(doc({ zones: { center: ['chat'] } }));
    grab(layout, 'chat');
    const at = (zone: string) => targetFor(layout, zone).getBoundingClientRect();

    expect(at('top').top).toBeLessThan(at('center').top);
    expect(at('bottom').top).toBeGreaterThan(at('center').top);
    expect(at('left').left).toBeLessThan(at('center').left);
    expect(at('right').left).toBeGreaterThan(at('center').left);
  });

  it('positions them INSIDE the fixed chrome, never over it', () => {
    // The user's constraint: "the top is below the top bar of scoops, and the left
    // is right of the left rail". The badges must promise the same region the
    // zones actually occupy.
    const layout = mount(['strip', 'rail', 'chat']);
    layout.setLayout(
      doc({
        docks: [
          { edge: 'top', size: '36px', panels: ['strip'] },
          { edge: 'left', size: '44px', panels: ['rail'] },
        ],
        zones: { center: ['chat'] },
      })
    );
    grab(layout, 'chat');
    const work = (
      layout.querySelector('.slicc-layout__work') as HTMLElement
    ).getBoundingClientRect();

    for (const zone of ['top', 'left', 'center', 'right', 'bottom']) {
      const badge = targetFor(layout, zone).getBoundingClientRect();
      expect(badge.top).toBeGreaterThanOrEqual(work.top - 1);
      expect(badge.left).toBeGreaterThanOrEqual(work.left - 1);
      expect(badge.bottom).toBeLessThanOrEqual(work.bottom + 1);
    }
    // …and the working area itself starts below the strip and right of the rail.
    expect(work.top).toBeGreaterThanOrEqual(36);
    expect(work.left).toBeGreaterThanOrEqual(44);
  });

  it('HIGHLIGHTS the one under the cursor, and only that one', () => {
    const layout = mount(['chat']);
    layout.setLayout(doc({ zones: { center: ['chat'] } }));
    grab(layout, 'chat');
    const top = targetFor(layout, 'top');
    const c = centerOf(top);
    pointer('pointermove', c.x, c.y);

    expect(top.classList.contains('slicc-layout__target--hot')).toBe(true);
    expect(
      targets(layout).filter((t) => t.classList.contains('slicc-layout__target--hot'))
    ).toHaveLength(1);
  });

  it('labels each with its zone name', () => {
    const layout = mount(['chat']);
    layout.setLayout(doc({ zones: { center: ['chat'] } }));
    grab(layout, 'chat');
    expect(targetFor(layout, 'bottom').title).toBe('Move to Bottom');
    expect(targetFor(layout, 'bottom').textContent).toContain('Bottom');
  });

  it('CLEARS them all on release', () => {
    const layout = mount(['chat']);
    layout.setLayout(doc({ zones: { center: ['chat'] } }));
    grab(layout, 'chat');
    pointer('pointerup', 5, 5);
    expect(targets(layout)).toHaveLength(0);
  });

  it('clears them when a drag is abandoned by disconnect', () => {
    const layout = mount(['chat']);
    layout.setLayout(doc({ zones: { center: ['chat'] } }));
    grab(layout, 'chat');
    layout.remove();
    expect(targets(layout)).toHaveLength(0);
  });
});

describe('dropping a panel into a zone', () => {
  it('moves it there', () => {
    const layout = mount(['chat', 'files']);
    layout.setLayout(doc({ zones: { center: ['chat'], right: ['files'] } }));

    dragToZone(layout, 'chat', 'bottom');

    const zones = layout.getLayout().base.zones;
    expect(zones?.center).toEqual([]);
    expect(zones?.bottom).toEqual(['chat']);
  });

  it('re-renders the DOM, not just the document', () => {
    const layout = mount(['chat', 'files']);
    layout.setLayout(doc({ zones: { center: ['chat'], top: ['files'] } }));

    dragToZone(layout, 'chat', 'bottom');

    const chat = slotOf(layout, 'chat').getBoundingClientRect();
    const files = slotOf(layout, 'files').getBoundingClientRect();
    expect(chat.top).toBeGreaterThan(files.top);
    expect(slotOf(layout, 'chat').dataset.zone).toBe('bottom');
  });

  it('JOINS a zone that already has a panel — two panels on one side', () => {
    // The explicit requirement: "there can be two panels on the left side".
    const layout = mount(['chat', 'files']);
    layout.setLayout(doc({ zones: { center: ['chat'], left: ['files'] } }));

    dragToZone(layout, 'chat', 'left');

    expect(layout.getLayout().base.zones?.left).toEqual(['files', 'chat']);
    // Both really render, in the left zone.
    expect(slotOf(layout, 'chat').dataset.zone).toBe('left');
    expect(slotOf(layout, 'files').dataset.zone).toBe('left');
  });

  it('stacks two panels in the left zone by default, and can put them side by side', () => {
    const layout = mount(['a', 'b']);
    layout.setLayout(doc({ zones: { left: ['a', 'b'] } }));
    let ra = slotOf(layout, 'a').getBoundingClientRect();
    let rb = slotOf(layout, 'b').getBoundingClientRect();
    expect(rb.top).toBeGreaterThan(ra.top);
    expect(Math.abs(ra.left - rb.left)).toBeLessThan(2);

    layout.setLayout(doc({ zones: { left: ['a', 'b'], axes: { left: 'row' } } }));
    ra = slotOf(layout, 'a').getBoundingClientRect();
    rb = slotOf(layout, 'b').getBoundingClientRect();
    expect(rb.left).toBeGreaterThan(ra.left);
    expect(Math.abs(ra.top - rb.top)).toBeLessThan(2);
  });

  it('fires slicc-layout-change with reason "rearrange" so a host can persist it', () => {
    const layout = mount(['chat']);
    layout.setLayout(doc({ zones: { center: ['chat'] } }));
    const seen: LayoutChangeDetail['reason'][] = [];
    layout.addEventListener('slicc-layout-change', (e) => seen.push(e.detail.reason));

    dragToZone(layout, 'chat', 'top');
    expect(seen).toContain('rearrange');
  });

  it('is a no-op when dropped on the zone it already occupies', () => {
    const layout = mount(['chat']);
    layout.setLayout(doc({ zones: { center: ['chat'] } }));
    const onChange = vi.fn();
    layout.addEventListener('slicc-layout-change', onChange);

    dragToZone(layout, 'chat', 'center');

    expect(layout.getLayout().base.zones?.center).toEqual(['chat']);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('cancels cleanly when released outside the layout', () => {
    const layout = mount(['chat']);
    const before = doc({ zones: { center: ['chat'] } });
    layout.setLayout(before);

    grab(layout, 'chat');
    pointer('pointermove', 5000, 5000);
    pointer('pointerup', 5000, 5000);

    expect(layout.getLayout().base.zones).toEqual(before.base.zones);
  });

  it('accepts a coarse drop onto a zone’s area, not just its badge', () => {
    const layout = mount(['chat', 'files']);
    layout.setLayout(doc({ zones: { center: ['chat'], bottom: ['files'] } }));

    grab(layout, 'chat');
    const area = centerOf(slotOf(layout, 'files'));
    pointer('pointermove', area.x, area.y);
    pointer('pointerup', area.x, area.y);

    expect(layout.getLayout().base.zones?.bottom).toEqual(['files', 'chat']);
  });

  it('edits the matched VARIANT, not base', () => {
    // A variant replaces the working area, so an edit written to `base` would
    // appear to do nothing at this width — the drag would visibly snap back.
    const layout = mount(['chat']);
    layout.style.width = '500px';
    layout.setLayout(
      doc(
        { zones: { center: ['chat'] } },
        { variants: [{ when: { maxWidth: 700 }, zones: { center: ['chat'] } }] }
      )
    );

    dragToZone(layout, 'chat', 'top');

    const saved = layout.getLayout();
    expect(saved.base.zones?.center).toEqual(['chat']);
    expect(saved.variants?.[0].zones?.top).toEqual(['chat']);
  });
});

describe('resizing panels within a zone', () => {
  /** Two stacked panels in the left zone, and the divider between them. */
  function stacked(): { layout: SliccLayout; divider: HTMLElement } {
    const layout = mount(['a', 'b']);
    layout.setLayout(doc({ zones: { left: ['a', 'b'], sizes: { left: '400px' } } }));
    const divider = layout.querySelector('.slicc-layout__divider') as HTMLElement;
    return { layout, divider };
  }

  it('renders a divider between two panels in the same zone', () => {
    const { divider } = stacked();
    expect(divider).not.toBeNull();
    // Stacked (col axis) → a row-resize cursor.
    expect(getComputedStyle(divider).cursor).toBe('row-resize');
  });

  it('renders NO divider for a single panel', () => {
    const layout = mount(['a']);
    layout.setLayout(doc({ zones: { left: ['a'] } }));
    expect(layout.querySelector('.slicc-layout__divider')).toBeNull();
  });

  it('renders NO divider in a locked zone', () => {
    const layout = mount(['a', 'b']);
    layout.setLayout(doc({ zones: { left: ['a', 'b'], locked: ['left'] } }));
    expect(layout.querySelector('.slicc-layout__divider')).toBeNull();
  });

  it('GROWS the first panel when dragged down', () => {
    const { layout, divider } = stacked();
    const before = slotOf(layout, 'a').getBoundingClientRect().height;
    const from = centerOf(divider);

    pointer('pointerdown', from.x, from.y, divider);
    pointer('pointermove', from.x, from.y + 120);
    pointer('pointerup', from.x, from.y + 120);

    expect(slotOf(layout, 'a').getBoundingClientRect().height).toBeGreaterThan(before + 80);
  });

  it('writes weights into the document, so a save round-trips', () => {
    const { layout, divider } = stacked();
    const from = centerOf(divider);
    pointer('pointerdown', from.x, from.y, divider);
    pointer('pointermove', from.x, from.y + 120);
    pointer('pointerup', from.x, from.y + 120);

    const panels = layout.getLayout().panels;
    expect(Number(panels?.a?.size)).toBeGreaterThan(Number(panels?.b?.size));
  });

  it('STOPS at pointerup — it must not keep resizing on a free-moving mouse', () => {
    // Capture lives on the HOST: each frame rebuilds this very divider, and a
    // captured element removed from the DOM loses capture per spec, which once
    // left the drag running after release.
    const { layout, divider } = stacked();
    const from = centerOf(divider);
    pointer('pointerdown', from.x, from.y, divider);
    pointer('pointermove', from.x, from.y + 100);
    pointer('pointerup', from.x, from.y + 100);
    const settled = slotOf(layout, 'a').getBoundingClientRect().height;

    pointer('pointermove', from.x, from.y + 400);
    expect(slotOf(layout, 'a').getBoundingClientRect().height).toBeCloseTo(settled, 0);
  });

  it('clamps so neither panel can be squeezed away', () => {
    const { layout, divider } = stacked();
    const from = centerOf(divider);
    pointer('pointerdown', from.x, from.y, divider);
    pointer('pointermove', from.x, from.y - 10_000);
    pointer('pointerup', from.x, from.y - 10_000);

    expect(slotOf(layout, 'a').getBoundingClientRect().height).toBeGreaterThan(0);
  });

  it('fires ONE change event for the whole drag, not one per frame', () => {
    // A persisting host would otherwise write a file ~60×/second for one gesture.
    const { layout, divider } = stacked();
    const onChange = vi.fn();
    layout.addEventListener('slicc-layout-change', onChange);
    const from = centerOf(divider);

    pointer('pointerdown', from.x, from.y, divider);
    for (let i = 1; i <= 8; i++) pointer('pointermove', from.x, from.y + i * 10);
    pointer('pointerup', from.x, from.y + 80);

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0].detail.reason).toBe('resize');
  });

  it('uses a COL-resize cursor for a side-by-side zone', () => {
    const layout = mount(['a', 'b']);
    layout.setLayout(doc({ zones: { left: ['a', 'b'], axes: { left: 'row' } } }));
    const divider = layout.querySelector('.slicc-layout__divider') as HTMLElement;
    expect(getComputedStyle(divider).cursor).toBe('col-resize');
  });

  it('renders one divider per adjacent pair with three panels in a zone', () => {
    const layout = mount(['a', 'b', 'c']);
    layout.setLayout(doc({ zones: { center: ['a', 'b', 'c'] } }));
    expect(layout.querySelectorAll('.slicc-layout__divider')).toHaveLength(2);
  });
});

describe('resizing the ZONES themselves', () => {
  /** left | center | right, with the seams between them. */
  function threeAcross(): SliccLayout {
    const layout = mount(['l', 'c', 'r']);
    layout.setLayout(
      doc({
        zones: {
          left: ['l'],
          center: ['c'],
          right: ['r'],
          sizes: { left: '200px', right: '150px' },
        },
      })
    );
    return layout;
  }

  function zoneDividers(layout: SliccLayout): HTMLElement[] {
    return [...layout.querySelectorAll('.slicc-layout__divider--zone')] as HTMLElement[];
  }

  function seam(layout: SliccLayout, before: string, after: string): HTMLElement {
    return zoneDividers(layout).find(
      (d) => d.dataset.zoneBefore === before && d.dataset.zoneAfter === after
    ) as HTMLElement;
  }

  function zoneRect(layout: SliccLayout, zone: string): DOMRect {
    return (
      layout.querySelector(`.slicc-layout__zone--${zone}`) as HTMLElement
    ).getBoundingClientRect();
  }

  it('renders a seam between each pair of adjacent rendered zones', () => {
    const layout = mount(['t', 'l', 'c', 'r', 'b']);
    layout.setLayout(
      doc({
        zones: {
          top: ['t'],
          left: ['l'],
          center: ['c'],
          right: ['r'],
          bottom: ['b'],
          sizes: { top: '80px', bottom: '80px', left: '150px', right: '150px' },
        },
      })
    );
    // left|center, center|right, top|middle, middle|bottom.
    expect(zoneDividers(layout)).toHaveLength(4);
    expect(seam(layout, 'left', 'center')).not.toBeUndefined();
    expect(seam(layout, 'center', 'right')).not.toBeUndefined();
    expect(seam(layout, 'top', 'center')).not.toBeUndefined();
    expect(seam(layout, 'center', 'bottom')).not.toBeUndefined();
  });

  it('renders NO seam beside an empty zone', () => {
    // An empty zone takes no space, so a seam next to one would sit against nothing
    // and drag a thickness the user cannot see.
    const layout = mount(['c']);
    layout.setLayout(doc({ zones: { center: ['c'], sizes: { left: '200px' } } }));
    expect(zoneDividers(layout)).toHaveLength(0);
  });

  it('WIDENS the left zone when its seam is dragged right', () => {
    const layout = threeAcross();
    const before = zoneRect(layout, 'left').width;
    const divider = seam(layout, 'left', 'center');
    const from = centerOf(divider);

    pointer('pointerdown', from.x, from.y, divider);
    pointer('pointermove', from.x + 120, from.y);
    pointer('pointerup', from.x + 120, from.y);

    expect(zoneRect(layout, 'left').width).toBeCloseTo(before + 120, 0);
  });

  it('WIDENS the right zone when its seam is dragged LEFT', () => {
    // A trailing zone grows as the seam comes back toward the origin — the opposite
    // sign from a leading one.
    const layout = threeAcross();
    const before = zoneRect(layout, 'right').width;
    const divider = seam(layout, 'center', 'right');
    const from = centerOf(divider);

    pointer('pointerdown', from.x, from.y, divider);
    pointer('pointermove', from.x - 100, from.y);
    pointer('pointerup', from.x - 100, from.y);

    expect(zoneRect(layout, 'right').width).toBeCloseTo(before + 100, 0);
  });

  it('resizes the TOP band vertically', () => {
    const layout = mount(['t', 'c']);
    layout.setLayout(doc({ zones: { top: ['t'], center: ['c'], sizes: { top: '100px' } } }));
    const divider = seam(layout, 'top', 'center');
    expect(getComputedStyle(divider).cursor).toBe('row-resize');
    const from = centerOf(divider);

    pointer('pointerdown', from.x, from.y, divider);
    pointer('pointermove', from.x, from.y + 80);
    pointer('pointerup', from.x, from.y + 80);

    expect(zoneRect(layout, 'top').height).toBeCloseTo(180, 0);
  });

  it('lets the CENTER absorb the difference — it is the remainder', () => {
    const layout = threeAcross();
    const before = zoneRect(layout, 'center').width;
    const divider = seam(layout, 'left', 'center');
    const from = centerOf(divider);

    pointer('pointerdown', from.x, from.y, divider);
    pointer('pointermove', from.x + 90, from.y);
    pointer('pointerup', from.x + 90, from.y);

    expect(zoneRect(layout, 'center').width).toBeCloseTo(before - 90, 0);
    // …and the center keeps no explicit size, staying the remainder by definition.
    expect(layout.getLayout().base.zones?.sizes?.center).toBeUndefined();
  });

  it('writes PIXELS into the document, so a save round-trips', () => {
    // A zone thickness is absolute: `sizeToFlex` turns px into a fixed basis that
    // neither grows nor shrinks. A weight would rubber-band the band as the window
    // resized, the opposite of what a rail-like zone wants.
    const layout = threeAcross();
    const divider = seam(layout, 'left', 'center');
    const from = centerOf(divider);

    pointer('pointerdown', from.x, from.y, divider);
    pointer('pointermove', from.x + 60, from.y);
    pointer('pointerup', from.x + 60, from.y);

    expect(layout.getLayout().base.zones?.sizes?.left).toBe('260px');
  });

  it('STOPS at pointerup — it must not keep resizing on a free-moving mouse', () => {
    const layout = threeAcross();
    const divider = seam(layout, 'left', 'center');
    const from = centerOf(divider);
    pointer('pointerdown', from.x, from.y, divider);
    pointer('pointermove', from.x + 80, from.y);
    pointer('pointerup', from.x + 80, from.y);
    const settled = zoneRect(layout, 'left').width;

    pointer('pointermove', from.x + 300, from.y);
    expect(zoneRect(layout, 'left').width).toBeCloseTo(settled, 0);
  });

  it('clamps so a zone cannot be dragged out of existence', () => {
    const layout = threeAcross();
    const divider = seam(layout, 'left', 'center');
    const from = centerOf(divider);

    pointer('pointerdown', from.x, from.y, divider);
    pointer('pointermove', from.x - 10_000, from.y);
    pointer('pointerup', from.x - 10_000, from.y);

    // The 48px floor: an absolute minimum, because 2% of a wide viewport is a usable
    // panel while 2% of a narrow one is a sliver.
    expect(zoneRect(layout, 'left').width).toBeCloseTo(48, 0);
  });

  it('clamps against EVERY other zone in the run, not just the neighbour', () => {
    // Measured 0px for the center before the fix: reserving one floor ignored the
    // right zone's fixed 150px and the two 6px seams, so a hard drag crushed it.
    const layout = threeAcross();
    const divider = seam(layout, 'left', 'center');
    const from = centerOf(divider);

    pointer('pointerdown', from.x, from.y, divider);
    pointer('pointermove', from.x + 10_000, from.y);
    pointer('pointerup', from.x + 10_000, from.y);

    expect(zoneRect(layout, 'center').width).toBeGreaterThanOrEqual(48);
    // The fixed right zone keeps its full width — it does not shrink to make room.
    expect(zoneRect(layout, 'right').width).toBeCloseTo(150, 0);
    // 800 = left + center(48 floor) + right(150) + two 6px seams.
    expect(zoneRect(layout, 'left').width).toBeCloseTo(800 - 48 - 150 - 12, 0);
  });

  it('fires ONE change event for the whole drag, not one per frame', () => {
    const layout = threeAcross();
    const onChange = vi.fn();
    layout.addEventListener('slicc-layout-change', onChange);
    const divider = seam(layout, 'left', 'center');
    const from = centerOf(divider);

    pointer('pointerdown', from.x, from.y, divider);
    for (let i = 1; i <= 8; i++) pointer('pointermove', from.x + i * 10, from.y);
    pointer('pointerup', from.x + 80, from.y);

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0].detail.reason).toBe('resize');
  });

  it('renders NO seam when either neighbour zone is LOCKED', () => {
    // A drag moves space between the two, so locking one has to suppress it.
    const layout = mount(['l', 'c']);
    layout.setLayout(
      doc({ zones: { left: ['l'], center: ['c'], sizes: { left: '200px' }, locked: ['left'] } })
    );
    expect(zoneDividers(layout)).toHaveLength(0);
  });

  it('renders NO seam under a document-wide lock', () => {
    const layout = mount(['l', 'c']);
    layout.setLayout(
      doc({ zones: { left: ['l'], center: ['c'], sizes: { left: '200px' } } }, { locked: true })
    );
    expect(zoneDividers(layout)).toHaveLength(0);
  });

  it('keeps zone seams distinguishable from panel seams', () => {
    // Both are dividers; only the zone seam carries the zone data and the hairline.
    const layout = mount(['l', 'l2', 'c']);
    layout.setLayout(
      doc({ zones: { left: ['l', 'l2'], center: ['c'], sizes: { left: '200px' } } })
    );
    const all = [...layout.querySelectorAll('.slicc-layout__divider')];
    expect(all).toHaveLength(2);
    expect(zoneDividers(layout)).toHaveLength(1);
  });
});

describe('legacy documents', () => {
  it('renders a pre-zone center tree, flattened into the center', () => {
    const layout = mount(['chat', 'files']);
    layout.setLayout(
      doc({ center: { split: 'row', children: [{ panel: 'chat' }, { panel: 'files' }] } })
    );
    expect(slotOf(layout, 'chat').dataset.zone).toBe('center');
    expect(slotOf(layout, 'files').dataset.zone).toBe('center');
  });

  it('MIGRATES to zones on the first drag rather than refusing to move', () => {
    // The alternative is a saved layout the user simply cannot rearrange.
    const layout = mount(['chat', 'files']);
    layout.setLayout(
      doc({ center: { split: 'row', children: [{ panel: 'chat' }, { panel: 'files' }] } })
    );

    dragToZone(layout, 'chat', 'right');

    const saved = layout.getLayout();
    expect(saved.base.center).toBeNull();
    expect(saved.base.zones?.right).toEqual(['chat']);
    expect(saved.base.zones?.center).toEqual(['files']);
  });
});
