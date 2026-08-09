import { define } from '../internal/define.js';
import { iconEl } from '../internal/icons.js';

/**
 * Scoped, document-level stylesheet for `<slicc-dock-tree>`. Light-DOM hosts
 * cannot carry an inline `<style>` in a shadow root, so the chrome is injected
 * once into the host document (idempotent) and selected by the host tag.
 *
 * Lifted faithfully from the validated prototype
 * (`docs/superpowers/specs/2026-07-03-dock-editor-prototype.html`): a fixed
 * flex column of `[top?, center-row?, bottom?]`, where the center row is a
 * flex row of `[left?, middle?, right?]`. Each shown zone hosts a recursive
 * `.dock-tree__split` tree (`row`/`col`) down to `.dock-tree__leaf` containers,
 * each holding a `.dock-tree__tile` (when the opt-in `tiles-movable` gate
 * resolves true, an unlocked leaf gets a hover-revealed
 * `.dock-tree__tile-move` corner button over the actual `<slicc-surface>`
 * content; the gate defaults off, and a locked leaf always renders none).
 * An empty zone renders as
 * a dashed `.dock-tree__empty` placeholder instead (only reachable while
 * `#dragging`). `.dock-tree__parking` is the offstage home for surfaces not
 * currently placed by the tree — hidden via the native `hidden` attribute (JS
 * also drives the surface's own inline `display`, see `parkSurfaceInline`).
 */
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
}
.dark slicc-dock-tree .dock-tree__tile--chrome,
[data-theme="dark"] slicc-dock-tree .dock-tree__tile--chrome {
  box-shadow:
    rgba(0, 0, 0, 0.45) 0 14px 36px -12px,
    rgba(0, 0, 0, 0.3) 0 4px 10px -4px;
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

/** Inject the scoped dock-tree stylesheet into a document once (idempotent). */
function ensureDockTreeStyle(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLE;
  (doc.head ?? doc.documentElement).appendChild(style);
}

/** Tag the host treats as a surface panel. */
const SURFACE_TAG = 'slicc-surface';

/** The reserved surfaceId for the chat panel — always pinned by the webapp. */
export const CHAT_SURFACE_ID = 'chat';

/** Prefix stripped from a sprinkle's surfaceId when deriving its friendly tile label. */
const SPRINKLE_PREFIX = 'sprinkle:';

/** Whether an attribute/property input is the explicit false string. */
function isFalseString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().toLowerCase() === 'false';
}

/**
 * Derive a friendly tile-handle label from a raw `surfaceId`: the reserved
 * `chat` id shows as `"Chat"`; a `sprinkle:<name>` id shows as `<name>`
 * (leading prefix stripped); anything else passes through unchanged. Pure and
 * unit-testable — purely cosmetic, no effect on drag/drop or identity.
 */
export function labelForSurface(surfaceId: string): string {
  if (surfaceId === CHAT_SURFACE_ID) return 'Chat';
  if (surfaceId.startsWith(SPRINKLE_PREFIX)) return surfaceId.slice(SPRINKLE_PREFIX.length);
  return surfaceId;
}

/**
 * A leaf pane (one surface) or a split of children laid out row/col with
 * relative sizes. `locked` (either variant) blocks drag, resize, and removal
 * for this node AND everything nested under it — see `#isLockedNode`.
 */
export type DockNode =
  | { type: 'leaf'; surfaceId: string; locked?: boolean }
  | { type: 'split'; dir: 'row' | 'col'; children: DockNode[]; sizes: number[]; locked?: boolean };

/** Narrowed alias for a `split` `DockNode`, used by in-zone divider resize wiring. */
type SplitNode = Extract<DockNode, { type: 'split' }>;

/** The five fixed dock zones. */
export type ZoneName = 'top' | 'left' | 'middle' | 'right' | 'bottom';

/** Where a drop lands relative to the target leaf's tile: an edge, or its center. */
export type DropRegion = 'n' | 's' | 'e' | 'w' | 'center';

/** The drop target resolved under the cursor during a drag: an empty zone, or an edge/center of a hovered leaf. */
type DropTarget =
  | { zone: ZoneName; empty: true }
  | { zone: ZoneName; empty?: false; leaf: DockNode; region: DropRegion };

/**
 * The in-flight drag's payload: `'internal'` carries the actual `DockNode`
 * being moved plus the zone it was picked up from (so it can be detached on
 * drop); `'external'` (a drag that started outside the component, e.g. a
 * dock-rail launcher) carries only the `surfaceId` a brand-new leaf will be
 * built for on drop — there is no existing node to detach.
 */
type DragState =
  | { kind: 'internal'; node: DockNode; fromZone: ZoneName }
  | { kind: 'external'; surfaceId: string };

/**
 * One resizable axis's current fr-weight group, resolved for a specific
 * leaf: `currentFr` is that leaf's own weight, `groupFr` is every weight in
 * the group (its own included, in whatever order — only the sum and the
 * target's own value matter), and `apply` writes a new weight for the leaf
 * back into the tree. See `SliccDockTree#sizeAxesFor`.
 */
interface SizeAxis {
  currentFr: number;
  groupFr: readonly number[];
  apply(newFr: number): void;
}

/**
 * The serializable (plain-JSON, no DOM refs) layout tree for
 * `<slicc-dock-tree>`. Tree-wide `locked` is sugar for "every leaf is
 * locked" — it ORs into every lock check rather than being tracked
 * separately, so it can never disagree with a per-node `locked` flag. Used
 * by embedders (e.g. Cherry) to push a fixed, unmovable arrangement.
 */
