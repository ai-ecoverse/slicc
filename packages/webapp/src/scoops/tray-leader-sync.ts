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
import { base64ToUint8, uint8ToBase64 } from '@slicc/shared-ts';
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
import { handleFsRequest } from './tray-fs-handler.js';
import { BroadcastManager } from './tray-leader/broadcast.js';
import { CDPRouter } from './tray-leader/cdp-router.js';
import type { LeaderSyncContext } from './tray-leader/context.js';
import {
  type ConnectedFollower,
  type FloatType,
  FollowerRegistry,
  labelForFollower,
} from './tray-leader/follower-registry.js';
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
  type TrayExecChunkMessage,
  type TrayExecRequestMessage,
  type TrayExecResponseMessage,
  type TrayExecSignalMessage,
  type TrayFsRequest,
  type TrayFsResponse,
  type TrayTargetEntry,
  unhandledProtocolMessage,
} from './tray-sync-protocol.js';
import { TrayTargetRegistry } from './tray-target-registry.js';
import type { TrayDataChannelLike } from './tray-webrtc.js';

const log = createLogger('tray-leader-sync');

export type { FloatType };
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

/** Buffered result of a remote command executed on a follower (the `ssh` command). */
export interface RemoteExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** Set when the follower could not run the command at all. */
  error?: string;
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

