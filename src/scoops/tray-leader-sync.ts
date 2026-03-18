/**
 * Leader sync manager — broadcasts agent events and snapshots to followers
 * over WebRTC data channels using the typed tray sync protocol.
 */

import type { AgentEvent, ChatMessage } from '../ui/types.js';
import type { TrayDataChannelLike } from './tray-webrtc.js';
import {
  createLeaderSyncChannel,
  sendCDPResponse,
  reassembleCDPResponse,
  sendSnapshot,
  type LeaderToFollowerMessage,
  type FollowerToLeaderMessage,
  type TraySyncChannel,
  type RemoteTargetInfo,
  type TrayTargetEntry,
  type TrayFsRequest,
  type TrayFsResponse,
  type CookieTeleportCookie,
} from './tray-sync-protocol.js';
import { handleFsRequest } from './tray-fs-handler.js';
import type { VirtualFS } from '../fs/virtual-fs.js';
import { TrayTargetRegistry } from './tray-target-registry.js';
import type { CDPTransport } from '../cdp/transport.js';
import type { BrowserAPI } from '../cdp/browser-api.js';
import { RemoteCDPTransport, type RemoteCDPSender } from '../cdp/remote-cdp-transport.js';
import { DataChannelKeepalive } from './data-channel-keepalive.js';
import { createLogger } from '../core/logger.js';

const log = createLogger('tray-leader-sync');

export interface LeaderSyncManagerOptions {
  /** Get current chat messages for the active scoop. */
  getMessages: () => ChatMessage[];
  /** Get the active scoop JID. */
  getScoopJid: () => string;
  /** Handle a user message arriving from a follower. */
  onFollowerMessage: (text: string, messageId: string) => void;
  /** Handle an abort request from a follower. */
  onFollowerAbort: () => void;
  /** Optional CDP transport for executing local CDP commands (leader's browser). */
  browserTransport?: CDPTransport;
  /** Optional BrowserAPI instance for session-aware browser commands (e.g. cookie capture). */
  browserAPI?: BrowserAPI;
  /** Called when a follower's data channel is considered dead (missed keepalive pongs). */
  onFollowerDead?: (bootstrapId: string) => void;
  /** VirtualFS instance for handling remote fs requests targeting the leader. */
  vfs?: VirtualFS;
}

/** Derived float type from the runtime string (e.g. 'slicc-standalone' → 'standalone'). */
export type FloatType = 'standalone' | 'extension' | 'electron' | 'unknown';

/** Derive a FloatType from the follower's runtime string. */
function deriveFloatType(runtime?: string): FloatType {
  if (!runtime) return 'unknown';
  if (runtime.includes('standalone')) return 'standalone';
  if (runtime.includes('extension')) return 'extension';
  if (runtime.includes('electron')) return 'electron';
  return 'unknown';
}

interface ConnectedFollower {
  bootstrapId: string;
  sync: TraySyncChannel<LeaderToFollowerMessage, FollowerToLeaderMessage>;
  unsubscribe: () => void;
  keepalive: DataChannelKeepalive;
  runtime?: string;
  connectedAt?: string;
  lastActivity: number;
  floatType: FloatType;
}

/** Tracks a CDP request being routed through the leader. */
interface PendingCDPRoute {
  /** bootstrapId of the follower that originated the request */
  requesterBootstrapId: string;
  /** The original requestId from the requester */
  requestId: string;
}

/** Tracks a tab.open request being routed through the leader. */
interface PendingTabOpenRoute {
  /** bootstrapId of the follower that originated the request (or '__leader__') */
  requesterBootstrapId: string;
  /** The original requestId from the requester */
  requestId: string;
}

/** Tracks an fs request being routed through the leader. */
interface PendingFsRoute {
  /** bootstrapId of the follower that originated the request (or '__leader__') */
  requesterBootstrapId: string;
  /** The original requestId from the requester */
  requestId: string;
  /** Accumulated chunked responses (for multi-chunk file reads). */
  chunks: TrayFsResponse[];
  /** Expected total chunks (set from first response). */
  totalChunks: number;
}

/** Tracks a cookie teleport request being routed through the leader. */
interface PendingCookieTeleportRoute {
  requesterBootstrapId: string;
  requestId: string;
}

