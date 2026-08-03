/**
 * Leader sync manager — broadcasts agent events and snapshots to followers
 * over WebRTC data channels using the typed tray sync protocol.
 */

import type {
  LeaderToWorkerControlMessage,
  TranscriptExportSelector,
  WorkerBridgeCdpResponse,
  WorkerBridgeConnected,
  WorkerBridgeDisconnected,
  WorkerPreviewState,
} from '@slicc/shared-ts';
import type { BrowserAPI } from '../cdp/browser-api.js';
import type { PreviewBridgeCdpTransport } from '../cdp/preview-bridge-cdp-transport.js';
import type { CDPTransport } from '../cdp/transport.js';
import type { AgentEvent } from '../core/agent-types.js';
import type { MessageAttachment } from '../core/attachments.js';
import { createLogger } from '../core/logger.js';
import type { VirtualFS } from '../fs/virtual-fs.js';
import type { TranscriptZipResult } from '../transcript/zip-stream.js';
import type { ChatMessage } from './chat-types.js';
import type { LickEvent } from './lick-manager.js';
import { BroadcastManager } from './tray-leader/broadcast.js';
import { CDPRouter } from './tray-leader/cdp-router.js';
import { CherryRouter } from './tray-leader/cherry-router.js';
import type { LeaderSyncContext } from './tray-leader/context.js';
import { FollowerDispatch } from './tray-leader/follower-dispatch.js';
import {
  type ConnectedFollower,
  deriveFloatType,
  type FloatType,
  type FollowerDetails,
  FollowerRegistry,
  labelForFollower,
} from './tray-leader/follower-registry.js';
import { FsRouter } from './tray-leader/fs-router.js';
import { PreviewBridgeManager, type PreviewLifecycleRecord } from './tray-leader/preview-bridge.js';
import { type RemoteExecResult, RemoteExecRouter } from './tray-leader/remote-exec.js';
import { TabRouter } from './tray-leader/tab-router.js';
import { isCherryTarget, selectTeleportPool, TeleportPool } from './tray-leader/teleport-pool.js';
import { TranscriptExportManager } from './tray-leader/transcript-export.js';
import {
  type RemoteTargetInfo,
  type ScoopSummary,
  type SprinkleSummary,
  TRAY_SYNC_PROTOCOL_VERSION,
  type TrayFsRequest,
  type TrayFsResponse,
  type TrayModelCatalogEntry,
  type TrayModelSelectionState,
  type TrayTargetEntry,
  type TrayThinkingLevel,
} from './tray-sync-protocol.js';
import type { TrayDataChannelLike } from './tray-webrtc.js';

const log = createLogger('tray-leader-sync');

export type { FloatType, RemoteExecResult };
export { deriveFloatType, isCherryTarget, labelForFollower, selectTeleportPool };

