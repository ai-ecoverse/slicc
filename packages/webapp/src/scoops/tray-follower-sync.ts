/**
 * Follower sync manager — receives agent events from the leader over WebRTC
 * and provides an AgentHandle for the follower's ChatPanel.
 *
 * Collaborators under `tray-follower/` own sprinkle cache, remote CDP, tab
 * teleport, fs routing, OAuth popups, transcript export, and sudo prompts.
 * This file is the `AgentHandle` + keepalive/disconnect owner and the
 * `handleLeaderMessage` dispatcher.
 */

import type { TranscriptExportProgress, TranscriptExportSelector } from '@slicc/shared-ts';
import { createLogger } from '../base/logger.js';
import type { RemoteCDPTransport } from '../cdp/remote-cdp-transport.js';
import type { AgentEvent, AgentHandle } from '../core/agent-types.js';
import type { MessageAttachment } from '../core/attachments.js';
import { stripLocalPathsForRemote } from '../core/attachments.js';
import type { ChatMessage } from './chat-types.js';
import { DataChannelKeepalive } from './data-channel-keepalive.js';
import type { LickEvent } from './lick-manager.js';
import type { FollowerSyncContext } from './tray-follower/context.js';
import { FollowerExportClient } from './tray-follower/export-client.js';
import { FollowerFsBridge } from './tray-follower/fs-bridge.js';
import { FollowerOAuthPopups } from './tray-follower/oauth-popups.js';
import { FollowerRemoteCdp } from './tray-follower/remote-cdp.js';
import { FollowerSprinkleCache } from './tray-follower/sprinkle-cache.js';
import { FollowerSudoClient } from './tray-follower/sudo-client.js';
import { FollowerTabTeleport } from './tray-follower/tab-teleport.js';
import type { FollowerSyncManagerOptions, SudoApprovalVerdict } from './tray-follower/types.js';
import {
  getFollowerTrayRuntimeStatus,
  setFollowerLastPingTime,
  setFollowerStalled,
  setFollowerTrayRuntimeStatus,
} from './tray-follower-status.js';
import {
  createFollowerSyncChannel,
  type FollowerToLeaderMessage,
  type LeaderToFollowerMessage,
  type RemoteTargetInfo,
  reassembleSnapshot,
  type ScoopSummary,
  type SprinkleSummary,
  TRAY_SYNC_PROTOCOL_VERSION,
  type TrayExecChunkMessage,
  type TrayExecRequestMessage,
  type TrayExecResponseMessage,
  type TrayExecSignalMessage,
  type TrayFsRequest,
  type TrayFsResponse,
  type TraySyncChannel,
  type TrayTargetEntry,
  type TrayThinkingLevel,
  unhandledProtocolMessage,
} from './tray-sync-protocol.js';
import type { TrayDataChannelLike } from './tray-webrtc.js';

export type { FollowerSyncManagerOptions, SudoApprovalVerdict };

const log = createLogger('tray-follower-sync');

