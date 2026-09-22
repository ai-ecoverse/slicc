import { define } from '../internal/define.js';
import { withFocusPreserved } from '../internal/focus.js';
import { iconEl } from '../internal/icons.js';
import { TERM_SURFACE_ID } from './terminal-theme.js';

export { TERM_SURFACE_ID } from './terminal-theme.js';

const STYLE = `
slicc-dock-tree {
  display: block;
  /* Fill the parent shell's flex column. Without this the host collapses to
     0 height, and the .dock-tree__root's height:100% resolves against 0 —
     leaving every zone/leaf zero-height. */
  flex: 1 1 0;
  position: relative;
  min-width: 0;
  min-height: 0;
  box-sizing: border-box;
}
slicc-dock-tree[hidden] {
  display: none;
}
slicc-dock-tree .dock-tree__root {
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  box-sizing: border-box;
}
slicc-dock-tree .dock-tree__row {
  display: flex;
  flex-direction: row;
  gap: 6px;
  min-width: 0;
  min-height: 0;
  box-sizing: border-box;
}
slicc-dock-tree .dock-tree__zone {
  position: relative;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  box-sizing: border-box;
}
slicc-dock-tree .dock-tree__empty {
  flex: 1 1 0;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 44px;
  min-width: 0;
  border: 2px dashed var(--line, #b7c6cf);
  border-radius: 10px;
  color: var(--muted, #8899aa);
  font-size: 12px;
  box-sizing: border-box;
}
slicc-dock-tree .dock-tree__split {
  display: flex;
  min-width: 0;
  min-height: 0;
  gap: 6px;
  box-sizing: border-box;
}
slicc-dock-tree .dock-tree__split--row {
  flex-direction: row;
}
slicc-dock-tree .dock-tree__split--col {
  flex-direction: column;
}
slicc-dock-tree .dock-tree__leaf {
  position: relative;
  display: flex;
  min-width: 0;
  min-height: 0;
  flex: 1 1 0;
  box-sizing: border-box;
}
slicc-dock-tree .dock-tree__divider {
  position: relative;
  flex: 0 0 6px;
}
slicc-dock-tree .dock-tree__divider--h {
  cursor: col-resize;
}
slicc-dock-tree .dock-tree__divider--v {
  cursor: row-resize;
}
slicc-dock-tree .dock-tree__parking {
  display: none;
}
slicc-dock-tree .dock-tree__zone--droppable {
  outline: 1px dashed rgba(99, 102, 241, 0.25);
  outline-offset: -1px;
}
slicc-dock-tree .dock-tree__zone--hot {
  outline: 2px dashed rgba(99, 102, 241, 0.4);
  outline-offset: 2px;
}
slicc-dock-tree .dock-tree__tile {
  position: relative;
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  box-sizing: border-box;
}
/* Tool tiles (every leaf except the reserved chat column) carry the
   prototype's floating rounded workbench-pane chrome — the .pane card that
   \`<slicc-workbench-pane>\` used to compose via \`<slicc-pane elevated>\`:
   --canvas surface, 1px --line border, 14px radius, the elevated two-layer
   shadow, 12px float margin. \`overflow: hidden\` clips full-bleed content
   (xterm's dark surface, iframes) to the rounded corners. The chat tile stays
   FLAT (full-bleed over the shader), exactly like the prototype's .chatpane. */
slicc-dock-tree .dock-tree__tile--chrome {
  margin: 12px;
  background: var(--canvas, #fff);
  border: 1px solid var(--line, #b7c6cf);
  border-radius: 14px;
  box-shadow:
    rgba(10, 10, 10, 0.1) 0 14px 36px -12px,
    rgba(10, 10, 10, 0.05) 0 4px 10px -4px;
  overflow: hidden;
  /* Float above the composer's full-bleed band (z-index 2 + a ::before that
     extends under the pane — slicc-composer.ts): the pane is chrome ON TOP
     of the band, not content beneath it. */
  z-index: 3;
}
.dark slicc-dock-tree .dock-tree__tile--chrome,
[data-theme="dark"] slicc-dock-tree .dock-tree__tile--chrome {
  box-shadow:
    rgba(0, 0, 0, 0.45) 0 14px 36px -12px,
    rgba(0, 0, 0, 0.3) 0 4px 10px -4px;
}
/* Terminal leaf: same floating geometry, but always-dark chrome so a light
   page theme (vanilla) does not paint a cream card border around xterm. */
slicc-dock-tree .dock-tree__tile--chrome-dark {
  background: var(--term-bg, #0c0c0e);
  border-color: var(--term-border, #232329);
  box-shadow:
    rgba(0, 0, 0, 0.35) 0 14px 36px -12px,
    rgba(0, 0, 0, 0.2) 0 4px 10px -4px;
}
/* Slide-in for a NEWLY PLACED tool tile — the prototype workbench's .38s
   cubic-bezier(.4,0,.2,1) open, re-homed as an entrance animation because the
   dock-tree rebuilds its DOM on every render (a width transition has no
   persistent element to ride). Applied only when the render actually ADDED
   the surface to the placed set — divider-drag re-renders (one per
   pointermove) keep the set unchanged and never replay it. Closing is
   instant: an exit animation would mean keeping dead tiles in the tree past
   their render. */
slicc-dock-tree .dock-tree__tile--enter {
  animation: slicc-dock-tile-in 0.38s cubic-bezier(0.4, 0, 0.2, 1);
}
@keyframes slicc-dock-tile-in {
  from {
    transform: translateX(32px);
    opacity: 0;
  }
  to {
    transform: none;
    opacity: 1;
  }
}
@media (prefers-reduced-motion: reduce) {
  slicc-dock-tree .dock-tree__tile--enter {
    animation: none;
  }
}
slicc-dock-tree .dock-tree__tile-move {
  position: absolute;
  top: 4px;
  left: 4px;
  z-index: 1;
  width: 22px;
  height: 22px;
  display: grid;
  place-items: center;
  border: none;
  background: var(--panel2, #217399);
  color: var(--ink, #eaf2f6);
  border-radius: 5px;
  cursor: grab;
  padding: 0;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.1s ease;
}
slicc-dock-tree .dock-tree__tile:hover .dock-tree__tile-move {
  opacity: 1;
  pointer-events: auto;
}
slicc-dock-tree .dock-tree__tile-move:active {
  cursor: grabbing;
}
slicc-dock-tree .dock-tree__tile-move svg {
  display: block;
}
slicc-dock-tree .dock-tree__tile-body {
  position: relative;
  flex: 1 1 auto;
  display: flex;
  min-width: 0;
  min-height: 0;
  box-sizing: border-box;
}
slicc-dock-tree .dock-tree__ghost {
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
slicc-dock-tree .dock-tree__ghost--active {
  display: block;
}
slicc-dock-tree .dock-tree__preview {
  position: fixed;
  z-index: 9998;
  display: none;
  pointer-events: none;
  border-radius: 8px;
  background: rgba(99, 102, 241, 0.28);
  outline: 2px solid var(--accent, #6366f1);
}
slicc-dock-tree .dock-tree__preview--active {
  display: block;
}
`;