export interface DockTreeSpec {
  zones: Record<ZoneName, DockNode | null>;
  rowFr: { top: number; center: number; bottom: number };
  colFr: { left: number; middle: number; right: number };
  locked?: boolean;
}

/**
 * A `setSurfaceSize` target size, in raw pixels or as a percent (0–100) of
 * the affected axis's current sibling group. Structural mirror in the
 * webapp's `wc-sprinkles.ts` (`SurfaceSizeSpecLike`) — keep in sync. If both
 * a `Px` and `Percent` value are given for the same axis, `Percent` wins.
 */
export interface SurfaceSizeSpec {
  widthPx?: number;
  widthPercent?: number;
  heightPx?: number;
  heightPercent?: number;
}

/** Zones in skeleton order (top/bottom flank the left/middle/right center row). */
const ZONE_NAMES: readonly ZoneName[] = ['top', 'left', 'middle', 'right', 'bottom'];

/** The three zones that make up the center row. */
type CenterZone = 'left' | 'middle' | 'right';
const CENTER_ZONES: readonly CenterZone[] = ['left', 'middle', 'right'];

/** All `rowFr` keys — the sum term for skeleton row-divider resize math (top/center/bottom). */
const ROW_KEYS: readonly ('top' | 'center' | 'bottom')[] = ['top', 'center', 'bottom'];

/**
 * The floor/ceiling every resize path — manual divider drag AND
 * `setSurfaceSize` — clamps to: a pane can never shrink below (or grow
 * above) this fraction of whatever it's being sized against. Shared by both
 * so dragging by hand can always reach whatever a programmatic
 * `layout size --height 2%` can, and vice versa; previously the drag path
 * clamped to an ABSOLUTE fr amount (0.2/0.15) instead of a fraction, which
 * silently became a much higher (or lower) percentage than 2% depending on
 * the pair's current combined weight — the drag could refuse to go as low
 * as a `setSurfaceSize` call just had.
 */
const MIN_FRACTION = 0.02;

/** A brand-new, all-empty tree (the `setTree(null)` / initial-mount default). */
function emptyTree(): DockTreeSpec {
  return {
    zones: { top: null, left: null, middle: null, right: null, bottom: null },
    rowFr: { top: 1, center: 1, bottom: 1 },
    colFr: { left: 1, middle: 1, right: 1 },
  };
}

/** Deep-clone a spec through JSON so callers can't mutate the host's internal tree. */
function cloneTree(spec: DockTreeSpec): DockTreeSpec {
  return JSON.parse(JSON.stringify(spec)) as DockTreeSpec;
}

/** Collect every leaf `surfaceId` under `node`, depth-first, into `out`. */
function collectNodeIds(node: DockNode, out: string[]): void {
  if (node.type === 'leaf') {
    out.push(node.surfaceId);
    return;
  }
  for (const child of node.children) collectNodeIds(child, out);
}

/** Depth-first search for the leaf `DockNode` matching `surfaceId` under `node`, or `null`. */
function findLeafById(node: DockNode, surfaceId: string): DockNode | null {
  if (node.type === 'leaf') return node.surfaceId === surfaceId ? node : null;
  for (const child of node.children) {
    const found = findLeafById(child, surfaceId);
    if (found) return found;
  }
  return null;
}

/**
 * Whether `target` is locked, walking down from `root` (a zone's tree) and
 * OR-ing `target.locked` with every ancestor split's `locked` along the way
 * — locking a split locks everything nested under it, but locking a leaf
 * never affects its siblings. `treeLocked` (the tree-wide flag) ORs in
 * unconditionally, before any walk. Returns `false` if `target` isn't found
 * under `root` (defensive; callers always pass a node that is).
 */
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

/**
 * Whether `node` or anything nested under it is locked — used to decide
 * whether a divider adjacent to `node` may resize at all. A parent's
 * resize would change every descendant's absolute size even though relative
 * `sizes`/`fr` stay put, so any lock anywhere inside blocks the divider, not
 * just a lock on `node` itself.
 */
function subtreeHasLock(node: DockNode): boolean {
  if (node.locked === true) return true;
  if (node.type !== 'split') return false;
  return node.children.some(subtreeHasLock);
}

/** A surface's identity: `surface-id` (its canonical attribute), then `data-s`, then a plain `id`. */
function surfaceIdOf(surface: HTMLElement): string | null {
  return surface.getAttribute('surface-id') || surface.getAttribute('data-s') || surface.id || null;
}

/**
 * Pull a placed surface in-flow inside its `.dock-tree__leaf` container,
 * overriding `<slicc-surface>`'s own default `position:absolute; inset:0;
 * display:none` (built for the show-one workbench-body stack, not a
 * side-by-side dock tree).
 */
function placeSurfaceInline(surface: HTMLElement): void {
  surface.style.position = 'relative';
  surface.style.inset = 'auto';
  surface.style.display = 'flex';
  surface.style.flex = '1 1 auto';
  surface.style.minWidth = '0';
  surface.style.minHeight = '0';
}

/** Undo `placeSurfaceInline` and hide a surface that fell out of the tree. */
function parkSurfaceInline(surface: HTMLElement): void {
  surface.style.removeProperty('position');
  surface.style.removeProperty('inset');
  surface.style.removeProperty('flex');
  surface.style.removeProperty('min-width');
  surface.style.removeProperty('min-height');
  surface.style.display = 'none';
}