export class LeaderSyncManager {
  private readonly followers = new Map<string, ConnectedFollower>();
  private readonly registry = new TrayTargetRegistry();
  /** Maps runtimeId → bootstrapId so we can clean up registry on disconnect. */
  private readonly runtimeToBootstrap = new Map<string, string>();
  /** Maps requestId → routing info for CDP requests in flight through the leader. */
  private readonly pendingCDPRoutes = new Map<string, PendingCDPRoute>();
  /** Chunk buffers for reassembling chunked CDP responses from followers. */
  private readonly cdpChunkBuffers = new Map<string, { chunks: string[]; received: number; totalChunks: number }>();
  /** Active RemoteCDPTransport instances for the leader's own BrowserAPI (keyed by runtimeId:localTargetId). */
  private readonly remoteTransports = new Map<string, RemoteCDPTransport>();
  /** Maps requestId → routing info for tab.open requests in flight through the leader. */
  private readonly pendingTabOpenRoutes = new Map<string, PendingTabOpenRoute>();
  /** Resolvers for leader-originated tab.open requests. */
  private readonly tabOpenResolvers = new Map<string, { resolve: (targetId: string) => void; reject: (err: Error) => void }>();
  /** Maps requestId → routing info for fs requests in flight through the leader. */
  private readonly pendingFsRoutes = new Map<string, PendingFsRoute>();
  /** Resolvers for leader-originated fs requests. */
  private readonly fsResolvers = new Map<string, { resolve: (responses: TrayFsResponse[]) => void; reject: (err: Error) => void; responses: TrayFsResponse[] }>();
  /** Maps requestId → routing info for cookie teleport requests in flight through the leader. */
  private readonly pendingCookieTeleportRoutes = new Map<string, PendingCookieTeleportRoute>();
  /** Resolvers for leader-originated cookie teleport requests. */
  private readonly cookieTeleportResolvers = new Map<string, { resolve: (result: { cookies: CookieTeleportCookie[]; timedOut?: boolean; finalUrl?: string }) => void; reject: (err: Error) => void }>();

  constructor(private readonly options: LeaderSyncManagerOptions) {}

  /**
   * Add a connected follower's data channel.
   * Sends an initial snapshot and subscribes to follower messages.
   */
  addFollower(bootstrapId: string, channel: TrayDataChannelLike, meta?: { runtime?: string; connectedAt?: string }): void {
    // Clean up existing connection for same bootstrap
    this.removeFollower(bootstrapId);

    const sync = createLeaderSyncChannel(channel);

    const unsubscribe = sync.onMessage((message: FollowerToLeaderMessage) => {
      this.handleFollowerMessage(bootstrapId, message);
    });

    const keepalive = new DataChannelKeepalive({
      sendPing: () => sync.send({ type: 'ping' }),
      onDead: () => {
        log.warn('Follower keepalive dead, removing follower', { bootstrapId });
        this.removeFollower(bootstrapId);
        this.options.onFollowerDead?.(bootstrapId);
      },
    });
    keepalive.start();

    this.followers.set(bootstrapId, {
      bootstrapId, sync, unsubscribe, keepalive,
      runtime: meta?.runtime, connectedAt: meta?.connectedAt,
      lastActivity: Date.now(), floatType: deriveFloatType(meta?.runtime),
    });
    log.info('Follower added to sync', { bootstrapId, followerCount: this.followers.size });

    // Send initial snapshot
    this.sendSnapshotToFollower(bootstrapId);

    // Send current target registry to the new follower
    const entries = this.registry.getEntries();
    if (entries.length > 0) {
      sync.send({ type: 'targets.registry', targets: entries });
    }
  }

  /**
   * Remove a follower's data channel and clean up.
   */
  removeFollower(bootstrapId: string): void {
    const follower = this.followers.get(bootstrapId);
    if (!follower) return;
    follower.keepalive.stop();
    follower.unsubscribe();
    follower.sync.close();
    this.followers.delete(bootstrapId);

    // Remove this follower's targets from the registry
    // Find the runtimeId that maps to this bootstrapId
    for (const [runtimeId, bId] of this.runtimeToBootstrap) {
      if (bId === bootstrapId) {
        // Clean up any cached RemoteCDPTransport instances for this runtime
        this.cleanupRemoteTransports(runtimeId);
        this.registry.removeRuntime(runtimeId);
        this.runtimeToBootstrap.delete(runtimeId);
        break;
      }
    }
    if (this.registry.hasChanged()) {
      this.broadcastTargetRegistry();
    }

    log.info('Follower removed from sync', { bootstrapId, followerCount: this.followers.size });
  }

  /**
   * Broadcast an agent event to all connected followers.
   * Called from the orchestrator callback wiring in main.ts.
   */
  broadcastEvent(event: AgentEvent): void {
    if (this.followers.size === 0) return;
    const scoopJid = this.options.getScoopJid();
    const message: LeaderToFollowerMessage = { type: 'agent_event', event, scoopJid };
    for (const follower of this.followers.values()) {
      follower.sync.send(message);
    }
  }

  /**
   * Broadcast a user message to all connected followers.
   * Called when any user message enters the leader (local or from a follower).
   */
  broadcastUserMessage(text: string, messageId: string): void {
    if (this.followers.size === 0) return;
    const scoopJid = this.options.getScoopJid();
    const message: LeaderToFollowerMessage = { type: 'user_message_echo', text, messageId, scoopJid };
    for (const follower of this.followers.values()) {
      follower.sync.send(message);
    }
  }

