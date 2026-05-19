/**
 * `page-leader-tray.ts` — page-side boot wiring for the multi-browser
 * sync leader role.
 *
 * Restores the pre-regression architecture (pre-`07cdce16`) where the
 * tray subsystem lived on the page so its WebRTC peer manager and the
 * sync manager that consumes the resulting `RTCDataChannel`s share the
 * same thread. After the kernel-worker refactor, the orchestrator and
 * `LickManager` moved into the worker, but `LeaderSyncManager`'s
 * page-side dependencies (chat panel, sprinkle manager, agent handle)
 * cannot follow — and `RTCDataChannel` instances cannot cross the
 * worker boundary either. So the tray subsystem stays on the page and
 * webhook events are relayed to the worker's `LickManager` via the
 * `lick-webhook-event` bridge message.
 *
 * See `docs/superpowers/specs/2026-05-17-multi-browser-sync-page-side-restoration.md`
 * for the full design and the architectural diagrams.
 *
 * This module deliberately has no UI imports — it takes a flat-callback
 * options object that the caller (`mainStandaloneWorker`) wires from
 * page state at the call site. That keeps the module easy to test and
 * keeps the helper's import graph small.
 */

import { LeaderTrayManager } from '../scoops/tray-leader.js';
import type {
  LeaderTraySession,
  LeaderTraySessionStore,
  LeaderTrayWebSocket,
} from '../scoops/tray-leader.js';
import { LeaderTrayPeerManager } from '../scoops/tray-webrtc.js';
import { LeaderSyncManager } from '../scoops/tray-leader-sync.js';
import type { LeaderSyncManagerOptions } from '../scoops/tray-leader-sync.js';
import type {
  ScoopSummary,
  SprinkleSummary,
  RemoteTargetInfo,
} from '../scoops/tray-sync-protocol.js';
import type { AgentEvent } from './types.js';
import type { BrowserAPI } from '../cdp/browser-api.js';
import type { CDPTransport } from '../cdp/transport.js';
import type { VirtualFS } from '../fs/virtual-fs.js';
import { buildTrayLaunchUrl } from '../scoops/tray-runtime-config.js';
import { getLeaderTrayRuntimeStatus, type LeaderTrayRuntimeStatus } from '../scoops/tray-leader.js';
import { createLogger } from '../core/logger.js';

const log = createLogger('page-leader-tray');

/**
 * Page-side dependency surface for {@link startPageLeaderTray}. Mirrors
 * `LeaderSyncManagerOptions` plus the one cross-thread bridge callback
 * (`sendWebhookEvent`) and the agent-event subscription primitive
 * (`onAgentEvent`). No heavy UI types are imported here — the caller
 * wires each callback at the call site.
 */
export interface StartPageLeaderTrayOptions {
  /** Cloudflare tray worker base URL (from `tray-worker-base-url` localStorage). */
  workerBaseUrl: string;

  // --- LeaderSyncManager dependencies (flat callbacks) ---
  getMessages: LeaderSyncManagerOptions['getMessages'];
  getMessagesForScoop?: LeaderSyncManagerOptions['getMessagesForScoop'];
  getScoopJid: LeaderSyncManagerOptions['getScoopJid'];
  getScoops?: () => ScoopSummary[];
  getSprinkles?: () => SprinkleSummary[];
  readSprinkleContent?: LeaderSyncManagerOptions['readSprinkleContent'];
  onSprinkleLick?: LeaderSyncManagerOptions['onSprinkleLick'];
  onFollowerMessage: LeaderSyncManagerOptions['onFollowerMessage'];
  onFollowerAbort: LeaderSyncManagerOptions['onFollowerAbort'];
  onFollowerCountChanged?: LeaderSyncManagerOptions['onFollowerCountChanged'];

  // --- Bridge hop to worker LickManager (replaces the pre-regression direct call) ---
  /**
   * Forward a tray `webhook.event` control message to the worker's
   * `LickManager`. Wired to `OffscreenClient.sendWebhookEvent` by the
   * caller. Fire-and-forget; no ack expected.
   */
  sendWebhookEvent: (webhookId: string, headers: Record<string, string>, body: unknown) => void;

