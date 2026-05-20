/**
 * Extension-leader tray factory — offscreen-side equivalent of
 * page-leader-tray.ts. Constructs LeaderSyncManager + LeaderTrayPeerManager
 * + LeaderTrayManager and wires the data-source callbacks against
 * OffscreenBridge state.
 *
 * Extracted from offscreen.ts so unit tests can drive the factory with
 * stubbed transports (no chrome.runtime, no real RTCDataChannel,
 * no createKernelHost).
 */

import { LeaderSyncManager } from '../../webapp/src/scoops/tray-leader-sync.js';
import type { LeaderSyncManagerOptions } from '../../webapp/src/scoops/tray-leader-sync.js';
import { LeaderTrayManager } from '../../webapp/src/scoops/tray-leader.js';
import type { LeaderTrayRuntimeStatus } from '../../webapp/src/scoops/tray-leader.js';
import { LeaderTrayPeerManager } from '../../webapp/src/scoops/tray-webrtc.js';
import type { Orchestrator } from '../../webapp/src/scoops/orchestrator.js';
import type { BrowserAPI } from '../../webapp/src/cdp/browser-api.js';
import type { VirtualFS } from '../../webapp/src/fs/virtual-fs.js';
import type { ChannelMessage } from '../../webapp/src/scoops/types.js';
import type { OffscreenLeaderSyncBridgeHandle } from './leader-sync-bridge.js';

export interface ExtensionLeaderTrayHandle {
  stop(): void;
  reset(): Promise<LeaderTrayRuntimeStatus>;
  readonly sync: LeaderSyncManager;
  readonly peers: LeaderTrayPeerManager;
  readonly leader: LeaderTrayManager;
}

/** Narrow surface the factory needs on OffscreenBridge. */
export interface ExtensionLeaderBridge {
  getConeJid(): string | null;
  getActiveScoopJid(): string | null;
  setActiveScoopJid(jid: string | null): void;
  getMessagesForJid(jid: string): any[];
  getBuffer(jid: string): any[];
  persistScoop(jid: string): void;
  routeSprinkleLick(name: string, body: unknown, targetScoop?: string): Promise<void>;
  notifyPanelIncomingMessage(jid: string, msg: ChannelMessage): void;
  onAgentEvent(handler: (scoopJid: string, event: any) => void): () => void;
}

export interface StartExtensionLeaderTrayOptions {
  workerBaseUrl: string;
  bridge: ExtensionLeaderBridge;
  orchestrator: Orchestrator;
  sharedFs: VirtualFS | null;
  browser: BrowserAPI;
  log: {
    info: (msg: string, ctx?: any) => void;
    warn: (msg: string, ctx?: any) => void;
    error: (msg: string, ctx?: any) => void;
    debug?: (msg: string, ctx?: any) => void;
  };
  leaderBridge: OffscreenLeaderSyncBridgeHandle;

  /** @internal */ _trayLeaderFactory?: (cfg: any) => LeaderTrayManager;
  /** @internal */ _peerManagerFactory?: (cfg: any) => LeaderTrayPeerManager;
  /** @internal */ _refreshIntervalMs?: number;
  /** @internal */ _onSyncOptions?: (opts: LeaderSyncManagerOptions) => void;
}

