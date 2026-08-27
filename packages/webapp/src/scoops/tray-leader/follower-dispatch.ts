import { stripLocalPathsForRemote } from '../../core/attachments.js';
import { FORWARDABLE_TO_LEADER, type LickEvent } from '../lick-manager.js';
import {
  type FollowerToLeaderMessage,
  TRAY_SYNC_PROTOCOL_VERSION,
  unhandledProtocolMessage,
} from '../tray-sync-protocol.js';
import { isMessageAllowedForTrust } from './biscotto-gate.js';
import type { BiscottoReview } from './biscotto-review.js';
import type { BroadcastManager } from './broadcast.js';
import type { CDPRouter } from './cdp-router.js';
import type { CherryRouter } from './cherry-router.js';
import type { LeaderSyncContext } from './context.js';
import { labelForFollower } from './follower-registry.js';
import type { FsRouter } from './fs-router.js';
import type { OAuthPopupDelegation } from './oauth-popup-delegation.js';
import type { RemoteExecRouter } from './remote-exec.js';
import type { RequesterTracker } from './requester-tracker.js';
import type { SudoDelegation } from './sudo-delegation.js';
import type { TabRouter } from './tab-router.js';
import type { TabTeleportRouter } from './tab-teleport-router.js';
import type { TeleportPool } from './teleport-pool.js';
import type { TranscriptExportManager } from './transcript-export.js';

export interface FollowerDispatchCollaborators {
  broadcast: Pick<
    BroadcastManager,
    | 'sendSnapshotToFollower'
    | 'sendModelCatalogToFollower'
    | 'broadcastModelState'
    | 'sendSprinklesListToFollower'
    | 'handleSprinkleFetch'
  >;
  cdpRouter: Pick<CDPRouter, 'handleCDPRequest' | 'handleCDPResponse' | 'handleCDPEvent'>;
  remoteExec: Pick<RemoteExecRouter, 'handleFollowerExecMessage'>;
  fsRouter: Pick<FsRouter, 'executeLocalFs' | 'forwardFsRequest' | 'handleFsResponse'>;
  tabRouter: Pick<
    TabRouter,
    'executeLocalTabOpen' | 'forwardTabOpen' | 'handleTabOpenResponse' | 'handleTabOpenError'
  >;
  teleportPool: Pick<TeleportPool, 'handleFollowerTargetsAdvertise'>;
  tabTeleportRouter: Pick<TabTeleportRouter, 'handleTeleportRequest'>;
  oauthPopupDelegation: Pick<OAuthPopupDelegation, 'handlePopupResponse'>;
  transcriptExport: Pick<
    TranscriptExportManager,
    'handleTranscriptExportRequest' | 'handleTranscriptExportCancel' | 'handleTranscriptExportAck'
  >;
  sudoDelegation: Pick<SudoDelegation, 'handleResponse' | 'handleFollowerReady'>;
  cherryRouter: Pick<CherryRouter, 'routeCherryHostEvent'>;
  requesterTracker: Pick<RequesterTracker, 'noteFollowerUserMessage'>;
  /** Holds a guest's message until its seat's approver says yes. */
  biscottoReview: Pick<BiscottoReview, 'submit'>;
  /** Forward a follower's push-token registration to the tray hub (issue #2062). */
  registerPushToken?: (
    bootstrapId: string,
    registration: { platform: 'ios'; token: string; environment: 'sandbox' | 'production' }
  ) => void;
}

/** Exhaustive follower-to-leader wire-message dispatcher. */
export class FollowerDispatch {
  constructor(
    private readonly context: LeaderSyncContext,
    private readonly collaborators: FollowerDispatchCollaborators
  ) {}

