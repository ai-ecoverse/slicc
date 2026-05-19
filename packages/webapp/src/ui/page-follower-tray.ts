/**
 * `page-follower-tray.ts` — page-side boot wiring for the multi-browser
 * sync follower role.
 *
 * Mirror of {@link startPageLeaderTray} for the joining browser. When the
 * user opens a join URL (or has one stored in `tray-join-storage-key`
 * localStorage), this helper:
 *
 *   1. Starts a `FollowerTrayManager` with automatic reconnect (via
 *      `startFollowerWithAutoReconnect`) that establishes the WebRTC
 *      data channel to the leader.
 *   2. On each successful connection, constructs a `FollowerSyncManager`
 *      that wraps the data channel and implements `AgentHandle`.
 *   3. Wires the follower sync into the page's chat panel as its agent
 *      handle, so user input from the chat goes to the leader's
 *      orchestrator instead of the local kernel-worker orchestrator.
 *   4. Periodically advertises the follower's local browser targets to
 *      the leader (every 5s by default) so the leader's federated CDP
 *      registry stays current.
 *
 * Like {@link startPageLeaderTray}, this module has no UI imports — the
 * caller wires every page-side dependency via flat callbacks.
 *
 * Spec: `docs/superpowers/specs/2026-05-17-multi-browser-sync-page-side-restoration.md`.
 */

import {
  startFollowerWithAutoReconnect,
  type FollowerAutoReconnectHandle,
  type FollowerTrayConnection,
  type TrayPeerConnectionFactory,
} from '../scoops/tray-webrtc.js';
import { FollowerSyncManager } from '../scoops/tray-follower-sync.js';
import type { AgentHandle, ChatMessage } from './types.js';
import type { MessageAttachment } from '../core/attachments.js';
import type { BrowserAPI } from '../cdp/browser-api.js';
import { createLogger } from '../core/logger.js';

const log = createLogger('page-follower-tray');

export interface StartPageFollowerTrayOptions {
  /** The leader's join URL (from `tray-join-storage-key` localStorage). */
  joinUrl: string;

  // --- FollowerSyncManager callbacks (forwarded directly) ---
  /** Replace the follower's chat panel with the snapshot from the leader. */
  onSnapshot: (messages: ChatMessage[], scoopJid: string) => void;
  /** Append a user message (local echo or another follower's) to the chat panel. */
  onUserMessage: (
    text: string,
    messageId: string,
    scoopJid: string,
    attachments?: MessageAttachment[]
  ) => void;
  /** Update the chat panel's processing indicator from the leader's scoop status. */
  onStatus: (scoopStatus: string) => void;

  // --- Page-side wiring callbacks ---
  /**
   * Install the freshly-constructed `FollowerSyncManager` as the chat
   * panel's agent handle. The follower sync implements `AgentHandle`, so
   * `chat.sendMessage` from the panel now forwards to the leader over
   * WebRTC instead of to the local orchestrator. Wired to
   * `layout.panels.chat.setAgent` by the caller.
   */
  setChatAgent: (agent: AgentHandle) => void;

  // --- BrowserAPI for federated target advertisement ---
  browserAPI: BrowserAPI;

  // --- Test hooks ---
  /** @internal Override fetch (defaults to plain `fetch`). */
  _fetchImpl?: typeof fetch;
  /** @internal Override the WebRTC peer-connection factory. */
  _peerConnectionFactory?: TrayPeerConnectionFactory;
  /** @internal Override the target-advertisement interval in ms (default 5000). */
  _refreshIntervalMs?: number;
  /** @internal Override the per-attempt sleep (used by reconnect backoff in tests). */
  _sleep?: (ms: number) => Promise<void>;
}

export interface PageFollowerTrayHandle {
  /**
   * Cancel the reconnect loop, close the active follower sync, and stop
   * advertising local targets.
   */
  stop(): void;
  /**
   * The currently-active follower sync, or `null` between connections
   * (initial connect pending or in the middle of a reconnect).
   * Exposed for testing.
   */
  readonly currentSync: FollowerSyncManager | null;
}

/**
 * Construct + start the follower tray subsystem on the page. Returns a
 * handle that the caller can hold for shutdown.
 *
 * Caller is responsible for gating on `joinUrl` presence — when no join
 * URL is stored, this helper is not invoked at all (the leader path runs
 * via {@link startPageLeaderTray} instead).
 */
export function startPageFollowerTray(
  options: StartPageFollowerTrayOptions
): PageFollowerTrayHandle {
  const refreshIntervalMs = options._refreshIntervalMs ?? 5000;

  let activeSync: FollowerSyncManager | null = null;
  let targetRefreshInterval: ReturnType<typeof setInterval> | null = null;
  let reconnectHandle: FollowerAutoReconnectHandle | null = null;

  const detachSync = (): void => {
    if (targetRefreshInterval) {
      clearInterval(targetRefreshInterval);
      targetRefreshInterval = null;
    }
    if (!activeSync) return;
    options.browserAPI.setTrayTargetProvider(null);
    activeSync.close();
    activeSync = null;
  };

  const wireFollowerSync = (connection: FollowerTrayConnection): void => {
    detachSync();
    const runtimeId = `follower-${connection.bootstrapId}`;
    const sync = new FollowerSyncManager(connection.channel, {
      browserTransport: options.browserAPI.getTransport(),
      browserAPI: options.browserAPI,
      onSnapshot: options.onSnapshot,
      onUserMessage: options.onUserMessage,
      onStatus: options.onStatus,
      onTargetsChanged: () => void refreshTargets(),
      onDisconnect: (reason) => {
        log.warn('Follower sync disconnected', { reason });
        detachSync();
      },
    });

    const refreshTargets = async (): Promise<void> => {
      try {
        const pages = await options.browserAPI.listPages();
        // A reconnect mid-flight may have swapped `activeSync` — bail in
        // that case so we don't advertise this connection's runtimeId
        // against the new sync (or vice versa).
        if (activeSync !== sync) return;
        sync.advertiseTargets(
          pages.map((p) => ({ targetId: p.targetId, title: p.title, url: p.url })),
          runtimeId
        );
      } catch {
        /* ignore — best-effort target advertisement */
      }
    };

    activeSync = sync;
    options.browserAPI.setTrayTargetProvider(sync);
    options.setChatAgent(sync);
    sync.requestSnapshot();

    targetRefreshInterval = setInterval(() => void refreshTargets(), refreshIntervalMs);
    void refreshTargets();

    log.info('Follower sync wired', { trayId: connection.trayId });
  };

  reconnectHandle = startFollowerWithAutoReconnect(
    {
      joinUrl: options.joinUrl,
      runtime: 'slicc-standalone',
      fetchImpl: options._fetchImpl,
      peerConnectionFactory: options._peerConnectionFactory,
      sleep: options._sleep,
    },
    {
      onConnected: wireFollowerSync,
      onReconnecting: (attempt) => {
        log.info('Follower reconnecting', { attempt });
      },
      onGaveUp: (lastError) => {
        log.warn('Follower reconnect gave up', { lastError });
        detachSync();
      },
      sleep: options._sleep,
    }
  );

  return {
    stop() {
      detachSync();
      reconnectHandle?.cancel();
      reconnectHandle = null;
    },
    get currentSync() {
      return activeSync;
    },
  };
}
