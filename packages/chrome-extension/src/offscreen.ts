/**
 * Offscreen document entry point — bootstraps the SLICC agent engine.
 *
 * This runs in a Chrome offscreen document (long-lived extension page)
 * so the agent survives side panel close/reopen cycles.
 *
 * Initializes: Orchestrator, VFS, BrowserAPI (via CDP proxy), OffscreenBridge.
 */

import { BrowserAPI, OffscreenCdpProxy } from '../../../packages/webapp/src/cdp/index.js';
import { Orchestrator } from '../../../packages/webapp/src/scoops/index.js';
import { LeaderTrayManager } from '../../../packages/webapp/src/scoops/tray-leader.js';
import {
  hasStoredTrayJoinUrl,
  resolveTrayRuntimeConfig,
} from '../../../packages/webapp/src/scoops/tray-runtime-config.js';
import {
  FollowerTrayManager,
  LeaderTrayPeerManager,
  startFollowerWithAutoReconnect,
} from '../../../packages/webapp/src/scoops/tray-webrtc.js';
import { OffscreenBridge } from './offscreen-bridge.js';
import { ServiceWorkerLeaderTraySocket } from './tray-socket-proxy.js';
import { createLogger } from '../../../packages/webapp/src/core/index.js';
import type { ExtensionMessage } from './messages.js';
import { getApiKey } from '../../../packages/webapp/src/ui/provider-settings.js';

