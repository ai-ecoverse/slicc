/**
 * Layout document schema — the serializable description of a SLICC arrangement,
 * plus the pure functions that resolve one for a given viewport.
 *
 * DOM-free on purpose: this module is the unit-test seam and is imported by the
 * webapp's kernel-worker-side `layout` command (which has no DOM) as well as by
 * the rendering component. Nothing here touches `document`.
 *
 * ## Two layers: fixed chrome, then five zones
 *
 *   - `docks[]` — the FIXED CHROME pinned to an edge at an exact size: the
 *     scoop/budget strip on top, the sessions rail left, the tool rail right.
 *     Not resizable, not rearrangeable; visible or not. A dock is what a zone-only
 *     model cannot express, since fr fractions have no way to say "44px".
 *   - `zones` — the WORKING AREA the docks leave over, as five named regions in
 *     the sense of Java's `BorderLayout`: `top`/`left`/`center`/`right`/`bottom`.
 *     Because the zones live inside what the docks did not take, `top` is below
 *     the scoop strip and `left`/`right` are inboard of the rails — the chrome and
 *     the zones can never overlap.
 *   - `floating[]` — panels painted above the docked ones without reflowing them.
 *
 * The zones replaced a recursive split tree. The tree could express arrangements
 * the zones cannot, but not ones a user could aim at: rearranging meant picking one
 * of five positions relative to some particular panel, multiplied by every panel on
 * screen. With five named zones a drag has five destinations, full stop. `center`
 * takes whatever the edge zones leave, so an arrangement cannot end up with a gap.
 */

import type { PanelAnchor, PanelPresentation, PanelSize } from './panel-meta.js';

/** Current schema version. Bump only for a genuinely breaking document change. */
export const LAYOUT_SCHEMA_VERSION = 1;

/** The four edges a dock can pin to. */
export type DockEdge = 'top' | 'right' | 'bottom' | 'left';

/** Split direction: `row` lays children side by side, `col` stacks them. */
export type SplitDirection = 'row' | 'col';

/** One docked strip: an edge, a thickness, and the panels inside it (in order). */
export interface DockSpec {
  edge: DockEdge;
  /** Thickness along the edge's axis (`"44px"`, `"10%"`, `2`). Omitted → panels' own preference. */
  size?: PanelSize;
  /** Panel ids in this dock, laid out along the edge. */
  panels: string[];
  /** Blocks user resize/move of this dock and everything in it. */
  locked?: boolean;
}

/**
 * The five zones of the working area, in the sense Java's `BorderLayout` uses:
 * four edges around one filling center.
 *
 * These sit INSIDE the fixed chrome, never overlapping it — `top` is below the
 * scoop/budget strip, `left` is right of the sessions rail, `right` is left of the
 * tool rail. The docks own the chrome; the zones own everything the docks leave.
 */
export type ZoneName = 'top' | 'left' | 'center' | 'right' | 'bottom';

/** Every zone, in the order a renderer should lay them out. */
export const ZONE_NAMES: readonly ZoneName[] = ['top', 'left', 'center', 'right', 'bottom'];

/**
 * The working area as five zones, each holding zero or more panels.
 *
 * Deliberately FLAT — this replaced a recursive split tree whose expressiveness
 * bought nothing a user could aim at: dragging meant choosing one of five
 * positions relative to some specific panel, times every panel on screen. Five
 * fixed named zones is the whole vocabulary, so a drag has exactly five
 * destinations no matter how much is open.
 *
 * A zone holds ANY NUMBER of panels, laid out along its `axis` — so two panels can
 * sit side by side in `left`, or stacked, and the user picks which. Simplicity here
 * is about the vocabulary of DESTINATIONS (five), not about capacity.
 */
export interface ZonesSpec {
  top?: string[];
  left?: string[];
  center?: string[];
  right?: string[];
  bottom?: string[];
  /**
   * How each zone lays its panels out: `row` side by side, `col` stacked.
   * Defaults suit each zone's shape — the wide bands (`top`/`bottom`) run in a row,
   * the tall ones (`left`/`right`/`center`) stack.
   */
  axes?: Partial<Record<ZoneName, SplitDirection>>;
  /** Thickness of the edge zones; `center` always takes the remainder. */
  sizes?: Partial<Record<ZoneName, PanelSize>>;
  /** Zones the user may not move panels into or out of, or resize. */
  locked?: ZoneName[];
}

/** How a zone lays out its panels when the document doesn't say. */
export const DEFAULT_ZONE_AXIS: Record<ZoneName, SplitDirection> = {
  top: 'row',
  bottom: 'row',
  left: 'col',
  right: 'col',
  center: 'col',
};