/** Tracks a leader-initiated remote exec (the `ssh` command) awaiting the follower's streamed reply. */
interface PendingRemoteExec {
  bootstrapId: string;
  stdout: string;
  stderr: string;
  /**
   * Per-stream streaming UTF-8 decoders. The follower reads arbitrary byte
   * blocks, so a multibyte character can straddle two `exec.chunk`s; a fresh
   * decoder per chunk would turn both halves into replacement chars. `{stream:
   * true}` carries the partial sequence across chunks.
   */
  stdoutDecoder: TextDecoder;
  stderrDecoder: TextDecoder;
  /** Total bytes buffered so far (memory-cap guard). */
  bytes: number;
  /** True once output was truncated at the byte cap. */
  truncated: boolean;
  onChunk?: (stream: 'stdout' | 'stderr', data: string) => void;
  resolve: (result: RemoteExecResult) => void;
  reject: (err: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
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

export class LeaderSyncManager {
  private readonly followerRegistry: FollowerRegistry;
  private readonly context: LeaderSyncContext;
  private readonly broadcast: BroadcastManager;
  private readonly cdpRouter: CDPRouter;
  private readonly transcriptExport: TranscriptExportManager;
  private readonly registry = new TrayTargetRegistry();
  private get followers(): Map<string, ConnectedFollower> {
    return this.context.followers.followers;
  }
  private get runtimeToBootstrap(): Map<string, string> {
    return this.context.followers.runtimeToBootstrap;
  }
  /** Maps requestId → routing info for tab.open requests in flight through the leader. */
  private readonly pendingTabOpenRoutes = new Map<string, PendingTabOpenRoute>();
  /** Resolvers for leader-originated tab.open requests. */
  private readonly tabOpenResolvers = new Map<
    string,
    { resolve: (targetId: string) => void; reject: (err: Error) => void }
  >();
  /** Maps requestId → routing info for fs requests in flight through the leader. */
  private readonly pendingFsRoutes = new Map<string, PendingFsRoute>();
  /** Resolvers for leader-originated fs requests. */
  private readonly fsResolvers = new Map<
    string,
    {
      resolve: (responses: TrayFsResponse[]) => void;
      reject: (err: Error) => void;
      responses: TrayFsResponse[];
    }
  >();
  /** Leader-initiated remote execs (the `ssh` command) awaiting a follower reply, keyed by (unguessable) requestId. */
  private readonly pendingRemoteExecs = new Map<string, PendingRemoteExec>();
  /**
   * Follower-initiated local execs (a CLI `exec`) running in the leader's shell,
   * keyed by `${bootstrapId}:${requestId}` so one follower's request id can't
   * collide with (or cancel) another follower's exec.
   */
  private readonly localExecAborters = new Map<
    string,
    { bootstrapId: string; controller: AbortController }
  >();
  /** Cap the buffered output of a single `ssh` command so an unbounded remote command can't exhaust page memory. */
  private static readonly MAX_REMOTE_EXEC_BYTES = 16 * 1024 * 1024;
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
    this.followerRegistry.onFollowerRemoved({
      beforeRegistryCleanup: (bootstrapId) => {
        for (const [requestId, pending] of this.pendingRemoteExecs) {
          if (pending.bootstrapId !== bootstrapId) continue;
          this.pendingRemoteExecs.delete(requestId);
          if (pending.timer) clearTimeout(pending.timer);
          pending.reject(new Error('follower disconnected before the command completed'));
        }
        for (const [requestId, entry] of this.localExecAborters) {
          if (entry.bootstrapId !== bootstrapId) continue;
          entry.controller.abort();
          this.localExecAborters.delete(requestId);
        }
      },
      removeRuntime: (_bootstrapId, runtimeId) => {
        this.registry.removeRuntime(runtimeId);
      },
      afterRegistryCleanup: (bootstrapId) => {
        if (this.registry.hasChanged()) this.broadcastTargetRegistry();
      },
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
    const resolved = this.resolveFollowerByRuntimeId(runtimeId);
    if (!resolved) {
      throw new Error(`No connected follower for '${runtimeId}'`);
    }
    const { bootstrapId, follower } = resolved;
    if (!follower.peerCapabilities?.exec) {
      throw new Error(
        `Follower '${runtimeId}' is not an exec target — only a 'slicc … follow' CLI accepts commands`
      );
    }
    // Unguessable id so a hostile follower can't forge a reply for someone
    // else's `ssh` command (the reply path also verifies the bootstrapId).
    const requestId = `lexec-${crypto.randomUUID()}`;
    return new Promise<RemoteExecResult>((resolve, reject) => {
      const pending: PendingRemoteExec = {
        bootstrapId,
        stdout: '',
        stderr: '',
        stdoutDecoder: new TextDecoder('utf-8'),
        stderrDecoder: new TextDecoder('utf-8'),
        bytes: 0,
        truncated: false,
        onChunk: opts.onChunk,
        resolve,
        reject,
      };
      if (opts.timeoutMs && opts.timeoutMs > 0) {
        pending.timer = setTimeout(() => {
          if (!this.pendingRemoteExecs.delete(requestId)) return;
          this.sendExecSignal(bootstrapId, requestId, 'SIGKILL');
          reject(new Error(`exec on '${runtimeId}' timed out after ${opts.timeoutMs}ms`));
        }, opts.timeoutMs);
      }
      this.pendingRemoteExecs.set(requestId, pending);

      if (opts.signal) {
        const onAbort = (): void => this.sendExecSignal(bootstrapId, requestId, 'SIGINT');
        if (opts.signal.aborted) onAbort();
        else opts.signal.addEventListener('abort', onAbort, { once: true });
      }

      const sent = follower.sync.send({
        type: 'exec.request',
        requestId,
        command,
        cwd: opts.cwd,
        env: opts.env,
      });
      if (!sent) {
        this.pendingRemoteExecs.delete(requestId);
        if (pending.timer) clearTimeout(pending.timer);
        reject(new Error(`Failed to send exec.request to follower '${runtimeId}'`));
      }
    });
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
   * Resolve a follower by the runtime id the `host` command displays. Prefers
   * the advertised-target mapping (`runtimeToBootstrap`); falls back to the
   * canonical `follower-<bootstrapId>` identity so a CLI follower that never
   * advertised browser targets is still addressable. The fallback mirrors
   * `canonicalRuntimeId` (ui/runtime-identity.ts), kept inline to avoid a
   * scoops→ui import.
   */
  private resolveFollowerByRuntimeId(
    runtimeId: string
  ): { bootstrapId: string; follower: ConnectedFollower } | null {
    return this.followerRegistry.resolveFollowerByRuntimeId(runtimeId);
  }

  /** Send an `exec.signal` to the follower running a leader-initiated exec. */
  private sendExecSignal(
    bootstrapId: string,
    requestId: string,
    signal: 'SIGINT' | 'SIGTERM' | 'SIGKILL'
  ): void {
    this.followers.get(bootstrapId)?.sync.send({ type: 'exec.signal', requestId, signal });
  }

  /** Accumulate + forward a streamed output block from a leader-initiated exec. */
  private handleRemoteExecChunk(bootstrapId: string, message: TrayExecChunkMessage): void {
    const pending = this.pendingRemoteExecs.get(message.requestId);
    // Only the follower the request was sent to may stream its output.
    if (!pending || pending.bootstrapId !== bootstrapId) return;
    let bytes: Uint8Array;
    try {
      bytes = base64ToUint8(message.data);
    } catch {
      return;
    }
    // Memory guard: once the cap is hit, keep draining (so exec.response still
    // resolves) but stop accumulating.
    if (pending.truncated) return;
    pending.bytes += bytes.length;
    if (pending.bytes > LeaderSyncManager.MAX_REMOTE_EXEC_BYTES) {
      pending.truncated = true;
    }
    const decoder = message.stream === 'stdout' ? pending.stdoutDecoder : pending.stderrDecoder;
    const text = decoder.decode(bytes, { stream: true });
    if (message.stream === 'stdout') pending.stdout += text;
    else pending.stderr += text;
    pending.onChunk?.(message.stream, text);
  }

  /** Resolve a leader-initiated exec on its terminal `exec.response`. */
  private handleRemoteExecResponse(bootstrapId: string, message: TrayExecResponseMessage): void {
    const pending = this.pendingRemoteExecs.get(message.requestId);
    if (!pending || pending.bootstrapId !== bootstrapId) return;
    this.pendingRemoteExecs.delete(message.requestId);
    if (pending.timer) clearTimeout(pending.timer);
    // Flush any bytes the streaming decoders were holding for a partial char.
    pending.stdout += pending.stdoutDecoder.decode();
    pending.stderr += pending.stderrDecoder.decode();
    pending.resolve({
      stdout: pending.truncated ? `${pending.stdout}\n[output truncated at cap]` : pending.stdout,
      stderr: pending.stderr,
      exitCode: message.exitCode,
      error: message.error,
    });
  }

  /** Route the four exec.* messages (kept out of the main switch for length). */
  private handleFollowerExecMessage(
    bootstrapId: string,
    message:
      | TrayExecRequestMessage
      | TrayExecChunkMessage
      | TrayExecResponseMessage
      | TrayExecSignalMessage
  ): void {
    switch (message.type) {
      case 'exec.request':
        // A CLI follower's `slicc … exec` — run it in the leader's own shell.
        void this.handleFollowerExecRequest(bootstrapId, message);
        break;
      case 'exec.chunk':
        // Streamed output of a leader-initiated `ssh` exec running on a follower.
        this.handleRemoteExecChunk(bootstrapId, message);
        break;
      case 'exec.response':
        this.handleRemoteExecResponse(bootstrapId, message);
        break;
      case 'exec.signal':
        // The CLI follower cancelled a `slicc … exec` it started; abort it.
        this.handleFollowerExecSignal(bootstrapId, message);
        break;
    }
  }

  /**
   * Run a CLI follower's `slicc … exec` command in the leader's own shell,
   * streaming each output block back as an `exec.chunk` and the exit code as a
   * terminal `exec.response`. Refuses with an error response when no
   * `execInShell` is wired (a leader float without a worker shell).
   */
  private async handleFollowerExecRequest(
    bootstrapId: string,
    message: TrayExecRequestMessage
  ): Promise<void> {
    const { requestId, command, cwd, env } = message;
    const execInShell = this.options.execInShell;
    if (!execInShell) {
      this.followers.get(bootstrapId)?.sync.send({
        type: 'exec.response',
        requestId,
        exitCode: 127,
        error: 'exec is not supported on this leader',
      });
      return;
    }
    const controller = new AbortController();
    const abortKey = `${bootstrapId}:${requestId}`;
    this.localExecAborters.set(abortKey, { bootstrapId, controller });
    try {
      const result = await execInShell(command, {
        cwd,
        env,
        signal: controller.signal,
        onChunk: (stream, data) => {
          this.followers.get(bootstrapId)?.sync.send({
            type: 'exec.chunk',
            requestId,
            stream,
            data: uint8ToBase64(new TextEncoder().encode(data)),
          });
        },
      });
      this.followers.get(bootstrapId)?.sync.send({
        type: 'exec.response',
        requestId,
        exitCode: result.exitCode,
        error: result.error,
      });
    } catch (err) {
      this.followers.get(bootstrapId)?.sync.send({
        type: 'exec.response',
        requestId,
        exitCode: 1,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.localExecAborters.delete(abortKey);
    }
  }

  /**
   * Abort a local `exec` run when the originating CLI follower cancels it. Keyed
   * by `${bootstrapId}:${requestId}` so a follower can only cancel its own exec.
   */
  private handleFollowerExecSignal(bootstrapId: string, message: TrayExecSignalMessage): void {
    this.localExecAborters.get(`${bootstrapId}:${message.requestId}`)?.controller.abort();
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
          this.executeLocalTabOpen(requestId, url, bootstrapId);
        } else {
          this.forwardTabOpen(requestId, targetRuntimeId, url, bootstrapId);
        }
        break;
      }
      case 'tab.opened':
        this.handleTabOpenResponse(message.requestId, message.targetId);
        break;
      case 'tab.open.error':
        this.handleTabOpenError(message.requestId, message.error);
        break;
      case 'fs.request': {
        const { requestId, targetRuntimeId, request } = message;
        if (targetRuntimeId === 'leader') {
          this.executeLocalFs(requestId, request, bootstrapId);
        } else {
          this.forwardFsRequest(requestId, targetRuntimeId, request, bootstrapId);
        }
        break;
      }
      case 'fs.response':
        this.handleFsResponse(message.requestId, message.response);
        break;
      case 'exec.request':
      case 'exec.chunk':
      case 'exec.response':
      case 'exec.signal':
        this.handleFollowerExecMessage(bootstrapId, message);
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

  // ---------------------------------------------------------------------------
  // Tab open routing
  // ---------------------------------------------------------------------------

  /**
   * Whether a runtime can honor a generic `tab.open`. A runtime whose only
   * advertised targets are cherry host pages cannot — a cooperative host page
   * is not a tab spawner and the tray `capabilities` shape (navigate/network/
   * screenshot) carries no `openUrl` capability, so we refuse rather than emit
   * a `tab.open` the cherry host can't honor. Runtimes with at least one real
   * browser target (or no registry entry yet) are allowed through unchanged.
   */
  private canRuntimeOpenTab(targetRuntimeId: string): boolean {
    // `getEntries()` is a read that ALSO clears the registry's dirty flag.
    // That is benign here: the registry mutation paths (`setTargets` via
    // `targets.advertise` / `setLocalTargets`) broadcast in the same
    // synchronous turn, before any `tab.open` can interleave — so a `tab.open`
    // gating read can never swallow a not-yet-broadcast change.
    const entries = this.registry.getEntries().filter((e) => e.runtimeId === targetRuntimeId);
    if (entries.length === 0) return true;
    return entries.some((e) => !isCherryTarget(e));
  }

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

    if (!this.canRuntimeOpenTab(targetRuntimeId)) {
      return Promise.reject(
        new Error(`Target runtime "${targetRuntimeId}" is a cherry host that cannot open tabs`)
      );
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
  private async executeLocalTabOpen(
    requestId: string,
    url: string,
    requesterBootstrapId: string
  ): Promise<void> {
    const follower = this.followers.get(requesterBootstrapId);
    if (!follower) return;

    const transport = this.options.browserTransport;
    if (!transport) {
      follower.sync.send({
        type: 'tab.open.error',
        requestId,
        error: 'Leader has no browser transport',
      });
      return;
    }

    try {
      const result = await transport.send('Target.createTarget', { url, background: true });
      const targetId = result['targetId'] as string;
      follower.sync.send({ type: 'tab.opened', requestId, targetId: `leader:${targetId}` });
    } catch (err) {
      follower.sync.send({
        type: 'tab.open.error',
        requestId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Forward a tab.open request from one follower to another.
   */
  private forwardTabOpen(
    requestId: string,
    targetRuntimeId: string,
    url: string,
    requesterBootstrapId: string
  ): void {
    const targetBootstrapId = this.runtimeToBootstrap.get(targetRuntimeId);
    const targetFollower = targetBootstrapId ? this.followers.get(targetBootstrapId) : undefined;
    const requester = this.followers.get(requesterBootstrapId);

    if (!targetFollower) {
      if (requester) {
        requester.sync.send({
          type: 'tab.open.error',
          requestId,
          error: `Target runtime "${targetRuntimeId}" not connected`,
        });
      }
      return;
    }

    if (!this.canRuntimeOpenTab(targetRuntimeId)) {
      if (requester) {
        requester.sync.send({
          type: 'tab.open.error',
          requestId,
          error: `Target runtime "${targetRuntimeId}" is a cherry host that cannot open tabs`,
        });
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
    requesterBootstrapId: string
  ): Promise<void> {
    const follower = this.followers.get(requesterBootstrapId);
    if (!follower) return;

    const vfs = this.options.vfs;
    if (!vfs) {
      follower.sync.send({
        type: 'fs.response',
        requestId,
        response: { ok: false, error: 'Leader has no VFS' },
      });
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
    requesterBootstrapId: string
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
    this.pendingFsRoutes.set(requestId, {
      requesterBootstrapId,
      requestId,
      chunks: [],
      totalChunks: 1,
    });

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
      return Promise.resolve([
        { ok: false, error: `Target runtime "${targetRuntimeId}" not connected` },
      ]);
    }

    const requestId = `fs-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    return new Promise<TrayFsResponse[]>((resolve, reject) => {
      this.fsResolvers.set(requestId, { resolve, reject, responses: [] });
      this.pendingFsRoutes.set(requestId, {
        requesterBootstrapId: '__leader__',
        requestId,
        chunks: [],
        totalChunks: 1,
      });
      targetFollower.sync.send({ type: 'fs.request', requestId, request });
    });
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