/** Build a new `split` node with an equal (`1`) weight per child — the drag-drop insertion shape. */
function makeSplit(dir: 'row' | 'col', children: DockNode[]): SplitNode {
  return { type: 'split', dir, children, sizes: children.map(() => 1) };
}

/**
 * Walk `root` (a zone's tree) looking for `node` among any `split`'s direct
 * children; when found, invoke `cb(parent, index)`. Ported verbatim from the
 * prototype's `findParent` (identity search, not structural equality).
 */
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

/**
 * Same search as `findParent`, but returns the result instead of invoking a
 * callback — used where the result feeds straight into a value (avoids a
 * `let` reassigned from inside a closure, which TS's control-flow narrowing
 * can't track back to a plain truthy check at the call site).
 */
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

/**
 * Recursively flatten same-direction nested splits, unwrap a single-child
 * split into its child, and drop a split down to `null` once it has no
 * children left. Ported verbatim from the prototype's `normalize` (mutates
 * `node` in place and returns the possibly-different root reference).
 */
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

/**
 * Detach `node` from zone `z`'s tree (the whole zone if `node` IS the root,
 * otherwise splice it out of its parent split) and normalize what remains.
 * Ported verbatim from the prototype's `zoneDetach`.
 */
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

/**
 * Replace `oldNode` with `newNode` inside zone `z`'s tree (the zone root
 * itself, or a parent split's child slot). Ported verbatim from the
 * prototype's `zoneReplace`.
 */
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

/**
 * The new weight for one entry among a group of fr weights (`allFr`,
 * `currentFr` included) so it ends up occupying `fraction` (0–1) of the
 * group's rendered total, holding every OTHER entry's weight — and
 * therefore their relative proportions to each other — exactly fixed. Every
 * flex context in this component uses `flex-basis: 0`, so an entry's
 * rendered pixel share is `fr / sum(allFr)`; solving that for the new fr
 * given a target fraction yields `fraction * sumOthers / (1 - fraction)`.
 * Returns `null` when there's no other entry to redistribute into (nothing
 * else rendered to size against).
 */
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

/**
 * Classify a point against a target rect: the inner 34–66% box in both axes
 * is `'center'`; otherwise the nearest edge (`n`/`s`/`w`/`e`). Ported
 * verbatim from the prototype's `regionForPoint`.
 */
function regionForPoint(rect: DOMRect, x: number, y: number): DropRegion {
  const fx = (x - rect.left) / rect.width;
  const fy = (y - rect.top) / rect.height;
  if (fx > 0.34 && fx < 0.66 && fy > 0.34 && fy < 0.66) return 'center';
  const d: Record<'n' | 's' | 'w' | 'e', number> = { n: fy, s: 1 - fy, w: fx, e: 1 - fx };
  const entries = Object.entries(d) as Array<[DropRegion, number]>;
  entries.sort((a, b) => a[1] - b[1]);
  return entries[0][0];
}

/**
 * Build one skeleton/in-zone divider element. `kind` picks the cursor/axis:
 * `'h'` is a vertical bar that drags horizontally (col-resize, for row splits
 * and left/middle/right skeleton seams); `'v'` is a horizontal bar that drags
 * vertically (row-resize, for col splits and top/center/bottom skeleton
 * seams). Pointer wiring is attached separately by the caller
 * (`#buildSkeletonDivider` / `#buildNodeDivider`) once it knows which two
 * adjacent fr values the divider controls.
 */
function buildDivider(kind: 'h' | 'v'): HTMLElement {
  const divider = document.createElement('div');
  divider.className = `dock-tree__divider dock-tree__divider--${kind}`;
  return divider;
}

/** Build the `#root` skeleton container (the tree render target). */
function buildRootEl(): HTMLDivElement {
  const el = document.createElement('div');
  el.className = 'dock-tree__root';
  return el;
}

/** Build the `#parking` container — the offstage home for unmatched surfaces. */
function buildParkingEl(): HTMLDivElement {
  const el = document.createElement('div');
  el.className = 'dock-tree__parking';
  el.hidden = true;
  return el;
}

/** Build the floating drag ghost — a small label that tracks the cursor while dragging. */
function buildGhostEl(): HTMLDivElement {
  const el = document.createElement('div');
  el.className = 'dock-tree__ghost';
  return el;
}

/** Build the drop-region preview overlay — highlights the sub-region a drop would land in. */
function buildPreviewEl(): HTMLDivElement {
  const el = document.createElement('div');
  el.className = 'dock-tree__preview';
  return el;
}

