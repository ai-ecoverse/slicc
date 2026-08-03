import { beforeEach, describe, expect, it } from 'vitest';
import { LAYOUT_SCHEMA_VERSION, type LayoutDocument } from '../../src/panel/layout-schema.js';
import { SliccLayout } from '../../src/panel/slicc-layout.js';
import { type PanelMeta, SliccPanel } from '../../src/panel/slicc-panel.js';

/** Panels under test — one class, many ids via `panel-id`. */
class TestPanel extends SliccPanel {
  static readonly panelMeta: PanelMeta = { id: 'test', title: 'Test' };
}
if (!customElements.get('layout-test-panel')) {
  customElements.define('layout-test-panel', TestPanel);
}

function doc(base: LayoutDocument['base'], over: Partial<LayoutDocument> = {}): LayoutDocument {
  return { version: LAYOUT_SCHEMA_VERSION, id: 'test', base, ...over };
}

/** Mount a layout of fixed size with panels for each of `ids`. */
function mount(ids: string[]): SliccLayout {
  const layout = document.createElement('slicc-layout') as SliccLayout;
  layout.style.cssText = 'width:800px;height:600px;';
  for (const id of ids) {
    const panel = document.createElement('layout-test-panel') as SliccPanel;
    panel.setAttribute('panel-id', id);
    layout.appendChild(panel);
  }
  document.body.appendChild(layout);
  return layout;
}

/** The panel element for `id` inside `layout`. */
function panelEl(layout: SliccLayout, id: string): HTMLElement {
  return layout.querySelector(`[panel-id="${id}"]`) as HTMLElement;
}

/** Whether a panel is currently parked offstage (not placed by the arrangement). */
function isParked(layout: SliccLayout, id: string): boolean {
  return !!panelEl(layout, id).closest('.slicc-layout__parking');
}

beforeEach(() => {
  document.body.replaceChildren();
});