  /**
   * Broadcast a status change to all connected followers.
   */
  broadcastStatus(status: string): void {
    if (this.followers.size === 0) return;
    const message: LeaderToFollowerMessage = { type: 'status', scoopStatus: status };
    for (const follower of this.followers.values()) {
      follower.sync.send(message);
    }
  }

  /**
   * Send a snapshot of current messages to a specific follower.
   * Automatically chunks large snapshots to avoid exceeding SCTP message size limits.
   */
  private sendSnapshotToFollower(bootstrapId: string): void {
    const follower = this.followers.get(bootstrapId);
    if (!follower) return;
    const messages = this.options.getMessages();
    const scoopJid = this.options.getScoopJid();
    sendSnapshot(follower.sync, messages, scoopJid);
    log.debug('Snapshot sent to follower', { bootstrapId, messageCount: messages.length });
  }

  /**
   * Handle incoming messages from a follower.
   */
  private handleFollowerMessage(bootstrapId: string, message: FollowerToLeaderMessage): void {
    switch (message.type) {
      case 'user_message':
        log.info('Follower user message received', { bootstrapId, messageId: message.messageId });
        this.options.onFollowerMessage(message.text, message.messageId);
        break;
      case 'abort':
        log.info('Follower abort received', { bootstrapId });
        this.options.onFollowerAbort();
        break;
      case 'request_snapshot':
        log.info('Follower snapshot request received', { bootstrapId });
        this.sendSnapshotToFollower(bootstrapId);
        break;
      case 'targets.advertise': {
        log.info('Follower targets advertised', { bootstrapId, runtimeId: message.runtimeId, targetCount: message.targets.length });
        // Clean up stale remote transports for runtimeIds that are no longer in runtimeToBootstrap
        // (e.g. a follower reconnected with a new runtimeId but old transports linger)
        for (const key of [...this.remoteTransports.keys()]) {
          const runtimeId = key.substring(0, key.indexOf(':'));
          if (runtimeId !== 'leader' && !this.runtimeToBootstrap.has(runtimeId) && runtimeId !== message.runtimeId) {
            const transport = this.remoteTransports.get(key);
            transport?.disconnect();
            this.remoteTransports.delete(key);
            log.debug('Cleaned up orphaned remote transport on advertise', { key });
          }
        }
        this.runtimeToBootstrap.set(message.runtimeId, bootstrapId);
        this.registry.setTargets(message.runtimeId, message.targets);
        this.broadcastTargetRegistry();
        break;
      }
      case 'cdp.request': {
        const { requestId, targetRuntimeId, localTargetId, method, params, sessionId } = message;
        if (targetRuntimeId === 'leader') {
          this.executeLocalCDP(requestId, localTargetId, method, params, sessionId, bootstrapId);
        } else {
          this.forwardCDPRequest(requestId, targetRuntimeId, localTargetId, method, params, sessionId, bootstrapId);
        }
        break;
      }
      case 'cdp.response': {
        this.handleCDPResponse(message);
        break;
      }
      case 'tab.open': {
        const { requestId, targetRuntimeId, url } = message;
        if (targetRuntimeId === 'leader') {
          this.executeLocalTabOpen(requestId, url, bootstrapId);
        } else {
          this.forwardTabOpen(requestId, targetRuntimeId, url, bootstrapId);
        }
        break;
      }
      case 'tab.opened': {
        this.handleTabOpenResponse(message.requestId, message.targetId);
        break;
      }
      case 'tab.open.error': {
        this.handleTabOpenError(message.requestId, message.error);
        break;
      }
      case 'fs.request': {
        const { requestId, targetRuntimeId, request } = message;
        if (targetRuntimeId === 'leader') {
          this.executeLocalFs(requestId, request, bootstrapId);
        } else {
          this.forwardFsRequest(requestId, targetRuntimeId, request, bootstrapId);
        }
        break;
      }
      case 'fs.response': {
        this.handleFsResponse(message.requestId, message.response);
        break;
      }
      case 'cookie.teleport.request': {
        const { requestId, targetRuntimeId, url, catchPattern, catchNotPattern, timeoutMs } = message;
        if (targetRuntimeId === 'leader') {
          // Leader executes locally: capture cookies from the leader's own browser
          this.executeLocalCookieTeleport(requestId, bootstrapId);
        } else {
          this.forwardCookieTeleportRequest(requestId, targetRuntimeId, bootstrapId, url, catchPattern, catchNotPattern, timeoutMs);
        }
        break;
      }
      case 'cookie.teleport.response': {
        this.handleCookieTeleportResponse(message.requestId, message.cookies, message.error, message.timedOut, message.finalUrl);
        break;
      }
      case 'ping': {
        // Follower is pinging us — respond with pong and treat as liveness signal
        const follower = this.followers.get(bootstrapId);
        if (follower) {
          follower.keepalive.receivePing();
          follower.lastActivity = Date.now();
          follower.sync.send({ type: 'pong' });
        }
        break;
      }
      case 'pong': {
        // Follower responded to our ping
        const follower = this.followers.get(bootstrapId);
        if (follower) {
          follower.keepalive.receivePong();
          follower.lastActivity = Date.now();
        }
        break;
      }
    }
  }

