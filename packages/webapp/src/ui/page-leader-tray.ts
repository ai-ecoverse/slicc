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

import type { BrowserAPI } from '../cdp/browser-api.js';
import type { CDPTransport } from '../cdp/transport.js';
import { createLogger } from '../core/logger.js';
import type { VirtualFS } from '../fs/virtual-fs.js';
import type { LickEvent } from '../scoops/lick-manager.js';
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
import { LeaderSyncManager } from '../scoops/tray-leader-sync.js';
import { buildTrayLaunchUrl } from '../scoops/tray-runtime-config.js';
import type {
  RemoteTargetInfo,
  ScoopSummary,
  SprinkleSummary,
} from '../scoops/tray-sync-protocol.js';
import { LeaderTrayPeerManager } from '../scoops/tray-webrtc.js';
import type { AgentEvent } from './types.js';

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

  /** Tray attach runtime string. Default 'slicc-standalone'. */
  runtime?: string;
  /** Tray kind. Default omitted (desktop). */
  kind?: TrayKind;
  /**
   * Invoked once the leader tray is ready and the join URL is minted.
   * Used by hosted-leader mode to POST `/api/cloud-status`.
   */
  onLeaderReady?: (session: LeaderTraySession) => void;

  // --- LeaderSyncManager dependencies (flat callbacks) ---
  getMessages: LeaderSyncManagerOptions['getMessages'];
  getMessagesForScoop?: LeaderSyncManagerOptions['getMessagesForScoop'];
  getScoopJid: LeaderSyncManagerOptions['getScoopJid'];
  getScoops?: () => ScoopSummary[];
  getSprinkles?: () => SprinkleSummary[];
  readSprinkleContent?: LeaderSyncManagerOptions['readSprinkleContent'];
  onSprinkleLick?: LeaderSyncManagerOptions['onSprinkleLick'];
  onForwardedLick?: (event: LickEvent, originBootstrapId: string) => void;
  onFollowerMessage: LeaderSyncManagerOptions['onFollowerMessage'];
  onFollowerAbort: LeaderSyncManagerOptions['onFollowerAbort'];
  onFollowerNewSession?: LeaderSyncManagerOptions['onFollowerNewSession'];
  onFollowerCountChanged?: LeaderSyncManagerOptions['onFollowerCountChanged'];
  onRemoteTransportsCleaned?: LeaderSyncManagerOptions['onRemoteTransportsCleaned'];

  // --- Bridge hop to worker LickManager (replaces the pre-regression direct call) ---
  /**
   * Forward a tray `webhook.event` control message to the worker's
   * `LickManager`. Wired to `OffscreenClient.sendWebhookEvent` by the
   * caller. Fire-and-forget; no ack expected.
   */
  sendWebhookEvent: (webhookId: string, headers: Record<string, string>, body: unknown) => void;

  /**
   * Forward an inbound `cherry.host_event` (from a follower's embedded cherry
   * host page) to the worker's `LickManager` as a `'cherry'` lick. Wired to
   * `OffscreenClient.sendCherryHostEvent` by the caller. Fire-and-forget.
   */
  onCherryHostEvent?: LeaderSyncManagerOptions['onCherryHostEvent'];
  onPreviewLick?: LeaderSyncManagerOptions['onPreviewLick'];

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
   * Resolves with the {@link LeaderTraySession} once the leader has
   * connected to the tray worker. Rejects when `leader.start()` fails
   * (timeout, auth, network). Derived from the same `start()` call —
   * no double invocation. Boot-path consumers that ignore `ready` see
   * unchanged behavior: the existing `.catch(log.error)` fires on a
   * separate branch, preventing unhandled rejections.
   */
  readonly ready: Promise<LeaderTraySession>;
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
  /**
   * Live accessor for the leader sync that cross-thread callers (the
   * worker `serve` command bridging through the `tray-open-preview`
   * panel-RPC op) consult to broadcast `preview.open` after a mint.
   * `null` after the handle is stopped. Mirrors the same pattern that
   * `PageFollowerTrayHandle.currentSync` provides so callers don't
   * snapshot the binding at construction time.
   */
  readonly currentLeaderSync: LeaderSyncManager | null;
}