export interface LeaderSyncManagerOptions {
  /** Get current chat messages for the active scoop. */
  getMessages: () => ChatMessage[];
  /** Get messages for an arbitrary scoop (used when a follower views a non-active scoop). */
  getMessagesForScoop?: (scoopJid: string) => ChatMessage[] | Promise<ChatMessage[]>;
  /** Get the active scoop JID. */
  getScoopJid: () => string;
  /** Get summaries for every registered scoop. Optional — when omitted, scoops list won't be broadcast. */
  getScoops?: () => ScoopSummary[];
  /** Get summaries for every available sprinkle. Optional — when omitted, sprinkles list won't be broadcast. */
  getSprinkles?: () => SprinkleSummary[];
  /** Build the credential-free model catalog advertised to followers. */
  getModelCatalog?: () => TrayModelCatalogEntry[];
  /** Resolve the current global model and per-scoop thinking state. */
  getModelSelectionState?: (scoopJid: string) => TrayModelSelectionState;
  /** Apply a validated follower model selection. False rejects it without changing state. */
  onFollowerModelSelect?: (modelId: string) => boolean;
  /** Apply thinking configuration to the follower's selected scoop. */
  onFollowerThinkingSet?: (
    scoopJid: string,
    thinkingLevel: TrayThinkingLevel,
    effortOverride?: string
  ) => void | Promise<unknown>;
  /** Resolve a sprinkle's raw .shtml content for follower-side rendering. */
  readSprinkleContent?: (sprinkleName: string) => Promise<string | null> | string | null;
  /** Forward a sprinkle lick (from a follower's open or inline sprinkle) to the leader's lick router. */
  onSprinkleLick?: (
    sprinkleName: string,
    body: unknown,
    targetScoop?: string,
    originLabel?: string
  ) => void;
  /**
   * Handle a generic lick (e.g. `navigate`) forwarded by a follower.
   * The event arrives already validated, scrubbed, and stamped with
   * `originFollowerId`/`originLabel`. Adapters route it into the
   * leader's `lickManager.emitEvent`.
   */
  onForwardedLick?: (event: LickEvent, originBootstrapId: string) => void;
  /** Handle a user message arriving from a follower. */
  onFollowerMessage: (
    text: string,
    messageId: string,
    attachments?: MessageAttachment[],
    options?: { steer?: boolean }
  ) => void;
  /** Handle an abort request from a follower. */
  onFollowerAbort: () => void;
  /**
   * Handle a follower's request to start a new session (freezer new-chat).
   * The follower has no VFS / cone to run `runNewSessionFreeze` itself; the
   * leader owns the archive + `clearAllMessages`. After clearing, the leader
   * must broadcast the cleared snapshot back to every follower so already-
   * connected followers drop the stale chat.
   */
  onFollowerNewSession?: (action: 'save' | 'skip' | 'erase', bootstrapId: string) => void;
  /** Optional CDP transport for executing local CDP commands (leader's browser). */
  browserTransport?: CDPTransport;
  /** Optional BrowserAPI instance for session-aware browser commands (e.g. cookie capture). */
  browserAPI?: BrowserAPI;
  /** Called when a follower's data channel is considered dead (missed keepalive pongs). */
  onFollowerDead?: (bootstrapId: string) => void;
  /** VirtualFS instance for handling remote fs requests targeting the leader. */
  vfs?: VirtualFS;
  /** Called whenever a follower is added or removed (incl. via dead detection or stop). */
  onFollowerCountChanged?: (count: number) => void;
  /**
   * Deliver an inbound cherry host event (`cherry.host_event`) to the cone as a
   * `'cherry'` lick. The sync manager resolves the owning follower's runtime id
   * and hands it off; the callback owns reaching the LickManager (which lives in
   * the kernel worker — standalone bridges page→worker via `OffscreenClient`,
   * the extension calls the in-process orchestrator). Optional — when omitted,
   * host events are dropped (no cone-side delivery).
   */
  onCherryHostEvent?: (cherryRuntimeId: string | undefined, name: string, detail?: unknown) => void;
  /**
   * Deliver a preview bridge lifecycle event (connect/disconnect) to the cone as a
   * `'preview'` lick. Called by `onBridgeConnected` / `onBridgeDisconnected` unless
   * the per-conn `quiet` flag is set. The callback owns reaching the LickManager.
   * Optional — when omitted, preview lifecycle licks are dropped.
   */
  onPreviewLick?: (event: LickEvent) => void;
  /**
   * Invoked from `cleanupRemoteTransports` (follower disconnect) with the
   * runtimeId whose page-side RemoteCDPTransports were just disconnected.
   * The standalone page wires this to the remote-CDP bridge so its
   * worker-facing session map drops matching sessions in sync. See #848.
   */
  onRemoteTransportsCleaned?: (runtimeId: string) => void;
  /**
   * Send a control message to the worker over the controller WebSocket.
   * Wired by buildSyncManager to leaderTray.sendControlMessage.
   */
  sendControl: (msg: LeaderToWorkerControlMessage) => void;
  /**
   * Run a shell command in the leader's own virtual shell on behalf of a
   * follower. `sessionId` is stable for that follower connection, allowing the
   * page-side runner to preserve cwd and environment across requests.
   */
  execInShell?: (
    command: string,
    opts: {
      sessionId: string;
      cwd?: string;
      env?: Record<string, string>;
      signal: AbortSignal;
      onChunk: (stream: 'stdout' | 'stderr', data: string) => void;
    }
  ) => Promise<{ exitCode: number; error?: string }>;
  /** Close the persistent leader shell owned by a disconnected follower. */
  closeExecShell?: (sessionId: string) => void;
  /**
   * Called when a follower requests a transcript export. The leader shows an
   * approval dialog and resolves true (allow) or false (deny). Derive follower
   * identity from connected state; never trust the request payload for it.
   */
  requestTranscriptExportApproval?: (request: {
    requestId: string;
    followerLabel: string;
    hostOrigin?: string;
    selector: TranscriptExportSelector;
    estimatedBytes?: number;
  }) => Promise<boolean>;
  /**
   * True when this leader tab has no interactive human of its own. The approval
   * gate is delegated to the requesting follower rather than skipped.
   */
  headlessLeader?: boolean;
  /**
   * Create a TranscriptZipResult for a follower-requested export.
   * The AbortSignal is cancelled on deny/cancel/disconnect/error.
   */
  createTranscriptExport?: (
    selector: TranscriptExportSelector,
    signal: AbortSignal
  ) => Promise<TranscriptZipResult>;
}

