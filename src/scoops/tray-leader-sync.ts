/**
 * Leader sync manager — broadcasts agent events and snapshots to followers
 * over WebRTC data channels using the typed tray sync protocol.
 */

import type { AgentEvent, ChatMessage } from '../ui/types.js';
import type { TrayDataChannelLike } from './tray-webrtc.js';
import {
  createLeaderSyncChannel,
  type LeaderToFollowerMessage,
  type FollowerToLeaderMessage,
  type TraySyncChannel,
  type RemoteTargetInfo,
  type TrayTargetEntry,
} from './tray-sync-protocol.js';
import { TrayTargetRegistry } from './tray-target-registry.js';
import type { CDPTransport } from '../cdp/transport.js';
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
  /** Called when a follower's data channel is considered dead (missed keepalive pongs). */
  onFollowerDead?: (bootstrapId: string) => void;
}

interface ConnectedFollower {
  bootstrapId: string;
  sync: TraySyncChannel<LeaderToFollowerMessage, FollowerToLeaderMessage>;
  unsubscribe: () => void;
  keepalive: DataChannelKeepalive;
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

export class LeaderSyncManager {
  private readonly followers = new Map<string, ConnectedFollower>();
  private readonly registry = new TrayTargetRegistry();
  /** Maps runtimeId → bootstrapId so we can clean up registry on disconnect. */
  private readonly runtimeToBootstrap = new Map<string, string>();
  /** Maps requestId → routing info for CDP requests in flight through the leader. */
  private readonly pendingCDPRoutes = new Map<string, PendingCDPRoute>();
  /** Active RemoteCDPTransport instances for the leader's own BrowserAPI (keyed by runtimeId:localTargetId). */
  private readonly remoteTransports = new Map<string, RemoteCDPTransport>();
  /** Maps requestId → routing info for tab.open requests in flight through the leader. */
  private readonly pendingTabOpenRoutes = new Map<string, PendingTabOpenRoute>();
  /** Resolvers for leader-originated tab.open requests. */
  private readonly tabOpenResolvers = new Map<string, { resolve: (targetId: string) => void; reject: (err: Error) => void }>();

  constructor(private readonly options: LeaderSyncManagerOptions) {}

  /**
   * Add a connected follower's data channel.
   * Sends an initial snapshot and subscribes to follower messages.
   */
  addFollower(bootstrapId: string, channel: TrayDataChannelLike): void {
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

    this.followers.set(bootstrapId, { bootstrapId, sync, unsubscribe, keepalive });
    log.info('Follower added to sync', { bootstrapId, followerCount: this.followers.size });

    // Send initial snapshot
    this.sendSnapshot(bootstrapId);

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
   */
  private sendSnapshot(bootstrapId: string): void {
    const follower = this.followers.get(bootstrapId);
    if (!follower) return;
    const messages = this.options.getMessages();
    const scoopJid = this.options.getScoopJid();
    follower.sync.send({ type: 'snapshot', messages, scoopJid });
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
        this.sendSnapshot(bootstrapId);
        break;
      case 'targets.advertise':
        log.info('Follower targets advertised', { bootstrapId, runtimeId: message.runtimeId, targetCount: message.targets.length });
        this.runtimeToBootstrap.set(message.runtimeId, bootstrapId);
        this.registry.setTargets(message.runtimeId, message.targets);
        this.broadcastTargetRegistry();
        break;
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
        this.handleCDPResponse(message.requestId, message.result, message.error);
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
      case 'ping': {
        // Follower is pinging us — respond with pong and treat as liveness signal
        const follower = this.followers.get(bootstrapId);
        if (follower) {
          follower.keepalive.receivePing();
          follower.sync.send({ type: 'pong' });
        }
        break;
      }
      case 'pong': {
        // Follower responded to our ping
        const follower = this.followers.get(bootstrapId);
        if (follower) {
          follower.keepalive.receivePong();
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
   * Return the list of connected follower runtimeIds.
   */
  getConnectedFollowers(): { runtimeId: string }[] {
    return [...this.runtimeToBootstrap.keys()].map(runtimeId => ({ runtimeId }));
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
   * Sends the response back to the requesting follower.
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
      follower.sync.send({ type: 'cdp.response', requestId, result });
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
   */
  private handleCDPResponse(requestId: string, result?: Record<string, unknown>, error?: string): void {
    const route = this.pendingCDPRoutes.get(requestId);
    if (!route) return;
    this.pendingCDPRoutes.delete(requestId);

    // Route to the leader's own RemoteCDPTransport if the requester is the leader itself
    if (route.requesterBootstrapId === '__leader__') {
      for (const transport of this.remoteTransports.values()) {
        transport.handleResponse(requestId, result, error);
      }
      return;
    }

    const requester = this.followers.get(route.requesterBootstrapId);
    if (requester) {
      requester.sync.send({ type: 'cdp.response', requestId, result, error });
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
}
