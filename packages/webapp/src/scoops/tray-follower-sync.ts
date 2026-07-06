/**
 * Follower sync manager — receives agent events from the leader over WebRTC
 * and provides an AgentHandle for the follower's ChatPanel.
 */

import type { BrowserAPI } from '../cdp/browser-api.js';
import { type RemoteCDPSender, RemoteCDPTransport } from '../cdp/remote-cdp-transport.js';
import type { CDPTransport } from '../cdp/transport.js';
import type { AgentEvent, AgentHandle } from '../core/agent-types.js';
import type { MessageAttachment } from '../core/attachments.js';
import { stripLocalPathsForRemote } from '../core/attachments.js';
import { createLogger } from '../core/logger.js';
import type { VirtualFS } from '../fs/virtual-fs.js';
import type { ChatMessage } from './chat-types.js';
import { DataChannelKeepalive } from './data-channel-keepalive.js';
import type { LickEvent } from './lick-manager.js';
import {
  getFollowerTrayRuntimeStatus,
  setFollowerLastPingTime,
  setFollowerTrayRuntimeStatus,
} from './tray-follower-status.js';
import { handleFsRequest } from './tray-fs-handler.js';
import {
  createFollowerSyncChannel,
  type FollowerToLeaderMessage,
  type LeaderToFollowerMessage,
  type RemoteTargetInfo,
  reassembleCDPResponse,
  reassembleSnapshot,
  type ScoopSummary,
  type SprinkleSummary,
  sendCDPResponse,
  type TrayFsRequest,
  type TrayFsResponse,
  type TraySyncChannel,
  type TrayTargetEntry,
  unhandledProtocolMessage,
} from './tray-sync-protocol.js';
import type { TrayDataChannelLike } from './tray-webrtc.js';

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
  /** Called when the leader sends an updated scoop list (nav bar / scoop picker). */
  onScoopsList?: (scoops: ScoopSummary[], activeScoopJid: string) => void;
  /** Called when the leader sends a `sprinkle.update` payload (mirrors `SprinkleManager.sendToSprinkle`). */
  onSprinkleUpdate?: (sprinkleName: string, data: unknown) => void;
  /** Called when the leader signals that a sprinkle's content has been reloaded (file changed). */
  onSprinkleReloaded?: (sprinkleName: string) => void;
  /**
   * Called when the leader sends a `cherry.slicc_event` (cone → host page). Only
   * a cherry follower wires this — it forwards the event to the host SDK via
   * `CherryHostTransport.emitSliccEventToHost`. Non-cherry followers leave it
   * unset, so the event falls through harmlessly. The wire `targetId` is not
   * forwarded: a cherry follower owns exactly one host transport, so the event
   * has only one destination.
   */
  onCherrySliccEvent?: (name: string, detail?: unknown) => void;
  /**
   * This follower's own runtime id, stamped onto outbound `cherry.host_event`
   * messages (host page → cone) so the cone-side lick records which cherry
   * runtime emitted it. The leader routes the event by connection identity, not
   * by this field, so it is informational only. Only a cherry follower sets it.
   */
  selfRuntimeId?: string;
  /**
   * Bound on every `fetchSprinkleContent` call. If the leader never
   * answers a `sprinkle.fetch` (deadlocked agent, partial chunked
   * transfer abandoned, leader still connected but stuck), the
   * follower would otherwise hang the controller's `opening` lock
   * forever. Defaults to 15 s. Pass `0` to disable this timer entirely,
   * or any positive value to override the default; non-positive /
   * non-finite inputs throw at construction.
   */
  sprinkleFetchTimeoutMs?: number;
}

const DEFAULT_SPRINKLE_FETCH_TIMEOUT_MS = 15000;

