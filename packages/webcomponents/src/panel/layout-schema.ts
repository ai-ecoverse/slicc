import type { PanelAnchor, PanelPresentation, PanelSize } from './panel-meta.js';

export const LAYOUT_SCHEMA_VERSION = 1;

export type DockEdge = 'top' | 'right' | 'bottom' | 'left';

export type SplitDirection = 'row' | 'col';

export interface DockSpec {
  edge: DockEdge;

  size?: PanelSize;

  panels: string[];

  locked?: boolean;
}

export type ZoneName = 'top' | 'left' | 'center' | 'right' | 'bottom';

export const ZONE_NAMES: readonly ZoneName[] = ['top', 'left', 'center', 'right', 'bottom'];

export interface ZonesSpec {
  top?: string[];
  left?: string[];
  center?: string[];
  right?: string[];
  bottom?: string[];

  axes?: Partial<Record<ZoneName, SplitDirection>>;

  sizes?: Partial<Record<ZoneName, PanelSize>>;

  locked?: ZoneName[];
}

export const DEFAULT_ZONE_AXIS: Record<ZoneName, SplitDirection> = {
  top: 'row',
  bottom: 'row',
  left: 'col',
  right: 'col',
  center: 'col',
};

export function zoneAxis(zones: ZonesSpec, zone: ZoneName): SplitDirection {
  return zones.axes?.[zone] ?? DEFAULT_ZONE_AXIS[zone];
}

export type CenterNode =
  | { panel: string; size?: PanelSize; locked?: boolean }
  | {
      split: SplitDirection;
      children: CenterNode[];

      sizes?: PanelSize[];
      locked?: boolean;
    };

export interface FloatingSpec {
  panel: string;
  anchor?: PanelAnchor;
  width?: PanelSize;
  height?: PanelSize;
  locked?: boolean;
}

export interface PanelOverride {
  visible?: boolean;
  movable?: boolean;
  resizable?: boolean;
  hideable?: boolean;
  locked?: boolean;
  presentation?: PanelPresentation;
  size?: PanelSize;
}

export interface Arrangement {
  docks?: DockSpec[];

  zones?: ZonesSpec | null;

  center?: CenterNode | null;
  floating?: FloatingSpec[];
}

export interface VariantCondition {
  minWidth?: number;
  maxWidth?: number;
  minHeight?: number;
  maxHeight?: number;
  orientation?: 'portrait' | 'landscape';

  platform?: 'web' | 'extension' | 'electron';
}

export interface LayoutVariant extends Arrangement {
  when: VariantCondition;
  panels?: Record<string, PanelOverride>;
}

export interface LayoutDocument {
  version: number;
  id: string;
  title?: string;

  locked?: boolean;
  base: Arrangement;
  panels?: Record<string, PanelOverride>;
  variants?: LayoutVariant[];
}

export interface LayoutEnvironment {
  width: number;
  height: number;
  platform?: VariantCondition['platform'];
}

export interface ResolvedLayout {
  id: string;
  locked: boolean;
  docks: DockSpec[];
  zones: ZonesSpec | null;
  center: CenterNode | null;
  floating: FloatingSpec[];
  panels: Record<string, PanelOverride>;

  appliedVariants: number[];
}

export function emptyLayout(id = 'empty'): LayoutDocument {
  return { version: LAYOUT_SCHEMA_VERSION, id, base: {} };
}

export function cloneLayout<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function isSplitNode(
  node: CenterNode
): node is Extract<CenterNode, { split: SplitDirection }> {
  return 'split' in node;
}

export function variantMatches(when: VariantCondition, env: LayoutEnvironment): boolean {
  if (when.minWidth != null && env.width < when.minWidth) return false;
  if (when.maxWidth != null && env.width > when.maxWidth) return false;
  if (when.minHeight != null && env.height < when.minHeight) return false;
  if (when.maxHeight != null && env.height > when.maxHeight) return false;
  if (when.orientation != null) {
    const actual = env.width >= env.height ? 'landscape' : 'portrait';
    if (actual !== when.orientation) return false;
  }

  if (when.platform != null && env.platform != null && when.platform !== env.platform) {
    return false;
  }
  return true;
}

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

export function zoneOfPanel(zones: ZonesSpec, panelId: string): ZoneName | null {
  for (const zone of ZONE_NAMES) {
    if ((zones[zone] ?? []).includes(panelId)) return zone;
  }
  return null;
}

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

export function removeFromZones(zones: ZonesSpec, panelId: string): ZonesSpec {
  const next: ZonesSpec = cloneLayout(zones);
  for (const name of ZONE_NAMES) {
    const list = next[name];
    if (list) next[name] = list.filter((id) => id !== panelId);
  }
  return next;
}

export function zonesFromCenter(center: CenterNode | null): ZonesSpec {
  const ids: string[] = [];
  if (center) walkCenter(center, (leaf) => ids.push(leaf.panel));
  return { center: ids };
}

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

export function sizeToFlex(size: PanelSize | undefined): string {
  if (size == null) return '1 1 auto';
  if (typeof size === 'number') return `${size} 1 0`;
  const trimmed = size.trim();
  const fr = /^([\d.]+)fr$/.exec(trimmed);
  if (fr) return `${fr[1]} 1 0`;
  if (/^[\d.]+$/.test(trimmed)) return `${trimmed} 1 0`;
  return `0 0 ${trimmed}`;
}

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
