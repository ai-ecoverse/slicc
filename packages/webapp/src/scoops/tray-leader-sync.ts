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
import { PreviewBridgeCdpTransport } from '../cdp/preview-bridge-cdp-transport.js';
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
import type { LeaderSyncContext } from './tray-leader/context.js';
import {
  type ConnectedFollower,
  type FloatType,
  FollowerRegistry,
  labelForFollower,
} from './tray-leader/follower-registry.js';
import { FsRouter } from './tray-leader/fs-router.js';
import { type RemoteExecResult, RemoteExecRouter } from './tray-leader/remote-exec.js';
import { TabRouter } from './tray-leader/tab-router.js';
import { TranscriptExportManager } from './tray-leader/transcript-export.js';
import {
  CHERRY_RUNTIME_TAG,
  type CherryHostEventMessage,
  type FollowerToLeaderMessage,
  isCherryHostEventMessage,
  type LeaderToFollowerMessage,
  type RemoteTargetInfo,
  type ScoopSummary,
  type SprinkleSummary,
  TRAY_SYNC_PROTOCOL_VERSION,
  type TrayFsRequest,
  type TrayFsResponse,
  type TrayTargetEntry,
  unhandledProtocolMessage,
} from './tray-sync-protocol.js';
import { TrayTargetRegistry } from './tray-target-registry.js';
import type { TrayDataChannelLike } from './tray-webrtc.js';

const log = createLogger('tray-leader-sync');

export type { FloatType, RemoteExecResult };
export { labelForFollower };

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

/**
 * True when a target is a cooperative cherry host page rather than a real
 * browser page. Cherry targets only lend the capabilities they advertise, so
 * teleport routing must treat them specially (see `selectTeleportPool`).
 */
export function isCherryTarget(t: Pick<RemoteTargetInfo, 'kind'>): boolean {
  return t.kind === 'cherry';
}

/**
 * Filter a list of advertised targets down to those eligible for a teleport.
 * Real browser targets always qualify. A cherry host page is included for a
 * network-requiring teleport (`requireNetwork: true`) only when it explicitly
 * advertises `capabilities.network === true` — honoring the field the protocol
 * doc on `RemoteTargetInfo.capabilities` says "gates whether the target may
 * serve `Network.*` CDP for teleport-pool selection." When the teleport does
 * not need network, cherry targets are always kept.
 *
 * Consumed by `getBestFollowerForTeleport` (auto-select) via
 * `canRuntimeServeTeleport`. The explicit `teleport --runtime <id>` path is
 * gated separately in `playwright-command.ts` at arm time, which rejects a
 * runtime advertising the `CHERRY_RUNTIME_TAG` before any watcher is created.
 */
export function selectTeleportPool<
  T extends Pick<RemoteTargetInfo, 'kind' | 'capabilities'> & { targetId: string },
>(targets: T[], opts: { requireNetwork: boolean }): T[] {
  return targets.filter((t) => {
    // Preview targets have no Network.* support, always exclude
    if (t.kind === 'preview') return false;
    if (!isCherryTarget(t)) return true;
    // Cherry hosts drive a host-page realm over postMessage; they can only
    // serve a network-requiring teleport if they explicitly advertise it.
    if (opts.requireNetwork) return t.capabilities?.network === true;
    return true;
  });
}