/** --- Sync manager (top of the dependency chain — peers feeds it) --- */
function buildSyncManager(
  options: StartPageLeaderTrayOptions,
  getLeader: () => LeaderTrayManager
): LeaderSyncManager {
  const syncOptions: LeaderSyncManagerOptions = {
    sendControl: (msg) => getLeader().sendControlMessage(msg),
    getMessages: options.getMessages,
    getMessagesForScoop: options.getMessagesForScoop,
    getScoopJid: options.getScoopJid,
    getScoops: options.getScoops,
    getSprinkles: options.getSprinkles,
    readSprinkleContent: options.readSprinkleContent,
    onSprinkleLick: options.onSprinkleLick,
    onForwardedLick: options.onForwardedLick,
    onFollowerMessage: options.onFollowerMessage,
    onFollowerAbort: options.onFollowerAbort,
    onFollowerNewSession: options.onFollowerNewSession,
    onFollowerCountChanged: options.onFollowerCountChanged,
    onRemoteTransportsCleaned: options.onRemoteTransportsCleaned,
    onCherryHostEvent: options.onCherryHostEvent,
    onPreviewLick: options.onPreviewLick,
    browserAPI: options.browserAPI,
    browserTransport: options.browserTransport,
    vfs: options.vfs,
  };
  return new LeaderSyncManager(syncOptions);
}

/**
 * --- Peer manager: routes signaling through the leader tray and hands open
 * data channels to the sync manager. `getLeader` is a forward-reference
 * getter because the leader manager is constructed AFTER the peer manager
 * (each references the other by closure, exactly like the pre-regression
 * `main.ts` code did).
 */
function buildPeerManager(
  getLeader: () => LeaderTrayManager,
  sync: LeaderSyncManager
): LeaderTrayPeerManager {
  return new LeaderTrayPeerManager({
    sendControlMessage: (message) => getLeader().sendControlMessage(message),
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
}

/**
 * --- Tray manager: WebSocket liaison + control-message dispatcher. Webhook
 * events relay through the bridge to the worker's LickManager; bridge.* messages
 * route to the sync manager; everything else is signaling for the peer manager.
 */
function buildLeaderManager(
  options: StartPageLeaderTrayOptions,
  peers: LeaderTrayPeerManager,
  sync: LeaderSyncManager,
  fetchImpl: typeof fetch,
  updateUrlBar: (session: LeaderTraySession) => void,
  getLeader: () => LeaderTrayManager
): LeaderTrayManager {
  /** Push the leader's tray joinUrl — or `null` once the tray is gone — to the
   *  SW so the cherry side panel can (dis)connect its follower. Extension bridge
   *  only; a no-op on transports without `sendLeaderJoinUrl`. */
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
        options.sendWebhookEvent(message.webhookId, message.headers, message.body);
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
        // `error`, not `warn` — peer-manager dispatch failures mean a
        // tray signaling/bootstrap envelope could not be applied; the
        // user sees a follower never showing up, with no surface signal
        // otherwise. Prod log gate is ERROR (`logger.ts`), so `warn`
        // would be invisible.
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
      // `error`, not `warn` — sustained reconnect failure is the
      // terminal state of the retry loop; followers will silently fail
      // to connect from this point forward until the user reloads or
      // resets the tray. The prod log gate is ERROR, so a `warn` here
      // would be invisible to operators investigating "where did my
      // tray go".
      log.error('Leader tray reconnect gave up', { lastError, attempts });
      pushJoinUrlToSw(null);
    },
  });
}