  // --- Agent event tap (helper owns the subscription) ---
  /**
   * Subscribe to agent events. The helper installs one listener that
   * forwards each event to `LeaderSyncManager.broadcastEvent`. The
   * returned unsubscribe is invoked from {@link PageLeaderTrayHandle.stop}.
   * Wired to `agentHandle.onEvent` by the caller.
   */
  onAgentEvent: (handler: (event: AgentEvent) => void) => () => void;

  // --- BrowserAPI + VFS for shared targets and sprinkle reads ---
  browserAPI: BrowserAPI;
  browserTransport?: CDPTransport;
  vfs?: VirtualFS;

  // --- Test hooks ---
  /** @internal Override the session store (defaults to IndexedDB-backed). */
  _storeOverride?: LeaderTraySessionStore;
  /** @internal Override the WebSocket factory (defaults to `new WebSocket(url)`). */
  _webSocketFactory?: (url: string) => LeaderTrayWebSocket;
  /** @internal Override fetch (defaults to plain `fetch`). */
  _fetchImpl?: typeof fetch;
  /** @internal Override `window` for URL bar updates (defaults to global `window`, no-op when absent). */
  _historyOverride?: {
    href: string;
    replaceState: (state: unknown, unused: string, url: string) => void;
  };
  /** @internal Override the periodic-refresh interval in ms (default 5000). */
  _refreshIntervalMs?: number;
}

export interface PageLeaderTrayHandle {
  /** Stop the tray, peer manager, sync manager, and all periodic refreshes. */
  stop(): void;
  /**
   * Reset the tray session (used by the `host reset` shell command).
   * Stops the leader, clears its persisted session, starts a new one,
   * and updates the URL bar. Returns the post-reset runtime status.
   */
  reset(): Promise<LeaderTrayRuntimeStatus>;
  /** Exposed for testing — read-only access to the underlying managers. */
  readonly leader: LeaderTrayManager;
  readonly peers: LeaderTrayPeerManager;
  readonly sync: LeaderSyncManager;
}

/**
 * Construct + start the leader tray subsystem on the page. Returns a
 * handle that the caller can hold for `host reset` and shutdown.
 *
 * Caller is responsible for gating on `workerBaseUrl` presence and
 * `joinUrl` absence (presence of a join URL means this instance is a
 * follower, handled separately by {@link startPageFollowerTray}).
 */