export class LeaderSyncManager {
  private lastThemeJson: string | null = null;
  private readonly followerRegistry: FollowerRegistry;
  private readonly broadcast: BroadcastManager;
  private readonly cdpRouter: CDPRouter;
  private readonly remoteExec: RemoteExecRouter;
  private readonly fsRouter: FsRouter;
  private readonly tabRouter: TabRouter;
  private readonly previewBridge: PreviewBridgeManager;
  private readonly cherryRouter: CherryRouter;
  private readonly teleportPool: TeleportPool;
  private readonly transcriptExport: TranscriptExportManager;
  private readonly followerDispatch: FollowerDispatch;
  private get followers(): Map<string, ConnectedFollower> {
    return this.followerRegistry.followers;
  }

  constructor(private readonly options: LeaderSyncManagerOptions) {
    this.followerRegistry = new FollowerRegistry({
      log,
      onMessage: (bootstrapId, message) => this.followerDispatch.dispatch(bootstrapId, message),
      onFollowerDead: (bootstrapId) => this.options.onFollowerDead?.(bootstrapId),
      onFollowerCountChanged: (count) => this.options.onFollowerCountChanged?.(count),
    });
    const context: LeaderSyncContext = {
      options,
      followers: this.followerRegistry,
      log,
      sendControl: options.sendControl,
    };
    this.broadcast = new BroadcastManager(context);
    this.previewBridge = new PreviewBridgeManager(context);
    this.cdpRouter = new CDPRouter(context, {
      getBridgeTransport: (connId) => this.previewBridge.getBridgeTransport(connId),
    });
    this.remoteExec = new RemoteExecRouter(context);
    this.teleportPool = new TeleportPool(context, {
      cleanupOrphanedRemoteTransports: (runtimeId) =>
        this.cdpRouter.cleanupOrphanedRemoteTransports(runtimeId),
      getPreviewTargetEntries: () => this.previewBridge.getTargetEntries(),
    });
    this.transcriptExport = new TranscriptExportManager(context);
    this.fsRouter = new FsRouter(context);
    this.tabRouter = new TabRouter(context, {
      getTargetEntries: () => this.teleportPool.getRegistryEntries(),
      isCherryTarget,
    });
    this.cherryRouter = new CherryRouter(context);
    this.followerDispatch = new FollowerDispatch(context, {
      broadcast: this.broadcast,
      cdpRouter: this.cdpRouter,
      remoteExec: this.remoteExec,
      fsRouter: this.fsRouter,
      tabRouter: this.tabRouter,
      teleportPool: this.teleportPool,
      transcriptExport: this.transcriptExport,
      cherryRouter: this.cherryRouter,
    });
    Object.defineProperties(this, {
      activeExports: { get: () => this.transcriptExport.activeExports },
      bridgeConns: { get: () => this.previewBridge.bridgeConns },
      mintMap: { get: () => this.previewBridge.mintMap },
    });
  }