const STYLE_ID = 'slicc-dock-tree-style';

function ensureDockTreeStyle(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLE;
  (doc.head ?? doc.documentElement).appendChild(style);
}

const SURFACE_TAG = 'slicc-surface';

export const CHAT_SURFACE_ID = 'chat';

const SPRINKLE_PREFIX = 'sprinkle:';

function isFalseString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().toLowerCase() === 'false';
}

export function labelForSurface(surfaceId: string): string {
  if (surfaceId === CHAT_SURFACE_ID) return 'Chat';
  if (surfaceId.startsWith(SPRINKLE_PREFIX)) return surfaceId.slice(SPRINKLE_PREFIX.length);
  return surfaceId;
}

export type DockNode =
  | { type: 'leaf'; surfaceId: string; locked?: boolean }
  | { type: 'split'; dir: 'row' | 'col'; children: DockNode[]; sizes: number[]; locked?: boolean };

type SplitNode = Extract<DockNode, { type: 'split' }>;

export type ZoneName = 'top' | 'left' | 'middle' | 'right' | 'bottom';

export type DropRegion = 'n' | 's' | 'e' | 'w' | 'center';

type DropTarget =
  | { zone: ZoneName; empty: true }
  | { zone: ZoneName; empty?: false; leaf: DockNode; region: DropRegion };

type DragState =
  | { kind: 'internal'; node: DockNode; fromZone: ZoneName }
  | { kind: 'external'; surfaceId: string };

interface SizeAxis {
  currentFr: number;
  groupFr: readonly number[];
  apply(newFr: number): void;
}

export interface DockTreeSpec {
  zones: Record<ZoneName, DockNode | null>;
  rowFr: { top: number; center: number; bottom: number };
  colFr: { left: number; middle: number; right: number };
  locked?: boolean;
}

export interface SurfaceSizeSpec {
  widthPx?: number;
  widthPercent?: number;
  heightPx?: number;
  heightPercent?: number;
}

const ZONE_NAMES: readonly ZoneName[] = ['top', 'left', 'middle', 'right', 'bottom'];

type CenterZone = 'left' | 'middle' | 'right';
const CENTER_ZONES: readonly CenterZone[] = ['left', 'middle', 'right'];

const ROW_KEYS: readonly ('top' | 'center' | 'bottom')[] = ['top', 'center', 'bottom'];

const MIN_FRACTION = 0.02;

function emptyTree(): DockTreeSpec {
  return {
    zones: { top: null, left: null, middle: null, right: null, bottom: null },
    rowFr: { top: 1, center: 1, bottom: 1 },
    colFr: { left: 1, middle: 1, right: 1 },
  };
}

function cloneTree(spec: DockTreeSpec): DockTreeSpec {
  return JSON.parse(JSON.stringify(spec)) as DockTreeSpec;
}

function collectNodeIds(node: DockNode, out: string[]): void {
  if (node.type === 'leaf') {
    out.push(node.surfaceId);
    return;
  }
  for (const child of node.children) collectNodeIds(child, out);
}