export function startPageLeaderTray(options: StartPageLeaderTrayOptions): PageLeaderTrayHandle {
  const refreshIntervalMs = options._refreshIntervalMs ?? 5000;
  const fetchImpl = options._fetchImpl ?? ((url, init) => fetch(url, init));

  // Forward declarations so the closures below can capture by reference;
  // managers are constructed bottom-up because each one references the
  // others by closure exactly like the pre-regression `main.ts` code did.
  let leader!: LeaderTrayManager;
  let peers!: LeaderTrayPeerManager;
  let sync!: LeaderSyncManager;

  // --- Sync manager (top of the dependency chain — peers feeds it) ---
  const syncOptions: LeaderSyncManagerOptions = {
    getMessages: options.getMessages,
    getMessagesForScoop: options.getMessagesForScoop,
    getScoopJid: options.getScoopJid,
    getScoops: options.getScoops,
    getSprinkles: options.getSprinkles,
    readSprinkleContent: options.readSprinkleContent,
    onSprinkleLick: options.onSprinkleLick,
    onFollowerMessage: options.onFollowerMessage,
    onFollowerAbort: options.onFollowerAbort,
    onFollowerCountChanged: options.onFollowerCountChanged,
    browserAPI: options.browserAPI,
    browserTransport: options.browserTransport,
    vfs: options.vfs,
  };
  sync = new LeaderSyncManager(syncOptions);
  options.browserAPI.setTrayTargetProvider(sync);

  // --- Peer manager: routes signaling through the leader tray and
  // hands open data channels to the sync manager. ---
  peers = new LeaderTrayPeerManager({
    sendControlMessage: (message) => leader.sendControlMessage(message),
    onPeerConnected: (peer, channel) => {
      log.info('Tray follower data channel opened', {
        controllerId: peer.controllerId,
        bootstrapId: peer.bootstrapId,
        attempt: peer.attempt,
        runtime: peer.runtime,
      });
      sync.addFollower(peer.bootstrapId, channel, {
        runtime: peer.runtime,
        connectedAt: peer.connectedAt ?? undefined,
      });
    },
    onPeerDisconnected: (bootstrapId, reason) => {
      log.info('Tray follower disconnected', { bootstrapId, reason });
    },
  });

  // --- Tray manager: WebSocket liaison + control-message dispatcher.
  // Webhook events relay through the bridge to the worker's LickManager;
  // everything else is signaling for the peer manager.
  leader = new LeaderTrayManager({
    workerBaseUrl: options.workerBaseUrl,
    runtime: 'slicc-standalone',
    fetchImpl,
    ...(options._storeOverride ? { store: options._storeOverride } : {}),
    ...(options._webSocketFactory ? { webSocketFactory: options._webSocketFactory } : {}),
    onControlMessage: (message) => {
      if (message.type === 'webhook.event') {
        options.sendWebhookEvent(message.webhookId, message.headers, message.body);
        return;
      }
      void peers.handleControlMessage(message).catch((err) => {
        log.warn('Tray leader bootstrap handling failed', {
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
    },
    onReconnectGaveUp: (lastError, attempts) => {
      log.warn('Leader tray reconnect gave up', { lastError, attempts });
    },
  });

  // --- Agent event tap → broadcast to all followers. The helper owns
  // this subscription (and unsubscribes on stop) so the caller doesn't
  // have to track it. See spec §6.6.
  const unsubscribeAgent = options.onAgentEvent((event) => sync.broadcastEvent(event));

  // --- Periodic refreshes. Each fires every `refreshIntervalMs` (5s
  // default) so a single missed update on the data channel doesn't
  // leave the follower's view permanently stale.
  const intervals: ReturnType<typeof setInterval>[] = [];

  // Browser targets: poll local CDP for the leader's open pages and
  // push them into the sync manager as the leader's local targets.
  const refreshLeaderTargets = async () => {
    try {
      const pages = await options.browserAPI.listPages();
      const targets: RemoteTargetInfo[] = pages.map((p) => ({
        targetId: p.targetId,
        title: p.title,
        url: p.url,
      }));
      sync.setLocalTargets(targets);
    } catch {
      /* ignore — browser may be unavailable transiently */
    }
  };
  intervals.push(setInterval(refreshLeaderTargets, refreshIntervalMs));
  void refreshLeaderTargets();

  // Scoops + sprinkles lists: re-broadcast so followers stay in sync as
  // the leader adds, drops, or activates scoops / sprinkles.
  intervals.push(
    setInterval(() => {
      try {
        sync.broadcastScoopsList();
        sync.broadcastSprinklesList();
      } catch (err) {
        log.debug('Failed to broadcast follower lists', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }, refreshIntervalMs)
  );

  // --- Update the URL bar with the tray join URL after successful
  // connection, so reloads attach to the same session.
  function updateUrlBar(session: LeaderTraySession): void {
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
  }

  // Kick off the leader connection.
  void leader
    .start()
    .then((session) => {
      updateUrlBar(session);
    })
    .catch((err) => {
      log.warn('Leader tray start failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    });

  return {
    stop() {
      unsubscribeAgent();
      for (const id of intervals) clearInterval(id);
      sync.stop();
      peers.stop();
      leader.stop();
    },
    async reset(): Promise<LeaderTrayRuntimeStatus> {
      sync.stop();
      peers.stop();
      leader.stop();
      await leader.clearSession();
      const session = await leader.start();
      updateUrlBar(session);
      return getLeaderTrayRuntimeStatus();
    },
    leader,
    peers,
    sync,
  };
}

/**
 * Resolve the page's `window.history`-like surface when running in the
 * browser. Returns `null` in Node tests so URL updates are skipped.
 */
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
