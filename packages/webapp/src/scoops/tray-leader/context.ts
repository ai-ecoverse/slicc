import type { Logger } from '../../base/logger.js';
import type { LeaderSyncManagerOptions } from '../tray-leader-sync.js';
import type { FollowerRegistry } from './follower-registry.js';

export interface LeaderSyncContext {
  options: LeaderSyncManagerOptions;
  followers: FollowerRegistry;
  log: Logger;
  sendControl: LeaderSyncManagerOptions['sendControl'];
}