function findLeafById(node: DockNode, surfaceId: string): DockNode | null {
  if (node.type === 'leaf') return node.surfaceId === surfaceId ? node : null;
  for (const child of node.children) {
    const found = findLeafById(child, surfaceId);
    if (found) return found;
  }
  return null;
}

function computeLocked(root: DockNode, target: DockNode, treeLocked: boolean): boolean {
  if (treeLocked) return true;
  function walk(node: DockNode, lockedSoFar: boolean): boolean | null {
    const locked = lockedSoFar || node.locked === true;
    if (node === target) return locked;
    if (node.type !== 'split') return null;
    for (const child of node.children) {
      const found = walk(child, locked);
      if (found != null) return found;
    }
    return null;
  }
  return walk(root, false) ?? false;
}

function subtreeHasLock(node: DockNode): boolean {
  if (node.locked === true) return true;
  if (node.type !== 'split') return false;
  return node.children.some(subtreeHasLock);
}

function surfaceIdOf(surface: HTMLElement): string | null {
  return surface.getAttribute('surface-id') || surface.getAttribute('data-s') || surface.id || null;
}

function placeSurfaceInline(surface: HTMLElement): void {
  surface.style.position = 'relative';
  surface.style.inset = 'auto';
  surface.style.display = 'flex';
  surface.style.flex = '1 1 auto';
  surface.style.minWidth = '0';
  surface.style.minHeight = '0';
}

function parkSurfaceInline(surface: HTMLElement): void {
  surface.style.removeProperty('position');
  surface.style.removeProperty('inset');
  surface.style.removeProperty('flex');
  surface.style.removeProperty('min-width');
  surface.style.removeProperty('min-height');
  surface.style.display = 'none';
}

function makeSplit(dir: 'row' | 'col', children: DockNode[]): SplitNode {
  return { type: 'split', dir, children, sizes: children.map(() => 1) };
}

function findParent(
  root: DockNode,
  node: DockNode,
  cb: (parent: SplitNode, index: number) => void
): void {
  if (root.type !== 'split') return;
  root.children.forEach((c, i) => {
    if (c === node) cb(root, i);
    else findParent(c, node, cb);
  });
}

function findImmediateParent(
  root: DockNode,
  node: DockNode
): { parent: SplitNode; index: number } | null {
  if (root.type !== 'split') return null;
  for (let i = 0; i < root.children.length; i++) {
    const child = root.children[i];
    if (child === node) return { parent: root, index: i };
    const nested = findImmediateParent(child, node);
    if (nested) return nested;
  }
  return null;
}

function normalize(node: DockNode | null): DockNode | null {
  if (!node) return null;
  if (node.type !== 'split') return node;
  node.children = node.children.map(normalize).filter((c): c is DockNode => c != null);
  const kids: DockNode[] = [];
  const sz: number[] = [];
  node.children.forEach((c, i) => {
    if (c.type === 'split' && c.dir === node.dir) {
      c.children.forEach((g, j) => {
        kids.push(g);
        sz.push((node.sizes[i] || 1) * (c.sizes[j] || 1));
      });
    } else {
      kids.push(c);
      sz.push(node.sizes[i] || 1);
    }
  });
  node.children = kids;
  node.sizes = sz;
  if (node.children.length === 0) return null;
  if (node.children.length === 1) return node.children[0];
  return node;
}

function zoneDetach(zones: Record<ZoneName, DockNode | null>, z: ZoneName, node: DockNode): void {
  const root = zones[z];
  if (!root) return;
  if (root === node) {
    zones[z] = null;
    return;
  }
  findParent(root, node, (p, i) => {
    p.children.splice(i, 1);
    p.sizes.splice(i, 1);
  });
  zones[z] = normalize(root);
}

function zoneReplace(
  zones: Record<ZoneName, DockNode | null>,
  z: ZoneName,
  oldNode: DockNode,
  newNode: DockNode
): void {
  if (zones[z] === oldNode) {
    zones[z] = newNode;
    return;
  }
  const root = zones[z];
  if (!root) return;
  findParent(root, oldNode, (p, i) => {
    p.children[i] = newNode;
  });
}

function weightForFraction(
  currentFr: number,
  allFr: readonly number[],
  fraction: number
): number | null {
  const sumOthers = allFr.reduce((sum, v) => sum + v, 0) - currentFr;
  if (sumOthers <= 0) return null;
  const f = Math.min(1 - MIN_FRACTION, Math.max(MIN_FRACTION, fraction));
  return (f * sumOthers) / (1 - f);
}

function regionForPoint(rect: DOMRect, x: number, y: number): DropRegion {
  const fx = (x - rect.left) / rect.width;
  const fy = (y - rect.top) / rect.height;
  if (fx > 0.34 && fx < 0.66 && fy > 0.34 && fy < 0.66) return 'center';
  const d: Record<'n' | 's' | 'w' | 'e', number> = { n: fy, s: 1 - fy, w: fx, e: 1 - fx };
  const entries = Object.entries(d) as Array<[DropRegion, number]>;
  entries.sort((a, b) => a[1] - b[1]);
  return entries[0][0];
}

function buildDivider(kind: 'h' | 'v'): HTMLElement {
  const divider = document.createElement('div');
  divider.className = `dock-tree__divider dock-tree__divider--${kind}`;
  return divider;
}

