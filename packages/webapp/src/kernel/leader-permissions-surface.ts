/**
 * Kernel-layer access to the leader `<slicc-permissions>` registry.
 *
 * The registry lives in `core/` so unranked / UI callers can resolve it
 * without importing upward into `ui/`. Shell commands (`ffmpeg`, …) sit
 * *below* `core` on the layer stack, so they must not import `core/` or
 * `ui/` directly — this kernel re-export is the allowed seam.
 */
export { getLeaderPermissionsSurface } from '../core/permissions-surface-registry.js';
