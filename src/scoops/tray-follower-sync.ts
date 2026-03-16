/**
 * Follower sync manager — receives agent events from the leader over WebRTC
 * and provides an AgentHandle for the follower's ChatPanel.
 */

import type { AgentEvent, AgentHandle, ChatMessage } from '../ui/types.js';
import type { TrayDataChannelLike } from './tray-webrtc.js';
import {
  createFollowerSyncChannel,
  type LeaderToFollowerMessage,
  type FollowerToLeaderMessage,
  type TraySyncChannel,
  type RemoteTargetInfo,
  type TrayTargetEntry,
} from './tray-sync-protocol.js';
import type { CDPTransport } from '../cdp/transport.js';
import { RemoteCDPTransport, type RemoteCDPSender } from '../cdp/remote-cdp-transport.js';
import { DataChannelKeepalive } from './data-channel-keepalive.js';
import { setFollowerTrayRuntimeStatus, getFollowerTrayRuntimeStatus, setFollowerLastPingTime } from './tray-follower-status.js';
import { createLogger } from '../core/logger.js';

const log = createLogger('tray-follower-sync');

export interface FollowerSyncManagerOptions {
  /** Called when the leader sends a snapshot (full state replacement). */
  onSnapshot?: (messages: ChatMessage[], scoopJid: string) => void;
  /** Called when the leader echoes a user message (local or from any follower). */
  onUserMessage?: (text: string, messageId: string, scoopJid: string) => void;
  /** Called when the leader sends a status update. */
  onStatus?: (scoopStatus: string) => void;
  /** Called when the leader sends an updated target registry. */
  onTargetsUpdated?: (targets: TrayTargetEntry[]) => void;
  /** Optional CDP transport for executing local CDP commands (follower's browser). */
  browserTransport?: CDPTransport;
  /** Called when the leader data channel is considered dead (missed keepalive pongs). */
  onDead?: () => void;
  /** Called after the connection has been cleaned up due to keepalive death or channel failure. Higher-level code can use this to trigger reconnection. */
  onDisconnect?: (reason: string) => void;
}

/**
 * FollowerSyncManager wraps a WebRTC data channel and implements AgentHandle
 * so the follower's ChatPanel can subscribe to events without knowing
 * it's talking to a remote leader instead of a local orchestrator.
 */
export class FollowerSyncManager implements AgentHandle {
  private readonly sync: TraySyncChannel<FollowerToLeaderMessage, LeaderToFollowerMessage>;
  private readonly eventListeners = new Set<(event: AgentEvent) => void>();
  private readonly unsubscribe: () => void;
  private readonly keepalive: DataChannelKeepalive;
  private latestSnapshot: { messages: ChatMessage[]; scoopJid: string } | null = null;
  private readonly sentMessageIds = new Set<string>();
  private targetEntries: TrayTargetEntry[] = [];
  /** Active RemoteCDPTransport instances keyed by requestId prefix for response routing. */
  private readonly remoteTransports = new Map<string, RemoteCDPTransport>();
  /** Resolvers for outgoing tab.open requests. */
  private readonly tabOpenResolvers = new Map<string, { resolve: (targetId: string) => void; reject: (err: Error) => void }>();

  constructor(
    channel: TrayDataChannelLike,
    private readonly options: FollowerSyncManagerOptions = {},
  ) {
    this.sync = createFollowerSyncChannel(channel);
    this.unsubscribe = this.sync.onMessage((message: LeaderToFollowerMessage) => {
      this.handleLeaderMessage(message);
    });
    this.keepalive = new DataChannelKeepalive({
      sendPing: () => this.sync.send({ type: 'ping' }),
      onDead: () => {
        log.warn('Leader keepalive dead, cleaning up');
        this.handleDisconnect('Keepalive timeout — leader not responding');
        this.options.onDead?.();
      },
    });
    this.keepalive.start();
    // Emit an error event when the underlying channel drops
    channel.addEventListener('close', () => {
      log.warn('Data channel closed');
      this.handleDisconnect('Data channel closed');
    });
    channel.addEventListener('error', () => {
      log.warn('Data channel error');
      this.handleDisconnect('Data channel error');
    });
  }

