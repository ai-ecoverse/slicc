import { beforeEach, describe, expect, it } from 'vitest';
// Sibling composed by tag (same wave); imported so <slicc-surface> is registered
// at test time. The host composes it strictly by tag/identity — this import
// only ensures the element upgrades so its own inline overrides participate.
import '../../src/workbench/slicc-surface.js';
import {
  CHAT_SURFACE_ID,
  type DockNode,
  type DockTreeSpec,
  labelForSurface,
  SliccDockTree,
} from '../../src/workbench/slicc-dock-tree.js';

/** Build a `<slicc-surface>` addressable by `surface-id`. */
function surface(id: string, label = id): HTMLElement {
  const s = document.createElement('slicc-surface');
  s.setAttribute('surface-id', id);
  s.textContent = label;
  return s;
}

/** A leaf node for `surfaceId`. */
function leaf(surfaceId: string): DockNode {
  return { type: 'leaf', surfaceId };
}

/** A split node; `sizes` defaults to an equal (`1`) weight per child. */
function split(dir: 'row' | 'col', children: DockNode[], sizes?: number[]): DockNode {
  return { type: 'split', dir, children, sizes: sizes ?? children.map(() => 1) };
}

/** A bare 5-zone spec, each zone a single-surface leaf named after the zone. */
function standardSpec(): DockTreeSpec {
  return {
    zones: {
      top: leaf('top'),
      left: leaf('left'),
      middle: leaf('middle'),
      right: leaf('right'),
      bottom: leaf('bottom'),
    },
    rowFr: { top: 0.7, center: 3, bottom: 0.7 },
    colFr: { left: 1, middle: 2, right: 1 },
  };
}

const EMPTY_SPEC: DockTreeSpec = {
  zones: { top: null, left: null, middle: null, right: null, bottom: null },
  rowFr: { top: 1, center: 1, bottom: 1 },
  colFr: { left: 1, middle: 1, right: 1 },
};

/** Mount a `<slicc-dock-tree>` with a definite box so flex geometry resolves. */
function mount(): SliccDockTree {
  const el = document.createElement('slicc-dock-tree') as SliccDockTree;
  el.style.display = 'block';
  el.style.width = '600px';
  el.style.height = '400px';
  document.body.appendChild(el);
  return el;
}

/** Mount with the opt-in tile drag gate enabled. */
function mountWithTileDrag(): SliccDockTree {
  const el = mount();
  el.tilesMovable = true;
  return el;
}