export class LeaderSyncManager {
  private readonly followerRegistry: FollowerRegistry;
  private readonly context: LeaderSyncContext;
  private readonly broadcast: BroadcastManager;
  private readonly cdpRouter: CDPRouter;
  private readonly remoteExec: RemoteExecRouter;
  private readonly fsRouter: FsRouter;
  private readonly tabRouter: TabRouter;
  private readonly transcriptExport: TranscriptExportManager;
  private readonly registry = new TrayTargetRegistry();
  private get followers(): Map<string, ConnectedFollower> {
    return this.context.followers.followers;
  }
  private get runtimeToBootstrap(): Map<string, string> {
    return this.context.followers.runtimeToBootstrap;
  }
  /** Mint map: previewToken → {url, title, quiet} */
  private readonly mintMap = new Map<string, { url: string; title: string; quiet: boolean }>();
  /** Bridge connections: connId → {previewToken, origin, userAgent, connectedAt, url, title, quiet, transport} */
  private readonly bridgeConns = new Map<
    string,
    {
      previewToken: string;
      origin: string;
      userAgent: string;
      connectedAt: string;
      url: string;
      title: string;
      quiet: boolean;
      transport: PreviewBridgeCdpTransport;
    }
  >();
  /** Rate-limit preview lick bursts: previewToken → last emit timestamp */
  private readonly previewLickLastEmitAt = new Map<string, number>();
  private static readonly PREVIEW_LICK_THROTTLE_MS = 2000;

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
    this.cdpRouter = new CDPRouter(this.context, {
      getBridgeTransport: (connId) => this.getBridgeTransport(connId),
    });
    this.remoteExec = new RemoteExecRouter(this.context);
    this.followerRegistry.onFollowerRemoved({
      removeRuntime: (_bootstrapId, runtimeId) => {
        this.registry.removeRuntime(runtimeId);
      },
      afterRegistryCleanup: (bootstrapId) => {
        if (this.registry.hasChanged()) this.broadcastTargetRegistry();
      },
    });
    this.fsRouter = new FsRouter(this.context);
    this.tabRouter = new TabRouter(this.context, {
      getTargetEntries: () => this.registry.getEntries(),
      isCherryTarget,
    });
    this.transcriptExport = new TranscriptExportManager(this.context);
    Object.defineProperty(this, 'activeExports', {
      get: () => this.transcriptExport.activeExports,
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
    const entries = this.getFollowerBroadcastEntries();
    if (entries.length > 0) {
      sync.send({ type: 'targets.registry', targets: entries });
    }
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

  private handleFollowerTargetsAdvertise(
    bootstrapId: string,
    message: FollowerToLeaderMessage & { type: 'targets.advertise' }
  ): void {
    log.info('Follower targets advertised', {
      bootstrapId,
      runtimeId: message.runtimeId,
      targetCount: message.targets.length,
    });
    this.cdpRouter.cleanupOrphanedRemoteTransports(message.runtimeId);
    this.followerRegistry.setRuntimeId(message.runtimeId, bootstrapId);
    this.registry.setTargets(message.runtimeId, message.targets);

    // Derive Cherry host origin from the first cherry-kind target URL.
    // Stored for the approval dialog; never accepted from the request payload.
    const follower = this.followers.get(bootstrapId);
    if (follower && follower.runtime === CHERRY_RUNTIME_TAG) {
      const cherryTarget = message.targets.find((t) => t.kind === 'cherry');
      if (cherryTarget) {
        try {
          follower.hostOrigin = new URL(cherryTarget.url).origin;
        } catch {
          // Malformed URL — omit hostOrigin
        }
      }
    }

    this.broadcastTargetRegistry();
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
        this.handleFollowerTargetsAdvertise(bootstrapId, message);
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
        this.routeCherryHostEvent(bootstrapId, message);
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
    const entries = this.getFollowerBroadcastEntries();
    const message: LeaderToFollowerMessage = { type: 'targets.registry', targets: entries };
    this.followerRegistry.broadcastToAllFollowers(message);
  }

  /**
   * Get the merged target registry entries.
   * Used to implement TrayTargetProvider for the leader's BrowserAPI.
   */
  getTargets(): TrayTargetEntry[] {
    return this.getConnectedEntries();
  }

  /**
   * Follower-facing subset of the target registry. Preview bridge targets
   * (`kind: 'preview'`) are leader-only — only the leader's own BrowserAPI can
   * drive them (the follower `cdp.request` path has no `runtimeId: 'preview'`
   * route), so they must never be advertised to followers.
   */
  private getFollowerBroadcastEntries(): TrayTargetEntry[] {
    return this.getConnectedEntries().filter((t) => t.kind !== 'preview');
  }

  private getConnectedEntries(): TrayTargetEntry[] {
    const registryEntries = this.registry.getEntries().filter((target) => {
      if (target.runtimeId === 'leader') return true;
      const bootstrapId = this.runtimeToBootstrap.get(target.runtimeId);
      return bootstrapId ? this.followers.has(bootstrapId) : false;
    });

    // Add bridge connections as preview targets
    const bridgeEntries: TrayTargetEntry[] = [];
    for (const [connId, entry] of this.bridgeConns) {
      bridgeEntries.push({
        targetId: `preview:${entry.previewToken}:${connId}`,
        localTargetId: connId,
        runtimeId: 'preview',
        title: entry.title,
        url: entry.url,
        isLocal: false,
        kind: 'preview',
      });
    }

    return [...registryEntries, ...bridgeEntries];
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
   * Whether a runtime can serve a (network-requiring) cookie teleport. A cherry
   * host can never serve `Network.*`, so it is excluded two ways: the
   * `CHERRY_RUNTIME_TAG` runtime tag short-circuits even before the follower has
   * advertised any targets (closing the pre-advertisement window), and once
   * targets exist they must pass `selectTeleportPool` with `requireNetwork`.
   * A runtime with no registry entries yet (and a non-cherry tag) is given the
   * benefit of the doubt — same posture as `canRuntimeOpenTab`.
   */
  private canRuntimeServeTeleport(runtimeId: string, follower: ConnectedFollower): boolean {
    if (follower.runtime === CHERRY_RUNTIME_TAG) return false;
    // `getEntries()` clears the registry dirty flag — benign here for the same
    // reason documented on `canRuntimeOpenTab`: advertise paths broadcast
    // synchronously before any teleport selection can interleave.
    const entries = this.registry.getEntries().filter((e) => e.runtimeId === runtimeId);
    if (entries.length === 0) return true;
    return selectTeleportPool(entries, { requireNetwork: true }).length > 0;
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
    const candidates: {
      runtimeId: string;
      bootstrapId: string;
      floatType: FloatType;
      lastActivity: number;
    }[] = [];
    for (const [runtimeId, bootstrapId] of this.runtimeToBootstrap) {
      const follower = this.followers.get(bootstrapId);
      if (!follower) continue;
      if (!this.canRuntimeServeTeleport(runtimeId, follower)) continue;
      candidates.push({
        runtimeId,
        bootstrapId,
        floatType: follower.floatType,
        lastActivity: follower.lastActivity,
      });
    }
    if (candidates.length === 0) return null;
    // Prefer standalone, then sort by most recent activity
    const standalone = candidates.filter((c) => c.floatType === 'standalone');
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
    // Tear down any live preview-bridge transports (each holds pending CDP
    // timeout timers) and clear the bridge/mint/rate-limit registries so a
    // stopped leader leaves no leaked transports or stale state behind.
    for (const entry of this.bridgeConns.values()) {
      entry.transport.disconnect();
    }
    this.bridgeConns.clear();
    this.mintMap.clear();
    this.previewLickLastEmitAt.clear();
  }

  /** Resolve the advertised runtimeId for a follower's bootstrapId, if known. */
  private runtimeIdForBootstrap(bootstrapId: string): string | undefined {
    return this.followerRegistry.runtimeIdForBootstrap(bootstrapId);
  }

  // ---------------------------------------------------------------------------
  // Cherry event routing
  // ---------------------------------------------------------------------------

  /**
   * Route an inbound `cherry.host_event` (a named event emitted by a cherry
   * host page on a follower) to the cone as a `'cherry'` lick. The host origin
   * is not carried at this protocol layer, so it is left undefined.
   */
  private routeCherryHostEvent(bootstrapId: string, message: CherryHostEventMessage): void {
    if (!isCherryHostEventMessage(message)) return;
    const onCherryHostEvent = this.options.onCherryHostEvent;
    if (!onCherryHostEvent) {
      log.debug('cherry.host_event received but no onCherryHostEvent wired', {
        bootstrapId,
        name: message.name,
      });
      return;
    }
    const cherryRuntimeId = this.runtimeIdForBootstrap(bootstrapId);
    try {
      onCherryHostEvent(cherryRuntimeId, message.name, message.detail);
    } catch (err) {
      log.warn('Failed to route cherry.host_event to cone', {
        bootstrapId,
        name: message.name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Send a `cherry.slicc_event` (cone → host page) to the follower that owns
   * `targetId`. The composite `targetId` is `{runtimeId}:{localTargetId}`; the
   * leader resolves the owning runtime and forwards the named event with its
   * optional detail. Returns true if the message was sent, false if the owning
   * follower is not connected.
   */
  emitCherrySliccEvent(targetId: string, name: string, detail?: unknown): boolean {
    const sep = targetId.indexOf(':');
    const targetRuntimeId = sep >= 0 ? targetId.slice(0, sep) : targetId;
    const targetBootstrapId = this.runtimeToBootstrap.get(targetRuntimeId);
    const targetFollower = targetBootstrapId ? this.followers.get(targetBootstrapId) : undefined;
    if (!targetFollower) {
      log.warn('emitCherrySliccEvent: owning follower not connected', { targetId, name });
      return false;
    }
    return targetFollower.sync.send({ type: 'cherry.slicc_event', targetId, name, detail });
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
    this.mintMap.set(previewToken, meta);
  }

  /**
   * Drop a minted preview entry. Called on preview revoke (Task 17). Also evicts
   * the per-(token,lifecycle) lick-throttle timestamps so the map doesn't grow
   * across repeated serve/stop cycles in a long-lived leader session.
   */
  dropMintedPreview(previewToken: string): void {
    this.mintMap.delete(previewToken);
    this.previewLickLastEmitAt.delete(`${previewToken}:connected`);
    this.previewLickLastEmitAt.delete(`${previewToken}:disconnected`);
  }

  /**
   * Handle an inbound bridge.connected message from the worker.
   * Resolves metadata from the mint map (fallback: url=origin, title='Preview', quiet=false),
   * builds a PreviewBridgeCdpTransport, and stores the per-conn entry.
   * Emits a 'preview' lifecycle lick (unless quiet) with rate-limiting per previewToken.
   */
  onBridgeConnected(msg: WorkerBridgeConnected): void {
    const { connId, previewToken, origin, userAgent, connectedAt } = msg;
    // Idempotent: the DO replays `bridge.connected` when a leader (re)connects,
    // so a connId we already track must not spawn a second transport (which would
    // leak the first and its pending-CDP timers). A fresh leader after a page
    // reload has an empty map, so a genuine replay still registers.
    if (this.bridgeConns.has(connId)) return;
    const mint = this.mintMap.get(previewToken);
    const url = mint?.url ?? origin;
    const title = mint?.title ?? 'Preview';
    const quiet = mint?.quiet ?? false;

    const transport = new PreviewBridgeCdpTransport({
      connId,
      targetUrl: url,
      targetOrigin: origin,
      title,
      send: (m) => this.options.sendControl(m),
    });

    // Connect the transport immediately
    void transport.connect();

    this.bridgeConns.set(connId, {
      previewToken,
      origin,
      userAgent,
      connectedAt,
      url,
      title,
      quiet,
      transport,
    });

    log.info('Preview bridge connected', { connId, previewToken, origin, userAgent });

    this.emitPreviewLifecycleLick('connected', {
      connId,
      previewToken,
      origin,
      userAgent,
      connectedAt,
      quiet,
    });
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
    const { connId, reason } = msg;
    const entry = this.bridgeConns.get(connId);
    if (!entry) return;

    const { previewToken, origin, userAgent, connectedAt, quiet } = entry;

    entry.transport.disconnect();
    this.bridgeConns.delete(connId);

    log.info('Preview bridge disconnected', { connId, reason });

    this.emitPreviewLifecycleLick('disconnected', {
      connId,
      previewToken,
      origin,
      userAgent,
      connectedAt,
      quiet,
    });
  }

  /**
   * Emit a preview lifecycle lick (connected/disconnected) unless the preview is
   * `--quiet`. Rate-limited per (previewToken, lifecycle) so a connect lick never
   * suppresses the paired disconnect lick within the throttle window (and vice
   * versa) — a quick visit must still surface its disconnect, or the cone would
   * believe a gone tab is still live.
   */
  private emitPreviewLifecycleLick(
    lifecycle: 'connected' | 'disconnected',
    conn: {
      connId: string;
      previewToken: string;
      origin: string;
      userAgent: string;
      connectedAt: string;
      quiet: boolean;
    }
  ): void {
    if (conn.quiet || !this.options.onPreviewLick) return;
    const throttleKey = `${conn.previewToken}:${lifecycle}`;
    const now = Date.now();
    const lastEmit = this.previewLickLastEmitAt.get(throttleKey) ?? 0;
    if (now - lastEmit < LeaderSyncManager.PREVIEW_LICK_THROTTLE_MS) return;
    this.previewLickLastEmitAt.set(throttleKey, now);
    const event: LickEvent = {
      type: 'preview',
      previewLifecycle: lifecycle,
      previewConnId: conn.connId,
      previewToken: conn.previewToken,
      previewOrigin: conn.origin,
      previewUserAgent: conn.userAgent,
      previewConnectedAt: conn.connectedAt,
      timestamp: new Date().toISOString(),
      body: {},
    };
    try {
      this.options.onPreviewLick(event);
    } catch (err) {
      log.warn('onPreviewLick handler threw', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Handle an inbound bridge.cdp.response message from the worker.
   * Delivers the response to the per-conn transport.
   */
  onBridgeCdpResponse(msg: WorkerBridgeCdpResponse): void {
    const { connId, id, result, error } = msg;
    const entry = this.bridgeConns.get(connId);
    if (!entry) {
      log.warn('Received bridge.cdp.response for unknown connId', { connId, id });
      return;
    }
    entry.transport.deliverResponse(id, { result, error });
  }

  /**
   * Get the per-conn transport for a given connId.
   * Returns undefined if the connection is not tracked.
   */
  getBridgeTransport(connId: string): PreviewBridgeCdpTransport | undefined {
    return this.bridgeConns.get(connId)?.transport;
  }
}