  /**
   * Feed the leader's own local browser targets into the registry.
   * Broadcasts the updated registry if targets changed.
   */
  setLocalTargets(targets: RemoteTargetInfo[]): void {
    this.registry.setTargets('leader', targets);
    if (this.registry.hasChanged()) {
      this.broadcastTargetRegistry();
    }
  }

  /**
   * Broadcast the merged target registry to all connected followers.
   */
  broadcastTargetRegistry(): void {
    if (this.followers.size === 0) return;
    const entries = this.registry.getEntries();
    const message: LeaderToFollowerMessage = { type: 'targets.registry', targets: entries };
    for (const follower of this.followers.values()) {
      follower.sync.send(message);
    }
  }

  /**
   * Get the merged target registry entries.
   * Used to implement TrayTargetProvider for the leader's BrowserAPI.
   */
  getTargets(): TrayTargetEntry[] {
    return this.registry.getEntries();
  }

  /**
   * Create a RemoteCDPTransport that routes CDP commands from the leader's
   * BrowserAPI to a follower that owns the target.
   */
  createRemoteTransport(targetRuntimeId: string, localTargetId: string): RemoteCDPTransport {
    const sender: RemoteCDPSender = {
      sendCDPRequest: (requestId, method, params, sessionId) => {
        const targetBootstrapId = this.runtimeToBootstrap.get(targetRuntimeId);
        const targetFollower = targetBootstrapId ? this.followers.get(targetBootstrapId) : undefined;
        if (!targetFollower) {
          // Immediately resolve as error — the transport will handle it
          const transport = this.remoteTransports.get(`${targetRuntimeId}:${localTargetId}`);
          transport?.handleResponse(requestId, undefined, `Target runtime "${targetRuntimeId}" not connected`);
          return;
        }
        // Track the route so the response can be delivered to the RemoteCDPTransport
        this.pendingCDPRoutes.set(requestId, { requesterBootstrapId: '__leader__', requestId });
        targetFollower.sync.send({ type: 'cdp.request', requestId, localTargetId, method, params, sessionId });
      },
    };
    const transport = new RemoteCDPTransport(sender);
    this.remoteTransports.set(`${targetRuntimeId}:${localTargetId}`, transport);
    return transport;
  }

  /**
   * Remove a remote transport created for the leader's BrowserAPI.
   */
  removeRemoteTransport(targetRuntimeId: string, localTargetId: string): void {
    const key = `${targetRuntimeId}:${localTargetId}`;
    const transport = this.remoteTransports.get(key);
    if (transport) {
      transport.disconnect();
      this.remoteTransports.delete(key);
    }
  }

  /**
   * Clean up all cached RemoteCDPTransport instances for a given runtimeId.
   * Called when a follower disconnects to prevent stale transports from lingering.
   */
  private cleanupRemoteTransports(runtimeId: string): void {
    const prefix = `${runtimeId}:`;
    for (const key of [...this.remoteTransports.keys()]) {
      if (key.startsWith(prefix)) {
        const transport = this.remoteTransports.get(key);
        transport?.disconnect();
        this.remoteTransports.delete(key);
        log.debug('Cleaned up stale remote transport', { key });
      }
    }
  }

  /**
   * Return the list of connected follower runtimeIds with metadata.
   */
  getConnectedFollowers(): { runtimeId: string; runtime?: string; connectedAt?: string; lastActivity?: number; floatType?: FloatType }[] {
    return [...this.runtimeToBootstrap.entries()].map(([runtimeId, bootstrapId]) => {
      const follower = this.followers.get(bootstrapId);
      return {
        runtimeId, runtime: follower?.runtime, connectedAt: follower?.connectedAt,
        lastActivity: follower?.lastActivity, floatType: follower?.floatType,
      };
    });
  }

