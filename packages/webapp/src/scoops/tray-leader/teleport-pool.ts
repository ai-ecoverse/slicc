import {
  CHERRY_RUNTIME_TAG,
  type FollowerToLeaderMessage,
  type RemoteTargetInfo,
  type TrayTargetEntry,
} from '../tray-sync-protocol.js';
import { TrayTargetRegistry } from '../tray-target-registry.js';
import type { LeaderSyncContext } from './context.js';
import type { ConnectedFollower, FloatType } from './follower-registry.js';

export function isCherryTarget(t: Pick<RemoteTargetInfo, 'kind'>): boolean {
  return t.kind === 'cherry';
}

export function selectTeleportPool<
  T extends Pick<RemoteTargetInfo, 'kind' | 'capabilities'> & { targetId: string },
>(targets: T[], opts: { requireNetwork: boolean }): T[] {
  return targets.filter((target) => {
    if (target.kind === 'preview') return false;
    if (!isCherryTarget(target)) return true;
    if (opts.requireNetwork) return target.capabilities?.network === true;
    return true;
  });
}

export interface TeleportPoolOptions {
  cleanupOrphanedRemoteTransports: (runtimeId: string) => void;
  getPreviewTargetEntries: () => TrayTargetEntry[];
}

export class TeleportPool {
  private readonly registry = new TrayTargetRegistry();

  constructor(
    private readonly context: LeaderSyncContext,
    private readonly options: TeleportPoolOptions
  ) {
    context.followers.onFollowerRemoved({
      removeRuntime: (_bootstrapId, runtimeId) => this.registry.removeRuntime(runtimeId),
      afterRegistryCleanup: () => {
        if (this.registry.hasChanged()) this.broadcastTargetRegistry();
      },
    });
  }

  setLocalTargets(targets: RemoteTargetInfo[]): void {
    this.registry.setTargets('leader', targets);
    if (this.registry.hasChanged()) this.broadcastTargetRegistry();
  }

  broadcastTargetRegistry(): void {
    if (this.context.followers.followers.size === 0) return;
    this.context.followers.broadcastToAllFollowers({
      type: 'targets.registry',
      targets: this.getFollowerBroadcastEntries(),
    });
  }

  sendTargetRegistryToFollower(bootstrapId: string): void {
    const entries = this.getFollowerBroadcastEntries();
    if (entries.length === 0) return;
    this.context.followers.followers
      .get(bootstrapId)
      ?.sync.send({ type: 'targets.registry', targets: entries });
  }

  getTargets(): TrayTargetEntry[] {
    return this.getConnectedEntries();
  }

  getRegistryEntries(): TrayTargetEntry[] {
    return this.registry.getEntries();
  }

  getFollowerBroadcastEntries(): TrayTargetEntry[] {
    return this.getConnectedEntries().filter((target) => target.kind !== 'preview');
  }

  getConnectedEntries(): TrayTargetEntry[] {
    const registryEntries = this.registry.getEntries().filter((target) => {
      if (target.runtimeId === 'leader') return true;
      const bootstrapId = this.context.followers.runtimeToBootstrap.get(target.runtimeId);
      return bootstrapId ? this.context.followers.followers.has(bootstrapId) : false;
    });
    return [...registryEntries, ...this.options.getPreviewTargetEntries()];
  }

  canRuntimeServeTeleport(runtimeId: string, follower: ConnectedFollower): boolean {
    if (follower.runtime === CHERRY_RUNTIME_TAG) return false;
    const entries = this.registry.getEntries().filter((entry) => entry.runtimeId === runtimeId);
    if (entries.length === 0) return true;
    return selectTeleportPool(entries, { requireNetwork: true }).length > 0;
  }

  getBestFollowerForTeleport(): {
    runtimeId: string;
    bootstrapId: string;
    floatType: FloatType;
  } | null {
    const candidates: Array<{
      runtimeId: string;
      bootstrapId: string;
      floatType: FloatType;
      lastActivity: number;
    }> = [];
    for (const [runtimeId, bootstrapId] of this.context.followers.runtimeToBootstrap) {
      const follower = this.context.followers.followers.get(bootstrapId);
      if (!follower || !this.canRuntimeServeTeleport(runtimeId, follower)) continue;
      candidates.push({
        runtimeId,
        bootstrapId,
        floatType: follower.floatType,
        lastActivity: follower.lastActivity,
      });
    }
    if (candidates.length === 0) return null;
    const standalone = candidates.filter((candidate) => candidate.floatType === 'standalone');
    const pool = standalone.length > 0 ? standalone : candidates;
    pool.sort((a, b) => b.lastActivity - a.lastActivity);
    return pool[0];
  }

  handleFollowerTargetsAdvertise(
    bootstrapId: string,
    message: FollowerToLeaderMessage & { type: 'targets.advertise' }
  ): void {
    this.context.log.info('Follower targets advertised', {
      bootstrapId,
      runtimeId: message.runtimeId,
      targetCount: message.targets.length,
    });
    this.options.cleanupOrphanedRemoteTransports(message.runtimeId);
    this.context.followers.setRuntimeId(message.runtimeId, bootstrapId);
    this.registry.setTargets(message.runtimeId, message.targets);
    const follower = this.context.followers.followers.get(bootstrapId);
    if (follower && follower.runtime === CHERRY_RUNTIME_TAG) {
      const cherryTarget = message.targets.find((target) => target.kind === 'cherry');
      if (cherryTarget) {
        try {
          follower.hostOrigin = new URL(cherryTarget.url).origin;
        } catch {
          // Malformed URL — omit hostOrigin
        }
      }
    }
    this.broadcastTargetRegistry();
  }
}