describe('slicc-dock-tree', () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it('registers the custom element', () => {
    expect(customElements.get('slicc-dock-tree')).toBe(SliccDockTree);
  });

  it('is a light-DOM host (no shadow root)', () => {
    const el = mount();
    expect(el.shadowRoot).toBeNull();
  });

  it('starts with an all-empty tree and renders nothing (no zones, no dividers)', () => {
    const el = mount();
    expect(el.getSurfaceIds()).toEqual([]);
    expect(el.getTree()).toEqual(EMPTY_SPEC);
    expect(el.querySelectorAll('.dock-tree__zone')).toHaveLength(0);
    expect(el.querySelector('.dock-tree__row')).toBeNull();
    expect(el.querySelectorAll('.dock-tree__divider')).toHaveLength(0);
  });

  describe('tile drag gate', () => {
    it('defaults off and renders no move handle for an unlocked leaf', () => {
      const el = mount();
      el.appendChild(surface('middle'));
      el.setTree({ ...EMPTY_SPEC, zones: { ...EMPTY_SPEC.zones, middle: leaf('middle') } });

      expect(el.tilesMovable).toBe(false);
      expect(el.hasAttribute('tiles-movable')).toBe(false);
      expect(el.querySelectorAll('.dock-tree__tile-move')).toHaveLength(0);
    });

    it('reflects tilesMovable to tiles-movable and renders the handle when enabled', () => {
      const el = mount();
      el.appendChild(surface('middle'));
      el.setTree({ ...EMPTY_SPEC, zones: { ...EMPTY_SPEC.zones, middle: leaf('middle') } });

      el.tilesMovable = true;
      expect(el.hasAttribute('tiles-movable')).toBe(true);
      expect(el.querySelectorAll('.dock-tree__tile-move')).toHaveLength(1);

      el.removeAttribute('tiles-movable');
      expect(el.tilesMovable).toBe(false);
      expect(el.querySelectorAll('.dock-tree__tile-move')).toHaveLength(0);
    });

    it('treats an explicit false attribute string as off while an empty attribute is on', () => {
      const el = mount();
      el.appendChild(surface('middle'));
      el.setTree({ ...EMPTY_SPEC, zones: { ...EMPTY_SPEC.zones, middle: leaf('middle') } });

      el.setAttribute('tiles-movable', 'false');
      expect(el.tilesMovable).toBe(false);
      expect(el.querySelectorAll('.dock-tree__tile-move')).toHaveLength(0);

      el.setAttribute('tiles-movable', '');
      expect(el.tilesMovable).toBe(true);
      expect(el.querySelectorAll('.dock-tree__tile-move')).toHaveLength(1);
    });

    it('coerces a runtime false property string off while preserving boolean reflection', () => {
      const el = mount();
      el.appendChild(surface('middle'));
      el.setTree({ ...EMPTY_SPEC, zones: { ...EMPTY_SPEC.zones, middle: leaf('middle') } });

      el.tilesMovable = true;
      expect(el.getAttribute('tiles-movable')).toBe('');

      (el as unknown as { tilesMovable: string }).tilesMovable = 'false';
      expect(el.tilesMovable).toBe(false);
      expect(el.hasAttribute('tiles-movable')).toBe(false);
      expect(el.querySelectorAll('.dock-tree__tile-move')).toHaveLength(0);

      el.tilesMovable = true;
      el.tilesMovable = false;
      expect(el.hasAttribute('tiles-movable')).toBe(false);
    });

    it('a stale move-button pointerdown no-ops after the gate is turned off', () => {
      const el = mountWithTileDrag();
      el.appendChild(surface('middle'));
      el.setTree({ ...EMPTY_SPEC, zones: { ...EMPTY_SPEC.zones, middle: leaf('middle') } });
      const before = el.getTree();
      const events: CustomEvent[] = [];
      el.addEventListener('dock-tree-change', (event) => events.push(event as CustomEvent));
      const staleButton = el.querySelector('.dock-tree__tile-move') as HTMLElement;
      el.tilesMovable = false;

      const pointerdown = new PointerEvent('pointerdown', {
        button: 0,
        bubbles: true,
        cancelable: true,
      });
      staleButton.dispatchEvent(pointerdown);

      expect(pointerdown.defaultPrevented).toBe(false);
      expect(el.querySelectorAll('.dock-tree__zone--droppable')).toHaveLength(0);
      expect(el.querySelector('.dock-tree__ghost--active')).toBeNull();
      expect(el.getTree()).toEqual(before);
      expect(events).toHaveLength(0);
    });

    it('beginExternalDrag no-ops while the gate is off', () => {
      const el = mount();
      const before = el.getTree();
      const events: CustomEvent[] = [];
      el.addEventListener('dock-tree-change', (event) => events.push(event as CustomEvent));

      el.beginExternalDrag('sprinkle:x');
      window.dispatchEvent(new PointerEvent('pointermove', { clientX: 10, clientY: 10 }));
      window.dispatchEvent(new PointerEvent('pointerup', { clientX: 10, clientY: 10 }));

      expect(el.querySelectorAll('.dock-tree__zone')).toHaveLength(0);
      expect(el.querySelector('.dock-tree__ghost--active')).toBeNull();
      expect(el.getTree()).toEqual(before);
      expect(events).toHaveLength(0);
    });

    it('combines the enabled gate with locked so a locked leaf still has no handle', () => {
      const el = mountWithTileDrag();
      el.appendChild(surface('middle'));
      el.setTree({
        ...EMPTY_SPEC,
        zones: { ...EMPTY_SPEC.zones, middle: { ...leaf('middle'), locked: true } },
      });

      expect(el.tilesMovable).toBe(true);
      expect(el.querySelectorAll('.dock-tree__tile-move')).toHaveLength(0);
    });
  });

  it('fills a flex-column parent with no explicit height on the host (host flex:1)', () => {
    // Regression: the host CSS lacked `flex:1`, so inside a pane's flex column
    // it collapsed to 0 height and `.dock-tree__root`'s height:100% resolved
    // against 0 — every zone/leaf rendered zero-height (the live editor showed
    // empty tiles). Mount WITHOUT an explicit height and assert it fills.
    const parent = document.createElement('div');
    parent.style.display = 'flex';
    parent.style.flexDirection = 'column';
    parent.style.width = '600px';
    parent.style.height = '400px';
    const el = document.createElement('slicc-dock-tree') as SliccDockTree;
    // Deliberately NO height on el — it must fill the parent via flex:1.
    parent.appendChild(el);
    document.body.appendChild(parent);
    for (const id of ['top', 'left', 'middle', 'right', 'bottom']) el.appendChild(surface(id));
    el.setTree(standardSpec());
    expect(Math.round(el.getBoundingClientRect().height)).toBeGreaterThan(300);
    const mid = el.querySelector('slicc-surface[surface-id="middle"]') as HTMLElement | null;
    expect(mid).not.toBeNull();
    expect(Math.round((mid as HTMLElement).getBoundingClientRect().height)).toBeGreaterThan(0);
  });

  describe('setTree / getTree', () => {
    it('renders all 5 zones with their surfaces visible', () => {
      const el = mount();
      const ids = ['top', 'left', 'middle', 'right', 'bottom'];
      for (const id of ids) el.appendChild(surface(id));
      el.setTree(standardSpec());

      const zones = Array.from(el.querySelectorAll('.dock-tree__zone')) as HTMLElement[];
      expect(zones.map((z) => z.dataset.zone).sort()).toEqual(
        ['bottom', 'left', 'middle', 'right', 'top'].sort()
      );

      for (const id of ids) {
        const s = el.querySelector(`slicc-surface[surface-id="${id}"]`) as HTMLElement;
        expect(s).toBeTruthy();
        expect(s.closest('.dock-tree__leaf')).toBeTruthy();
        expect(getComputedStyle(s).display).toBe('flex');
      }
    });

    it('round-trips a set spec through getTree() (JSON deep-equal)', () => {
      const el = mount();
      const spec = standardSpec();
      el.setTree(spec);
      expect(el.getTree()).toEqual(spec);
    });

    it('getTree() returns a deep clone — mutating it cannot affect the host', () => {
      const el = mount();
      el.setTree(standardSpec());
      const clone = el.getTree();
      clone.zones.top = null;
      clone.rowFr.top = 999;
      const again = el.getTree();
      expect(again.zones.top).not.toBeNull();
      expect(again.rowFr.top).toBe(0.7);
    });

    it('setTree(null) resets to an all-empty tree', () => {
      const el = mount();
      el.setTree(standardSpec());
      el.setTree(null);
      expect(el.getSurfaceIds()).toEqual([]);
      expect(el.getTree()).toEqual(EMPTY_SPEC);
      expect(el.querySelectorAll('.dock-tree__zone')).toHaveLength(0);
    });

    it('setTree before connecting still renders once appended (lazy render)', () => {
      const el = document.createElement('slicc-dock-tree') as SliccDockTree;
      el.style.width = '600px';
      el.style.height = '400px';
      el.setTree({ ...EMPTY_SPEC, zones: { ...EMPTY_SPEC.zones, middle: leaf('m') } });
      expect(el.isConnected).toBe(false);
      document.body.appendChild(el);
      expect(el.querySelector('.dock-tree__zone[data-zone="middle"]')).toBeTruthy();
    });
  });

  describe('collapse-empty', () => {
    it('omits an empty zone entirely (no element) and parks its orphaned surface', () => {
      const el = mount();
      const ids = ['top', 'left', 'middle', 'right', 'bottom'];
      for (const id of ids) el.appendChild(surface(id));
      const spec = standardSpec();
      spec.zones.top = null;
      el.setTree(spec);

      expect(el.querySelector('.dock-tree__zone[data-zone="top"]')).toBeNull();
      const topSurface = el.querySelector('slicc-surface[surface-id="top"]') as HTMLElement;
      expect(getComputedStyle(topSurface).display).toBe('none');
      expect(topSurface.parentElement?.classList.contains('dock-tree__parking')).toBe(true);
    });

    it('parks a surface with no matching leaf anywhere in the tree', () => {
      const el = mount();
      el.appendChild(surface('orphan'));
      el.setTree(standardSpec());
      const s = el.querySelector('slicc-surface[surface-id="orphan"]') as HTMLElement;
      expect(getComputedStyle(s).display).toBe('none');
      expect(s.parentElement?.classList.contains('dock-tree__parking')).toBe(true);
    });

    it('composes a surface with nested child surfaces, leaving the nested ones untouched', () => {
      // A surface can nest child surfaces as its own content — those nested
      // surfaces must never be independently pooled/placed by the tree.
      const el = mount();
      const outer = surface('tools', '');
      const nestedA = surface('files', 'files-content');
      const nestedB = surface('term', 'term-content');
      outer.append(nestedA, nestedB);
      el.appendChild(outer);
      el.setTree({ ...EMPTY_SPEC, zones: { ...EMPTY_SPEC.zones, right: leaf('tools') } });

      // The outer surface is placed into its leaf's tile body.
      expect(outer.parentElement?.classList.contains('dock-tree__tile-body')).toBe(true);
      // The nested surfaces are NOT pooled: they stay inside `outer` and are
      // not ripped out into parking (their visibility stays their owner's job).
      expect(nestedA.parentElement).toBe(outer);
      expect(nestedB.parentElement).toBe(outer);
      expect(nestedA.closest('.dock-tree__parking')).toBeNull();
      expect(nestedB.closest('.dock-tree__parking')).toBeNull();
      // And they are not exposed as composable surface ids.
      expect(el.getSurfaceIds()).toEqual(['tools']);
    });

    it('omits the center row entirely when left/middle/right are all empty', () => {
      const el = mount();
      el.setTree({
        ...EMPTY_SPEC,
        zones: { ...EMPTY_SPEC.zones, top: leaf('t'), bottom: leaf('b') },
      });
      expect(el.querySelector('.dock-tree__row')).toBeNull();
      const root = el.querySelector('.dock-tree__root') as HTMLElement;
      const dividers = Array.from(root.children).filter((c) =>
        c.classList.contains('dock-tree__divider')
      );
      expect(dividers).toHaveLength(1); // exactly between the top and bottom blocks
    });

    it('renders a single block with no divider when only one zone shows', () => {
      const el = mount();
      el.setTree({ ...EMPTY_SPEC, zones: { ...EMPTY_SPEC.zones, middle: leaf('m') } });
      expect(el.querySelectorAll('.dock-tree__divider')).toHaveLength(0);
    });
  });

  describe('recursive render', () => {
    it('a split.row in middle renders its two surfaces side by side', () => {
      const el = mount();
      el.appendChild(surface('a'));
      el.appendChild(surface('b'));
      el.setTree({
        ...EMPTY_SPEC,
        zones: { ...EMPTY_SPEC.zones, middle: split('row', [leaf('a'), leaf('b')]) },
      });

      const a = el.querySelector('slicc-surface[surface-id="a"]') as HTMLElement;
      const b = el.querySelector('slicc-surface[surface-id="b"]') as HTMLElement;
      expect(a.getBoundingClientRect().left).toBeLessThan(b.getBoundingClientRect().left);
    });

    it('renders a nested split (col of [leaf, row-split]) with 3 leaves and matching dividers', () => {
      const el = mount();
      for (const id of ['r1', 'r2a', 'r2b']) el.appendChild(surface(id));
      el.setTree({
        ...EMPTY_SPEC,
        zones: {
          ...EMPTY_SPEC.zones,
          right: split('col', [leaf('r1'), split('row', [leaf('r2a'), leaf('r2b')])]),
        },
      });

      const rightZone = el.querySelector('.dock-tree__zone[data-zone="right"]') as HTMLElement;
      expect(rightZone.querySelectorAll('.dock-tree__split--col')).toHaveLength(1);
      expect(rightZone.querySelectorAll('.dock-tree__split--row')).toHaveLength(1);
      expect(rightZone.querySelectorAll('slicc-surface')).toHaveLength(3);
      expect(rightZone.querySelectorAll('.dock-tree__divider--v')).toHaveLength(1);
      expect(rightZone.querySelectorAll('.dock-tree__divider--h')).toHaveLength(1);
    });

    it('falls back to a flex-grow of 1 when a split is missing a size entry', () => {
      const el = mount();
      el.appendChild(surface('x'));
      el.appendChild(surface('y'));
      el.setTree({
        ...EMPTY_SPEC,
        zones: {
          ...EMPTY_SPEC.zones,
          middle: { type: 'split', dir: 'row', children: [leaf('x'), leaf('y')], sizes: [] },
        },
      });
      const xLeaf = (el.querySelector('slicc-surface[surface-id="x"]') as HTMLElement).closest(
        '.dock-tree__leaf'
      ) as HTMLElement;
      const yLeaf = (el.querySelector('slicc-surface[surface-id="y"]') as HTMLElement).closest(
        '.dock-tree__leaf'
      ) as HTMLElement;
      // The browser normalizes the flex-basis component of the shorthand to `0px`.
      expect(xLeaf.style.flex).toBe('1 1 0px');
      expect(yLeaf.style.flex).toBe('1 1 0px');
    });

    it('renders an empty leaf container when a leaf references a surface not yet present', () => {
      const el = mount();
      el.setTree({ ...EMPTY_SPEC, zones: { ...EMPTY_SPEC.zones, middle: leaf('missing') } });
      const leafEl = el.querySelector(
        '.dock-tree__zone[data-zone="middle"] .dock-tree__leaf'
      ) as HTMLElement;
      expect(leafEl).toBeTruthy();
      expect(leafEl.children).toHaveLength(0);
    });
  });

  describe('surface identity + late mounts', () => {
    it('falls back to a plain id when no surface-id/data-s is present', () => {
      // The sibling's own connectedCallback clears data-s when surface-id is
      // absent, so a plain `id` is the only fallback reachable through a real
      // <slicc-surface>.
      const el = mount();
      const s = document.createElement('slicc-surface');
      s.id = 'viaPlainId';
      el.appendChild(s);
      el.setTree({ ...EMPTY_SPEC, zones: { ...EMPTY_SPEC.zones, middle: leaf('viaPlainId') } });
      expect(s.closest('.dock-tree__leaf')).toBeTruthy();
      expect(getComputedStyle(s).display).toBe('flex');
    });

    it('places a surface appended AFTER setTree once it mounts (re-syncs on child mutation)', async () => {
      const el = mount();
      el.setTree({ ...EMPTY_SPEC, zones: { ...EMPTY_SPEC.zones, middle: leaf('late') } });
      expect(el.querySelector('slicc-surface[surface-id="late"]')).toBeNull();

      el.appendChild(surface('late'));
      await Promise.resolve();

      const s = el.querySelector('slicc-surface[surface-id="late"]') as HTMLElement;
      expect(s.closest('.dock-tree__leaf')).toBeTruthy();
      expect(getComputedStyle(s).display).toBe('flex');
    });

    it('stops re-syncing once disconnected', async () => {
      const el = mount();
      el.setTree({ ...EMPTY_SPEC, zones: { ...EMPTY_SPEC.zones, middle: leaf('late') } });
      el.remove();
      el.appendChild(surface('late'));
      await Promise.resolve();
      // Disconnected: the observer is torn down, so the surface never gets
      // pulled into a leaf and is simply left as a raw child.
      const s = el.querySelector('slicc-surface[surface-id="late"]') as HTMLElement;
      expect(s.closest('.dock-tree__leaf')).toBeNull();
    });
  });

  describe('resize dividers', () => {
    /** Dispatch a `PointerEvent` with the given coords/id, bubbling (so window-level listeners fire). */
    function firePointer(
      target: EventTarget,
      type: string,
      opts: { clientX?: number; clientY?: number; pointerId?: number } = {}
    ): void {
      const { clientX = 0, clientY = 0, pointerId = 1 } = opts;
      target.dispatchEvent(
        new PointerEvent(type, {
          clientX,
          clientY,
          pointerId,
          button: 0,
          bubbles: true,
          cancelable: true,
        })
      );
    }

    it('dragging the top/bottom skeleton divider (row-resize) changes rowFr and zone heights, then fires dock-tree-resize on pointerup', () => {
      const el = mount();
      el.appendChild(surface('t'));
      el.appendChild(surface('b'));
      el.setTree({
        ...EMPTY_SPEC,
        zones: { ...EMPTY_SPEC.zones, top: leaf('t'), bottom: leaf('b') },
      });

      const dividers = el.querySelectorAll('.dock-tree__divider--v');
      expect(dividers).toHaveLength(1); // 2 shown blocks (top, bottom) -> 1 skeleton divider
      const divider = dividers[0] as HTMLElement;
      expect(getComputedStyle(divider).cursor).toBe('row-resize');

      const topZoneBefore = el.querySelector('.dock-tree__zone[data-zone="top"]') as HTMLElement;
      const bottomZoneBefore = el.querySelector(
        '.dock-tree__zone[data-zone="bottom"]'
      ) as HTMLElement;
      const heightBefore = topZoneBefore.getBoundingClientRect().height;
      const bottomHeightBefore = bottomZoneBefore.getBoundingClientRect().height;

      const rect = divider.getBoundingClientRect();
      const startY = rect.top + rect.height / 2;

      const events: CustomEvent[] = [];
      el.addEventListener('dock-tree-resize', (e) => events.push(e as CustomEvent));

      firePointer(divider, 'pointerdown', { clientX: rect.left, clientY: startY });
      firePointer(window, 'pointermove', { clientX: rect.left, clientY: startY + 40 });

      // The divider (and its former container subtree) is rebuilt on every
      // render — re-query rather than reuse the pre-drag element references.
      const tree = el.getTree();
      expect(tree.rowFr.top).toBeGreaterThan(1);
      expect(tree.rowFr.bottom).toBeLessThan(1);
      expect(tree.rowFr.top + tree.rowFr.bottom).toBeCloseTo(2, 5);

      const topZoneAfter = el.querySelector('.dock-tree__zone[data-zone="top"]') as HTMLElement;
      const bottomZoneAfter = el.querySelector(
        '.dock-tree__zone[data-zone="bottom"]'
      ) as HTMLElement;
      expect(topZoneAfter.getBoundingClientRect().height).toBeGreaterThan(heightBefore);
      expect(bottomZoneAfter.getBoundingClientRect().height).toBeLessThan(bottomHeightBefore);

      expect(events).toHaveLength(0); // no event yet — only fires on pointerup
      firePointer(window, 'pointerup', { clientX: rect.left, clientY: startY + 40 });

      expect(events).toHaveLength(1);
      expect(events[0].bubbles).toBe(true);
      expect(events[0].composed).toBe(true);
      expect(events[0].detail.tree).toEqual(el.getTree());
      expect(events[0].detail.tree.rowFr.top).toBeCloseTo(tree.rowFr.top, 5);
    });

    it('dragging a left/right skeleton divider (col-resize) changes colFr and zone widths', () => {
      const el = mount();
      el.appendChild(surface('l'));
      el.appendChild(surface('r'));
      el.setTree({
        ...EMPTY_SPEC,
        zones: { ...EMPTY_SPEC.zones, left: leaf('l'), right: leaf('r') },
      });

      const dividers = el.querySelectorAll('.dock-tree__divider--h');
      expect(dividers).toHaveLength(1); // 2 shown center zones (left, right) -> 1 divider
      const divider = dividers[0] as HTMLElement;
      expect(getComputedStyle(divider).cursor).toBe('col-resize');

      const leftZone = el.querySelector('.dock-tree__zone[data-zone="left"]') as HTMLElement;
      const rightZone = el.querySelector('.dock-tree__zone[data-zone="right"]') as HTMLElement;
      const leftWidthBefore = leftZone.getBoundingClientRect().width;
      const rightWidthBefore = rightZone.getBoundingClientRect().width;

      const rect = divider.getBoundingClientRect();
      const startX = rect.left + rect.width / 2;
      firePointer(divider, 'pointerdown', { clientX: startX, clientY: rect.top });
      firePointer(window, 'pointermove', { clientX: startX + 40, clientY: rect.top });

      const tree = el.getTree();
      expect(tree.colFr.left).toBeGreaterThan(1);
      expect(tree.colFr.right).toBeLessThan(1);

      const leftZoneAfter = el.querySelector('.dock-tree__zone[data-zone="left"]') as HTMLElement;
      const rightZoneAfter = el.querySelector('.dock-tree__zone[data-zone="right"]') as HTMLElement;
      expect(leftZoneAfter.getBoundingClientRect().width).toBeGreaterThan(leftWidthBefore);
      expect(rightZoneAfter.getBoundingClientRect().width).toBeLessThan(rightWidthBefore);

      firePointer(window, 'pointerup', { clientX: startX + 40, clientY: rect.top });
    });

    it('clamps a skeleton divider drag to 2% of the pair instead of going negative', () => {
      const el = mount();
      el.setTree({
        ...EMPTY_SPEC,
        zones: { ...EMPTY_SPEC.zones, top: leaf('t'), bottom: leaf('b') },
      });
      const divider = el.querySelector('.dock-tree__divider--v') as HTMLElement;
      const rect = divider.getBoundingClientRect();
      const startY = rect.top + rect.height / 2;

      firePointer(divider, 'pointerdown', { clientX: rect.left, clientY: startY });
      // Drag far past the top of the container -> top fr should clamp at 2% of
      // the pair (top + bottom start at 1 + 1 = 2, so floor = 0.04), not go to
      // 0/negative — and matches the floor `setSurfaceSize` enforces too.
      firePointer(window, 'pointermove', { clientX: rect.left, clientY: -10000 });

      const tree = el.getTree();
      expect(tree.rowFr.top).toBeCloseTo(0.04, 5);
      expect(tree.rowFr.bottom).toBeCloseTo(1.96, 5);

      firePointer(window, 'pointerup', { clientX: rect.left, clientY: -10000 });
    });

    it('dragging an in-zone (node) divider resizes node.sizes and the rendered widths, and fires dock-tree-resize', () => {
      const el = mount();
      el.appendChild(surface('x'));
      el.appendChild(surface('y'));
      el.setTree({
        ...EMPTY_SPEC,
        zones: { ...EMPTY_SPEC.zones, middle: split('row', [leaf('x'), leaf('y')]) },
      });

      const dividers = el.querySelectorAll(
        '.dock-tree__zone[data-zone="middle"] .dock-tree__divider--h'
      );
      expect(dividers).toHaveLength(1); // a 2-child split -> 1 in-zone divider
      const divider = dividers[0] as HTMLElement;

      const xLeaf = (el.querySelector('slicc-surface[surface-id="x"]') as HTMLElement).closest(
        '.dock-tree__leaf'
      ) as HTMLElement;
      const widthBefore = xLeaf.getBoundingClientRect().width;

      const rect = divider.getBoundingClientRect();
      const startX = rect.left + rect.width / 2;

      const events: CustomEvent[] = [];
      el.addEventListener('dock-tree-resize', (e) => events.push(e as CustomEvent));

      firePointer(divider, 'pointerdown', { clientX: startX, clientY: rect.top });
      firePointer(window, 'pointermove', { clientX: startX + 60, clientY: rect.top });

      const tree = el.getTree();
      const node = tree.zones.middle as Extract<DockNode, { type: 'split' }>;
      expect(node.sizes[0]).toBeGreaterThan(1);
      expect(node.sizes[1]).toBeLessThan(1);
      expect(node.sizes[0] + node.sizes[1]).toBeCloseTo(2, 5);

      const xLeafAfter = (el.querySelector('slicc-surface[surface-id="x"]') as HTMLElement).closest(
        '.dock-tree__leaf'
      ) as HTMLElement;
      expect(xLeafAfter.getBoundingClientRect().width).toBeGreaterThan(widthBefore);

      firePointer(window, 'pointerup', { clientX: startX + 60, clientY: rect.top });
      expect(events).toHaveLength(1);
      expect(events[0].detail.tree).toEqual(el.getTree());
    });
  });

  describe('getSurfaceIds', () => {
    it('returns [] for an all-empty tree', () => {
      const el = mount();
      expect(el.getSurfaceIds()).toEqual([]);
    });

    it('collects leaf ids depth-first, in zone order, skipping empty zones', () => {
      const el = mount();
      el.setTree({
        ...EMPTY_SPEC,
        zones: {
          ...EMPTY_SPEC.zones,
          left: leaf('l1'),
          middle: split('row', [leaf('m1'), leaf('m2')]),
          bottom: leaf('b1'),
        },
      });
      expect(el.getSurfaceIds()).toEqual(['l1', 'm1', 'm2', 'b1']);
    });
  });

  describe('internal drag-drop', () => {
    /** Dispatch a `PointerEvent` with the given coords/id, bubbling (so window-level listeners fire). */
    function firePointer(
      target: EventTarget,
      type: string,
      opts: { clientX?: number; clientY?: number; pointerId?: number } = {}
    ): void {
      const { clientX = 0, clientY = 0, pointerId = 1 } = opts;
      target.dispatchEvent(
        new PointerEvent(type, {
          clientX,
          clientY,
          pointerId,
          button: 0,
          bubbles: true,
          cancelable: true,
        })
      );
    }

    /** The `.dock-tree__tile` currently composing `surfaceId` (re-query after every render-triggering action). */
    function tileFor(el: SliccDockTree, surfaceId: string): HTMLElement {
      const s = el.querySelector(`slicc-surface[surface-id="${surfaceId}"]`) as HTMLElement;
      return s.closest('.dock-tree__tile') as HTMLElement;
    }

    /** The `.dock-tree__tile-move` hover-reveal button for `surfaceId`'s current tile. */
    function moveButtonFor(el: SliccDockTree, surfaceId: string): HTMLElement {
      return tileFor(el, surfaceId).querySelector('.dock-tree__tile-move') as HTMLElement;
    }

    /** `pointerdown` on `surfaceId`'s move button — starts the drag (re-renders synchronously). */
    function startDragOn(el: SliccDockTree, surfaceId: string): void {
      el.tilesMovable = true;
      const button = moveButtonFor(el, surfaceId);
      const rect = button.getBoundingClientRect();
      firePointer(button, 'pointerdown', {
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
      });
    }

    /** Move to, then drop at, a point (fires `pointermove` then `pointerup` on `window`). */
    function moveAndDrop(x: number, y: number): void {
      firePointer(window, 'pointermove', { clientX: x, clientY: y });
      firePointer(window, 'pointerup', { clientX: x, clientY: y });
    }

    /** A point inside `rect` at fractional offsets `(fx, fy)` (0..1) — matches the prototype's `regionForPoint` math. */
    function pointIn(rect: DOMRect, fx: number, fy: number): { x: number; y: number } {
      return { x: rect.left + rect.width * fx, y: rect.top + rect.height * fy };
    }

    it("drag leaf A onto leaf B's east edge -> B's zone becomes a row split [B, A] (A to the right)", () => {
      const el = mount();
      for (const id of ['top', 'left', 'middle', 'right', 'bottom']) el.appendChild(surface(id));
      el.setTree(standardSpec());

      startDragOn(el, 'left');
      const targetRect = tileFor(el, 'middle').getBoundingClientRect();
      const p = pointIn(targetRect, 0.95, 0.5); // east edge
      moveAndDrop(p.x, p.y);

      const tree = el.getTree();
      expect(tree.zones.left).toBeNull();
      const middleNode = tree.zones.middle as Extract<DockNode, { type: 'split' }>;
      expect(middleNode.type).toBe('split');
      expect(middleNode.dir).toBe('row');
      expect(middleNode.children).toEqual([leaf('middle'), leaf('left')]);

      const middleSurface = el.querySelector('slicc-surface[surface-id="middle"]') as HTMLElement;
      const leftSurface = el.querySelector('slicc-surface[surface-id="left"]') as HTMLElement;
      expect(middleSurface.getBoundingClientRect().left).toBeLessThan(
        leftSurface.getBoundingClientRect().left
      );
      // The vacated `left` zone is gone from normal rendering (collapsed).
      expect(el.querySelector('.dock-tree__zone[data-zone="left"]')).toBeNull();
    });

    it("drag leaf A onto leaf B's north edge -> B's zone becomes a col split with A first", () => {
      const el = mount();
      for (const id of ['top', 'left', 'middle', 'right', 'bottom']) el.appendChild(surface(id));
      el.setTree(standardSpec());

      startDragOn(el, 'top');
      const targetRect = tileFor(el, 'middle').getBoundingClientRect();
      const p = pointIn(targetRect, 0.5, 0.05); // north edge
      moveAndDrop(p.x, p.y);

      const tree = el.getTree();
      expect(tree.zones.top).toBeNull();
      const middleNode = tree.zones.middle as Extract<DockNode, { type: 'split' }>;
      expect(middleNode.dir).toBe('col');
      expect(middleNode.children).toEqual([leaf('top'), leaf('middle')]);
    });

    it('drag onto the south edge -> col split with the target first, dragged leaf last', () => {
      const el = mount();
      for (const id of ['top', 'left', 'middle', 'right', 'bottom']) el.appendChild(surface(id));
      el.setTree(standardSpec());

      startDragOn(el, 'right');
      const targetRect = tileFor(el, 'middle').getBoundingClientRect();
      const p = pointIn(targetRect, 0.5, 0.95); // south edge
      moveAndDrop(p.x, p.y);

      const tree = el.getTree();
      expect(tree.zones.right).toBeNull();
      const middleNode = tree.zones.middle as Extract<DockNode, { type: 'split' }>;
      expect(middleNode.dir).toBe('col');
      expect(middleNode.children).toEqual([leaf('middle'), leaf('right')]);
    });

    it('drag onto the west edge -> row split with the dragged leaf first (before)', () => {
      const el = mount();
      for (const id of ['top', 'left', 'middle', 'right', 'bottom']) el.appendChild(surface(id));
      el.setTree(standardSpec());

      startDragOn(el, 'right');
      const targetRect = tileFor(el, 'middle').getBoundingClientRect();
      const p = pointIn(targetRect, 0.05, 0.5); // west edge
      moveAndDrop(p.x, p.y);

      const tree = el.getTree();
      expect(tree.zones.right).toBeNull();
      const middleNode = tree.zones.middle as Extract<DockNode, { type: 'split' }>;
      expect(middleNode.dir).toBe('row');
      expect(middleNode.children).toEqual([leaf('right'), leaf('middle')]);
    });

    it('drag onto the center -> col-stack with the target first, dragged leaf below', () => {
      const el = mount();
      for (const id of ['top', 'left', 'middle', 'right', 'bottom']) el.appendChild(surface(id));
      el.setTree(standardSpec());

      startDragOn(el, 'right');
      const targetRect = tileFor(el, 'middle').getBoundingClientRect();
      const p = pointIn(targetRect, 0.5, 0.5); // dead center
      moveAndDrop(p.x, p.y);

      const tree = el.getTree();
      expect(tree.zones.right).toBeNull();
      const middleNode = tree.zones.middle as Extract<DockNode, { type: 'split' }>;
      expect(middleNode.dir).toBe('col');
      expect(middleNode.children).toEqual([leaf('middle'), leaf('right')]);
    });

    it("dragging a zone's only leaf out to another empty zone collapses the source, and it is re-droppable during a later drag", () => {
      const el = mount();
      el.appendChild(surface('left'));
      el.appendChild(surface('middle'));
      el.setTree({
        ...EMPTY_SPEC,
        zones: { ...EMPTY_SPEC.zones, left: leaf('left'), middle: leaf('middle') },
      });
      expect(el.querySelector('.dock-tree__zone[data-zone="right"]')).toBeNull(); // collapsed before any drag

      startDragOn(el, 'left');
      // Empty zones render live as drop placeholders while dragging (Task 1's dead branch, now live).
      const rightZone = el.querySelector('.dock-tree__zone[data-zone="right"]') as HTMLElement;
      expect(rightZone).toBeTruthy();
      const placeholder = rightZone.querySelector('.dock-tree__empty') as HTMLElement;
      expect(placeholder).toBeTruthy();
      const r = placeholder.getBoundingClientRect();
      moveAndDrop(r.left + r.width / 2, r.top + r.height / 2);

      let tree = el.getTree();
      expect(tree.zones.left).toBeNull();
      expect(tree.zones.right).toEqual(leaf('left'));
      expect(el.querySelector('.dock-tree__zone[data-zone="left"]')).toBeNull(); // collapsed, not rendered normally

      // Start a second drag: the now-empty `left` zone must render live as a placeholder again.
      startDragOn(el, 'middle');
      const leftZoneDuringDrag = el.querySelector(
        '.dock-tree__zone[data-zone="left"]'
      ) as HTMLElement;
      expect(leftZoneDuringDrag).toBeTruthy();
      expect(leftZoneDuringDrag.querySelector('.dock-tree__empty')).toBeTruthy();

      // Cancel this drag by dropping on the dragged tile itself (self-drop) — no mutation, no event.
      const events: CustomEvent[] = [];
      el.addEventListener('dock-tree-change', (e) => events.push(e as CustomEvent));
      const selfRect = tileFor(el, 'middle').getBoundingClientRect();
      moveAndDrop(selfRect.left + selfRect.width / 2, selfRect.top + selfRect.height / 2);

      expect(events).toHaveLength(0);
      tree = el.getTree();
      expect(tree.zones.middle).toEqual(leaf('middle')); // unchanged
      expect(el.querySelector('.dock-tree__zone[data-zone="left"]')).toBeNull(); // collapsed again once the drag ends
    });

    it('fires dock-tree-change (composed + bubbling) with the new tree after a successful drop', () => {
      const el = mount();
      for (const id of ['top', 'left', 'middle', 'right', 'bottom']) el.appendChild(surface(id));
      el.setTree(standardSpec());

      const events: CustomEvent[] = [];
      el.addEventListener('dock-tree-change', (e) => events.push(e as CustomEvent));

      startDragOn(el, 'left');
      const targetRect = tileFor(el, 'middle').getBoundingClientRect();
      const p = pointIn(targetRect, 0.95, 0.5);
      moveAndDrop(p.x, p.y);

      expect(events).toHaveLength(1);
      expect(events[0].bubbles).toBe(true);
      expect(events[0].composed).toBe(true);
      expect(events[0].detail.tree).toEqual(el.getTree());
    });

    it('drops nowhere valid (no zone under the cursor) cancel cleanly: no mutation, no event', () => {
      const el = mount();
      for (const id of ['top', 'left', 'middle', 'right', 'bottom']) el.appendChild(surface(id));
      el.setTree(standardSpec());
      const before = el.getTree();

      const events: CustomEvent[] = [];
      el.addEventListener('dock-tree-change', (e) => events.push(e as CustomEvent));

      startDragOn(el, 'left');
      // Far outside the mounted tree (and the viewport) -> elementFromPoint resolves to nothing usable.
      moveAndDrop(-500, -500);

      expect(events).toHaveLength(0);
      expect(el.getTree()).toEqual(before);
    });

    it('hovering an element outside any zone clears the pending drop target (no mutation on drop)', () => {
      const el = mount();
      for (const id of ['top', 'left', 'middle', 'right', 'bottom']) el.appendChild(surface(id));
      el.setTree(standardSpec());
      const before = el.getTree();

      // A fixed-position sibling well clear of the 600x400 mounted host, but inside the
      // 1280x900 test viewport — guaranteed to resolve via `elementFromPoint` while NOT
      // being (or being inside) any `.dock-tree__zone`. Exercises the "no zoneEl" branch.
      const outsider = document.createElement('div');
      outsider.style.position = 'fixed';
      outsider.style.left = '1000px';
      outsider.style.top = '850px';
      outsider.style.width = '50px';
      outsider.style.height = '40px';
      document.body.appendChild(outsider);

      startDragOn(el, 'left');
      moveAndDrop(1025, 870);

      expect(el.getTree()).toEqual(before);
      outsider.remove();
    });

    it('hovering the dragged tile itself shows no preview and drop is a no-op', () => {
      const el = mount();
      for (const id of ['top', 'left', 'middle', 'right', 'bottom']) el.appendChild(surface(id));
      el.setTree(standardSpec());
      const before = el.getTree();

      startDragOn(el, 'middle');
      const selfRect = tileFor(el, 'middle').getBoundingClientRect();
      moveAndDrop(selfRect.left + selfRect.width / 2, selfRect.top + selfRect.height / 2);

      expect(el.getTree()).toEqual(before);
    });

    it('shows a floating ghost while dragging, labeled with the surfaceId, and hides it on drop', () => {
      const el = mount();
      for (const id of ['top', 'left', 'middle', 'right', 'bottom']) el.appendChild(surface(id));
      el.setTree(standardSpec());

      startDragOn(el, 'left');
      const ghost = el.querySelector('.dock-tree__ghost') as HTMLElement;
      expect(ghost).toBeTruthy();
      expect(ghost.classList.contains('dock-tree__ghost--active')).toBe(true);
      expect(ghost.textContent).toBe('left');

      moveAndDrop(-500, -500); // cancel
      expect(ghost.classList.contains('dock-tree__ghost--active')).toBe(false);
    });

    it('shows a drop-region preview overlay while hovering a valid target, and hides it on drop', () => {
      const el = mount();
      for (const id of ['top', 'left', 'middle', 'right', 'bottom']) el.appendChild(surface(id));
      el.setTree(standardSpec());

      startDragOn(el, 'left');
      const preview = el.querySelector('.dock-tree__preview') as HTMLElement;
      expect(preview.classList.contains('dock-tree__preview--active')).toBe(false);

      const targetRect = tileFor(el, 'middle').getBoundingClientRect();
      const p = pointIn(targetRect, 0.95, 0.5);
      firePointer(window, 'pointermove', { clientX: p.x, clientY: p.y });
      expect(preview.classList.contains('dock-tree__preview--active')).toBe(true);
      // East-edge preview should be the right half of the target's rect.
      expect(Number.parseFloat(preview.style.width)).toBeCloseTo(targetRect.width / 2, 0);

      firePointer(window, 'pointerup', { clientX: p.x, clientY: p.y });
      expect(preview.classList.contains('dock-tree__preview--active')).toBe(false);
    });

    it('the move button is labeled with the surfaceId (title/aria-label) and shows a grab cursor', () => {
      const el = mountWithTileDrag();
      el.appendChild(surface('middle'));
      el.setTree({ ...EMPTY_SPEC, zones: { ...EMPTY_SPEC.zones, middle: leaf('middle') } });
      const button = moveButtonFor(el, 'middle');
      expect(button.title).toBe('middle');
      expect(button.getAttribute('aria-label')).toBe('Move middle');
      expect(getComputedStyle(button).cursor).toBe('grab');
    });

    it('abandons an in-progress drag cleanly when the host disconnects mid-drag', () => {
      const el = mount();
      for (const id of ['top', 'left', 'middle', 'right', 'bottom']) el.appendChild(surface(id));
      el.setTree(standardSpec());
      const before = el.getTree();

      startDragOn(el, 'left');
      el.remove();

      // Listeners were torn down on disconnect — this must not throw or mutate anything once reconnected.
      const targetRect = tileFor(el, 'middle')?.getBoundingClientRect();
      if (targetRect) moveAndDrop(targetRect.left + 1, targetRect.top + 1);
      document.body.appendChild(el);
      expect(el.getTree()).toEqual(before);
    });

    it("4-column: dragging the bottom leaf onto middle's east edge renders 4 leaves left-to-right in the center row", () => {
      const el = mount();
      for (const id of ['top', 'left', 'middle', 'right', 'bottom']) el.appendChild(surface(id));
      el.setTree(standardSpec());

      startDragOn(el, 'bottom');
      const targetRect = tileFor(el, 'middle').getBoundingClientRect();
      const p = pointIn(targetRect, 0.95, 0.5); // east edge
      moveAndDrop(p.x, p.y);

      expect(el.getTree().zones.bottom).toBeNull();
      const centerRow = el.querySelector('.dock-tree__row') as HTMLElement;
      const tiles = Array.from(centerRow.querySelectorAll('.dock-tree__tile')) as HTMLElement[];
      expect(tiles).toHaveLength(4);
      const lefts = tiles.map((t) => t.getBoundingClientRect().left);
      const sorted = [...lefts].sort((a, b) => a - b);
      expect(lefts).toEqual(sorted);
      // strictly ascending (no two tiles at the same x)
      for (let i = 1; i < sorted.length; i++) expect(sorted[i]).toBeGreaterThan(sorted[i - 1]);
    });

    it('adds dock-tree__zone--droppable to every rendered zone for the drag duration, removed on drop', () => {
      const el = mount();
      for (const id of ['top', 'left', 'middle', 'right', 'bottom']) el.appendChild(surface(id));
      el.setTree(standardSpec());
      expect(el.querySelectorAll('.dock-tree__zone--droppable')).toHaveLength(0);

      startDragOn(el, 'left');
      const zonesDuringDrag = Array.from(el.querySelectorAll('.dock-tree__zone')) as HTMLElement[];
      expect(zonesDuringDrag.length).toBeGreaterThan(0);
      for (const z of zonesDuringDrag) {
        expect(z.classList.contains('dock-tree__zone--droppable')).toBe(true);
      }

      moveAndDrop(-500, -500); // cancel
      expect(el.querySelectorAll('.dock-tree__zone--droppable')).toHaveLength(0);
    });
  });

  describe('placeSurface', () => {
    it('places a surface into an empty zone as a bare leaf', () => {
      const el = mount();
      el.appendChild(surface('sprinkle:x'));
      el.placeSurface('sprinkle:x', 'right');
      expect(el.getTree().zones.right).toEqual(leaf('sprinkle:x'));
      const s = el.querySelector('slicc-surface[surface-id="sprinkle:x"]') as HTMLElement;
      expect(s.closest('.dock-tree__leaf')).toBeTruthy();
      expect(getComputedStyle(s).display).toBe('flex');
    });

    it('appends a split when placed into a non-empty zone', () => {
      const el = mount();
      el.appendChild(surface('right'));
      el.appendChild(surface('sprinkle:x'));
      el.setTree({ ...EMPTY_SPEC, zones: { ...EMPTY_SPEC.zones, right: leaf('right') } });

      el.placeSurface('sprinkle:x', 'right');

      const node = el.getTree().zones.right as Extract<DockNode, { type: 'split' }>;
      expect(node.type).toBe('split');
      expect(node.children).toContainEqual(leaf('right'));
      expect(node.children).toContainEqual(leaf('sprinkle:x'));
      expect(node.children).toHaveLength(2);
    });

    it('flattens onto an existing same-direction (col) split instead of nesting', () => {
      const el = mount();
      el.setTree({
        ...EMPTY_SPEC,
        zones: { ...EMPTY_SPEC.zones, right: split('col', [leaf('r1'), leaf('r2')]) },
      });
      el.placeSurface('r3', 'right');
      const node = el.getTree().zones.right as Extract<DockNode, { type: 'split' }>;
      expect(node.type).toBe('split');
      expect(node.dir).toBe('col');
      expect(node.children).toEqual([leaf('r1'), leaf('r2'), leaf('r3')]);
    });

    it('is a no-op when the surfaceId is already somewhere in the tree (no duplicate)', () => {
      const el = mount();
      el.setTree(standardSpec());
      const before = el.getTree();

      const events: CustomEvent[] = [];
      el.addEventListener('dock-tree-change', (e) => events.push(e as CustomEvent));

      el.placeSurface('middle', 'right'); // 'middle' already placed in the `middle` zone
      expect(el.getTree()).toEqual(before);
      expect(events).toHaveLength(0);
    });

    it('fires dock-tree-change when it actually places a surface', () => {
      const el = mount();
      const events: CustomEvent[] = [];
      el.addEventListener('dock-tree-change', (e) => events.push(e as CustomEvent));
      el.placeSurface('sprinkle:x', 'right');
      expect(events).toHaveLength(1);
      expect(events[0].bubbles).toBe(true);
      expect(events[0].composed).toBe(true);
      expect(events[0].detail.tree).toEqual(el.getTree());
    });

    it('works before the host connects, applying once appended (mirrors setTree lazy render)', () => {
      const el = document.createElement('slicc-dock-tree') as SliccDockTree;
      el.style.width = '600px';
      el.style.height = '400px';
      el.placeSurface('m', 'middle');
      expect(el.isConnected).toBe(false);
      expect(el.getTree().zones.middle).toEqual(leaf('m'));
      document.body.appendChild(el);
      expect(el.querySelector('.dock-tree__zone[data-zone="middle"]')).toBeTruthy();
    });
  });

  describe('removeSurface', () => {
    it('collapses an emptied zone to null', () => {
      const el = mount();
      el.appendChild(surface('middle'));
      el.setTree({ ...EMPTY_SPEC, zones: { ...EMPTY_SPEC.zones, middle: leaf('middle') } });

      el.removeSurface('middle');

      expect(el.getTree().zones.middle).toBeNull();
      expect(el.querySelector('.dock-tree__zone[data-zone="middle"]')).toBeNull();
      const s = el.querySelector('slicc-surface[surface-id="middle"]') as HTMLElement;
      expect(getComputedStyle(s).display).toBe('none');
      expect(s.parentElement?.classList.contains('dock-tree__parking')).toBe(true);
    });

    it('detaches one leaf of a split without disturbing its sibling', () => {
      const el = mount();
      el.appendChild(surface('x'));
      el.appendChild(surface('y'));
      el.setTree({
        ...EMPTY_SPEC,
        zones: { ...EMPTY_SPEC.zones, middle: split('row', [leaf('x'), leaf('y')]) },
      });

      el.removeSurface('x');

      expect(el.getTree().zones.middle).toEqual(leaf('y'));
    });

    it('is a no-op when the surfaceId is absent (no render churn, no event)', () => {
      const el = mount();
      el.setTree(standardSpec());
      const before = el.getTree();
      const events: CustomEvent[] = [];
      el.addEventListener('dock-tree-change', (e) => events.push(e as CustomEvent));

      el.removeSurface('does-not-exist');

      expect(el.getTree()).toEqual(before);
      expect(events).toHaveLength(0);
    });

    it('fires dock-tree-change when it actually removes a surface', () => {
      const el = mount();
      el.setTree({ ...EMPTY_SPEC, zones: { ...EMPTY_SPEC.zones, middle: leaf('middle') } });
      const events: CustomEvent[] = [];
      el.addEventListener('dock-tree-change', (e) => events.push(e as CustomEvent));

      el.removeSurface('middle');

      expect(events).toHaveLength(1);
      expect(events[0].bubbles).toBe(true);
      expect(events[0].composed).toBe(true);
      expect(events[0].detail.tree).toEqual(el.getTree());
    });

    it('works before the host connects, applying without requiring a render (mirrors placeSurface lazy-render)', () => {
      const el = document.createElement('slicc-dock-tree') as SliccDockTree;
      el.style.width = '600px';
      el.style.height = '400px';
      el.setTree({ ...EMPTY_SPEC, zones: { ...EMPTY_SPEC.zones, middle: leaf('middle') } });
      expect(el.isConnected).toBe(false);

      el.removeSurface('middle');

      expect(el.isConnected).toBe(false);
      expect(el.getTree().zones.middle).toBeNull();
    });
  });

  describe('moveSurfaceToZone', () => {
    it("relocates a placed leaf to become the destination zone's sole occupant", () => {
      const el = mount();
      el.setTree({
        ...EMPTY_SPEC,
        zones: { ...EMPTY_SPEC.zones, left: leaf('x'), right: leaf('other') },
      });

      el.moveSurfaceToZone('x', 'right');

      expect(el.getTree().zones.left).toBeNull();
      expect(el.getTree().zones.right).toEqual(leaf('x'));
    });

    it('does not clobber the destination zone when surfaceId is not placed anywhere (falls through to placeSurface)', () => {
      const el = mount();
      el.setTree({ ...EMPTY_SPEC, zones: { ...EMPTY_SPEC.zones, right: leaf('other') } });

      el.moveSurfaceToZone('sprinkle:not-yet-open', 'right');

      // 'other' must survive — the bug clobbered it outright.
      expect(el.getSurfaceIds()).toContain('other');
      expect(el.getSurfaceIds()).toContain('sprinkle:not-yet-open');
    });

    it('is a no-op when surfaceId is already the sole occupant of zone', () => {
      const el = mount();
      el.setTree({ ...EMPTY_SPEC, zones: { ...EMPTY_SPEC.zones, right: leaf('x') } });
      const events: CustomEvent[] = [];
      el.addEventListener('dock-tree-change', (e) => events.push(e as CustomEvent));

      el.moveSurfaceToZone('x', 'right');

      expect(events).toHaveLength(0);
    });
  });

  describe('external drag-drop (beginExternalDrag)', () => {
    /** Dispatch a `PointerEvent` with the given coords/id, bubbling (so window-level listeners fire). */
    function firePointer(
      target: EventTarget,
      type: string,
      opts: { clientX?: number; clientY?: number; pointerId?: number } = {}
    ): void {
      const { clientX = 0, clientY = 0, pointerId = 1 } = opts;
      target.dispatchEvent(
        new PointerEvent(type, {
          clientX,
          clientY,
          pointerId,
          button: 0,
          bubbles: true,
          cancelable: true,
        })
      );
    }

    /** Move to, then drop at, a point (fires `pointermove` then `pointerup` on `window`). */
    function moveAndDrop(x: number, y: number): void {
      firePointer(window, 'pointermove', { clientX: x, clientY: y });
      firePointer(window, 'pointerup', { clientX: x, clientY: y });
    }

    /** A point inside `rect` at fractional offsets `(fx, fy)` (0..1). */
    function pointIn(rect: DOMRect, fx: number, fy: number): { x: number; y: number } {
      return { x: rect.left + rect.width * fx, y: rect.top + rect.height * fy };
    }

    /** Opt the component into tile drag, then enter its public external-drag path. */
    function beginEnabledExternalDrag(
      el: SliccDockTree,
      surfaceId: string,
      pointerId?: number
    ): void {
      el.tilesMovable = true;
      el.beginExternalDrag(surfaceId, pointerId);
    }

    it("lands a brand-new leaf via the drop-region path when dropped on a tile's edge, and fires dock-tree-change", () => {
      const el = mount();
      for (const id of ['top', 'left', 'middle', 'right', 'bottom']) el.appendChild(surface(id));
      el.setTree(standardSpec());
      el.appendChild(surface('sprinkle:rail')); // mounted up front, as the webapp would before the drop lands

      const events: CustomEvent[] = [];
      el.addEventListener('dock-tree-change', (e) => events.push(e as CustomEvent));

      beginEnabledExternalDrag(el, 'sprinkle:rail', 7);
      // Empty zones render live as placeholders during ANY drag (internal or external).
      const ghost = el.querySelector('.dock-tree__ghost') as HTMLElement;
      expect(ghost.classList.contains('dock-tree__ghost--active')).toBe(true);
      expect(ghost.textContent).toBe('sprinkle:rail');

      const targetRect = (el.querySelector('slicc-surface[surface-id="middle"]') as HTMLElement)
        .closest('.dock-tree__tile')!
        .getBoundingClientRect();
      const p = pointIn(targetRect, 0.95, 0.5); // east edge
      moveAndDrop(p.x, p.y);

      const tree = el.getTree();
      const middleNode = tree.zones.middle as Extract<DockNode, { type: 'split' }>;
      expect(middleNode.type).toBe('split');
      expect(middleNode.dir).toBe('row');
      expect(middleNode.children).toEqual([leaf('middle'), leaf('sprinkle:rail')]);

      expect(events).toHaveLength(1);
      expect(events[0].bubbles).toBe(true);
      expect(events[0].composed).toBe(true);
      expect(events[0].detail.tree).toEqual(tree);

      const railSurface = el.querySelector(
        'slicc-surface[surface-id="sprinkle:rail"]'
      ) as HTMLElement;
      expect(railSurface.closest('.dock-tree__tile')).toBeTruthy();
      expect(getComputedStyle(railSurface).display).toBe('flex');
    });

    it('lands into an empty zone outright', () => {
      const el = mount();
      el.appendChild(surface('sprinkle:rail'));
      beginEnabledExternalDrag(el, 'sprinkle:rail');

      const rightZone = el.querySelector('.dock-tree__zone[data-zone="right"]') as HTMLElement;
      const placeholder = rightZone.querySelector('.dock-tree__empty') as HTMLElement;
      const r = placeholder.getBoundingClientRect();
      moveAndDrop(r.left + r.width / 2, r.top + r.height / 2);

      expect(el.getTree().zones.right).toEqual(leaf('sprinkle:rail'));
    });

    it('leaves the leaf slot empty when the surface element has not mounted yet', () => {
      const el = mount();
      // No <slicc-surface surface-id="sprinkle:rail"> appended anywhere.
      beginEnabledExternalDrag(el, 'sprinkle:rail');
      const rightZone = el.querySelector('.dock-tree__zone[data-zone="right"]') as HTMLElement;
      const placeholder = rightZone.querySelector('.dock-tree__empty') as HTMLElement;
      const r = placeholder.getBoundingClientRect();
      moveAndDrop(r.left + r.width / 2, r.top + r.height / 2);

      expect(el.getTree().zones.right).toEqual(leaf('sprinkle:rail'));
      const leafEl = el.querySelector(
        '.dock-tree__zone[data-zone="right"] .dock-tree__leaf'
      ) as HTMLElement;
      expect(leafEl).toBeTruthy();
      expect(leafEl.children).toHaveLength(0);
    });

    it('cancels cleanly (no mutation, no event) when dropped nowhere valid', () => {
      const el = mount();
      el.setTree(standardSpec());
      const before = el.getTree();
      const events: CustomEvent[] = [];
      el.addEventListener('dock-tree-change', (e) => events.push(e as CustomEvent));

      beginEnabledExternalDrag(el, 'sprinkle:rail');
      moveAndDrop(-500, -500);

      expect(el.getTree()).toEqual(before);
      expect(events).toHaveLength(0);
    });

    it('tags every rendered zone droppable during an external drag too', () => {
      const el = mount();
      el.setTree(standardSpec());
      beginEnabledExternalDrag(el, 'sprinkle:rail');
      const zones = Array.from(el.querySelectorAll('.dock-tree__zone')) as HTMLElement[];
      expect(zones.length).toBeGreaterThan(0);
      for (const z of zones) expect(z.classList.contains('dock-tree__zone--droppable')).toBe(true);
      moveAndDrop(-500, -500);
      expect(el.querySelectorAll('.dock-tree__zone--droppable')).toHaveLength(0);
    });

    it('rejects the drop (no duplicate leaf, no event) when beginExternalDrag targets a surfaceId already docked elsewhere', () => {
      const el = mount();
      for (const id of ['top', 'left', 'middle', 'right', 'bottom']) el.appendChild(surface(id));
      el.setTree(standardSpec());
      const before = el.getTree();

      const events: CustomEvent[] = [];
      el.addEventListener('dock-tree-change', (e) => events.push(e as CustomEvent));

      // 'middle' is already docked in the `middle` zone — beginExternalDrag it
      // as if it were a fresh drag from outside, then drop on a DIFFERENT
      // zone's tile edge.
      beginEnabledExternalDrag(el, 'middle');
      const targetRect = (el.querySelector('slicc-surface[surface-id="right"]') as HTMLElement)
        .closest('.dock-tree__tile')!
        .getBoundingClientRect();
      const p = pointIn(targetRect, 0.95, 0.5); // east edge of the `right` zone's tile
      moveAndDrop(p.x, p.y);

      // No mutation at all: tree is byte-for-byte the same as before the drop.
      expect(el.getTree()).toEqual(before);
      // No duplicate leaf anywhere, and no spurious empty zone left behind.
      expect(el.getSurfaceIds().filter((id) => id === 'middle')).toHaveLength(1);
      expect(el.getSurfaceIds().sort()).toEqual(
        ['bottom', 'left', 'middle', 'right', 'top'].sort()
      );
      expect(el.querySelector('.dock-tree__zone[data-zone="middle"] .dock-tree__empty')).toBeNull();
      // No spurious dock-tree-change for the rejected drop.
      expect(events).toHaveLength(0);
      // Drag state cleared cleanly, same as any other cancelled drop.
      const ghost = el.querySelector('.dock-tree__ghost') as HTMLElement;
      expect(ghost.classList.contains('dock-tree__ghost--active')).toBe(false);
      expect(el.querySelectorAll('.dock-tree__zone--droppable')).toHaveLength(0);
    });
  });

  describe('labelForSurface (friendly tile labels)', () => {
    it('special-cases the reserved chat surface id to "Chat"', () => {
      expect(CHAT_SURFACE_ID).toBe('chat');
      expect(labelForSurface(CHAT_SURFACE_ID)).toBe('Chat');
    });

    it('strips a leading "sprinkle:" prefix', () => {
      expect(labelForSurface('sprinkle:foo')).toBe('foo');
    });

    it('leaves a plain surfaceId (no prefix, not chat) unchanged', () => {
      expect(labelForSurface('middle')).toBe('middle');
    });

    it("the rendered tile's move button uses the friendly label for a 'chat' leaf", () => {
      const el = mountWithTileDrag();
      el.appendChild(surface(CHAT_SURFACE_ID));
      el.setTree({ ...EMPTY_SPEC, zones: { ...EMPTY_SPEC.zones, middle: leaf(CHAT_SURFACE_ID) } });

      const button = (
        el.querySelector(`slicc-surface[surface-id="${CHAT_SURFACE_ID}"]`) as HTMLElement
      )
        .closest('.dock-tree__tile')!
        .querySelector('.dock-tree__tile-move') as HTMLElement;
      expect(button.title).toBe('Chat');
      expect(button.getAttribute('aria-label')).toBe('Move Chat');
    });

    it("the rendered tile's move button uses the friendly label for a 'sprinkle:foo' leaf", () => {
      const el = mountWithTileDrag();
      el.appendChild(surface('sprinkle:foo'));
      el.setTree({ ...EMPTY_SPEC, zones: { ...EMPTY_SPEC.zones, middle: leaf('sprinkle:foo') } });

      const button = (el.querySelector('slicc-surface[surface-id="sprinkle:foo"]') as HTMLElement)
        .closest('.dock-tree__tile')!
        .querySelector('.dock-tree__tile-move') as HTMLElement;
      expect(button.title).toBe('foo');
      expect(button.getAttribute('aria-label')).toBe('Move foo');
    });
  });

  describe('setPinned (non-closable leaves)', () => {
    it('removeSurface on a pinned surfaceId is a no-op (chat can never be orphaned)', () => {
      const el = mount();
      el.setTree({ ...EMPTY_SPEC, zones: { ...EMPTY_SPEC.zones, middle: leaf(CHAT_SURFACE_ID) } });
      el.setPinned([CHAT_SURFACE_ID]);
      const events: CustomEvent[] = [];
      el.addEventListener('dock-tree-change', (e) => events.push(e as CustomEvent));

      el.removeSurface(CHAT_SURFACE_ID);

      expect(el.getTree().zones.middle).toEqual(leaf(CHAT_SURFACE_ID));
      expect(events).toHaveLength(0);
    });

    it('a non-pinned surfaceId still removes normally once other ids are pinned', () => {
      const el = mount();
      el.setTree({
        ...EMPTY_SPEC,
        zones: { ...EMPTY_SPEC.zones, left: leaf(CHAT_SURFACE_ID), middle: leaf('other') },
      });
      el.setPinned([CHAT_SURFACE_ID]);

      el.removeSurface('other');

      expect(el.getTree().zones.middle).toBeNull();
      expect(el.getTree().zones.left).toEqual(leaf(CHAT_SURFACE_ID));
    });

    it('a pinned leaf can still be drag-moved between zones', () => {
      const el = mountWithTileDrag();
      for (const id of ['top', 'left', 'middle', 'right', 'bottom']) el.appendChild(surface(id));
      el.setTree(standardSpec());
      el.setPinned(['left']);

      const firePointer = (
        target: EventTarget,
        type: string,
        opts: { clientX?: number; clientY?: number; pointerId?: number } = {}
      ): void => {
        const { clientX = 0, clientY = 0, pointerId = 1 } = opts;
        target.dispatchEvent(
          new PointerEvent(type, {
            clientX,
            clientY,
            pointerId,
            button: 0,
            bubbles: true,
            cancelable: true,
          })
        );
      };
      const button = (el.querySelector('slicc-surface[surface-id="left"]') as HTMLElement)
        .closest('.dock-tree__tile')!
        .querySelector('.dock-tree__tile-move') as HTMLElement;
      const buttonRect = button.getBoundingClientRect();
      firePointer(button, 'pointerdown', {
        clientX: buttonRect.left + buttonRect.width / 2,
        clientY: buttonRect.top + buttonRect.height / 2,
      });

      const targetRect = (el.querySelector('slicc-surface[surface-id="middle"]') as HTMLElement)
        .closest('.dock-tree__tile')!
        .getBoundingClientRect();
      const dropX = targetRect.left + targetRect.width * 0.95;
      const dropY = targetRect.top + targetRect.height * 0.5;
      firePointer(window, 'pointermove', { clientX: dropX, clientY: dropY });
      firePointer(window, 'pointerup', { clientX: dropX, clientY: dropY });

      const tree = el.getTree();
      expect(tree.zones.left).toBeNull();
      const middleNode = tree.zones.middle as Extract<DockNode, { type: 'split' }>;
      expect(middleNode.type).toBe('split');
      expect(middleNode.children).toEqual([leaf('middle'), leaf('left')]);
    });
  });

  describe('serialization contract (getTree/setTree round-trip)', () => {
    it('round-trips getTree() through JSON.parse(JSON.stringify(...)) into setTree', () => {
      const el = mount();
      const spec: DockTreeSpec = {
        zones: {
          top: leaf('top'),
          left: split('col', [leaf('l1'), leaf('l2')]),
          middle: split('row', [leaf('m1'), split('col', [leaf('m2a'), leaf('m2b')])]),
          right: null,
          bottom: leaf('bottom'),
        },
        rowFr: { top: 0.6, center: 2.4, bottom: 0.9 },
        colFr: { left: 1.1, middle: 2.2, right: 0.7 },
      };
      el.setTree(spec);

      const serialized = JSON.parse(JSON.stringify(el.getTree())) as DockTreeSpec;
      expect(serialized).toEqual(spec); // JSON round-trip is lossless for this plain-data shape

      const el2 = mount();
      el2.setTree(serialized);
      expect(el2.getTree()).toEqual(el.getTree());
      expect(el2.getSurfaceIds()).toEqual(el.getSurfaceIds());
    });
  });

  describe('locking', () => {
    /** Dispatch a `PointerEvent` with the given coords/id, bubbling (so window-level listeners fire). */
    function firePointer(
      target: EventTarget,
      type: string,
      opts: { clientX?: number; clientY?: number; pointerId?: number } = {}
    ): void {
      const { clientX = 0, clientY = 0, pointerId = 1 } = opts;
      target.dispatchEvent(
        new PointerEvent(type, {
          clientX,
          clientY,
          pointerId,
          button: 0,
          bubbles: true,
          cancelable: true,
        })
      );
    }

    /** Move to, then drop at, a point (fires `pointermove` then `pointerup` on `window`). */
    function moveAndDrop(x: number, y: number): void {
      firePointer(window, 'pointermove', { clientX: x, clientY: y });
      firePointer(window, 'pointerup', { clientX: x, clientY: y });
    }

    it('a locked leaf renders no move button', () => {
      const el = mountWithTileDrag();
      el.appendChild(surface('middle'));
      el.setTree({
        ...EMPTY_SPEC,
        zones: { ...EMPTY_SPEC.zones, middle: { type: 'leaf', surfaceId: 'middle', locked: true } },
      });
      const tile = (el.querySelector('slicc-surface[surface-id="middle"]') as HTMLElement).closest(
        '.dock-tree__tile'
      ) as HTMLElement;
      expect(tile.querySelector('.dock-tree__tile-move')).toBeNull();
    });

    it('an unlocked leaf still renders its move button', () => {
      const el = mountWithTileDrag();
      el.appendChild(surface('middle'));
      el.setTree({ ...EMPTY_SPEC, zones: { ...EMPTY_SPEC.zones, middle: leaf('middle') } });
      const tile = (el.querySelector('slicc-surface[surface-id="middle"]') as HTMLElement).closest(
        '.dock-tree__tile'
      ) as HTMLElement;
      expect(tile.querySelector('.dock-tree__tile-move')).not.toBeNull();
    });

    it('tree-level locked: true locks every leaf, in every zone, with no per-leaf flag set', () => {
      const el = mountWithTileDrag();
      for (const id of ['top', 'left', 'middle', 'right', 'bottom']) el.appendChild(surface(id));
      el.setTree({ ...standardSpec(), locked: true });
      for (const id of ['top', 'left', 'middle', 'right', 'bottom']) {
        const tile = (el.querySelector(`slicc-surface[surface-id="${id}"]`) as HTMLElement).closest(
          '.dock-tree__tile'
        ) as HTMLElement;
        expect(tile.querySelector('.dock-tree__tile-move')).toBeNull();
      }
    });

    it('locking a split locks every descendant leaf, but not an unrelated sibling zone', () => {
      const el = mountWithTileDrag();
      el.appendChild(surface('a'));
      el.appendChild(surface('b'));
      el.appendChild(surface('c'));
      el.setTree({
        ...EMPTY_SPEC,
        zones: {
          ...EMPTY_SPEC.zones,
          middle: { ...split('row', [leaf('a'), leaf('b')]), locked: true },
          right: leaf('c'),
        },
      });
      const tileA = (el.querySelector('slicc-surface[surface-id="a"]') as HTMLElement).closest(
        '.dock-tree__tile'
      ) as HTMLElement;
      const tileB = (el.querySelector('slicc-surface[surface-id="b"]') as HTMLElement).closest(
        '.dock-tree__tile'
      ) as HTMLElement;
      const tileC = (el.querySelector('slicc-surface[surface-id="c"]') as HTMLElement).closest(
        '.dock-tree__tile'
      ) as HTMLElement;
      expect(tileA.querySelector('.dock-tree__tile-move')).toBeNull();
      expect(tileB.querySelector('.dock-tree__tile-move')).toBeNull();
      expect(tileC.querySelector('.dock-tree__tile-move')).not.toBeNull();
    });

    it('a locked leaf cannot be dragged: no dock-tree-change fires, and the tree is unchanged', () => {
      const el = mountWithTileDrag();
      for (const id of ['top', 'left', 'middle', 'right', 'bottom']) el.appendChild(surface(id));
      const spec = standardSpec();
      spec.zones.left = { type: 'leaf', surfaceId: 'left', locked: true };
      el.setTree(spec);
      const before = el.getTree();

      const events: CustomEvent[] = [];
      el.addEventListener('dock-tree-change', (e) => events.push(e as CustomEvent));

      // No move button to grab — simulate a caller bypassing that (e.g. a
      // stale reference) by calling the drag entry point directly via a
      // pointerdown on the tile body, which has no drag listener at all.
      const tileBody = (
        el.querySelector('slicc-surface[surface-id="left"]') as HTMLElement
      ).closest('.dock-tree__tile-body') as HTMLElement;
      const rect = tileBody.getBoundingClientRect();
      firePointer(tileBody, 'pointerdown', {
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
      });
      moveAndDrop(rect.left + 200, rect.top);

      expect(el.getTree()).toEqual(before);
      expect(events).toHaveLength(0);
    });

    it('removeSurface no-ops on a locked leaf (mirrors the pinned guard)', () => {
      const el = mount();
      el.setTree({
        ...EMPTY_SPEC,
        zones: { ...EMPTY_SPEC.zones, middle: { type: 'leaf', surfaceId: 'middle', locked: true } },
      });
      const events: CustomEvent[] = [];
      el.addEventListener('dock-tree-change', (e) => events.push(e as CustomEvent));

      el.removeSurface('middle');

      expect(el.getTree().zones.middle).toEqual({
        type: 'leaf',
        surfaceId: 'middle',
        locked: true,
      });
      expect(events).toHaveLength(0);
    });

    it('a skeleton divider adjacent to a locked zone does not render', () => {
      const el = mount();
      el.appendChild(surface('t'));
      el.appendChild(surface('b'));
      el.setTree({
        ...EMPTY_SPEC,
        zones: {
          ...EMPTY_SPEC.zones,
          top: { type: 'leaf', surfaceId: 't', locked: true },
          bottom: leaf('b'),
        },
      });
      expect(el.querySelectorAll('.dock-tree__divider')).toHaveLength(0);
    });

    it('an in-zone divider inside a locked split does not render', () => {
      const el = mount();
      el.appendChild(surface('x'));
      el.appendChild(surface('y'));
      el.setTree({
        ...EMPTY_SPEC,
        zones: {
          ...EMPTY_SPEC.zones,
          middle: { ...split('row', [leaf('x'), leaf('y')]), locked: true },
        },
      });
      expect(
        el.querySelectorAll('.dock-tree__zone[data-zone="middle"] .dock-tree__divider')
      ).toHaveLength(0);
    });

    it('dividers still render normally between two unlocked blocks', () => {
      const el = mount();
      el.appendChild(surface('t'));
      el.appendChild(surface('b'));
      el.setTree({
        ...EMPTY_SPEC,
        zones: { ...EMPTY_SPEC.zones, top: leaf('t'), bottom: leaf('b') },
      });
      expect(el.querySelectorAll('.dock-tree__divider')).toHaveLength(1);
    });

    it('a locked leaf rejects being a drop target: an external drag dropped on its edge cancels cleanly', () => {
      const el = mountWithTileDrag();
      el.appendChild(surface('locked-one'));
      el.setTree({
        ...EMPTY_SPEC,
        zones: {
          ...EMPTY_SPEC.zones,
          middle: { type: 'leaf', surfaceId: 'locked-one', locked: true },
        },
      });
      el.appendChild(surface('sprinkle:rail'));
      const before = el.getTree();
      const events: CustomEvent[] = [];
      el.addEventListener('dock-tree-change', (e) => events.push(e as CustomEvent));

      el.beginExternalDrag('sprinkle:rail');
      const targetRect = (el.querySelector('slicc-surface[surface-id="locked-one"]') as HTMLElement)
        .closest('.dock-tree__tile')!
        .getBoundingClientRect();
      // East edge of the locked tile — would normally split it.
      moveAndDrop(
        targetRect.left + targetRect.width * 0.95,
        targetRect.top + targetRect.height * 0.5
      );

      // Rejected as a tile target: the move lands as "hovering nothing valid"
      // (no zoneEl branch never applies here since it's still inside the
      // `middle` zone) — resolves to no dropTarget at all, so the drop
      // cancels with no mutation.
      expect(el.getTree()).toEqual(before);
      expect(events).toHaveLength(0);
    });

    it('resize still works end-to-end when nothing in the tree is locked (regression guard)', () => {
      const el = mount();
      el.appendChild(surface('t'));
      el.appendChild(surface('b'));
      el.setTree({
        ...EMPTY_SPEC,
        zones: { ...EMPTY_SPEC.zones, top: leaf('t'), bottom: leaf('b') },
      });
      const divider = el.querySelector('.dock-tree__divider--v') as HTMLElement;
      expect(divider).not.toBeNull();
      const rect = divider.getBoundingClientRect();
      const startY = rect.top + rect.height / 2;

      const events: CustomEvent[] = [];
      el.addEventListener('dock-tree-resize', (e) => events.push(e as CustomEvent));

      firePointer(divider, 'pointerdown', { clientX: rect.left, clientY: startY });
      firePointer(window, 'pointermove', { clientX: rect.left, clientY: startY + 40 });
      firePointer(window, 'pointerup', { clientX: rect.left, clientY: startY + 40 });

      expect(events).toHaveLength(1);
      expect(el.getTree().rowFr.top).toBeGreaterThan(1);
    });
  });

  describe('setSurfaceSize (programmatic px/percent resize)', () => {
    it("percent-resizes a row-split child, holding its sibling's own weight fixed", () => {
      const el = mount();
      el.appendChild(surface('a'));
      el.appendChild(surface('b'));
      el.setTree({
        ...EMPTY_SPEC,
        zones: { ...EMPTY_SPEC.zones, middle: split('row', [leaf('a'), leaf('b')]) },
      });
      expect(el.setSurfaceSize('a', { widthPercent: 80 })).toBe(true);
      const node = el.getTree().zones.middle as Extract<DockNode, { type: 'split' }>;
      // a:b should now be 4:1 (80%:20%) — b's own weight (the sibling) is untouched.
      expect(node.sizes[1]).toBe(1);
      expect(node.sizes[0]).toBeCloseTo(4 * node.sizes[1], 5);
    });

    it('percent-resizes a col-split child on the height axis; the (lever-less) width request is a no-op', () => {
      const el = mount();
      el.appendChild(surface('a'));
      el.appendChild(surface('b'));
      el.setTree({
        ...EMPTY_SPEC,
        zones: { ...EMPTY_SPEC.zones, middle: split('col', [leaf('a'), leaf('b')]) },
      });
      expect(el.setSurfaceSize('a', { heightPercent: 25 })).toBe(true);
      const node = el.getTree().zones.middle as Extract<DockNode, { type: 'split' }>;
      expect(node.sizes[1]).toBeCloseTo(3 * node.sizes[0], 5); // a=25% => b=75% => b=3a
    });

    it("percent-resizes a center zone-root leaf's width via colFr", () => {
      const el = mount();
      for (const id of ['left', 'middle', 'right']) el.appendChild(surface(id));
      el.setTree(standardSpec());
      expect(el.setSurfaceSize('middle', { widthPercent: 50 })).toBe(true);
      const { colFr } = el.getTree();
      expect(colFr.middle).toBeCloseTo(colFr.left + colFr.right, 5); // 50% => middle == left+right
    });

    it("a center zone-root leaf's heightPercent maps to rowFr.center (the lever shared by the whole row)", () => {
      const el = mount();
      for (const id of ['top', 'left', 'middle', 'right', 'bottom']) el.appendChild(surface(id));
      el.setTree(standardSpec());
      expect(el.setSurfaceSize('middle', { heightPercent: 60 })).toBe(true);
      const { rowFr } = el.getTree();
      expect(rowFr.center).toBeCloseTo(1.5 * (rowFr.top + rowFr.bottom), 5); // 60% => 0.6/0.4 = 1.5x
    });

    it('a top/bottom zone-root leaf sizes only by height — widthPercent is a no-op (no lever)', () => {
      const el = mount();
      el.appendChild(surface('top'));
      el.appendChild(surface('bottom'));
      el.setTree({
        ...EMPTY_SPEC,
        zones: { ...EMPTY_SPEC.zones, top: leaf('top'), bottom: leaf('bottom') },
      });
      expect(el.setSurfaceSize('top', { widthPercent: 40 })).toBe(false);
      expect(el.getTree().colFr).toEqual(EMPTY_SPEC.colFr);

      expect(el.setSurfaceSize('top', { heightPercent: 75 })).toBe(true);
      const { rowFr } = el.getTree();
      expect(rowFr.top).toBeCloseTo(3 * rowFr.bottom, 5);
    });

    it('a lone shown block has nothing to size against — no-op', () => {
      const el = mount();
      el.appendChild(surface('top'));
      el.setTree({ ...EMPTY_SPEC, zones: { ...EMPTY_SPEC.zones, top: leaf('top') } });
      expect(el.setSurfaceSize('top', { heightPercent: 50 })).toBe(false);
    });

    it('a locked leaf refuses resizing, leaving the tree unchanged', () => {
      const el = mount();
      el.appendChild(surface('a'));
      el.appendChild(surface('b'));
      el.setTree({
        ...EMPTY_SPEC,
        zones: {
          ...EMPTY_SPEC.zones,
          middle: { ...split('row', [leaf('a'), leaf('b')]), locked: true },
        },
      });
      const before = el.getTree();
      expect(el.setSurfaceSize('a', { widthPercent: 90 })).toBe(false);
      expect(el.getTree()).toEqual(before);
    });

    it('an unplaced surfaceId is a no-op', () => {
      const el = mount();
      el.setTree(EMPTY_SPEC);
      expect(el.setSurfaceSize('nowhere', { widthPercent: 50 })).toBe(false);
    });

    it('fires dock-tree-resize (with the current tree) only when something actually changed', () => {
      const el = mount();
      el.appendChild(surface('a'));
      el.appendChild(surface('b'));
      el.setTree({
        ...EMPTY_SPEC,
        zones: { ...EMPTY_SPEC.zones, middle: split('row', [leaf('a'), leaf('b')]) },
      });
      const events: CustomEvent[] = [];
      el.addEventListener('dock-tree-resize', (e) => events.push(e as CustomEvent));

      el.setSurfaceSize('nowhere', { widthPercent: 50 });
      expect(events).toHaveLength(0);

      el.setSurfaceSize('a', { widthPercent: 70 });
      expect(events).toHaveLength(1);
      expect(events[0].detail.tree).toEqual(el.getTree());
    });

    it('a pixel target converges the VISIBLE surface to (approximately) that many rendered pixels', () => {
      // Both leaves are non-chat, so both tiles carry the 12px-margin chrome:
      // the calibration must measure the leaf (the actual flex item) and fold
      // the chrome inset into the target, or the surface lands ~26px short
      // (the P2 caught on #2023).
      const el = mount(); // 600x400 host
      el.appendChild(surface('a'));
      el.appendChild(surface('b'));
      el.setTree({
        ...EMPTY_SPEC,
        zones: { ...EMPTY_SPEC.zones, middle: split('row', [leaf('a'), leaf('b')]) },
      });
      el.setSurfaceSize('a', { widthPx: 200 });
      const width = (
        el.querySelector('slicc-surface[surface-id="a"]') as HTMLElement
      ).getBoundingClientRect().width;
      expect(width).toBeGreaterThan(194);
      expect(width).toBeLessThan(206);
    });
  });

  describe('tile chrome', () => {
    it('frames every non-chat tile with the rounded pane chrome and keeps chat flat', () => {
      const el = mount();
      el.append(surface(CHAT_SURFACE_ID), surface('term'));
      el.setTree({
        ...EMPTY_SPEC,
        zones: { ...EMPTY_SPEC.zones, left: leaf(CHAT_SURFACE_ID), right: leaf('term') },
      });
      const chatTile = el
        .querySelector(`slicc-surface[surface-id="${CHAT_SURFACE_ID}"]`)
        ?.closest('.dock-tree__tile') as HTMLElement;
      const termTile = el
        .querySelector('slicc-surface[surface-id="term"]')
        ?.closest('.dock-tree__tile') as HTMLElement;
      expect(chatTile.classList.contains('dock-tree__tile--chrome')).toBe(false);
      expect(termTile.classList.contains('dock-tree__tile--chrome')).toBe(true);
      // The chrome is the old floating workbench-pane card (the deleted
      // `<slicc-workbench-pane>` → `<slicc-pane elevated>` chain): rounded,
      // bordered, clipped to the radius, floated off the edges.
      const cs = getComputedStyle(termTile);
      expect(cs.borderTopLeftRadius).toBe('14px');
      expect(cs.overflow).toBe('hidden');
      expect(cs.borderTopWidth).toBe('1px');
      expect(cs.marginLeft).toBe('12px');
      // The chat column keeps the prototype's flat full-bleed treatment.
      const chatCs = getComputedStyle(chatTile);
      expect(chatCs.borderTopLeftRadius).toBe('0px');
      expect(chatCs.marginLeft).toBe('0px');
    });
  });

  describe('tile entrance animation', () => {
    it('slides in only the tiles a render NEWLY placed — carry-over renders never replay it', () => {
      const el = mount();
      el.append(surface(CHAT_SURFACE_ID), surface('term'));
      const chatOnly: DockTreeSpec = {
        ...EMPTY_SPEC,
        zones: { ...EMPTY_SPEC.zones, left: leaf(CHAT_SURFACE_ID) },
      };
      el.setTree(chatOnly);
      el.setTree({
        ...EMPTY_SPEC,
        zones: { ...EMPTY_SPEC.zones, left: leaf(CHAT_SURFACE_ID), right: leaf('term') },
      });
      const termTile = () =>
        el.querySelector('slicc-surface[surface-id="term"]')?.closest('.dock-tree__tile');
      const chatTile = el
        .querySelector(`slicc-surface[surface-id="${CHAT_SURFACE_ID}"]`)
        ?.closest('.dock-tree__tile');
      // The newly placed tool tile enters; the carried-over chat leaf (flat,
      // never animated) does not.
      expect(termTile()?.classList.contains('dock-tree__tile--enter')).toBe(true);
      expect(chatTile?.classList.contains('dock-tree__tile--enter')).toBe(false);
      // A re-render with an unchanged placed set (what every divider-drag
      // pointermove produces) must NOT restart the slide-in.
      el.setSurfaceSize('term', { widthPercent: 40 });
      expect(termTile()?.classList.contains('dock-tree__tile--enter')).toBe(false);
    });
  });

  describe('dock-tree-render notification', () => {
    it('announces the placed surfaceIds after every render — the silent setTree restore included', () => {
      const el = mount();
      el.append(surface(CHAT_SURFACE_ID), surface('term'));
      const placed: string[][] = [];
      const changes: unknown[] = [];
      el.addEventListener('dock-tree-render', (e) =>
        placed.push([...(e as CustomEvent<{ placed: string[] }>).detail.placed])
      );
      el.addEventListener('dock-tree-change', (e) => changes.push(e));
      el.setTree({
        ...EMPTY_SPEC,
        zones: { ...EMPTY_SPEC.zones, left: leaf(CHAT_SURFACE_ID), right: leaf('term') },
      });
      expect(placed.at(-1)?.sort()).toEqual([CHAT_SURFACE_ID, 'term']);
      // `setTree` deliberately fires no `dock-tree-change` (persistence must
      // not loop on restore) — the render notification is the display-only
      // channel that still fires, so `<slicc-shell>` can sync chatpane state.
      expect(changes).toHaveLength(0);
      el.removeSurface('term');
      expect(placed.at(-1)).toEqual([CHAT_SURFACE_ID]);
    });
  });
});