  /**
   * Find the best follower for a cookie teleport.
   * Prefers standalone floats, then sorts by most recent activity.
   * Returns null if no alive followers exist.
   */
  getBestFollowerForTeleport(): { runtimeId: string; bootstrapId: string; floatType: FloatType } | null {
    const candidates: { runtimeId: string; bootstrapId: string; floatType: FloatType; lastActivity: number }[] = [];
    for (const [runtimeId, bootstrapId] of this.runtimeToBootstrap) {
      const follower = this.followers.get(bootstrapId);
      if (!follower) continue;
      candidates.push({
        runtimeId, bootstrapId, floatType: follower.floatType, lastActivity: follower.lastActivity,
      });
    }
    if (candidates.length === 0) return null;
    // Prefer standalone, then sort by most recent activity
    const standalone = candidates.filter(c => c.floatType === 'standalone');
    const pool = standalone.length > 0 ? standalone : candidates;
    pool.sort((a, b) => b.lastActivity - a.lastActivity);
    return pool[0];
  }

  /**
   * Check if there are any connected followers.
   */
  get hasFollowers(): boolean {
    return this.followers.size > 0;
  }

  /**
   * Stop all follower connections.
   */
  stop(): void {
    for (const bootstrapId of [...this.followers.keys()]) {
      this.removeFollower(bootstrapId);
    }
  }

  // ---------------------------------------------------------------------------
  // CDP routing
  // ---------------------------------------------------------------------------

  /**
   * Execute a CDP command on the leader's own browser transport.
   * Sends the response back to the requesting follower, chunking if necessary.
   */
  private async executeLocalCDP(
    requestId: string,
    localTargetId: string,
    method: string,
    params: Record<string, unknown> | undefined,
    sessionId: string | undefined,
    requesterBootstrapId: string,
  ): Promise<void> {
    const follower = this.followers.get(requesterBootstrapId);
    if (!follower) return;

    const transport = this.options.browserTransport;
    if (!transport) {
      follower.sync.send({ type: 'cdp.response', requestId, error: 'Leader has no browser transport' });
      return;
    }

    try {
      const result = await transport.send(method, params, sessionId);
      sendCDPResponse(follower.sync, requestId, result);
    } catch (err) {
      follower.sync.send({ type: 'cdp.response', requestId, error: err instanceof Error ? err.message : String(err) });
    }
  }

  /**
   * Forward a CDP request from one follower to another follower that owns the target.
   */
  private forwardCDPRequest(
    requestId: string,
    targetRuntimeId: string,
    localTargetId: string,
    method: string,
    params: Record<string, unknown> | undefined,
    sessionId: string | undefined,
    requesterBootstrapId: string,
  ): void {
    const targetBootstrapId = this.runtimeToBootstrap.get(targetRuntimeId);
    const targetFollower = targetBootstrapId ? this.followers.get(targetBootstrapId) : undefined;
    const requester = this.followers.get(requesterBootstrapId);

    if (!targetFollower) {
      if (requester) {
        requester.sync.send({ type: 'cdp.response', requestId, error: `Target runtime "${targetRuntimeId}" not connected` });
      }
      return;
    }

    // Track the pending route so we can return the response to the requester
    this.pendingCDPRoutes.set(requestId, { requesterBootstrapId, requestId });

    // Forward to the target follower (without targetRuntimeId — it's always for their local target)
    targetFollower.sync.send({ type: 'cdp.request', requestId, localTargetId, method, params, sessionId });
  }

  /**
   * Handle a CDP response from a follower (forwarding back to the original requester).
   * Supports chunked responses: reassembles chunks before forwarding, then re-chunks
   * for the outbound channel.
   */
  private handleCDPResponse(message: FollowerToLeaderMessage & { type: 'cdp.response' }): void {
    const { requestId, result, error, chunkData, chunkIndex, totalChunks } = message;
    const route = this.pendingCDPRoutes.get(requestId);
    if (!route) return;

    // Reassemble chunked response from the follower
    const assembled = reassembleCDPResponse(this.cdpChunkBuffers, message);
    if (!assembled) return; // Still waiting for more chunks

    this.pendingCDPRoutes.delete(requestId);

    // Route to the leader's own RemoteCDPTransport if the requester is the leader itself
    if (route.requesterBootstrapId === '__leader__') {
      for (const transport of this.remoteTransports.values()) {
        transport.handleResponse(requestId, assembled.result, assembled.error);
      }
      return;
    }

    // Forward to the requesting follower, re-chunking if necessary
    const requester = this.followers.get(route.requesterBootstrapId);
    if (requester) {
      sendCDPResponse(requester.sync, requestId, assembled.result, assembled.error);
    }
  }

  // ---------------------------------------------------------------------------
  // Tab open routing
  // ---------------------------------------------------------------------------

