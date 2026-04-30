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
import {
  AGENT_SPAWN_REQUEST_TYPE,
  publishAgentBridge,
  type AgentSpawnOptions,
  type AgentSpawnResult,
} from '../../../packages/webapp/src/scoops/agent-bridge.js';
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
import { formatLickEventForCone } from '../../../packages/webapp/src/scoops/lick-formatting.js';
import { recoverMounts } from '../../../packages/webapp/src/fs/mount-recovery.js';
import { getAllMountEntries } from '../../../packages/webapp/src/fs/mount-table-store.js';
import type { LickEvent } from '../../../packages/webapp/src/scoops/lick-manager.js';

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

  // Publish the real AgentBridge on globalThis.__slicc_agent so the
  // offscreen WasmShell's `agent` supplemental command can spawn scoops
  // directly. The side panel's `agent` command talks to this same bridge
  // via a proxy — see the AGENT_SPAWN_REQUEST_TYPE handler below.
  {
    const sharedFs = orchestrator.getSharedFS();
    if (sharedFs) {
      publishAgentBridge(orchestrator, sharedFs, orchestrator.getSessionStore());
    } else {
      log.warn('AgentBridge not published — orchestrator.getSharedFS() returned null');
    }
  }

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

      const bridge = (globalThis as Record<string, unknown>).__slicc_agent as
        | { spawn: (opts: AgentSpawnOptions) => Promise<AgentSpawnResult> }
        | undefined;
      if (!bridge || typeof bridge.spawn !== 'function') {
        sendResponse({ ok: false, error: 'agent-spawn-request: bridge not published' });
        return true;
      }

      bridge
        .spawn(options)
        .then((result) => sendResponse({ ok: true, result }))
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          sendResponse({ ok: false, error: msg });
        });
      return true; // keep the message channel open for the async response
    }
  );

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
  // Route lick events to scoops. Content rendering is shared with main.ts
  // (formatLickEventForCone) so CLI and extension produce identical UX —
  // including session-reload + mount-recovery prompts. Without the shared
  // formatter, the previous offscreen handler only special-cased upgrade
  // events and rendered everything else as a malformed JSON dump.
  lickManager.setEventHandler((event) => {
    const formatted = formatLickEventForCone(event);
    if (formatted === null) {
      console.debug('[slicc-offscreen] dropping lick event with no renderable content', {
        type: event.type,
      });
      return;
    }

    // Compute eventName + eventId for routing / message id (unchanged).
    const isWebhook = event.type === 'webhook';
    const isSprinkle = event.type === 'sprinkle';
    const isFsWatch = event.type === 'fswatch';
    const isNavigate = event.type === 'navigate';
    const isUpgrade = event.type === 'upgrade';
    const isSessionReload = event.type === 'session-reload';
    const eventName = isWebhook
      ? event.webhookName
      : isSprinkle
        ? event.sprinkleName
        : isFsWatch
          ? (event as any).fswatchName
          : isNavigate
            ? (event as any).navigateUrl
            : isUpgrade
              ? `${(event as any).upgradeFromVersion ?? 'unknown'}→${(event as any).upgradeToVersion ?? 'unknown'}`
              : isSessionReload
                ? 'mount-recovery'
                : event.cronName;
    const eventId = isWebhook
      ? event.webhookId
      : isSprinkle
        ? event.sprinkleName
        : isFsWatch
          ? (event as any).fswatchId
          : isNavigate
            ? (event as any).navigateUrl
            : isUpgrade
              ? `upgrade-${(event as any).upgradeToVersion ?? 'unknown'}`
              : isSessionReload
                ? `session-reload-${event.timestamp}`
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
      const channelMsg: import('../../../packages/webapp/src/scoops/types.js').ChannelMessage = {
        id: msgId,
        chatJid: resolvedTarget.jid,
        senderId: channel,
        senderName: `${channel}:${eventName}`,
        content: formatted.content,
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

  // Restore persisted mounts. MUST run AFTER setEventHandler is registered
  // (so the session-reload lick we may emit below routes through the shared
  // formatter installed above). Mirrors main.ts:1748-1763 for CLI/Electron
  // — without this branch, persisted s3:// and da:// mounts would not
  // auto-restore on extension reopen.
  const sharedFsForRecovery = orchestrator.getSharedFS();
  if (sharedFsForRecovery) {
    void getAllMountEntries()
      .then(async (entries) => {
        if (entries.length === 0) return;
        const { needsRecovery } = await recoverMounts(entries, sharedFsForRecovery, console);
        if (needsRecovery.length === 0) return;
        const event: LickEvent = {
          type: 'session-reload',
          targetScoop: undefined,
          timestamp: new Date().toISOString(),
          body: { reason: 'mount-recovery', mounts: needsRecovery },
        };
        // routeLickToScoop is a private helper inside main(); offscreen uses
        // the public emit API. The handler installed via setEventHandler
        // above formats the event via formatLickEventForCone.
        lickManager.emitEvent(event);
      })
      .catch((err) => console.warn('[slicc-offscreen] mount recovery failed:', err));
  }

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

  // ── Upgrade detection ─────────────────────────────────────────────
  // Aligned with the boot-time check in packages/webapp/src/ui/main.ts:
  // both run only after a cone is guaranteed to exist as a routable
  // target. We also defer advancing the "last seen" marker until the
  // lick has been routed — otherwise a transient no-cone state would
  // silently lose the upgrade notification for that version.
  {
    const sharedFsForUpgrade = orchestrator.getSharedFS();
    if (sharedFsForUpgrade) {
      const { detectUpgrade, recordVersionSeen } =
        await import('../../../packages/webapp/src/scoops/upgrade-detection.js');
      detectUpgrade(sharedFsForUpgrade)
        .then(async (result) => {
          if (!result.isUpgrade || result.lastSeen === null) return;
          lickManager.emitEvent({
            type: 'upgrade',
            targetScoop: undefined,
            timestamp: new Date().toISOString(),
            upgradeFromVersion: result.lastSeen,
            upgradeToVersion: result.bundled.version,
            body: {
              from: result.lastSeen,
              to: result.bundled.version,
              releasedAt: result.bundled.releasedAt,
            },
          });
          await recordVersionSeen(result.bundled.version);
        })
        .catch((err) => console.warn('[slicc-offscreen] Upgrade detection failed', err));
    }
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
