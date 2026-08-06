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
    // Advertised capabilities are authoritative for EVERY kind: a target that
    // says network:false cannot serve a cookie teleport no matter what kind it
    // claims (iOS advertises browser targets whose Network domain is absent).
    if (opts.requireNetwork && target.capabilities) {
      return target.capabilities.network === true;
    }
    // Legacy peers advertise no capabilities: keep the historical rule
    // (cherry excluded, everything else optimistically accepted) so a new
    // leader doesn't strand an old standalone follower mid-skew.
    if (!isCherryTarget(target)) return true;
    return !opts.requireNetwork;
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
    // Skew guard: iOS apps predating capability advertisement expose targets
    // whose Network domain silently no-ops — a teleport would "succeed" with
    // zero cookies. Require an explicit network-capable target from iOS.
    if (follower.floatType === 'ios') {
      const iosEntries = this.registry
        .getEntries()
        .filter((entry) => entry.runtimeId === runtimeId);
      return iosEntries.some((entry) => entry.capabilities?.network === true);
    }
    const entries = this.registry.getEntries().filter((entry) => entry.runtimeId === runtimeId);
    if (entries.length === 0) {
      // Advertised an EMPTY target list (a browser with no open tabs yet):
      // trust the hello capability. Exec-only followers (CLI) never set
      // `browser` and must not be selected — their `tab.open` would hang, not
      // fail. Note this branch is only reachable after an advertise, because
      // selection enumerates `runtimeToBootstrap`, which nothing populates
      // until the first `targets.advertise` arrives; a follower that has never
      // advertised has no runtime id to address and is excluded earlier.
      return follower.peerCapabilities?.browser === true;
    }
    return selectTeleportPool(entries, { requireNetwork: true }).length > 0;
  }

  /** Bootstrap ids of followers currently able to host a cookie teleport. */
  getTeleportEligibleBootstrapIds(): Set<string> {
    const eligible = new Set<string>();
    for (const [runtimeId, bootstrapId] of this.context.followers.runtimeToBootstrap) {
      const follower = this.context.followers.followers.get(bootstrapId);
      if (follower && this.canRuntimeServeTeleport(runtimeId, follower)) {
        eligible.add(bootstrapId);
      }
    }
    return eligible;
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
