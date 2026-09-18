import {
  isSliccAppUrl,
  type LeaderWebhookDelivery,
  type WebhookEventMessage,
} from '@slicc/shared-ts';
import { createLogger } from '../base/logger.js';
import type { BrowserAPI } from '../cdp/browser-api.js';
import type { CDPTransport } from '../cdp/transport.js';
import type { VirtualFS } from '../fs/virtual-fs.js';
import type { LickEvent, WebhookDeliveryDisposition } from '../scoops/lick-manager.js';
import { handlePreviewRequest } from '../scoops/preview-request-handler.js';
import { ThrottledErrorTracker } from '../scoops/throttled-error-tracker.js';
import type {
  LeaderTraySession,
  LeaderTraySessionStore,
  LeaderTrayWebSocket,
  TrayKind,
} from '../scoops/tray-leader.js';
import {
  getLeaderTrayRuntimeStatus,
  LeaderTrayManager,
  type LeaderTrayRuntimeStatus,
} from '../scoops/tray-leader.js';
import type { LeaderSyncManagerOptions } from '../scoops/tray-leader-sync.js';
import { deriveFloatType, type FloatType, LeaderSyncManager } from '../scoops/tray-leader-sync.js';
import { buildTrayLaunchUrl } from '../scoops/tray-runtime-config.js';
import type {
  RemoteTargetInfo,
  ScoopSummary,
  SprinkleSummary,
} from '../scoops/tray-sync-protocol.js';
import { LeaderTrayPeerManager, type TrayPeerConnectionFactory } from '../scoops/tray-webrtc.js';
import { getComputersStore } from './computers-store.js';
import type { AgentEvent } from './types.js';

const log = createLogger('page-leader-tray');