export function startExtensionLeaderTray(
  options: StartExtensionLeaderTrayOptions
): ExtensionLeaderTrayHandle {
  const { workerBaseUrl, bridge, orchestrator, sharedFs, browser, leaderBridge } = options;

  let sync!: LeaderSyncManager;
  let trayLeader!: LeaderTrayManager;
  let trayPeers!: LeaderTrayPeerManager;

  const getActiveJid = (): string => bridge.getActiveScoopJid() ?? bridge.getConeJid() ?? '';

  const toScoopSummaries = () =>
    orchestrator.getScoops().map((s) => ({
      jid: s.jid,
      name: s.name,
      folder: s.folder,
      isCone: s.isCone,
      assistantLabel: s.assistantLabel,
      trigger: s.trigger,
    }));

  const syncOptions: LeaderSyncManagerOptions = {
    getMessages: () => bridge.getMessagesForJid(getActiveJid()) as any,
    getMessagesForScoop: (jid) => bridge.getMessagesForJid(jid) as any,
    getScoopJid: () => getActiveJid(),
    getScoops: toScoopSummaries,
    getSprinkles: () => leaderBridge.getSprinkles() as any,
    readSprinkleContent: async (name) => {
      const path = leaderBridge.resolveSprinklePath(name);
      if (!path || !sharedFs) return null;
      try {
        const raw = await sharedFs.readFile(path, { encoding: 'utf-8' });
        return typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
      } catch {
        return null;
      }
    },
    onSprinkleLick: (name, body, targetScoop) => {
      void bridge.routeSprinkleLick(name, body, targetScoop);
    },
    onFollowerMessage: (text, messageId, attachments) => {
      const activeJid = getActiveJid();
      if (!activeJid) return;
      const channelMsg: ChannelMessage = {
        id: messageId,
        chatJid: activeJid,
        senderId: 'user',
        senderName: 'User',
        content: text,
        attachments,
        timestamp: new Date().toISOString(),
        fromAssistant: false,
        channel: 'web',
      };

      // (1) Panel echo. `'web'` is NOT in EXTERNAL_LICK_CHANNELS
      // (lick-formatting.ts:29-37), so orchestrator.handleMessage's gated
      // onIncomingMessage call at orchestrator.ts:1297-1306 does NOT fire
      // for this channel. Without the explicit emit below, the follower's
      // typed message never reaches the leader's panel UI.
      bridge.notifyPanelIncomingMessage(activeJid, channelMsg);

      // (2) Buffer + persist (matches offscreen-bridge.ts:784-791).
      bridge.getBuffer(activeJid).push({
        id: messageId,
        role: 'user',
        content: text,
        attachments,
        timestamp: Date.now(),
      });
      bridge.persistScoop(activeJid);

      // (3) Rebroadcast immediately — don't gate on the agent turn.
      // Matches main.ts:2462 ordering for sibling followers.
      sync.broadcastUserMessage(text, messageId, attachments);

      // (4) Async orchestrator dispatch in fire-and-forget IIFE.
      void (async () => {
        try {
          await orchestrator.handleMessage(channelMsg);
          orchestrator.createScoopTab(activeJid);
        } catch (err) {
          options.log.error('Follower message dispatch failed', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      })();
    },
    onFollowerAbort: () => {
      const jid = getActiveJid();
      if (jid) orchestrator.stopScoop(jid);
    },
    browserAPI: browser,
    browserTransport: browser.getTransport?.() ?? undefined,
    vfs: sharedFs ?? undefined,
  };
  sync = new LeaderSyncManager(syncOptions);
  options._onSyncOptions?.(syncOptions);
  browser.setTrayTargetProvider?.(sync);

  const peerFactory = options._peerManagerFactory ?? ((cfg) => new LeaderTrayPeerManager(cfg));
  trayPeers = peerFactory({
    sendControlMessage: (m: any) => trayLeader.sendControlMessage(m),
    onPeerConnected: (peer: any, channel: any) => {
      options.log.info('Extension tray follower connected', {
        bootstrapId: peer.bootstrapId,
        runtime: peer.runtime,
      });
      sync.addFollower(peer.bootstrapId, channel, {
        runtime: peer.runtime,
        connectedAt: peer.connectedAt ?? undefined,
      });
    },
    onPeerDisconnected: (bootstrapId: string, reason: string) =>
      options.log.info('Extension tray follower disconnected', { bootstrapId, reason }),
  });

  const leaderFactory = options._trayLeaderFactory ?? ((cfg) => new LeaderTrayManager(cfg));
  trayLeader = leaderFactory({
    workerBaseUrl,
    runtime: 'slicc-extension-offscreen',
    onControlMessage: () => {},
    onReconnecting: () => {},
    onReconnected: () => {},
    onReconnectGaveUp: () => {},
  });

  return {
    stop() {
      sync.stop();
      trayPeers.stop();
      trayLeader.stop();
    },
    async reset() {
      sync.stop();
      trayPeers.stop();
      trayLeader.stop();
      await trayLeader.clearSession();
      await trayLeader.start();
      const { getLeaderTrayRuntimeStatus } = await import('../../webapp/src/scoops/tray-leader.js');
      return getLeaderTrayRuntimeStatus();
    },
    sync,
    peers: trayPeers,
    leader: trayLeader,
  };
}