/** Internal buffer for chunked sprinkle.content reassembly. Mirrors the
 *  `SprinkleFetchBuffer` Swift struct nested inside the `AppState` class in
 *  `packages/ios-app/SliccFollower/App/AppState.swift` (declared with the
 *  `private` access modifier, i.e. type-scoped to `AppState`). */
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
  /** Waiters awaiting a sprinkle.content reply, keyed by sprinkleName.
   *  Each waiter carries a fresh `symbol` id so the timeout path can
   *  identify exactly one entry to splice out without relying on
   *  reference equality on a closure (which a future refactor that
   *  wraps `resolve`/`reject` once more would silently break). */
  private readonly sprinkleContentWaiters = new Map<
    string,
    Array<{
      readonly id: symbol;
      resolve: (content: string) => void;
      reject: (err: Error) => void;
    }>
  >();
  /**
   * Monotonic counter incremented on every `sprinkles.list` arrival.
   * In-flight fetches are stamped with the current value at issue time;
   * `handleSprinkleContent` only writes to `sprinkleContentCache` when the
   * stamp still matches. Closes the cache-write-races-list race
   * (R3-IMP): if a fetch's content reply lands AFTER a list barrier,
   * it's content from the pre-barrier world and must not be cached.
   */
  private cacheEpoch = 0;
  /** Per-requestId epoch stamp captured at `fetchSprinkleContent` time. */
  private readonly fetchEpoch = new Map<string, number>();
  constructor(
    channel: TrayDataChannelLike,
    private readonly options: FollowerSyncManagerOptions = {}
  ) {
    // Validate the fetch timeout at construction. Without this, a
    // negative / NaN / Infinity value collapses onto the same code
    // path as `0` (disabled) because the runtime guard is
    // `timeoutMs > 0`. Callers expect non-positive to mean either
    // "use the default" or "disabled"; we treat exactly `0` as the
    // explicit disable sentinel and reject everything else.
    const t = options.sprinkleFetchTimeoutMs;
    if (t !== undefined && (!Number.isFinite(t) || t < 0)) {
      throw new RangeError(
        `sprinkleFetchTimeoutMs must be a non-negative finite number (0 disables the timer); got ${t}`
      );
    }
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

  /** Tell the leader to switch this follower's view to a different scoop. */
  selectScoop(scoopJid: string): void {
    this.sync.send({ type: 'scoops.select', scoopJid });
  }

  /** Get the latest snapshot received from the leader, if any. */
  getLatestSnapshot(): { messages: ChatMessage[]; scoopJid: string } | null {
    return this.latestSnapshot;
  }

  /**
   * Close the sync channel and clean up. Idempotent — once called, the
   * channel-close event that follows will short-circuit in
   * `handleDisconnect`, so a caller-initiated teardown can't trigger
   * the error-state side effects (red-error follower status, `error`
   * event emission, `onDisconnect` callback that drives reconnect
   * logic) that `handleDisconnect` is designed to fire only on an
   * unexpected channel drop.
   */
  close(): void {
    if (this.disconnected) return;
    this.disconnected = true;
    this.keepalive.stop();
    this.unsubscribe();
    this.sync.close();
    this.eventListeners.clear();
    this.cleanupCDPEventForwarding();
    this.rejectPendingRequests('Follower sync closed');
    log.info('Follower sync closed');
  }

  /**
   * Reject every pending request waiting on the leader and clear the
   * associated buffers. Called from both `close()` (caller-initiated
   * shutdown) and `handleDisconnect()` (channel drop / keepalive death).
   *
   * Before this method existed, only `sprinkleContentWaiters` got drained
   * on disconnect — `tabOpenResolvers`, `fsResolvers`, in-flight
   * `cdpChunkBuffers`, and active `remoteTransports` all leaked. Any
   * caller awaiting `openRemoteTab()`, `sendFsRequest()`, or a
   * `RemoteCDPTransport.send()` past a disconnect would hang forever,
   * because a fresh `FollowerSyncManager` is constructed on reconnect
   * and the original resolvers never resolve.
   *
   * `RemoteCDPTransport.disconnect()` rejects its own pending
   * request/response promises and clears them, so we don't need to
   * walk into each transport's internals. (Per-event `once()` waiters
   * fall back to their individual timeouts; they're not drained here.)
   */
  private rejectPendingRequests(reason: string): void {
    this.rejectPendingSprinkleFetches(reason);
    const err = new Error(reason);
    for (const { reject } of this.tabOpenResolvers.values()) reject(err);
    this.tabOpenResolvers.clear();
    for (const { reject } of this.fsResolvers.values()) reject(err);
    this.fsResolvers.clear();
    this.cdpChunkBuffers.clear();
    for (const transport of this.remoteTransports.values()) transport.disconnect();
    this.remoteTransports.clear();
  }

  /** Advertise local browser targets to the leader. */
  advertiseTargets(targets: RemoteTargetInfo[], runtimeId: string): void {
    this.sync.send({ type: 'targets.advertise', targets, runtimeId });
  }

  /** Get the stored target registry entries from the leader. */
  getTargets(): TrayTargetEntry[] {
    return this.targetEntries;
  }

  /**
   * Send a host-originated `cherry.host_event` (host page → cone) to the leader,
   * where it surfaces as a `cherry` lick. Only a cherry follower calls this —
   * its `CherryHostTransport.onHostEvent` is wired to forward host SDK
   * `emitHostEvent` calls here.
   */
  sendCherryHostEvent(name: string, detail?: unknown): void {
    this.sync.send({
      type: 'cherry.host_event',
      targetId: this.options.selfRuntimeId ?? '',
      name,
      detail,
    });
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

    const timeoutMs = this.options.sprinkleFetchTimeoutMs ?? DEFAULT_SPRINKLE_FETCH_TIMEOUT_MS;

    return new Promise<string>((resolve, reject) => {
      // Per-waiter timer — when this fetch's caller times out, only this
      // waiter rejects; siblings that joined the same in-flight request
      // keep waiting (or get cancelled together when the LAST waiter
      // gives up, since `cancelSprinkleFetch` drains them all).
      const waiterId = Symbol('sprinkle-waiter');
      let timer: ReturnType<typeof setTimeout> | undefined;
      const wrapResolve = (content: string) => {
        if (timer !== undefined) clearTimeout(timer);
        resolve(content);
      };
      const wrapReject = (err: Error) => {
        if (timer !== undefined) clearTimeout(timer);
        reject(err);
      };

      const waiters = this.sprinkleContentWaiters.get(sprinkleName) ?? [];
      waiters.push({ id: waiterId, resolve: wrapResolve, reject: wrapReject });
      this.sprinkleContentWaiters.set(sprinkleName, waiters);

      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          // Drop just this caller's waiter; the in-flight fetch lives
          // on for the others. If we were the last waiter, cancel the
          // whole fetch so the three lockstep maps don't leak. The
          // symbol id (not the closure reference) is what identifies
          // us — a future refactor that wraps `wrapResolve` once more
          // would otherwise silently miss the match.
          const list = this.sprinkleContentWaiters.get(sprinkleName);
          if (list) {
            const idx = list.findIndex((w) => w.id === waiterId);
            if (idx >= 0) list.splice(idx, 1);
            if (list.length === 0) {
              this.sprinkleContentWaiters.delete(sprinkleName);
              this.cancelSprinkleFetch(
                sprinkleName,
                `Sprinkle fetch for "${sprinkleName}" timed out after ${timeoutMs}ms`
              );
            }
          }
          reject(new Error(`Sprinkle fetch for "${sprinkleName}" timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }

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
      // Stamp this fetch with the current cache epoch. If the epoch
      // advances (via a `sprinkles.list` broadcast) before the reply
      // lands, the cache write at reassembly time will be skipped.
      this.fetchEpoch.set(requestId, this.cacheEpoch);
      this.sync.send({ type: 'sprinkle.fetch', requestId, sprinkleName });
    });
  }

  /** Forward a sprinkle lick (from a follower-rendered sprinkle) to the leader. */
  sendSprinkleLick(sprinkleName: string, body: unknown, targetScoop?: string): void {
    const ok = this.sync.send({ type: 'sprinkle.lick', sprinkleName, body, targetScoop });
    if (!ok) log.warn('sendSprinkleLick dropped: tray channel closed', { sprinkleName });
  }

  /**
   * Forward a generic lick (e.g. `navigate`) to the leader's agent.
   * Returns false (and drops) if the channel is closed/failed — never
   * falls back to local handling (that is the phantom-cone bug).
   */
  forwardLick(event: LickEvent): boolean {
    const ok = this.sync.send({ type: 'lick', event });
    if (!ok) log.warn('forwardLick dropped: tray channel closed', { type: event.type });
    return ok;
  }

  /** Invalidate the cached .shtml content for one sprinkle (or all). */
  clearSprinkleCache(sprinkleName?: string): void {
    if (sprinkleName === undefined) this.sprinkleContentCache.clear();
    else this.sprinkleContentCache.delete(sprinkleName);
  }

  /**
   * Cancel any in-flight `sprinkle.fetch` for the named sprinkle. Rejects
   * all current waiters so callers don't accumulate across retries when
   * the panel-side proxy gave up on the original fetch (R2-IMP-2).
   *
   * Clears the requestId from `pendingSprinkleFetches`, the
   * `inflightSprinkleByName` lookup, and the `fetchEpoch` stamp — every
   * site that removes a `pendingSprinkleFetches` entry must keep the
   * three Maps in lockstep, otherwise an orphan epoch stamp could
   * mis-classify a future re-used requestId. A late `sprinkle.content`
   * reply for the cancelled requestId then falls into the
   * unknown-requestId branch in `handleSprinkleContent` and is silently
   * dropped — that's what prevents the cache from being poisoned by a
   * stale post-cancel reply. The next `fetchSprinkleContent(sprinkleName)`
   * call goes back on the wire cleanly instead of latching onto an
   * orphan requestId.
   */
  cancelSprinkleFetch(sprinkleName: string, reason = 'fetch cancelled'): void {
    const waiters = this.sprinkleContentWaiters.get(sprinkleName) ?? [];
    this.sprinkleContentWaiters.delete(sprinkleName);
    const requestId = this.inflightSprinkleByName.get(sprinkleName);
    if (requestId !== undefined) {
      this.inflightSprinkleByName.delete(sprinkleName);
      this.pendingSprinkleFetches.delete(requestId);
      this.fetchEpoch.delete(requestId);
    }
    if (waiters.length === 0) return;
    const err = new Error(reason);
    for (const waiter of waiters) waiter.reject(err);
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
    this.rejectPendingRequests(`Follower sync disconnected: ${reason}`);

    // Notify higher-level code for potential reconnection
    this.options.onDisconnect?.(reason);
  }

  private handleLeaderMessage(message: LeaderToFollowerMessage): void {
    if (message.type === 'theme.apply') {
      this.applyLeaderTheme(message.themeJson);
      return;
    }
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
        this.handleUserMessageEcho(message);
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
      // tab.open and preview.open share executeLocalTabOpen for Phase 1 —
      // preview-vs-tab is informational, deferring the distinction to Phase 2
      // when an injected bridge channel might want preview-specific behavior.
      case 'tab.open':
      case 'preview.open': {
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
      case 'scoops.list': {
        this.handleScoopsList(message.scoops, message.activeScoopJid);
        break;
      }

      case 'sprinkles.list': {
        log.info('Sprinkles list received from leader', {
          sprinkleCount: message.sprinkles.length,
        });
        // Treat every list broadcast as a content invalidation barrier.
        // The leader has no per-file change signal today; broadcasts are
        // periodic (~5 s default), so a stable `.shtml` re-invalidates
        // its cache on every tick. This is conservative — the trade-off
        // is cache effectiveness during steady state in exchange for
        // never serving stale content to the user when the leader's
        // file actually changed. Bumping `cacheEpoch` ALSO discards any
        // in-flight fetch's content reply that arrives AFTER this
        // barrier — see `handleSprinkleContent`. Without that, a late
        // pre-barrier reply could poison the cache for the post-barrier
        // world.
        this.sprinkleContentCache.clear();
        this.cacheEpoch++;
        this.latestSprinkles = message.sprinkles;
        this.options.onSprinklesList?.(message.sprinkles);
        break;
      }

      case 'sprinkle.content':
        this.handleSprinkleContent(message);
        break;

      case 'sprinkle.update':
        this.options.onSprinkleUpdate?.(message.sprinkleName, message.data);
        break;
      case 'sprinkle.reloaded':
        this.handleSprinkleReloaded(message.sprinkleName);
        break;

      case 'cherry.slicc_event':
        // Cone → host page event. A cherry follower forwards it to the host
        // SDK; non-cherry followers leave `onCherrySliccEvent` unset and it
        // falls through harmlessly.
        this.options.onCherrySliccEvent?.(message.name, message.detail);
        break;

      case 'ping':
        this.keepalive.receivePing();
        this.sync.send({ type: 'pong' });
        break;
      case 'pong':
        this.keepalive.receivePong();
        setFollowerLastPingTime(Date.now());
        break;
      default: {
        // Exhaustiveness guard: a new LeaderToFollowerMessage variant fails
        // compile here until this dispatcher decides (mirrors the iOS
        // `.unknown` case in AppState.swift). At runtime this branch means a
        // version-skewed leader — log loudly, never throw.
        const unknown = unhandledProtocolMessage(message);
        log.warn('Unknown leader message type — skewed leader?', {
          type: unknown.type,
        });
        break;
      }
    }
  }

  private handleUserMessageEcho(
    message: LeaderToFollowerMessage & { type: 'user_message_echo' }
  ): void {
    if (this.sentMessageIds.has(message.messageId)) {
      this.sentMessageIds.delete(message.messageId);
      log.debug('Skipping own message echo', { messageId: message.messageId });
      return;
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
  }

  private handleScoopsList(scoops: ScoopSummary[], activeScoopJid: string): void {
    log.info('Scoops list received from leader', { scoopCount: scoops.length });
    this.options.onScoopsList?.(scoops, activeScoopJid);
  }

  /**
   * Reassemble chunked `sprinkle.content` responses and resolve the waiting
   * fetchers. Mirrors `handleSprinkleContent` in iOS `AppState.swift` — same
   * chunk-buffer + ordered-join + waiter-resolve flow, plus error rejection.
   */
  private handleSprinkleReloaded(sprinkleName: string): void {
    this.sprinkleContentCache.delete(sprinkleName);
    this.options.onSprinkleReloaded?.(sprinkleName);
  }

  private handleSprinkleContent(
    message: LeaderToFollowerMessage & { type: 'sprinkle.content' }
  ): void {
    const { requestId, sprinkleName, content, chunkIndex, totalChunks, error } = message;

    if (error) {
      log.warn('sprinkle.content error from leader', { sprinkleName, error });
      this.pendingSprinkleFetches.delete(requestId);
      this.inflightSprinkleByName.delete(sprinkleName);
      // Mirror the cancel/reject/success paths: every removal from
      // `pendingSprinkleFetches` must drop the matching `fetchEpoch`
      // stamp too. Without this, leader-returned errors leak one Map
      // entry per error for the session lifetime (R4 hygiene fix).
      this.fetchEpoch.delete(requestId);
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

    // Only cache if the fetch was issued in the current cache epoch — a
    // `sprinkles.list` arriving mid-fetch advances the epoch and signals
    // the content is from before the cache barrier. Waiters still get
    // resolved with the content so the original caller isn't penalised
    // (they asked for this content; the leader's later list broadcast
    // can't retroactively unsay it). The NEXT fetch goes back on the
    // wire instead of returning a stale cache hit.
    const fetchedEpoch = this.fetchEpoch.get(requestId);
    this.fetchEpoch.delete(requestId);
    if (fetchedEpoch === this.cacheEpoch) {
      this.sprinkleContentCache.set(sprinkleName, assembled);
    }
    this.inflightSprinkleByName.delete(sprinkleName);
    const waiters = this.sprinkleContentWaiters.get(sprinkleName) ?? [];
    this.sprinkleContentWaiters.delete(sprinkleName);
    for (const waiter of waiters) waiter.resolve(assembled);
  }

  /**
   * Reject every pending sprinkle fetch with the given reason. Also clears
   * the `fetchEpoch` map — without this, a future fetch with the same
   * requestId (e.g. across a reconnect with stale clock collisions) could
   * see a leftover epoch stamp and write stale content to the cache.
   */
  private rejectPendingSprinkleFetches(reason: string): void {
    const err = new Error(reason);
    for (const [, waiters] of this.sprinkleContentWaiters) {
      for (const waiter of waiters) waiter.reject(err);
    }
    this.sprinkleContentWaiters.clear();
    this.pendingSprinkleFetches.clear();
    this.inflightSprinkleByName.clear();
    this.fetchEpoch.clear();
  }

  private applyLeaderTheme(themeJson: string | null): void {
    import('../ui/theme-engine.js')
      .then(
        ({
          importTheme,
          saveCustomTheme,
          setActiveTheme,
          clearActiveTheme,
          applyThemeOverrides,
        }) => {
          if (!themeJson) {
            clearActiveTheme();
          } else {
            const theme = importTheme(themeJson);
            saveCustomTheme(theme);
            setActiveTheme(theme.id);
          }
          applyThemeOverrides();
        }
      )
      .catch((err) => log.error('Failed to apply leader theme', { err }));
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