/** A zone's layout axis: its own setting, else the default for that zone. */
export function zoneAxis(zones: ZonesSpec, zone: ZoneName): SplitDirection {
  return zones.axes?.[zone] ?? DEFAULT_ZONE_AXIS[zone];
}

/**
 * A node in the legacy center tree: one panel, or a split of child nodes.
 *
 * Superseded by {@link ZonesSpec}. Still rendered so documents saved before the
 * zone model — including anything a skill shipped — keep working; nothing writes
 * this shape anymore.
 */
export type CenterNode =
  | { panel: string; size?: PanelSize; locked?: boolean }
  | {
      split: SplitDirection;
      children: CenterNode[];
      /** Relative or absolute size per child; index-aligned with `children`. */
      sizes?: PanelSize[];
      locked?: boolean;
    };

/** A panel painted above the docked layout without reflowing it. */
export interface FloatingSpec {
  panel: string;
  anchor?: PanelAnchor;
  width?: PanelSize;
  height?: PanelSize;
  locked?: boolean;
}

/** Per-panel overrides applied on top of whatever the arrangement says. */
export interface PanelOverride {
  visible?: boolean;
  movable?: boolean;
  resizable?: boolean;
  hideable?: boolean;
  locked?: boolean;
  presentation?: PanelPresentation;
  size?: PanelSize;
}

/** One arrangement: the docks (fixed chrome), the five zones, and any floating panels. */
export interface Arrangement {
  docks?: DockSpec[];
  /** The five-zone working area — what a document should use. */
  zones?: ZonesSpec | null;
  /** Legacy recursive center tree; rendered when `zones` is absent. */
  center?: CenterNode | null;
  floating?: FloatingSpec[];
}

/**
 * Conditions selecting a variant. All present predicates must hold (AND).
 * Viewport bounds are inclusive.
 */
export interface VariantCondition {
  minWidth?: number;
  maxWidth?: number;
  minHeight?: number;
  maxHeight?: number;
  orientation?: 'portrait' | 'landscape';
  /** Float the layout is running in. */
  platform?: 'web' | 'extension' | 'electron';
}

/** A conditional override of the base arrangement. */
export interface LayoutVariant extends Arrangement {
  when: VariantCondition;
  panels?: Record<string, PanelOverride>;
}

/** A complete, serializable layout document. */
export interface LayoutDocument {
  version: number;
  id: string;
  title?: string;
  /**
   * Tree-wide runtime lock. Blocks the USER from moving/resizing/closing
   * anything — what a Cherry embedder sets. Unrelated to the sudo gating that
   * restricts the AGENT; see `docs/panel-system-design.md`.
   */
  locked?: boolean;
  base: Arrangement;
  panels?: Record<string, PanelOverride>;
  variants?: LayoutVariant[];
}

/** The environment a layout is resolved against. */
export interface LayoutEnvironment {
  width: number;
  height: number;
  platform?: VariantCondition['platform'];
}

/** A document resolved for one environment: a single flat arrangement. */
export interface ResolvedLayout {
  id: string;
  locked: boolean;
  docks: DockSpec[];
  zones: ZonesSpec | null;
  center: CenterNode | null;
  floating: FloatingSpec[];
  panels: Record<string, PanelOverride>;
  /** Indices of the variants that matched, in application order. Diagnostics. */
  appliedVariants: number[];
}

/** An empty document — the `setLayout(null)` / initial-mount default. */
export function emptyLayout(id = 'empty'): LayoutDocument {
  return { version: LAYOUT_SCHEMA_VERSION, id, base: {} };
}

/** Deep-clone through JSON so a caller can't mutate the engine's internal state. */
export function cloneLayout<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Whether a center node is a split (vs. a single panel). */
export function isSplitNode(
  node: CenterNode
): node is Extract<CenterNode, { split: SplitDirection }> {
  return 'split' in node;
}

/** Whether a variant's condition holds in `env`. */
export function variantMatches(when: VariantCondition, env: LayoutEnvironment): boolean {
  if (when.minWidth != null && env.width < when.minWidth) return false;
  if (when.maxWidth != null && env.width > when.maxWidth) return false;
  if (when.minHeight != null && env.height < when.minHeight) return false;
  if (when.maxHeight != null && env.height > when.maxHeight) return false;
  if (when.orientation != null) {
    const actual = env.width >= env.height ? 'landscape' : 'portrait';
    if (actual !== when.orientation) return false;
  }
  // An unset `platform` in the ENV matches any platform predicate — callers that
  // don't know their float shouldn't lose every platform-keyed variant.
  if (when.platform != null && env.platform != null && when.platform !== env.platform) {
    return false;
  }
  return true;
}

