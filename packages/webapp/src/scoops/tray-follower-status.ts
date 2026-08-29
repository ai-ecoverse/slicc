/**
 * Follower tray runtime status — relocated to `base/tray-follower-status.ts`
 * so `shell/` (the `host` command) can read it without importing UP the layer
 * stack (#2537). Re-exported here under the established names: this module
 * stays the address the tray managers and the UI already import.
 */

export {
  FOLLOWER_STATUS_STORAGE_KEY,
  type FollowerTrayRuntimeStatus,
  getFollowerStatusWithFallback,
  getFollowerTrayRuntimeStatus,
  resetReconnectAttempts,
  setFollowerLastPingTime,
  setFollowerStalled,
  setFollowerTrayRuntimeStatus,
  subscribeToFollowerTrayRuntimeStatus,
} from '../base/tray-follower-status.js';
