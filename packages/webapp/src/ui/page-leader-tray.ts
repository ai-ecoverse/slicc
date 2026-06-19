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
    onForwardedLick: options.onForwardedLick,
    onFollowerMessage: options.onFollowerMessage,
    onFollowerAbort: options.onFollowerAbort,
    onFollowerCountChanged: options.onFollowerCountChanged,
    onRemoteTransportsCleaned: options.onRemoteTransportsCleaned,
    onCherryHostEvent: options.onCherryHostEvent,
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
    runtime: options.runtime ?? 'slicc-standalone',
    ...(options.kind ? { kind: options.kind } : {}),
    ...(options.onLeaderReady ? { onLeaderReady: options.onLeaderReady } : {}),
    fetchImpl,
    ...(options._storeOverride ? { store: options._storeOverride } : {}),
    ...(options._webSocketFactory ? { webSocketFactory: options._webSocketFactory } : {}),
    onControlMessage: (message) => {
      if (message.type === 'webhook.event') {
        options.sendWebhookEvent(message.webhookId, message.headers, message.body);
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
    },
    onReconnectGaveUp: (lastError, attempts) => {
      // `error`, not `warn` — sustained reconnect failure is the
      // terminal state of the retry loop; followers will silently fail
      // to connect from this point forward until the user reloads or
      // resets the tray. The prod log gate is ERROR, so a `warn` here
      // would be invisible to operators investigating "where did my
      // tray go".
      log.error('Leader tray reconnect gave up', { lastError, attempts });
    },
  });

  // --- Agent event tap → broadcast to all followers. The helper owns
  // this subscription (and unsubscribes on stop) so the caller doesn't
  // have to track it.
  const unsubscribeAgent = options.onAgentEvent((event) => sync.broadcastEvent(event));

  // --- Periodic refreshes. Each fires every `refreshIntervalMs` (5s
  // default) so a single missed update on the data channel doesn't
  // leave the follower's view permanently stale.
  const intervals: ReturnType<typeof setInterval>[] = [];

  // Browser targets: poll local CDP for the leader's open pages and
  // push them into the sync manager as the leader's local targets.
  // The throttle is keyed to CDP listing only — broadcast failures
  // (the second try block below) are their own surface and shouldn't
  // be conflated with "CDP refresh failed". See
  // `scoops/throttled-error-tracker.ts` for the full throttle/recovery
  // contract.
  const cdpThrottle = new ThrottledErrorTracker(log, {
    failureMessage: 'Leader CDP target refresh failed (best-effort, throttled)',
    recoveryMessage: 'Leader CDP target refresh recovered (stable for debounce window)',
  });
  const refreshLeaderTargets = async () => {
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
      // `error`, not `warn` — initial leader-tray start failure means
      // multi-browser sync never came up at all. Prod log gate is ERROR,
      // so a `warn` here would leave operators with no signal that the
      // user's tray-leader configuration silently failed to activate.
      log.error('Leader tray start failed', {
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
