import type { Logger } from '../../base/logger.js';
import type { SprinkleInstance } from '../../shell/sprinkle-manager-handle.js';
import { DataChannelKeepalive } from '../data-channel-keepalive.js';
import {
  createLeaderSyncChannel,
  type FollowerToLeaderMessage,
  type LeaderToFollowerMessage,
  type TraySyncCapabilities,
  type TraySyncChannel,
} from '../tray-sync-protocol.js';
import type { TrayDataChannelLike } from '../tray-webrtc.js';

export type FloatType = 'standalone' | 'extension' | 'electron' | 'ios' | 'unknown';

export function deriveFloatType(runtime?: string): FloatType {
  if (!runtime) return 'unknown';
  if (runtime.includes('ios')) return 'ios';
  if (runtime.includes('standalone')) return 'standalone';
  if (runtime.includes('extension')) return 'extension';
  if (runtime.includes('electron')) return 'electron';
  return 'unknown';
}

export function labelForFollower(floatType: FloatType, runtime?: string): string {
  switch (floatType) {
    case 'extension':
      return 'extension follower';
    case 'standalone':
      return 'standalone follower';
    case 'electron':
      return 'Electron follower';
    case 'ios':
      return 'iOS follower';
    default:
      return runtime ? `follower (${runtime})` : 'follower';
  }
}

export interface ConnectedFollower {
  bootstrapId: string;
  sync: TraySyncChannel<LeaderToFollowerMessage, FollowerToLeaderMessage>;
  unsubscribe: () => void;
  keepalive: DataChannelKeepalive;
  runtime?: string;
  connectedAt?: string;
  lastActivity: number;
  floatType: FloatType;
  hostOrigin?: string;
  selectedScoopJid?: string;
  peerProtocolVersion?: number;
  legacyPeerLogged?: boolean;
  peerCapabilities?: TraySyncCapabilities;
  peerMotd?: string;
  /**
   * Sprinkles this follower reported as RENDERED (`sprinkle.instances`).
   * Absent until the follower reports — an iOS follower never does, so its
   * documents are absent from `sprinkle list` rather than guessed at.
   */
  sprinkleInstances?: string[];
}

export interface FollowerRegistryOptions {
  log: Logger;
  onMessage: (bootstrapId: string, message: FollowerToLeaderMessage) => void;
  onFollowerDead?: (bootstrapId: string) => void;
  onFollowerCountChanged?: (count: number) => void;
}

export interface FollowerRemovalHooks {
  beforeRegistryCleanup?: (bootstrapId: string) => void;
  removeRuntime?: (bootstrapId: string, runtimeId: string) => void;
  afterRegistryCleanup?: (bootstrapId: string, runtimeId?: string) => void;
}

export interface ConnectedFollowerInfo {
  runtimeId: string;
  runtime?: string;
  connectedAt?: string;
  lastActivity?: number;
  floatType?: FloatType;
}

export interface FollowerDetails {
  bootstrapId: string;
  runtime?: string;
  connectedAt?: string;
  lastActivity: number;
  floatType: FloatType;
  hostOrigin?: string;
  selectedScoopJid?: string;
  health: 'live' | 'stalled';
}

const BROADCAST_ERROR_THROTTLE_MS = 60_000;

export class FollowerRegistry {
  readonly followers = new Map<string, ConnectedFollower>();
  readonly runtimeToBootstrap = new Map<string, string>();
  private readonly removalHooks = new Set<FollowerRemovalHooks>();
  private readonly followerBroadcastErrorLogAt = new Map<string, number>();

  constructor(private readonly options: FollowerRegistryOptions) {}

