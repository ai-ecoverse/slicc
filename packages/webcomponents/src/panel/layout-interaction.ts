/**
 * The DOM half of user rearrangement: the hover-reveal move button, the five zone
 * drop targets, and the divider drags that resize.
 *
 * Split out of `slicc-layout.ts` because the component was already at its size
 * budget and because the two concerns are genuinely separate — the component owns
 * *arrangement from a document*, this owns *the gesture that edits one*. It talks
 * to the component through {@link LayoutInteractionHost}, so the interaction can be
 * tested against a stub and the component doesn't grow a second personality.
 *
 * ## Five destinations, not a tree
 *
 * Grabbing a panel offers exactly five places to put it — `top`, `left`, `center`,
 * `right`, `bottom` — in the sense Java's `BorderLayout` uses them. The predecessor
 * offered five positions RELATIVE TO EACH PANEL, so the number of choices grew with
 * everything on screen and no two drags meant the same thing. Five named zones is
 * the whole vocabulary, however much is open.
 *
 * A zone still holds any number of panels, laid out along its axis, so "two panels
 * on the left, side by side or stacked" is expressible — the simplicity is in the
 * destinations, not the capacity.
 */

import { iconEl } from '../internal/icons.js';
import { type SplitDirection, ZONE_NAMES, type ZoneName } from './layout-schema.js';
import type { PanelSize } from './panel-meta.js';

/** Minimum share of a dragged PAIR either side may be squeezed to. */
const MIN_FRACTION = 0.02;

/**
 * Floor for a zone's thickness, in px. Absolute rather than fractional because a
 * zone's size is absolute: 2% of a wide viewport is a usable panel, 2% of a narrow
 * one is a sliver, and either way a zone below this is unusable rather than small.
 */
const MIN_ZONE_PX = 48;

/** What the interaction needs from the component hosting it. */
export interface LayoutInteractionHost extends HTMLElement {
  /** Whether the user may rearrange this panel at all. */
  isLocked(panelId: string): boolean;
  /** Commit a move: `panelId` goes to `zone`. */
  applyMove(panelId: string, zone: ZoneName): void;
  /** Write panel weights within one zone. Does not render or announce. */
  applyResize(zone: ZoneName, weights: number[]): void;
  /** Write a zone's thickness against its neighbours. */
  applyZoneResize(zone: ZoneName, size: PanelSize): void;
  /** Re-render mid-gesture without announcing — called once per resize frame. */
  rerender(): void;
  /** End of a resize drag: announce the final geometry once. */
  commitResize(): void;
}

/** A drag in progress. */
interface DragState {
  panelId: string;
  zone: ZoneName | null;
}

/** Human name per zone, for tooltips and the drop-target labels. */
const ZONE_LABEL: Record<ZoneName, string> = {
  top: 'Top',
  left: 'Left',
  center: 'Center',
  right: 'Right',
  bottom: 'Bottom',
};

/**
 * Owns every pointer gesture for one `<slicc-layout>`.
 *
 * Overlays (ghost, targets) are `position: fixed` children of the host rather than
 * of a slot: a slot is destroyed and rebuilt by every re-render during a drag, and
 * an overlay inside one would vanish mid-gesture.
 */
export class LayoutInteraction {
  readonly #host: LayoutInteractionHost;
  readonly #ghost: HTMLElement;

  /**
   * The five zone drop targets, shown as a compass over the working area while
   * dragging. Without them the destinations were invisible — you grabbed a panel and
   * had to guess where releasing would put it.
   */
  readonly #targets: HTMLElement;
  #drag: DragState | null = null;

  constructor(host: LayoutInteractionHost) {
    this.#host = host;
    this.#ghost = div('slicc-layout__ghost');
    this.#targets = div('slicc-layout__targets');
  }

