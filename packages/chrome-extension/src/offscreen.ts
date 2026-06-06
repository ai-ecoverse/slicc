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
import { createLogger } from '../../../packages/webapp/src/core/index.js';
import { createKernelHost } from '../../../packages/webapp/src/kernel/host.js';
import { createPanelTerminalHost } from '../../../packages/webapp/src/kernel/panel-terminal-host.js';
import { createOffscreenChromeRuntimeTransport } from '../../../packages/webapp/src/kernel/transport-chrome-runtime.js';
import { startVfsRpcHost } from '../../../packages/webapp/src/kernel/vfs-rpc-host.js';
// Auto-discover and register all providers (built-in + external).
// IMPORTANT: Keep in sync with packages/webapp/src/ui/main.ts — both
// entry points need all providers. Registration is explicit (not
// side-effect import) to break a module-cycle that hit TDZ in the
// kernel worker; the offscreen entry awaits `registerProviders()` in
// `init()`.
import { registerProviders } from '../../../packages/webapp/src/providers/index.js';
import {
  AGENT_SPAWN_REQUEST_TYPE,
  type AgentSpawnOptions,
  type AgentSpawnResult,
} from '../../../packages/webapp/src/scoops/agent-bridge.js';
import { ThrottledErrorTracker } from '../../../packages/webapp/src/scoops/throttled-error-tracker.js';
import { FollowerSyncManager } from '../../../packages/webapp/src/scoops/tray-follower-sync.js';
import { OFFSCREEN_SET_TRAY_RUNTIME_HOOK } from '../../../packages/webapp/src/scoops/tray-leave.js';
import {
  DEFAULT_PRODUCTION_TRAY_WORKER_BASE_URL,
  DEFAULT_STAGING_TRAY_WORKER_BASE_URL,
  hasStoredTrayJoinUrl,
  resolveTrayRuntimeConfig,
} from '../../../packages/webapp/src/scoops/tray-runtime-config.js';
import { startFollowerWithAutoReconnect } from '../../../packages/webapp/src/scoops/tray-webrtc.js';
import { installSudoTestHook } from '../../../packages/webapp/src/sudo/index.js';
import { getApiKey } from '../../../packages/webapp/src/ui/provider-settings.js';
import { canonicalRuntimeId } from '../../../packages/webapp/src/ui/runtime-identity.js';
import { initTelemetry } from '../../../packages/webapp/src/ui/telemetry.js';
import { applyTrayRuntimeUpdate as applyTrayRuntimeUpdateHelper } from './apply-tray-runtime-update.js';
import {
  type ExtensionLeaderTrayHandle,
  startExtensionLeaderTray,
} from './extension-leader-tray.js';
import {
  connectOffscreenFollowerSprinkleBridge,
  type OffscreenMessageHub,
} from './follower-sprinkle-bridge.js';
import { connectOffscreenLeaderSyncBridge } from './leader-sync-bridge.js';
import type { ExtensionMessage } from './messages.js';
import { OffscreenBridge } from './offscreen-bridge.js';
import { fetchOutboundScrubSnapshot, installOutboundScrubber } from './offscreen-outbound-scrub.js';

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

  // Install the defense-in-depth outbound LLM-wire scrub BEFORE anything else
  // here can issue a `fetch`. Wraps `globalThis.fetch` so cross-origin http(s)
  // request bodies/headers are scrubbed real → masked. Same-origin and
  // non-http(s) (chrome-extension:, blob:, data:) pass through. Response
  // streams are NOT buffered — SSE survives intact. See
  // `offscreen-outbound-scrub.ts` for details.
  installOutboundScrubber({
    getSnapshot: fetchOutboundScrubSnapshot,
    logger: log,
  });

  // Initialize RUM telemetry so beacons fire from the offscreen WasmShell
  // — `trackShellCommand` and friends silently no-op until `sampleRUM` is
  // bound here. Without this, agent-initiated `bash` invocations from the
  // extension (including `agent ...` scoop delegations from the cone)
  // never reach RUM, which is why extension users showed cone-prompt
  // beacons but zero shell-command beacons in the data. Fire-and-forget
  // — telemetry init must never block the boot.
  initTelemetry().catch(() => {});

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
    isExtension: true,
    logger: log,
  });
  const { orchestrator, lickManager } = host;
  console.log('[slicc-offscreen] Kernel host ready, scoops:', orchestrator.getScoops().length);

  // Publish the manual sudo test hook in the offscreen (agent) realm. It
  // relays approval requests to the side-panel responder via
  // chrome.runtime.sendMessage. No enforcement is wired yet — test surface.
  installSudoTestHook();

  // Stand up the terminal-RPC host on the same kernel transport — the
  // panel's `RemoteTerminalView` opens sessions here so panel-typed
  // commands hit the same `ProcessManager` and `/proc` view as the
  // agent's bash tool. Shared `createPanelTerminalHost` factory pins
  // parity with the standalone DedicatedWorker path (`kernel-worker.ts`):
  // both pass `processManager: host.processManager` into
  // `TerminalSessionHost` AND the per-session `WasmShellHeadless`, so
  // `ps` / `kill` / `cat /proc/<pid>/...` work uniformly.
  let stopTerminalHost: (() => void) | null = null;
  let stopVfsRpcHost: (() => void) | null = null;
  const sharedFs = host.sharedFs;
  if (sharedFs) {
    const handle = createPanelTerminalHost({
      transport: bridgeTransport,
      fs: sharedFs,
      browser,
      processManager: host.processManager,
      // Thread the orchestrator's SudoManager through so the panel
      // shell's explicit `sudo <cmd...>` prompts the human via the same
      // broker the offscreen agent uses. The factory pins
      // `transparentGating: false` so plain commands stay ungated.
      sudoManager: host.orchestrator.getSudoManager(),
      logger: log,
    });
    stopTerminalHost = handle.stop;
    // Worker-side VFS read RPC surface, same wiring as the standalone
    // DedicatedWorker (`kernel-worker.ts`).
    //
    // Also wire `writableClient: sharedFs` so the host accepts
    // `vfs-write-file` / `vfs-mkdir` / `vfs-rm` / `vfs-flush`
    // envelopes from the panel-side `WritableVfsClient`. `VirtualFS`
    // satisfies the `WritableVfsBackend` shape structurally. With
    // the OPFS flag off, the panel never constructs the writable
    // client so these write request types fan out into nobody —
    // existing behavior is unchanged.
    const vfsHandle = startVfsRpcHost({
      transport: bridgeTransport,
      client: sharedFs,
      writableClient: sharedFs,
      logger: log,
    });
    stopVfsRpcHost = vfsHandle.stop;
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
      stopVfsRpcHost?.();
      stopVfsRpcHost = null;
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

  // Start BroadcastChannel host so the side panel terminal can proxy
  // crontask/webhook ops. The webhook command needs the active leader
  // tray's webhook capability URL to build per-webhook URLs; resolve
  // it here on demand (offscreen owns the leader status singleton —
  // panel-side reads via the proxy).
  const { startLickManagerHost } = await import('./lick-manager-proxy.js');
  const { getLeaderTrayRuntimeStatus } = await import('../../webapp/src/scoops/tray-leader.js');
  startLickManagerHost(lickManager, {
    getTrayWebhookUrl: () => getLeaderTrayRuntimeStatus().session?.webhookUrl ?? null,
  });
  console.log('[slicc-offscreen] LickManager BroadcastChannel host started');

  // Listen for navigate-lick events forwarded from the service worker's
  // chrome.webRequest observer and emit them as lick events.
  chrome.runtime.onMessage.addListener((message: unknown) => {
    if (!isExtensionMessage(message) || message.source !== 'service-worker') return false;
    const payload = message.payload as { type?: string };
    if (payload?.type !== 'navigate-lick') return false;
    const navMsg = payload as import('./messages.js').NavigateLickMsg;
    const body: Record<string, unknown> = {
      url: navMsg.url,
      verb: navMsg.verb,
      target: navMsg.target,
    };
    if (navMsg.instruction != null) body.instruction = navMsg.instruction;
    if (navMsg.branch != null) body.branch = navMsg.branch;
    if (navMsg.path != null) body.path = navMsg.path;
    if (navMsg.title != null) body.title = navMsg.title;
    lickManager.emitEvent({
      type: 'navigate',
      navigateUrl: navMsg.url,
      targetScoop: undefined,
      timestamp: new Date().toISOString(),
      body,
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
      // Mark follower mode active for the whole join lifetime — sticky across
      // transient WebRTC reconnects so panel→offscreen handlers (e.g.
      // `sprinkle-lick`) know to log+drop instead of falling back to the
      // local model-less cone when sync is briefly null between connects.
      // Cleared in the matching `stopTrayRuntime` below.
      bridge.setFollowerActive(true);
      let activeSync: FollowerSyncManager | null = null;
      let activeSprinkleBridge: ReturnType<typeof connectOffscreenFollowerSprinkleBridge> | null =
        null;
      let targetRefreshInterval: ReturnType<typeof setInterval> | null = null;
      const detachSync = () => {
        if (targetRefreshInterval) {
          clearInterval(targetRefreshInterval);
          targetRefreshInterval = null;
        }
        if (activeSprinkleBridge) {
          activeSprinkleBridge.detach();
          activeSprinkleBridge = null;
        }
        if (!activeSync) return;
        bridge.setFollowerSync(null);
        lickManager.setForwarder(null);
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
            const runtimeId = canonicalRuntimeId(connection.bootstrapId);
            // Track our sprinkle bridge ahead of time so the FollowerSyncManager
            // callbacks can forward `sprinkles.list` / `sprinkle.update` to the
            // panel without a forward declaration. Bind is wrapped in a closure
            // so a transient bridge swap during reconnect doesn't leak stale
            // forwards to a previous panel session.
            let sprinkleBridgeRef: typeof activeSprinkleBridge = null;
            const sync: FollowerSyncManager = new FollowerSyncManager(connection.channel, {
              browserTransport: browser.getTransport(),
              browserAPI: browser,
              onSnapshot: (messages) => bridge.applyFollowerSnapshot(messages),
              onUserMessage: (text, messageId) =>
                bridge.emitFollowerIncomingMessage(messageId, text),
              onStatus: (scoopStatus) => bridge.emitFollowerStatus(scoopStatus),
              onTargetsChanged: () => void refreshTargets(),
              onSprinklesList: (sprinkles) => sprinkleBridgeRef?.forwardSprinklesList(sprinkles),
              onSprinkleUpdate: (name, data) =>
                sprinkleBridgeRef?.forwardSprinkleUpdate(name, data),
              onDisconnect: (reason) => {
                log.warn('Follower sync disconnected', { reason });
                detachSync();
              },
            });
            // Wire panel↔offscreen sprinkle messages: panel `follower-sprinkle-fetch`
            // / `follower-sprinkle-lick` enter via chrome.runtime.onMessage and are
            // routed through `sync` (a FollowerSyncManager). Outbound forwards
            // for `sprinkles.list` / `sprinkle.update` are bound above.
            const hub: OffscreenMessageHub = {
              sendToPanel: (envelope) => {
                chrome.runtime.sendMessage(envelope).catch((err: unknown) => {
                  // "Could not establish connection. Receiving end does not
                  // exist" is the expected case (no panel open) — drop it.
                  // Anything else (extension-context-invalidated, message
                  // length exceeded, serialization errors on non-cloneable
                  // payloads) is worth a log so the failure is observable.
                  const msg = err instanceof Error ? err.message : String(err);
                  if (/receiving end does not exist/i.test(msg)) return;
                  // `error` not `warn` — prod default log level is
                  // ERROR. The documented failure modes are all real
                  // bugs requiring investigation.
                  log.error('Offscreen → panel sendMessage failed', { error: msg });
                });
              },
              onPanelMessage: (handler) => {
                const listener = (msg: unknown): boolean => {
                  if (
                    !msg ||
                    typeof msg !== 'object' ||
                    !('source' in msg) ||
                    !('payload' in msg)
                  ) {
                    return false;
                  }
                  handler(msg as { source: string; payload: unknown });
                  return false;
                };
                chrome.runtime.onMessage.addListener(listener);
                return () => chrome.runtime.onMessage.removeListener(listener);
              },
            };
            sprinkleBridgeRef = connectOffscreenFollowerSprinkleBridge(hub, {
              fetchSprinkleContent: (name: string) => sync.fetchSprinkleContent(name),
              sendSprinkleLick: (name: string, body: unknown, targetScoop?: string) =>
                sync.sendSprinkleLick(name, body, targetScoop),
              cancelSprinkleFetch: (name: string, reason?: string) =>
                sync.cancelSprinkleFetch(name, reason),
            });
            activeSprinkleBridge = sprinkleBridgeRef;
            // Throttle: shared with the standalone follower and leader
            // via `scoops/throttled-error-tracker.ts`. Without the
            // shared helper, this site had drifted from R10/R11 fixes
            // (Date.now instead of performance.now, log.warn instead
            // of log.error, no recovery signal) — R12 brought it back
            // into the symmetry the extraction was meant to enforce.
            const cdpThrottle = new ThrottledErrorTracker(log, {
              failureMessage:
                'Offscreen follower CDP target listing failed (best-effort, throttled)',
              recoveryMessage:
                'Offscreen follower CDP target listing recovered (stable for debounce window)',
            });
            const refreshTargets = async () => {
              let pages: Awaited<ReturnType<typeof browser.listPages>>;
              try {
                pages = await browser.listPages();
              } catch (err) {
                cdpThrottle.reportFailure(err);
                return;
              }
              // Bail if a reconnect swapped activeSync while listPages was in
              // flight — otherwise we'd advertise this connection's runtimeId
              // against the new sync (or vice versa), polluting the registry.
              if (activeSync !== sync) return;
              cdpThrottle.reportSuccess();
              try {
                sync.advertiseTargets(
                  pages.map((p) => ({ targetId: p.targetId, title: p.title, url: p.url })),
                  runtimeId
                );
              } catch (err) {
                log.error(
                  'Offscreen follower target advertisement broadcast failed (sync.advertiseTargets threw)',
                  {
                    error: err instanceof Error ? err.message : String(err),
                  }
                );
              }
            };
            sync.onEvent((event) => bridge.emitFollowerAgentEvent(event));
            activeSync = sync;
            browser.setTrayTargetProvider(sync);
            bridge.setFollowerSync(sync);
            // Follower mode: forwardable licks (`navigate` — how SLICC handoffs
            // arrive) observed locally must go to the LEADER's agent, not this
            // follower's (model-less or invisible) local cone. The LickManager
            // dispatch chokepoint ships them over the data channel.
            lickManager.setForwarder((event) => sync.forwardLick(event));
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
        // Clear sticky follower-mode marker — only on permanent leave, not
        // on the transient detaches inside `detachSync` above.
        bridge.setFollowerActive(false);
      };
      return;
    }

    if (trayRuntimeConfig?.workerBaseUrl) {
      // Build the panel↔offscreen hub. The leader and follower branches
      // each own their own hub instance and detach on switch.
      const hub: OffscreenMessageHub = {
        sendToPanel: (envelope) => {
          chrome.runtime.sendMessage(envelope).catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            if (/receiving end does not exist/i.test(msg)) return;
            log.error('Offscreen → panel sendMessage failed (leader)', { error: msg });
          });
        },
        onPanelMessage: (handler) => {
          const listener = (msg: unknown): boolean => {
            if (!msg || typeof msg !== 'object' || !('source' in msg) || !('payload' in msg)) {
              return false;
            }
            handler(msg as { source: string; payload: unknown });
            return false;
          };
          chrome.runtime.onMessage.addListener(listener);
          return () => chrome.runtime.onMessage.removeListener(listener);
        },
      };

      // Forward-declared so the bridge can resolve sync lazily (sync isn't
      // built until startExtensionLeaderTray returns the handle).
      let activeHandle: ExtensionLeaderTrayHandle | null = null;
      const leaderBridge = connectOffscreenLeaderSyncBridge(
        hub,
        () => activeHandle?.sync ?? null,
        bridge
      );
      leaderBridge.signalLeaderMode(true);

      activeHandle = startExtensionLeaderTray({
        workerBaseUrl: trayRuntimeConfig.workerBaseUrl,
        bridge,
        orchestrator,
        sharedFs: host.sharedFs ?? null,
        browser,
        log,
        leaderBridge,
        lickManager,
      });

      // REGRESSION-SENSITIVE SITE: clearing `activeTrayRuntimeKey` and
      // `stopTrayRuntime` in the catch handler is load-bearing. Without
      // them, a retry with the SAME `workerBaseUrl` (which produces the
      // same `nextTrayRuntimeKey` JSON) would early-out at the
      // `nextTrayRuntimeKey === activeTrayRuntimeKey` guard in
      // `syncTrayRuntime` above — leaving leader mode permanently off
      // for the user until they change config or reload the extension.
      // Do NOT remove these resets without restoring an equivalent
      // re-entry path.
      void activeHandle.leader.start().catch((err) => {
        log.error('Extension leader tray start failed — reverting leader mode', {
          error: err instanceof Error ? err.message : String(err),
        });
        // Retract the leader-mode claim so the panel removes its hooks.
        leaderBridge.signalLeaderMode(false);
        // Tear down the now-dead handle so any user retry starts cleanly.
        activeHandle?.stop();
        activeHandle = null;
        // Clear the runtime key + stopTrayRuntime so a retry with the SAME
        // worker URL re-enters syncTrayRuntime instead of early-outing at
        // the `nextTrayRuntimeKey === activeTrayRuntimeKey` guard.
        activeTrayRuntimeKey = null;
        stopTrayRuntime = null;
      });

      stopTrayRuntime = () => {
        activeHandle?.stop();
        activeHandle = null;
      };
      return;
    }
  };

  await syncTrayRuntime();

  // Single source of truth for updating the offscreen's tray-runtime
  // localStorage and re-running `syncTrayRuntime`. Used by:
  //
  //   - the `refresh-tray-runtime` panel→offscreen relay (panel UI),
  //   - the `__slicc_setTrayRuntime` globalThis hook (in-offscreen
  //     shell, e.g. `host leave` typed at the panel terminal — the
  //     offscreen owns the shell that runs the agent's bash tool, and
  //     `chrome.runtime.sendMessage` does NOT deliver to the sender's
  //     own listeners, so the shell needs a direct local entry point).
  //
  // Logic is in `apply-tray-runtime-update.ts` for unit testability;
  // this site just wires the closure-captured deps.
  const applyTrayRuntimeUpdate = (
    joinUrl: string | null | undefined,
    workerBaseUrl: string | null | undefined
  ): Promise<void> =>
    applyTrayRuntimeUpdateHelper(joinUrl, workerBaseUrl, {
      storage: window.localStorage,
      stopTrayRuntime: () => {
        stopTrayRuntime?.();
        stopTrayRuntime = null;
      },
      resetTrayRuntimeKey: () => {
        activeTrayRuntimeKey = JSON.stringify(null);
      },
      syncTrayRuntime,
    });

  // Publish the in-offscreen direct hook so the agent's shell (running
  // in this same offscreen document) can drive the leave flow without
  // round-tripping through `chrome.runtime.sendMessage`. The hook name
  // is shared via the `OFFSCREEN_SET_TRAY_RUNTIME_HOOK` constant — the
  // consumer in `tray-leave.ts` reads the same constant.
  (globalThis as Record<string, unknown>)[OFFSCREEN_SET_TRAY_RUNTIME_HOOK] = applyTrayRuntimeUpdate;

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
    //
    // The async work runs after the synchronous message ack. Catch +
    // log any rejection so a failure inside `syncTrayRuntime` or the
    // leader/follower teardown surfaces in production telemetry instead
    // of becoming an unhandled rejection.
    const { joinUrl, workerBaseUrl } = message.payload;
    void applyTrayRuntimeUpdate(joinUrl, workerBaseUrl).catch((err) => {
      log.error('refresh-tray-runtime update failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
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