  addFollower(
    bootstrapId: string,
    channel: TrayDataChannelLike,
    meta?: { runtime?: string; connectedAt?: string }
  ): ConnectedFollower {
    this.removeFollower(bootstrapId);
    const sync = createLeaderSyncChannel(channel);
    const unsubscribe = sync.onMessage((message) => this.options.onMessage(bootstrapId, message));
    const keepalive = new DataChannelKeepalive({
      sendPing: () => sync.send({ type: 'ping' }),
      isTransportOpen: () => sync.isOpen,
      onStalled: () => {
        this.options.log.warn('Follower stopped answering pings; channel still open, keeping it', {
          bootstrapId,
        });
      },
      onRecovered: () => {
        this.options.log.info('Follower is answering pings again', { bootstrapId });
      },
      onDead: () => {
        this.options.log.warn('Follower keepalive dead, removing follower', { bootstrapId });
        this.removeFollower(bootstrapId);
        this.options.onFollowerDead?.(bootstrapId);
      },
    });
    keepalive.start();
    const follower: ConnectedFollower = {
      bootstrapId,
      sync,
      unsubscribe,
      keepalive,
      runtime: meta?.runtime,
      connectedAt: meta?.connectedAt,
      lastActivity: Date.now(),
      floatType: deriveFloatType(meta?.runtime),
    };
    this.followers.set(bootstrapId, follower);
    this.options.log.info('Follower added to sync', {
      bootstrapId,
      followerCount: this.followers.size,
    });
    this.notifyFollowerCountChanged();
    return follower;
  }

  removeFollower(bootstrapId: string): void {
    const follower = this.followers.get(bootstrapId);
    if (!follower) return;
    follower.keepalive.stop();
    follower.unsubscribe();
    follower.sync.close();
    this.followers.delete(bootstrapId);
    for (const hooks of this.removalHooks) hooks.beforeRegistryCleanup?.(bootstrapId);
    this.followerBroadcastErrorLogAt.delete(bootstrapId);
    const runtimeId = this.runtimeIdForBootstrap(bootstrapId);
    if (runtimeId) {
      for (const hooks of this.removalHooks) hooks.removeRuntime?.(bootstrapId, runtimeId);
      this.runtimeToBootstrap.delete(runtimeId);
    }
    for (const hooks of this.removalHooks) hooks.afterRegistryCleanup?.(bootstrapId, runtimeId);
    this.options.log.info('Follower removed from sync', {
      bootstrapId,
      followerCount: this.followers.size,
    });
    this.notifyFollowerCountChanged();
  }

  onFollowerRemoved(hooks: FollowerRemovalHooks): () => void {
    this.removalHooks.add(hooks);
    return () => this.removalHooks.delete(hooks);
  }

  notifyFollowerCountChanged(): void {
    this.options.onFollowerCountChanged?.(this.followers.size);
  }

  setRuntimeId(runtimeId: string, bootstrapId: string): void {
    this.runtimeToBootstrap.set(runtimeId, bootstrapId);
  }

  resolveFollowerByRuntimeId(
    runtimeId: string
  ): { bootstrapId: string; follower: ConnectedFollower } | null {
    const advertised = this.runtimeToBootstrap.get(runtimeId);
    if (advertised) {
      const follower = this.followers.get(advertised);
      if (follower) return { bootstrapId: advertised, follower };
    }
    const candidates = [runtimeId];
    if (runtimeId.startsWith('follower-')) candidates.push(runtimeId.slice('follower-'.length));
    for (const candidate of candidates) {
      const follower = this.followers.get(candidate);
      if (follower) return { bootstrapId: candidate, follower };
    }
    return null;
  }

  runtimeIdForBootstrap(bootstrapId: string): string | undefined {
    for (const [runtimeId, candidate] of this.runtimeToBootstrap) {
      if (candidate === bootstrapId) return runtimeId;
    }
    return undefined;
  }

  /** Record a follower's latest rendered-sprinkle report. */
  setSprinkleInstances(bootstrapId: string, sprinkleNames: string[]): void {
    const follower = this.followers.get(bootstrapId);
    if (!follower) return;
    follower.sprinkleInstances = [...sprinkleNames];
  }