/** Legacy unscoped statuses apply; scoped statuses apply only to the viewed scoop. */
export function shouldApplyFollowerStatus(
  statusScoopJid: string | undefined,
  selectedScoopJid: string | null
): boolean {
  return statusScoopJid === undefined || statusScoopJid === selectedScoopJid;
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
  private snapshotChunkBuffer: { chunks: string[]; received: number; totalChunks: number } | null =
    null;
  /** Tray sync protocol version from the leader's `hello`; undefined until it arrives. */
  private leaderProtocolVersion?: number;
  /** True once the no-hello legacy-leader diagnosis has been logged. */
  private legacyLeaderLogged = false;
  private disconnected = false;

  private readonly sprinkles: FollowerSprinkleCache;
  private readonly remoteCdp: FollowerRemoteCdp;
  private readonly tabTeleport: FollowerTabTeleport;
  private readonly fsBridge: FollowerFsBridge;
  private readonly oauthPopups: FollowerOAuthPopups;
  private readonly exportClient: FollowerExportClient;
  private readonly sudoClient: FollowerSudoClient;

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
    const context: FollowerSyncContext = {
      options: this.options,
      log,
      send: (message) => this.sync.send(message),
    };
    this.sprinkles = new FollowerSprinkleCache(context);
    this.remoteCdp = new FollowerRemoteCdp(context);
    this.tabTeleport = new FollowerTabTeleport(context);
    this.fsBridge = new FollowerFsBridge(context);
    this.oauthPopups = new FollowerOAuthPopups(context);
    this.exportClient = new FollowerExportClient(context);
    this.sudoClient = new FollowerSudoClient(context);
    this.unsubscribe = this.sync.onMessage((message: LeaderToFollowerMessage) => {
      this.handleLeaderMessage(message);
    });
    // Version handshake first — additive; legacy leaders drop it harmlessly.
    // A follower that can render a delegated sudo prompt says so (#2062);
    // the leader never sends one to a peer that did not.
    const capabilities = this.options.onSudoApprovalRequest
      ? { exec: false, ...(this.options.helloCapabilities ?? {}), sudoApproval: true }
      : this.options.helloCapabilities;
    this.sync.send({
      type: 'hello',
      protocolVersion: TRAY_SYNC_PROTOCOL_VERSION,
      ...(this.options.selfRuntimeId ? { runtime: this.options.selfRuntimeId } : {}),
      ...(capabilities ? { capabilities } : {}),
    });
    this.keepalive = new DataChannelKeepalive({
      sendPing: () => this.sync.send({ type: 'ping' }),
      // A leader that stops answering while the data channel is still open is
      // busy, not gone. The hosted-leader float shares one small sandbox
      // between Chromium, the kernel worker, and node-server, so a working
      // cone routinely starves its own main thread past the ping deadline.
      // Disconnecting there used to close a healthy channel and force a full
      // renegotiation — the drop was self-inflicted. Wait it out instead.
      isTransportOpen: () => this.sync.isOpen,
      onStalled: () => {
        log.warn('Leader stopped answering pings; channel still open, waiting for it to catch up');
        setFollowerStalled(true);
        this.options.onLeaderStalled?.(true);
      },
      onRecovered: () => {
        log.info('Leader is answering pings again');
        setFollowerStalled(false);
        this.options.onLeaderStalled?.(false);
      },
      onDead: () => {
        log.warn('Leader keepalive dead, cleaning up');
        this.handleDisconnect('Keepalive timeout — leader not responding');
        this.options.onDead?.();
      },
    });
    this.keepalive.start();
    // Treat an unexpected underlying channel drop as a disconnect (status +
    // cleanup + onDisconnect; no transcript error event — see handleDisconnect)
    channel.addEventListener('close', () => {
      log.warn('Data channel closed');
      this.handleDisconnect('Data channel closed');
    });
    channel.addEventListener('error', () => {
      log.warn('Data channel error');
      this.handleDisconnect('Data channel error');
    });
    Object.defineProperties(this, {
      activeExportRequests: { get: () => this.exportClient.activeExportRequests },
    });
  }

  // ---------------------------------------------------------------------------
  // AgentHandle implementation
  // ---------------------------------------------------------------------------

  /**
   * Send a prompt to the leader.
   *
   * Returns whether the channel ACCEPTED the frame. `TraySyncChannel.send`
   * answers `false` for a closed or closing data channel, and swallowing that
   * is how a refused send looked like a delivered one: the composer had
   * already rendered the bubble and cleared the input. `void` remains the
   * `AgentHandle` contract, so a boolean here is additive — callers that
   * cannot act on it keep ignoring it.
   */
  sendMessage(
    text: string,
    messageId?: string,
    attachments?: MessageAttachment[],
    options?: { steer?: boolean }
  ): boolean {
    const id = messageId ?? `follower-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.sentMessageIds.add(id);
    // Off-loaded `path` values point at this follower's VFS — they are
    // not reachable from the leader. Strip them (preserving inline
    // text/data) so the cone never sees a stale path it cannot read.
    const safeAttachments = attachments?.length
      ? stripLocalPathsForRemote(attachments)
      : attachments;
    const accepted = this.sync.send({
      type: 'user_message',
      text,
      messageId: id,
      attachments: safeAttachments,
      ...(options?.steer ? { steer: true as const } : {}),
    });
    if (accepted) log.info('Sent user message to leader', { messageId: id });
    else {
      // The id never left the device, so it can never be echoed back — keeping
      // it would suppress a LATER message that happens to reuse it after a
      // retry.
      this.sentMessageIds.delete(id);
      log.warn('Channel refused a user message', { messageId: id });
    }
    return accepted;
  }

  onEvent(callback: (event: AgentEvent) => void): () => void {
    this.eventListeners.add(callback);
    return () => this.eventListeners.delete(callback);
  }

  /** Abort the leader's current turn. Returns whether the channel took it. */
  stop(): boolean {
    const accepted = this.sync.send({ type: 'abort' });
    if (accepted) log.info('Sent abort to leader');
    else log.warn('Channel refused an abort');
    return accepted;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /** Request a fresh snapshot from the leader. */
  requestSnapshot(scoopJid?: string): void {
    this.sync.send({ type: 'request_snapshot', ...(scoopJid ? { scoopJid } : {}) });
  }

  /**
   * Ask the leader to start a new session (freezer new-chat). A follower has
   * no cone / VFS to run `runNewSessionFreeze` itself; the leader runs its
   * own `runNewSession` and then broadcasts the cleared snapshot back.
   */
  requestNewSession(action: 'save' | 'skip' | 'erase'): void {
    this.sync.send({ type: 'new_session', action });
    log.info('Sent new_session to leader', { action });
  }

  /** Tell the leader to switch this follower's view to a different scoop. */
  selectScoop(scoopJid: string): void {
    this.sync.send({ type: 'scoops.select', scoopJid });
  }

  /** Ask a v5+ leader to send its model catalog and current selection state. */
  requestModels(): void {
    this.sync.send({ type: 'models.request' });
  }

  /**
   * Ask the leader to change the model of the cone this follower is looking
   * at (#2310). `scoopJid` names that unit — a scoop resolves to the cone
   * that owns it on the leader; omitted, the leader uses this follower's
   * last `scoops.select`.
   */
  selectModel(modelId: string, scoopJid?: string): void {
    this.sync.send({ type: 'model.select', modelId, ...(scoopJid ? { scoopJid } : {}) });
  }

  /** Ask the leader to change one scoop's thinking level. */
  setThinkingLevel(
    scoopJid: string,
    thinkingLevel: TrayThinkingLevel,
    effortOverride?: string
  ): void {
    this.sync.send({ type: 'thinking.set', scoopJid, thinkingLevel, effortOverride });
  }

  /** Get the latest snapshot received from the leader, if any. */
  getLatestSnapshot(): { messages: ChatMessage[]; scoopJid: string } | null {
    return this.latestSnapshot;
  }

  /**
   * Close the sync channel and clean up. Idempotent — once called, the
   * channel-close event that follows will short-circuit in
   * `handleDisconnect`, so a caller-initiated teardown can't trigger
   * the error-state side effects (red-error follower status, error-level
   * disconnect log, `onDisconnect` callback that drives reconnect
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
    this.remoteCdp.cleanupEventForwarding();
    this.rejectPendingRequests('Follower sync closed');
    log.info('Follower sync closed');
  }

  /**
   * Reject every pending request waiting on the leader and clear the
   * associated buffers. Called from both `close()` (caller-initiated
   * shutdown) and `handleDisconnect()` (channel drop / keepalive death).
   *
   * Order is load-bearing: sprinkle waiters first, then OAuth/sudo aborts,
   * then tab/fs rejects, then CDP transports, then export spool cancel.
   * A fresh `FollowerSyncManager` is constructed on reconnect, so any
   * resolver left pending here hangs forever.
   */
  private rejectPendingRequests(reason: string): void {
    this.sprinkles.rejectPending(reason);
    this.oauthPopups.abortAll();
    this.sudoClient.abortAll();
    this.tabTeleport.rejectPending(reason);
    this.fsBridge.rejectPending(reason);
    this.remoteCdp.rejectPending();
    this.exportClient.rejectPending();
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

  /** Latest sprinkle list received from the leader. */
  getSprinkles(): SprinkleSummary[] {
    return this.sprinkles.getSprinkles();
  }

  /** Ask the leader to re-broadcast the sprinkle list. */
  refreshSprinkles(): void {
    this.sync.send({ type: 'sprinkles.refresh' });
  }

  fetchSprinkleContent(sprinkleName: string): Promise<string> {
    return this.sprinkles.fetchSprinkleContent(sprinkleName);
  }

  /** Forward a sprinkle lick (from a follower-rendered sprinkle) to the leader. */
  sendSprinkleLick(sprinkleName: string, body: unknown, targetScoop?: string): void {
    const ok = this.sync.send({ type: 'sprinkle.lick', sprinkleName, body, targetScoop });
    if (!ok) log.warn('sendSprinkleLick dropped: tray channel closed', { sprinkleName });
  }

  /**
   * Report which sprinkles this follower currently renders.
   *
   * Fire-and-forget by design: the report is a diagnostic aid for the
   * leader's `sprinkle list`, and a dropped one is corrected by the next
   * open/close transition. It must never fail a reconcile.
   */
  reportSprinkleInstances(sprinkleNames: string[]): void {
    const ok = this.sync.send({ type: 'sprinkle.instances', sprinkles: sprinkleNames });
    if (!ok) log.debug('reportSprinkleInstances dropped: tray channel closed');
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
    this.sprinkles.clearSprinkleCache(sprinkleName);
  }

  cancelSprinkleFetch(sprinkleName: string, reason = 'fetch cancelled'): void {
    this.sprinkles.cancelSprinkleFetch(sprinkleName, reason);
  }

  /**
   * Handle a detected disconnect (keepalive dead, channel close/error).
   * Updates follower status, cleans up, and notifies via onDisconnect.
   *
   * Deliberately does NOT emit an agent 'error' event (#1707): this manager
   * is installed as the chat panel's AgentHandle, so such an event renders a
   * permanent `<slicc-error-card>` in the transcript and fires `trackError`
   * into RUM — for a state that `startFollowerWithAutoReconnect` usually
   * heals in seconds. Connection state is presented by the mount instead
   * (`onConnectionChange`/`onGaveUp` → composer placeholders) and recorded in
   * the follower runtime status for `host`/telemetry. Leader-SENT error
   * events (genuine agent errors) still forward via `handleLeaderMessage`.
   */
  private handleDisconnect(reason: string): void {
    if (this.disconnected) return;
    this.disconnected = true;

    log.error('Follower sync disconnected', { reason });

    const current = getFollowerTrayRuntimeStatus();
    setFollowerTrayRuntimeStatus({
      ...current,
      state: 'error',
      error: reason,
      stalled: false,
    });

    this.keepalive.stop();
    this.remoteCdp.cleanupEventForwarding();
    this.unsubscribe();
    this.sync.close();
    this.rejectPendingRequests(`Follower sync disconnected: ${reason}`);

    this.options.onDisconnect?.(reason);
  }

  /** Keepalive bookkeeping for the leader's ping/pong. */
  private handleKeepaliveMessage(type: 'ping' | 'pong'): void {
    if (type === 'ping') {
      this.keepalive.receivePing();
      this.sync.send({ type: 'pong' });
      return;
    }
    this.keepalive.receivePong();
    setFollowerLastPingTime(Date.now());
  }

  /** A whole-thread replacement. Drops any half-assembled chunked snapshot. */
  private handleSnapshot(messages: ChatMessage[], scoopJid: string): void {
    log.info('Snapshot received from leader', { messageCount: messages.length, scoopJid });
    this.snapshotChunkBuffer = null;
    this.latestSnapshot = { messages, scoopJid };
    this.options.onSnapshot?.(messages, scoopJid);
  }

  /** One frame of a snapshot too large to send whole; emits once complete. */
  private handleSnapshotChunk(
    message: Extract<LeaderToFollowerMessage, { type: 'snapshot_chunk' }>
  ): void {
    const assembled = reassembleSnapshot(this.snapshotChunkBuffer, message);
    this.snapshotChunkBuffer = assembled.buffer;
    if (!assembled.result) return;
    log.info('Chunked snapshot reassembled from leader', {
      messageCount: assembled.result.messages.length,
      scoopJid: assembled.result.scoopJid,
    });
    this.latestSnapshot = assembled.result;
    this.options.onSnapshot?.(assembled.result.messages, assembled.result.scoopJid);
  }

  /**
   * Only a biscotto ever receives this; an ordinary follower's messages are
   * never reviewed. Surfaced so the guest composer can show its own message as
   * pending / refused rather than appearing to have been sent and vanished.
   */
  private handleBiscottoMessageState(
    messageId: string,
    state: 'pending' | 'approved' | 'rejected' | 'unanswered'
  ): void {
    this.options.onBiscottoMessageState?.(messageId, state);
  }

  private handleLeaderHello(protocolVersion: number): void {
    this.leaderProtocolVersion = protocolVersion;
    if (protocolVersion > TRAY_SYNC_PROTOCOL_VERSION) {
      log.warn('Leader speaks a newer tray sync protocol — update this build', {
        leaderVersion: protocolVersion,
        ourVersion: TRAY_SYNC_PROTOCOL_VERSION,
      });
    } else {
      log.info('Leader hello', { protocolVersion });
    }
    if (protocolVersion >= 5) this.requestModels();
  }

  /** Log once when the leader's first message is not `hello` (ordered channel ⇒ legacy build). */
  private noteLegacyLeader(messageType: string): void {
    if (messageType === 'hello' || this.leaderProtocolVersion !== undefined) return;
    if (this.legacyLeaderLogged) return;
    this.legacyLeaderLogged = true;
    log.info('Leader sent no hello — legacy peer (pre-versioning build)');
  }

  private handleThemeMessage(
    message: LeaderToFollowerMessage
  ): message is Extract<LeaderToFollowerMessage, { type: 'theme.apply' }> {
    if (message.type !== 'theme.apply') return false;
    this.options.onThemeApply?.(message.themeJson);
    return true;
  }

  private handleLeaderMessage(message: LeaderToFollowerMessage): void {
    this.noteLegacyLeader(message.type);
    if (this.handleThemeMessage(message)) return;
    switch (message.type) {
      case 'snapshot':
        this.handleSnapshot(message.messages, message.scoopJid);
        break;
      case 'snapshot_chunk':
        this.handleSnapshotChunk(message);
        break;
      case 'agent_event':
        this.emitEvent(message.event);
        break;
      case 'user_message_echo':
        this.handleUserMessageEcho(message);
        break;
      case 'status':
        this.options.onStatus?.(message.scoopStatus, message.scoopJid);
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
      case 'cdp.request':
        void this.remoteCdp.executeLocalCDP(
          message.requestId,
          message.localTargetId,
          message.method,
          message.params,
          message.sessionId
        );
        break;
      case 'cdp.response':
        this.remoteCdp.routeCDPResponse(message);
        break;
      case 'cdp.event':
        this.remoteCdp.routeCDPEvent(message);
        break;
      // tab.open and preview.open share executeLocalTabOpen for Phase 1 —
      // preview-vs-tab is informational, deferring the distinction to Phase 2
      // when an injected bridge channel might want preview-specific behavior.
      case 'tab.open':
      case 'preview.open':
        void this.tabTeleport.executeLocalTabOpen(message.requestId, message.url);
        break;
      case 'tab.opened':
        this.tabTeleport.handleOpened(message.requestId, message.targetId);
        break;
      case 'tab.open.error':
        this.tabTeleport.handleOpenError(message.requestId, message.error);
        break;
      case 'fs.request':
        void this.fsBridge.executeLocalFs(message.requestId, message.request);
        break;
      case 'fs.response':
        this.fsBridge.routeFsResponse(message.requestId, message.response);
        break;
      case 'scoops.list':
        this.handleScoopsList(message.scoops, message.activeScoopJid);
        break;
      case 'models.list':
        this.options.onModelsList?.(message.models);
        break;
      case 'model.state':
        this.options.onModelState?.(message.state);
        break;
      case 'sprinkles.list':
        this.sprinkles.handleList(message.sprinkles);
        break;
      case 'sprinkle.content':
        this.sprinkles.handleContent(message);
        break;
      case 'sprinkle.update':
        this.options.onSprinkleUpdate?.(message.sprinkleName, message.data);
        break;
      case 'sprinkle.reloaded':
        this.sprinkles.handleReloaded(message.sprinkleName);
        break;
      case 'cherry.slicc_event':
        this.options.onCherrySliccEvent?.(message.name, message.detail);
        break;
      case 'transcript.export.pending':
      case 'transcript.export.denied':
      case 'transcript.export.start':
      case 'transcript.export.chunk':
      case 'transcript.export.complete':
      case 'transcript.export.error':
        this.exportClient.handleLeaderMessage(message);
        break;
      case 'sudo.approve.request':
      case 'sudo.approve.cancel':
        this.sudoClient.handleLeaderMessage(message);
        break;
      case 'oauth.popup.request':
        void this.oauthPopups.handleRequest(message.requestId, message.url);
        break;
      case 'ping':
      case 'pong':
        this.handleKeepaliveMessage(message.type);
        break;
      case 'hello':
        this.handleLeaderHello(message.protocolVersion);
        break;
      case 'biscotto.message.state':
        this.handleBiscottoMessageState(message.messageId, message.state);
        break;
      case 'exec.request':
      case 'exec.chunk':
      case 'exec.response':
      case 'exec.signal':
        this.handleExecMessage(message);
        break;
      default: {
        const unknown = unhandledProtocolMessage(message);
        log.warn('Unknown leader message type — skewed leader?', { type: unknown.type });
        break;
      }
    }
  }

  /**
   * The browser follower has no OS shell and never advertises `exec`
   * capability. It refuses a leader-issued `exec.request` with a clean error
   * response; the reply-path variants (`exec.chunk` / `exec.response` /
   * `exec.signal`) are documented no-ops — only the CLI follower originates an
   * exec, so a browser follower never has one to reconcile.
   */
  private handleExecMessage(
    message:
      | TrayExecRequestMessage
      | TrayExecChunkMessage
      | TrayExecResponseMessage
      | TrayExecSignalMessage
  ): void {
    if (message.type === 'exec.request') {
      this.sync.send({
        type: 'exec.response',
        requestId: message.requestId,
        exitCode: 127,
        error: 'exec is not supported on this follower',
      });
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

  createRemoteTransport(targetRuntimeId: string, localTargetId: string): RemoteCDPTransport {
    return this.remoteCdp.createRemoteTransport(targetRuntimeId, localTargetId);
  }

  removeRemoteTransport(targetRuntimeId: string, localTargetId: string): void {
    this.remoteCdp.removeRemoteTransport(targetRuntimeId, localTargetId);
  }

  openRemoteTab(targetRuntimeId: string, url: string): Promise<string> {
    return this.tabTeleport.openRemoteTab(targetRuntimeId, url);
  }

  requestTabTeleport(sourceTargetId: string): Promise<string> {
    return this.tabTeleport.requestTabTeleport(sourceTargetId);
  }

  /** The leader's advertised protocol version, when it sent a `hello`. */
  getLeaderProtocolVersion(): number | undefined {
    return this.leaderProtocolVersion;
  }

  sendFsRequest(targetRuntimeId: string, request: TrayFsRequest): Promise<TrayFsResponse[]> {
    return this.fsBridge.sendFsRequest(targetRuntimeId, request);
  }

  requestTranscriptExport(
    selector: TranscriptExportSelector,
    signal: AbortSignal,
    onProgress?: (progress: TranscriptExportProgress) => void
  ): Promise<Blob> {
    return this.exportClient.requestTranscriptExport(selector, signal, onProgress);
  }

  /**
   * Register this device's push token with the leader, which forwards it to
   * the tray hub (issue #2062). Browser followers have no APNs token; this is
   * the TS mirror of what the iOS follower sends on every connect.
   */
  registerPushToken(registration: {
    platform: 'ios';
    token: string;
    environment: 'sandbox' | 'production';
  }): boolean {
    return this.sync.send({ type: 'push.register', ...registration });
  }
}
