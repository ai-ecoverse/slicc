/**
 * Offscreen document entry point — bootstraps the SLICC agent engine.
 *
 * This runs in a Chrome offscreen document (long-lived extension page)
 * so the agent survives side panel close/reopen cycles.
 *
 * The shared boot sequence (Orchestrator construction, bridge binding,
 * tray-runtime subscriptions, agent-bridge publish, session-costs
 * provider, LickManager init + lick→cone routing, mount recovery,
 * cone bootstrap, upgrade detection, BshWatchdog) lives in
 * `packages/webapp/src/kernel/host.ts`'s `createKernelHost`. This file
 * is responsible only for the extension-specific bits:
 *
 *   - CDP transport / `BrowserAPI` construction (chrome.debugger via the
 *     service worker).
 *   - chrome.runtime listeners for `agent-spawn-request`,
 *     `get-session-costs`, `navigate-lick`, `refresh-tray-runtime`.
 *   - BroadcastChannel bridges for the side panel:
 *     `startLickManagerHost`, `createSprinkleManagerProxy`, the
 *     `.shtml` watcher relay.
 *   - Tray-runtime sync (uses `window.localStorage`).
 *   - Initial `offscreen-ready` + `state-snapshot` emissions over
 *     `chrome.runtime.sendMessage`.
 */

import { BrowserAPI, OffscreenCdpProxy } from '../../../packages/webapp/src/cdp/index.js';
import { createKernelHost } from '../../../packages/webapp/src/kernel/host.js';
import { createPanelTerminalHost } from '../../../packages/webapp/src/kernel/panel-terminal-host.js';
import { createOffscreenChromeRuntimeTransport } from '../../../packages/webapp/src/kernel/transport-chrome-runtime.js';
import {
  AGENT_SPAWN_REQUEST_TYPE,
  type AgentSpawnOptions,
  type AgentSpawnResult,
} from '../../../packages/webapp/src/scoops/agent-bridge.js';
import { LeaderTrayManager } from '../../../packages/webapp/src/scoops/tray-leader.js';
import {
  DEFAULT_PRODUCTION_TRAY_WORKER_BASE_URL,
  DEFAULT_STAGING_TRAY_WORKER_BASE_URL,
  hasStoredTrayJoinUrl,
  resolveTrayRuntimeConfig,
  TRAY_JOIN_STORAGE_KEY,
  TRAY_WORKER_STORAGE_KEY,
} from '../../../packages/webapp/src/scoops/tray-runtime-config.js';
import {
  FollowerTrayManager,
  LeaderTrayPeerManager,
  startFollowerWithAutoReconnect,
} from '../../../packages/webapp/src/scoops/tray-webrtc.js';
import { FollowerSyncManager } from '../../../packages/webapp/src/scoops/tray-follower-sync.js';
import { OffscreenBridge } from './offscreen-bridge.js';
import { ServiceWorkerLeaderTraySocket } from './tray-socket-proxy.js';
import { createLogger } from '../../../packages/webapp/src/core/index.js';
import type { ExtensionMessage } from './messages.js';
import { getApiKey } from '../../../packages/webapp/src/ui/provider-settings.js';

// Auto-discover and register all providers (built-in + external).
// IMPORTANT: Keep in sync with packages/webapp/src/ui/main.ts — both
// entry points need all providers. Registration is explicit (not
// side-effect import) to break a module-cycle that hit TDZ in the
// kernel worker; the offscreen entry awaits `registerProviders()` in
// `init()`.
import { registerProviders } from '../../../packages/webapp/src/providers/index.js';

const log = createLogger('offscreen');

function isExtensionMessage(message: unknown): message is ExtensionMessage {
  return (
    typeof message === 'object' && message !== null && 'source' in message && 'payload' in message
  );
}

// Use console.log directly for critical diagnostics (visible in chrome://extensions inspect)
console.log('[slicc-offscreen] Script loaded');

