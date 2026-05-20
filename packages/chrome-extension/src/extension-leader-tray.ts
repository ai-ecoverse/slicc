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
import {
  getLeaderTrayRuntimeStatus,
  type LeaderTrayRuntimeStatus,
} from '../../webapp/src/scoops/tray-leader.js';
import { LeaderTrayPeerManager } from '../../webapp/src/scoops/tray-webrtc.js';
import type { Orchestrator } from '../../webapp/src/scoops/orchestrator.js';
import type { BrowserAPI } from '../../webapp/src/cdp/browser-api.js';
import type { VirtualFS } from '../../webapp/src/fs/virtual-fs.js';
import type { ChannelMessage } from '../../webapp/src/scoops/types.js';
import { ThrottledErrorTracker } from '../../webapp/src/scoops/throttled-error-tracker.js';
import {
  setConnectedFollowersGetter,
  setTrayResetter,
} from '../../webapp/src/shell/supplemental-commands/host-command.js';
import type { OffscreenLeaderSyncBridgeHandle } from './leader-sync-bridge.js';
import { ServiceWorkerLeaderTraySocket } from './tray-socket-proxy.js';
import type { LeaderTrayResetRequestMsg, LeaderTrayResetResponseMsg } from './messages.js';

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
  const refreshIntervalMs = options._refreshIntervalMs ?? 5000;

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

  // LeaderSyncManager.broadcastEvent (tray-leader-sync.ts:300-304) tags the
  // wire payload with options.getScoopJid() (the active scoop) and ignores
  // the event's own scoopJid. Without filtering at the tap, a background
  // scoop's stream would be broadcast tagged as the active scoop — wrong
  // content + wrong scope. Filter `eventScoopJid !== getActiveJid()` here so
  // only events from the currently-active scoop are forwarded, matching the
  // standalone path's implicit filter in offscreen-client.ts:496.
  const unsubAgent = bridge.onAgentEvent((eventScoopJid: string, event: any) => {
    if (eventScoopJid !== getActiveJid()) return;
    sync.broadcastEvent(event);
  });

  // Periodic refreshes mirror page-leader-tray.ts:234-285. setLocalTargets
  // is the LEADER API (tray-leader-sync.ts:725) — do NOT confuse with
  // advertiseTargets, which is the follower API (tray-follower-sync.ts:315).
  // CDP errors are throttled via ThrottledErrorTracker so a flapping CDP
  // transport doesn't spam the log.
  const cdpThrottle = new ThrottledErrorTracker(options.log as any, {
    failureMessage: 'Extension leader CDP target refresh failed (best-effort, throttled)',
    recoveryMessage: 'Extension leader CDP target refresh recovered',
  });

  const refreshLeaderTargets = async () => {
    let pages: Awaited<ReturnType<BrowserAPI['listPages']>>;
    try {
      pages = await browser.listPages();
    } catch (err) {
      cdpThrottle.reportFailure(err);
      return;
    }
    cdpThrottle.reportSuccess();
    try {
      sync.setLocalTargets(
        pages.map((p) => ({ targetId: p.targetId, title: p.title, url: p.url }))
      );
    } catch (err) {
      options.log.error('Extension leader target broadcast failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const intervals: ReturnType<typeof setInterval>[] = [
    setInterval(refreshLeaderTargets, refreshIntervalMs),
    setInterval(() => {
      try {
        sync.broadcastScoopsList();
        sync.broadcastSprinklesList();
      } catch (err) {
        options.log.error('Failed to broadcast follower lists', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }, refreshIntervalMs),
  ];
  // Immediate first refresh so followers don't wait a full interval for
  // their first target snapshot after leader boot.
  void refreshLeaderTargets();

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
    webSocketFactory: (url: string) => new ServiceWorkerLeaderTraySocket(url),
    onControlMessage: (message: any) => {
      if (message.type === 'webhook.event') {
        orchestrator.handleWebhookEvent(message.webhookId, message.headers, message.body);
        return;
      }
      void trayPeers.handleControlMessage(message).catch((err) => {
        options.log.warn('Tray leader bootstrap handling failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    },
    onReconnecting: (attempt: number, lastError: any) =>
      options.log.info('Extension leader tray reconnecting', { attempt, lastError }),
    onReconnected: (session: any) =>
      options.log.info('Extension leader tray reconnected', { trayId: session.trayId }),
    onReconnectGaveUp: (lastError: any, attempts: number) =>
      options.log.warn('Extension leader tray reconnect gave up', { lastError, attempts }),
  });

  // Panel terminal `host` reads from host-command.ts module singletons.
  // The host-command module is shared by panel and offscreen so wiring
  // the offscreen-side getter here lets the panel terminal's `host`
  // command surface the live follower list. (`host reset` cross-context
  // routing goes via the chrome.runtime envelope below, NOT via
  // setTrayResetter — but we still populate it for offscreen-local
  // shell consumers.)
  setConnectedFollowersGetter(() =>
    trayPeers.getPeers().map((p) => ({
      runtimeId: p.bootstrapId,
      runtime: p.runtime,
      connectedAt: p.connectedAt ?? undefined,
    }))
  );

  const resetSequence = async (): Promise<LeaderTrayRuntimeStatus> => {
    sync.stop();
    trayPeers.stop();
    trayLeader.stop();
    await trayLeader.clearSession();
    await trayLeader.start();
    return getLeaderTrayRuntimeStatus();
  };
  setTrayResetter(resetSequence);

  // onFollowerCountChanged — parity with standalone main.ts:2465-2476.
  // LeaderSyncManager stores options by reference (tray-leader-sync.ts:155),
  // so assigning after construction mutates the live options.
  syncOptions.onFollowerCountChanged = (_count: number) => {
    const peers = trayPeers.getPeers().map((p) => ({
      runtimeId: p.bootstrapId,
      runtime: p.runtime,
      connectedAt: p.connectedAt ?? undefined,
    }));
    try {
      window.localStorage.setItem('slicc.leaderTrayFollowers', JSON.stringify(peers));
    } catch (err) {
      options.log.warn('Failed to persist leaderTrayFollowers', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  // leader-tray-reset RPC listener. Matches the envelope shape from
  // PanelLeaderSyncProxy.resetTray (Task 10): `{ source: 'panel',
  // payload: { type: 'leader-tray-reset', requestId } }`. Replies with
  // `{ source: 'offscreen', payload: { type: 'leader-tray-reset-response', ... } }`.
  const resetListener = (message: unknown): boolean => {
    if (typeof message !== 'object' || message === null) return false;
    const env = message as { source?: string; payload?: { type?: string } };
    if (env.source !== 'panel') return false;
    if (env.payload?.type !== 'leader-tray-reset') return false;
    const req = env.payload as LeaderTrayResetRequestMsg;
    void (async () => {
      try {
        const status = await resetSequence();
        const reply: LeaderTrayResetResponseMsg = {
          type: 'leader-tray-reset-response',
          requestId: req.requestId,
          ok: true,
          status,
        };
        chrome.runtime.sendMessage({ source: 'offscreen', payload: reply }).catch(() => {});
      } catch (err) {
        const reply: LeaderTrayResetResponseMsg = {
          type: 'leader-tray-reset-response',
          requestId: req.requestId,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
        chrome.runtime.sendMessage({ source: 'offscreen', payload: reply }).catch(() => {});
      }
    })();
    return false;
  };
  chrome.runtime.onMessage.addListener(resetListener);

  return {
    stop() {
      // Unsubscribe the agent tap FIRST so no late events reach the
      // now-stopping sync. Then clear intervals so no late refresh /
      // broadcast tick runs after sync.stop(). Matches standalone
      // teardown order at page-leader-tray.ts:316-323.
      unsubAgent();
      for (const id of intervals) clearInterval(id);
      setConnectedFollowersGetter(null);
      setTrayResetter(null);
      chrome.runtime.onMessage.removeListener(resetListener);
      sync.stop();
      trayPeers.stop();
      trayLeader.stop();
    },
    async reset() {
      return resetSequence();
    },
    sync,
    peers: trayPeers,
    leader: trayLeader,
  };
}