  dispatch(bootstrapId: string, message: FollowerToLeaderMessage): void {
    if (!this.acceptFromPeer(bootstrapId, message)) return;
    this.noteLegacyPeer(bootstrapId, message);
    const { broadcast, cdpRouter, remoteExec, fsRouter, tabRouter } = this.collaborators;
    const { teleportPool, transcriptExport, cherryRouter, tabTeleportRouter } = this.collaborators;
    const { oauthPopupDelegation } = this.collaborators;

    switch (message.type) {
      case 'user_message':
        this.handleFollowerUserMessage(bootstrapId, message);
        break;
      case 'abort':
        this.context.log.info('Follower abort received', { bootstrapId });
        this.context.options.onFollowerAbort();
        break;
      case 'new_session':
        this.handleFollowerNewSession(bootstrapId, message.action);
        break;
      case 'request_snapshot':
        this.context.log.info('Follower snapshot request received', {
          bootstrapId,
          scoopJid: message.scoopJid,
        });
        void broadcast.sendSnapshotToFollower(bootstrapId, message.scoopJid);
        break;
      case 'scoops.select':
        this.handleScoopSelection(bootstrapId, message.scoopJid);
        break;
      case 'models.request':
        broadcast.sendModelCatalogToFollower(bootstrapId);
        break;
      case 'model.select':
        this.handleModelSelection(bootstrapId, message.modelId, message.scoopJid);
        break;
      case 'thinking.set':
        this.handleThinkingSelection(
          bootstrapId,
          message.scoopJid,
          message.thinkingLevel,
          message.effortOverride
        );
        break;
      case 'sprinkles.refresh':
        this.context.log.info('Follower requested sprinkles refresh', { bootstrapId });
        broadcast.sendSprinklesListToFollower(bootstrapId);
        break;
      case 'sprinkle.fetch':
        void broadcast.handleSprinkleFetch(bootstrapId, message.requestId, message.sprinkleName);
        break;
      case 'sprinkle.lick':
        this.handleFollowerSprinkleLick(bootstrapId, message);
        break;
      case 'sprinkle.instances':
        this.context.followers.setSprinkleInstances(bootstrapId, message.sprinkles);
        this.context.options.onSprinkleInstancesChanged?.();
        break;
      case 'lick':
        this.handleFollowerLick(bootstrapId, message);
        break;
      case 'targets.advertise':
        teleportPool.handleFollowerTargetsAdvertise(bootstrapId, message);
        break;
      case 'cdp.request':
        cdpRouter.handleCDPRequest(bootstrapId, message);
        break;
      case 'cdp.response':
        cdpRouter.handleCDPResponse(message);
        break;
      case 'cdp.event':
        cdpRouter.handleCDPEvent(bootstrapId, message.method, message.params, message.sessionId);
        break;
      case 'tab.open':
        this.routeTabOpen(bootstrapId, message);
        break;
      case 'tab.opened':
        tabRouter.handleTabOpenResponse(message.requestId, message.targetId);
        break;
      case 'tab.open.error':
        tabRouter.handleTabOpenError(message.requestId, message.error);
        break;
      case 'tab.teleport.request':
        void tabTeleportRouter.handleTeleportRequest(bootstrapId, message);
        break;
      case 'oauth.popup.response':
        oauthPopupDelegation.handlePopupResponse(
          bootstrapId,
          message.requestId,
          message.redirectUrl,
          message.error
        );
        break;
      case 'fs.request':
        this.routeFsRequest(bootstrapId, message);
        break;
      case 'fs.response':
        fsRouter.handleFsResponse(message.requestId, message.response);
        break;
      case 'exec.request':
      case 'exec.chunk':
      case 'exec.response':
      case 'exec.signal':
        remoteExec.handleFollowerExecMessage(bootstrapId, message);
        break;
      case 'transcript.export.request':
        void transcriptExport.handleTranscriptExportRequest(
          bootstrapId,
          message.requestId,
          message.selector
        );
        break;
      case 'transcript.export.cancel':
        transcriptExport.handleTranscriptExportCancel(bootstrapId, message.requestId);
        break;
      case 'transcript.export.ack':
        transcriptExport.handleTranscriptExportAck(bootstrapId, message.requestId, message.index);
        break;
      case 'sudo.approve.response':
        this.collaborators.sudoDelegation.handleResponse(
          bootstrapId,
          message.requestId,
          message.decision,
          message.pattern,
          message.attestation
        );
        break;
      case 'push.register':
        this.handlePushRegister(bootstrapId, message);
        break;
      case 'cherry.host_event':
        cherryRouter.routeCherryHostEvent(bootstrapId, message);
        break;
      case 'ping':
        this.handlePing(bootstrapId);
        break;
      case 'pong':
        this.handlePong(bootstrapId);
        break;
      case 'hello':
        this.handleFollowerHello(bootstrapId, message);
        break;
      default: {
        const unknown = unhandledProtocolMessage(message);
        this.context.log.warn('Unknown follower message type — skewed follower?', {
          bootstrapId,
          type: unknown.type,
        });
      }
    }
  }