/**
 * `<slicc-dock-tree>` — the fixed 5-zone (top/left/middle/right/bottom)
 * drag-drop dock layout editor, ported from the validated prototype
 * (`docs/superpowers/specs/2026-07-03-dock-editor-prototype.html`): the data
 * model + recursive renderer, collapse-when-empty behavior, pointer-driven
 * divider resize, and the internal drag-drop interaction itself.
 *
 * Light DOM (no shadow root): the host never owns surface content.
 * `<slicc-surface>` children are matched to tree leaves by identity
 * (`surface-id`, falling back
 * to `data-s`, falling back to a plain `id`) and moved (not cloned) into their
 * leaf's `.dock-tree__leaf` container; surfaces with no matching leaf are
 * parked offstage (`display:none`).
 *
 * A zone whose node is `null` collapses entirely — no space, no divider — in
 * normal rendering. The private `#dragging` flag flips to `true` for the
 * duration of an internal drag (see below), making empty zones reappear as
 * drop-target placeholders.
 *
 * Every skeleton divider (between shown top/center/bottom blocks, and between
 * shown left/middle/right zones in the center row) and every in-zone split
 * divider (between a split's children) is pointer-drag-resizable: dragging
 * moves fr weight between the two adjacent slots (`rowFr`/`colFr` entries or
 * a split's `sizes` entries), clamped to a minimum, and re-renders on each
 * `pointermove`. `getTree()` — already the full serialization contract —
 * carries the updated sizes; on `pointerup` the host also fires
 * `dock-tree-resize` (composed + bubbling, `detail: { tree }`) so a listener
 * (e.g. the webapp) can persist without the component touching storage
 * itself.
 *
 * **Internal drag-drop** (the opt-in core interaction): when `tilesMovable`
 * is true, every unlocked leaf renders inside a `.dock-tree__tile` with a
 * `.dock-tree__tile-move` corner button — hidden until the tile is hovered,
 * then fades in over its top-left corner
 * (`title`/`aria-label` carry a friendly form of the surfaceId — see
 * `labelForSurface`) above a `.dock-tree__tile-body` holding the
 * `<slicc-surface>`. A `pointerdown` on that button starts a drag: `#dragging`
 * flips `true` (re-rendering empty zones as live drop placeholders) and a
 * floating ghost label tracks the cursor. On `pointermove`,
 * `document.elementFromPoint` resolves the zone/tile under the cursor;
 * hovering a tile computes a `DropRegion` (ported `regionForPoint`: an inner
 * center box, else the nearest edge) and previews that sub-region; hovering
 * an empty zone placeholder previews the whole zone. On drop, the dragged
 * leaf is detached from its source zone (ported `zoneDetach` + `normalize` —
 * an emptied zone collapses to `null`) and inserted at the target: an empty
 * zone becomes the leaf outright; an edge target `split`s the target leaf
 * (`n`/`s` → `col`, `e`/`w` → `row`, `center` → `col`-stack; `n`/`w` insert
 * `before`), via the ported `zoneReplace` + `normalize`. The host then
 * re-renders (`#dragging=false`, empty zones collapse again) and fires
 * `dock-tree-change` (composed + bubbling, `detail: { tree }`). Dropping on
 * the dragged tile itself, or nowhere valid, cancels cleanly with no event.
 * Drag listeners live on `window` (not the tile), and drag state lives in
 * instance fields, because `#render()` rebuilds the tile DOM mid-interaction
 * (e.g. drag start itself re-renders to reveal placeholders). Every rendered
 * zone also gets a `dock-tree__zone--droppable` outline for the duration of
 * ANY drag (internal or external) — a "you can drop anywhere" affordance —
 * layered under the per-hover `--hot` highlight.
 *
 * **External drag-drop**: when `tilesMovable` is true,
 * `beginExternalDrag(surfaceId)` lets a drag that STARTED outside the
 * component (e.g. dragging a dock-rail launcher chip in the webapp) enter the
 * exact same drag state machine — `#onDragMove` /
 * `#onDragUp` are shared verbatim with internal drags. The only difference
 * is the payload: an external drag carries just a `surfaceId` (no existing
 * `DockNode`/source zone), so `#onDragUp` builds a brand-new leaf for it
 * instead of detaching one. A dropped external leaf composes its
 * `<slicc-surface>` on the next render once the webapp mounts it as a
 * light-DOM child (Task 1's pool/`MutationObserver` behavior) — the leaf's
 * slot simply renders empty until then.
 *
 * **Programmatic placement API**: `placeSurface(surfaceId, zone)` places a
 * surface with no drag gesture at all (e.g. the webapp opening a sprinkle) —
 * an empty zone becomes `leaf(surfaceId)`, a non-empty one gets it appended
 * as a `col` split; it's a no-op if `surfaceId` is already anywhere in the
 * tree. `removeSurface(surfaceId)` is its inverse (e.g. a sprinkle closing):
 * detaches the leaf from wherever it sits, normalizing/collapsing an emptied
 * zone; a no-op if absent. Both mutate through the same `zoneDetach` /
 * `normalize` machinery as drag-drop and fire `dock-tree-change` when they
 * actually change the tree.
 *
 * **Programmatic sizing API**: `setSurfaceSize(surfaceId, size)` resizes the
 * leaf holding `surfaceId` to an exact width/height, in pixels or as a
 * percent (0–100) of the space its current sibling group renders into — the
 * agent-facing counterpart to dragging a divider by hand (see
 * `#sizeAxesFor`/`#applyAxisSize`). Only the axis(es) that leaf actually has
 * a lever for are honored (e.g. a top/bottom zone root has no width lever —
 * it always spans full width); every other sibling in the affected group
 * keeps its own weight, so only the targeted leaf's share changes. No-ops
 * when `surfaceId` isn't placed, is `locked`, or the axis has nothing to
 * size against (a lone shown block).
 *
 * @attr tiles-movable - boolean opt-in for internal/external tile drag; absent or `"false"` is off, empty is on; reflected by `tilesMovable`
 * @slot - default; `<slicc-surface>` children, matched into the tree by id
 * @fires dock-tree-change - composed + bubbling; `detail: { tree: DockTreeSpec }`; fired after a drag-drop (internal or external), `placeSurface`, or `removeSurface` mutates the tree
 * @fires dock-tree-resize - composed + bubbling; `detail: { tree: DockTreeSpec }`; fired on divider-drag pointerup, or `setSurfaceSize` actually changing a weight
 * @fires dock-tree-render - composed + bubbling; `detail: { placed: string[] }` (the placed surfaceIds); fired after EVERY render, `setTree` included — a display notification (drives `<slicc-shell>`'s chatpane `narrow` sync), never a persistence trigger
 */
