import { stripLocalPathsForRemote } from '../../core/attachments.js';
import { FORWARDABLE_TO_LEADER, type LickEvent } from '../lick-manager.js';
import {
  type FollowerToLeaderMessage,
  TRAY_SYNC_PROTOCOL_VERSION,
  unhandledProtocolMessage,
} from '../tray-sync-protocol.js';
import type { BroadcastManager } from './broadcast.js';
import type { CDPRouter } from './cdp-router.js';
import type { CherryRouter } from './cherry-router.js';
import type { LeaderSyncContext } from './context.js';
import { labelForFollower } from './follower-registry.js';
import type { FsRouter } from './fs-router.js';
import type { RemoteExecRouter } from './remote-exec.js';
import type { TabRouter } from './tab-router.js';
import type { TeleportPool } from './teleport-pool.js';
import type { TranscriptExportManager } from './transcript-export.js';

export interface FollowerDispatchCollaborators {
  broadcast: Pick<
    BroadcastManager,
    'sendSnapshotToFollower' | 'sendSprinklesListToFollower' | 'handleSprinkleFetch'
  >;
  cdpRouter: Pick<CDPRouter, 'handleCDPRequest' | 'handleCDPResponse' | 'handleCDPEvent'>;
  remoteExec: Pick<RemoteExecRouter, 'handleFollowerExecMessage'>;
  fsRouter: Pick<FsRouter, 'executeLocalFs' | 'forwardFsRequest' | 'handleFsResponse'>;
  tabRouter: Pick<
    TabRouter,
    'executeLocalTabOpen' | 'forwardTabOpen' | 'handleTabOpenResponse' | 'handleTabOpenError'
  >;
  teleportPool: Pick<TeleportPool, 'handleFollowerTargetsAdvertise'>;
  transcriptExport: Pick<
    TranscriptExportManager,
    | 'handleTranscriptExportRequest'
    | 'handleTranscriptExportCancel'
    | 'handleTranscriptExportAck'
    | 'handleTranscriptExportApprovalResponse'
  >;
  cherryRouter: Pick<CherryRouter, 'routeCherryHostEvent'>;
}

/** Exhaustive follower-to-leader wire-message dispatcher. */
export class FollowerDispatch {
  constructor(
    private readonly context: LeaderSyncContext,
    private readonly collaborators: FollowerDispatchCollaborators
  ) {}

  dispatch(bootstrapId: string, message: FollowerToLeaderMessage): void {
    this.noteLegacyPeer(bootstrapId, message);
    const { broadcast, cdpRouter, remoteExec, fsRouter, tabRouter } = this.collaborators;
    const { teleportPool, transcriptExport, cherryRouter } = this.collaborators;

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
      case 'transcript.export.approve.response':
        transcriptExport.handleTranscriptExportApprovalResponse(
          bootstrapId,
          message.requestId,
          message.approved
        );
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

  private handleFollowerUserMessage(
    bootstrapId: string,
    message: FollowerToLeaderMessage & { type: 'user_message' }
  ): void {
    this.context.log.info('Follower user message received', {
      bootstrapId,
      messageId: message.messageId,
    });
    const safeAttachments = message.attachments?.length
      ? stripLocalPathsForRemote(message.attachments)
      : message.attachments;
    // Only a steering send carries the options argument, so the ordinary
    // hand-off stays a three-argument call.
    if (message.steer) {
      this.context.options.onFollowerMessage(message.text, message.messageId, safeAttachments, {
        steer: true,
      });
    } else {
      this.context.options.onFollowerMessage(message.text, message.messageId, safeAttachments);
    }
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
      follower.peerCapabilities = message.capabilities;
      follower.peerMotd = message.motd;
      this.context.followers.notifyFollowerCountChanged();
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