async function init(): Promise<void> {
  console.log('[slicc-offscreen] init() starting...');

  // Register providers BEFORE the kernel host — the host's
  // construction reaches into the provider registry via
  // scoop-context → provider-settings.
  await registerProviders();

  // Create CDP transport that proxies through the service worker
  const cdpProxy = new OffscreenCdpProxy();
  await cdpProxy.connect();
  console.log('[slicc-offscreen] CDP proxy connected');

  const browser = new BrowserAPI(cdpProxy);

  // Construct the chrome.runtime transport up front so the bridge AND
  // the terminal-session host share the same wire. The transport's
  // `onMessage` adapter installs a fresh chrome.runtime listener per
  // call; chrome.runtime supports multiple listeners, so each consumer
  // (bridge, terminal host) gets every envelope and filters
  // independently.
  const bridgeTransport =
    createOffscreenChromeRuntimeTransport<import('./messages.js').OffscreenToPanelMessage>();
  const bridge = new OffscreenBridge(bridgeTransport);
  const callbacks = OffscreenBridge.createCallbacks(bridge);

  // Skip cone auto-create when joining a tray without a configured
  // provider — a cone with no API key would dead-end. The factory's
  // `skipConeBootstrap` honors this decision.
  const allowProviderlessTrayJoin = !getApiKey() && hasStoredTrayJoinUrl(window.localStorage);
  if (allowProviderlessTrayJoin) {
    console.log(
      '[slicc-offscreen] Skipping cone auto-create while joining a tray without a configured provider'
    );
  }

  const host = await createKernelHost({
    container: document.body,
    browser,
    bridge,
    callbacks,
    skipConeBootstrap: allowProviderlessTrayJoin,
    logger: log,
  });
  const { orchestrator, lickManager } = host;
  console.log('[slicc-offscreen] Kernel host ready, scoops:', orchestrator.getScoops().length);

  // Stand up the terminal-RPC host on the same kernel transport — the
  // panel's `RemoteTerminalView` opens sessions here so panel-typed
  // commands hit the same `ProcessManager` and `/proc` view as the
  // agent's bash tool. Shared `createPanelTerminalHost` factory pins
  // parity with the standalone DedicatedWorker path (`kernel-worker.ts`):
  // both pass `processManager: host.processManager` into
  // `TerminalSessionHost` AND the per-session `WasmShellHeadless`, so
  // `ps` / `kill` / `cat /proc/<pid>/...` work uniformly.
  let stopTerminalHost: (() => void) | null = null;
  const sharedFs = host.sharedFs;
  if (sharedFs) {
    const handle = createPanelTerminalHost({
      transport: bridgeTransport,
      fs: sharedFs,
      browser,
      processManager: host.processManager,
      logger: log,
    });
    stopTerminalHost = handle.stop;
  } else {
    log.warn('shared FS unavailable; panel terminal sessions will fail to open');
  }

  // Tear down the terminal host when the offscreen document unloads.
  // MV3 normally kills the offscreen page abruptly, but graceful
  // teardown lets the close-on-reload path drop chrome.runtime
  // listeners cleanly during dev reloads.
  window.addEventListener(
    'beforeunload',
    () => {
      stopTerminalHost?.();
      stopTerminalHost = null;
      void host.dispose();
    },
    { once: true }
  );

  // ── Extension-only: chrome.runtime listeners ───────────────────────

  // Route agent-spawn requests from the side-panel proxy
  // (see publishAgentBridgeProxy) into this realm's real bridge.
  chrome.runtime.onMessage.addListener(
    (message: unknown, _sender, sendResponse: (response: unknown) => void) => {
      if (!isExtensionMessage(message)) return false;
      if (message.source !== 'panel') return false;
      const payload = message.payload as { type: string; options?: AgentSpawnOptions };
      if (payload.type !== AGENT_SPAWN_REQUEST_TYPE) return false;

      const options = payload.options;
      if (!options) {
        sendResponse({ ok: false, error: 'agent-spawn-request: missing options' });
        return true;
      }

      const agentBridge = (globalThis as Record<string, unknown>).__slicc_agent as
        | { spawn: (opts: AgentSpawnOptions) => Promise<AgentSpawnResult> }
        | undefined;
      if (!agentBridge || typeof agentBridge.spawn !== 'function') {
        sendResponse({ ok: false, error: 'agent-spawn-request: bridge not published' });
        return true;
      }

      agentBridge
        .spawn(options)
        .then((result) => sendResponse({ ok: true, result }))
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          sendResponse({ ok: false, error: msg });
        });
      return true; // keep the message channel open for the async response
    }
  );

  // Handle cost data requests from the side panel shell
  chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
    if (
      typeof message === 'object' &&
      message !== null &&
      'source' in message &&
      'payload' in message
    ) {
      const msg = message as { source: string; payload: { type: string } };
      if (msg.source === 'panel' && msg.payload?.type === 'get-session-costs') {
        try {
          const costs = orchestrator.getSessionCosts();
          sendResponse({ ok: true, costs });
        } catch (error) {
          sendResponse({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        return true; // Keep message channel open for sendResponse
      }
    }
    return false;
  });

  // Start BroadcastChannel host so the side panel terminal can proxy crontask ops
  const { startLickManagerHost } = await import('./lick-manager-proxy.js');
  startLickManagerHost(lickManager);
  console.log('[slicc-offscreen] LickManager BroadcastChannel host started');

  // Listen for navigate-lick events forwarded from the service worker's
  // chrome.webRequest observer and emit them as lick events.
  chrome.runtime.onMessage.addListener((message: unknown) => {
    if (!isExtensionMessage(message) || message.source !== 'service-worker') return false;
    const payload = message.payload as { type?: string };
    if (payload?.type !== 'navigate-lick') return false;
    const navMsg = payload as import('./messages.js').NavigateLickMsg;
    lickManager.emitEvent({
      type: 'navigate',
      navigateUrl: navMsg.url,
      targetScoop: undefined,
      timestamp: new Date().toISOString(),
      body: {
        url: navMsg.url,
        sliccHeader: navMsg.sliccHeader,
        title: navMsg.title,
      },
    });
    return false;
  });

  // ── Tray-runtime sync (uses window.localStorage; extension-flavored) ──

  let stopTrayRuntime: (() => void) | null = null;
  let activeTrayRuntimeKey: string | null = null;

  const syncTrayRuntime = async (): Promise<void> => {
    const trayRuntimeConfig = await resolveTrayRuntimeConfig({
      locationHref: window.location.href,
      storage: window.localStorage,
      envBaseUrl: import.meta.env.VITE_WORKER_BASE_URL ?? null,
      defaultWorkerBaseUrl: __DEV__
        ? DEFAULT_STAGING_TRAY_WORKER_BASE_URL
        : DEFAULT_PRODUCTION_TRAY_WORKER_BASE_URL,
    });
    const nextTrayRuntimeKey = JSON.stringify(trayRuntimeConfig);
    if (nextTrayRuntimeKey === activeTrayRuntimeKey) {
      return;
    }

    stopTrayRuntime?.();
    stopTrayRuntime = null;
    activeTrayRuntimeKey = nextTrayRuntimeKey;

    if (trayRuntimeConfig?.joinUrl) {
      let activeSync: FollowerSyncManager | null = null;
      let targetRefreshInterval: ReturnType<typeof setInterval> | null = null;
      const detachSync = () => {
        if (targetRefreshInterval) {
          clearInterval(targetRefreshInterval);
          targetRefreshInterval = null;
        }
        if (!activeSync) return;
        bridge.setFollowerSync(null);
        browser.setTrayTargetProvider(null);
        activeSync.close();
        activeSync = null;
      };

      const reconnectHandle = startFollowerWithAutoReconnect(
        {
          joinUrl: trayRuntimeConfig.joinUrl,
          runtime: 'slicc-extension-offscreen',
        },
        {
          onConnected: (connection) => {
            log.info('Extension follower connected', { trayId: connection.trayId });
            detachSync();
            const runtimeId = `follower-${connection.bootstrapId}`;
            const sync: FollowerSyncManager = new FollowerSyncManager(connection.channel, {
              browserTransport: browser.getTransport(),
              browserAPI: browser,
              onSnapshot: (messages) => bridge.applyFollowerSnapshot(messages),
              onUserMessage: (text, messageId) =>
                bridge.emitFollowerIncomingMessage(messageId, text),
              onStatus: (scoopStatus) => bridge.emitFollowerStatus(scoopStatus),
              onTargetsChanged: () => void refreshTargets(),
              onDisconnect: (reason) => {
                log.warn('Follower sync disconnected', { reason });
                detachSync();
              },
            });
            const refreshTargets = async () => {
              try {
                const pages = await browser.listPages();
                // Bail if a reconnect swapped activeSync while listPages was in
                // flight — otherwise we'd advertise this connection's runtimeId
                // against the new sync (or vice versa), polluting the registry.
                if (activeSync !== sync) return;
                sync.advertiseTargets(
                  pages.map((p) => ({ targetId: p.targetId, title: p.title, url: p.url })),
                  runtimeId
                );
              } catch {
                /* ignore — best-effort target advertisement */
              }
            };
            sync.onEvent((event) => bridge.emitFollowerAgentEvent(event));
            activeSync = sync;
            browser.setTrayTargetProvider(sync);
            bridge.setFollowerSync(sync);
            sync.requestSnapshot();
            targetRefreshInterval = setInterval(() => void refreshTargets(), 5000);
            void refreshTargets();
          },
          onGaveUp: (lastError) => {
            log.warn('Extension follower reconnect gave up', { lastError });
            detachSync();
          },
        }
      );
      stopTrayRuntime = () => {
        detachSync();
        reconnectHandle.cancel();
      };
      return;
    }

    if (trayRuntimeConfig?.workerBaseUrl) {
      let trayLeader!: LeaderTrayManager;
      const trayPeers = new LeaderTrayPeerManager({
        sendControlMessage: (message) => trayLeader.sendControlMessage(message),
        onPeerConnected: (peer) => {
          log.info('Tray follower data channel opened', {
            controllerId: peer.controllerId,
            bootstrapId: peer.bootstrapId,
            attempt: peer.attempt,
          });
        },
      });
      trayLeader = new LeaderTrayManager({
        workerBaseUrl: trayRuntimeConfig.workerBaseUrl,
        runtime: 'slicc-extension-offscreen',
        webSocketFactory: (url) => new ServiceWorkerLeaderTraySocket(url),
        onControlMessage: (message) => {
          void trayPeers.handleControlMessage(message).catch((error) => {
            log.warn('Tray leader bootstrap handling failed', {
              error: error instanceof Error ? error.message : String(error),
            });
          });
        },
        onReconnecting: (attempt, lastError) => {
          log.info('Extension leader tray reconnecting', { attempt, lastError });
        },
        onReconnected: (session) => {
          log.info('Extension leader tray reconnected', { trayId: session.trayId });
        },
        onReconnectGaveUp: (lastError, attempts) => {
          log.warn('Extension leader tray reconnect gave up', { lastError, attempts });
        },
      });
      void trayLeader.start().catch((error) => {
        log.warn('Leader tray join failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
      stopTrayRuntime = () => {
        trayPeers.stop();
        trayLeader.stop();
      };
    }
  };

  await syncTrayRuntime();
  chrome.runtime.onMessage.addListener((message: unknown) => {
    if (!isExtensionMessage(message) || message.source !== 'panel') {
      return false;
    }
    if (message.payload.type !== 'refresh-tray-runtime') {
      return false;
    }
    // Mirror the panel's localStorage values into ours: in MV3 the side
    // panel and the offscreen document are independent contexts with
    // separate localStorage instances, so a join URL the user pasted in
    // the panel is invisible to `resolveTrayRuntimeConfig` here unless
    // we persist it locally first.
    const { joinUrl, workerBaseUrl } = message.payload;
    if (typeof joinUrl === 'string' && joinUrl) {
      window.localStorage.setItem(TRAY_JOIN_STORAGE_KEY, joinUrl);
    } else if (joinUrl === null) {
      window.localStorage.removeItem(TRAY_JOIN_STORAGE_KEY);
    }
    if (typeof workerBaseUrl === 'string' && workerBaseUrl) {
      window.localStorage.setItem(TRAY_WORKER_STORAGE_KEY, workerBaseUrl);
    } else if (workerBaseUrl === null && joinUrl === null) {
      window.localStorage.removeItem(TRAY_WORKER_STORAGE_KEY);
    }
    void syncTrayRuntime();
    return false;
  });

  // Signal readiness to any connected panels + send initial state
  chrome.runtime
    .sendMessage({
      source: 'offscreen' as const,
      payload: { type: 'offscreen-ready' },
    })
    .catch(() => {
      /* no panel yet */
    });

  const snapshot = bridge.buildStateSnapshot();
  chrome.runtime
    .sendMessage({
      source: 'offscreen' as const,
      payload: snapshot,
    })
    .catch(() => {
      /* no panel yet */
    });

  // Set up sprinkle manager proxy so the `sprinkle` shell command works from scoops.
  // The real SprinkleManager runs in the side panel (needs DOM). This proxy relays
  // operations via BroadcastChannel.
  const { createSprinkleManagerProxy } = await import('./sprinkle-proxy.js');
  const sprinkleManagerProxy = createSprinkleManagerProxy();
  (globalThis as unknown as Record<string, unknown>).__slicc_sprinkleManager = sprinkleManagerProxy;

  // Relay .shtml file changes from the offscreen FS to the panel
  // SprinkleManager. The panel's localFs is a separate VirtualFS
  // instance over the same IndexedDB, so its in-memory watcher
  // can't see writes made by the agent's bash tool here. Bridge
  // them via the sprinkle proxy: when offscreen sees a new/changed
  // .shtml, ask the panel to refresh + auto-open. Debounced to
  // coalesce bursty installs.
  {
    const offscreenWatcher = host.sharedFs?.getWatcher();
    if (offscreenWatcher) {
      let timer: ReturnType<typeof setTimeout> | null = null;
      offscreenWatcher.watch(
        '/',
        (path) => path.endsWith('.shtml'),
        () => {
          if (timer) return;
          timer = setTimeout(() => {
            timer = null;
            void sprinkleManagerProxy.openNewAutoOpenSprinkles().catch(() => {});
          }, 150);
        }
      );
    }
  }

  // Tear down host + tray runtime on offscreen unload.
  window.addEventListener(
    'beforeunload',
    () => {
      stopTrayRuntime?.();
      void host.dispose();
    },
    { once: true }
  );

  console.log('[slicc-offscreen] Agent engine ready, scoops:', orchestrator.getScoops().length);
}

init().catch((err) => {
  console.error('[slicc-offscreen] Init FAILED:', err);
  log.error('Offscreen init failed', err);
});
