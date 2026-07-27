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
} from '@slicc/shared-ts';
import type { BrowserAPI } from '../cdp/browser-api.js';
import type { PreviewBridgeCdpTransport } from '../cdp/preview-bridge-cdp-transport.js';
import type { CDPTransport } from '../cdp/transport.js';
import type { AgentEvent } from '../core/agent-types.js';
import type { MessageAttachment } from '../core/attachments.js';
import { stripLocalPathsForRemote } from '../core/attachments.js';
import { createLogger } from '../core/logger.js';
import type { VirtualFS } from '../fs/virtual-fs.js';
import type { TranscriptZipResult } from '../transcript/zip-stream.js';
import type { ChatMessage } from './chat-types.js';
import { FORWARDABLE_TO_LEADER, type LickEvent } from './lick-manager.js';
import { BroadcastManager } from './tray-leader/broadcast.js';
import { CDPRouter } from './tray-leader/cdp-router.js';
import { CherryRouter } from './tray-leader/cherry-router.js';
import type { LeaderSyncContext } from './tray-leader/context.js';
import {
  type ConnectedFollower,
  type FloatType,
  FollowerRegistry,
  labelForFollower,
} from './tray-leader/follower-registry.js';
import { FsRouter } from './tray-leader/fs-router.js';
import { PreviewBridgeManager } from './tray-leader/preview-bridge.js';
import { type RemoteExecResult, RemoteExecRouter } from './tray-leader/remote-exec.js';
import { TabRouter } from './tray-leader/tab-router.js';
import { isCherryTarget, selectTeleportPool, TeleportPool } from './tray-leader/teleport-pool.js';
import { TranscriptExportManager } from './tray-leader/transcript-export.js';
import {
  type FollowerToLeaderMessage,
  type RemoteTargetInfo,
  type ScoopSummary,
  type SprinkleSummary,
  TRAY_SYNC_PROTOCOL_VERSION,
  type TrayFsRequest,
  type TrayFsResponse,
  type TrayTargetEntry,
  unhandledProtocolMessage,
} from './tray-sync-protocol.js';
import type { TrayDataChannelLike } from './tray-webrtc.js';

const log = createLogger('tray-leader-sync');

