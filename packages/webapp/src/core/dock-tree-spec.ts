/**
 * Compatibility shim: the dock-tree spec types and the preset library now live
 * in the foundational `base/` layer (`base/dock-tree-spec.ts`) so `shell/` can
 * reach them without an up-the-stack back-edge into `core/` — the `layout`
 * shell command needs the presets. Same pattern, and the same reason, as
 * `core/logger.ts`.
 *
 * Modules that already import from this path and do not otherwise need
 * touching keep working through this re-export; new code should import from
 * `base/dock-tree-spec.js`. Keeping the shim is deliberate: a one-line import
 * rewrite in `kernel/panel-rpc.ts` would put that file in the CI `speech` path
 * filter, un-skipping a 25-minute real-Kokoro end-to-end spec for a change
 * that cannot affect it.
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
} from '../base/dock-tree-spec.js';