/**
 * Collect every panel id a resolved layout places, in document order (docks
 * first by edge order, then the center tree depth-first, then floating).
 * Duplicates are dropped — a panel can only be in one place.
 */
export function layoutPanelIds(layout: ResolvedLayout): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  const push = (id: string): void => {
    if (seen.has(id)) return;
    seen.add(id);
    ids.push(id);
  };
  for (const dock of layout.docks) for (const id of dock.panels) push(id);
  if (layout.zones) {
    for (const zone of ZONE_NAMES) for (const id of layout.zones[zone] ?? []) push(id);
  } else if (layout.center) {
    walkCenter(layout.center, (node) => push(node.panel));
  }
  for (const f of layout.floating) push(f.panel);
  return ids;
}

/** Which zone holds `panelId`, or `null` when no zone does. */
export function zoneOfPanel(zones: ZonesSpec, panelId: string): ZoneName | null {
  for (const zone of ZONE_NAMES) {
    if ((zones[zone] ?? []).includes(panelId)) return zone;
  }
  return null;
}

/**
 * Move `panelId` into `zone`, removing it from whichever zone holds it now.
 *
 * Returns a new spec; the original is untouched, so a rejected move is a returned
 * value rather than a half-applied edit. A move into the zone it already occupies
 * is a no-op — including its position within that zone, since the zones carry no
 * ordering the user can currently express.
 */
export function moveToZone(zones: ZonesSpec, panelId: string, zone: ZoneName): ZonesSpec {
  if (zoneOfPanel(zones, panelId) === zone) return zones;
  const next: ZonesSpec = cloneLayout(zones);
  for (const name of ZONE_NAMES) {
    const list = next[name];
    if (list) next[name] = list.filter((id) => id !== panelId);
  }
  next[zone] = [...(next[zone] ?? []), panelId];
  return next;
}

/** Remove `panelId` from every zone. */
export function removeFromZones(zones: ZonesSpec, panelId: string): ZonesSpec {
  const next: ZonesSpec = cloneLayout(zones);
  for (const name of ZONE_NAMES) {
    const list = next[name];
    if (list) next[name] = list.filter((id) => id !== panelId);
  }
  return next;
}

/**
 * Convert a legacy center tree into zones, so an old document still renders.
 *
 * Everything lands in `center`: the tree's geometry has no faithful five-zone
 * equivalent, and inventing one would silently rearrange a saved layout. Landing it
 * all in the center is honest — the panels are all still there, in one region the
 * user can then redistribute.
 */
export function zonesFromCenter(center: CenterNode | null): ZonesSpec {
  const ids: string[] = [];
  if (center) walkCenter(center, (leaf) => ids.push(leaf.panel));
  return { center: ids };
}

/** Visit every leaf (panel) node in a center tree, depth-first. */
export function walkCenter(
  node: CenterNode,
  visit: (leaf: Extract<CenterNode, { panel: string }>) => void
): void {
  if (!isSplitNode(node)) {
    visit(node);
    return;
  }
  for (const child of node.children) walkCenter(child, visit);
}

/**
 * Resolve a document for an environment: start from `base`, apply every matching
 * variant in declaration order, then flatten.
 *
 * Variants replace whole sections rather than deep-merging into them. A variant
 * that supplies `center` replaces the center outright; one that omits it leaves
 * the previous value. This is deliberate — deep-merging two recursive split trees
 * has no intuitive semantics (what does merging a 2-child row into a 3-child col
 * mean?), whereas "the narrow layout declares its own center" is obvious to
 * author and to read. `panels` overrides DO merge per panel id, since those are
 * flat key/value and merging them is unambiguous.
 */
export function resolveLayout(doc: LayoutDocument, env: LayoutEnvironment): ResolvedLayout {
  const resolved: ResolvedLayout = {
    id: doc.id,
    locked: doc.locked === true,
    docks: cloneLayout(doc.base.docks ?? []),
    zones: cloneLayout(doc.base.zones ?? null),
    center: cloneLayout(doc.base.center ?? null),
    floating: cloneLayout(doc.base.floating ?? []),
    panels: cloneLayout(doc.panels ?? {}),
    appliedVariants: [],
  };

  (doc.variants ?? []).forEach((variant, index) => {
    if (!variantMatches(variant.when, env)) return;
    resolved.appliedVariants.push(index);
    if (variant.docks !== undefined) resolved.docks = cloneLayout(variant.docks);
    if (variant.zones !== undefined) resolved.zones = cloneLayout(variant.zones);
    if (variant.center !== undefined) resolved.center = cloneLayout(variant.center);
    if (variant.floating !== undefined) resolved.floating = cloneLayout(variant.floating);
    for (const [id, override] of Object.entries(variant.panels ?? {})) {
      resolved.panels[id] = { ...resolved.panels[id], ...override };
    }
  });

  return resolved;
}

