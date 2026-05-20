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
import type { ChatMessage, AgentEvent } from '../../webapp/src/ui/types.js';
import type { MessageAttachment } from '../../webapp/src/core/attachments.js';
import type { SprinkleSummary } from '../../webapp/src/scoops/tray-sync-protocol.js';
import type { Logger } from '../../webapp/src/core/logger.js';
import { ThrottledErrorTracker } from '../../webapp/src/scoops/throttled-error-tracker.js';
import {
  setConnectedFollowersGetter,
  setTrayResetter,
} from '../../webapp/src/shell/supplemental-commands/host-command.js';
import type { OffscreenLeaderSyncBridgeHandle } from './leader-sync-bridge.js';
import { ServiceWorkerLeaderTraySocket } from './tray-socket-proxy.js';
import type { LeaderTrayResetRequestMsg, LeaderTrayResetResponseMsg } from './messages.js';

export interface ExtensionLeaderTrayHandle {
  /** Canonical teardown — runs the full sequence documented on the
   *  returned `stop()` method (unsubAgent → clearIntervals → sync.stop
   *  → trayPeers.stop → trayLeader.stop → clear host-command setters →
   *  removeListener → signalLeaderMode(false) → leaderBridge.detach).
   *  Idempotent. ALL external callers must use this — never call
   *  `.stop()` on the individual `sync` / `peers` / `leader` fields
   *  below or the teardown order is broken. */
  stop(): void;

  /** Reset the tray session by stopping + restarting the leader and
   *  returning the fresh runtime status. */
  reset(): Promise<LeaderTrayRuntimeStatus>;

  /** @internal Exposed for inspection and tests only. Do NOT call
   *  `.stop()` on this — use {@link ExtensionLeaderTrayHandle.stop}
   *  instead so the full teardown sequence runs in the documented
   *  order. Matches the `@internal` convention `OffscreenBridge` uses
   *  for `getBuffer`. */
  readonly sync: LeaderSyncManager;
  /** @internal Same caveat as {@link sync}. */
  readonly peers: LeaderTrayPeerManager;
  /** @internal Same caveat as {@link sync}. Production code calls
   *  `.start()` here once at boot in `offscreen.ts`; otherwise treat
   *  as inspection-only. */
  readonly leader: LeaderTrayManager;
}

/**
 * Narrow buffer view this factory needs on the bridge's per-scoop
 * message buffer. The full `BufferedChatMessage` shape lives in
 * `offscreen-bridge.ts` as a private interface — exposing only `push`
 * here keeps that internal shape encapsulated AND lets the bridge's
 * `getBuffer` return its private `BufferedChatMessage[]` (structurally
 * assignable to `BufferLike` because `BufferedChatMessage` is a
 * supertype of what we push).
 */
export interface BufferLike {
  push(msg: {
    id: string;
    role: 'user' | 'assistant';
    content: string;
    attachments?: MessageAttachment[];
    timestamp: number;
  }): void;
}

/** Narrow surface the factory needs on OffscreenBridge. */
export interface ExtensionLeaderBridge {
  getConeJid(): string | null;
  getActiveScoopJid(): string | null;
  setActiveScoopJid(jid: string | null): void;
  getMessagesForJid(jid: string): ChatMessage[];
  /** @internal The bridge's per-scoop message buffer. Returns the
   *  private `BufferedChatMessage[]` widened to `BufferLike` so this
   *  module doesn't import the bridge's internal shape — callers only
   *  push new entries, which is all `BufferLike` exposes. */
  getBuffer(jid: string): BufferLike;
  persistScoop(jid: string): void;
  routeSprinkleLick(name: string, body: unknown, targetScoop?: string): Promise<void>;
  notifyPanelIncomingMessage(jid: string, msg: ChannelMessage): void;
  onAgentEvent(handler: (scoopJid: string, event: AgentEvent) => void): () => void;
}

export interface StartExtensionLeaderTrayOptions {
  workerBaseUrl: string;
  bridge: ExtensionLeaderBridge;
  orchestrator: Orchestrator;
  sharedFs: VirtualFS | null;
  browser: BrowserAPI;
  log: Logger;
  leaderBridge: OffscreenLeaderSyncBridgeHandle;

