/**
 * Structural mirrors of `@slicc/webcomponents`' dock-tree types, plus the shipped
 * preset library.
 *
 * These live in `base/` rather than `ui/wc/` because the layer stack
 * (`base/fs → shell/git → cdp → tools → core → scoops → ui`) forbids lower layers
 * from importing up, and several of them need this data: the `layout` shell command
 * (`shell/`), skill frontmatter resolution (`scoops/`), and the panel-RPC contract
 * (`kernel/`). All of it is plain JSON with no DOM reference, so `ui/` was never the
 * right home — it just happened to be where the rendering code lived. `base/` (not
 * `core/`) so `shell/` reaches it without a back-edge.
 *
 * The types are REDECLARED rather than imported from `@slicc/webcomponents` so this
 * module carries no runtime dependency on that package: webapp tests run in
 * Node/jsdom without the component library, stubbing the dock-tree with fakes.
 */

/** The five fixed dock-tree zones — mirrors the library's `ZoneName`. */
export type DockZoneName = 'top' | 'left' | 'middle' | 'right' | 'bottom';

/** Mirrors the library's `DockTreeSpec` — plain JSON, no DOM refs. */
export interface DockTreeSpecLike {
  zones: Record<DockZoneName, unknown>;
  rowFr: { top: number; center: number; bottom: number };
  colFr: { left: number; middle: number; right: number };
}

/**
 * Mirrors the library's `SurfaceSizeSpec` — a `setSurfaceSize` target size, in raw
 * pixels or as a percent (0-100) of the affected axis's current sibling group.
 * `Percent` wins if both are given for the same axis.
 */
export interface SurfaceSizeSpecLike {
  widthPx?: number;
  widthPercent?: number;
  heightPx?: number;
  heightPercent?: number;
}

/** A leaf pane (one surface) or a directional split of children with relative sizes. */
export type DockNodeLike =
  | { type: 'leaf'; surfaceId: string; locked?: boolean }
  | {
      type: 'split';
      dir: 'row' | 'col';
      children: DockNodeLike[];
      sizes: number[];
      locked?: boolean;
    };

/** A named, ready-to-apply dock-tree shape — the `layout set <name>` menu. */
export interface NamedDockTreeSpec {
  name: string;
  tree: DockTreeSpecLike;
}

export const DEFAULT_LAYOUT = 'focus';

const CHAT_LEAF: DockNodeLike = { type: 'leaf', surfaceId: 'chat' };

function tree(
  zones: Partial<Record<DockZoneName, DockNodeLike | null>>,
  colFr: Partial<{ left: number; middle: number; right: number }> = {},
  rowFr: Partial<{ top: number; center: number; bottom: number }> = {}
): DockTreeSpecLike {
  return {
    zones: {
      top: null,
      left: null,
      middle: null,
      right: null,
      bottom: null,
      ...zones,
    } as Record<DockZoneName, unknown>,
    rowFr: { top: 1, center: 1, bottom: 1, ...rowFr },
    colFr: { left: 1, middle: 1, right: 1, ...colFr },
  };
}

/**
 * The shipped dock-tree shapes. Exactly ONE: `focus`, the boot arrangement.
 *
 * Canned arrangements beyond the boot shape are the user's to make and save
 * (`layout save <name>`), not the app's to guess — the same reason the panel system
 * ships a single `default` document. The record shape is kept so `layout set` and
 * `getPreset` keep working, and so `DEFAULT_LAYOUT` stays a lookup rather than a
 * special case.
 */
export const LAYOUT_PRESETS: Record<string, NamedDockTreeSpec> = {
  // Today's exact shell shape: chat dominant, left, single column.
  focus: {
    name: 'focus',
    tree: tree({ left: CHAT_LEAF }, { left: 3, middle: 1 }),
  },
};

export function getPreset(name: string): NamedDockTreeSpec | null {
  return LAYOUT_PRESETS[name] ?? null;
}
