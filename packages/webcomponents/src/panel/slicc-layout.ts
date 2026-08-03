import { define } from '../internal/define.js';
import { liveArrangement } from './center-ops.js';
import { INTERACTION_CSS, LayoutInteraction } from './layout-interaction.js';
import {
  cloneLayout,
  emptyLayout,
  isPanelLocked,
  type LayoutDocument,
  type LayoutEnvironment,
  layoutPanelIds,
  moveToZone,
  type ResolvedLayout,
  resolveLayout,
  sizeToFlex,
  type ZoneName,
  zoneAxis,
  zonesFromCenter,
} from './layout-schema.js';
import type { PanelSize } from './panel-meta.js';
import { PANEL_MARKER_ATTR } from './slicc-panel.js';

/**
 * Scoped stylesheet for `<slicc-layout>`. Light-DOM host (the layout/slotting
 * convention), so the chrome is injected once into the host document and scoped
 * by tag.
 *
 * The structure nests flexbox to match the schema: a column of
 * `[top dock, middle row, bottom dock]`, where the middle row is
 * `[left dock, center, right dock]` and the center is the recursive split tree.
 * `.slicc-layout__floating` is an inset overlay holding the floating panels —
 * inside this component, so a floating panel stays under the app's trusted layer
 * (see the webapp's `trusted-layer.ts`).
 */
const STYLE = `
slicc-layout {
  display: flex;
  flex-direction: column;
  flex: 1 1 0;
  position: relative;
  min-width: 0;
  min-height: 0;
  box-sizing: border-box;
}
slicc-layout[hidden] { display: none; }
/* The stable render target. Every rebuild replaces THIS element's children, not
   the host's — see the \`#root\` note in the class. \`position:relative\` anchors
   the floating stratum's \`inset:0\`. */
slicc-layout .slicc-layout__root {
  display: flex;
  flex-direction: column;
  flex: 1 1 0;
  position: relative;
  min-width: 0;
  min-height: 0;
  box-sizing: border-box;
}
slicc-layout .slicc-layout__row {
  display: flex;
  flex-direction: row;
  flex: 1 1 0;
  min-width: 0;
  min-height: 0;
}
slicc-layout .slicc-layout__dock,
slicc-layout .slicc-layout__split,
slicc-layout .slicc-layout__slot {
  display: flex;
  min-width: 0;
  min-height: 0;
  box-sizing: border-box;
}
slicc-layout .slicc-layout__dock--top,
slicc-layout .slicc-layout__dock--bottom { flex-direction: row; }
slicc-layout .slicc-layout__dock--left,
slicc-layout .slicc-layout__dock--right { flex-direction: column; }
slicc-layout .slicc-layout__split--row { flex-direction: row; }
slicc-layout .slicc-layout__split--col { flex-direction: column; }
/* A slot is the containing block for its own move grip. Without this the grip's
   \`position: absolute\` resolved against the layout ROOT (the nearest positioned
   ancestor), so every panel's grip stacked at the layout's top-left corner instead
   of appearing on its own panel. */
slicc-layout .slicc-layout__slot { flex-direction: column; position: relative; }
/* The floating stratum: an inset overlay the docked layout does not reflow for.
   No z-index — it is a later sibling of the docked structure, which is enough to
   paint above it, and staying out of the numeric game keeps it below the app's
   trusted layer. \`pointer-events\` are restored on the panels themselves so the
   empty area stays click-through. */
slicc-layout .slicc-layout__floating {
  position: absolute;
  inset: 0;
  pointer-events: none;
}
slicc-layout .slicc-layout__floating > * { pointer-events: auto; }
/* Offstage home for panels the current arrangement does not place. They stay in
   the DOM (state, scroll position, a live terminal session) rather than being
   destroyed and rebuilt on every variant switch. */
slicc-layout .slicc-layout__parking { display: none; }
/* Several strips on one edge stack along that edge's cross axis, in declaration
   order — a second \`top\` dock sits BELOW the first, not beside it. */
slicc-layout .slicc-layout__dockstack {
  display: flex;
  min-width: 0;
  min-height: 0;
  box-sizing: border-box;
}
slicc-layout .slicc-layout__dockstack--top,
slicc-layout .slicc-layout__dockstack--bottom { flex-direction: column; }
slicc-layout .slicc-layout__dockstack--left,
slicc-layout .slicc-layout__dockstack--right { flex-direction: row; }
/* The WORKING AREA: everything the docks left over, divided into the five zones.
   Top and bottom are full-width bands with left|center|right in the row between
   them — Java BorderLayout in nested flexbox. Because this box is nested inside what
   the docks did not take, a zone can never overlap the fixed chrome. */
slicc-layout .slicc-layout__work,
slicc-layout .slicc-layout__work-row {
  display: flex;
  min-width: 0;
  min-height: 0;
  box-sizing: border-box;
}
slicc-layout .slicc-layout__work { flex-direction: column; }
slicc-layout .slicc-layout__work-row { flex-direction: row; flex: 1 1 0; }
slicc-layout .slicc-layout__zone {
  display: flex;
  min-width: 0;
  min-height: 0;
  box-sizing: border-box;
}
/* A zone lays its panels out along its own axis, so two panels in the left zone can
   sit side by side or stacked — see zoneAxis(). */
slicc-layout .slicc-layout__zone[data-axis='row'] { flex-direction: row; }
slicc-layout .slicc-layout__zone[data-axis='col'] { flex-direction: column; }
${INTERACTION_CSS}`;