export type { FloatType, RemoteExecResult };
export { isCherryTarget, labelForFollower, selectTeleportPool };

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
  onFollowerMessage: (text: string, messageId: string, attachments?: MessageAttachment[]) => void;
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
   * Run a shell command in the leader's own (virtual) shell on behalf of a CLI
   * follower's `slicc … exec`. Streams output blocks through `onChunk` as they
   * arrive and resolves with the process exit code. Optional — a leader float
   * without a worker shell (or a test) leaves it unset, and any inbound
   * `exec.request` is refused with an error `exec.response`. Wired page-side to
   * a `TerminalSessionClient` by `wc-tray.ts`.
   */
  execInShell?: (
    command: string,
    opts: {
      cwd?: string;
      env?: Record<string, string>;
      signal: AbortSignal;
      onChunk: (stream: 'stdout' | 'stderr', data: string) => void;
    }
  ) => Promise<{ exitCode: number; error?: string }>;
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
  private readonly followerRegistry: FollowerRegistry;
  private readonly context: LeaderSyncContext;
  private readonly broadcast: BroadcastManager;
  private readonly cdpRouter: CDPRouter;
  private readonly remoteExec: RemoteExecRouter;
  private readonly fsRouter: FsRouter;
  private readonly tabRouter: TabRouter;
  private readonly previewBridge: PreviewBridgeManager;
  private readonly cherryRouter: CherryRouter;
  private readonly teleportPool: TeleportPool;
  private readonly transcriptExport: TranscriptExportManager;
  private get followers(): Map<string, ConnectedFollower> {
    return this.context.followers.followers;
  }

  constructor(private readonly options: LeaderSyncManagerOptions) {
    this.followerRegistry = new FollowerRegistry({
      log,
      onMessage: (bootstrapId, message) => this.handleFollowerMessage(bootstrapId, message),
      onFollowerDead: (bootstrapId) => this.options.onFollowerDead?.(bootstrapId),
      onFollowerCountChanged: (count) => this.options.onFollowerCountChanged?.(count),
    });
    this.context = {
      options,
      followers: this.followerRegistry,
      log,
      sendControl: options.sendControl,
    };
    this.broadcast = new BroadcastManager(this.context);
    this.previewBridge = new PreviewBridgeManager(this.context);
    this.cdpRouter = new CDPRouter(this.context, {
      getBridgeTransport: (connId) => this.previewBridge.getBridgeTransport(connId),
    });
    this.remoteExec = new RemoteExecRouter(this.context);
    this.teleportPool = new TeleportPool(this.context, {
      cleanupOrphanedRemoteTransports: (runtimeId) =>
        this.cdpRouter.cleanupOrphanedRemoteTransports(runtimeId),
      getPreviewTargetEntries: () => this.previewBridge.getTargetEntries(),
    });
    this.fsRouter = new FsRouter(this.context);
    this.tabRouter = new TabRouter(this.context, {
      getTargetEntries: () => this.teleportPool.getRegistryEntries(),
      isCherryTarget,
    });
    this.cherryRouter = new CherryRouter(this.context);
    this.transcriptExport = new TranscriptExportManager(this.context);
    Object.defineProperties(this, {
      activeExports: { get: () => this.transcriptExport.activeExports },
      bridgeConns: { get: () => this.previewBridge.bridgeConns },
      mintMap: { get: () => this.previewBridge.mintMap },
    });
  }

  /**
   * Add a connected follower's data channel.
   * Sends an initial snapshot and subscribes to follower messages.
   */
  addFollower(
    bootstrapId: string,
    channel: TrayDataChannelLike,
    meta?: { runtime?: string; connectedAt?: string }
  ): void {
    const { sync } = this.followerRegistry.addFollower(bootstrapId, channel, meta);

    // Version handshake first — additive; legacy followers drop it harmlessly.
    sync.send({ type: 'hello', protocolVersion: TRAY_SYNC_PROTOCOL_VERSION });

    // Send initial snapshot
    void this.broadcast.sendSnapshotToFollower(bootstrapId);

    // Send scoops list and sprinkles list so the follower can populate its UI
    this.broadcast.sendScoopsListToFollower(bootstrapId);
    this.broadcast.sendSprinklesListToFollower(bootstrapId);

    // Send current target registry to the new follower
    this.teleportPool.sendTargetRegistryToFollower(bootstrapId);
  }

  /**
   * Remove a follower's data channel and clean up.
   */
  removeFollower(bootstrapId: string): void {
    this.followerRegistry.removeFollower(bootstrapId);
  }

  /**
   * Broadcast an agent event to all connected followers.
   * Called from the orchestrator callback wiring in main.ts.
   */
  broadcastEvent(event: AgentEvent): void {
    this.broadcast.broadcastEvent(event);
  }

  /**
   * Broadcast a user message to all connected followers.
   * Called when any user message enters the leader (local or from a follower).
   *
   * Attachments are scrubbed of leader-local VFS paths via
   * `stripLocalPathsForRemote` before going on the wire. The follower-
   * originated path already scrubs in `handleFollowerMessage` (defense
   * in depth — that scrub stays), so the second pass here is idempotent.
   * The leader-originated path (the panel chat `setOnLocalUserMessage`
   * hook) was the gap: leader paths like
   * `/tmp/attachment-<stamp>-<seq>-<rand>-<name>` (the off-load shape
   * produced by `attachment-vfs.ts:makeAttachmentPath`) would have
   * shipped raw to every follower, where they're meaningless.
   */
  broadcastUserMessage(text: string, messageId: string, attachments?: MessageAttachment[]): void {
    this.broadcast.broadcastUserMessage(text, messageId, attachments);
  }

  /**
   * Broadcast a status change to all connected followers.
   */
  broadcastStatus(status: string): void {
    this.broadcast.broadcastStatus(status);
  }

  /**
   * Broadcast the current cone snapshot to every connected follower using
   * each follower's own selected scoop. Called after the leader clears the
   * cone (`runNewSession` → `clearAllMessages`) so already-connected followers
   * drop the stale chat instead of only receiving it on next reconnect /
   * `request_snapshot`.
   */
  broadcastSnapshot(): void {
    this.broadcast.broadcastSnapshot();
  }

  /**
   * Broadcast the current scoop list to every connected follower.
   * Call when scoops are added/removed or the active selection changes.
   */
  broadcastScoopsList(): void {
    this.broadcast.broadcastScoopsList();
  }

  /**
   * Broadcast the current sprinkle list to every connected follower.
   * Call when sprinkles are added/removed or visibility changes.
   */
  broadcastSprinklesList(): void {
    this.broadcast.broadcastSprinklesList();
  }

  /**
   * Push a sprinkle update payload to every connected follower.
   * Mirrors `SprinkleManager.sendToSprinkle` so a follower's open sprinkle
   * gets the same data that the leader's local instance would receive.
   */
  broadcastSprinkleUpdate(sprinkleName: string, data: unknown): void {
    this.broadcast.broadcastSprinkleUpdate(sprinkleName, data);
  }

  broadcastTheme(themeJson: string | null): void {
    this.broadcast.broadcastTheme(themeJson);
  }

  /**
   * Notify every connected follower that a sprinkle's content has changed
   * and should be re-fetched and re-rendered in place.
   */
  broadcastSprinkleReloaded(sprinkleName: string): void {
    this.broadcast.broadcastSprinkleReloaded(sprinkleName);
  }

  /**
   * Tell every connected follower to open the worker-served preview URL.
   * Phase 1: fire-and-forget; followers don't ack (no preview.opened reply).
   */
  broadcastPreviewOpen(url: string): void {
    this.broadcast.broadcastPreviewOpen(url);
  }

  private handleFollowerUserMessage(
    bootstrapId: string,
    message: FollowerToLeaderMessage & { type: 'user_message' }
  ): void {
    log.info('Follower user message received', { bootstrapId, messageId: message.messageId });
    // Defense in depth: even though followers strip their local
    // `path` values before sending, scrub again here so older or
    // mis-behaving peers cannot trick the cone into trying to read
    // a follower-local path that does not exist on this runtime.
    const safeAttachments = message.attachments?.length
      ? stripLocalPathsForRemote(message.attachments)
      : message.attachments;
    this.options.onFollowerMessage(message.text, message.messageId, safeAttachments);
  }

  private handleFollowerSprinkleLick(
    bootstrapId: string,
    message: FollowerToLeaderMessage & { type: 'sprinkle.lick' }
  ): void {
    log.info('Follower sprinkle lick received', {
      bootstrapId,
      sprinkleName: message.sprinkleName,
    });
    const follower = this.followers.get(bootstrapId);
    const originLabel = labelForFollower(follower?.floatType ?? 'unknown', follower?.runtime);
    try {
      this.options.onSprinkleLick?.(
        message.sprinkleName,
        message.body,
        message.targetScoop,
        originLabel
      );
    } catch (err) {
      log.warn('onSprinkleLick handler threw', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private handleFollowerLick(
    bootstrapId: string,
    message: FollowerToLeaderMessage & { type: 'lick' }
  ): void {
    const incoming = message.event;
    if (!incoming || !FORWARDABLE_TO_LEADER.has(incoming.type)) {
      log.warn('Rejecting malformed or non-forwardable lick from follower', {
        bootstrapId,
        type: incoming?.type,
      });
      return;
    }
    const follower = this.followers.get(bootstrapId);
    // Strip follower-sent routing — the leader is the sole authority on
    // origin AND routing. The wire type omits origin fields, and the
    // stamp below overrides any that a malformed peer sneaks through at
    // runtime (later keys win over `...rest`). Forwarded licks (navigate)
    // always target the leader's cone, so a follower `targetScoop` is dropped.
    const { targetScoop: _droppedTarget, ...rest } = incoming;
    const stamped: LickEvent = {
      ...rest,
      originFollowerId: bootstrapId,
      originLabel: labelForFollower(follower?.floatType ?? 'unknown', follower?.runtime),
    };
    try {
      this.options.onForwardedLick?.(stamped, bootstrapId);
    } catch (err) {
      log.warn('onForwardedLick handler threw', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Run a command on a connected follower (the leader-side `ssh` command) and
   * resolve with the buffered stdout/stderr/exit code. Streams each output
   * block to `opts.onChunk` as it arrives, and forwards an abort on
   * `opts.signal` as an `exec.signal`. Rejects if the follower is unknown,
   * isn't an exec target, or disconnects before the command finishes.
   */
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

  /** bootstrapIds of followers that advertised `exec` capability on `hello`. */
  getExecCapableBootstrapIds(): Set<string> {
    return this.followerRegistry.getExecCapableBootstrapIds();
  }

  /**
   * bootstrapIds of followers that advertised browser targets — i.e. reachable
   * via `playwright-cli`. A follower lands in `runtimeToBootstrap` only after it
   * sends a `targets.registry`, so this excludes headless CLI (`exec`-only)
   * followers, which have no browser to drive.
   */
  getBrowserCapableBootstrapIds(): Set<string> {
    return this.followerRegistry.getBrowserCapableBootstrapIds();
  }

  /** Per-follower `hello.motd`, keyed by bootstrapId (exec targets advertise it). */
  getFollowerMotds(): Map<string, string> {
    return this.followerRegistry.getFollowerMotds();
  }

  /**
   * Handle incoming messages from a follower.
   */
  private handleFollowerMessage(bootstrapId: string, message: FollowerToLeaderMessage): void {
    if (message.type !== 'hello') {
      // Ordered channel: a versioned follower's first message is `hello`.
      // Anything else first means a legacy (pre-versioning) build — say so
      // once, so missing-feature reports are diagnosable.
      const follower = this.followers.get(bootstrapId);
      if (follower && follower.peerProtocolVersion === undefined && !follower.legacyPeerLogged) {
        follower.legacyPeerLogged = true;
        log.info('Follower sent no hello — legacy peer (pre-versioning build)', { bootstrapId });
      }
    }
    switch (message.type) {
      case 'user_message':
        this.handleFollowerUserMessage(bootstrapId, message);
        break;
      case 'abort':
        log.info('Follower abort received', { bootstrapId });
        this.options.onFollowerAbort();
        break;
      case 'new_session':
        log.info('Follower new-session received', { bootstrapId, action: message.action });
        try {
          this.options.onFollowerNewSession?.(message.action, bootstrapId);
        } catch (err) {
          log.warn('onFollowerNewSession handler threw', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
        break;
      case 'request_snapshot':
        log.info('Follower snapshot request received', {
          bootstrapId,
          scoopJid: message.scoopJid,
        });
        void this.broadcast.sendSnapshotToFollower(bootstrapId, message.scoopJid);
        break;
      case 'scoops.select': {
        log.info('Follower selected scoop', { bootstrapId, scoopJid: message.scoopJid });
        const follower = this.followers.get(bootstrapId);
        if (follower) {
          follower.selectedScoopJid = message.scoopJid;
          void this.broadcast.sendSnapshotToFollower(bootstrapId, message.scoopJid);
        }
        break;
      }
      case 'sprinkles.refresh':
        log.info('Follower requested sprinkles refresh', { bootstrapId });
        this.broadcast.sendSprinklesListToFollower(bootstrapId);
        break;
      case 'sprinkle.fetch':
        void this.broadcast.handleSprinkleFetch(
          bootstrapId,
          message.requestId,
          message.sprinkleName
        );
        break;
      case 'sprinkle.lick':
        this.handleFollowerSprinkleLick(bootstrapId, message);
        break;
      case 'lick':
        this.handleFollowerLick(bootstrapId, message);
        break;
      case 'targets.advertise':
        this.teleportPool.handleFollowerTargetsAdvertise(bootstrapId, message);
        break;
      case 'cdp.request':
        this.cdpRouter.handleCDPRequest(bootstrapId, message);
        break;
      case 'cdp.response':
        this.cdpRouter.handleCDPResponse(message);
        break;
      case 'cdp.event':
        this.cdpRouter.handleCDPEvent(
          bootstrapId,
          message.method,
          message.params,
          message.sessionId
        );
        break;
      case 'tab.open': {
        const { requestId, targetRuntimeId, url } = message;
        if (targetRuntimeId === 'leader') {
          void this.tabRouter.executeLocalTabOpen(requestId, url, bootstrapId);
        } else {
          this.tabRouter.forwardTabOpen(requestId, targetRuntimeId, url, bootstrapId);
        }
        break;
      }
      case 'tab.opened':
        this.tabRouter.handleTabOpenResponse(message.requestId, message.targetId);
        break;
      case 'tab.open.error':
        this.tabRouter.handleTabOpenError(message.requestId, message.error);
        break;
      case 'fs.request': {
        const { requestId, targetRuntimeId, request } = message;
        if (targetRuntimeId === 'leader') {
          void this.fsRouter.executeLocalFs(requestId, request, bootstrapId);
        } else {
          this.fsRouter.forwardFsRequest(requestId, targetRuntimeId, request, bootstrapId);
        }
        break;
      }
      case 'fs.response':
        this.fsRouter.handleFsResponse(message.requestId, message.response);
        break;
      case 'exec.request':
      case 'exec.chunk':
      case 'exec.response':
      case 'exec.signal':
        this.remoteExec.handleFollowerExecMessage(bootstrapId, message);
        break;
      case 'transcript.export.request':
        void this.transcriptExport.handleTranscriptExportRequest(
          bootstrapId,
          message.requestId,
          message.selector
        );
        break;
      case 'transcript.export.cancel':
        this.transcriptExport.handleTranscriptExportCancel(bootstrapId, message.requestId);
        break;
      case 'transcript.export.ack':
        this.transcriptExport.handleTranscriptExportAck(
          bootstrapId,
          message.requestId,
          message.index
        );
        break;
      case 'transcript.export.approve.response':
        this.transcriptExport.handleTranscriptExportApprovalResponse(
          bootstrapId,
          message.requestId,
          message.approved
        );
        break;
      case 'cherry.host_event':
        this.cherryRouter.routeCherryHostEvent(bootstrapId, message);
        break;
      case 'ping': {
        const follower = this.followers.get(bootstrapId);
        if (follower) {
          follower.keepalive.receivePing();
          follower.lastActivity = Date.now();
          follower.sync.send({ type: 'pong' });
        }
        break;
      }
      case 'pong': {
        const follower = this.followers.get(bootstrapId);
        if (follower) {
          follower.keepalive.receivePong();
          follower.lastActivity = Date.now();
        }
        break;
      }
      case 'hello':
        this.handleFollowerHello(bootstrapId, message);
        break;
      default: {
        // Exhaustiveness guard: a new FollowerToLeaderMessage variant fails
        // compile here until this dispatcher decides. At runtime this branch
        // means a version-skewed follower — log loudly, never throw.
        const unknown = unhandledProtocolMessage(message);
        log.warn('Unknown follower message type — skewed follower?', {
          bootstrapId,
          type: unknown.type,
        });
        break;
      }
    }
  }

  /** Handle a follower `hello` handshake message. */
  private handleFollowerHello(
    bootstrapId: string,
    message: FollowerToLeaderMessage & { type: 'hello' }
  ): void {
    const follower = this.followers.get(bootstrapId);
    if (follower) {
      follower.peerProtocolVersion = message.protocolVersion;
      follower.peerCapabilities = message.capabilities;
      follower.peerMotd = message.motd;
      // `exec` capability arrives on `hello` (after the follower is already
      // counted on connect), so re-notify with the unchanged count to let
      // the page re-mirror the followers shim with fresh exec flags — the
      // `host` / `ssh` listing reads that shim from the kernel worker.
      this.followerRegistry.notifyFollowerCountChanged();
    }
    if (message.protocolVersion > TRAY_SYNC_PROTOCOL_VERSION) {
      log.warn('Follower speaks a newer tray sync protocol — update this build', {
        bootstrapId,
        followerVersion: message.protocolVersion,
        ourVersion: TRAY_SYNC_PROTOCOL_VERSION,
      });
    } else {
      log.info('Follower hello', { bootstrapId, protocolVersion: message.protocolVersion });
    }
  }

  /**
   * Feed the leader's own local browser targets into the registry.
   * Broadcasts the updated registry if targets changed.
   */
  setLocalTargets(targets: RemoteTargetInfo[]): void {
    this.teleportPool.setLocalTargets(targets);
  }

  /**
   * Broadcast the merged target registry to all connected followers.
   */
  broadcastTargetRegistry(): void {
    this.teleportPool.broadcastTargetRegistry();
  }

  /**
   * Get the merged target registry entries.
   * Used to implement TrayTargetProvider for the leader's BrowserAPI.
   */
  getTargets(): TrayTargetEntry[] {
    return this.teleportPool.getTargets();
  }

  /**
   * Create a CDPTransport that routes CDP commands from the leader's
   * BrowserAPI to a follower or bridge-connected preview target.
   */
  createRemoteTransport(targetRuntimeId: string, localTargetId: string): CDPTransport {
    return this.cdpRouter.createRemoteTransport(targetRuntimeId, localTargetId);
  }

  /**
   * Remove a remote transport created for the leader's BrowserAPI.
   */
  removeRemoteTransport(targetRuntimeId: string, localTargetId: string): void {
    this.cdpRouter.removeRemoteTransport(targetRuntimeId, localTargetId);
  }

  /**
   * Return the list of connected follower runtimeIds with metadata.
   */
  getConnectedFollowers(): {
    runtimeId: string;
    runtime?: string;
    connectedAt?: string;
    lastActivity?: number;
    floatType?: FloatType;
  }[] {
    return this.followerRegistry.getConnectedFollowers();
  }

  /**
   * Find the best follower for a cookie teleport.
   * Prefers standalone floats, then sorts by most recent activity.
   * Excludes cherry hosts and any runtime that cannot serve `Network.*`.
   * Returns null if no eligible followers exist.
   */
  getBestFollowerForTeleport(): {
    runtimeId: string;
    bootstrapId: string;
    floatType: FloatType;
  } | null {
    return this.teleportPool.getBestFollowerForTeleport();
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
    this.previewBridge.stop();
  }

  // ---------------------------------------------------------------------------
  // Cherry event routing
  // ---------------------------------------------------------------------------

  /**
   * Send a `cherry.slicc_event` (cone → host page) to the follower that owns
   * `targetId`. The composite `targetId` is `{runtimeId}:{localTargetId}`; the
   * leader resolves the owning runtime and forwards the named event with its
   * optional detail. Returns true if the message was sent, false if the owning
   * follower is not connected.
   */
  emitCherrySliccEvent(targetId: string, name: string, detail?: unknown): boolean {
    return this.cherryRouter.emitCherrySliccEvent(targetId, name, detail);
  }

  /**
   * Open a tab on a remote runtime from the leader's own code.
   * Returns a promise that resolves with the composite targetId ("{runtimeId}:{localTargetId}").
   */
  openRemoteTab(targetRuntimeId: string, url: string): Promise<string> {
    return this.tabRouter.openRemoteTab(targetRuntimeId, url);
  }

  /**
   * Send an fs request to a remote runtime from the leader's own code.
   * Returns a promise that resolves with the response(s).
   */
  sendFsRequest(targetRuntimeId: string, request: TrayFsRequest): Promise<TrayFsResponse[]> {
    return this.fsRouter.sendFsRequest(targetRuntimeId, request);
  }

  // ---------------------------------------------------------------------------
  // Preview bridge connection registry
  // ---------------------------------------------------------------------------

  /**
   * Register a minted preview's metadata. Called by the minter (Task 17).
   */
  registerMintedPreview(
    previewToken: string,
    meta: { url: string; title: string; quiet: boolean }
  ): void {
    this.previewBridge.registerMintedPreview(previewToken, meta);
  }

  /**
   * Drop a minted preview entry. Called on preview revoke (Task 17). Also evicts
   * the per-(token,lifecycle) lick-throttle timestamps so the map doesn't grow
   * across repeated serve/stop cycles in a long-lived leader session.
   */
  dropMintedPreview(previewToken: string): void {
    this.previewBridge.dropMintedPreview(previewToken);
  }

  /**
   * Handle an inbound bridge.connected message from the worker.
   * Resolves metadata from the mint map (fallback: url=origin, title='Preview', quiet=false),
   * builds a PreviewBridgeCdpTransport, and stores the per-conn entry.
   * Emits a 'preview' lifecycle lick (unless quiet) with rate-limiting per previewToken.
   */
  onBridgeConnected(msg: WorkerBridgeConnected): void {
    this.previewBridge.onBridgeConnected(msg);
  }

  /**
   * Handle an inbound bridge.disconnected message from the worker.
   * Drops the per-conn entry and disposes the transport.
   * Emits a 'preview' lifecycle lick (unless quiet) with rate-limiting per previewToken.
   * Reads quiet/origin/userAgent/connectedAt from the per-conn entry (snapshotted at
   * connect), NOT the mint map, so a quiet disconnect stays suppressed even after
   * the mint entry is dropped on stop.
   */
  onBridgeDisconnected(msg: WorkerBridgeDisconnected): void {
    this.previewBridge.onBridgeDisconnected(msg);
  }

  /**
   * Handle an inbound bridge.cdp.response message from the worker.
   * Delivers the response to the per-conn transport.
   */
  onBridgeCdpResponse(msg: WorkerBridgeCdpResponse): void {
    this.previewBridge.onBridgeCdpResponse(msg);
  }

  /**
   * Get the per-conn transport for a given connId.
   * Returns undefined if the connection is not tracked.
   */
  getBridgeTransport(connId: string): PreviewBridgeCdpTransport | undefined {
    return this.previewBridge.getBridgeTransport(connId);
  }
}