  private noteLegacyPeer(bootstrapId: string, message: FollowerToLeaderMessage): void {
    if (message.type === 'hello') return;
    const follower = this.context.followers.followers.get(bootstrapId);
    if (!follower || follower.peerProtocolVersion !== undefined || follower.legacyPeerLogged)
      return;
    follower.legacyPeerLogged = true;
    this.context.log.info('Follower sent no hello — legacy peer (pre-versioning build)', {
      bootstrapId,
    });
  }

  /**
   * Trust gate for the inbound wire. Runs BEFORE any other handling — including
   * `noteLegacyPeer`, so a denied message cannot even move peer bookkeeping.
   *
   * An unknown `bootstrapId` is denied: the registry entry is what carries the
   * hub's trust verdict, so a message arriving without one has no verdict to
   * check and must not be assumed trustworthy. In practice this is a message
   * racing follower removal.
   */
  private acceptFromPeer(bootstrapId: string, message: FollowerToLeaderMessage): boolean {
    const follower = this.context.followers.followers.get(bootstrapId);
    if (!follower) {
      this.context.log.warn('Dropping message from unregistered peer', {
        bootstrapId,
        type: message.type,
      });
      return false;
    }
    if (isMessageAllowedForTrust(follower.trust, message.type)) return true;
    // Deliberately logged at warn: a guest seat reaching for a denied
    // capability is the signal that a shared URL is being probed.
    this.context.log.warn('Dropping message not permitted for a biscotto', {
      bootstrapId,
      biscottoId: follower.biscotto?.id,
      type: message.type,
    });
    return false;
  }

  private handleFollowerUserMessage(
    bootstrapId: string,
    message: FollowerToLeaderMessage & { type: 'user_message' }
  ): void {
    this.context.log.info('Follower user message received', {
      bootstrapId,
      messageId: message.messageId,
    });
    // A user message is real human activity — unlike ping/pong keepalives — so
    // it makes lastActivity a meaningful recency signal for follower selection.
    const follower = this.context.followers.followers.get(bootstrapId);
    if (follower) follower.lastActivity = Date.now();
    const safeAttachments = message.attachments?.length
      ? stripLocalPathsForRemote(message.attachments)
      : message.attachments;
    // A guest's text is REVIEWED before it reaches the cone, and never arrives
    // looking like the owner's. A full follower IS the owner on another device:
    // it is not reviewed and keeps the historical three-argument hand-off.
    const biscotto = follower?.trust === 'biscotto' ? follower.biscotto : undefined;
    if (biscotto) {
      // NOT marked as the interaction origin here. A reviewed message may never
      // be delivered, and `RequesterTracker` decides where interactive prompts
      // (OAuth popups, teleport pickers) get routed — pointing those at a guest
      // whose message is still pending, or was refused outright, would hand the
      // owner's interactions to someone whose input was rejected. The review
      // path notes the origin only once the message is actually delivered.
      this.collaborators.biscottoReview.submit(bootstrapId, {
        bootstrapId,
        messageId: message.messageId,
        text: message.text,
        attachments: safeAttachments,
        steer: message.steer,
        biscotto,
      });
      return;
    }
    this.noteInteractionOrigin(bootstrapId);
    if (message.steer) {
      this.context.options.onFollowerMessage(message.text, message.messageId, safeAttachments, {
        steer: true,
      });
    } else {
      this.context.options.onFollowerMessage(message.text, message.messageId, safeAttachments);
    }
  }

  /**
   * Mark this follower as where the current interaction came from, so a
   * delegated OAuth popup or teleport picker opens on the browser its human is
   * actually looking at.
   */
  noteInteractionOrigin(bootstrapId: string): void {
    this.collaborators.requesterTracker.noteFollowerUserMessage(
      bootstrapId,
      this.context.followers.runtimeIdForBootstrap(bootstrapId)
    );
  }