function relayWebhookEvent(
  message: WebhookEventMessage,
  sendWebhookEvent: StartPageLeaderTrayOptions['sendWebhookEvent'],
  sendAck: (ack: LeaderWebhookDelivery) => void
): void {
  void sendWebhookEvent(message.webhookId, message.headers, message.body)
    .then((disposition: WebhookDeliveryDisposition | null) => {
      if (!message.deliveryId || !disposition) return;
      sendAck({ type: 'webhook.delivery', deliveryId: message.deliveryId, disposition });
    })
    .catch((err: unknown) => {
      log.warn('webhook.event relay failed', {
        webhookId: message.webhookId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
}

export interface StartPageLeaderTrayOptions {
  workerBaseUrl: string;

  runtime?: string;

  kind?: TrayKind;

  onLeaderReady?: (session: LeaderTraySession) => void;

  getMessages: LeaderSyncManagerOptions['getMessages'];
  getMessagesForScoop?: LeaderSyncManagerOptions['getMessagesForScoop'];
  getScoopJid: LeaderSyncManagerOptions['getScoopJid'];
  getScoops?: () => ScoopSummary[];
  getSprinkles?: () => SprinkleSummary[];
  getModelCatalog?: LeaderSyncManagerOptions['getModelCatalog'];
  getModelSelectionState?: LeaderSyncManagerOptions['getModelSelectionState'];
  onFollowerModelSelect?: LeaderSyncManagerOptions['onFollowerModelSelect'];
  onFollowerThinkingSet?: LeaderSyncManagerOptions['onFollowerThinkingSet'];
  readSprinkleContent?: LeaderSyncManagerOptions['readSprinkleContent'];
  onSprinkleLick?: LeaderSyncManagerOptions['onSprinkleLick'];
  onSprinkleInstancesChanged?: LeaderSyncManagerOptions['onSprinkleInstancesChanged'];
  onForwardedLick?: (event: LickEvent, originBootstrapId: string) => void;
  onFollowerMessage: LeaderSyncManagerOptions['onFollowerMessage'];
  onFollowerAbort: LeaderSyncManagerOptions['onFollowerAbort'];
  onFollowerNewSession?: LeaderSyncManagerOptions['onFollowerNewSession'];
  onFollowerCountChanged?: LeaderSyncManagerOptions['onFollowerCountChanged'];
  onRemoteTransportsCleaned?: LeaderSyncManagerOptions['onRemoteTransportsCleaned'];

  execInShell?: LeaderSyncManagerOptions['execInShell'];

  closeExecShell?: LeaderSyncManagerOptions['closeExecShell'];

  sendWebhookEvent: (
    webhookId: string,
    headers: Record<string, string>,
    body: unknown
  ) => Promise<WebhookDeliveryDisposition | null>;

  onCherryHostEvent?: LeaderSyncManagerOptions['onCherryHostEvent'];
  onPreviewLick?: LeaderSyncManagerOptions['onPreviewLick'];

  requestSudoApproval?: LeaderSyncManagerOptions['requestSudoApproval'];

  createTranscriptExport?: LeaderSyncManagerOptions['createTranscriptExport'];

  onAgentEvent: (handler: (event: AgentEvent) => void) => () => void;

  browserAPI: BrowserAPI;
  browserTransport?: CDPTransport;
  vfs?: VirtualFS;

  _storeOverride?: LeaderTraySessionStore;

  _webSocketFactory?: (url: string) => LeaderTrayWebSocket;

  _fetchImpl?: typeof fetch;

  _historyOverride?: {
    href: string;
    replaceState: (state: unknown, unused: string, url: string) => void;
  };

  _refreshIntervalMs?: number;

  _scoopBroadcastCoalesceMs?: number;

  _peerConnectionFactory?: TrayPeerConnectionFactory;
}

export interface PageLeaderTrayHandle {
  stop(): void;

  scheduleScoopsListBroadcast(): void;

  readonly ready: Promise<LeaderTraySession>;

  reset(): Promise<LeaderTrayRuntimeStatus>;

  readonly leader: LeaderTrayManager;
  readonly peers: LeaderTrayPeerManager;
  readonly sync: LeaderSyncManager;

  readonly currentLeaderSync: LeaderSyncManager | null;
}

export interface PageLeaderFollowerState {
  bootstrapId: string;
  runtime?: string;
  connectedAt?: string;
  lastActivity?: number;
  floatType?: FloatType;
  hostOrigin?: string;
  selectedScoopJid?: string;
  health?: 'live' | 'stalled';
  peerState: 'connecting' | 'connected';
}

export function getLeaderFollowerStates(
  peers: Pick<LeaderTrayPeerManager, 'getPeers'>,
  sync: Pick<LeaderSyncManager, 'getFollowerDetails'>
): PageLeaderFollowerState[] {
  const details = new Map(
    sync.getFollowerDetails().map((follower) => [follower.bootstrapId, follower])
  );
  const states: PageLeaderFollowerState[] = [];
  for (const peer of peers.getPeers()) {
    const follower = details.get(peer.bootstrapId);
    if (peer.state === 'connected' && !follower) continue;
    states.push({
      bootstrapId: peer.bootstrapId,
      runtime: follower?.runtime ?? peer.runtime,
      connectedAt: follower?.connectedAt ?? peer.connectedAt ?? undefined,
      lastActivity: follower?.lastActivity,
      floatType: follower?.floatType ?? deriveFloatType(peer.runtime),
      hostOrigin: follower?.hostOrigin,
      selectedScoopJid: follower?.selectedScoopJid,
      health: follower?.health,
      peerState: peer.state,
    });
    details.delete(peer.bootstrapId);
  }
  for (const follower of details.values()) {
    states.push({ ...follower, peerState: 'connected' });
  }
  return states;
}

function buildSyncManager(
  options: StartPageLeaderTrayOptions,
  getLeader: () => LeaderTrayManager,
  onFollowerCountChanged: () => void
): LeaderSyncManager {
  const syncOptions: LeaderSyncManagerOptions = {
    sendControl: (msg) => getLeader().sendControlMessage(msg),
    getMessages: options.getMessages,
    getMessagesForScoop: options.getMessagesForScoop,
    getScoopJid: options.getScoopJid,
    getScoops: options.getScoops,
    getSprinkles: options.getSprinkles,
    computers: {
      list: () => getComputersStore().list(),
      onList: (listener) => getComputersStore().onList(listener),
      onFrame: (listener) => getComputersStore().onFrame(listener),
      lastFrame: (id) => getComputersStore().lastFrame(id),
      watch: (id, fps, maxWidth) => getComputersStore().watch(id, fps, maxWidth),
      unwatch: (id, token) => getComputersStore().unwatch(id, token),
    },
    getModelCatalog: options.getModelCatalog,
    getModelSelectionState: options.getModelSelectionState,
    onFollowerModelSelect: options.onFollowerModelSelect,
    onFollowerThinkingSet: options.onFollowerThinkingSet,
    readSprinkleContent: options.readSprinkleContent,
    onSprinkleLick: options.onSprinkleLick,
    onSprinkleInstancesChanged: options.onSprinkleInstancesChanged,
    onForwardedLick: options.onForwardedLick,
    onFollowerMessage: options.onFollowerMessage,
    onFollowerAbort: options.onFollowerAbort,
    onFollowerNewSession: options.onFollowerNewSession,
    onFollowerCountChanged,
    onRemoteTransportsCleaned: options.onRemoteTransportsCleaned,
    execInShell: options.execInShell,
    closeExecShell: options.closeExecShell,
    onCherryHostEvent: options.onCherryHostEvent,
    onPreviewLick: options.onPreviewLick,
    requestSudoApproval: options.requestSudoApproval,
    createTranscriptExport: options.createTranscriptExport,

    headlessLeader: options.kind === 'hosted',
    browserAPI: options.browserAPI,
    browserTransport: options.browserTransport,
    vfs: options.vfs,
  };
  return new LeaderSyncManager(syncOptions);
}

function buildPeerManager(
  getLeader: () => LeaderTrayManager,
  sync: LeaderSyncManager,
  onPeersChanged: () => void,
  peerConnectionFactory?: TrayPeerConnectionFactory
): LeaderTrayPeerManager {
  return new LeaderTrayPeerManager({
    peerConnectionFactory,
    sendControlMessage: (message) => getLeader().sendControlMessage(message),
    onPeersChanged,
    onPeerConnected: (peer, channel) => {
      log.info('Tray follower data channel opened', {
        controllerId: peer.controllerId,
        bootstrapId: peer.bootstrapId,
        attempt: peer.attempt,
        runtime: peer.runtime,
        trust: peer.trust,
      });
      sync.addFollower(peer.bootstrapId, channel, {
        runtime: peer.runtime,
        connectedAt: peer.connectedAt ?? undefined,
        trust: peer.trust,
        biscotto: peer.biscotto,
      });
    },
    onPeerDisconnected: (bootstrapId, reason) => {
      log.info('Tray follower disconnected', { bootstrapId, reason });
    },
    onPeerTransportClosed: (bootstrapId) => {
      sync.removeFollower(bootstrapId);
    },
  });
}

function buildLeaderManager(
  options: StartPageLeaderTrayOptions,
  peers: LeaderTrayPeerManager,
  sync: LeaderSyncManager,
  fetchImpl: typeof fetch,
  updateUrlBar: (session: LeaderTraySession) => void,
  getLeader: () => LeaderTrayManager
): LeaderTrayManager {
  const pushJoinUrlToSw = (joinUrl: string | null): void => {
    const t = options.browserTransport as { sendLeaderJoinUrl?: (u: string | null) => void };
    t?.sendLeaderJoinUrl?.(joinUrl);
  };

  return new LeaderTrayManager({
    workerBaseUrl: options.workerBaseUrl,
    runtime: options.runtime ?? 'slicc-standalone',
    ...(options.kind ? { kind: options.kind } : {}),
    onLeaderReady: (session) => {
      options.onLeaderReady?.(session);
      pushJoinUrlToSw(session.joinUrl);
    },
    fetchImpl,
    ...(options._storeOverride ? { store: options._storeOverride } : {}),
    ...(options._webSocketFactory ? { webSocketFactory: options._webSocketFactory } : {}),
    onControlMessage: (message) => {
      if (message.type === 'webhook.event') {
        relayWebhookEvent(message, options.sendWebhookEvent, (ack) =>
          getLeader().sendControlMessage(ack)
        );
        return;
      }
      if (message.type === 'preview.request') {
        const vfs = options.vfs;
        if (!vfs) {
          getLeader().sendControlMessage({
            type: 'preview.response',
            reqId: message.reqId,
            ok: false,
            status: 500,
            reason: 'leader has no VFS bound',
          });
          return;
        }
        void handlePreviewRequest(
          message,
          {
            send: (m) =>
              getLeader().sendControlMessage(
                m as Parameters<ReturnType<typeof getLeader>['sendControlMessage']>[0]
              ),
          },
          vfs
        ).catch((err) => {
          log.error('preview.request handling failed', {
            error: err instanceof Error ? err.message : String(err),
          });
        });
        return;
      }
      if (message.type === 'preview.revoked') {
        log.info('Preview revoked by worker', { previewToken: message.previewToken });
        sync.dropMintedPreview(message.previewToken);
        return;
      }
      if (message.type === 'preview.state') {
        sync.restorePreviewState(message);
        return;
      }
      if (message.type === 'bridge.connected') {
        sync.onBridgeConnected(message);
        return;
      }
      if (message.type === 'bridge.disconnected') {
        sync.onBridgeDisconnected(message);
        return;
      }
      if (message.type === 'bridge.cdp.response') {
        sync.onBridgeCdpResponse(message);
        return;
      }
      void peers.handleControlMessage(message).catch((err) => {
        log.error('Tray leader bootstrap handling failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    },
    onReconnecting: (attempt, lastError) => {
      log.info('Leader tray reconnecting', { attempt, lastError });
    },
    onReconnected: (session) => {
      log.info('Leader tray reconnected', { trayId: session.trayId });
      updateUrlBar(session);
      pushJoinUrlToSw(session.joinUrl);
    },
    onReconnectGaveUp: (lastError, attempts) => {
      log.error('Leader tray reconnect gave up', { lastError, attempts });
      pushJoinUrlToSw(null);
    },
  });
}

function createRefreshLeaderTargets(
  options: StartPageLeaderTrayOptions,
  sync: LeaderSyncManager
): () => Promise<void> {
  const cdpThrottle = new ThrottledErrorTracker(log, {
    failureMessage: 'Leader CDP target refresh failed (best-effort, throttled)',
    recoveryMessage: 'Leader CDP target refresh recovered (stable for debounce window)',
  });
  return async () => {
    let pages: Awaited<ReturnType<typeof options.browserAPI.listPages>>;
    try {
      pages = await options.browserAPI.listPages();
    } catch (err) {
      cdpThrottle.reportFailure(err);
      return;
    }
    cdpThrottle.reportSuccess();
    try {
      const selfOrigins =
        typeof location !== 'undefined' && location.origin ? [location.origin] : undefined;
      const targets: RemoteTargetInfo[] = pages
        .filter((p) => !isSliccAppUrl(p.url, { selfOrigins }))
        .map((p) => ({
          targetId: p.targetId,
          title: p.title,
          url: p.url,
        }));
      sync.setLocalTargets(targets);
    } catch (err) {
      log.error('Leader target broadcast failed (sync.setLocalTargets threw)', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };
}

function scheduleListBroadcasts(
  sync: LeaderSyncManager,
  refreshIntervalMs: number
): ReturnType<typeof setInterval> {
  return setInterval(() => {
    try {
      sync.broadcastScoopsList();
      sync.broadcastSprinklesList();
    } catch (err) {
      log.error('Failed to broadcast follower lists', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }, refreshIntervalMs);
}

function createUpdateUrlBar(
  options: StartPageLeaderTrayOptions
): (session: LeaderTraySession) => void {
  return (session: LeaderTraySession): void => {
    const history = options._historyOverride ?? safePageHistory();
    if (!history) return;
    try {
      const trayUrl = buildTrayLaunchUrl(history.href, session.workerBaseUrl, session.trayId);
      if (trayUrl !== history.href) {
        history.replaceState(null, '', trayUrl);
      }
    } catch (err) {
      log.debug('URL bar update skipped', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };
}

export function startPageLeaderTray(options: StartPageLeaderTrayOptions): PageLeaderTrayHandle {
  const refreshIntervalMs = options._refreshIntervalMs ?? 5000;
  const scoopBroadcastCoalesceMs = options._scoopBroadcastCoalesceMs ?? 50;
  const fetchImpl = options._fetchImpl ?? ((url, init) => fetch(url, init));

  let leader!: LeaderTrayManager;
  let peers!: LeaderTrayPeerManager;
  let sync!: LeaderSyncManager;
  const updateUrlBar = createUpdateUrlBar(options);
  const notifyFollowerCountChanged = (): void => {
    const count = getLeaderFollowerStates(peers, sync).filter(
      (follower) => follower.peerState === 'connected'
    ).length;
    options.onFollowerCountChanged?.(count);
  };

  sync = buildSyncManager(options, () => leader, notifyFollowerCountChanged);
  options.browserAPI.setTrayTargetProvider(sync);
  peers = buildPeerManager(
    () => leader,
    sync,
    notifyFollowerCountChanged,
    options._peerConnectionFactory
  );
  leader = buildLeaderManager(options, peers, sync, fetchImpl, updateUrlBar, () => leader);

  const unsubscribeAgent = options.onAgentEvent((event) => sync.broadcastEvent(event));

  const intervals: ReturnType<typeof setInterval>[] = [];
  const refreshLeaderTargets = createRefreshLeaderTargets(options, sync);
  intervals.push(setInterval(refreshLeaderTargets, refreshIntervalMs));
  void refreshLeaderTargets();
  intervals.push(scheduleListBroadcasts(sync, refreshIntervalMs));

  const startResult = leader.start();
  void startResult.then(updateUrlBar).catch((err) => {
    log.error('Leader tray start failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  });

  let stopped = false;
  let scoopBroadcastTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleScoopsListBroadcast = (): void => {
    if (stopped || scoopBroadcastTimer !== null) return;
    scoopBroadcastTimer = setTimeout(() => {
      scoopBroadcastTimer = null;
      if (!stopped) sync.broadcastScoopsList();
    }, scoopBroadcastCoalesceMs);
  };
  return {
    ready: startResult,
    scheduleScoopsListBroadcast,
    stop() {
      stopped = true;
      if (scoopBroadcastTimer !== null) clearTimeout(scoopBroadcastTimer);
      scoopBroadcastTimer = null;
      unsubscribeAgent();
      for (const id of intervals) clearInterval(id);
      sync.stop();
      peers.stop();
      leader.stop();
    },
    async reset(): Promise<LeaderTrayRuntimeStatus> {
      sync.stop();
      peers.stop();

      const session = await leader.reset();
      updateUrlBar(session);
      return getLeaderTrayRuntimeStatus();
    },
    leader,
    peers,
    sync,
    get currentLeaderSync(): LeaderSyncManager | null {
      return stopped ? null : sync;
    },
  };
}

function safePageHistory(): {
  href: string;
  replaceState: (state: unknown, unused: string, url: string) => void;
} | null {
  if (typeof window === 'undefined' || !window.history || !window.location) return null;
  return {
    get href(): string {
      return window.location.href;
    },
    replaceState(state, unused, url) {
      window.history.replaceState(state, unused, url);
    },
  } as {
    href: string;
    replaceState: (state: unknown, unused: string, url: string) => void;
  };
}