function buildRootEl(): HTMLDivElement {
  const el = document.createElement('div');
  el.className = 'dock-tree__root';
  return el;
}

function buildParkingEl(): HTMLDivElement {
  const el = document.createElement('div');
  el.className = 'dock-tree__parking';
  el.hidden = true;
  return el;
}

function buildGhostEl(): HTMLDivElement {
  const el = document.createElement('div');
  el.className = 'dock-tree__ghost';
  return el;
}

function buildPreviewEl(): HTMLDivElement {
  const el = document.createElement('div');
  el.className = 'dock-tree__preview';
  return el;
}

export class SliccDockTree extends HTMLElement {
  static readonly observedAttributes = ['tiles-movable'];

  #tree: DockTreeSpec = emptyTree();
  #dragging = false;
  #connected = false;

  #pinned = new Set<string>();

  #drag: DragState | null = null;

  #dropTarget: DropTarget | null = null;

  readonly #tileNodeMap = new WeakMap<HTMLElement, DockNode>();

  #prevPlaced: ReadonlySet<string> = new Set();

  readonly #root: HTMLDivElement = buildRootEl();

  readonly #parking: HTMLDivElement = buildParkingEl();

  readonly #ghost: HTMLDivElement = buildGhostEl();

  readonly #preview: HTMLDivElement = buildPreviewEl();

  readonly #childObserver = new MutationObserver(() => this.#render());

