/**
 * UI-layer view of the leader permissions-surface registry.
 *
 * The registry itself lives in `base/permissions-surface-registry.ts` so
 * every ranked layer (including `shell/`) can resolve it without importing
 * upward. This module keeps the familiar `ui/wc/` import path for UI callers
 * and for `wc-permissions.ts`, the only place that actually mounts the
 * element.
 */

export {
  getLeaderPermissionsSurface,
  setLeaderPermissionsSurface,
} from '../../base/permissions-surface-registry.js';
