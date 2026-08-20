/**
 * Re-export shim. The dock-tree spec types and the preset library moved to
 * `base/dock-tree-spec.ts` so the shell, scoops and kernel layers can reach them
 * without importing `ui/` — the layer stack forbids that back-edge, and none of the
 * data was ever DOM-bound.
 *
 * Kept as a shim rather than rewriting every `ui/` import: this module's callers all
 * live in `ui/`, where either path is layer-legal, and one indirection is cheaper
 * than churning the call sites.
 */

export {
  DEFAULT_LAYOUT,
  type DockNodeLike,
  type DockTreeSpecLike,
  type DockZoneName,
  getPreset,
  LAYOUT_PRESETS,
  type NamedDockTreeSpec,
  type SurfaceSizeSpecLike,
} from '../../base/dock-tree-spec.js';
