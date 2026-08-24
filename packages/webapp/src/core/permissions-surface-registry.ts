/**
 * Compatibility re-export of the leader permissions-surface registry.
 *
 * The singleton lives in `base/permissions-surface-registry.ts` so `shell/`
 * can import it without a layer back-edge. This module keeps the historical
 * `core/` path for speech, kernel, providers, and UI callers.
 */
export {
  getLeaderPermissionsSurface,
  setLeaderPermissionsSurface,
} from '../base/permissions-surface-registry.js';