const STYLE_ID = 'slicc-layout-style';

function ensureLayoutStyle(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLE;
  (doc.head ?? doc.documentElement).appendChild(style);
}

/** Detail of the `slicc-layout-change` event. */
export interface LayoutChangeDetail {
  layout: ResolvedLayout;
  /**
   * Why the layout re-resolved. `rearrange`/`resize` mean the USER edited the
   * document by dragging — the two a host should persist. The others are the
   * layout reacting to something (a load, a breakpoint) and are already
   * reproducible from what's stored.
   */
  reason: 'set' | 'viewport' | 'environment' | 'rearrange' | 'resize';
}

function el(tag: string, className: string): HTMLDivElement {
  const node = document.createElement(tag) as HTMLDivElement;
  node.className = className;
  return node;
}

/**
 * `<slicc-layout>` — renders a {@link LayoutDocument} by arranging `SliccPanel`
 * children into docks, a recursive center tree, and a floating stratum.
 *
 * **Panels are matched, never created.** Like `slicc-dock-tree` before it, the
 * component owns arrangement only: it finds panel elements among its own light-DOM
 * children by `panel-id` and MOVES them into the slot the document asks for.
 * Panels the arrangement does not place are parked offstage rather than removed,
 * so a panel keeps its state (scroll position, a live terminal session, a loaded
 * file tree) across variant switches and re-layouts. The host app decides which
 * panels exist; this decides where they go.
 *
 * **Responsive.** The document's `variants` are re-resolved on host resize via a
 * `ResizeObserver` — against the HOST's box, not the window's, so a layout nested
 * in a narrow container (the extension side panel, a Cherry embed) responds to the
 * space it actually has rather than the viewport it happens to sit in.
 *
 * Built alongside `<slicc-dock-tree>` rather than replacing it in place, so the
 * shipping shell keeps working while this lands. See
 * `docs/panel-system-design.md`.
 *
 * @attr hidden - native; hides the whole layout
 * @attr platform - float hint for `variants[].when.platform` (`web`/`extension`/`electron`)
 * @fires slicc-layout-change - composed + bubbling `CustomEvent<LayoutChangeDetail>` when the resolved layout changes
 * @slot - default; `SliccPanel` children, matched into slots by `panel-id`
 */
export class SliccLayout extends HTMLElement {
  static readonly observedAttributes = ['platform'];

  #doc: LayoutDocument = emptyLayout();
  #resolved: ResolvedLayout | null = null;
  #connected = false;

  /**
   * The stable render target. Rebuilds replace THIS element's children rather
   * than the host's, which is what keeps `#childObserver` from re-entering:
   * observing the host and then calling `this.replaceChildren()` inside the
   * callback is an infinite loop. `#root` and `#parking` are the host's only
   * own children once mounted, so a rebuild produces no host-level mutation.
   */
  readonly #root: HTMLDivElement = el('div', 'slicc-layout__root');

