/**
 * Leader sync manager — broadcasts agent events and snapshots to followers
 * over WebRTC data channels using the typed tray sync protocol.
 */

import type {
  LeaderToWorkerControlMessage,
  TranscriptExportSelector,
  TraySudoKind,
  WorkerBridgeCdpResponse,
  WorkerBridgeConnected,
  WorkerBridgeDisconnected,
  WorkerPreviewState,
} from '@slicc/shared-ts';
import { createLogger } from '../base/logger.js';
import type { BrowserAPI } from '../cdp/browser-api.js';
import type { PreviewBridgeCdpTransport } from '../cdp/preview-bridge-cdp-transport.js';
import type { CDPTransport } from '../cdp/transport.js';
import type { AgentEvent } from '../core/agent-types.js';
import type { MessageAttachment } from '../core/attachments.js';
import type { VirtualFS } from '../fs/virtual-fs.js';
import type {
  SprinkleBroadcastResult,
  SprinkleInstance,
  SprinkleSendTarget,
} from '../shell/sprinkle-manager-handle.js';
import type { SudoDecision, SudoRequest } from '../sudo/types.js';
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
import { runDelegatedCdpLogin } from './tray-leader/oauth-cdp-login.js';
import {
  type DelegatedOAuthResult,
  OAuthPopupDelegation,
} from './tray-leader/oauth-popup-delegation.js';
import { PreviewBridgeManager, type PreviewLifecycleRecord } from './tray-leader/preview-bridge.js';
import { type RemoteExecResult, RemoteExecRouter } from './tray-leader/remote-exec.js';
import { type LastUserMessageOrigin, RequesterTracker } from './tray-leader/requester-tracker.js';
import { SudoDelegation } from './tray-leader/sudo-delegation.js';
import { TabRouter } from './tray-leader/tab-router.js';
import { TabTeleportRouter } from './tray-leader/tab-teleport-router.js';
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
  /** Resolve the named unit's model and thinking state (#2310). */
  getModelSelectionState?: (scoopJid: string) => TrayModelSelectionState;
  /**
   * Apply a validated follower model selection to the cone the follower is
   * looking at (#2310). `scoopJid` is that follower's selected unit — a
   * scoop resolves to the cone that owns it. False rejects the pick without
   * changing state.
   */
  onFollowerModelSelect?: (modelId: string, scoopJid?: string) => boolean;
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
   * A follower's set of rendered sprinkles changed. The page mirrors
   * `getSprinkleInstances()` into the worker shim so `sprinkle list` — which
   * runs in the kernel worker — can report per-instance state (issue #2166).
   */
  onSprinkleInstancesChanged?: () => void;
  /**
   * Called when a follower re-advertises its targets, which can flip its
   * teleport eligibility without changing the follower count. Lets the host
   * re-publish any cached follower snapshot kernel-side selection reads from.
   */
  onFollowerTargetsChanged?: () => void;
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
   * Gate a follower-originated action through the kernel's sudo policy +
   * broker (issue #2062 folded the transcript-export approval into sudo).
   * The kernel checks `NOPASSWD` grants, routes the prompt to the human —
   * which may come straight back to this page as a tray delegation — and
   * persists "Always". Derive follower identity from connected state; never
   * trust the request payload for it. Unset → the gate denies.
   */
  requestSudoApproval?: (request: {
    kind: TraySudoKind;
    detail: string;
    suggestedPattern?: string;
    followerLabel: string;
    hostOrigin?: string;
  }) => Promise<SudoDecision>;
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
  private readonly requesterTracker = new RequesterTracker();
  private readonly tabTeleportRouter: TabTeleportRouter;
  private readonly oauthPopupDelegation: OAuthPopupDelegation;
  private readonly sudoDelegation: SudoDelegation;
  /** Follower bootstrap ids that registered a push token this session. */
  private readonly pushRegistered = new Set<string>();
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
      onTeleportEligibilityChanged: () => this.options.onFollowerTargetsChanged?.(),
    });
    this.transcriptExport = new TranscriptExportManager(context);
    this.fsRouter = new FsRouter(context);
    this.tabRouter = new TabRouter(context, {
      getTargetEntries: () => this.teleportPool.getRegistryEntries(),
      isCherryTarget,
    });
    this.cherryRouter = new CherryRouter(context);
    this.tabTeleportRouter = new TabTeleportRouter(context, {
      getTargetEntries: () => this.teleportPool.getConnectedEntries(),
    });
    this.oauthPopupDelegation = new OAuthPopupDelegation(context);
    this.sudoDelegation = new SudoDelegation(context);
    this.followerDispatch = new FollowerDispatch(context, {
      broadcast: this.broadcast,
      cdpRouter: this.cdpRouter,
      remoteExec: this.remoteExec,
      fsRouter: this.fsRouter,
      tabRouter: this.tabRouter,
      teleportPool: this.teleportPool,
      transcriptExport: this.transcriptExport,
      cherryRouter: this.cherryRouter,
      requesterTracker: this.requesterTracker,
      tabTeleportRouter: this.tabTeleportRouter,
      oauthPopupDelegation: this.oauthPopupDelegation,
      sudoDelegation: this.sudoDelegation,
      registerPushToken: (bootstrapId, registration) => {
        this.pushRegistered.add(bootstrapId);
        try {
          this.options.sendControl({ type: 'push.register', bootstrapId, ...registration });
        } catch (err) {
          log.warn('Could not forward push.register to the tray hub', {
            bootstrapId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      },
    });
    this.followerRegistry.onFollowerRemoved({
      afterRegistryCleanup: (bootstrapId) =>
        this.requesterTracker.handleFollowerRemoved(bootstrapId),
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

  /** Every follower-rendered sprinkle document, for `sprinkle list`. */
  getSprinkleInstances(): SprinkleInstance[] {
    return this.followerRegistry.getSprinkleInstances();
  }

  broadcastSprinkleUpdate(
    sprinkleName: string,
    data: unknown,
    target?: SprinkleSendTarget
  ): SprinkleBroadcastResult {
    return this.broadcast.broadcastSprinkleUpdate(sprinkleName, data, target);
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

  getTeleportEligibleBootstrapIds(): Set<string> {
    return this.teleportPool.getTeleportEligibleBootstrapIds();
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

  /**
   * Should a sudo prompt go to a tray follower's human instead of this
   * leader's native dialog? Same shape as {@link shouldDelegateOAuthLogin}: a
   * headless leader always says yes (it parks the prompt and push-wakes a
   * phone if nobody is connected); a leader with a human says yes only when a
   * `sudoApproval` follower is connected AND the last user message came from a
   * follower — the human is demonstrably elsewhere (issue #2062).
   */
  shouldDelegateSudo(): boolean {
    if (this.options.headlessLeader === true) return true;
    if (!this.sudoDelegation.hasCapableFollower()) return false;
    return this.requesterTracker.get()?.kind === 'follower';
  }

  /** Ship a sudo prompt to the capable followers; first verdict wins. */
  delegateSudoApproval(request: SudoRequest, opts?: { scoopName?: string }): Promise<SudoDecision> {
    return this.sudoDelegation.requestApproval(request, opts);
  }

  /**
   * The leader's turn finished. Ask the hub to wake registered phones with a
   * `turn_end` banner (metadata only). No-op until some follower has
   * registered a push token this session, so leaders without an iOS follower
   * never chatter at the hub.
   */
  notifyTurnEnd(scoopLabel: string): void {
    if (this.pushRegistered.size === 0) return;
    try {
      this.options.sendControl({ type: 'push.send', category: 'turn_end', label: scoopLabel });
    } catch (err) {
      log.debug?.('push.send(turn_end) not delivered', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Record that the leader's own UI submitted a user message. */
  noteLeaderUserMessage(): void {
    this.requesterTracker.noteLeaderUserMessage();
  }

  /** Where the most recent user message came from (leader UI or a follower). */
  getLastUserMessageOrigin(): LastUserMessageOrigin | null {
    return this.requesterTracker.get();
  }

  /**
   * Can any connected follower host an interactive OAuth popup? Callers use
   * this to fail fast with an actionable message instead of prompting into a
   * void (#1915).
   */
  hasDelegatableFollower(): boolean {
    return this.pickDriveableFollower() !== null || this.pickOAuthPopupFollower() !== null;
  }

  /**
   * Should an interactive login run on a follower rather than here?
   *
   * A headless leader answers yes unconditionally — even with no capable
   * follower connected. It has no human of its own, so falling back to a local
   * popup would put the prompt in a sandbox nobody is watching: the exact
   * #1915 failure this delegation exists to remove. Saying yes routes the
   * attempt through `delegateOAuthLogin`, which reports "no connected follower
   * can show an interactive login" and lets the command fail fast instead.
   *
   * A leader WITH a human only delegates when there is somewhere to delegate
   * to and the human is demonstrably elsewhere (the last user message came
   * from a follower).
   */
  shouldDelegateOAuthLogin(): boolean {
    if (this.options.headlessLeader === true) return true;
    if (!this.hasDelegatableFollower()) return false;
    return this.requesterTracker.get()?.kind === 'follower';
  }

  /**
   * Run the interactive half of an OAuth login on a follower.
   *
   * Two mechanisms, preferred in this order:
   *
   *  1. **Drive the follower's browser** (`runDelegatedCdpLogin`) — open the
   *     authorize URL as a normal tab and read the callback off its
   *     navigation. No popup, so no user-activation problem; no
   *     `window.opener`, so COOP cannot sever it; no same-origin requirement.
   *  2. **Ask the follower's page to open a popup** — for floats with no CDP
   *     surface of their own (a plain browser tab at a join URL, cherry, the
   *     extension side panel), where there is nothing to drive.
   *
   * Either way only the callback URL comes back; nonce validation, the code
   * exchange and persistence stay here.
   */
  async delegateOAuthLogin(url: string): Promise<DelegatedOAuthResult> {
    const driveable = this.pickDriveableFollower();
    if (driveable && this.options.browserAPI) {
      log.info('Delegating OAuth login by driving a follower browser', {
        runtimeId: driveable.runtimeId,
      });
      try {
        const redirectUrl = await runDelegatedCdpLogin({
          browser: this.options.browserAPI,
          runtimeId: driveable.runtimeId,
          authorizeUrl: url,
        });
        return { redirectUrl };
      } catch (err) {
        // Fall through to the popup rather than failing the login outright:
        // a follower can lose its CDP surface between advertisement and use.
        log.warn('Driven login failed; trying the popup path', { error: String(err) });
      }
    }

    const bootstrapId = this.pickOAuthPopupFollower();
    if (!bootstrapId) {
      return {
        redirectUrl: null,
        error: 'no connected follower can show an interactive login',
      };
    }
    log.info('Delegating OAuth popup to a follower', { bootstrapId });
    return this.oauthPopupDelegation.requestPopup(bootstrapId, url);
  }

  /**
   * A follower whose browser the leader can drive: it must be able to host a
   * tab AND serve `Network.*`, which is exactly the teleport bar.
   */
  private pickDriveableFollower(): { bootstrapId: string; runtimeId: string } | null {
    const eligible = this.teleportPool.getTeleportEligibleBootstrapIds();
    const runtimeFor = (bootstrapId: string): string | undefined =>
      this.followerRegistry.runtimeIdForBootstrap(bootstrapId);

    const origin = this.requesterTracker.get();
    if (origin?.kind === 'follower' && eligible.has(origin.bootstrapId)) {
      const runtimeId = runtimeFor(origin.bootstrapId);
      if (runtimeId) return { bootstrapId: origin.bootstrapId, runtimeId };
    }
    const candidates = [...this.followerRegistry.followers.values()]
      .filter((follower) => eligible.has(follower.bootstrapId))
      .sort((a, b) => b.lastActivity - a.lastActivity);
    for (const candidate of candidates) {
      const runtimeId = runtimeFor(candidate.bootstrapId);
      if (runtimeId) return { bootstrapId: candidate.bootstrapId, runtimeId };
    }
    return null;
  }

  /** The follower that should host a popup-based login, if any. */
  private pickOAuthPopupFollower(): string | null {
    const canPopup = (bootstrapId: string): boolean =>
      this.followerRegistry.followers.get(bootstrapId)?.peerCapabilities?.oauthPopup === true;

    const origin = this.requesterTracker.get();
    if (origin?.kind === 'follower' && canPopup(origin.bootstrapId)) return origin.bootstrapId;

    const candidates = [...this.followerRegistry.followers.values()]
      .filter((follower) => canPopup(follower.bootstrapId))
      .sort((a, b) => b.lastActivity - a.lastActivity);
    return candidates[0]?.bootstrapId ?? null;
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