export class SliccDockTree extends HTMLElement {
  static readonly observedAttributes = ['tiles-movable'];

  #tree: DockTreeSpec = emptyTree();
  #dragging = false;
  #connected = false;

  /**
   * SurfaceIds that can never be removed via `removeSurface` (e.g. `chat`
   * once it's dockable) — defense-in-depth so a caller mis-calling
   * `removeSurface` can't orphan a leaf the host depends on always having.
   * Dragging a pinned leaf still moves it normally; this only guards removal
   * (and is a hook for a future close/remove tile affordance — the dock-tree
   * doesn't render one today).
   */
  #pinned = new Set<string>();

  /** The in-flight drag's payload (internal leaf + source zone, or an external surfaceId), or `null` when idle. */
  #drag: DragState | null = null;

  /** The most recently computed drop target under the cursor, or `null` when none. */
  #dropTarget: DropTarget | null = null;

  /** Maps a rendered `.dock-tree__tile` element back to the `DockNode` it displays (identity, current render only). */
  readonly #tileNodeMap = new WeakMap<HTMLElement, DockNode>();

  readonly #root: HTMLDivElement = buildRootEl();

  readonly #parking: HTMLDivElement = buildParkingEl();

  readonly #ghost: HTMLDivElement = buildGhostEl();

  readonly #preview: HTMLDivElement = buildPreviewEl();

  /**
   * A surface appended directly to the host AFTER `setTree` (e.g. a lazily
   * mounted panel) would otherwise sit unplaced forever — re-render whenever
   * the host's own child list changes. `#render` moves matched/unmatched
   * surfaces into `#root`/`#parking` respectively, which are themselves
   * stable direct children once mounted, so this settles rather than looping.
   */
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

  /** Whether internal and external tile drag is enabled; reflected to `tiles-movable`. Dormant in the shipped webapp — retained for embedders/tests. */
  get tilesMovable(): boolean {
    const value = this.getAttribute('tiles-movable');
    return value !== null && !isFalseString(value);
  }

  set tilesMovable(value: boolean) {
    this.toggleAttribute('tiles-movable', Boolean(value) && !isFalseString(value));
  }