// Auto-discover and register all providers (built-in + external).
// IMPORTANT: Keep in sync with packages/webapp/src/ui/main.ts — both entry points need all providers.
import '../../../packages/webapp/src/providers/index.js';

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

  // Create CDP transport that proxies through the service worker
  const cdpProxy = new OffscreenCdpProxy();
  await cdpProxy.connect();
  console.log('[slicc-offscreen] CDP proxy connected');

  const browser = new BrowserAPI(cdpProxy);

  const container = document.body;

  const bridge = new OffscreenBridge();
  const callbacks = OffscreenBridge.createCallbacks(bridge);

  const orchestrator = new Orchestrator(container, {
    ...callbacks,
    getBrowserAPI: () => browser,
  });

  // Bind the orchestrator to the bridge (sets up message listener + session store)
  // Pass BrowserAPI so the bridge can proxy panel CDP commands through the offscreen transport.
  await bridge.bind(orchestrator, browser);

  console.log('[slicc-offscreen] Orchestrator created, calling init()...');
  await orchestrator.init();
  console.log('[slicc-offscreen] Orchestrator initialized');

  // Register session costs provider for the `cost` shell command (offscreen agent shell)
  const { registerSessionCostsProvider } =
    await import('../../../packages/webapp/src/shell/supplemental-commands/cost-command.js');
  registerSessionCostsProvider(() => orchestrator.getSessionCosts());

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

  // Initialize lick manager for cron tasks in extension mode
  const { getLickManager } = await import('../../../packages/webapp/src/scoops/lick-manager.js');
  const lickManager = getLickManager();
  await lickManager.init();
  orchestrator.setLickManager(lickManager);

  // Route lick events to scoops (mirrors CLI mode logic in main.ts)
  lickManager.setEventHandler((event) => {
    const isWebhook = event.type === 'webhook';
    const isSprinkle = event.type === 'sprinkle';
    const isFsWatch = event.type === 'fswatch';
    const isNavigate = event.type === 'navigate';
    const eventName = isWebhook
      ? event.webhookName
      : isSprinkle
        ? event.sprinkleName
        : isFsWatch
          ? (event as any).fswatchName
          : isNavigate
            ? (event as any).navigateUrl
            : event.cronName;
    const eventId = isWebhook
      ? event.webhookId
      : isSprinkle
        ? event.sprinkleName
        : isFsWatch
          ? (event as any).fswatchId
          : isNavigate
            ? (event as any).navigateUrl
            : event.cronId;
    const channel = event.type;

    const scoops = orchestrator.getScoops();
    let resolvedTarget: (typeof scoops)[number] | undefined;

    if (!event.targetScoop) {
      // Untargeted events → cone
      resolvedTarget = scoops.find((s) => s.isCone);
    } else {
      resolvedTarget = scoops.find(
        (s) =>
          s.name === event.targetScoop ||
          s.folder === event.targetScoop ||
          s.folder === `${event.targetScoop}-scoop`
      );
    }

    if (resolvedTarget) {
      const msgId = `${channel}-${eventId}-${Date.now()}`;
      const eventLabel = isWebhook
        ? 'Webhook Event'
        : isSprinkle
          ? 'Sprinkle Event'
          : isFsWatch
            ? 'File Watch Event'
            : isNavigate
              ? 'Navigate Event'
              : 'Cron Event';
      const content = `[${eventLabel}: ${eventName}]\n\`\`\`json\n${JSON.stringify(event.body, null, 2)}\n\`\`\``;

      const channelMsg: import('../../../packages/webapp/src/scoops/types.js').ChannelMessage = {
        id: msgId,
        chatJid: resolvedTarget.jid,
        senderId: channel,
        senderName: `${channel}:${eventName}`,
        content,
        timestamp: event.timestamp,
        fromAssistant: false,
        channel,
      };

      orchestrator.handleMessage(channelMsg);
    } else {
      console.warn('[slicc-offscreen] Lick target scoop not found', event.targetScoop);
    }
  });

  // Expose lickManager for the crontask shell command running in the offscreen document
  (globalThis as unknown as Record<string, unknown>).__slicc_lickManager = lickManager;

  // Start BroadcastChannel host so the side panel terminal can proxy crontask ops
  const { startLickManagerHost } = await import('./lick-manager-proxy.js');
  startLickManagerHost(lickManager);
  console.log('[slicc-offscreen] LickManager initialized (host + proxy)');

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

  // Ensure cone exists
  const allScoops = orchestrator.getScoops();
  const hasCone = allScoops.some((s) => s.isCone);
  const allowProviderlessTrayJoin = !getApiKey() && hasStoredTrayJoinUrl(window.localStorage);
  if (allowProviderlessTrayJoin && !hasCone) {
    console.log(
      '[slicc-offscreen] Skipping cone auto-create while joining a tray without a configured provider'
    );
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
      const reconnectHandle = startFollowerWithAutoReconnect(
        {
          joinUrl: trayRuntimeConfig.joinUrl,
          runtime: 'slicc-extension-offscreen',
        },
        {
          onConnected: (connection) => {
            log.info('Extension follower connected', { trayId: connection.trayId });
          },
          onGaveUp: (lastError) => {
            log.warn('Extension follower reconnect gave up', { lastError });
          },
        }
      );
      stopTrayRuntime = () => reconnectHandle.cancel();
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
  (globalThis as unknown as Record<string, unknown>).__slicc_sprinkleManager =
    createSprinkleManagerProxy();

  // Start BSH navigation watchdog — auto-executes .bsh scripts on matching navigations
  // Mirrors the setup in packages/webapp/src/ui/main.ts
  const sharedFs = orchestrator.getSharedFS();
  if (sharedFs) {
    try {
      const { BshWatchdog } = await import('../../../packages/webapp/src/shell/bsh-watchdog.js');
      const { ScriptCatalog } =
        await import('../../../packages/webapp/src/shell/script-catalog.js');
      const scriptCatalog = new ScriptCatalog({
        jshFs: sharedFs,
        bshFs: sharedFs,
        watcher: sharedFs.getWatcher(),
      });
      const bshWatchdog = new BshWatchdog({
        browserAPI: browser,
        scriptCatalog,
        fs: sharedFs,
      });
      void bshWatchdog.start();
      window.addEventListener(
        'beforeunload',
        () => {
          bshWatchdog.stop();
          scriptCatalog.dispose();
        },
        { once: true }
      );
      console.log('[slicc-offscreen] BSH navigation watchdog started');
    } catch (e) {
      log.warn('Failed to start BSH watchdog in offscreen', e);
    }
  }

  console.log('[slicc-offscreen] Agent engine ready, scoops:', orchestrator.getScoops().length);
}

init().catch((err) => {
  console.error('[slicc-offscreen] Init FAILED:', err);
  log.error('Offscreen init failed', err);
});