  private handleFollowerNewSession(bootstrapId: string, action: 'save' | 'skip' | 'erase'): void {
    this.context.log.info('Follower new-session received', { bootstrapId, action });
    try {
      this.context.options.onFollowerNewSession?.(action, bootstrapId);
    } catch (err) {
      this.context.log.warn('onFollowerNewSession handler threw', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private handleScoopSelection(bootstrapId: string, scoopJid: string): void {
    this.context.log.info('Follower selected scoop', { bootstrapId, scoopJid });
    const follower = this.context.followers.followers.get(bootstrapId);
    if (!follower) return;
    follower.selectedScoopJid = scoopJid;
    void this.collaborators.broadcast.sendSnapshotToFollower(bootstrapId, scoopJid);
  }

  private handleModelSelection(
    bootstrapId: string,
    modelId: string,
    requestedScoopJid?: string
  ): void {
    // The unit the pick applies to: what the follower named, else the unit it
    // is viewing. Never the leader's selection — a follower changes the cone
    // it is looking at (#2310).
    const scoopJid =
      requestedScoopJid ?? this.context.followers.followers.get(bootstrapId)?.selectedScoopJid;
    try {
      const applied = this.context.options.onFollowerModelSelect?.(modelId, scoopJid ?? undefined);
      if (applied === true) {
        this.collaborators.broadcast.broadcastModelState();
        return;
      }
      if (typeof applied === 'object' && typeof applied?.then === 'function') {
        // A per-cone pick is persisted asynchronously (#2310). Broadcasting
        // before the record actually changes would recompute `model.state`
        // from the OLD value and snap the follower's picker back, while the
        // kernel goes on to run (and bill) the new model.
        void applied
          .then((ok) => {
            if (ok) {
              this.collaborators.broadcast.broadcastModelState();
              return;
            }
            this.context.log.warn('Follower model selection was not applied', {
              bootstrapId,
              modelId,
            });
            // Re-state the truth so the follower's picker leaves the value it
            // optimistically showed and returns to what the leader has.
            this.collaborators.broadcast.broadcastModelState();
          })
          .catch((err: unknown) => {
            this.context.log.warn('Follower model selection failed to persist', {
              bootstrapId,
              modelId,
              error: err instanceof Error ? err.message : String(err),
            });
            this.collaborators.broadcast.broadcastModelState();
          });
        return;
      }
      this.context.log.warn('Rejecting unknown or unresolvable follower model selection', {
        bootstrapId,
        modelId,
      });
    } catch (err) {
      this.context.log.warn('Rejecting follower model selection after apply failure', {
        bootstrapId,
        modelId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private handleThinkingSelection(
    bootstrapId: string,
    requestedScoopJid: string,
    thinkingLevel: Parameters<
      NonNullable<LeaderSyncContext['options']['onFollowerThinkingSet']>
    >[1],
    effortOverride?: string
  ): void {
    const follower = this.context.followers.followers.get(bootstrapId);
    const scoopJid = follower?.selectedScoopJid;
    if (!scoopJid) {
      this.context.log.warn('Rejecting follower thinking selection without a selected scoop', {
        bootstrapId,
        requestedScoopJid,
      });
      return;
    }
    if (requestedScoopJid !== scoopJid) {
      this.context.log.warn(
        'Follower thinking selection targeted a stale scoop; using selected scoop',
        {
          bootstrapId,
          requestedScoopJid,
          scoopJid,
        }
      );
    }
    try {
      const applied = this.context.options.onFollowerThinkingSet?.(
        scoopJid,
        thinkingLevel,
        effortOverride
      );
      if (applied && typeof applied.then === 'function') {
        void applied
          .then((didApply) => {
            if (didApply === false) {
              this.logThinkingApplyFailure(
                bootstrapId,
                scoopJid,
                new Error('thinking update was not acknowledged')
              );
              return;
            }
            this.collaborators.broadcast.broadcastModelState();
          })
          .catch((err) => this.logThinkingApplyFailure(bootstrapId, scoopJid, err));
      } else {
        this.collaborators.broadcast.broadcastModelState();
      }
    } catch (err) {
      this.logThinkingApplyFailure(bootstrapId, scoopJid, err);
    }
  }

  private logThinkingApplyFailure(bootstrapId: string, scoopJid: string, err: unknown): void {
    this.context.log.warn('Follower thinking selection apply failed', {
      bootstrapId,
      scoopJid,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  private handleFollowerSprinkleLick(
    bootstrapId: string,
    message: FollowerToLeaderMessage & { type: 'sprinkle.lick' }
  ): void {
    this.context.log.info('Follower sprinkle lick received', {
      bootstrapId,
      sprinkleName: message.sprinkleName,
    });
    const follower = this.context.followers.followers.get(bootstrapId);
    const originLabel = labelForFollower(follower?.floatType ?? 'unknown', follower?.runtime);
    try {
      this.context.options.onSprinkleLick?.(
        message.sprinkleName,
        message.body,
        message.targetScoop,
        originLabel
      );
    } catch (err) {
      this.context.log.warn('onSprinkleLick handler threw', {
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
      this.context.log.warn('Rejecting malformed or non-forwardable lick from follower', {
        bootstrapId,
        type: incoming?.type,
      });
      return;
    }
    const follower = this.context.followers.followers.get(bootstrapId);
    const { targetScoop: _droppedTarget, ...rest } = incoming;
    const stamped: LickEvent = {
      ...rest,
      originFollowerId: bootstrapId,
      originLabel: labelForFollower(follower?.floatType ?? 'unknown', follower?.runtime),
    };
    try {
      this.context.options.onForwardedLick?.(stamped, bootstrapId);
    } catch (err) {
      this.context.log.warn('onForwardedLick handler threw', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private routeTabOpen(
    bootstrapId: string,
    message: FollowerToLeaderMessage & { type: 'tab.open' }
  ): void {
    const { requestId, targetRuntimeId, url } = message;
    if (targetRuntimeId === 'leader') {
      void this.collaborators.tabRouter.executeLocalTabOpen(requestId, url, bootstrapId);
    } else {
      this.collaborators.tabRouter.forwardTabOpen(requestId, targetRuntimeId, url, bootstrapId);
    }
  }

  private routeFsRequest(
    bootstrapId: string,
    message: FollowerToLeaderMessage & { type: 'fs.request' }
  ): void {
    const { requestId, targetRuntimeId, request } = message;
    if (targetRuntimeId === 'leader') {
      void this.collaborators.fsRouter.executeLocalFs(requestId, request, bootstrapId);
    } else {
      this.collaborators.fsRouter.forwardFsRequest(
        requestId,
        targetRuntimeId,
        request,
        bootstrapId
      );
    }
  }

  private handlePing(bootstrapId: string): void {
    const follower = this.context.followers.followers.get(bootstrapId);
    if (!follower) return;
    follower.keepalive.receivePing();
    follower.lastActivity = Date.now();
    follower.sync.send({ type: 'pong' });
  }

  /**
   * A follower registered a push token. Validate the shape defensively — the
   * token is opaque hex from APNs — and forward to the hub with the follower's
   * identity derived from the channel, never the payload.
   */
  private handlePushRegister(
    bootstrapId: string,
    message: FollowerToLeaderMessage & { type: 'push.register' }
  ): void {
    const token = typeof message.token === 'string' ? message.token.trim() : '';
    const environment = message.environment === 'production' ? 'production' : 'sandbox';
    if (message.platform !== 'ios' || !/^[0-9a-fA-F]{32,400}$/.test(token)) {
      this.context.log.warn('Ignoring malformed push.register', { bootstrapId });
      return;
    }
    this.collaborators.registerPushToken?.(bootstrapId, { platform: 'ios', token, environment });
  }

  private handlePong(bootstrapId: string): void {
    const follower = this.context.followers.followers.get(bootstrapId);
    if (!follower) return;
    follower.keepalive.receivePong();
    follower.lastActivity = Date.now();
  }

  private handleFollowerHello(
    bootstrapId: string,
    message: FollowerToLeaderMessage & { type: 'hello' }
  ): void {
    const follower = this.context.followers.followers.get(bootstrapId);
    if (follower) {
      follower.peerProtocolVersion = message.protocolVersion;
      if (follower.trust === 'biscotto') {
        // Capabilities are SELF-REPORTED, and every follower-selection site
        // (`sudo-delegation`, `teleport-pool`, `remote-exec`, the OAuth-popup
        // picker) reads them as a volunteer list. A guest that advertised
        // `sudoApproval` would be handed the owner's approval prompts — the
        // exact inversion this feature exists to prevent. It gets none, and
        // no MOTD, which is only shown for exec-capable peers anyway.
        follower.peerCapabilities = {};
        follower.peerMotd = undefined;
        this.context.followers.notifyFollowerCountChanged();
      } else {
        follower.peerCapabilities = message.capabilities;
        follower.peerMotd = message.motd;
        this.context.followers.notifyFollowerCountChanged();
        // A sudo-capable follower just arrived — hand it any prompt a headless
        // leader parked while no one could answer (issue #2062).
        this.collaborators.sudoDelegation.handleFollowerReady(bootstrapId);
      }
    }
    if (message.protocolVersion > TRAY_SYNC_PROTOCOL_VERSION) {
      this.context.log.warn('Follower speaks a newer tray sync protocol — update this build', {
        bootstrapId,
        followerVersion: message.protocolVersion,
        ourVersion: TRAY_SYNC_PROTOCOL_VERSION,
      });
    } else {
      this.context.log.info('Follower hello', {
        bootstrapId,
        protocolVersion: message.protocolVersion,
      });
    }
  }
}