  /**
   * Open a tab on a remote runtime from the leader's own code.
   * Returns a promise that resolves with the composite targetId ("{runtimeId}:{localTargetId}").
   */
  openRemoteTab(targetRuntimeId: string, url: string): Promise<string> {
    const targetBootstrapId = this.runtimeToBootstrap.get(targetRuntimeId);
    const targetFollower = targetBootstrapId ? this.followers.get(targetBootstrapId) : undefined;

    if (!targetFollower) {
      return Promise.reject(new Error(`Target runtime "${targetRuntimeId}" not connected`));
    }

    const requestId = `tab-open-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    return new Promise<string>((resolve, reject) => {
      this.tabOpenResolvers.set(requestId, { resolve, reject });
      this.pendingTabOpenRoutes.set(requestId, { requesterBootstrapId: '__leader__', requestId });
      targetFollower.sync.send({ type: 'tab.open', requestId, url });
    });
  }

  /**
   * Execute a tab.open on the leader's own browser transport.
   */
  private async executeLocalTabOpen(requestId: string, url: string, requesterBootstrapId: string): Promise<void> {
    const follower = this.followers.get(requesterBootstrapId);
    if (!follower) return;

    const transport = this.options.browserTransport;
    if (!transport) {
      follower.sync.send({ type: 'tab.open.error', requestId, error: 'Leader has no browser transport' });
      return;
    }

    try {
      const result = await transport.send('Target.createTarget', { url, background: true });
      const targetId = result['targetId'] as string;
      follower.sync.send({ type: 'tab.opened', requestId, targetId: `leader:${targetId}` });
    } catch (err) {
      follower.sync.send({ type: 'tab.open.error', requestId, error: err instanceof Error ? err.message : String(err) });
    }
  }

  /**
   * Forward a tab.open request from one follower to another.
   */
  private forwardTabOpen(requestId: string, targetRuntimeId: string, url: string, requesterBootstrapId: string): void {
    const targetBootstrapId = this.runtimeToBootstrap.get(targetRuntimeId);
    const targetFollower = targetBootstrapId ? this.followers.get(targetBootstrapId) : undefined;
    const requester = this.followers.get(requesterBootstrapId);

    if (!targetFollower) {
      if (requester) {
        requester.sync.send({ type: 'tab.open.error', requestId, error: `Target runtime "${targetRuntimeId}" not connected` });
      }
      return;
    }

    this.pendingTabOpenRoutes.set(requestId, { requesterBootstrapId, requestId });
    targetFollower.sync.send({ type: 'tab.open', requestId, url });
  }

  /**
   * Handle a tab.opened response from a follower.
   */
  private handleTabOpenResponse(requestId: string, targetId: string): void {
    const route = this.pendingTabOpenRoutes.get(requestId);
    if (!route) return;
    this.pendingTabOpenRoutes.delete(requestId);

    if (route.requesterBootstrapId === '__leader__') {
      const resolver = this.tabOpenResolvers.get(requestId);
      if (resolver) {
        this.tabOpenResolvers.delete(requestId);
        resolver.resolve(targetId);
      }
      return;
    }

    const requester = this.followers.get(route.requesterBootstrapId);
    if (requester) {
      requester.sync.send({ type: 'tab.opened', requestId, targetId });
    }
  }

  /**
   * Handle a tab.open.error response from a follower.
   */
  private handleTabOpenError(requestId: string, error: string): void {
    const route = this.pendingTabOpenRoutes.get(requestId);
    if (!route) return;
    this.pendingTabOpenRoutes.delete(requestId);

    if (route.requesterBootstrapId === '__leader__') {
      const resolver = this.tabOpenResolvers.get(requestId);
      if (resolver) {
        this.tabOpenResolvers.delete(requestId);
        resolver.reject(new Error(error));
      }
      return;
    }

    const requester = this.followers.get(route.requesterBootstrapId);
    if (requester) {
      requester.sync.send({ type: 'tab.open.error', requestId, error });
    }
  }

  // ---------------------------------------------------------------------------
  // FS routing
  // ---------------------------------------------------------------------------

  /**
   * Execute an fs request on the leader's own VFS.
   * Sends the response(s) back to the requesting follower.
   */
  private async executeLocalFs(
    requestId: string,
    request: TrayFsRequest,
    requesterBootstrapId: string,
  ): Promise<void> {
    const follower = this.followers.get(requesterBootstrapId);
    if (!follower) return;

    const vfs = this.options.vfs;
    if (!vfs) {
      follower.sync.send({ type: 'fs.response', requestId, response: { ok: false, error: 'Leader has no VFS' } });
      return;
    }

    const responses = await handleFsRequest(vfs, request);
    for (const response of responses) {
      follower.sync.send({ type: 'fs.response', requestId, response });
    }
  }

  /**
   * Forward an fs request from one follower to another follower that owns the target runtime.
   */
  private forwardFsRequest(
    requestId: string,
    targetRuntimeId: string,
    request: TrayFsRequest,
    requesterBootstrapId: string,
  ): void {
    const targetBootstrapId = this.runtimeToBootstrap.get(targetRuntimeId);
    const targetFollower = targetBootstrapId ? this.followers.get(targetBootstrapId) : undefined;
    const requester = this.followers.get(requesterBootstrapId);

    if (!targetFollower) {
      if (requester) {
        requester.sync.send({
          type: 'fs.response',
          requestId,
          response: { ok: false, error: `Target runtime "${targetRuntimeId}" not connected` },
        });
      }
      return;
    }

    // Track the pending route so we can return the response to the requester
    this.pendingFsRoutes.set(requestId, { requesterBootstrapId, requestId, chunks: [], totalChunks: 1 });

    // Forward to the target follower
    targetFollower.sync.send({ type: 'fs.request', requestId, request });
  }

  /**
   * Handle an fs response from a follower (forwarding back to the original requester).
   * Supports chunked responses — accumulates chunks and forwards each one.
   */
  private handleFsResponse(requestId: string, response: TrayFsResponse): void {
    const route = this.pendingFsRoutes.get(requestId);
    if (!route) {
      // Check if this is for a leader-originated request
      const resolver = this.fsResolvers.get(requestId);
      if (resolver) {
        resolver.responses.push(response);
        const totalChunks = (response.ok && response.totalChunks) || 1;
        if (resolver.responses.length >= totalChunks) {
          this.fsResolvers.delete(requestId);
          resolver.resolve(resolver.responses);
        }
      }
      return;
    }

    // Route to the leader's own fsResolvers if the requester is the leader itself
    if (route.requesterBootstrapId === '__leader__') {
      const resolver = this.fsResolvers.get(requestId);
      if (resolver) {
        resolver.responses.push(response);
        const totalChunks = (response.ok && response.totalChunks) || 1;
        if (resolver.responses.length >= totalChunks) {
          this.fsResolvers.delete(requestId);
          this.pendingFsRoutes.delete(requestId);
          resolver.resolve(resolver.responses);
        }
      }
      return;
    }

    const requester = this.followers.get(route.requesterBootstrapId);
    if (requester) {
      requester.sync.send({ type: 'fs.response', requestId, response });
    }

    // Track chunks and clean up route when all chunks received
    route.chunks.push(response);
    const totalChunks = (response.ok && response.totalChunks) || 1;
    route.totalChunks = totalChunks;
    if (route.chunks.length >= route.totalChunks) {
      this.pendingFsRoutes.delete(requestId);
    }
  }

  /**
   * Send an fs request to a remote runtime from the leader's own code.
   * Returns a promise that resolves with the response(s).
   */
  sendFsRequest(targetRuntimeId: string, request: TrayFsRequest): Promise<TrayFsResponse[]> {
    if (targetRuntimeId === 'leader') {
      const vfs = this.options.vfs;
      if (!vfs) return Promise.resolve([{ ok: false, error: 'Leader has no VFS' }]);
      return handleFsRequest(vfs, request);
    }

    const targetBootstrapId = this.runtimeToBootstrap.get(targetRuntimeId);
    const targetFollower = targetBootstrapId ? this.followers.get(targetBootstrapId) : undefined;

    if (!targetFollower) {
      return Promise.resolve([{ ok: false, error: `Target runtime "${targetRuntimeId}" not connected` }]);
    }

    const requestId = `fs-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    return new Promise<TrayFsResponse[]>((resolve, reject) => {
      this.fsResolvers.set(requestId, { resolve, reject, responses: [] });
      this.pendingFsRoutes.set(requestId, { requesterBootstrapId: '__leader__', requestId, chunks: [], totalChunks: 1 });
      targetFollower.sync.send({ type: 'fs.request', requestId, request });
    });
  }

