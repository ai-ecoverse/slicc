/**
 * Follower sync manager — receives agent events from the leader over WebRTC
 * and provides an AgentHandle for the follower's ChatPanel.
 */

import type { AgentEvent, AgentHandle, ChatMessage } from '../ui/types.js';
import { stripLocalPathsForRemote } from '../core/attachments.js';
import type { MessageAttachment } from '../core/attachments.js';
import type { TrayDataChannelLike } from './tray-webrtc.js';
import {
  createFollowerSyncChannel,
  sendCDPResponse,
  reassembleCDPResponse,
  reassembleSnapshot,
  type LeaderToFollowerMessage,
  type FollowerToLeaderMessage,
  type TraySyncChannel,
  type RemoteTargetInfo,
  type TrayTargetEntry,
  type TrayFsRequest,
  type TrayFsResponse,
  type SprinkleSummary,
} from './tray-sync-protocol.js';
import { handleFsRequest } from './tray-fs-handler.js';
import type { VirtualFS } from '../fs/virtual-fs.js';
import type { CDPTransport } from '../cdp/transport.js';
import type { BrowserAPI } from '../cdp/browser-api.js';
import { RemoteCDPTransport, type RemoteCDPSender } from '../cdp/remote-cdp-transport.js';
import { DataChannelKeepalive } from './data-channel-keepalive.js';
import {
  setFollowerTrayRuntimeStatus,
  getFollowerTrayRuntimeStatus,
  setFollowerLastPingTime,
} from './tray-follower-status.js';
import { createLogger } from '../core/logger.js';

const log = createLogger('tray-follower-sync');

export interface FollowerSyncManagerOptions {
  /** Called when the leader sends a snapshot (full state replacement). */
  onSnapshot?: (messages: ChatMessage[], scoopJid: string) => void;
  /** Called when the leader echoes a user message (local or from any follower). */
  onUserMessage?: (
    text: string,
    messageId: string,
    scoopJid: string,
    attachments?: MessageAttachment[]
  ) => void;
  /** Called when the leader sends a status update. */
  onStatus?: (scoopStatus: string) => void;
  /** Called when the leader sends an updated target registry. */
  onTargetsUpdated?: (targets: TrayTargetEntry[]) => void;
  /** Optional CDP transport for executing local CDP commands (follower's browser). */
  browserTransport?: CDPTransport;
  /** Optional BrowserAPI instance for session-aware browser commands (e.g. cookie capture). */
  browserAPI?: BrowserAPI;
  /** Called when the leader data channel is considered dead (missed keepalive pongs). */
  onDead?: () => void;
  /** Called after the connection has been cleaned up due to keepalive death or channel failure. Higher-level code can use this to trigger reconnection. */
  onDisconnect?: (reason: string) => void;
  /** VirtualFS instance for handling remote fs requests targeting this follower. */
  vfs?: VirtualFS;
  /** Called when local browser targets may have changed (e.g. after a tab is opened or closed). */
  onTargetsChanged?: () => void;
  /** Called when the leader sends an updated sprinkle list. */
  onSprinklesList?: (sprinkles: SprinkleSummary[]) => void;
  /** Called when the leader sends a `sprinkle.update` payload (mirrors `SprinkleManager.sendToSprinkle`). */
  onSprinkleUpdate?: (sprinkleName: string, data: unknown) => void;
}

/** Internal buffer for chunked sprinkle.content reassembly. Mirrors the
 *  private `SprinkleFetchBuffer` struct in `packages/ios-app/SliccFollower/
 *  App/AppState.swift` (defined as a fileprivate type inside the `AppState`
 *  class). */