  readonly #parking: HTMLDivElement = el('div', 'slicc-layout__parking');

  /** Ids the last render actually placed (vs. merely referenced by the document). */
  #placed = new Set<string>();

  /**
   * The arrangement currently being built, for the duration of `#render` only.
   * Slot decoration happens mid-build and must see THIS arrangement's locks, not
   * the previous one's — see `isLocked`.
   */
  #rendering: ResolvedLayout | null = null;

  /**
   * Re-resolve on host resize so `variants` react to the space this component
   * actually has. Debounced through rAF: a resize drag fires continuously and
   * each re-resolve rebuilds DOM.
   */
  #resizeObserver: ResizeObserver | null = null;
  #resizeRaf = 0;

  /**
   * A panel appended after `setLayout` (a lazily mounted tool panel, a sprinkle
   * that just finished discovery) would otherwise sit unplaced forever.
   * `#render` moves matched panels into stable containers, so this settles
   * rather than looping.
   */
  readonly #childObserver = new MutationObserver(() => this.#render());

  /** Pointer gestures (move button + divider drag) — see `layout-interaction.ts`. */
  readonly #interaction = new LayoutInteraction(this);

  connectedCallback(): void {
    ensureLayoutStyle(this.ownerDocument);
    this.#connected = true;
    if (this.#root.parentElement !== this) this.append(this.#root);
    if (this.#parking.parentElement !== this) this.append(this.#parking);
    // The overlays are the host's own children, so a rebuild of `#root` mid-drag
    // cannot destroy the ghost the user is currently dragging.
    for (const overlay of this.#interaction.overlays()) {
      if (overlay.parentElement !== this) this.append(overlay);
    }
    this.#observeResize();
    this.#render();
    this.#childObserver.observe(this, { childList: true });
  }

  disconnectedCallback(): void {
    this.#connected = false;
    this.#childObserver.disconnect();
    this.#interaction.cancel();
    this.#resizeObserver?.disconnect();
    this.#resizeObserver = null;
    if (this.#resizeRaf) cancelAnimationFrame(this.#resizeRaf);
    this.#resizeRaf = 0;
  }

  attributeChangedCallback(name: string, prev: string | null, next: string | null): void {
    if (name !== 'platform' || prev === next || !this.#connected) return;
    this.#render('environment');
  }

  /** Load a layout document. `null` resets to an empty layout. */
  setLayout(doc: LayoutDocument | null): void {
    this.#doc = doc ? cloneLayout(doc) : emptyLayout();
    if (this.#connected) this.#render('set');
  }

  /** The loaded document, deep-cloned — the serialization contract for save. */
  getLayout(): LayoutDocument {
    return cloneLayout(this.#doc);
  }

  /** The arrangement currently rendered (post-variant), or `null` before first render. */
  getResolved(): ResolvedLayout | null {
    return this.#resolved ? cloneLayout(this.#resolved) : null;
  }

  /**
   * Panel ids the current arrangement ACTUALLY rendered, in document order.
   *
   * Filtered by what was placed, not merely by what the document mentions: a
   * panel the document references but that is hidden (`panels[id].visible ===
   * false`), has no element supplied, or sits in a collapsed dock is parked
   * rather than rendered. Reporting it as placed made the add-panel menu show a
   * checkmark next to an invisible panel, so clicking it "again" hid what was
   * already hidden.
   */
  getPlacedPanelIds(): string[] {
    if (!this.#resolved) return [];
    return layoutPanelIds(this.#resolved).filter((id) => this.#placed.has(id));
  }

  /**
   * Whether a panel is locked against user rearrangement in the current layout.
   *
   * Prefers `#rendering` — the arrangement being built right now — over `#resolved`,
   * which `#render` only assigns once the DOM is complete. `decorateSlot` asks this
   * DURING the build, so reading `#resolved` there consulted the PREVIOUS
   * arrangement (or `null` on first render) and handed a locked panel a move button.
   */
  isLocked(panelId: string): boolean {
    const layout = this.#rendering ?? this.#resolved;
    return layout ? isPanelLocked(layout, panelId) : false;
  }

  /** The environment the document is resolved against (host box + platform hint). */
  environment(): LayoutEnvironment {
    const rect = this.getBoundingClientRect();
    const platform = this.getAttribute('platform');
    return {
      width: rect.width,
      height: rect.height,
      platform:
        platform === 'web' || platform === 'extension' || platform === 'electron'
          ? platform
          : undefined,
    };
  }

  /**
   * Collect placeable panels: light-DOM descendants carrying a panel marker,
   * keyed by `panel-id`. Skips panels nested inside another panel — those are
   * that panel's CONTENT, not slots this layout fills, and pooling them would
   * rip them out of their owner.
   */
  #collectPanels(): Map<string, HTMLElement> {
    const pool = new Map<string, HTMLElement>();
    for (const node of Array.from(this.querySelectorAll(`[${PANEL_MARKER_ATTR}]`))) {
      if (!(node instanceof HTMLElement)) continue;
      if (node.parentElement?.closest(`[${PANEL_MARKER_ATTR}]`)) continue;
      const id = node.getAttribute('panel-id');
      if (id) pool.set(id, node);
    }
    return pool;
  }

  /** Rebuild the arrangement from the document, resolved for the current environment. */
  #render(reason: LayoutChangeDetail['reason'] = 'set', opts?: { silent?: boolean }): void {
    const resolved = resolveLayout(this.#doc, this.environment());
    this.#rendering = resolved;
    const pool = this.#collectPanels();
    const placed = new Set<string>();

    const dockFor = (edge: 'top' | 'bottom' | 'left' | 'right'): HTMLElement | null =>
      this.#buildDocks(resolved, edge, pool, placed);

    const middle = el('div', 'slicc-layout__row');
    const left = dockFor('left');
    const right = dockFor('right');
    if (left) middle.appendChild(left);
    // The working area goes between the rails and under the top strip, because it
    // is what the docks leave over — that nesting is what keeps a zone from ever
    // overlapping the fixed chrome.
    const work = this.#buildZones(resolved, pool, placed);
    work.style.flex = '1 1 0';
    middle.appendChild(work);
    if (right) middle.appendChild(right);

    const children: HTMLElement[] = [];
    const top = dockFor('top');
    if (top) children.push(top);
    // Keep the middle row even when empty: it is what gives the layout its
    // height, and dropping it would collapse a docks-only arrangement.
    children.push(middle);
    const bottom = dockFor('bottom');
    if (bottom) children.push(bottom);

    const floating = this.#buildFloating(resolved, pool, placed);
    if (floating) children.push(floating);

    // Park whatever the arrangement did not place — keeping it in the DOM so its
    // state survives (see the class doc).
    for (const [id, panel] of pool) {
      if (placed.has(id)) continue;
      if (panel.parentElement !== this.#parking) this.#parking.appendChild(panel);
    }

    // Replace `#root`'s children, never the host's: the child observer watches
    // the host, so mutating it here would re-enter `#render` forever.
    this.#root.replaceChildren(...children);
    // Rendering still mutates the HOST's child list once per newly-arrived
    // panel — a panel authored as a direct child (the normal case) gets MOVED
    // into `#root`/`#parking`, which is a removal from the host. Draining the
    // observer's queue here discards those self-inflicted records so they don't
    // schedule a redundant second render (which would also fire a spurious
    // change event). Genuinely new children appended later still queue a record
    // after this point and are picked up normally.
    this.#childObserver.takeRecords();
    this.#resolved = resolved;
    this.#placed = placed;
    this.#rendering = null;
    if (opts?.silent) return;
    this.dispatchEvent(
      new CustomEvent<LayoutChangeDetail>('slicc-layout-change', {
        bubbles: true,
        composed: true,
        detail: { layout: cloneLayout(resolved), reason },
      })
    );
  }

  /** Build one edge's dock, or `null` when it has no placeable panels. */
  #buildDocks(
    resolved: ResolvedLayout,
    edge: 'top' | 'bottom' | 'left' | 'right',
    pool: Map<string, HTMLElement>,
    placed: Set<string>
  ): HTMLElement | null {
    const specs = resolved.docks.filter((dock) => dock.edge === edge);
    if (specs.length === 0) return null;

    // ONE container per spec, not one per edge.
    //
    // Collapsing every `edge: 'top'` spec into a single element made a second top
    // dock a SIBLING of the first: a 180px status bar declared after the 36px scoop
    // strip landed beside the switcher in one row, sharing its height, instead of
    // stacking beneath it. Each spec is its own strip — that is what "in order"
    // means for `docks[]` — and the last spec's `size` also silently overwrote the
    // first's, which is how a 36px chrome strip became 180px tall.
    const built: HTMLElement[] = [];
    for (const spec of specs) {
      const container = el('div', `slicc-layout__dock slicc-layout__dock--${edge}`);
      container.dataset.edge = edge;
      let any = false;
      for (const id of spec.panels) {
        const panel = pool.get(id);
        if (!panel || resolved.panels[id]?.visible === false) continue;
        this.#applyPanelState(panel, resolved, id);
        container.appendChild(panel);
        placed.add(id);
        any = true;
      }
      // A dock whose panels are all missing or hidden must not reserve space —
      // otherwise hiding the last panel in a rail leaves an empty strip behind.
      if (!any) continue;
      container.style.flex = spec.size != null ? sizeToFlex(spec.size) : '0 0 auto';
      built.push(container);
    }
    if (built.length === 0) return null;
    if (built.length === 1) return built[0];

    // Several strips on one edge stack along that edge's cross axis, in declaration
    // order: `top`/`bottom` strips are full-width rows stacked vertically, `left`/
    // `right` strips are full-height columns stacked horizontally.
    const stack = el('div', `slicc-layout__dockstack slicc-layout__dockstack--${edge}`);
    stack.dataset.edge = edge;
    stack.append(...built);
    stack.style.flex = '0 0 auto';
    return stack;
  }

  /**
   * Build the five-zone working area: `top` and `bottom` as full-width rows, with
   * `left`/`center`/`right` in the row between them — Java `BorderLayout`, in
   * nested flexbox.
   *
   * An empty zone renders nothing and takes no space, so a layout with only a
   * center looks exactly like one panel filling the area. `center` always gets the
   * remainder (`flex: 1 1 0`); the edge zones take their `sizes` entry or size to
   * their content.
   */
  #buildZones(
    resolved: ResolvedLayout,
    pool: Map<string, HTMLElement>,
    placed: Set<string>
  ): HTMLElement {
    // A document predating the zone model renders through its legacy tree,
    // flattened — see `zonesFromCenter` for why everything lands in the center.
    const zones = resolved.zones ?? (resolved.center ? zonesFromCenter(resolved.center) : {});
    const container = el('div', 'slicc-layout__work');

    const band = (zone: ZoneName): HTMLElement | null => {
      const locked = resolved.locked || (zones.locked ?? []).includes(zone);
      const slots = (zones[zone] ?? [])
        .map((id) => this.#buildSlot(id, zone, resolved, pool, placed))
        .filter((slot): slot is HTMLElement => slot !== null);
      if (slots.length === 0) return null;
      const element = el('div', `slicc-layout__zone slicc-layout__zone--${zone}`);
      element.dataset.zone = zone;
      const axis = zoneAxis(zones, zone);
      element.dataset.axis = axis;
      // Panels within a zone are resizable against each other, so interleave a
      // divider between each adjacent pair.
      slots.forEach((slot, index) => {
        if (index > 0) {
          const divider = this.#interaction.buildZonePanelDivider(zone, axis, element, locked);
          if (divider) element.appendChild(divider);
        }
        element.appendChild(slot);
      });
      const size = zones.sizes?.[zone];
      // `center` is the remainder by definition, so an explicit size on it would
      // contradict the model — the edge zones are the ones with a thickness.
      element.style.flex = zone === 'center' ? '1 1 0' : sizeToFlex(size ?? undefined);
      return element;
    };

    /**
     * Assemble a run of zones with resize dividers between the RENDERED ones.
     *
     * Only between rendered zones: an empty zone takes no space, so a divider
     * beside one would sit against nothing and drag a thickness the user cannot
     * see. Either neighbour being locked suppresses the divider, since a drag
     * moves space between the two of them.
     */
    const runOf = (parent: HTMLElement, order: readonly ZoneName[], horiz: boolean): void => {
      const built = order
        .map((zone) => ({ zone, element: band(zone) }))
        .filter((entry): entry is { zone: ZoneName; element: HTMLElement } => !!entry.element);
      built.forEach((entry, index) => {
        if (index > 0) {
          const previous = built[index - 1].zone;
          const locked =
            resolved.locked ||
            (zones.locked ?? []).includes(previous) ||
            (zones.locked ?? []).includes(entry.zone);
          const divider = this.#interaction.buildZoneDivider(
            previous,
            entry.zone,
            horiz,
            parent,
            locked
          );
          if (divider) parent.appendChild(divider);
        }
        parent.appendChild(entry.element);
      });
    };

    // `top` and `bottom` are full-width bands, so their dividers run horizontally
    // (row-resize); `left|center|right` divide the width, so theirs are vertical.
    const middle = el('div', 'slicc-layout__work-row');
    runOf(middle, ['left', 'center', 'right'], true);

    const top = band('top');
    const bottom = band('bottom');
    const column: Array<{ zone: ZoneName; element: HTMLElement }> = [];
    if (top) column.push({ zone: 'top', element: top });
    // The middle row is the center's band for divider purposes: dragging the seam
    // under `top` resizes `top` against everything below it.
    column.push({ zone: 'center', element: middle });
    if (bottom) column.push({ zone: 'bottom', element: bottom });
    column.forEach((entry, index) => {
      if (index > 0) {
        const previous = column[index - 1].zone;
        const locked =
          resolved.locked ||
          (zones.locked ?? []).includes(previous) ||
          (zones.locked ?? []).includes(entry.zone);
        const divider = this.#interaction.buildZoneDivider(
          previous,
          entry.zone,
          false,
          container,
          locked
        );
        if (divider) container.appendChild(divider);
      }
      container.appendChild(entry.element);
    });
    return container;
  }

  /** One panel's slot within a zone, or `null` when it is missing or hidden. */
  #buildSlot(
    panelId: string,
    zone: ZoneName,
    resolved: ResolvedLayout,
    pool: Map<string, HTMLElement>,
    placed: Set<string>
  ): HTMLElement | null {
    const panel = pool.get(panelId);
    if (!panel || resolved.panels[panelId]?.visible === false) return null;
    const slot = el('div', 'slicc-layout__slot');
    // The drag layer hit-tests slots and reads both of these straight back off.
    slot.dataset.panelId = panelId;
    slot.dataset.zone = zone;
    slot.style.flex = sizeToFlex(resolved.panels[panelId]?.size ?? undefined);
    this.#applyPanelState(panel, resolved, panelId);
    slot.appendChild(panel);
    this.#interaction.decorateSlot(slot, panelId);
    placed.add(panelId);
    return slot;
  }

  /**
   * Commit a user drag: put `panelId` in `zone`.
   *
   * Edits the DOCUMENT and re-renders from it, so the change is what `getLayout()`
   * serializes and a host persists. Edits the arrangement the current environment
   * RENDERS — which may be a variant, not `base` — since a variant replaces the
   * working area, and writing to `base` while a variant is on screen would land the
   * change somewhere invisible and the drag would appear to snap back.
   */
  applyMove(panelId: string, zone: ZoneName): void {
    if (this.isLocked(panelId)) return;
    const owner = liveArrangement(this.#doc, this.environment());
    // Migrate a legacy document on first edit rather than refusing to move: the
    // alternative is a saved layout the user simply cannot rearrange.
    const zones = owner.zones ?? zonesFromCenter(owner.center ?? null);
    const next = moveToZone(zones, panelId, zone);
    if (next === zones && owner.zones) return;
    owner.zones = next;
    owner.center = null;
    this.#render('rearrange');
  }

  /**
   * Write panel weights within one zone into the document. No render, no event.
   *
   * Weights live in `panels[id].size` rather than on the zone, because a zone's own
   * `sizes` entry is its THICKNESS against the other zones — a different axis and a
   * different question. `weights` is index-aligned with the zone's panel list.
   */
  applyResize(zone: ZoneName, weights: number[]): void {
    const owner = liveArrangement(this.#doc, this.environment());
    const zones = owner.zones;
    const ids = zones?.[zone];
    if (!zones || !ids || ids.length !== weights.length) return;
    const panels = { ...(this.#doc.panels ?? {}) };
    ids.forEach((id, index) => {
      panels[id] = { ...panels[id], size: weights[index] };
    });
    this.#doc.panels = panels;
  }

  /**
   * Write a zone's THICKNESS — how much of the working area the whole zone takes
   * against its neighbours, which is what a divider between two zones drags.
   */
  applyZoneResize(zone: ZoneName, size: PanelSize): void {
    const owner = liveArrangement(this.#doc, this.environment());
    if (!owner.zones) return;
    owner.zones.sizes = { ...owner.zones.sizes, [zone]: size };
  }

  /**
   * Re-render mid-gesture, WITHOUT firing a change event.
   *
   * A resize drag calls this on every pointermove; firing `slicc-layout-change`
   * per frame would have a persisting host writing a file ~60×/second for one
   * drag. `commitResize` fires once at the end instead — the same split the
   * dock-tree made between its live re-render and its `dock-tree-resize` event.
   */
  rerender(): void {
    this.#render('resize', { silent: true });
  }

  /** End of a divider drag: announce the final geometry once. */
  commitResize(): void {
    this.#render('resize');
  }

  /** Build the floating stratum, or `null` when nothing floats. */
  #buildFloating(
    resolved: ResolvedLayout,
    pool: Map<string, HTMLElement>,
    placed: Set<string>
  ): HTMLElement | null {
    if (resolved.floating.length === 0) return null;
    const container = el('div', 'slicc-layout__floating');
    let any = false;

    for (const spec of resolved.floating) {
      const panel = pool.get(spec.panel);
      if (!panel || resolved.panels[spec.panel]?.visible === false) continue;
      this.#applyPanelState(panel, resolved, spec.panel);
      panel.setAttribute('presentation', 'floating');
      if (spec.anchor) panel.setAttribute('anchor', spec.anchor);
      if (spec.width != null) panel.style.width = cssLength(spec.width);
      if (spec.height != null) panel.style.height = cssLength(spec.height);
      container.appendChild(panel);
      placed.add(spec.panel);
      any = true;
    }
    return any ? container : null;
  }

  /**
   * Push the resolved state onto a panel element: lock, and the docked
   * presentation reset.
   *
   * The presentation reset matters — a panel that floated under the previous
   * arrangement carries `presentation="floating"` plus inline width/height, and
   * would keep floating in a layout that docks it. `#buildFloating` re-applies
   * the floating attributes after this, so ordering is: reset here, float there.
   */
  #applyPanelState(panel: HTMLElement, resolved: ResolvedLayout, id: string): void {
    panel.toggleAttribute('locked', isPanelLocked(resolved, id));
    panel.removeAttribute('hidden');
    panel.setAttribute('presentation', 'docked');
    panel.removeAttribute('anchor');
    panel.style.removeProperty('width');
    panel.style.removeProperty('height');
  }

  /** Observe the host box so `variants` track the space this layout actually has. */
  #observeResize(): void {
    if (typeof ResizeObserver === 'undefined') return;
    this.#resizeObserver = new ResizeObserver(() => {
      // Only re-render when a variant could actually change — a document with no
      // variants is size-independent, and rebuilding its DOM on every resize
      // frame would be pure waste (and would fight an in-progress drag).
      if (!this.#doc.variants?.length) return;
      if (this.#resizeRaf) return;
      this.#resizeRaf = requestAnimationFrame(() => {
        this.#resizeRaf = 0;
        const next = resolveLayout(this.#doc, this.environment());
        // Re-render only when the matched variant set changed, not on every
        // pixel: resizing within one breakpoint must not rebuild the DOM.
        const before = this.#resolved?.appliedVariants.join(',') ?? '';
        if (next.appliedVariants.join(',') === before) return;
        this.#render('viewport');
      });
    });
    this.#resizeObserver.observe(this);
  }
}

/** Render a `PanelSize` as a CSS length (a bare number means px here, not fr). */
function cssLength(size: string | number): string {
  return typeof size === 'number' ? `${size}px` : size;
}

define('slicc-layout', SliccLayout);

declare global {
  interface HTMLElementTagNameMap {
    'slicc-layout': SliccLayout;
  }
  interface HTMLElementEventMap {
    'slicc-layout-change': CustomEvent<LayoutChangeDetail>;
  }
}