  /** Set/replace the layout; `null` resets to an all-empty tree. */
  setTree(spec: DockTreeSpec | null): void {
    this.#tree = spec ? cloneTree(spec) : emptyTree();
    if (this.#connected) this.#render();
  }

  /** A JSON-safe deep clone of the current tree — the full serialization contract. */
  getTree(): DockTreeSpec {
    return cloneTree(this.#tree);
  }

  /**
   * Replace the set of pinned (non-closable) surfaceIds. A pinned leaf's
   * `removeSurface` call becomes a no-op; a pinned leaf still drags/moves
   * exactly like any other leaf. Does not re-render — pinning only affects
   * `removeSurface` and any future close-affordance rendering, neither of
   * which need a render on their own.
   */
  setPinned(surfaceIds: string[]): void {
    this.#pinned = new Set(surfaceIds);
  }

  /** Every leaf `surfaceId` currently in the tree, depth-first, zone by zone. */
  getSurfaceIds(): string[] {
    const ids: string[] = [];
    for (const zone of ZONE_NAMES) {
      const node = this.#tree.zones[zone];
      if (node) collectNodeIds(node, ids);
    }
    return ids;
  }

  /** Whether `zone` should render: non-empty, or dragging (placeholder mode). */
  #show(zone: ZoneName): boolean {
    return this.#tree.zones[zone] != null || this.#dragging;
  }

  /**
   * Whether `node` (found in `zone`) is locked — the tree-wide flag, or any
   * ancestor split's `locked`, or the node's own `locked`. See `computeLocked`.
   */
  #isLockedNode(node: DockNode, zone: ZoneName): boolean {
    const root = this.#tree.zones[zone];
    if (!root) return false;
    return computeLocked(root, node, this.#tree.locked === true);
  }

  /**
   * Whether a divider touching `zone` must not render/resize — the tree-wide
   * flag, or a lock anywhere in the zone's subtree. An empty zone (no root)
   * never blocks — there's nothing there to lock.
   */
  #zoneBlocksResize(zone: ZoneName): boolean {
    if (this.#tree.locked === true) return true;
    const root = this.#tree.zones[zone];
    return root != null && subtreeHasLock(root);
  }

  /**
   * Whether a skeleton divider touching row block `key` (`'top'`/`'bottom'`
   * are single zones; `'center'` is the left/middle/right row as a whole)
   * must not render/resize.
   */
  #blockBlocksResize(key: 'top' | 'center' | 'bottom'): boolean {
    if (this.#tree.locked === true) return true;
    if (key === 'center') return CENTER_ZONES.some((z) => this.#zoneBlocksResize(z));
    return this.#zoneBlocksResize(key);
  }

  /**
   * Programmatic placement (no drag): used by the webapp when a sprinkle
   * opens with no drag gesture in play. A no-op when `surfaceId` is already
   * anywhere in the tree (never duplicates). An empty `zone` becomes
   * `leaf(surfaceId)` outright; a non-empty zone gets the new leaf appended
   * as a `col` split alongside whatever was already there — routed through
   * `normalize` so appending onto an existing `col` split flattens into it
   * rather than nesting. Re-renders and fires `dock-tree-change` when it
   * actually mutates the tree.
   */
  placeSurface(surfaceId: string, zone: ZoneName): void {
    if (this.getSurfaceIds().includes(surfaceId)) return;
    const newLeaf: DockNode = { type: 'leaf', surfaceId };
    const existing = this.#tree.zones[zone];
    this.#tree.zones[zone] =
      existing == null ? newLeaf : normalize(makeSplit('col', [existing, newLeaf]));
    if (this.#connected) this.#render();
    this.#emitChange();
  }

  /**
   * Detach `surfaceId`'s leaf from wherever it sits in the tree (used by the
   * webapp when a sprinkle closes). Normalizes what remains — an emptied
   * zone collapses to `null` (via `zoneDetach`). A no-op (no render, no
   * event) when `surfaceId` isn't placed anywhere, OR when `surfaceId` is
   * pinned (see `setPinned`) — defense-in-depth so a pinned leaf (e.g. chat)
   * can never be orphaned even if a caller mis-calls remove. Also a no-op
   * when the leaf is `locked` — locking implies non-removable regardless of
   * pinned state.
   */
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

  /**
   * Move `surfaceId` to `zone` as that zone's sole leaf, detaching it from
   * wherever it currently sits first — including a pinned leaf (e.g. `chat`),
   * which `removeSurface` refuses to touch. `placeSurface`'s no-op-if-present
   * rule means the webapp can't compose a move from `removeSurface` +
   * `placeSurface` for a pinned id, so this is a first-class primitive
   * instead. A no-op when `surfaceId` is locked (locking blocks relocation
   * the same as drag) or already the sole occupant of `zone`. When
   * `surfaceId` isn't placed anywhere in the tree, falls through to
   * `placeSurface` rather than clobbering whatever `zone` already holds.
   */
  moveSurfaceToZone(surfaceId: string, zone: ZoneName): void {
    let found = false;
    for (const z of ZONE_NAMES) {
      const root = this.#tree.zones[z];
      if (!root) continue;
      const node = findLeafById(root, surfaceId);
      if (!node) continue;
      found = true;
      if (this.#isLockedNode(node, z)) return;
      if (z === zone && root === node) return; // already the zone's sole leaf
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

  /**
   * Resize the leaf holding `surfaceId` to an exact width and/or height —
   * see the class doc's "Programmatic sizing API" section. Returns whether
   * either axis actually changed anything (re-rendering and firing
   * `dock-tree-resize` only when it did).
   */
  setSurfaceSize(surfaceId: string, size: SurfaceSizeSpec): boolean {
    const axes = this.#sizeAxesFor(surfaceId);
    if (!axes) return false;

    const surfaceEl = this.#collectSurfacePool().get(surfaceId) ?? null;
    const rect = surfaceEl?.getBoundingClientRect() ?? null;

    let changed = false;
    if (axes.width && (size.widthPx != null || size.widthPercent != null)) {
      changed =
        this.#applyAxisSize(axes.width, size.widthPx, size.widthPercent, rect?.width) || changed;
    }
    if (axes.height && (size.heightPx != null || size.heightPercent != null)) {
      changed =
        this.#applyAxisSize(axes.height, size.heightPx, size.heightPercent, rect?.height) ||
        changed;
    }

    if (changed) {
      this.#render();
      this.#emitResize();
    }
    return changed;
  }

  /**
   * Resolve `surfaceId`'s width/height sizing levers. Returns `null` if
   * `surfaceId` isn't placed anywhere; `{ width: null, height: null }` if it
   * is placed but `locked`. Otherwise: a leaf directly inside a `split`
   * sizes against that split's `sizes[]` (width if `dir==='row'`, height if
   * `dir==='col'`, never both); a bare zone-root leaf sizes against the
   * skeleton `colFr`/`rowFr` weights instead — a center-zone (`left`/
   * `middle`/`right`) root's width comes from its own `colFr` entry, and its
   * "height" (there being no per-zone height in the skeleton) maps to
   * `rowFr.center`, the lever shared by the whole center row; a top/bottom
   * zone root has height only (`rowFr.top`/`rowFr.bottom`) — it always spans
   * full width, so there is no width lever at all.
   */
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

  /**
   * Row-block keys (`'top'`/`'center'`/`'bottom'`) currently rendered — the
   * group a skeleton row-height lever sizes against. `'center'` stands for
   * the whole left/middle/right row block.
   */
  #rowBlockKeys(): Array<'top' | 'center' | 'bottom'> {
    const keys: Array<'top' | 'center' | 'bottom'> = [];
    if (this.#show('top')) keys.push('top');
    if (CENTER_ZONES.some((z) => this.#show(z))) keys.push('center');
    if (this.#show('bottom')) keys.push('bottom');
    return keys;
  }

  /** Center-zone keys (`'left'`/`'middle'`/`'right'`) currently rendered — the group a skeleton column-width lever sizes against. */
  #colZoneKeys(): CenterZone[] {
    return CENTER_ZONES.filter((z) => this.#show(z));
  }

  /**
   * Resolve a `px`/`percent` target (percent wins if both given) into a
   * fraction of `axis`'s group and apply it via `weightForFraction`. A
   * `percent` target needs no measurement at all — it IS the fraction. A
   * `px` target self-calibrates off `renderedPx` (the leaf's own current
   * live size along this axis): `renderedPx` already reflects whatever the
   * browser's actual flex layout (gaps, dividers, everything) produced for
   * `axis.currentFr / sum(axis.groupFr)`, so inverting that ratio recovers
   * the group's live pixel span without re-deriving CSS geometry by hand.
   */
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

  /**
   * Rebuild `#root` from the current tree, moving matched `<slicc-surface>`
   * children into their leaf slots and parking the rest. Collects the surface
   * pool BEFORE tearing down the old skeleton so in-flight elements survive
   * the move regardless of where they currently sit (a prior leaf, parking,
   * or a fresh direct child of the host).
   */
  #render(): void {
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

    // Every render (setTree restore included — which deliberately does NOT
    // fire dock-tree-change, so persistence can't loop) announces what is
    // currently placed. `<slicc-shell>` keys the chatpane's `narrow` state off
    // this; it is a display notification, never a persistence trigger.
    this.dispatchEvent(
      new CustomEvent<{ placed: string[] }>('dock-tree-render', {
        detail: { placed: [...usedIds] },
        bubbles: true,
        composed: true,
      })
    );
  }

  /** Build the center row (`left`/`middle`/`right`), or `null` when none of them show. */
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

  /** Render one zone: its recursive node tree, or the dashed empty placeholder. */
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

  /** Recursively render a leaf (as a draggable `.dock-tree__tile` composing its `<slicc-surface>`) or a row/col split. */
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

  /**
   * Build a leaf's `.dock-tree__tile`: a `.dock-tree__tile-body` holding the
   * placed `<slicc-surface>`, plus — when `tilesMovable` is true and the leaf
   * is not locked — a `.dock-tree__tile-move` button that fades in only on
   * hover over the tile's top-left corner (see the CSS). Its `pointerdown`
   * starts the same internal drag a header used to. With the gate off, or for
   * a locked leaf, no move button renders at all (rather than a disabled one).
   * `node`/`zone` are captured by the button's drag-start closure and also
   * recorded in `#tileNodeMap` so `#onDragMove`/`#onDragUp` can map a tile
   * element found via `elementFromPoint` back to its `DockNode`.
   */
  #buildTile(
    node: DockNode,
    zone: ZoneName,
    surfaceId: string,
    surfaceEl: HTMLElement
  ): HTMLElement {
    const tile = document.createElement('div');
    tile.className = 'dock-tree__tile';
    // Tool tiles get the floating rounded pane chrome; the reserved chat
    // column renders flat (see the .dock-tree__tile--chrome CSS above).
    if (surfaceId !== CHAT_SURFACE_ID) tile.classList.add('dock-tree__tile--chrome');
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

  /**
   * Build one skeleton divider between blocks `a`/`b` (keys into `fr`, a
   * `rowFr`/`colFr` record) and wire its pointer-drag-to-resize behavior.
   * Ported from the prototype's `skeletonDivider`.
   */
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

  /**
   * Build one in-zone divider between `node.children[i]`/`[i + 1]` and wire
   * its pointer-drag-to-resize behavior against `node.sizes`. Ported from the
   * prototype's `nodeDivider`.
   */
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

  /**
   * Shared pointer-drag-to-resize wiring for both skeleton and in-zone
   * dividers: at `pointerdown`, snapshot the container's geometry and the
   * pair's combined total; on each `pointermove`, convert the pixel delta
   * along the divider's axis into an fr delta (scaled by `sumFr()`, the sum
   * across ALL siblings including hidden ones — matching the prototype so
   * ratios stay stable even for zones not currently shown), clamp each side
   * to `MIN_FRACTION` of the PAIR's own total (not `sumFr()` — a divider only
   * ever redistributes between its own two sides, so "how small can this
   * side go" is relative to just the two of them, same as `weightForFraction`
   * uses for `setSurfaceSize`), write the pair back via `setPair`, and
   * re-render; on `pointerup`, tear down the window listeners and emit
   * `dock-tree-resize`.
   */
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
      // Capture on the host, not `divider`: `move()` below calls `#render()`
      // on every pointermove, which rebuilds the dock-tree DOM (including this
      // very divider) via `replaceChildren`. A captured element that gets
      // removed from the DOM implicitly loses capture (spec behavior), which
      // dropped the drag back to ordinary hit-testing after the very first
      // move — the reported "resize never lets go" bug: with capture gone,
      // pointerup delivery becomes hit-test-dependent (an intervening render,
      // a fast drag, or the pointer straying off the (now-relocated) divider
      // can all fail to deliver it), leaving the window-level `move` listener
      // attached and firing on every subsequent mouse move, held or not. The
      // host element (`this`) is stable across every re-render, so capture
      // survives the whole drag and pointerup is always delivered.
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

  /** Fire `dock-tree-resize` (composed + bubbling) with the current tree — the webapp persists it. */
  #emitResize(): void {
    this.dispatchEvent(
      new CustomEvent('dock-tree-resize', {
        detail: { tree: this.getTree() },
        bubbles: true,
        composed: true,
      })
    );
  }

  /**
   * `pointerdown` on a tile's move button: enter drag mode. Ported from the
   * prototype's `startDrag`; shared with `beginExternalDrag` via `#beginDrag`.
   * Guarded against the opt-in gate and locked nodes as defense-in-depth — a
   * disabled or locked leaf renders no move button at all, but this keeps a
   * stale button reference or future programmatic entry point from bypassing
   * either restriction.
   */
  #startDrag(e: PointerEvent, node: DockNode, fromZone: ZoneName): void {
    if (!this.tilesMovable || this.#isLockedNode(node, fromZone)) return;
    e.preventDefault();
    this.#beginDrag(
      { kind: 'internal', node, fromZone },
      node.type === 'leaf' ? node.surfaceId : 'panel'
    );
    this.#moveGhost(e);
  }

  /**
   * Begin tracking a drag that STARTED outside the component — e.g. the
   * webapp dragging a dock-rail launcher chip onto the tree. A no-op unless
   * `tilesMovable` is true. When enabled, enters the same
   * drag mode as an internal tile drag (`#dragging=true`, empty zones reveal
   * as live drop placeholders, the ghost label tracks the cursor), reusing
   * `#onDragMove`/`#onDragUp` end to end via the shared `#beginDrag`. The
   * only difference from an internal drag materializes in `#onDragUp`, which
   * builds a brand-new leaf for `surfaceId` instead of detaching an existing
   * node — there's nothing to detach yet. `pointerId` is accepted for parity
   * with callers that also manage native pointer capture on their own
   * drag-source element; the component itself doesn't need it since its
   * pointermove/pointerup listeners live on `window`.
   */
  beginExternalDrag(surfaceId: string, pointerId?: number): void {
    void pointerId;
    if (!this.tilesMovable) return;
    this.#beginDrag({ kind: 'external', surfaceId }, surfaceId);
  }

  /**
   * Shared drag-start plumbing for both `#startDrag` (internal) and
   * `beginExternalDrag`: records the drag payload, flips `#dragging=true` and
   * re-renders (revealing empty zones as live drop placeholders via
   * `#show()`, and tagging every rendered zone `dock-tree__zone--droppable`),
   * arms the ghost label, and wires window-level pointermove/pointerup
   * listeners for the rest of the gesture. The caller positions the ghost
   * itself when it has an originating event (`#startDrag`) — an external
   * drag has none yet, so the ghost sits at its default position until the
   * first `pointermove`.
   */
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

  /** Reposition the floating ghost label to track the cursor. */
  #moveGhost(e: PointerEvent): void {
    this.#ghost.style.left = `${e.clientX}px`;
    this.#ghost.style.top = `${e.clientY}px`;
  }

  /**
   * `pointermove` while dragging: resolve the zone/tile under the cursor via
   * `document.elementFromPoint`, recompute `#dropTarget`, and show the
   * matching preview — a `DropRegion` sub-box of the hovered tile (ported
   * `showCardPreview`), or the whole zone rect when hovering an empty-zone
   * placeholder. Hovering nothing valid (no zone, or the dragged tile
   * itself) clears both. Ported from the prototype's `onMove`.
   */
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

  /** Preview the `DropRegion` sub-box of a hovered tile's rect. Ported from the prototype's `showCardPreview`. */
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

  /** Position + show the preview overlay over `rect`. */
  #showRectPreview(rect: DOMRect): void {
    this.#preview.style.left = `${rect.left}px`;
    this.#preview.style.top = `${rect.top}px`;
    this.#preview.style.width = `${rect.width}px`;
    this.#preview.style.height = `${rect.height}px`;
    this.#preview.classList.add('dock-tree__preview--active');
  }

  /**
   * `pointerup`: resolve the drop. No target (or dropped on the dragged tile
   * itself, internal-only) cancels cleanly — re-render, no event. An external
   * drag whose `surfaceId` is already docked somewhere also cancels cleanly
   * (same guard as `placeSurface`'s no-duplicate rule — reject rather than
   * "move", since that's ambiguous with the tree already holding the id).
   * Otherwise resolve the node to place: an internal drag detaches the
   * dragged leaf from its source zone first (`zoneDetach` + `normalize`); an
   * external drag builds a brand-new leaf for its `surfaceId` (nothing to
   * detach). Insert that node at the target (an empty zone becomes the leaf
   * outright; an edge target `split`s the target leaf via `zoneReplace` +
   * `normalize`), re-render, and fire `dock-tree-change`. Ported from the
   * prototype's `onUp`, extended to cover the external-drag payload.
   */
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

  /** Abandon an in-progress drag (e.g. on disconnect) without mutating the tree. */
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

  /**
   * Fire `dock-tree-change` (composed + bubbling) with the current tree.
   * Shared emitter for every tree-mutating path: internal drag-drop, external
   * drag-drop, `placeSurface`, and `removeSurface`.
   */
  #emitChange(): void {
    this.dispatchEvent(
      new CustomEvent('dock-tree-change', {
        detail: { tree: this.getTree() },
        bubbles: true,
        composed: true,
      })
    );
  }

  /**
   * Every COMPOSABLE `<slicc-surface>` descendant, keyed by identity, wherever
   * it currently sits. A `<slicc-surface>` nested inside another surface is
   * that surface's CONTENT, not a leaf the tree places on its own — pooling
   * nested surfaces would find them unused by any leaf and park+hide them out
   * of their owner (`#render`). Skip any surface with an ancestor surface so
   * only top-level surfaces are matched to leaves.
   */
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