  /** The overlay elements, for the host to keep as its own stable children. */
  overlays(): HTMLElement[] {
    return [this.#targets, this.#ghost];
  }

  /** Abandon any in-progress gesture (host disconnect) without committing it. */
  cancel(): void {
    window.removeEventListener('pointermove', this.#onDragMove);
    window.removeEventListener('pointerup', this.#onDragUp);
    this.#drag = null;
    this.#ghost.classList.remove('slicc-layout__ghost--active');
    this.#targets.replaceChildren();
    this.#targets.classList.remove('slicc-layout__targets--active');
  }

  /**
   * Add the corner grip to a slot, unless the panel is locked.
   *
   * A locked panel gets NO button rather than a disabled one — "cannot move" read
   * literally. Docked panels never get one: the rails and the top strip are fixed
   * chrome with one correct position (see `docs/layouts.md`).
   */
  decorateSlot(slot: HTMLElement, panelId: string): void {
    if (this.#host.isLocked(panelId)) return;
    const grip = document.createElement('button');
    grip.type = 'button';
    grip.className = 'slicc-layout__move';
    grip.title = `Move ${panelId}`;
    grip.setAttribute('aria-label', `Move ${panelId}`);
    grip.dataset.panelId = panelId;
    grip.appendChild(iconEl('grip-vertical', { size: 13 }));
    grip.addEventListener('pointerdown', (e) => this.#startDrag(e as PointerEvent, panelId));
    slot.appendChild(grip);
  }

  /**
   * A divider between two adjacent panels INSIDE one zone — what makes "two panels
   * on the left" resizable against each other. `null` when the zone is locked.
   */
  buildZonePanelDivider(
    zone: ZoneName,
    axis: SplitDirection,
    container: HTMLElement,
    locked: boolean
  ): HTMLElement | null {
    if (locked) return null;
    const horiz = axis === 'row';
    const divider = div(`slicc-layout__divider slicc-layout__divider--${horiz ? 'h' : 'v'}`);
    divider.dataset.zone = zone;
    divider.addEventListener('pointerdown', (e: PointerEvent) => {
      this.#startPanelResize(e, zone, horiz, container);
    });
    return divider;
  }

  /**
   * A divider between two adjacent ZONES — what resizes a zone's thickness against
   * its neighbour, as opposed to resizing panels inside one. `null` when either
   * neighbour is locked, since the drag moves space between the two of them.
   *
   * `before`/`after` are the zones on each side. Only one of them ends up written:
   * `center` is the remainder by definition, so a drag against it sets the EDGE
   * zone's thickness and lets the center absorb the difference. When neither side is
   * the center (never in the shipped runs, but expressible), the leading zone is the
   * one sized.
   */
  buildZoneDivider(
    before: ZoneName,
    after: ZoneName,
    horiz: boolean,
    container: HTMLElement,
    locked: boolean
  ): HTMLElement | null {
    if (locked) return null;
    const divider = div(
      `slicc-layout__divider slicc-layout__divider--zone slicc-layout__divider--${horiz ? 'h' : 'v'}`
    );
    divider.dataset.zoneBefore = before;
    divider.dataset.zoneAfter = after;
    divider.addEventListener('pointerdown', (e: PointerEvent) => {
      this.#startZoneResize(e, before, after, horiz, container);
    });
    return divider;
  }

  /**
   * Drag a seam between two zones: convert pointer movement into an absolute px
   * thickness for whichever side is sizable, clamped to a minimum on both so neither
   * zone can be dragged out of existence.
   *
   * Writes PIXELS rather than a weight, because that is what a zone thickness is in
   * this model — `zones.sizes` feeds `sizeToFlex`, where a `px` value becomes a fixed
   * basis that neither grows nor shrinks. Weights would make an edge zone rubber-band
   * as the window resized, which is the opposite of what a rail-like band wants.
   */
  #startZoneResize(
    e: PointerEvent,
    before: ZoneName,
    after: ZoneName,
    horiz: boolean,
    container: HTMLElement
  ): void {
    e.preventDefault();
    // The sized zone is the non-center one; dragging its seam grows or shrinks it and
    // the center absorbs the rest.
    const sized = before === 'center' ? after : before;
    // Which direction of pointer travel makes `sized` bigger: a leading zone grows
    // as the seam moves away from the origin, a trailing one grows as it comes back.
    const sign = sized === before ? 1 : -1;
    const target = container.querySelector(`:scope > [data-zone="${sized}"]`);
    if (!(target instanceof HTMLElement)) return;

    this.#host.setPointerCapture(e.pointerId);
    const rect = target.getBoundingClientRect();
    const startSize = horiz ? rect.width : rect.height;
    const start = horiz ? e.clientX : e.clientY;
    const containerRect = container.getBoundingClientRect();
    const available = horiz ? containerRect.width : containerRect.height;
    // Reserve room for EVERY other element in this run, not just the immediate
    // neighbour: with three zones across, accounting for one let a hard drag crush
    // the center to 0px, because the opposite zone's width and the two 6px seams
    // went unreserved.
    //
    // A FIXED zone (an edge zone with a px thickness) reserves its actual size,
    // since it will not shrink to make room; the flexible one — the center, or the
    // middle row in the vertical run — reserves only the floor, because absorbing
    // the difference is its job.
    let reserved = 0;
    for (const sibling of Array.from(container.children)) {
      if (!(sibling instanceof HTMLElement) || sibling === target) continue;
      const rect = sibling.getBoundingClientRect();
      const extent = horiz ? rect.width : rect.height;
      const flexible =
        sibling.dataset.zone === 'center' || sibling.classList.contains('slicc-layout__work-row');
      reserved += flexible ? MIN_ZONE_PX : extent;
    }
    const max = Math.max(MIN_ZONE_PX, available - reserved);
    let live = startSize;

    const move = (ev: PointerEvent): void => {
      const pos = horiz ? ev.clientX : ev.clientY;
      live = Math.max(MIN_ZONE_PX, Math.min(max, startSize + (pos - start) * sign));
      this.#host.applyZoneResize(sized, `${Math.round(live)}px`);
      this.#host.rerender();
    };
    const end = (): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      if (this.#host.hasPointerCapture(e.pointerId)) {
        this.#host.releasePointerCapture(e.pointerId);
      }
      this.#host.applyZoneResize(sized, `${Math.round(live)}px`);
      this.#host.commitResize();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  }

  #startDrag(e: PointerEvent, panelId: string): void {
    if (this.#host.isLocked(panelId)) return;
    e.preventDefault();
    this.#drag = { panelId, zone: null };
    this.#ghost.textContent = panelId;
    this.#ghost.classList.add('slicc-layout__ghost--active');
    this.#moveGhost(e);
    // Show the five destinations immediately: the point of grabbing is to see
    // where the panel can go, not to hunt for it.
    this.#showTargets();
    window.addEventListener('pointermove', this.#onDragMove);
    window.addEventListener('pointerup', this.#onDragUp);
  }

  /**
   * Paint the five zone targets as a compass over the working area.
   *
   * Positioned from the WORKING AREA's box, not the layout's, so the targets sit
   * inside the fixed chrome — `top` below the scoop strip, `left`/`right` inboard of
   * the rails. That is the same region the zones themselves occupy, so where a
   * badge appears is where the panel lands.
   */
  #showTargets(): void {
    const work = this.#host.querySelector('.slicc-layout__work');
    if (!(work instanceof HTMLElement)) return;
    const rect = work.getBoundingClientRect();
    for (const zone of ZONE_NAMES) {
      this.#targets.appendChild(buildTarget(zone, rect));
    }
    this.#targets.classList.add('slicc-layout__targets--active');
  }

  /** Mark the target under the cursor, clearing the others. */
  #highlightTarget(active: HTMLElement | null): void {
    for (const node of Array.from(this.#targets.children)) {
      node.classList.toggle('slicc-layout__target--hot', node === active);
    }
  }

  #moveGhost(e: PointerEvent): void {
    this.#ghost.style.left = `${e.clientX}px`;
    this.#ghost.style.top = `${e.clientY}px`;
  }

  /**
   * Resolve which zone target is under the cursor.
   *
   * Hit-tests the VISIBLE badges, so what commits is exactly what the user aimed at.
   * `elementFromPoint` rather than `pointerover`: the ghost sits under the cursor
   * itself, and is `pointer-events: none` so it doesn't shadow what's beneath.
   */
  #onDragMove = (e: PointerEvent): void => {
    const drag = this.#drag;
    if (!drag) return;
    this.#moveGhost(e);
    drag.zone = null;

    const el = document.elementFromPoint(e.clientX, e.clientY);
    const badge = el?.closest('.slicc-layout__target');
    if (badge instanceof HTMLElement) {
      const zone = badge.dataset.zone as ZoneName | undefined;
      if (zone) {
        drag.zone = zone;
        this.#highlightTarget(badge);
        return;
      }
    }
    // Falling back to the zone under the cursor keeps a coarse drop working — you
    // can drop onto a zone's area without hitting its badge exactly.
    const zoneEl = el?.closest('.slicc-layout__zone');
    const zone = zoneEl instanceof HTMLElement ? (zoneEl.dataset.zone as ZoneName) : null;
    drag.zone = zone;
    this.#highlightTarget(zone ? this.#badgeFor(zone) : null);
  };

  #badgeFor(zone: ZoneName): HTMLElement | null {
    return this.#targets.querySelector(`.slicc-layout__target[data-zone="${zone}"]`);
  }

  #onDragUp = (): void => {
    const drag = this.#drag;
    this.cancel();
    if (!drag?.zone) return;
    this.#host.applyMove(drag.panelId, drag.zone);
  };

  /**
   * Drag a divider between two panels in one zone: convert pixel movement into
   * weight moved between the two adjacent slots, clamped so neither drops below
   * `MIN_FRACTION` of the pair's own total.
   *
   * Pointer capture goes on the HOST, not the divider: each frame re-renders and
   * rebuilds this very divider, and a captured element removed from the DOM loses
   * capture per spec — the bug that once left resize stuck to the mouse after
   * release, because `pointerup` was never delivered to a torn-down element.
   */
  #startPanelResize(e: PointerEvent, zone: ZoneName, horiz: boolean, container: HTMLElement): void {
    e.preventDefault();
    const divider = e.currentTarget as HTMLElement;
    const slots = Array.from(container.querySelectorAll(':scope > .slicc-layout__slot'));
    // The divider sits between slot `index - 1` and `index`, counted by how many
    // slots precede it in the DOM.
    const index = Array.from(container.children)
      .slice(0, Array.from(container.children).indexOf(divider))
      .filter((node) => node.classList.contains('slicc-layout__slot')).length;
    if (index < 1 || index >= slots.length) return;

    this.#host.setPointerCapture(e.pointerId);
    // Weights start from measured geometry, so an unsized zone becomes resizable on
    // the first drag rather than needing sizes authored up front.
    const measured = slots.map((slot) => {
      const r = slot.getBoundingClientRect();
      return Math.max(1, horiz ? r.width : r.height);
    });
    const total = measured.reduce((sum, v) => sum + v, 0);
    const weights = measured.map((v) => (v / total) * measured.length);
    const rect = container.getBoundingClientRect();
    const span = horiz ? rect.width : rect.height;
    const start = horiz ? e.clientX : e.clientY;
    const sum = weights.reduce((acc, w) => acc + w, 0);
    const pair = weights[index - 1] + weights[index];
    const min = pair * MIN_FRACTION;
    const first = weights[index - 1];
    let live = weights;

    const move = (ev: PointerEvent): void => {
      const pos = horiz ? ev.clientX : ev.clientY;
      const delta = span > 0 ? ((pos - start) / span) * sum : 0;
      const next = Math.max(min, Math.min(pair - min, first + delta));
      live = [...weights];
      live[index - 1] = next;
      live[index] = pair - next;
      this.#host.applyResize(zone, live);
      this.#host.rerender();
    };
    const end = (): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      if (this.#host.hasPointerCapture(e.pointerId)) {
        this.#host.releasePointerCapture(e.pointerId);
      }
      this.#host.applyResize(zone, live);
      this.#host.commitResize();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  }
}

function div(className: string): HTMLElement {
  const node = document.createElement('div');
  node.className = className;
  return node;
}

/** Icon per zone — an arrow toward the edge, or a square for the center. */
const ZONE_ICON: Record<ZoneName, string> = {
  top: 'arrow-up',
  bottom: 'arrow-down',
  left: 'arrow-left',
  right: 'arrow-right',
  center: 'square',
};

/** Badge size, and its inset from the working area's edge. */
const BADGE = 56;
const BADGE_INSET = 16;

/**
 * One zone target, positioned as a compass point within the working area's `rect`.
 *
 * `position: fixed` with viewport coordinates, because the compass lives in a
 * host-level overlay rather than inside the layout — the indicators must not become
 * part of the arrangement they describe.
 */
function buildTarget(zone: ZoneName, rect: DOMRect): HTMLElement {
  const badge = div(`slicc-layout__target slicc-layout__target--${zone}`);
  badge.dataset.zone = zone;
  badge.title = `Move to ${ZONE_LABEL[zone]}`;
  badge.appendChild(iconEl(ZONE_ICON[zone], { size: 20 }));
  const label = div('slicc-layout__target-label');
  label.textContent = ZONE_LABEL[zone];
  badge.appendChild(label);

  const midX = rect.left + rect.width / 2 - BADGE / 2;
  const midY = rect.top + rect.height / 2 - BADGE / 2;
  const positions: Record<ZoneName, [number, number]> = {
    center: [midX, midY],
    top: [midX, rect.top + BADGE_INSET],
    bottom: [midX, rect.bottom - BADGE - BADGE_INSET],
    left: [rect.left + BADGE_INSET, midY],
    right: [rect.right - BADGE - BADGE_INSET, midY],
  };
  const [x, y] = positions[zone];
  badge.style.left = `${x}px`;
  badge.style.top = `${y}px`;
  return badge;
}

/** The interaction chrome's CSS, appended to the layout's stylesheet. */
export const INTERACTION_CSS = `
/* The corner grip: hidden until the slot is hovered, mirroring the dock-tree's
   (and slicc-file-tree's) hover-reveal action pattern — a persistent title bar on
   every panel was the thing the redesign set out to remove. */
slicc-layout .slicc-layout__move {
  position: absolute;
  top: 4px;
  left: 4px;
  z-index: 2;
  width: 22px;
  height: 22px;
  display: grid;
  place-items: center;
  border: none;
  padding: 0;
  border-radius: 5px;
  background: var(--panel2, #217399);
  color: var(--ink, #eaf2f6);
  cursor: grab;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.1s ease;
}
slicc-layout .slicc-layout__slot:hover > .slicc-layout__move {
  opacity: 1;
  pointer-events: auto;
}
slicc-layout .slicc-layout__move:active { cursor: grabbing; }
slicc-layout .slicc-layout__move:focus-visible { opacity: 1; pointer-events: auto; }
slicc-layout .slicc-layout__move svg { display: block; }
/* Dividers are inert 6px gutters; the cursor advertises the axis. A ZONE seam is
   the more consequential of the two, so it gets a faint hairline — enough to find,
   not enough to read as a border. */
slicc-layout .slicc-layout__divider { position: relative; flex: 0 0 6px; }
slicc-layout .slicc-layout__divider--h { cursor: col-resize; }
slicc-layout .slicc-layout__divider--v { cursor: row-resize; }
slicc-layout .slicc-layout__divider--zone::after {
  content: '';
  position: absolute;
  inset: 0;
  margin: auto;
  background: color-mix(in srgb, var(--ink, #eaf2f6) 14%, transparent);
  transition: background 0.1s ease;
}
slicc-layout .slicc-layout__divider--zone.slicc-layout__divider--h::after { width: 1px; }
slicc-layout .slicc-layout__divider--zone.slicc-layout__divider--v::after { height: 1px; }
slicc-layout .slicc-layout__divider--zone:hover::after {
  background: var(--accent, #6366f1);
}
/* The drag ghost: fixed and click-through, so it tracks the cursor without
   shadowing the badge being hit-tested underneath it. */
slicc-layout .slicc-layout__ghost {
  position: fixed;
  z-index: 9999;
  display: none;
  pointer-events: none;
  padding: 6px 10px;
  border-radius: 8px;
  background: var(--accent, #6366f1);
  color: #fff;
  font: 600 12px/1.2 system-ui, sans-serif;
  transform: translate(-50%, -50%);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.25);
}
slicc-layout .slicc-layout__ghost--active { display: block; }
/* The five-zone compass. Hidden until a drag starts; each badge takes real
   pointer events so what commits is what the user aimed at, while the container
   stays click-through so the space between badges is not dead. */
slicc-layout .slicc-layout__targets {
  position: fixed;
  inset: 0;
  z-index: 9998;
  display: none;
  pointer-events: none;
}
slicc-layout .slicc-layout__targets--active { display: block; }
slicc-layout .slicc-layout__target {
  position: fixed;
  width: 56px;
  height: 56px;
  display: grid;
  place-items: center;
  gap: 1px;
  pointer-events: auto;
  border-radius: 10px;
  background: color-mix(in srgb, var(--panel2, #217399) 90%, transparent);
  color: var(--ink, #eaf2f6);
  border: 1px solid color-mix(in srgb, var(--accent, #6366f1) 55%, transparent);
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.3);
  transition:
    transform 0.08s ease,
    background 0.08s ease;
}
slicc-layout .slicc-layout__target svg { display: block; }
slicc-layout .slicc-layout__target-label {
  font: 600 9px/1 system-ui, sans-serif;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  opacity: 0.85;
}
/* The hovered badge grows and takes the accent, so the destination is unambiguous. */
slicc-layout .slicc-layout__target--hot {
  background: var(--accent, #6366f1);
  color: #fff;
  transform: scale(1.12);
}
`;