interface SprinkleFetchBuffer {
  sprinkleName: string;
  chunks: Map<number, string>;
  totalChunks: number;
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
  /** Chunk buffers for reassembling chunked CDP responses from the leader. */
  private readonly cdpChunkBuffers = new Map<
    string,
    { chunks: string[]; received: number; totalChunks: number }
  >();
  /** Buffer for reassembling chunked snapshots from the leader. */
  private snapshotChunkBuffer: { chunks: string[]; received: number; totalChunks: number } | null =
    null;
  /** CDP sessions initiated by remote requests (leader attached to follower tabs). Events for these sessions are forwarded. */
  private readonly remoteCDPSessions = new Set<string>();
  /** Cleanup functions for CDP event listeners registered on the local transport. */
  private readonly cdpEventCleanups: Array<() => void> = [];
  /** Resolvers for outgoing tab.open requests. */
  private readonly tabOpenResolvers = new Map<
    string,
    { resolve: (targetId: string) => void; reject: (err: Error) => void }
  >();
  /** Resolvers for outgoing fs requests. */
  private readonly fsResolvers = new Map<
    string,
    {
      resolve: (responses: TrayFsResponse[]) => void;
      reject: (err: Error) => void;
      responses: TrayFsResponse[];
    }
  >();
  /** Latest sprinkle summaries received from the leader (most-recent `sprinkles.list`). */
  private latestSprinkles: SprinkleSummary[] = [];
  /** Cache of resolved sprinkle .shtml content by name. Cleared on explicit invalidate. */
  private readonly sprinkleContentCache = new Map<string, string>();
  /** In-flight `sprinkle.fetch` request buffers, keyed by requestId. */
  private readonly pendingSprinkleFetches = new Map<string, SprinkleFetchBuffer>();
  /** Map of sprinkleName → requestId for the in-flight fetch (used to dedupe concurrent calls). */
  private readonly inflightSprinkleByName = new Map<string, string>();
  /** Waiters awaiting a sprinkle.content reply, keyed by sprinkleName. */
  private readonly sprinkleContentWaiters = new Map<
    string,
    Array<{ resolve: (content: string) => void; reject: (err: Error) => void }>
  >();
  constructor(
    channel: TrayDataChannelLike,
    private readonly options: FollowerSyncManagerOptions = {}
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

  sendMessage(text: string, messageId?: string, attachments?: MessageAttachment[]): void {
    const id = messageId ?? `follower-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.sentMessageIds.add(id);
    // Off-loaded `path` values point at this follower's VFS — they are
    // not reachable from the leader. Strip them (preserving inline
    // text/data) so the cone never sees a stale path it cannot read.
    const safeAttachments = attachments?.length
      ? stripLocalPathsForRemote(attachments)
      : attachments;
    this.sync.send({
      type: 'user_message',
      text,
      messageId: id,
      attachments: safeAttachments,
    });
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
    this.cleanupCDPEventForwarding();
    this.rejectPendingSprinkleFetches('Follower sync closed');
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
  // Sprinkle sync — mirrors `packages/ios-app/SliccFollower/App/AppState.swift`
  // (refreshSprinkles / fetchSprinkleContent / sendSprinkleLick / chunked
  // sprinkle.content reassembly + concurrent-fetch dedupe via waiter list).
  // ---------------------------------------------------------------------------

  /** Latest sprinkle list received from the leader. */
  getSprinkles(): SprinkleSummary[] {
    return this.latestSprinkles;
  }

  /** Ask the leader to re-broadcast the sprinkle list. */
  refreshSprinkles(): void {
    this.sync.send({ type: 'sprinkles.refresh' });
  }

  /**
   * Fetch the raw .shtml content for a sprinkle. Returns cached content when
   * available, otherwise sends `sprinkle.fetch` and awaits the reassembled
   * `sprinkle.content` response. Concurrent calls for the same sprinkle name
   * share a single inflight request and resolve together.
   */
  fetchSprinkleContent(sprinkleName: string): Promise<string> {
    const cached = this.sprinkleContentCache.get(sprinkleName);
    if (cached !== undefined) return Promise.resolve(cached);

    return new Promise<string>((resolve, reject) => {
      const waiters = this.sprinkleContentWaiters.get(sprinkleName) ?? [];
      waiters.push({ resolve, reject });
      this.sprinkleContentWaiters.set(sprinkleName, waiters);

      // Only one in-flight request per name. Subsequent calls latch onto the
      // same waiter list.
      if (this.inflightSprinkleByName.has(sprinkleName)) return;

      const requestId = `sprinkle-fetch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      this.inflightSprinkleByName.set(sprinkleName, requestId);
      this.pendingSprinkleFetches.set(requestId, {
        sprinkleName,
        chunks: new Map(),
        totalChunks: 1,
      });
      this.sync.send({ type: 'sprinkle.fetch', requestId, sprinkleName });
    });
  }

  /** Forward a sprinkle lick (from a follower-rendered sprinkle) to the leader. */
  sendSprinkleLick(sprinkleName: string, body: unknown, targetScoop?: string): void {
    this.sync.send({ type: 'sprinkle.lick', sprinkleName, body, targetScoop });
  }

  /** Invalidate the cached .shtml content for one sprinkle (or all). */
  clearSprinkleCache(sprinkleName?: string): void {
    if (sprinkleName === undefined) this.sprinkleContentCache.clear();
    else this.sprinkleContentCache.delete(sprinkleName);
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

    // Clean up keepalive, CDP event forwarding, and sync channel
    this.keepalive.stop();
    this.cleanupCDPEventForwarding();
    this.unsubscribe();
    this.sync.close();
    this.rejectPendingSprinkleFetches(`Follower sync disconnected: ${reason}`);

    // Notify higher-level code for potential reconnection
    this.options.onDisconnect?.(reason);
  }

  private handleLeaderMessage(message: LeaderToFollowerMessage): void {
    switch (message.type) {
      case 'snapshot':
        log.info('Snapshot received from leader', {
          messageCount: message.messages.length,
          scoopJid: message.scoopJid,
        });
        this.snapshotChunkBuffer = null; // Clear any in-progress chunked snapshot
        this.latestSnapshot = { messages: message.messages, scoopJid: message.scoopJid };
        this.options.onSnapshot?.(message.messages, message.scoopJid);
        break;

      case 'snapshot_chunk': {
        const assembled = reassembleSnapshot(this.snapshotChunkBuffer, message);
        this.snapshotChunkBuffer = assembled.buffer;
        if (assembled.result) {
          log.info('Chunked snapshot reassembled from leader', {
            messageCount: assembled.result.messages.length,
            scoopJid: assembled.result.scoopJid,
          });
          this.latestSnapshot = assembled.result;
          this.options.onSnapshot?.(assembled.result.messages, assembled.result.scoopJid);
        }
        break;
      }

      case 'agent_event':
        this.emitEvent(message.event);
        break;

      case 'user_message_echo':
        if (this.sentMessageIds.has(message.messageId)) {
          this.sentMessageIds.delete(message.messageId);
          log.debug('Skipping own message echo', { messageId: message.messageId });
          break;
        }
        log.info('User message echo received', {
          messageId: message.messageId,
          scoopJid: message.scoopJid,
        });
        this.options.onUserMessage?.(
          message.text,
          message.messageId,
          message.scoopJid,
          message.attachments
        );
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
        this.routeCDPResponse(message);
        break;
      }
      case 'cdp.event': {
        // Route CDP events from the leader to the appropriate RemoteCDPTransport
        for (const transport of this.remoteTransports.values()) {
          transport.handleEvent(message.method, message.params);
        }
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
      case 'fs.request': {
        this.executeLocalFs(message.requestId, message.request);
        break;
      }
      case 'fs.response': {
        this.routeFsResponse(message.requestId, message.response);
        break;
      }
      case 'sprinkles.list':
        log.info('Sprinkles list received from leader', {
          sprinkleCount: message.sprinkles.length,
        });
        this.latestSprinkles = message.sprinkles;
        this.options.onSprinklesList?.(message.sprinkles);
        break;

      case 'sprinkle.content':
        this.handleSprinkleContent(message);
        break;

      case 'sprinkle.update':
        log.debug('Sprinkle update received', { sprinkleName: message.sprinkleName });
        this.options.onSprinkleUpdate?.(message.sprinkleName, message.data);
        break;

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
      default: {
        // Protocol drift safety net — mirrors the iOS follower's explicit
        // `.unknown` case (`AppState.swift`). If the leader emits a new
        // message type that this follower hasn't been updated to handle,
        // log once and ignore rather than throwing or silently dropping.
        log.debug('Unknown leader message type', {
          type: (message as { type?: string }).type,
        });
        break;
      }
    }
  }

  /**
   * Reassemble chunked `sprinkle.content` responses and resolve the waiting
   * fetchers. Mirrors `handleSprinkleContent` in iOS `AppState.swift` — same
   * chunk-buffer + ordered-join + waiter-resolve flow, plus error rejection.
   */
  private handleSprinkleContent(
    message: LeaderToFollowerMessage & { type: 'sprinkle.content' }
  ): void {
    const { requestId, sprinkleName, content, chunkIndex, totalChunks, error } = message;

    if (error) {
      log.warn('sprinkle.content error from leader', { sprinkleName, error });
      this.pendingSprinkleFetches.delete(requestId);
      this.inflightSprinkleByName.delete(sprinkleName);
      const waiters = this.sprinkleContentWaiters.get(sprinkleName) ?? [];
      this.sprinkleContentWaiters.delete(sprinkleName);
      for (const waiter of waiters) waiter.reject(new Error(error));
      return;
    }

    // Both chunked and non-chunked paths require an outstanding fetch — a
    // delivery for an unknown requestId is either a late post-disconnect
    // arrival or a misbehaving leader. Drop silently in both cases; the
    // previous chunked-branch behavior (auto-create a buffer) could let an
    // unsolicited payload poison `sprinkleContentCache`.
    if (!this.pendingSprinkleFetches.has(requestId)) {
      log.debug('Dropping sprinkle.content for unknown requestId', {
        sprinkleName,
        requestId,
      });
      return;
    }

    let assembled: string | null = null;

    if (chunkIndex !== undefined && totalChunks !== undefined) {
      // Reject obviously-malformed chunk indices instead of accepting them
      // into the buffer (a chunkIndex >= totalChunks would otherwise grow
      // the buffer beyond the assembly threshold without ever satisfying
      // the strict equality below).
      if (chunkIndex < 0 || chunkIndex >= totalChunks) {
        log.warn('Dropping sprinkle.content with out-of-range chunkIndex', {
          sprinkleName,
          chunkIndex,
          totalChunks,
        });
        return;
      }
      const buffer = this.pendingSprinkleFetches.get(requestId)!;
      buffer.totalChunks = totalChunks;
      // Idempotent against duplicate chunks: only the FIRST delivery for a
      // given index advances the completion count. A retry race or
      // misbehaving leader sending two payloads for the same index does
      // not falsely trigger early assembly.
      if (!buffer.chunks.has(chunkIndex)) {
        buffer.chunks.set(chunkIndex, content);
      } else {
        log.warn('Dropping duplicate sprinkle.content chunk', {
          sprinkleName,
          chunkIndex,
        });
      }
      if (buffer.chunks.size >= totalChunks) {
        const ordered: string[] = [];
        for (let i = 0; i < totalChunks; i++) {
          const chunk = buffer.chunks.get(i);
          if (chunk === undefined) {
            log.warn('Chunked sprinkle.content missing chunk after assembly', {
              sprinkleName,
              missingIndex: i,
            });
            return; // Wait for the missing chunk.
          }
          ordered.push(chunk);
        }
        assembled = ordered.join('');
        this.pendingSprinkleFetches.delete(requestId);
      }
    } else {
      // Non-chunked single response — request is known (checked above).
      assembled = content;
      this.pendingSprinkleFetches.delete(requestId);
    }

    if (assembled === null) return;

    this.sprinkleContentCache.set(sprinkleName, assembled);
    this.inflightSprinkleByName.delete(sprinkleName);
    const waiters = this.sprinkleContentWaiters.get(sprinkleName) ?? [];
    this.sprinkleContentWaiters.delete(sprinkleName);
    for (const waiter of waiters) waiter.resolve(assembled);
  }

  /** Reject every pending sprinkle fetch with the given reason. */
  private rejectPendingSprinkleFetches(reason: string): void {
    const err = new Error(reason);
    for (const [, waiters] of this.sprinkleContentWaiters) {
      for (const waiter of waiters) waiter.reject(err);
    }
    this.sprinkleContentWaiters.clear();
    this.pendingSprinkleFetches.clear();
    this.inflightSprinkleByName.clear();
  }

  private emitEvent(event: AgentEvent): void {
    for (const cb of this.eventListeners) {
      try {
        cb(event);
      } catch (err) {
        log.error('Listener error', {
          eventType: event.type,
          error: err instanceof Error ? err.message : String(err),
        });
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
      this.sync.send({
        type: 'tab.open.error',
        requestId,
        error: 'Follower has no browser transport',
      });
      return;
    }

    try {
      const result = await transport.send('Target.createTarget', { url, background: true });
      const targetId = result['targetId'];
      // Some CDP versions / target denial paths can return without a usable
      // targetId. Surface a meaningful error instead of forwarding "undefined"
      // and letting the leader fail later attaching to a junk id.
      if (typeof targetId !== 'string' || targetId.length === 0) {
        this.sync.send({
          type: 'tab.open.error',
          requestId,
          error: 'Target.createTarget did not return a usable targetId',
        });
        return;
      }
      this.sync.send({ type: 'tab.opened', requestId, targetId });
      this.options.onTargetsChanged?.();
    } catch (err) {
      this.sync.send({
        type: 'tab.open.error',
        requestId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Execute a CDP command on the follower's local browser transport.
   * Sends the response back to the leader, chunking if necessary.
   *
   * When a `Target.attachToTarget` command succeeds, the resulting sessionId
   * is tracked as a remote-initiated session so that CDP events for that
   * session are forwarded to the leader.
   */
  private async executeLocalCDP(
    requestId: string,
    localTargetId: string,
    method: string,
    params: Record<string, unknown> | undefined,
    sessionId: string | undefined
  ): Promise<void> {
    const transport = this.options.browserTransport;
    if (!transport) {
      this.sync.send({
        type: 'cdp.response',
        requestId,
        error: 'Follower has no browser transport',
      });
      return;
    }

    try {
      const result = await transport.send(method, params, sessionId);

      // Track sessions created by remote CDP requests so we can forward events
      if (method === 'Target.attachToTarget' && result['sessionId']) {
        const remoteSessionId = result['sessionId'] as string;
        this.remoteCDPSessions.add(remoteSessionId);
        this.setupCDPEventForwarding(transport, remoteSessionId);
        log.debug('Tracking remote CDP session', { remoteSessionId });
      }

      // Clean up session tracking when detached
      if (
        method === 'Target.detachFromTarget' &&
        sessionId &&
        this.remoteCDPSessions.has(sessionId)
      ) {
        this.remoteCDPSessions.delete(sessionId);
        log.debug('Removed remote CDP session on detach', { sessionId });
      }

      sendCDPResponse(this.sync, requestId, result);
    } catch (err) {
      this.sync.send({
        type: 'cdp.response',
        requestId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Register CDP event listeners on the local transport for a remote-initiated session.
   * Events matching the sessionId are forwarded to the leader via `cdp.event`.
   */
  private setupCDPEventForwarding(transport: CDPTransport, remoteSessionId: string): void {
    // Events we care about forwarding to the leader
    const events = [
      'Page.frameNavigated',
      'Page.loadEventFired',
      'Page.domContentEventFired',
      'Network.responseReceived',
      'Network.loadingFinished',
      'Network.requestWillBeSent',
    ];

    for (const eventName of events) {
      const listener = (params: Record<string, unknown>) => {
        // Only forward events that belong to our remote session
        if (params['sessionId'] !== remoteSessionId) return;
        if (!this.remoteCDPSessions.has(remoteSessionId)) return;
        // Strip sessionId from forwarded params — the leader routes by sessionId at the message level
        const { sessionId: _sid, ...forwardedParams } = params;
        this.sync.send({
          type: 'cdp.event',
          method: eventName,
          params: forwardedParams,
          sessionId: remoteSessionId,
        });
      };
      transport.on(eventName, listener);
      this.cdpEventCleanups.push(() => transport.off(eventName, listener));
    }
  }

  /** Remove all CDP event listeners and clear session tracking. */
  private cleanupCDPEventForwarding(): void {
    for (const cleanup of this.cdpEventCleanups) cleanup();
    this.cdpEventCleanups.length = 0;
    this.remoteCDPSessions.clear();
  }

  /**
   * Route a CDP response from the leader to the appropriate RemoteCDPTransport.
   * Handles chunked responses by reassembling before delivery.
   */
  private routeCDPResponse(message: LeaderToFollowerMessage & { type: 'cdp.response' }): void {
    const assembled = reassembleCDPResponse(this.cdpChunkBuffers, message);
    if (!assembled) return; // Still waiting for more chunks

    // Find the transport that has this pending request by checking all transports
    for (const transport of this.remoteTransports.values()) {
      transport.handleResponse(message.requestId, assembled.result, assembled.error);
    }
  }

  // ---------------------------------------------------------------------------
  // FS routing
  // ---------------------------------------------------------------------------

  /**
   * Execute an fs request on the follower's local VFS.
   * Sends the response(s) back to the leader.
   */
  private async executeLocalFs(requestId: string, request: TrayFsRequest): Promise<void> {
    const vfs = this.options.vfs;
    if (!vfs) {
      this.sync.send({
        type: 'fs.response',
        requestId,
        response: { ok: false, error: 'Follower has no VFS' },
      });
      return;
    }

    // Mirror the executeLocalCDP / executeLocalTabOpen pattern: any rejection
    // from `handleFsRequest` (broken VFS, permission error, malformed path)
    // becomes an `fs.response` with `ok: false` instead of an unhandled async
    // rejection — otherwise the leader's `fsResolvers` entry would never
    // resolve, hanging any caller awaiting the response.
    let responses;
    try {
      responses = await handleFsRequest(vfs, request);
    } catch (err) {
      this.sync.send({
        type: 'fs.response',
        requestId,
        response: { ok: false, error: err instanceof Error ? err.message : String(err) },
      });
      return;
    }
    for (const response of responses) {
      this.sync.send({ type: 'fs.response', requestId, response });
    }
  }

  /**
   * Route an fs response from the leader to the appropriate pending resolver.
   * Handles chunked responses by accumulating until all chunks arrive.
   */
  private routeFsResponse(requestId: string, response: TrayFsResponse): void {
    const resolver = this.fsResolvers.get(requestId);
    if (!resolver) return;

    resolver.responses.push(response);
    const totalChunks = (response.ok && response.totalChunks) || 1;
    if (resolver.responses.length >= totalChunks) {
      this.fsResolvers.delete(requestId);
      resolver.resolve(resolver.responses);
    }
  }

  /**
   * Send an fs request to a remote runtime via the leader.
   * Returns a promise that resolves with the response(s).
   *
   * This is the public API that the rsync shell command will call.
   */
  sendFsRequest(targetRuntimeId: string, request: TrayFsRequest): Promise<TrayFsResponse[]> {
    const requestId = `fs-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    return new Promise<TrayFsResponse[]>((resolve, reject) => {
      this.fsResolvers.set(requestId, { resolve, reject, responses: [] });
      this.sync.send({ type: 'fs.request', requestId, targetRuntimeId, request });
    });
  }
}