  // ---------------------------------------------------------------------------
  // AgentHandle implementation
  // ---------------------------------------------------------------------------

  sendMessage(text: string, messageId?: string): void {
    const id = messageId ?? `follower-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.sentMessageIds.add(id);
    this.sync.send({ type: 'user_message', text, messageId: id });
    log.info('Sent user message to leader', { messageId: id });
  }

  onEvent(callback: (event: AgentEvent) => void): () => void {
    this.eventListeners.add(callback);
    return () => this.eventListeners.delete(callback);
  }

  stop(): void {
    this.sync.send({ type: 'abort' });
    log.info('Sent abort to leader');
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /** Request a fresh snapshot from the leader. */
  requestSnapshot(): void {
    this.sync.send({ type: 'request_snapshot' });
  }

  /** Get the latest snapshot received from the leader, if any. */
  getLatestSnapshot(): { messages: ChatMessage[]; scoopJid: string } | null {
    return this.latestSnapshot;
  }

  /** Close the sync channel and clean up. */
  close(): void {
    this.keepalive.stop();
    this.unsubscribe();
    this.sync.close();
    this.eventListeners.clear();
    log.info('Follower sync closed');
  }

  /** Advertise local browser targets to the leader. */
  advertiseTargets(targets: RemoteTargetInfo[], runtimeId: string): void {
    this.sync.send({ type: 'targets.advertise', targets, runtimeId });
  }

  /** Get the stored target registry entries from the leader. */
  getTargets(): TrayTargetEntry[] {
    return this.targetEntries;
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private disconnected = false;

  /**
   * Handle a detected disconnect (keepalive dead, channel close/error).
   * Updates follower status, emits an error event, cleans up, and notifies via onDisconnect.
   */
  private handleDisconnect(reason: string): void {
    if (this.disconnected) return; // prevent duplicate cleanup
    this.disconnected = true;

    // Update follower runtime status to error
    const current = getFollowerTrayRuntimeStatus();
    setFollowerTrayRuntimeStatus({
      ...current,
      state: 'error',
      error: reason,
    });

    // Emit error to UI listeners
    this.emitEvent({ type: 'error', error: `Connection to leader lost: ${reason}` });

    // Clean up keepalive and sync channel
    this.keepalive.stop();
    this.unsubscribe();
    this.sync.close();

    // Notify higher-level code for potential reconnection
    this.options.onDisconnect?.(reason);
  }

  private handleLeaderMessage(message: LeaderToFollowerMessage): void {
    switch (message.type) {
      case 'snapshot':
        log.info('Snapshot received from leader', { messageCount: message.messages.length, scoopJid: message.scoopJid });
        this.latestSnapshot = { messages: message.messages, scoopJid: message.scoopJid };
        this.options.onSnapshot?.(message.messages, message.scoopJid);
        break;

      case 'agent_event':
        this.emitEvent(message.event);
        break;

      case 'user_message_echo':
        if (this.sentMessageIds.has(message.messageId)) {
          this.sentMessageIds.delete(message.messageId);
          log.debug('Skipping own message echo', { messageId: message.messageId });
          break;
        }
        log.info('User message echo received', { messageId: message.messageId, scoopJid: message.scoopJid });
        this.options.onUserMessage?.(message.text, message.messageId, message.scoopJid);
        break;

      case 'status':
        this.options.onStatus?.(message.scoopStatus);
        break;

      case 'error':
        log.warn('Error from leader', { error: message.error });
        this.emitEvent({ type: 'error', error: message.error });
        break;

      case 'targets.registry':
        log.info('Target registry received from leader', { targetCount: message.targets.length });
        this.targetEntries = message.targets;
        this.options.onTargetsUpdated?.(this.targetEntries);
        break;

      case 'cdp.request': {
        const { requestId, localTargetId, method, params, sessionId } = message;
        this.executeLocalCDP(requestId, localTargetId, method, params, sessionId);
        break;
      }

      case 'cdp.response': {
        this.routeCDPResponse(message.requestId, message.result, message.error);
        break;
      }
      case 'tab.open': {
        this.executeLocalTabOpen(message.requestId, message.url);
        break;
      }
      case 'tab.opened': {
        const resolver = this.tabOpenResolvers.get(message.requestId);
        if (resolver) {
          this.tabOpenResolvers.delete(message.requestId);
          resolver.resolve(message.targetId);
        }
        break;
      }
      case 'tab.open.error': {
        const resolver = this.tabOpenResolvers.get(message.requestId);
        if (resolver) {
          this.tabOpenResolvers.delete(message.requestId);
          resolver.reject(new Error(message.error));
        }
        break;
      }
      case 'ping': {
        // Leader is pinging us — respond with pong and treat as liveness signal
        this.keepalive.receivePing();
        this.sync.send({ type: 'pong' });
        break;
      }
      case 'pong': {
        // Leader responded to our ping
        this.keepalive.receivePong();
        setFollowerLastPingTime(Date.now());
        break;
      }
    }
  }

  private emitEvent(event: AgentEvent): void {
    for (const cb of this.eventListeners) {
      try {
        cb(event);
      } catch (err) {
        log.error('Listener error', { eventType: event.type, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // CDP routing
  // ---------------------------------------------------------------------------

  /**
   * Create a RemoteCDPTransport that routes CDP commands to a remote runtime
   * via the leader data channel.
   */
  createRemoteTransport(targetRuntimeId: string, localTargetId: string): RemoteCDPTransport {
    const sender: RemoteCDPSender = {
      sendCDPRequest: (requestId, method, params, sessionId) => {
        this.sync.send({
          type: 'cdp.request',
          requestId,
          targetRuntimeId,
          localTargetId,
          method,
          params,
          sessionId,
        });
      },
    };
    const transport = new RemoteCDPTransport(sender);
    this.remoteTransports.set(`${targetRuntimeId}:${localTargetId}`, transport);
    return transport;
  }

  /**
   * Remove a remote transport when no longer needed.
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
   * Open a tab on a remote runtime via the leader.
   * Returns a promise that resolves with the composite targetId ("{runtimeId}:{localTargetId}").
   */
  openRemoteTab(targetRuntimeId: string, url: string): Promise<string> {
    const requestId = `tab-open-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    return new Promise<string>((resolve, reject) => {
      this.tabOpenResolvers.set(requestId, { resolve, reject });
      this.sync.send({ type: 'tab.open', requestId, targetRuntimeId, url });
    });
  }

