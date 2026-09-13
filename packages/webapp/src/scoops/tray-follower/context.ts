import type { Logger } from '../../base/logger.js';
import type { FollowerToLeaderMessage } from '../tray-sync-protocol.js';
import type { FollowerSyncManagerOptions } from './types.js';

/** Shared send/options/log bag for follower-sync collaborators. */
export interface FollowerSyncContext {
  options: FollowerSyncManagerOptions;
  log: Logger;
  send: (message: FollowerToLeaderMessage) => boolean;
}
