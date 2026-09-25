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
  type SnapshotChunkBuffer,
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

export function shouldApplyFollowerStatus(
  statusScoopJid: string | undefined,
  selectedScoopJid: string | null
): boolean {
  return statusScoopJid === undefined || statusScoopJid === selectedScoopJid;
}

export class FollowerSyncManager implements AgentHandle {
  private readonly sync: TraySyncChannel<FollowerToLeaderMessage, LeaderToFollowerMessage>;
  private readonly eventListeners = new Set<(event: AgentEvent) => void>();
  private readonly unsubscribe: () => void;
  private readonly keepalive: DataChannelKeepalive;
  private latestSnapshot: { messages: ChatMessage[]; scoopJid: string } | null = null;
  private readonly sentMessageIds = new Set<string>();
  private targetEntries: TrayTargetEntry[] = [];

  private readonly snapshotChunkBuffers = new Map<string, SnapshotChunkBuffer>();

  private leaderProtocolVersion?: number;

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

  sendMessage(
    text: string,
    messageId?: string,
    attachments?: MessageAttachment[],
    options?: { steer?: boolean }
  ): boolean {
    const id = messageId ?? `follower-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.sentMessageIds.add(id);

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
      this.sentMessageIds.delete(id);
      log.warn('Channel refused a user message', { messageId: id });
    }
    return accepted;
  }

  onEvent(callback: (event: AgentEvent) => void): () => void {
    this.eventListeners.add(callback);
    return () => this.eventListeners.delete(callback);
  }

  stop(): boolean {
    const accepted = this.sync.send({ type: 'abort' });
    if (accepted) log.info('Sent abort to leader');
    else log.warn('Channel refused an abort');
    return accepted;
  }

  requestSnapshot(scoopJid?: string): void {
    this.sync.send({ type: 'request_snapshot', ...(scoopJid ? { scoopJid } : {}) });
  }

  requestNewSession(action: 'save' | 'skip' | 'erase'): void {
    this.sync.send({ type: 'new_session', action });
    log.info('Sent new_session to leader', { action });
  }

  selectScoop(scoopJid: string): void {
    this.sync.send({ type: 'scoops.select', scoopJid });
  }

  requestModels(): void {
    this.sync.send({ type: 'models.request' });
  }

  selectModel(modelId: string, scoopJid?: string): void {
    this.sync.send({ type: 'model.select', modelId, ...(scoopJid ? { scoopJid } : {}) });
  }

  setThinkingLevel(
    scoopJid: string,
    thinkingLevel: TrayThinkingLevel,
    effortOverride?: string
  ): void {
    this.sync.send({ type: 'thinking.set', scoopJid, thinkingLevel, effortOverride });
  }

  getLatestSnapshot(): { messages: ChatMessage[]; scoopJid: string } | null {
    return this.latestSnapshot;
  }

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

  private rejectPendingRequests(reason: string): void {
    this.sprinkles.rejectPending(reason);
    this.oauthPopups.abortAll();
    this.sudoClient.abortAll();
    this.tabTeleport.rejectPending(reason);
    this.fsBridge.rejectPending(reason);
    this.remoteCdp.rejectPending();
    this.exportClient.rejectPending();
    this.snapshotChunkBuffers.clear();
  }

  advertiseTargets(targets: RemoteTargetInfo[], runtimeId: string): void {
    this.sync.send({ type: 'targets.advertise', targets, runtimeId });
  }

  getTargets(): TrayTargetEntry[] {
    return this.targetEntries;
  }

  sendCherryHostEvent(name: string, detail?: unknown): void {
    this.sync.send({
      type: 'cherry.host_event',
      targetId: this.options.selfRuntimeId ?? '',
      name,
      detail,
    });
  }

  getSprinkles(): SprinkleSummary[] {
    return this.sprinkles.getSprinkles();
  }

  refreshSprinkles(): void {
    this.sync.send({ type: 'sprinkles.refresh' });
  }

  fetchSprinkleContent(sprinkleName: string): Promise<string> {
    return this.sprinkles.fetchSprinkleContent(sprinkleName);
  }

  sendSprinkleLick(sprinkleName: string, body: unknown, targetScoop?: string): void {
    const ok = this.sync.send({ type: 'sprinkle.lick', sprinkleName, body, targetScoop });
    if (!ok) log.warn('sendSprinkleLick dropped: tray channel closed', { sprinkleName });
  }

  reportSprinkleInstances(sprinkleNames: string[]): void {
    const ok = this.sync.send({ type: 'sprinkle.instances', sprinkles: sprinkleNames });
    if (!ok) log.debug('reportSprinkleInstances dropped: tray channel closed');
  }

  forwardLick(event: LickEvent): boolean {
    const ok = this.sync.send({ type: 'lick', event });
    if (!ok) log.warn('forwardLick dropped: tray channel closed', { type: event.type });
    return ok;
  }

  clearSprinkleCache(sprinkleName?: string): void {
    this.sprinkles.clearSprinkleCache(sprinkleName);
  }

  cancelSprinkleFetch(sprinkleName: string, reason = 'fetch cancelled'): void {
    this.sprinkles.cancelSprinkleFetch(sprinkleName, reason);
  }

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

  private handleKeepaliveMessage(type: 'ping' | 'pong'): void {
    if (type === 'ping') {
      this.keepalive.receivePing();
      this.sync.send({ type: 'pong' });
      return;
    }
    this.keepalive.receivePong();
    setFollowerLastPingTime(Date.now());
  }

  private handleSnapshot(messages: ChatMessage[], scoopJid: string): void {
    log.info('Snapshot received from leader', { messageCount: messages.length, scoopJid });
    this.snapshotChunkBuffers.delete(scoopJid);
    this.latestSnapshot = { messages, scoopJid };
    this.options.onSnapshot?.(messages, scoopJid);
  }

  private handleSnapshotChunk(
    message: Extract<LeaderToFollowerMessage, { type: 'snapshot_chunk' }>
  ): void {
    const assembled = reassembleSnapshot(this.snapshotChunkBuffers, message);
    if (!assembled) return;
    log.info('Chunked snapshot reassembled from leader', {
      messageCount: assembled.messages.length,
      scoopJid: assembled.scoopJid,
    });
    this.latestSnapshot = assembled;
    this.options.onSnapshot?.(assembled.messages, assembled.scoopJid);
  }

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
      case 'user_message_ack':
        this.handleUserMessageAck(message);
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

      case 'computers.list':
      case 'computer.frame':
      case 'computer.native.capture':
      case 'computer.native.unwatch':
      case 'computer.native.input':
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
      this.options.onOwnUserMessageEcho?.(message.messageId, message.scoopJid);
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

  private handleUserMessageAck(
    message: LeaderToFollowerMessage & { type: 'user_message_ack' }
  ): void {
    const { messageId, scoopJid, state, error } = message;
    if (state === 'rejected') log.warn('Leader rejected a user message', { messageId, error });
    else log.info('Leader accepted a user message', { messageId, scoopJid });
    this.options.onUserMessageAck?.({
      messageId,
      scoopJid,
      state,
      ...(error !== undefined ? { error } : {}),
    });
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

  registerPushToken(registration: {
    platform: 'ios';
    token: string;
    environment: 'sandbox' | 'production';
  }): boolean {
    return this.sync.send({ type: 'push.register', ...registration });
  }
}