  /** @internal */ _trayLeaderFactory?: (
    cfg: ConstructorParameters<typeof LeaderTrayManager>[0]
  ) => LeaderTrayManager;
  /** @internal */ _peerManagerFactory?: (
    cfg: ConstructorParameters<typeof LeaderTrayPeerManager>[0]
  ) => LeaderTrayPeerManager;
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
  let stopped = false;

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
    getMessages: () => bridge.getMessagesForJid(getActiveJid()),
    getMessagesForScoop: (jid) => bridge.getMessagesForJid(jid),
    getScoopJid: () => getActiveJid(),
    getScoops: toScoopSummaries,
    // Commit to the canonical `SprinkleSummary[]` here. The bridge handle
    // returns `SprinkleSummaryEnvelope[]` (a structural mirror) because
    // `messages.ts` cannot import from `tray-sync-protocol.ts` under the
    // worker tsconfig; the two shapes are equivalent at the field level,
    // and the leader-sync factory is the right boundary to commit to
    // the canonical type the rest of the pipeline expects.
    getSprinkles: () => leaderBridge.getSprinkles() as SprinkleSummary[],
    readSprinkleContent: async (name) => {
      const path = leaderBridge.resolveSprinklePath(name);
      if (!path || !sharedFs) return null;
      try {
        const raw = await sharedFs.readFile(path, { encoding: 'utf-8' });
        return typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
      } catch (err) {
        const code = (err as { code?: string })?.code;
        if (code === 'ENOENT') return null; // expected — sprinkle file deleted between snapshot and read
        options.log.error('readSprinkleContent failed', {
          name,
          error: err instanceof Error ? err.message : String(err),
        });
        return null;
      }
    },
    onSprinkleLick: (name, body, targetScoop) => {
      void bridge.routeSprinkleLick(name, body, targetScoop).catch((err) => {
        options.log.error('routeSprinkleLick failed', {
          name,
          targetScoop,
          error: err instanceof Error ? err.message : String(err),
        });
      });
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
      // (see `EXTERNAL_LICK_CHANNELS` in `lick-formatting.ts`), so
      // `orchestrator.handleMessage`'s gated `onIncomingMessage` call
      // does NOT fire for this channel. Without the explicit emit below,
      // the follower's typed message never reaches the leader's panel UI.
      bridge.notifyPanelIncomingMessage(activeJid, channelMsg);

      bridge.getBuffer(activeJid).push({
        id: messageId,
        role: 'user',
        content: text,
        attachments,
        timestamp: Date.now(),
      });
      bridge.persistScoop(activeJid);

      // (3) Rebroadcast immediately — don't gate on the agent turn.
      // Matches the standalone path's `sync.broadcastUserMessage`
      // ordering in `page-leader-tray.ts`/`main.ts` for sibling followers.
      sync.broadcastUserMessage(text, messageId, attachments);

      // Orchestrator dispatch runs in a fire-and-forget IIFE so the outer
      // signature stays `void` (the `LeaderSyncManagerOptions.onFollowerMessage`
      // declaration in `tray-leader-sync.ts` is `=> void` and the caller
      // doesn't await). Errors are caught and logged so they don't become
      // unhandled rejections.
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

  // `LeaderSyncManager.broadcastEvent` tags the wire payload with
  // `options.getScoopJid()` (the active scoop) and ignores the event's
  // own `scoopJid`. Without filtering at the tap, a background scoop's
  // stream would be broadcast tagged as the active scoop — wrong content
  // + wrong scope. Filter `eventScoopJid !== getActiveJid()` here so
  // only events from the currently-active scoop are forwarded, matching
  // the standalone path's filter in `offscreen-client.ts` `handleAgentEvent`.
  const unsubAgent = bridge.onAgentEvent((eventScoopJid, event) => {
    if (eventScoopJid !== getActiveJid()) return;
    sync.broadcastEvent(event);
  });

  // Periodic refreshes mirror the standalone `page-leader-tray.ts`
  // refresh wiring. `setLocalTargets` is the LEADER API on
  // `LeaderSyncManager` — do NOT confuse with `advertiseTargets`, which
  // is the follower API on `FollowerSyncManager`. CDP errors are
  // throttled via `ThrottledErrorTracker` so a flapping CDP transport
  // doesn't spam the log.
  const cdpThrottle = new ThrottledErrorTracker(options.log, {
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
    sendControlMessage: (m) => trayLeader.sendControlMessage(m),
    onPeerConnected: (peer, channel) => {
      options.log.info('Extension tray follower connected', {
        bootstrapId: peer.bootstrapId,
        runtime: peer.runtime,
      });
      sync.addFollower(peer.bootstrapId, channel, {
        runtime: peer.runtime,
        connectedAt: peer.connectedAt ?? undefined,
      });
    },
    onPeerDisconnected: (bootstrapId, reason) =>
      options.log.info('Extension tray follower disconnected', { bootstrapId, reason }),
  });

  const leaderFactory = options._trayLeaderFactory ?? ((cfg) => new LeaderTrayManager(cfg));
  trayLeader = leaderFactory({
    workerBaseUrl,
    runtime: 'slicc-extension-offscreen',
    webSocketFactory: (url: string) => new ServiceWorkerLeaderTraySocket(url),
    onControlMessage: (message) => {
      if (message.type === 'webhook.event') {
        orchestrator.handleWebhookEvent(message.webhookId, message.headers, message.body);
        return;
      }
      void trayPeers.handleControlMessage(message).catch((err) => {
        options.log.error('Tray leader bootstrap handling failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    },
    onReconnecting: (attempt, lastError) =>
      options.log.info('Extension leader tray reconnecting', { attempt, lastError }),
    onReconnected: (session) =>
      options.log.info('Extension leader tray reconnected', { trayId: session.trayId }),
    onReconnectGaveUp: (lastError, attempts) =>
      options.log.error('Extension leader tray reconnect gave up', { lastError, attempts }),
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

  // `onFollowerCountChanged` — parity with the standalone
  // `page-leader-tray.ts` `onFollowerCountChanged` wiring.
  // `LeaderSyncManager` stores `options` by reference, so assigning
  // after construction mutates the live options.
  syncOptions.onFollowerCountChanged = (_count: number) => {
    const peers = trayPeers.getPeers().map((p) => ({
      runtimeId: p.bootstrapId,
      runtime: p.runtime,
      connectedAt: p.connectedAt ?? undefined,
    }));
    try {
      window.localStorage.setItem('slicc.leaderTrayFollowers', JSON.stringify(peers));
    } catch (err) {
      options.log.error('Failed to persist leaderTrayFollowers', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  // leader-tray-reset RPC listener. Matches the envelope shape from
  // `PanelLeaderSyncProxy.resetTray` in `leader-sync-bridge.ts`:
  // `{ source: 'panel', payload: { type: 'leader-tray-reset', requestId } }`.
  // Replies with `{ source: 'offscreen', payload: { type: 'leader-tray-reset-response', ... } }`.
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
        chrome.runtime
          .sendMessage({ source: 'offscreen', payload: reply })
          .catch((err: unknown) => {
            const errMsg = err instanceof Error ? err.message : String(err);
            if (/receiving end does not exist/i.test(errMsg)) return;
            options.log.error('Failed to deliver leader-tray-reset-response', {
              requestId: req.requestId,
              ok: reply.ok,
              error: errMsg,
            });
          });
      } catch (err) {
        const reply: LeaderTrayResetResponseMsg = {
          type: 'leader-tray-reset-response',
          requestId: req.requestId,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
        chrome.runtime
          .sendMessage({ source: 'offscreen', payload: reply })
          .catch((err: unknown) => {
            const errMsg = err instanceof Error ? err.message : String(err);
            if (/receiving end does not exist/i.test(errMsg)) return;
            options.log.error('Failed to deliver leader-tray-reset-response', {
              requestId: req.requestId,
              ok: reply.ok,
              error: errMsg,
            });
          });
      }
    })();
    return false;
  };
  chrome.runtime.onMessage.addListener(resetListener);

  return {
    /**
     * Canonical teardown order (mirrors `page-leader-tray.ts`):
     * unsubscribe agent events → clear intervals → stop sync/peers/leader
     * → clear host-command setters → remove reset listener →
     * `signalLeaderMode(false)` → `leaderBridge.detach()`.
     * `signalLeaderMode(false)` runs BEFORE `detach()` so the panel sees
     * the deactivation signal before the hub listener goes away.
     * Idempotent via the `stopped` flag.
     */
    stop() {
      if (stopped) return;
      stopped = true;
      unsubAgent();
      for (const id of intervals) clearInterval(id);
      sync.stop();
      trayPeers.stop();
      trayLeader.stop();
      setConnectedFollowersGetter(null);
      setTrayResetter(null);
      chrome.runtime.onMessage.removeListener(resetListener);
      leaderBridge.signalLeaderMode(false);
      leaderBridge.detach();
    },
    async reset() {
      return resetSequence();
    },
    sync,
    peers: trayPeers,
    leader: trayLeader,
  };
}
