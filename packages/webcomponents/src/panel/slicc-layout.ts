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

export interface LayoutChangeDetail {
  layout: ResolvedLayout;

  reason: 'set' | 'viewport' | 'environment' | 'rearrange' | 'resize';
}

function el(tag: string, className: string): HTMLDivElement {
  const node = document.createElement(tag) as HTMLDivElement;
  node.className = className;
  return node;
}

export class SliccLayout extends HTMLElement {
  static readonly observedAttributes = ['platform'];

  #doc: LayoutDocument = emptyLayout();
  #resolved: ResolvedLayout | null = null;
  #connected = false;

  readonly #root: HTMLDivElement = el('div', 'slicc-layout__root');

  readonly #parking: HTMLDivElement = el('div', 'slicc-layout__parking');

  #placed = new Set<string>();

  #rendering: ResolvedLayout | null = null;

  #resizeObserver: ResizeObserver | null = null;
  #resizeRaf = 0;

  readonly #childObserver = new MutationObserver(() => this.#render());

  readonly #interaction = new LayoutInteraction(this);

  connectedCallback(): void {
    ensureLayoutStyle(this.ownerDocument);
    this.#connected = true;
    if (this.#root.parentElement !== this) this.append(this.#root);
    if (this.#parking.parentElement !== this) this.append(this.#parking);

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

  setLayout(doc: LayoutDocument | null): void {
    this.#doc = doc ? cloneLayout(doc) : emptyLayout();
    if (this.#connected) this.#render('set');
  }

  getLayout(): LayoutDocument {
    return cloneLayout(this.#doc);
  }

  getResolved(): ResolvedLayout | null {
    return this.#resolved ? cloneLayout(this.#resolved) : null;
  }

  getPlacedPanelIds(): string[] {
    if (!this.#resolved) return [];
    return layoutPanelIds(this.#resolved).filter((id) => this.#placed.has(id));
  }

  isLocked(panelId: string): boolean {
    const layout = this.#rendering ?? this.#resolved;
    return layout ? isPanelLocked(layout, panelId) : false;
  }

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

    const work = this.#buildZones(resolved, pool, placed);
    work.style.flex = '1 1 0';
    middle.appendChild(work);
    if (right) middle.appendChild(right);

    const children: HTMLElement[] = [];
    const top = dockFor('top');
    if (top) children.push(top);

    children.push(middle);
    const bottom = dockFor('bottom');
    if (bottom) children.push(bottom);

    const floating = this.#buildFloating(resolved, pool, placed);
    if (floating) children.push(floating);

    for (const [id, panel] of pool) {
      if (placed.has(id)) continue;
      if (panel.parentElement !== this.#parking) this.#parking.appendChild(panel);
    }

    this.#root.replaceChildren(...children);

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

  #buildDocks(
    resolved: ResolvedLayout,
    edge: 'top' | 'bottom' | 'left' | 'right',
    pool: Map<string, HTMLElement>,
    placed: Set<string>
  ): HTMLElement | null {
    const specs = resolved.docks.filter((dock) => dock.edge === edge);
    if (specs.length === 0) return null;

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

      if (!any) continue;
      container.style.flex = spec.size != null ? sizeToFlex(spec.size) : '0 0 auto';
      built.push(container);
    }
    if (built.length === 0) return null;
    if (built.length === 1) return built[0];

    const stack = el('div', `slicc-layout__dockstack slicc-layout__dockstack--${edge}`);
    stack.dataset.edge = edge;
    stack.append(...built);
    stack.style.flex = '0 0 auto';
    return stack;
  }

  #buildZones(
    resolved: ResolvedLayout,
    pool: Map<string, HTMLElement>,
    placed: Set<string>
  ): HTMLElement {
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

      slots.forEach((slot, index) => {
        if (index > 0) {
          const divider = this.#interaction.buildZonePanelDivider(zone, axis, element, locked);
          if (divider) element.appendChild(divider);
        }
        element.appendChild(slot);
      });
      const size = zones.sizes?.[zone];

      element.style.flex = zone === 'center' ? '1 1 0' : sizeToFlex(size ?? undefined);
      return element;
    };

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

    const middle = el('div', 'slicc-layout__work-row');
    runOf(middle, ['left', 'center', 'right'], true);

    const top = band('top');
    const bottom = band('bottom');
    const column: Array<{ zone: ZoneName; element: HTMLElement }> = [];
    if (top) column.push({ zone: 'top', element: top });

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

    slot.dataset.panelId = panelId;
    slot.dataset.zone = zone;
    slot.style.flex = sizeToFlex(resolved.panels[panelId]?.size ?? undefined);
    this.#applyPanelState(panel, resolved, panelId);
    slot.appendChild(panel);
    this.#interaction.decorateSlot(slot, panelId);
    placed.add(panelId);
    return slot;
  }

  applyMove(panelId: string, zone: ZoneName): void {
    if (this.isLocked(panelId)) return;
    const owner = liveArrangement(this.#doc, this.environment());

    const zones = owner.zones ?? zonesFromCenter(owner.center ?? null);
    const next = moveToZone(zones, panelId, zone);
    if (next === zones && owner.zones) return;
    owner.zones = next;
    owner.center = null;
    this.#render('rearrange');
  }

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

  applyZoneResize(zone: ZoneName, size: PanelSize): void {
    const owner = liveArrangement(this.#doc, this.environment());
    if (!owner.zones) return;
    owner.zones.sizes = { ...owner.zones.sizes, [zone]: size };
  }

  rerender(): void {
    this.#render('resize', { silent: true });
  }

  commitResize(): void {
    this.#render('resize');
  }

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

  #applyPanelState(panel: HTMLElement, resolved: ResolvedLayout, id: string): void {
    panel.toggleAttribute('locked', isPanelLocked(resolved, id));
    panel.removeAttribute('hidden');
    panel.setAttribute('presentation', 'docked');
    panel.removeAttribute('anchor');
    panel.style.removeProperty('width');
    panel.style.removeProperty('height');
  }

  #observeResize(): void {
    if (typeof ResizeObserver === 'undefined') return;
    this.#resizeObserver = new ResizeObserver(() => {
      if (!this.#doc.variants?.length) return;
      if (this.#resizeRaf) return;
      this.#resizeRaf = requestAnimationFrame(() => {
        this.#resizeRaf = 0;
        const next = resolveLayout(this.#doc, this.environment());

        const before = this.#resolved?.appliedVariants.join(',') ?? '';
        if (next.appliedVariants.join(',') === before) return;
        this.#render('viewport');
      });
    });
    this.#resizeObserver.observe(this);
  }
}

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
