/**
 * Offscreen document entry point — bootstraps the SLICC agent engine.
 *
 * This runs in a Chrome offscreen document (long-lived extension page)
 * so the agent survives side panel close/reopen cycles.
 *
 * Initializes: Orchestrator, VFS, BrowserAPI (via CDP proxy), OffscreenBridge.
 */

import { BrowserAPI, OffscreenCdpProxy } from '../cdp/index.js';
import { Orchestrator } from '../scoops/index.js';
import { LeaderTrayManager } from '../scoops/tray-leader.js';
import { hasStoredTrayJoinUrl, resolveTrayRuntimeConfig } from '../scoops/tray-runtime-config.js';
import { FollowerTrayManager, LeaderTrayPeerManager } from '../scoops/tray-webrtc.js';
import { OffscreenBridge } from './offscreen-bridge.js';
import { ServiceWorkerLeaderTraySocket } from './tray-socket-proxy.js';
import { createLogger } from '../core/index.js';
import type { ExtensionMessage } from './messages.js';
import { getApiKey } from '../ui/provider-settings.js';

const log = createLogger('offscreen');

function isExtensionMessage(message: unknown): message is ExtensionMessage {
  return typeof message === 'object' && message !== null && 'source' in message && 'payload' in message;
}

// Use console.log directly for critical diagnostics (visible in chrome://extensions inspect)
console.log('[slicc-offscreen] Script loaded');

async function init(): Promise<void> {
  console.log('[slicc-offscreen] init() starting...');

  // Create CDP transport that proxies through the service worker
  const cdpProxy = new OffscreenCdpProxy();
  await cdpProxy.connect();
  console.log('[slicc-offscreen] CDP proxy connected');

  const browser = new BrowserAPI(cdpProxy);

  const container = document.body;

  const bridge = new OffscreenBridge();
  const callbacks = OffscreenBridge.createCallbacks(bridge);

  const orchestrator = new Orchestrator(
    container,
    {
      ...callbacks,
      getBrowserAPI: () => browser,
    },
  );

  // Bind the orchestrator to the bridge (sets up message listener + session store)
  // Pass BrowserAPI so the bridge can proxy panel CDP commands through the offscreen transport.
  await bridge.bind(orchestrator, browser);

  console.log('[slicc-offscreen] Orchestrator created, calling init()...');
  await orchestrator.init();
  console.log('[slicc-offscreen] Orchestrator initialized');

  // Ensure cone exists
  const allScoops = orchestrator.getScoops();
  const hasCone = allScoops.some(s => s.isCone);
  const allowProviderlessTrayJoin = !getApiKey() && hasStoredTrayJoinUrl(window.localStorage);
  if (allowProviderlessTrayJoin && !hasCone) {
    console.log('[slicc-offscreen] Skipping cone auto-create while joining a tray without a configured provider');
  } else if (!hasCone) {
    await orchestrator.registerScoop({
      jid: `cone_${Date.now()}`,
      name: 'Cone',
      folder: 'cone',
      isCone: true,
      type: 'cone',
      requiresTrigger: false,
      assistantLabel: 'sliccy',
      addedAt: new Date().toISOString(),
    });
    console.log('[slicc-offscreen] Created cone');
  }

  let stopTrayRuntime: (() => void) | null = null;
  let activeTrayRuntimeKey: string | null = null;

  const syncTrayRuntime = async (): Promise<void> => {
    const trayRuntimeConfig = await resolveTrayRuntimeConfig({
      locationHref: window.location.href,
      storage: window.localStorage,
      envBaseUrl: import.meta.env.VITE_WORKER_BASE_URL ?? null,
    });
    const nextTrayRuntimeKey = JSON.stringify(trayRuntimeConfig);
    if (nextTrayRuntimeKey === activeTrayRuntimeKey) {
      return;
    }

    stopTrayRuntime?.();
    stopTrayRuntime = null;
    activeTrayRuntimeKey = nextTrayRuntimeKey;

    if (trayRuntimeConfig?.joinUrl) {
      const trayFollower = new FollowerTrayManager({
        joinUrl: trayRuntimeConfig.joinUrl,
        runtime: 'slicc-extension-offscreen',
      });
      void trayFollower.start().catch((error) => {
        log.warn('Follower tray join failed', { error: error instanceof Error ? error.message : String(error) });
      });
      stopTrayRuntime = () => trayFollower.stop();
      return;
    }

    if (trayRuntimeConfig?.workerBaseUrl) {
      let trayLeader!: LeaderTrayManager;
      const trayPeers = new LeaderTrayPeerManager({
        sendControlMessage: message => trayLeader.sendControlMessage(message),
        onPeerConnected: peer => {
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
        webSocketFactory: url => new ServiceWorkerLeaderTraySocket(url),
        onControlMessage: message => {
          void trayPeers.handleControlMessage(message).catch((error) => {
            log.warn('Tray leader bootstrap handling failed', {
              error: error instanceof Error ? error.message : String(error),
            });
          });
        },
      });
      void trayLeader.start().catch((error) => {
        log.warn('Leader tray join failed', { error: error instanceof Error ? error.message : String(error) });
      });
      stopTrayRuntime = () => {
        trayPeers.stop();
        trayLeader.stop();
      };
    }
  };

  await syncTrayRuntime();
  window.addEventListener('beforeunload', () => stopTrayRuntime?.(), { once: true });
  chrome.runtime.onMessage.addListener((message: unknown) => {
    if (!isExtensionMessage(message) || message.source !== 'panel') {
      return false;
    }
    if (message.payload.type !== 'refresh-tray-runtime') {
      return false;
    }
    void syncTrayRuntime();
    return false;
  });

  // Signal readiness to any connected panels + send initial state
  chrome.runtime.sendMessage({
    source: 'offscreen' as const,
    payload: { type: 'offscreen-ready' },
  }).catch(() => { /* no panel yet */ });

  const snapshot = bridge.buildStateSnapshot();
  chrome.runtime.sendMessage({
    source: 'offscreen' as const,
    payload: snapshot,
  }).catch(() => { /* no panel yet */ });

  console.log('[slicc-offscreen] Agent engine ready, scoops:', orchestrator.getScoops().length);
}

init().catch((err) => {
  console.error('[slicc-offscreen] Init FAILED:', err);
  log.error('Offscreen init failed', err);
});
