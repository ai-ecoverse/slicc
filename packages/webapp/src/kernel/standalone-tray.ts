/**
 * `standalone-tray.ts` — leader tray boot for the standalone kernel worker.
 *
 * Extracted from `kernel-worker.ts` so the boot logic can be unit-tested
 * without running a real DedicatedWorker. The kernel worker calls
 * `startStandaloneLeaderTray` after `createKernelHost` when the
 * localStorage shim carries a tray-worker-base-url and no join URL
 * (join URL presence means this instance is a follower, handled
 * separately).
 *
 * This module deliberately has NO DOM or Worker-global dependencies so
 * Vitest can import it in the Node test environment.
 */

import { LeaderTrayManager } from '../scoops/tray-leader.js';
import type {
  LeaderTraySessionStore,
  LeaderTrayWebSocket,
  LeaderTrayManagerOptions,
} from '../scoops/tray-leader.js';
import { LeaderTrayPeerManager } from '../scoops/tray-webrtc.js';
import type { LickManager } from '../scoops/lick-manager.js';

export interface StandaloneLeaderTrayOptions {
  workerBaseUrl: string;
  lickManager: LickManager;
  /** Override fetch — defaults to globalThis.fetch (worker-safe; no window ref). */
  fetchImpl?: typeof fetch;
  /** @internal Test hook: override the session store. */
  _storeOverride?: LeaderTraySessionStore;
  /** @internal Test hook: override the WebSocket factory. */
  _webSocketFactory?: (url: string) => LeaderTrayWebSocket;
  /**
   * @internal Test hook: intercept the onControlMessage callback.
   * Called with the callback so tests can invoke it directly.
   */
  _onControlMessage?: (cb: LeaderTrayManagerOptions['onControlMessage']) => void;
}

export interface StandaloneLeaderTrayHandle {
  stop(): void;
  /** Exposed for testing. */
  readonly leader: LeaderTrayManager;
  readonly peers: LeaderTrayPeerManager;
}

/**
 * Create and start a leader tray manager pair for the standalone worker float.
 *
 * The `LeaderTrayManager` connects to the Cloudflare tray worker and
 * transitions `leaderTrayRuntimeStatus` from 'inactive' → 'connecting'
 * → 'leader'. The existing `subscribeToLeaderTrayRuntimeStatus` wired
 * in `createKernelHost` (host.ts:285) automatically propagates each
 * status change to the page via `bridge.emitTrayRuntimeStatus()`, so
 * the avatar-popover "Enable multi-browser sync" section appears once
 * the leader session is established.
 *
 * `LeaderTrayPeerManager` accepts incoming follower WebRTC connections
 * forwarded as control messages from the tray worker.
 */
export function startStandaloneLeaderTray(
  options: StandaloneLeaderTrayOptions
): StandaloneLeaderTrayHandle {
  const { workerBaseUrl, lickManager } = options;
  // Plain fetch is correct here: tray worker URLs are always cross-origin
  // external endpoints that don't need the CLI fetch proxy. createTrayFetch()
  // references window.location.origin which is unavailable in DedicatedWorker.
  const fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));

  let leader!: LeaderTrayManager;

  const peers = new LeaderTrayPeerManager({
    sendControlMessage: (message) => leader.sendControlMessage(message),
    onPeerConnected: (peer, _channel) => {
      console.info('[standalone-tray] follower data channel opened', {
        controllerId: peer.controllerId,
        bootstrapId: peer.bootstrapId,
        attempt: peer.attempt,
      });
    },
  });

  const onControlMessage: LeaderTrayManagerOptions['onControlMessage'] = (message) => {
    if (message.type === 'webhook.event') {
      lickManager.handleWebhookEvent(message.webhookId, message.headers, message.body);
      return;
    }
    void peers.handleControlMessage(message).catch((err) => {
      console.warn('[standalone-tray] leader bootstrap handling failed', err);
    });
  };
  options._onControlMessage?.(onControlMessage);

  leader = new LeaderTrayManager({
    workerBaseUrl,
    runtime: 'slicc-standalone-worker',
    fetchImpl,
    ...(options._storeOverride ? { store: options._storeOverride } : {}),
    ...(options._webSocketFactory ? { webSocketFactory: options._webSocketFactory } : {}),
    onControlMessage,
    onReconnecting: (attempt, lastError) => {
      console.info('[standalone-tray] leader tray reconnecting', { attempt, lastError });
    },
    onReconnected: (session) => {
      console.info('[standalone-tray] leader tray reconnected', { trayId: session.trayId });
    },
    onReconnectGaveUp: (lastError, attempts) => {
      console.warn('[standalone-tray] leader tray reconnect gave up', { lastError, attempts });
    },
  });

  void leader.start().catch((err) => {
    console.warn('[standalone-tray] leader tray start failed', err);
  });

  return {
    stop() {
      peers.stop();
      leader.stop();
    },
    leader,
    peers,
  };
}