  // ---------------------------------------------------------------------------
  // Cookie teleport routing
  // ---------------------------------------------------------------------------

  /**
   * Execute a cookie teleport on the leader's own browser transport.
   * Captures all cookies and sends them back to the requesting follower.
   */
  private async executeLocalCookieTeleport(requestId: string, requesterBootstrapId: string): Promise<void> {
    const follower = this.followers.get(requesterBootstrapId);
    if (!follower) return;

    const browserAPI = this.options.browserAPI;
    const transport = this.options.browserTransport;
    if (!browserAPI && !transport) {
      follower.sync.send({ type: 'cookie.teleport.response', requestId, error: 'Leader has no browser transport' });
      return;
    }

    try {
      if (browserAPI) {
        // Use BrowserAPI to get a proper session for Network.getCookies
        const pages = await browserAPI.listPages();
        const target = pages.find(p => p.url && !p.url.startsWith('about:') && !p.url.includes('/preview/'))
          ?? pages[0];
        if (!target) {
          follower.sync.send({ type: 'cookie.teleport.response', requestId, error: 'No browser tab available for cookie capture' });
          return;
        }
        await browserAPI.attachToPage(target.targetId);
        const result = await browserAPI.sendCDP('Network.getCookies');
        const cookies = (result['cookies'] as CookieTeleportCookie[]) ?? [];
        follower.sync.send({ type: 'cookie.teleport.response', requestId, cookies });
      } else {
        // Fallback to raw transport (will likely fail with -32601)
        const result = await transport!.send('Network.getCookies', {});
        const cookies = (result['cookies'] as CookieTeleportCookie[]) ?? [];
        follower.sync.send({ type: 'cookie.teleport.response', requestId, cookies });
      }
    } catch (err) {
      follower.sync.send({ type: 'cookie.teleport.response', requestId, error: err instanceof Error ? err.message : String(err) });
    }
  }