  addFollower(
    bootstrapId: string,
    channel: TrayDataChannelLike,
    meta?: { runtime?: string; connectedAt?: string }
  ): void {
    const { sync } = this.followerRegistry.addFollower(bootstrapId, channel, meta);

    sync.send({
      type: 'hello',
      protocolVersion: TRAY_SYNC_PROTOCOL_VERSION,
      capabilities: { exec: this.options.execInShell !== undefined },
    });
    void this.broadcast.sendSnapshotToFollower(bootstrapId);
    this.broadcast.sendScoopsListToFollower(bootstrapId);
    this.broadcast.sendModelCatalogToFollower(bootstrapId);
    this.broadcast.sendSprinklesListToFollower(bootstrapId);
    // The snapshot carries chat state only — a themed leader must also hand
    // the joiner its palette or the phone renders unthemed until the next
    // theme change. Null means unthemed, which is every follower's default.
    if (this.lastThemeJson !== null) {
      sync.send({ type: 'theme.apply', themeJson: this.lastThemeJson });
    }
    this.teleportPool.sendTargetRegistryToFollower(bootstrapId);
  }

  removeFollower(bootstrapId: string): void {
    this.followerRegistry.removeFollower(bootstrapId);
  }

  broadcastEvent(event: AgentEvent): void {
    this.broadcast.broadcastEvent(event);
  }

  broadcastUserMessage(text: string, messageId: string, attachments?: MessageAttachment[]): void {
    this.broadcast.broadcastUserMessage(text, messageId, attachments);
  }

  broadcastStatus(status: string): void {
    this.broadcast.broadcastStatus(status);
  }

  broadcastSnapshot(): void {
    this.broadcast.broadcastSnapshot();
  }

  broadcastScoopsList(): void {
    this.broadcast.broadcastScoopsList();
  }

  broadcastSprinklesList(): void {
    this.broadcast.broadcastSprinklesList();
  }

  broadcastModelCatalog(): void {
    this.broadcast.broadcastModelCatalog();
  }

  broadcastModelState(): void {
    this.broadcast.broadcastModelState();
  }

  broadcastSprinkleUpdate(sprinkleName: string, data: unknown): void {
    this.broadcast.broadcastSprinkleUpdate(sprinkleName, data);
  }

  broadcastTheme(themeJson: string | null): void {
    // Remembered so a follower that joins AFTER the theme was applied still
    // receives it (followers reset per-leader theme state on connect).
    this.lastThemeJson = themeJson;
    this.broadcast.broadcastTheme(themeJson);
  }

  broadcastSprinkleReloaded(sprinkleName: string): void {
    this.broadcast.broadcastSprinkleReloaded(sprinkleName);
  }

  broadcastPreviewOpen(url: string): void {
    this.broadcast.broadcastPreviewOpen(url);
  }

  async execOnRemote(
    runtimeId: string,
    command: string,
    opts: {
      cwd?: string;
      env?: Record<string, string>;
      signal?: AbortSignal;
      onChunk?: (stream: 'stdout' | 'stderr', data: string) => void;
      timeoutMs?: number;
    } = {}
  ): Promise<RemoteExecResult> {
    return this.remoteExec.execOnRemote(runtimeId, command, opts);
  }

  getExecCapableBootstrapIds(): Set<string> {
    return this.followerRegistry.getExecCapableBootstrapIds();
  }