/**
 * Whether a panel is effectively locked: the tree-wide flag, its own override,
 * or an enclosing dock/split. Inherited DOWN — locking a dock locks its panels,
 * locking one panel never affects a sibling.
 */
export function isPanelLocked(layout: ResolvedLayout, panelId: string): boolean {
  if (layout.locked) return true;
  if (layout.panels[panelId]?.locked === true) return true;

  for (const dock of layout.docks) {
    if (dock.panels.includes(panelId)) return dock.locked === true;
  }
  for (const f of layout.floating) {
    if (f.panel === panelId) return f.locked === true;
  }
  if (layout.zones) {
    const zone = zoneOfPanel(layout.zones, panelId);
    return zone ? (layout.zones.locked ?? []).includes(zone) : false;
  }
  return layout.center ? isLockedInCenter(layout.center, panelId, false) : false;
}

function isLockedInCenter(node: CenterNode, panelId: string, inherited: boolean): boolean {
  const locked = inherited || node.locked === true;
  if (!isSplitNode(node)) return node.panel === panelId ? locked : false;
  return node.children.some((child) => isLockedInCenter(child, panelId, locked));
}

/**
 * Coerce a `PanelSize` into a CSS `flex` shorthand for a layout slot.
 *
 * A bare number or `"<n>fr"` is a flex GROW factor with a zero basis — that is
 * what makes proportional splits resize predictably (the dock-tree relies on the
 * same trick, see its `weightForFraction`). A `px`/`%`/other CSS length becomes a
 * fixed BASIS that neither grows nor shrinks, which is how a 44px rail keeps its
 * width. `undefined` grows to fill.
 */
export function sizeToFlex(size: PanelSize | undefined): string {
  if (size == null) return '1 1 auto';
  if (typeof size === 'number') return `${size} 1 0`;
  const trimmed = size.trim();
  const fr = /^([\d.]+)fr$/.exec(trimmed);
  if (fr) return `${fr[1]} 1 0`;
  if (/^[\d.]+$/.test(trimmed)) return `${trimmed} 1 0`;
  return `0 0 ${trimmed}`;
}

/**
 * Validate a parsed JSON value as a layout document, returning either the typed
 * document or a human-readable reason.
 *
 * Deliberately shallow: it checks the shape the engine dereferences (version, id,
 * a `base` object, well-formed dock/center nodes) and NOT every optional field,
 * because an unknown panel id or an odd size string must degrade at render time
 * rather than reject the whole document. A layout that is 90% loadable should
 * load — the alternative is a skill-shipped layout failing wholesale over one
 * typo in one panel.
 */
export function parseLayoutDocument(value: unknown): LayoutDocument | { error: string } {
  if (!value || typeof value !== 'object') return { error: 'layout must be an object' };
  const doc = value as Partial<LayoutDocument>;
  if (typeof doc.id !== 'string' || doc.id.trim() === '') {
    return { error: 'layout.id must be a non-empty string' };
  }
  if (typeof doc.version !== 'number') return { error: 'layout.version must be a number' };
  if (doc.version > LAYOUT_SCHEMA_VERSION) {
    return {
      error: `layout.version ${doc.version} is newer than supported (${LAYOUT_SCHEMA_VERSION})`,
    };
  }
  if (!doc.base || typeof doc.base !== 'object') return { error: 'layout.base must be an object' };

  for (const dock of doc.base.docks ?? []) {
    if (!isDockEdge(dock?.edge)) return { error: `invalid dock edge: ${String(dock?.edge)}` };
    if (!Array.isArray(dock.panels)) return { error: `dock.${dock.edge}.panels must be an array` };
  }
  if (doc.base.center != null) {
    const centerError = validateCenter(doc.base.center);
    if (centerError) return { error: centerError };
  }
  return doc as LayoutDocument;
}

function isDockEdge(value: unknown): value is DockEdge {
  return value === 'top' || value === 'right' || value === 'bottom' || value === 'left';
}

/** Returns an error string, or `null` when the subtree is well-formed. */
function validateCenter(node: unknown): string | null {
  if (!node || typeof node !== 'object') return 'center node must be an object';
  const candidate = node as { panel?: unknown; split?: unknown; children?: unknown };
  if (typeof candidate.panel === 'string') return null;
  if (candidate.split !== 'row' && candidate.split !== 'col') {
    return 'center node needs a `panel` string or a `split` of "row"/"col"';
  }
  if (!Array.isArray(candidate.children) || candidate.children.length === 0) {
    return 'a split node needs a non-empty `children` array';
  }
  for (const child of candidate.children) {
    const childError = validateCenter(child);
    if (childError) return childError;
  }
  return null;
}
