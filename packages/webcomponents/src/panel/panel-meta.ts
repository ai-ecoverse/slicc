/**
 * Panel metadata types and the pure helpers over them.
 *
 * Split out of `slicc-panel.ts` so this can be imported with **no DOM**:
 * `slicc-panel.ts` calls `define()` at module load, which needs
 * `customElements` and (transitively, via the package barrel) `CSSStyleSheet`.
 * The registry, the webapp's layout store, and the kernel-worker-side `layout`
 * command all need the metadata shape without any of that — same reasoning as
 * `layout-schema.ts` and the `composer/speech` subpath.
 *
 * Re-exported from `slicc-panel.ts` so existing imports keep working.
 */

/**
 * A CSS length a layout may request for a panel: raw pixels (`"44px"`), a
 * percentage of the parent slot (`"30%"`), or a flex fraction (`"3fr"` or the
 * bare number `3`). Fixed chrome (rails, strips) needs the `px` form — the
 * reason the layout schema is not fr-only.
 */
export type PanelSize = string | number;

/**
 * How an open panel occupies space.
 *
 * - `docked` (default) — a real cell in the layout tree: it takes space, its
 *   siblings reflow around it, and it can be drag-split and resized against
 *   them.
 * - `floating` — painted above the docked panels without reflowing them, in the
 *   panel host's floating stratum. For glanceable panels (a monitor you check
 *   rather than work in), and for narrow viewports where docking would crush
 *   the chat.
 *
 * Independent of visibility: "collapsed by default" is expressed by a panel
 * simply not being in the layout until opened, not by its presentation.
 *
 * A floating panel stacks INSIDE the app's panel host, never in `document.body`
 * — so it stays below the trusted layer and can never occlude an approval
 * dialog (see the webapp's `trusted-layer.ts`).
 */
export type PanelPresentation = 'docked' | 'floating';

/** Edge a floating panel anchors to when the layout does not place it explicitly. */
export type PanelAnchor = 'top' | 'right' | 'bottom' | 'left' | 'center';

const PANEL_ANCHORS: readonly PanelAnchor[] = ['top', 'right', 'bottom', 'left', 'center'];

/** Whether a raw attribute value is a valid {@link PanelAnchor}. */
export function isPanelAnchor(value: string | null): value is PanelAnchor {
  return value != null && (PANEL_ANCHORS as readonly string[]).includes(value);
}

/**
 * Static description of a panel type. Subclasses declare this so the registry,
 * the "add panel" menu, and the layout engine can reason about a panel WITHOUT
 * instantiating it (the menu lists panels that are not mounted; the engine needs
 * sizing hints before it builds a slot).
 */
export interface PanelMeta {
  /** Stable id a layout document references. Unique per registry. */
  id: string;
  /** Human label for the "add panel" menu and the drag handle's tooltip. */
  title: string;
  /** Lucide glyph name, VFS path to an SVG/PNG, or inline `<svg>` markup. */
  icon?: string;
  /** Smallest useful width/height in px — a responsive variant may hide the panel below it. */
  minWidth?: number;
  minHeight?: number;
  /** Size the panel prefers when a layout does not specify one. */
  preferredSize?: PanelSize;
  /**
   * Default presentation for this panel type. Omitted means `docked`. A layout
   * document may override it per placement, so the same panel can float in one
   * layout and dock in another.
   */
  presentation?: PanelPresentation;
  /** Edge a `floating` panel prefers. Ignored when docked. */
  anchor?: PanelAnchor;
  /**
   * Where the panel's body executes. `'main'` is a real custom element in the
   * page realm (needed for chrome whose popovers must escape their bounds, and
   * for cross-panel drag). `'sandboxed'` renders inside the existing sprinkle
   * iframe. NOT a security boundary either way — see
   * `docs/panel-system-design.md`'s trust model.
   */
  realm?: 'main' | 'sandboxed';
}

/**
 * Read a panel constructor's static `panelMeta` without assuming it declared
 * one. Kept a free function (not a getter) so the registry can validate a
 * constructor it has never instantiated.
 */
export function panelMetaOf(ctor: unknown): PanelMeta | undefined {
  const meta = (ctor as { panelMeta?: PanelMeta } | null | undefined)?.panelMeta;
  return meta && typeof meta.id === 'string' ? meta : undefined;
}
