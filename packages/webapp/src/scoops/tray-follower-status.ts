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