  connectedCallback(): void {
    ensureDockTreeStyle(this.ownerDocument);
    this.#connected = true;
    if (this.#root.parentElement !== this) this.append(this.#root);
    if (this.#parking.parentElement !== this) this.append(this.#parking);
    if (this.#ghost.parentElement !== this) this.append(this.#ghost);
    if (this.#preview.parentElement !== this) this.append(this.#preview);
    this.#render();
    this.#childObserver.observe(this, { childList: true });
  }

  disconnectedCallback(): void {
    this.#connected = false;
    this.#childObserver.disconnect();
    this.#cancelDrag();
  }

  attributeChangedCallback(name: string, oldValue: string | null, newValue: string | null): void {
    if (name !== 'tiles-movable' || oldValue === newValue || !this.#connected) return;
    if (!this.tilesMovable) this.#cancelDrag();
    this.#render();
  }

  get tilesMovable(): boolean {
    const value = this.getAttribute('tiles-movable');
    return value !== null && !isFalseString(value);
  }

  set tilesMovable(value: boolean) {
    this.toggleAttribute('tiles-movable', Boolean(value) && !isFalseString(value));
  }

  setTree(spec: DockTreeSpec | null): void {
    this.#tree = spec ? cloneTree(spec) : emptyTree();
    if (this.#connected) this.#render();
  }

  getTree(): DockTreeSpec {
    return cloneTree(this.#tree);
  }

  setPinned(surfaceIds: string[]): void {
    this.#pinned = new Set(surfaceIds);
  }

  getSurfaceIds(): string[] {
    const ids: string[] = [];
    for (const zone of ZONE_NAMES) {
      const node = this.#tree.zones[zone];
      if (node) collectNodeIds(node, ids);
    }
    return ids;
  }

  #show(zone: ZoneName): boolean {
    return this.#tree.zones[zone] != null || this.#dragging;
  }

  #isLockedNode(node: DockNode, zone: ZoneName): boolean {
    const root = this.#tree.zones[zone];
    if (!root) return false;
    return computeLocked(root, node, this.#tree.locked === true);
  }

  #zoneBlocksResize(zone: ZoneName): boolean {
    if (this.#tree.locked === true) return true;
    const root = this.#tree.zones[zone];
    return root != null && subtreeHasLock(root);
  }

  #blockBlocksResize(key: 'top' | 'center' | 'bottom'): boolean {
    if (this.#tree.locked === true) return true;
    if (key === 'center') return CENTER_ZONES.some((z) => this.#zoneBlocksResize(z));
    return this.#zoneBlocksResize(key);
  }

  placeSurface(surfaceId: string, zone: ZoneName): void {
    if (this.getSurfaceIds().includes(surfaceId)) return;
    const newLeaf: DockNode = { type: 'leaf', surfaceId };
    const existing = this.#tree.zones[zone];
    this.#tree.zones[zone] =
      existing == null ? newLeaf : normalize(makeSplit('col', [existing, newLeaf]));
    if (this.#connected) this.#render();
    this.#emitChange();
  }

  removeSurface(surfaceId: string): void {
    if (this.#pinned.has(surfaceId)) return;
    for (const zone of ZONE_NAMES) {
      const root = this.#tree.zones[zone];
      if (!root) continue;
      const node = findLeafById(root, surfaceId);
      if (!node) continue;
      if (this.#isLockedNode(node, zone)) return;
      zoneDetach(this.#tree.zones, zone, node);
      if (this.#connected) this.#render();
      this.#emitChange();
      return;
    }
  }

  moveSurfaceToZone(surfaceId: string, zone: ZoneName): void {
    let found = false;
    for (const z of ZONE_NAMES) {
      const root = this.#tree.zones[z];
      if (!root) continue;
      const node = findLeafById(root, surfaceId);
      if (!node) continue;
      found = true;
      if (this.#isLockedNode(node, z)) return;
      if (z === zone && root === node) return;
      zoneDetach(this.#tree.zones, z, node);
      break;
    }
    if (!found) {
      this.placeSurface(surfaceId, zone);
      return;
    }
    const newLeaf: DockNode = { type: 'leaf', surfaceId };
    this.#tree.zones[zone] = newLeaf;
    if (this.#connected) this.#render();
    this.#emitChange();
  }

  setSurfaceSize(surfaceId: string, size: SurfaceSizeSpec): boolean {
    const axes = this.#sizeAxesFor(surfaceId);
    if (!axes) return false;

    const surfaceEl = this.#collectSurfacePool().get(surfaceId) ?? null;

    const rect = surfaceEl?.getBoundingClientRect() ?? null;
    const leafRect = surfaceEl?.closest('.dock-tree__leaf')?.getBoundingClientRect() ?? rect;

    let changed = false;
    if (axes.width && (size.widthPx != null || size.widthPercent != null)) {
      const inset = leafRect && rect ? Math.max(0, leafRect.width - rect.width) : 0;
      changed =
        this.#applyAxisSize(
          axes.width,
          size.widthPx == null ? undefined : size.widthPx + inset,
          size.widthPercent,
          leafRect?.width
        ) || changed;
    }
    if (axes.height && (size.heightPx != null || size.heightPercent != null)) {
      const inset = leafRect && rect ? Math.max(0, leafRect.height - rect.height) : 0;
      changed =
        this.#applyAxisSize(
          axes.height,
          size.heightPx == null ? undefined : size.heightPx + inset,
          size.heightPercent,
          leafRect?.height
        ) || changed;
    }

    if (changed) {
      this.#render();
      this.#emitResize();
    }
    return changed;
  }

  #sizeAxesFor(surfaceId: string): { width: SizeAxis | null; height: SizeAxis | null } | null {
    for (const zone of ZONE_NAMES) {
      const root = this.#tree.zones[zone];
      if (!root) continue;
      const node = findLeafById(root, surfaceId);
      if (!node) continue;
      if (this.#isLockedNode(node, zone)) return { width: null, height: null };

      const immediateParent = findImmediateParent(root, node);

      if (immediateParent) {
        const { parent, index } = immediateParent;
        const axis: SizeAxis = {
          currentFr: parent.sizes[index] ?? 1,
          groupFr: parent.sizes,
          apply: (v) => {
            parent.sizes[index] = v;
          },
        };
        return {
          width: parent.dir === 'row' ? axis : null,
          height: parent.dir === 'col' ? axis : null,
        };
      }

      const isCenterZone = zone === 'left' || zone === 'middle' || zone === 'right';
      let width: SizeAxis | null = null;
      if (isCenterZone) {
        const czone = zone as CenterZone;
        const keys = this.#colZoneKeys();
        width = {
          currentFr: this.#tree.colFr[czone],
          groupFr: keys.map((k) => this.#tree.colFr[k]),
          apply: (v) => {
            this.#tree.colFr[czone] = v;
          },
        };
      }
      const rowKey: 'top' | 'center' | 'bottom' = isCenterZone
        ? 'center'
        : (zone as 'top' | 'bottom');
      const rowKeys = this.#rowBlockKeys();
      const height: SizeAxis = {
        currentFr: this.#tree.rowFr[rowKey],
        groupFr: rowKeys.map((k) => this.#tree.rowFr[k]),
        apply: (v) => {
          this.#tree.rowFr[rowKey] = v;
        },
      };
      return { width, height };
    }
    return null;
  }

  #rowBlockKeys(): Array<'top' | 'center' | 'bottom'> {
    const keys: Array<'top' | 'center' | 'bottom'> = [];
    if (this.#show('top')) keys.push('top');
    if (CENTER_ZONES.some((z) => this.#show(z))) keys.push('center');
    if (this.#show('bottom')) keys.push('bottom');
    return keys;
  }

  #colZoneKeys(): CenterZone[] {
    return CENTER_ZONES.filter((z) => this.#show(z));
  }

  #applyAxisSize(
    axis: SizeAxis,
    px: number | undefined,
    percent: number | undefined,
    renderedPx: number | undefined
  ): boolean {
    let fraction: number | null = null;
    if (percent != null) {
      fraction = percent / 100;
    } else if (px != null && renderedPx != null && renderedPx > 0 && axis.currentFr > 0) {
      const sumGroup = axis.groupFr.reduce((s, v) => s + v, 0);
      const span = (renderedPx * sumGroup) / axis.currentFr;
      if (span > 0) fraction = px / span;
    }
    if (fraction == null) return false;
    const newFr = weightForFraction(axis.currentFr, axis.groupFr, fraction);
    if (newFr == null) return false;
    axis.apply(newFr);
    return true;
  }

  #render(): void {
    withFocusPreserved(this, () => this.#rebuild());
  }

  #rebuild(): void {
    const tree = this.#tree;
    const pool = this.#collectSurfacePool();
    const usedIds = new Set(this.getSurfaceIds());

    const centerRow = this.#renderCenterRow(tree, pool);
    const blocks: Array<{ key: 'top' | 'center' | 'bottom'; el: HTMLElement }> = [];
    if (this.#show('top')) {
      const topEl = this.#renderZone('top', pool);
      topEl.style.flex = `${tree.rowFr.top} 1 0`;
      blocks.push({ key: 'top', el: topEl });
    }
    if (centerRow) blocks.push({ key: 'center', el: centerRow });
    if (this.#show('bottom')) {
      const bottomEl = this.#renderZone('bottom', pool);
      bottomEl.style.flex = `${tree.rowFr.bottom} 1 0`;
      blocks.push({ key: 'bottom', el: bottomEl });
    }

    const rootChildren: HTMLElement[] = [];
    blocks.forEach((block, i) => {
      rootChildren.push(block.el);
      if (
        i < blocks.length - 1 &&
        !this.#blockBlocksResize(block.key) &&
        !this.#blockBlocksResize(blocks[i + 1].key)
      ) {
        rootChildren.push(
          this.#buildSkeletonDivider(
            'v',
            block.key,
            blocks[i + 1].key,
            this.#root,
            tree.rowFr as unknown as Record<string, number>,
            ROW_KEYS
          )
        );
      }
    });
    this.#root.replaceChildren(...rootChildren);

    for (const [id, surfaceEl] of pool) {
      if (usedIds.has(id)) continue;
      parkSurfaceInline(surfaceEl);
      if (surfaceEl.parentElement !== this.#parking) this.#parking.appendChild(surfaceEl);
    }

    this.#prevPlaced = usedIds;

    this.dispatchEvent(
      new CustomEvent<{ placed: string[] }>('dock-tree-render', {
        detail: { placed: [...usedIds] },
        bubbles: true,
        composed: true,
      })
    );
  }

  #renderCenterRow(tree: DockTreeSpec, pool: Map<string, HTMLElement>): HTMLElement | null {
    const centerZones = CENTER_ZONES.filter((zone) => this.#show(zone));
    if (centerZones.length === 0) return null;
    const centerEl = document.createElement('div');
    centerEl.className = 'dock-tree__row';
    centerEl.style.flex = `${tree.rowFr.center} 1 0`;
    centerZones.forEach((zone, i) => {
      const zoneEl = this.#renderZone(zone, pool);
      zoneEl.style.flex = `${tree.colFr[zone]} 1 0`;
      centerEl.appendChild(zoneEl);
      if (
        i < centerZones.length - 1 &&
        !this.#zoneBlocksResize(zone) &&
        !this.#zoneBlocksResize(centerZones[i + 1])
      ) {
        centerEl.appendChild(
          this.#buildSkeletonDivider(
            'h',
            zone,
            centerZones[i + 1],
            centerEl,
            tree.colFr as unknown as Record<string, number>,
            CENTER_ZONES
          )
        );
      }
    });
    return centerEl;
  }

  #renderZone(zone: ZoneName, pool: Map<string, HTMLElement>): HTMLElement {
    const el = document.createElement('div');
    el.className = 'dock-tree__zone';
    if (this.#dragging) el.classList.add('dock-tree__zone--droppable');
    el.dataset.zone = zone;
    const node = this.#tree.zones[zone];
    if (node == null) {
      const empty = document.createElement('div');
      empty.className = 'dock-tree__empty';
      empty.textContent = `${zone} (drop here)`;
      el.appendChild(empty);
      return el;
    }
    const rendered = this.#renderNode(node, pool, zone);
    rendered.style.flex = '1 1 0';
    el.appendChild(rendered);
    return el;
  }

  #renderNode(node: DockNode, pool: Map<string, HTMLElement>, zone: ZoneName): HTMLElement {
    if (node.type === 'leaf') {
      const leafEl = document.createElement('div');
      leafEl.className = 'dock-tree__leaf';
      const surfaceEl = pool.get(node.surfaceId);
      if (surfaceEl) {
        leafEl.appendChild(this.#buildTile(node, zone, node.surfaceId, surfaceEl));
      }
      return leafEl;
    }
    const splitEl = document.createElement('div');
    splitEl.className = `dock-tree__split dock-tree__split--${node.dir}`;
    const splitLocked = this.#tree.locked === true || node.locked === true;
    node.children.forEach((child, i) => {
      const childEl = this.#renderNode(child, pool, zone);
      childEl.style.flex = `${node.sizes[i] ?? 1} 1 0`;
      splitEl.appendChild(childEl);
      if (i < node.children.length - 1 && !splitLocked) {
        splitEl.appendChild(this.#buildNodeDivider(node, i, splitEl));
      }
    });
    return splitEl;
  }

  #buildTile(
    node: DockNode,
    zone: ZoneName,
    surfaceId: string,
    surfaceEl: HTMLElement
  ): HTMLElement {
    const tile = document.createElement('div');
    tile.className = 'dock-tree__tile';

    if (surfaceId !== CHAT_SURFACE_ID) {
      tile.classList.add('dock-tree__tile--chrome');
      if (surfaceId === TERM_SURFACE_ID) tile.classList.add('dock-tree__tile--chrome-dark');
      if (!this.#prevPlaced.has(surfaceId)) tile.classList.add('dock-tree__tile--enter');
    }
    if (this.tilesMovable && !this.#isLockedNode(node, zone)) {
      const label = labelForSurface(surfaceId);
      const move = document.createElement('button');
      move.type = 'button';
      move.className = 'dock-tree__tile-move';
      move.setAttribute('aria-label', `Move ${label}`);
      move.title = label;
      move.appendChild(iconEl('grip-vertical', { size: 13 }));
      move.addEventListener('pointerdown', (e) => this.#startDrag(e as PointerEvent, node, zone));
      tile.appendChild(move);
    }
    const body = document.createElement('div');
    body.className = 'dock-tree__tile-body';
    placeSurfaceInline(surfaceEl);
    body.appendChild(surfaceEl);
    tile.appendChild(body);
    this.#tileNodeMap.set(tile, node);
    return tile;
  }

  #buildSkeletonDivider(
    kind: 'h' | 'v',
    a: string,
    b: string,
    container: HTMLElement,
    fr: Record<string, number>,
    allKeys: readonly string[]
  ): HTMLElement {
    const divider = buildDivider(kind);
    this.#wireResize(
      divider,
      kind === 'h',
      container,
      () => fr[a] ?? 1,
      () => fr[b] ?? 1,
      (va, vb) => {
        fr[a] = va;
        fr[b] = vb;
      },
      () => allKeys.reduce((sum, key) => sum + (fr[key] ?? 1), 0)
    );
    return divider;
  }

  #buildNodeDivider(node: SplitNode, i: number, container: HTMLElement): HTMLElement {
    const horiz = node.dir === 'row';
    const divider = buildDivider(horiz ? 'h' : 'v');
    this.#wireResize(
      divider,
      horiz,
      container,
      () => node.sizes[i] ?? 1,
      () => node.sizes[i + 1] ?? 1,
      (va, vb) => {
        node.sizes[i] = va;
        node.sizes[i + 1] = vb;
      },
      () => node.sizes.reduce((sum, v) => sum + (v ?? 1), 0)
    );
    return divider;
  }

  #wireResize(
    divider: HTMLElement,
    horiz: boolean,
    container: HTMLElement,
    getA: () => number,
    getB: () => number,
    setPair: (a: number, b: number) => void,
    sumFr: () => number
  ): void {
    divider.addEventListener('pointerdown', (e: PointerEvent) => {
      e.preventDefault();

      this.setPointerCapture(e.pointerId);
      const rect = container.getBoundingClientRect();
      const total = getA() + getB();
      const min = total * MIN_FRACTION;
      const sum = sumFr();
      const span = horiz ? rect.width : rect.height;
      const start = horiz ? e.clientX : e.clientY;
      const s0 = getA();

      const move = (ev: PointerEvent) => {
        const pos = horiz ? ev.clientX : ev.clientY;
        const delta = span > 0 ? ((pos - start) / span) * sum : 0;
        const v = Math.max(min, Math.min(total - min, s0 + delta));
        setPair(v, total - v);
        this.#render();
      };
      const end = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', end);
        window.removeEventListener('pointercancel', end);
        if (this.hasPointerCapture(e.pointerId)) this.releasePointerCapture(e.pointerId);
        this.#emitResize();
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', end);
      window.addEventListener('pointercancel', end);
    });
  }

  #emitResize(): void {
    this.dispatchEvent(
      new CustomEvent('dock-tree-resize', {
        detail: { tree: this.getTree() },
        bubbles: true,
        composed: true,
      })
    );
  }

  #startDrag(e: PointerEvent, node: DockNode, fromZone: ZoneName): void {
    if (!this.tilesMovable || this.#isLockedNode(node, fromZone)) return;
    e.preventDefault();
    this.#beginDrag(
      { kind: 'internal', node, fromZone },
      node.type === 'leaf' ? node.surfaceId : 'panel'
    );
    this.#moveGhost(e);
  }

  beginExternalDrag(surfaceId: string, pointerId?: number): void {
    void pointerId;
    if (!this.tilesMovable) return;
    this.#beginDrag({ kind: 'external', surfaceId }, surfaceId);
  }

  #beginDrag(drag: DragState, ghostLabel: string): void {
    this.#drag = drag;
    this.#dropTarget = null;
    this.#dragging = true;
    this.#render();
    this.#ghost.textContent = ghostLabel;
    this.#ghost.classList.add('dock-tree__ghost--active');
    window.addEventListener('pointermove', this.#onDragMove);
    window.addEventListener('pointerup', this.#onDragUp);
  }

  #moveGhost(e: PointerEvent): void {
    this.#ghost.style.left = `${e.clientX}px`;
    this.#ghost.style.top = `${e.clientY}px`;
  }

  #onDragMove = (e: PointerEvent): void => {
    this.#moveGhost(e);
    this.#dropTarget = null;
    this.#preview.classList.remove('dock-tree__preview--active');
    for (const hot of Array.from(this.querySelectorAll('.dock-tree__zone--hot'))) {
      hot.classList.remove('dock-tree__zone--hot');
    }
    const drag = this.#drag;
    if (!drag) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el) return;
    const zoneEl = el.closest('.dock-tree__zone');
    if (!(zoneEl instanceof HTMLElement)) return;
    const zone = zoneEl.dataset.zone as ZoneName | undefined;
    if (!zone) return;
    zoneEl.classList.add('dock-tree__zone--hot');

    const tileEl = el.closest('.dock-tree__tile');
    const tileNode = tileEl instanceof HTMLElement ? this.#tileNodeMap.get(tileEl) : undefined;
    const isDraggedTile = drag.kind === 'internal' && tileNode === drag.node;
    const isLockedTarget = !!tileNode && this.#isLockedNode(tileNode, zone);
    if (tileEl instanceof HTMLElement && tileNode && !isDraggedTile && !isLockedTarget) {
      const rect = tileEl.getBoundingClientRect();
      const region = regionForPoint(rect, e.clientX, e.clientY);
      this.#dropTarget = { zone, leaf: tileNode, region };
      this.#showTilePreview(rect, region);
    } else if (!tileEl) {
      this.#dropTarget = { zone, empty: true };
      this.#showRectPreview(zoneEl.getBoundingClientRect());
    }
  };

  #showTilePreview(rect: DOMRect, region: DropRegion): void {
    let { left, top, width, height } = rect;
    if (region === 'n') {
      height = rect.height / 2;
    } else if (region === 's') {
      top = rect.top + rect.height / 2;
      height = rect.height / 2;
    } else if (region === 'w') {
      width = rect.width / 2;
    } else if (region === 'e') {
      left = rect.left + rect.width / 2;
      width = rect.width / 2;
    }
    this.#showRectPreview(new DOMRect(left, top, width, height));
  }

  #showRectPreview(rect: DOMRect): void {
    this.#preview.style.left = `${rect.left}px`;
    this.#preview.style.top = `${rect.top}px`;
    this.#preview.style.width = `${rect.width}px`;
    this.#preview.style.height = `${rect.height}px`;
    this.#preview.classList.add('dock-tree__preview--active');
  }

  #onDragUp = (): void => {
    window.removeEventListener('pointermove', this.#onDragMove);
    window.removeEventListener('pointerup', this.#onDragUp);
    this.#ghost.classList.remove('dock-tree__ghost--active');
    this.#preview.classList.remove('dock-tree__preview--active');
    for (const hot of Array.from(this.querySelectorAll('.dock-tree__zone--hot'))) {
      hot.classList.remove('dock-tree__zone--hot');
    }

    const target = this.#dropTarget;
    const drag = this.#drag;
    this.#dropTarget = null;
    this.#drag = null;
    this.#dragging = false;

    const selfDrop =
      !!drag && drag.kind === 'internal' && !!target && !target.empty && target.leaf === drag.node;
    const duplicateExternalDrop =
      !!drag && drag.kind === 'external' && this.getSurfaceIds().includes(drag.surfaceId);
    if (!drag || !target || selfDrop || duplicateExternalDrop) {
      this.#render();
      return;
    }

    let placedNode: DockNode;
    if (drag.kind === 'internal') {
      zoneDetach(this.#tree.zones, drag.fromZone, drag.node);
      placedNode = drag.node;
    } else {
      placedNode = { type: 'leaf', surfaceId: drag.surfaceId };
    }

    if (target.empty || this.#tree.zones[target.zone] == null) {
      this.#tree.zones[target.zone] = placedNode;
    } else {
      const { region, leaf: targetLeaf } = target;
      const dir: 'row' | 'col' = region === 'e' || region === 'w' ? 'row' : 'col';
      const before = region === 'n' || region === 'w';
      const newSplit = makeSplit(dir, before ? [placedNode, targetLeaf] : [targetLeaf, placedNode]);
      zoneReplace(this.#tree.zones, target.zone, targetLeaf, newSplit);
      this.#tree.zones[target.zone] = normalize(this.#tree.zones[target.zone]);
    }

    this.#render();
    this.#emitChange();
  };

  #cancelDrag(): void {
    if (!this.#drag) return;
    window.removeEventListener('pointermove', this.#onDragMove);
    window.removeEventListener('pointerup', this.#onDragUp);
    this.#drag = null;
    this.#dropTarget = null;
    this.#dragging = false;
    this.#ghost.classList.remove('dock-tree__ghost--active');
    this.#preview.classList.remove('dock-tree__preview--active');
  }

  #emitChange(): void {
    this.dispatchEvent(
      new CustomEvent('dock-tree-change', {
        detail: { tree: this.getTree() },
        bubbles: true,
        composed: true,
      })
    );
  }

  #collectSurfacePool(): Map<string, HTMLElement> {
    const pool = new Map<string, HTMLElement>();
    for (const el of Array.from(this.querySelectorAll(SURFACE_TAG))) {
      if (!(el instanceof HTMLElement)) continue;
      if (el.parentElement?.closest(SURFACE_TAG)) continue;
      const id = surfaceIdOf(el);
      if (id) pool.set(id, el);
    }
    return pool;
  }
}

define('slicc-dock-tree', SliccDockTree);

declare global {
  interface HTMLElementTagNameMap {
    'slicc-dock-tree': SliccDockTree;
  }
}