  /**
   * Execute a tab.open on the follower's local browser transport.
   * Sends tab.opened or tab.open.error back to the leader.
   */
  private async executeLocalTabOpen(requestId: string, url: string): Promise<void> {
    const transport = this.options.browserTransport;
    if (!transport) {
      this.sync.send({ type: 'tab.open.error', requestId, error: 'Follower has no browser transport' });
      return;
    }

    try {
      const result = await transport.send('Target.createTarget', { url, background: true });
      const targetId = result['targetId'] as string;
      this.sync.send({ type: 'tab.opened', requestId, targetId });
    } catch (err) {
      this.sync.send({ type: 'tab.open.error', requestId, error: err instanceof Error ? err.message : String(err) });
    }
  }

  /**
   * Execute a CDP command on the follower's local browser transport.
   * Sends the response back to the leader.
   */
  private async executeLocalCDP(
    requestId: string,
    localTargetId: string,
    method: string,
    params: Record<string, unknown> | undefined,
    sessionId: string | undefined,
  ): Promise<void> {
    const transport = this.options.browserTransport;
    if (!transport) {
      this.sync.send({ type: 'cdp.response', requestId, error: 'Follower has no browser transport' });
      return;
    }

    try {
      const result = await transport.send(method, params, sessionId);
      this.sync.send({ type: 'cdp.response', requestId, result });
    } catch (err) {
      this.sync.send({ type: 'cdp.response', requestId, error: err instanceof Error ? err.message : String(err) });
    }
  }

  /**
   * Route a CDP response from the leader to the appropriate RemoteCDPTransport.
   */
  private routeCDPResponse(requestId: string, result?: Record<string, unknown>, error?: string): void {
    // Find the transport that has this pending request by checking all transports
    for (const transport of this.remoteTransports.values()) {
      transport.handleResponse(requestId, result, error);
    }
  }
}