describe('slicc-layout', () => {
  it('registers the element and renders in light DOM', () => {
    expect(customElements.get('slicc-layout')).toBe(SliccLayout);
    expect(mount([]).shadowRoot).toBeNull();
  });

  it('places a center panel so it fills the layout', () => {
    const layout = mount(['chat']);
    layout.setLayout(doc({ center: { panel: 'chat' } }));

    const rect = panelEl(layout, 'chat').getBoundingClientRect();
    expect(rect.width).toBeCloseTo(800, 0);
    expect(rect.height).toBeCloseTo(600, 0);
  });

  describe('docks', () => {
    it('gives a left dock its exact fixed width — the case fr-only could not express', () => {
      const layout = mount(['rail', 'chat']);
      layout.setLayout(
        doc({
          docks: [{ edge: 'left', size: '44px', panels: ['rail'] }],
          center: { panel: 'chat' },
        })
      );

      expect(panelEl(layout, 'rail').getBoundingClientRect().width).toBeCloseTo(44, 0);
      // The center takes exactly the remainder.
      expect(panelEl(layout, 'chat').getBoundingClientRect().width).toBeCloseTo(756, 0);
    });

    it('gives a top dock its exact fixed height and full width', () => {
      const layout = mount(['nav', 'chat']);
      layout.setLayout(
        doc({
          docks: [{ edge: 'top', size: '36px', panels: ['nav'] }],
          center: { panel: 'chat' },
        })
      );

      const nav = panelEl(layout, 'nav').getBoundingClientRect();
      expect(nav.height).toBeCloseTo(36, 0);
      expect(nav.width).toBeCloseTo(800, 0);
      expect(panelEl(layout, 'chat').getBoundingClientRect().height).toBeCloseTo(564, 0);
    });

    it('lays several panels along one dock in order', () => {
      const layout = mount(['switcher', 'floatbar', 'chat']);
      layout.setLayout(
        doc({
          docks: [{ edge: 'top', size: '36px', panels: ['switcher', 'floatbar'] }],
          center: { panel: 'chat' },
        })
      );

      const a = panelEl(layout, 'switcher').getBoundingClientRect();
      const b = panelEl(layout, 'floatbar').getBoundingClientRect();
      expect(a.left).toBeLessThan(b.left);
      expect(a.top).toBeCloseTo(b.top, 0);
    });

    it('supports all four edges at once', () => {
      const layout = mount(['t', 'r', 'b', 'l', 'c']);
      layout.setLayout(
        doc({
          docks: [
            { edge: 'top', size: '30px', panels: ['t'] },
            { edge: 'bottom', size: '20px', panels: ['b'] },
            { edge: 'left', size: '40px', panels: ['l'] },
            { edge: 'right', size: '50px', panels: ['r'] },
          ],
          center: { panel: 'c' },
        })
      );

      const c = panelEl(layout, 'c').getBoundingClientRect();
      expect(c.width).toBeCloseTo(800 - 40 - 50, 0);
      expect(c.height).toBeCloseTo(600 - 30 - 20, 0);
    });

    it('collapses a dock whose only panel is hidden, reserving no space', () => {
      // Otherwise hiding the last panel in a rail leaves an empty strip behind.
      const layout = mount(['rail', 'chat']);
      layout.setLayout(
        doc(
          { docks: [{ edge: 'left', size: '44px', panels: ['rail'] }], center: { panel: 'chat' } },
          { panels: { rail: { visible: false } } }
        )
      );

      expect(layout.querySelector('.slicc-layout__dock--left')).toBeNull();
      expect(panelEl(layout, 'chat').getBoundingClientRect().width).toBeCloseTo(800, 0);
    });

    it('collapses a dock whose panel element is absent', () => {
      const layout = mount(['chat']); // no 'ghost' panel supplied
      layout.setLayout(
        doc({
          docks: [{ edge: 'left', size: '44px', panels: ['ghost'] }],
          center: { panel: 'chat' },
        })
      );
      expect(layout.querySelector('.slicc-layout__dock--left')).toBeNull();
    });
  });

  describe('the five zones', () => {
    // BorderLayout geometry: four edge bands around a filling center. These
    // replaced a set of split-tree tests — the tree could express more, but nothing
    // a user could aim at, so the shapes worth asserting are these.
    it('gives the CENTER everything the edge zones leave', () => {
      const layout = mount(['chat']);
      layout.setLayout(doc({ zones: { center: ['chat'] } }));
      const rect = panelEl(layout, 'chat').getBoundingClientRect();
      expect(rect.width).toBeCloseTo(800, 0);
      expect(rect.height).toBeCloseTo(600, 0);
    });

    it('runs top and bottom FULL WIDTH, with the side zones between them', () => {
      const layout = mount(['t', 'l', 'c', 'r', 'b']);
      layout.setLayout(
        doc({
          zones: {
            top: ['t'],
            left: ['l'],
            center: ['c'],
            right: ['r'],
            bottom: ['b'],
            sizes: { top: '60px', bottom: '40px', left: '100px', right: '120px' },
          },
        })
      );
      const r = (id: string) => panelEl(layout, id).getBoundingClientRect();

      // Top and bottom span the whole width — the Swing picture exactly.
      expect(r('t').width).toBeCloseTo(800, 0);
      expect(r('b').width).toBeCloseTo(800, 0);
      expect(r('t').height).toBeCloseTo(60, 0);
      expect(r('b').height).toBeCloseTo(40, 0);
      // The side zones sit between them, left → center → right.
      expect(r('l').left).toBeLessThan(r('c').left);
      expect(r('c').left).toBeLessThan(r('r').left);
      expect(r('l').width).toBeCloseTo(100, 0);
      expect(r('r').width).toBeCloseTo(120, 0);
      // …and the center takes the rest, less the resize seams: two vertical seams
      // in the middle row (left|center, center|right) and two horizontal ones
      // (top|middle, middle|bottom), 6px each.
      expect(r('c').width).toBeCloseTo(580 - 12, 0);
      expect(r('c').height).toBeCloseTo(500 - 12, 0);
    });

    it('gives an empty zone NO space at all', () => {
      const layout = mount(['chat']);
      layout.setLayout(doc({ zones: { center: ['chat'], sizes: { top: '80px' } } }));
      // An unpopulated `top` must not reserve its thickness as a dead band.
      expect(panelEl(layout, 'chat').getBoundingClientRect().height).toBeCloseTo(600, 0);
      expect(layout.querySelector('.slicc-layout__zone--top')).toBeNull();
    });

    it('STACKS several panels in one zone by default', () => {
      const layout = mount(['a', 'b']);
      layout.setLayout(doc({ zones: { left: ['a', 'b'], sizes: { left: '200px' } } }));
      const ra = panelEl(layout, 'a').getBoundingClientRect();
      const rb = panelEl(layout, 'b').getBoundingClientRect();
      expect(rb.top).toBeGreaterThan(ra.top);
      expect(ra.width).toBeCloseTo(200, 0);
      expect(rb.width).toBeCloseTo(200, 0);
    });

    it('puts them SIDE BY SIDE when the zone’s axis says row', () => {
      const layout = mount(['a', 'b']);
      layout.setLayout(doc({ zones: { left: ['a', 'b'], axes: { left: 'row' } } }));
      const ra = panelEl(layout, 'a').getBoundingClientRect();
      const rb = panelEl(layout, 'b').getBoundingClientRect();
      expect(rb.left).toBeGreaterThan(ra.left);
      expect(ra.top).toBeCloseTo(rb.top, 0);
    });

    it('keeps every zone INSIDE the docks, so chrome and zones never overlap', () => {
      const layout = mount(['strip', 'rail', 'top', 'chat']);
      layout.setLayout(
        doc({
          docks: [
            { edge: 'top', size: '36px', panels: ['strip'] },
            { edge: 'left', size: '44px', panels: ['rail'] },
          ],
          zones: { top: ['top'], center: ['chat'], sizes: { top: '50px' } },
        })
      );
      const strip = panelEl(layout, 'strip').getBoundingClientRect();
      const topZone = panelEl(layout, 'top').getBoundingClientRect();
      const rail = panelEl(layout, 'rail').getBoundingClientRect();

      // The `top` ZONE begins below the docked strip, not over it.
      expect(topZone.top).toBeGreaterThanOrEqual(strip.bottom - 1);
      // …and every zone starts right of the rail.
      expect(topZone.left).toBeGreaterThanOrEqual(rail.right - 1);
      expect(panelEl(layout, 'chat').getBoundingClientRect().left).toBeGreaterThanOrEqual(
        rail.right - 1
      );
    });

    it('skips a panel with no element, without leaving a gap', () => {
      const layout = mount(['chat']);
      layout.setLayout(doc({ zones: { center: ['chat', 'ghost'] } }));
      expect(panelEl(layout, 'chat').getBoundingClientRect().height).toBeCloseTo(600, 0);
    });

    it('renders NOTHING for a zone whose panels are all missing', () => {
      const layout = mount(['chat']);
      layout.setLayout(doc({ zones: { center: ['chat'], right: ['gone'] } }));
      expect(layout.querySelector('.slicc-layout__zone--right')).toBeNull();
      expect(panelEl(layout, 'chat').getBoundingClientRect().width).toBeCloseTo(800, 0);
    });

    it('renders a LEGACY center tree, flattened into the center zone', () => {
      // Documents saved before the zone model — including anything a skill shipped
      // — must keep working.
      const layout = mount(['chat', 'files']);
      layout.setLayout(
        doc({ center: { split: 'row', children: [{ panel: 'chat' }, { panel: 'files' }] } })
      );
      for (const id of ['chat', 'files']) {
        expect(
          (panelEl(layout, id).closest('.slicc-layout__slot') as HTMLElement).dataset.zone
        ).toBe('center');
      }
    });
  });

  describe('floating panels', () => {
    it('does not reflow the docked layout', () => {
      const layout = mount(['chat', 'monitor']);
      layout.setLayout(doc({ center: { panel: 'chat' } }));
      const widthBefore = panelEl(layout, 'chat').getBoundingClientRect().width;

      layout.setLayout(
        doc({
          center: { panel: 'chat' },
          floating: [{ panel: 'monitor', anchor: 'right', width: '200px' }],
        })
      );

      expect(panelEl(layout, 'chat').getBoundingClientRect().width).toBeCloseTo(widthBefore, 0);
      expect(panelEl(layout, 'monitor').getBoundingClientRect().width).toBeCloseTo(200, 0);
    });

    it('paints above the docked panels', () => {
      const layout = mount(['chat', 'monitor']);
      layout.setLayout(
        doc({
          center: { panel: 'chat' },
          floating: [{ panel: 'monitor', anchor: 'center', width: '100px', height: '100px' }],
        })
      );

      const rect = panelEl(layout, 'monitor').getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + 50, rect.top + 50);
      expect(panelEl(layout, 'monitor').contains(hit)).toBe(true);
    });

    it('does NOT use a z-index — sibling order is enough, and staying out of the numeric game keeps it below the trusted layer', () => {
      const layout = mount(['chat', 'monitor']);
      layout.setLayout(doc({ center: { panel: 'chat' }, floating: [{ panel: 'monitor' }] }));
      const stratum = layout.querySelector('.slicc-layout__floating') as HTMLElement;
      expect(getComputedStyle(stratum).zIndex).toBe('auto');
    });

    it('lets clicks fall through the empty area of the floating stratum', () => {
      const layout = mount(['chat', 'monitor']);
      layout.setLayout(
        doc({
          center: { panel: 'chat' },
          floating: [{ panel: 'monitor', anchor: 'right', width: '100px', height: '100px' }],
        })
      );
      // Far from the floating panel, the hit-test reaches the chat panel.
      const chatRect = panelEl(layout, 'chat').getBoundingClientRect();
      const hit = document.elementFromPoint(chatRect.left + 20, chatRect.bottom - 20);
      expect(panelEl(layout, 'chat').contains(hit)).toBe(true);
    });

    it('resets floating state when a later layout docks the same panel', () => {
      // A panel that floated must not keep floating (or keep its inline size)
      // once an arrangement docks it.
      const layout = mount(['chat', 'monitor']);
      layout.setLayout(
        doc({
          center: { panel: 'chat' },
          floating: [{ panel: 'monitor', anchor: 'right', width: '200px' }],
        })
      );
      expect(panelEl(layout, 'monitor').getAttribute('presentation')).toBe('floating');

      layout.setLayout(
        doc({ center: { split: 'row', children: [{ panel: 'chat' }, { panel: 'monitor' }] } })
      );

      const monitor = panelEl(layout, 'monitor');
      expect(monitor.getAttribute('presentation')).toBe('docked');
      expect(monitor.hasAttribute('anchor')).toBe(false);
      expect(monitor.style.width).toBe('');
    });
  });

  describe('parking (state preservation)', () => {
    it('parks a panel the arrangement does not place, keeping it in the DOM', () => {
      // Keeping it mounted preserves scroll position, a live terminal session,
      // a loaded file tree — rebuilding on every variant switch would lose all
      // of that.
      const layout = mount(['chat', 'files']);
      layout.setLayout(doc({ center: { panel: 'chat' } }));

      expect(isParked(layout, 'files')).toBe(true);
      expect(panelEl(layout, 'files').isConnected).toBe(true);
    });

    it('un-parks a panel when a later layout places it, same element instance', () => {
      const layout = mount(['chat', 'files']);
      layout.setLayout(doc({ center: { panel: 'chat' } }));
      const instance = panelEl(layout, 'files');

      layout.setLayout(
        doc({ center: { split: 'row', children: [{ panel: 'chat' }, { panel: 'files' }] } })
      );

      expect(isParked(layout, 'files')).toBe(false);
      expect(panelEl(layout, 'files')).toBe(instance); // moved, not recreated
    });

    it('places a panel appended AFTER the layout was set', () => {
      // Tool panels mount lazily and sprinkles arrive from VFS discovery, so a
      // late child must still land in its slot.
      const layout = mount(['chat']);
      layout.setLayout(
        doc({ center: { split: 'row', children: [{ panel: 'chat' }, { panel: 'late' }] } })
      );
      expect(layout.querySelector('[panel-id="late"]')).toBeNull();

      const late = document.createElement('layout-test-panel') as SliccPanel;
      late.setAttribute('panel-id', 'late');
      layout.appendChild(late);

      // The MutationObserver is async; flush a microtask + frame.
      return new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          expect(isParked(layout, 'late')).toBe(false);
          expect(late.getBoundingClientRect().width).toBeGreaterThan(0);
          resolve();
        });
      });
    });

    it('does not treat a panel nested inside another panel as a slot to fill', () => {
      // A nested panel is its parent's CONTENT; pooling it would rip it out.
      const layout = mount(['chat']);
      const inner = document.createElement('layout-test-panel') as SliccPanel;
      inner.setAttribute('panel-id', 'inner');
      panelEl(layout, 'chat').appendChild(inner);

      layout.setLayout(
        doc({ center: { split: 'row', children: [{ panel: 'chat' }, { panel: 'inner' }] } })
      );

      expect(inner.parentElement).toBe(panelEl(layout, 'chat'));
    });
  });

  describe('locking', () => {
    it('reflects a tree-wide lock onto every placed panel', () => {
      const layout = mount(['chat', 'rail']);
      layout.setLayout(
        doc(
          { docks: [{ edge: 'left', size: '44px', panels: ['rail'] }], center: { panel: 'chat' } },
          { locked: true }
        )
      );

      expect(panelEl(layout, 'chat').hasAttribute('locked')).toBe(true);
      expect(panelEl(layout, 'rail').hasAttribute('locked')).toBe(true);
      expect(layout.isLocked('chat')).toBe(true);
    });

    it('locks only the affected subtree', () => {
      const layout = mount(['a', 'b']);
      layout.setLayout(
        doc({
          docks: [
            { edge: 'left', size: '40px', panels: ['a'], locked: true },
            { edge: 'right', size: '40px', panels: ['b'] },
          ],
          center: null,
        })
      );

      expect(panelEl(layout, 'a').hasAttribute('locked')).toBe(true);
      expect(panelEl(layout, 'b').hasAttribute('locked')).toBe(false);
    });

    it('clears the lock when a later layout does not lock the panel', () => {
      const layout = mount(['chat']);
      layout.setLayout(doc({ center: { panel: 'chat' } }, { locked: true }));
      expect(panelEl(layout, 'chat').hasAttribute('locked')).toBe(true);

      layout.setLayout(doc({ center: { panel: 'chat' } }));
      expect(panelEl(layout, 'chat').hasAttribute('locked')).toBe(false);
    });
  });

  describe('document API', () => {
    it('round-trips the document through getLayout', () => {
      const layout = mount(['chat']);
      const source = doc({ center: { panel: 'chat' } }, { title: 'Mine' });
      layout.setLayout(source);
      expect(layout.getLayout()).toEqual(source);
    });

    it('returns a clone so a caller cannot mutate engine state', () => {
      const layout = mount(['chat']);
      layout.setLayout(doc({ center: { panel: 'chat' } }));
      const copy = layout.getLayout();
      copy.id = 'mutated';
      expect(layout.getLayout().id).toBe('test');
    });

    it('setLayout(null) resets to an empty layout, parking everything', () => {
      const layout = mount(['chat']);
      layout.setLayout(doc({ center: { panel: 'chat' } }));
      layout.setLayout(null);
      expect(isParked(layout, 'chat')).toBe(true);
      expect(layout.getPlacedPanelIds()).toEqual([]);
    });

    it('reports the placed ids in document order', () => {
      const layout = mount(['rail', 'chat', 'files']);
      layout.setLayout(
        doc({
          docks: [{ edge: 'left', size: '40px', panels: ['rail'] }],
          center: { split: 'row', children: [{ panel: 'chat' }, { panel: 'files' }] },
        })
      );
      expect(layout.getPlacedPanelIds()).toEqual(['rail', 'chat', 'files']);
    });

    it('reports only what actually RENDERED — not every id the document mentions', () => {
      // Regression: this read the document, so a hidden panel still counted as
      // placed. The add-panel menu keys its checkmarks off this, so an invisible
      // panel showed as enabled and clicking it "again" hid what was already
      // hidden.
      const layout = mount(['chat', 'files']);
      layout.setLayout(
        doc(
          { center: { split: 'row', children: [{ panel: 'chat' }, { panel: 'files' }] } },
          { panels: { files: { visible: false } } }
        )
      );

      expect(layout.getPlacedPanelIds()).toEqual(['chat']);
      expect(isParked(layout, 'files')).toBe(true);
    });

    it('omits a panel the document references but no element was supplied for', () => {
      const layout = mount(['chat']); // no 'ghost' element
      layout.setLayout(
        doc({ center: { split: 'row', children: [{ panel: 'chat' }, { panel: 'ghost' }] } })
      );
      expect(layout.getPlacedPanelIds()).toEqual(['chat']);
    });

    it('exposes the resolved arrangement, cloned', () => {
      const layout = mount(['chat']);
      layout.setLayout(doc({ center: { panel: 'chat' } }));
      const resolved = layout.getResolved();
      expect(resolved?.center).toEqual({ panel: 'chat' });
      resolved!.id = 'mutated';
      expect(layout.getResolved()?.id).toBe('test');
    });
  });

  describe('variants', () => {
    it('applies a variant matching the HOST box, not the window', () => {
      // A layout nested in a narrow container (extension side panel, Cherry
      // embed) must respond to the space it actually has.
      const layout = mount(['rail', 'chat']);
      layout.style.width = '500px';
      layout.setLayout(
        doc(
          { docks: [{ edge: 'left', size: '44px', panels: ['rail'] }], center: { panel: 'chat' } },
          { variants: [{ when: { maxWidth: 700 }, docks: [] }] }
        )
      );

      // The narrow variant dropped the rail even though the window is wide.
      expect(layout.querySelector('.slicc-layout__dock--left')).toBeNull();
      expect(isParked(layout, 'rail')).toBe(true);
      expect(layout.getResolved()?.appliedVariants).toEqual([0]);
    });

    it('does not apply a variant whose condition fails at the host size', () => {
      const layout = mount(['rail', 'chat']);
      layout.setLayout(
        doc(
          { docks: [{ edge: 'left', size: '44px', panels: ['rail'] }], center: { panel: 'chat' } },
          { variants: [{ when: { maxWidth: 400 }, docks: [] }] }
        )
      );
      expect(layout.querySelector('.slicc-layout__dock--left')).not.toBeNull();
      expect(layout.getResolved()?.appliedVariants).toEqual([]);
    });

    it('honors a platform-keyed variant via the platform attribute', () => {
      const layout = mount(['rail', 'chat']);
      layout.setAttribute('platform', 'extension');
      layout.setLayout(
        doc(
          { docks: [{ edge: 'left', size: '44px', panels: ['rail'] }], center: { panel: 'chat' } },
          { variants: [{ when: { platform: 'extension' }, docks: [] }] }
        )
      );
      expect(layout.getResolved()?.appliedVariants).toEqual([0]);
    });

    /** Let the ResizeObserver fire and its rAF callback run. */
    function settleResize(): Promise<void> {
      return new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });
    }

    it('re-resolves live when the host is RESIZED across a breakpoint', async () => {
      // The point of variants: shrinking the window past a breakpoint must drop
      // the rail without anyone calling setLayout again.
      const layout = mount(['rail', 'chat']);
      layout.setLayout(
        doc(
          { docks: [{ edge: 'left', size: '44px', panels: ['rail'] }], center: { panel: 'chat' } },
          { variants: [{ when: { maxWidth: 700 }, docks: [] }] }
        )
      );
      expect(layout.querySelector('.slicc-layout__dock--left')).not.toBeNull();

      layout.style.width = '500px';
      await settleResize();

      expect(layout.querySelector('.slicc-layout__dock--left')).toBeNull();
      expect(isParked(layout, 'rail')).toBe(true);
      expect(layout.getResolved()?.appliedVariants).toEqual([0]);
    });

    it('restores the wide arrangement when the host grows back', async () => {
      const layout = mount(['rail', 'chat']);
      layout.style.width = '500px';
      layout.setLayout(
        doc(
          { docks: [{ edge: 'left', size: '44px', panels: ['rail'] }], center: { panel: 'chat' } },
          { variants: [{ when: { maxWidth: 700 }, docks: [] }] }
        )
      );
      expect(isParked(layout, 'rail')).toBe(true);

      layout.style.width = '900px';
      await settleResize();

      expect(isParked(layout, 'rail')).toBe(false);
      expect(panelEl(layout, 'rail').getBoundingClientRect().width).toBeCloseTo(44, 0);
    });

    it('does NOT rebuild when a resize stays inside the same breakpoint', async () => {
      // Resizing within one breakpoint must not churn the DOM — a rebuild would
      // fight an in-progress drag and throw away transient panel state.
      const layout = mount(['chat']);
      layout.setLayout(
        doc({ center: { panel: 'chat' } }, { variants: [{ when: { maxWidth: 700 }, docks: [] }] })
      );

      let rebuilds = 0;
      layout.addEventListener('slicc-layout-change', () => rebuilds++);

      layout.style.width = '780px';
      await settleResize();
      layout.style.width = '760px';
      await settleResize();

      expect(rebuilds).toBe(0);
    });

    it('does not observe-and-rebuild at all for a document with no variants', async () => {
      const layout = mount(['chat']);
      layout.setLayout(doc({ center: { panel: 'chat' } }));

      let rebuilds = 0;
      layout.addEventListener('slicc-layout-change', () => rebuilds++);

      layout.style.width = '300px';
      await settleResize();

      expect(rebuilds).toBe(0);
    });

    it('labels a resize-driven rebuild with the viewport reason', async () => {
      const layout = mount(['rail', 'chat']);
      layout.setLayout(
        doc(
          { docks: [{ edge: 'left', size: '44px', panels: ['rail'] }], center: { panel: 'chat' } },
          { variants: [{ when: { maxWidth: 700 }, docks: [] }] }
        )
      );

      const reasons: string[] = [];
      layout.addEventListener('slicc-layout-change', (e) => {
        reasons.push((e as CustomEvent<{ reason: string }>).detail.reason);
      });

      layout.style.width = '400px';
      await settleResize();

      expect(reasons).toEqual(['viewport']);
    });

    it('stops re-resolving once disconnected', async () => {
      const layout = mount(['rail', 'chat']);
      layout.setLayout(
        doc(
          { docks: [{ edge: 'left', size: '44px', panels: ['rail'] }], center: { panel: 'chat' } },
          { variants: [{ when: { maxWidth: 700 }, docks: [] }] }
        )
      );
      layout.remove();

      let rebuilds = 0;
      layout.addEventListener('slicc-layout-change', () => rebuilds++);
      layout.style.width = '400px';
      await settleResize();

      expect(rebuilds).toBe(0);
    });

    it('re-resolves when the platform attribute changes', () => {
      const layout = mount(['rail', 'chat']);
      layout.setLayout(
        doc(
          { docks: [{ edge: 'left', size: '44px', panels: ['rail'] }], center: { panel: 'chat' } },
          { variants: [{ when: { platform: 'electron' }, docks: [] }] }
        )
      );
      // Unknown env platform matches any predicate, so it applies already.
      expect(layout.getResolved()?.appliedVariants).toEqual([0]);

      layout.setAttribute('platform', 'web');
      expect(layout.getResolved()?.appliedVariants).toEqual([]);
    });
  });

  describe('re-entrancy', () => {
    it('rebuilds without re-triggering its own child observer', () => {
      // Regression: rendering with `this.replaceChildren()` mutated the host's
      // own child list, which is what `#childObserver` watches — so every
      // render scheduled another one and the component looped forever (it hung
      // the whole test run rather than failing). Rebuilds now replace a stable
      // inner root's children, leaving the host's list untouched.
      const layout = mount(['chat', 'files']);
      layout.setLayout(doc({ center: { panel: 'chat' } }));

      const hostChildren = [...layout.children].map((c) => c.className);
      layout.setLayout(
        doc({ center: { split: 'row', children: [{ panel: 'chat' }, { panel: 'files' }] } })
      );

      // The host's own children are the same two stable containers, in the same
      // order — a rebuild produced no host-level mutation to observe.
      expect([...layout.children].map((c) => c.className)).toEqual(hostChildren);
      // The drag overlays are stable host children too — they must survive a
      // rebuild, since one happens on every frame of a resize drag.
      expect(hostChildren).toEqual([
        'slicc-layout__root',
        'slicc-layout__parking',
        'slicc-layout__targets',
        'slicc-layout__ghost',
      ]);
    });

    it('survives many consecutive re-renders (no runaway growth)', () => {
      const layout = mount(['chat', 'files']);
      for (let i = 0; i < 20; i++) {
        layout.setLayout(doc({ center: { panel: i % 2 === 0 ? 'chat' : 'files' } }));
      }
      // The four stable containers: root, parking, and the two drag overlays.
      expect(layout.children).toHaveLength(4);
      expect(layout.querySelectorAll('[panel-id="chat"]')).toHaveLength(1);
    });
  });

  describe('slicc-layout-change', () => {
    it('fires composed + bubbling with the resolved layout and a reason', () => {
      const layout = mount(['chat']);
      const seen: Array<{ id: string; reason: string }> = [];
      let composed = false;
      document.body.addEventListener('slicc-layout-change', (e) => {
        const ce = e as CustomEvent<{ layout: { id: string }; reason: string }>;
        seen.push({ id: ce.detail.layout.id, reason: ce.detail.reason });
        composed = ce.composed && ce.bubbles;
      });

      layout.setLayout(doc({ center: { panel: 'chat' } }));

      expect(seen.at(-1)).toEqual({ id: 'test', reason: 'set' });
      expect(composed).toBe(true);
    });
  });
});
