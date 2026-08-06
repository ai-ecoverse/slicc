/**
 * UI-layer view of the leader permissions-surface registry.
 *
 * The registry itself lives in `core/permissions-surface-registry.ts`: its
 * consumers include `providers/` (OAuth), `speech/`, and `kernel/`, all of
 * which sit below the UI layer and must not import upward. This module keeps
 * the familiar `ui/wc/` import path for UI callers and for
 * `wc-permissions.ts`, the only place that actually mounts the element.
 */

export {
  getLeaderPermissionsSurface,
  setLeaderPermissionsSurface,
} from '../../core/permissions-surface-registry.js';