  /**
   * Forward a cookie teleport request from one follower to another.
   */
  private forwardCookieTeleportRequest(requestId: string, targetRuntimeId: string, requesterBootstrapId: string, url?: string, catchPattern?: string, catchNotPattern?: string, timeoutMs?: number): void {
    const targetBootstrapId = this.runtimeToBootstrap.get(targetRuntimeId);
    const targetFollower = targetBootstrapId ? this.followers.get(targetBootstrapId) : undefined;
    const requester = this.followers.get(requesterBootstrapId);

    if (!targetFollower) {
      if (requester) {
        requester.sync.send({ type: 'cookie.teleport.response', requestId, error: `Target runtime "${targetRuntimeId}" not connected` });
      }
      return;
    }

    log.info('[teleport-debug] forwarding cookie.teleport.request', { requestId, targetRuntimeId, url, catchPattern, catchNotPattern, timeoutMs });
    this.pendingCookieTeleportRoutes.set(requestId, { requesterBootstrapId, requestId });
    targetFollower.sync.send({ type: 'cookie.teleport.request', requestId, url, catchPattern, catchNotPattern, timeoutMs });
  }

  /**
   * Handle a cookie teleport response from a follower (forwarding back to the original requester).
   */
  private handleCookieTeleportResponse(requestId: string, cookies?: CookieTeleportCookie[], error?: string, timedOut?: boolean, finalUrl?: string): void {
    const route = this.pendingCookieTeleportRoutes.get(requestId);
    if (!route) {
      // Check if this is for a leader-originated request
      const resolver = this.cookieTeleportResolvers.get(requestId);
      if (resolver) {
        this.cookieTeleportResolvers.delete(requestId);
        if (error) {
          resolver.reject(new Error(error));
        } else {
          resolver.resolve({ cookies: cookies ?? [], timedOut, finalUrl });
        }
      }
      return;
    }

    this.pendingCookieTeleportRoutes.delete(requestId);

    if (route.requesterBootstrapId === '__leader__') {
      const resolver = this.cookieTeleportResolvers.get(requestId);
      if (resolver) {
        this.cookieTeleportResolvers.delete(requestId);
        if (error) {
          resolver.reject(new Error(error));
        } else {
          resolver.resolve({ cookies: cookies ?? [], timedOut, finalUrl });
        }
      }
      return;
    }

    const requester = this.followers.get(route.requesterBootstrapId);
    if (requester) {
      requester.sync.send({ type: 'cookie.teleport.response', requestId, cookies, error, timedOut, finalUrl });
    }
  }

  /**
   * Send a cookie teleport request to a remote runtime from the leader's own code.
   * Returns a promise that resolves with the cookies from the target runtime.
   * If `url` is provided, the follower opens a tab for the human to authenticate before capturing cookies.
   */
  sendCookieTeleportRequest(targetRuntimeId: string, url?: string, catchPattern?: string, catchNotPattern?: string, timeoutMs?: number): Promise<{ cookies: CookieTeleportCookie[]; timedOut?: boolean; finalUrl?: string }> {
    const targetBootstrapId = this.runtimeToBootstrap.get(targetRuntimeId);
    const targetFollower = targetBootstrapId ? this.followers.get(targetBootstrapId) : undefined;

    if (!targetFollower) {
      return Promise.reject(new Error(`Target runtime "${targetRuntimeId}" not connected`));
    }

    const requestId = `cookie-teleport-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    return new Promise<{ cookies: CookieTeleportCookie[]; timedOut?: boolean; finalUrl?: string }>((resolve, reject) => {
      this.cookieTeleportResolvers.set(requestId, { resolve, reject });
      log.info('[teleport-debug] sending cookie.teleport.request to follower', { requestId, url, catchPattern, catchNotPattern, timeoutMs, targetRuntimeId });
      this.pendingCookieTeleportRoutes.set(requestId, { requesterBootstrapId: '__leader__', requestId });
      targetFollower.sync.send({ type: 'cookie.teleport.request', requestId, url, catchPattern, catchNotPattern, timeoutMs });
    });
  }
}
