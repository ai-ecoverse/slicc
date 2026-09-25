import type {
  ComputerInputEvent,
  FollowerBiscottoIdentity,
  FollowerTrust,
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
import type {
  SudoApproverDirective,
  SudoDecision,
  SudoRequest,
  TurnGuestGate,
} from '../sudo/types.js';
import type { TranscriptZipResult } from '../transcript/zip-stream.js';
import type { ChatMessage } from './chat-types.js';
import type { LickEvent } from './lick-manager.js';
import { BiscottoReview } from './tray-leader/biscotto-review.js';
import { BroadcastManager } from './tray-leader/broadcast.js';
import { CDPRouter } from './tray-leader/cdp-router.js';
import { CherryRouter } from './tray-leader/cherry-router.js';
import {
  ComputersRouter,
  type NativeComputerCaptureResult,
  type TrayComputersSource,
} from './tray-leader/computers-router.js';
import type { LeaderSyncContext } from './tray-leader/context.js';
import { FollowerDispatch, type FollowerMessageOutcome } from './tray-leader/follower-dispatch.js';
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

export type { FloatType, FollowerMessageOutcome, RemoteExecResult };
export { deriveFloatType, isCherryTarget, labelForFollower, selectTeleportPool };

export interface LeaderSyncManagerOptions {
  getMessages: () => ChatMessage[];

  getMessagesForScoop?: (scoopJid: string) => ChatMessage[] | Promise<ChatMessage[]>;

  getScoopJid: () => string;

  getScoops?: () => ScoopSummary[];

  getSprinkles?: () => SprinkleSummary[];

  computers?: TrayComputersSource;

  getModelCatalog?: () => TrayModelCatalogEntry[];

  getModelSelectionState?: (scoopJid: string) => TrayModelSelectionState;

  onFollowerModelSelect?: (modelId: string, scoopJid?: string) => boolean | Promise<boolean>;

  onFollowerThinkingSet?: (
    scoopJid: string,
    thinkingLevel: TrayThinkingLevel,
    effortOverride?: string
  ) => void | Promise<unknown>;

  readSprinkleContent?: (sprinkleName: string) => Promise<string | null> | string | null;

  onSprinkleLick?: (
    sprinkleName: string,
    body: unknown,
    targetScoop?: string,
    originLabel?: string,
    originUnitJid?: string
  ) => void;

  onForwardedLick?: (event: LickEvent, originBootstrapId: string) => void;

  onFollowerMessage: (
    text: string,
    messageId: string,
    attachments?: MessageAttachment[],
    options?: {
      steer?: boolean;
      biscotto?: FollowerBiscottoIdentity;

      guestGate?: TurnGuestGate;

      targetScoopJid?: string;
    }
  ) => void | Promise<FollowerMessageOutcome>;

  onFollowerAbort: (targetScoopJid?: string) => void;

  onFollowerNewSession?: (action: 'save' | 'skip' | 'erase', bootstrapId: string) => void;

  browserTransport?: CDPTransport;

  browserAPI?: BrowserAPI;

  onFollowerDead?: (bootstrapId: string) => void;

  vfs?: VirtualFS;

  onFollowerCountChanged?: (count: number) => void;

  onSprinkleInstancesChanged?: () => void;

  onFollowerTargetsChanged?: () => void;

  onCherryHostEvent?: (cherryRuntimeId: string | undefined, name: string, detail?: unknown) => void;

  onPreviewLick?: (event: LickEvent) => void;

  onRemoteTransportsCleaned?: (runtimeId: string) => void;

  sendControl: (msg: LeaderToWorkerControlMessage) => void;

  execInShell?: (
    command: string,
    opts: {
      sessionId: string;
      cwd?: string;
      env?: Record<string, string>;

      stdin?: string;
      signal: AbortSignal;
      onChunk: (stream: 'stdout' | 'stderr', data: string) => void;
    }
  ) => Promise<{ exitCode: number; error?: string }>;

  closeExecShell?: (sessionId: string) => void;

  requestSudoApproval?: (request: {
    kind: TraySudoKind;
    detail: string;
    suggestedPattern?: string;
    followerLabel: string;
    hostOrigin?: string;

    approver?: SudoApproverDirective;
  }) => Promise<SudoDecision>;

  headlessLeader?: boolean;

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
  private readonly computersRouter: ComputersRouter;
  private readonly teleportPool: TeleportPool;
  private readonly transcriptExport: TranscriptExportManager;
  private readonly followerDispatch: FollowerDispatch;
  private readonly requesterTracker = new RequesterTracker();
  private readonly tabTeleportRouter: TabTeleportRouter;
  private readonly oauthPopupDelegation: OAuthPopupDelegation;
  private readonly sudoDelegation: SudoDelegation;
  private readonly biscottoReview: BiscottoReview;

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
    this.computersRouter = new ComputersRouter(context);
    this.computersRouter.start();
    this.tabTeleportRouter = new TabTeleportRouter(context, {
      getTargetEntries: () => this.teleportPool.getConnectedEntries(),
    });
    this.oauthPopupDelegation = new OAuthPopupDelegation(context);
    this.sudoDelegation = new SudoDelegation(context);
    this.biscottoReview = new BiscottoReview(context, {
      deliver: (pending) => {
        this.followerDispatch.noteInteractionOrigin(pending.bootstrapId);
        const delivery = this.options.onFollowerMessage(
          pending.text,
          pending.messageId,
          pending.attachments,
          {
            ...(pending.steer ? { steer: true } : {}),
            biscotto: pending.biscotto,
            ...(pending.toolGate ? { guestGate: pending.toolGate } : {}),

            targetScoopJid: pending.unitJid,
          }
        );
        this.followerDispatch.ackUserMessage(pending.bootstrapId, pending.messageId, delivery);
      },
      notify: (bootstrapId, messageId, state) => {
        this.followerRegistry.followers
          .get(bootstrapId)
          ?.sync.send({ type: 'biscotto.message.state', messageId, state });
      },
    });
    this.followerDispatch = new FollowerDispatch(context, {
      biscottoReview: this.biscottoReview,
      broadcast: this.broadcast,
      cdpRouter: this.cdpRouter,
      remoteExec: this.remoteExec,
      fsRouter: this.fsRouter,
      tabRouter: this.tabRouter,
      teleportPool: this.teleportPool,
      transcriptExport: this.transcriptExport,
      cherryRouter: this.cherryRouter,
      computersRouter: this.computersRouter,
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
      afterRegistryCleanup: (bootstrapId) => {
        this.requesterTracker.handleFollowerRemoved(bootstrapId);
        this.computersRouter.removeFollower(bootstrapId);
      },
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
    meta?: {
      runtime?: string;
      connectedAt?: string;
      trust?: FollowerTrust;
      biscotto?: FollowerBiscottoIdentity;
    }
  ): void {
    const { sync } = this.followerRegistry.addFollower(bootstrapId, channel, meta);

    sync.send({
      type: 'hello',
      protocolVersion: TRAY_SYNC_PROTOCOL_VERSION,
      capabilities: { exec: this.options.execInShell !== undefined },
    });
    void this.broadcast.sendSnapshotToFollower(bootstrapId);
    this.broadcast.sendScoopsListToFollower(bootstrapId);
    this.computersRouter.sendListToFollower(bootstrapId);
    this.broadcast.sendModelCatalogToFollower(bootstrapId);
    this.broadcast.sendSprinklesListToFollower(bootstrapId);

    if (this.lastThemeJson !== null) {
      sync.send({ type: 'theme.apply', themeJson: this.lastThemeJson });
    }
    this.teleportPool.sendTargetRegistryToFollower(bootstrapId);
  }

  removeFollower(bootstrapId: string): void {
    this.followerRegistry.removeFollower(bootstrapId);
  }

  broadcastEvent(event: AgentEvent, backgroundScoopJid?: string): void {
    this.broadcast.broadcastEvent(event, backgroundScoopJid);
  }

  broadcastUserMessage(
    text: string,
    messageId: string,
    attachments?: MessageAttachment[],
    scoopJid?: string
  ): void {
    this.broadcast.broadcastUserMessage(text, messageId, attachments, scoopJid);
  }

  broadcastStatus(status: string, scoopJid?: string): void {
    this.broadcast.broadcastStatus(status, scoopJid);
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
      stdin?: string;
      signal?: AbortSignal;
      onChunk?: (stream: 'stdout' | 'stderr', data: string) => void;
      timeoutMs?: number;
    } = {}
  ): Promise<RemoteExecResult> {
    return this.remoteExec.execOnRemote(runtimeId, command, opts);
  }

  captureNativeComputer(
    runtimeId: string,
    opts: {
      fps?: number;
      maxWidth?: number;
      display?: number;
      watch?: boolean;
      timeoutMs?: number;

      onFrame?: (frame: NativeComputerCaptureResult) => void;

      onEnd?: (error: Error) => void;
    } = {}
  ): Promise<NativeComputerCaptureResult> {
    return this.computersRouter.captureNative(runtimeId, opts);
  }

  inputNativeComputer(
    runtimeId: string,
    events: ComputerInputEvent[],
    opts: { display?: number } = {}
  ): Promise<void> {
    return this.computersRouter.inputNative(runtimeId, events, opts);
  }

  unwatchNativeComputer(runtimeId: string, opts: { display?: number } = {}): void {
    this.computersRouter.unwatchNative(runtimeId, opts);
  }

  getExecCapableBootstrapIds(): Set<string> {
    return this.followerRegistry.getExecCapableBootstrapIds();
  }

  getComputerCapableBootstrapIds(): Set<string> {
    return this.followerRegistry.getComputerCapableBootstrapIds();
  }

  getAbsorbedBootstrapIds(): Set<string> {
    return this.followerRegistry.getAbsorbedBootstrapIds();
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

  getPartnerMotds(): Map<string, string> {
    return this.followerRegistry.getPartnerMotds();
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

  shouldDelegateSudo(): boolean {
    if (this.options.headlessLeader === true) return true;
    if (!this.sudoDelegation.hasCapableFollower()) return false;
    return this.requesterTracker.get()?.kind === 'follower';
  }

  delegateSudoApproval(request: SudoRequest, opts?: { scoopName?: string }): Promise<SudoDecision> {
    return this.sudoDelegation.requestApproval(request, opts);
  }

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

  noteLeaderUserMessage(): void {
    this.requesterTracker.noteLeaderUserMessage();
  }

  getLastUserMessageOrigin(): LastUserMessageOrigin | null {
    return this.requesterTracker.get();
  }

  hasDelegatableFollower(): boolean {
    return this.pickDriveableFollower() !== null || this.pickOAuthPopupFollower() !== null;
  }

  shouldDelegateOAuthLogin(): boolean {
    if (this.options.headlessLeader === true) return true;
    if (!this.hasDelegatableFollower()) return false;
    return this.requesterTracker.get()?.kind === 'follower';
  }

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