  /**
   * Every follower-rendered sprinkle document, flattened for `sprinkle list`.
   * Dropping a follower drops its instances with it — the registry entry is
   * the only place they live.
   */
  getSprinkleInstances(): SprinkleInstance[] {
    const instances: SprinkleInstance[] = [];
    for (const [bootstrapId, follower] of this.followers) {
      const runtimeId = this.runtimeIdForBootstrap(bootstrapId) ?? bootstrapId;
      for (const name of follower.sprinkleInstances ?? []) {
        instances.push({ name, runtimeId, runtime: follower.runtime });
      }
    }
    return instances;
  }

  getFollowerMotds(): Map<string, string> {
    const motds = new Map<string, string>();
    for (const [bootstrapId, follower] of this.followers) {
      if (follower.peerMotd) motds.set(bootstrapId, follower.peerMotd);
    }
    return motds;
  }

  getExecCapableBootstrapIds(): Set<string> {
    const ids = new Set<string>();
    for (const [bootstrapId, follower] of this.followers) {
      if (follower.peerCapabilities?.exec) ids.add(bootstrapId);
    }
    return ids;
  }

  getBrowserCapableBootstrapIds(): Set<string> {
    return new Set(this.runtimeToBootstrap.values());
  }

  getFollowerDetails(): FollowerDetails[] {
    return [...this.followers.values()].map((follower) => ({
      bootstrapId: follower.bootstrapId,
      runtime: follower.runtime,
      connectedAt: follower.connectedAt,
      lastActivity: follower.lastActivity,
      floatType: follower.floatType,
      hostOrigin: follower.hostOrigin,
      selectedScoopJid: follower.selectedScoopJid,
      health: follower.keepalive.isStalled ? 'stalled' : 'live',
    }));
  }

  getConnectedFollowers(): ConnectedFollowerInfo[] {
    return [...this.runtimeToBootstrap.entries()].map(([runtimeId, bootstrapId]) => {
      const follower = this.followers.get(bootstrapId);
      return {
        runtimeId,
        runtime: follower?.runtime,
        connectedAt: follower?.connectedAt,
        lastActivity: follower?.lastActivity,
        floatType: follower?.floatType,
      };
    });
  }

  /**
   * Send a message to every connected follower, reporting which ones refused it.
   *
   * `TraySyncChannel.send` catches every throw internally and reports failure
   * through its return value, so this reads that value rather than wrapping the
   * call in a try/catch — the catch this method used to carry could never run,
   * which is what made oversize-message failures invisible here (#1700).
   *
   * Failures are throttled per-follower (~1 log per 60s) so a stuck channel
   * can't flood logs during a high-event turn. Successful sends clear the
   * throttle so a recovered channel logs immediately if it fails again. Does
   * NOT auto-remove the broken follower — keepalive timeout owns that decision.
   *
   * @returns bootstrapIds of followers whose send failed.
   */
  broadcastToAllFollowers(message: LeaderToFollowerMessage): string[] {
    const now = performance.now();
    const failed: string[] = [];
    for (const [bootstrapId, follower] of this.followers) {
      let sent = false;
      let thrown: unknown;
      try {
        sent = follower.sync.send(message);
      } catch (err) {
        // Backstop, not the primary signal: `TraySyncChannel.send` reports
        // failure by returning false. This keeps one hostile or stubbed channel
        // from aborting the loop and stranding the followers behind it.
        thrown = err;
      }
      if (sent) {
        this.followerBroadcastErrorLogAt.delete(bootstrapId);
        continue;
      }
      failed.push(bootstrapId);
      const lastLogAt =
        this.followerBroadcastErrorLogAt.get(bootstrapId) ?? Number.NEGATIVE_INFINITY;
      if (now - lastLogAt > BROADCAST_ERROR_THROTTLE_MS) {
        this.followerBroadcastErrorLogAt.set(bootstrapId, now);
        this.options.log.error('Broadcast send to follower failed', {
          bootstrapId,
          messageType: message.type,
          ...(thrown ? { error: thrown instanceof Error ? thrown.message : String(thrown) } : {}),
        });
      }
    }
    return failed;
  }
}