  getBrowserCapableBootstrapIds(): Set<string> {
    return this.followerRegistry.getBrowserCapableBootstrapIds();
  }

  getFollowerMotds(): Map<string, string> {
    return this.followerRegistry.getFollowerMotds();
  }

  getFollowerDetails(): FollowerDetails[] {
    return this.followerRegistry.getFollowerDetails();
  }

  setLocalTargets(targets: RemoteTargetInfo[]): void {
    this.teleportPool.setLocalTargets(targets);
  }

  broadcastTargetRegistry(): void {
    this.teleportPool.broadcastTargetRegistry();
  }

  getTargets(): TrayTargetEntry[] {
    return this.teleportPool.getTargets();
  }

  createRemoteTransport(targetRuntimeId: string, localTargetId: string): CDPTransport {
    return this.cdpRouter.createRemoteTransport(targetRuntimeId, localTargetId);
  }

  removeRemoteTransport(targetRuntimeId: string, localTargetId: string): void {
    this.cdpRouter.removeRemoteTransport(targetRuntimeId, localTargetId);
  }

  getConnectedFollowers(): {
    runtimeId: string;
    runtime?: string;
    connectedAt?: string;
    lastActivity?: number;
    floatType?: FloatType;
  }[] {
    return this.followerRegistry.getConnectedFollowers();
  }

  getBestFollowerForTeleport(): {
    runtimeId: string;
    bootstrapId: string;
    floatType: FloatType;
  } | null {
    return this.teleportPool.getBestFollowerForTeleport();
  }

  get hasFollowers(): boolean {
    return this.followers.size > 0;
  }

  stop(): void {
    this.cdpRouter.resetPreviewFocus();
    for (const bootstrapId of [...this.followers.keys()]) {
      this.removeFollower(bootstrapId);
    }
    this.previewBridge.stop();
  }

  emitCherrySliccEvent(targetId: string, name: string, detail?: unknown): boolean {
    return this.cherryRouter.emitCherrySliccEvent(targetId, name, detail);
  }

  openRemoteTab(targetRuntimeId: string, url: string): Promise<string> {
    return this.tabRouter.openRemoteTab(targetRuntimeId, url);
  }

  sendFsRequest(targetRuntimeId: string, request: TrayFsRequest): Promise<TrayFsResponse[]> {
    return this.fsRouter.sendFsRequest(targetRuntimeId, request);
  }

  registerMintedPreview(
    previewToken: string,
    meta: { url: string; title: string; quiet: boolean }
  ): void {
    this.previewBridge.registerMintedPreview(previewToken, meta);
  }

  dropMintedPreview(previewToken: string): void {
    this.previewBridge.dropMintedPreview(previewToken);
  }

  restorePreviewState(msg: WorkerPreviewState): void {
    this.previewBridge.restorePreviewState(msg);
  }

  getPreviewLifecycleRecords(previewToken?: string): readonly PreviewLifecycleRecord[] {
    return this.previewBridge.getPreviewLifecycleRecords(previewToken);
  }

  clearPreviewLifecycleRecords(previewToken?: string): number {
    return this.previewBridge.clearPreviewLifecycleRecords(previewToken);
  }

  rearmPreviewAnnouncements(previewToken?: string): number {
    return this.previewBridge.rearmPreviewAnnouncements(previewToken);
  }

  onBridgeConnected(msg: WorkerBridgeConnected): void {
    this.previewBridge.onBridgeConnected(msg);
  }

  onBridgeDisconnected(msg: WorkerBridgeDisconnected): void {
    this.previewBridge.onBridgeDisconnected(msg);
  }

  onBridgeCdpResponse(msg: WorkerBridgeCdpResponse): void {
    this.previewBridge.onBridgeCdpResponse(msg);
  }

  getBridgeTransport(connId: string): PreviewBridgeCdpTransport | undefined {
    return this.previewBridge.getBridgeTransport(connId);
  }
}