/**
 * Browser targets refresher: poll local CDP for the leader's open pages and
 * push them into the sync manager as the leader's local targets. The
 * throttle is keyed to CDP listing only — broadcast failures (the second
 * try block below) are their own surface and shouldn't be conflated with
 * "CDP refresh failed". See `scoops/throttled-error-tracker.ts` for the
 * full throttle/recovery contract.
 */
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
      const targets: RemoteTargetInfo[] = pages.map((p) => ({
        targetId: p.targetId,
        title: p.title,
        url: p.url,
      }));
      sync.setLocalTargets(targets);
    } catch (err) {
      // Distinct from the CDP-failure path above so the message
      // doesn't lie. A broadcast error doesn't mean CDP is broken.
      log.error('Leader target broadcast failed (sync.setLocalTargets threw)', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };
}

/**
 * Scoops + sprinkles lists: re-broadcast so followers stay in sync as the
 * leader adds, drops, or activates scoops / sprinkles.
 */
function scheduleListBroadcasts(
  sync: LeaderSyncManager,
  refreshIntervalMs: number
): ReturnType<typeof setInterval> {
  return setInterval(() => {
    try {
      sync.broadcastScoopsList();
      sync.broadcastSprinklesList();
    } catch (err) {
      // `error`, not `warn` — the prod default log level is ERROR
      // (`logger.ts`), so `warn` would also be suppressed. The inner
      // broadcast methods have their own narrow catches around user
      // callbacks (e.g. `getSprinkles`); anything reaching this outer
      // catch is unexpected and an `error`-grade signal. Sustained
      // failures otherwise leave followers staring at stale scoop /
      // sprinkle lists for the entire session with no log signal.
      log.error('Failed to broadcast follower lists', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }, refreshIntervalMs);
}

/**
 * Update the URL bar with the tray join URL after successful connection, so
 * reloads attach to the same session.
 */
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

  // Forward declaration so the peer manager can call `leader.sendControlMessage`
  // through the getter closure; the leader is constructed bottom-up after peers.
  let leader!: LeaderTrayManager;
  const updateUrlBar = createUpdateUrlBar(options);

  // Forward declaration so sync can call leader.sendControlMessage through the getter
  const sync = buildSyncManager(options, () => leader);
  options.browserAPI.setTrayTargetProvider(sync);
  const peers = buildPeerManager(() => leader, sync);
  leader = buildLeaderManager(options, peers, sync, fetchImpl, updateUrlBar, () => leader);

  // --- Agent event tap → broadcast to all followers. The helper owns
  // this subscription (and unsubscribes on stop) so the caller doesn't
  // have to track it.
  const unsubscribeAgent = options.onAgentEvent((event) => sync.broadcastEvent(event));

  // --- Periodic refreshes. Each fires every `refreshIntervalMs` (5s
  // default) so a single missed update on the data channel doesn't
  // leave the follower's view permanently stale.
  const intervals: ReturnType<typeof setInterval>[] = [];
  const refreshLeaderTargets = createRefreshLeaderTargets(options, sync);
  intervals.push(setInterval(refreshLeaderTargets, refreshIntervalMs));
  void refreshLeaderTargets();
  intervals.push(scheduleListBroadcasts(sync, refreshIntervalMs));

  // Kick off the leader connection. The promise is shared between the
  // `ready` handle field (for callers that need to await connection) and
  // a fire-and-forget branch that logs failures so boot-path consumers
  // that ignore `ready` see unchanged behavior (no unhandled rejection).
  const startResult = leader.start();
  void startResult.then(updateUrlBar).catch((err) => {
    // `error`, not `warn` — initial leader-tray start failure means
    // multi-browser sync never came up at all. Prod log gate is ERROR,
    // so a `warn` here would leave operators with no signal that the
    // user's tray-leader configuration silently failed to activate.
    log.error('Leader tray start failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  });

  let stopped = false;
  return {
    ready: startResult,
    stop() {
      stopped = true;
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
    get currentLeaderSync(): LeaderSyncManager | null {
      return stopped ? null : sync;
    },
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
