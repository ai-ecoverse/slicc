// ── CSS imports (order matters for specificity) ──────────────────────
import './styles/tokens.css';
import './styles/base.css';
import './styles/layout.css';
import './styles/header.css';
import './styles/chat.css';
import './styles/tools.css';
import './styles/markdown.css';
import './styles/panels.css';
import './styles/tabs.css';
import './styles/dialog.css';
import './styles/sprinkle-components.css';
import './styles/feedback.css';
import './styles/image-preview.css';
import './styles/add-menu.css';
/**
 * Main entry point for the Browser Coding Agent UI.
 *
 * Bootstraps the layout, checks for API key, initializes the
 * orchestrator with cone + scoops, and wires events to the Chat UI.
 * Always uses cone+orchestrator mode — no direct agent path.
 */

import { createLogger } from '../core/index.js';
import type { VirtualFS } from '../fs/index.js';
// Auto-discover and register all providers (built-in + external).
// IMPORTANT: This import must also appear in packages/chrome-extension/src/offscreen.ts
// — the extension agent engine runs in the offscreen document, not in this file.
import { registerProviders } from '../providers/index.js';
import { hasStoredTrayJoinUrl } from '../scoops/tray-runtime-config.js';
import type { RegisteredScoop } from '../scoops/types.js';
import { capturePhoto, captureScreenshot } from './add-menu/capture.js';
import {
  createAggregator,
  createFileFolderProvider,
  createScoopProvider,
  createSessionProvider,
  createSkillProvider,
} from './add-menu/search-providers.js';
import { setupElectronOverlay } from './boot/setup-electron-overlay.js';
import { setupExtensionClient } from './boot/setup-extension-client.js';
import { setupExtensionDetached } from './boot/setup-extension-detached.js';
import { setupExtensionFinalize } from './boot/setup-extension-finalize.js';
import { setupExtensionFollowerSprinkle } from './boot/setup-extension-follower-sprinkle.js';
import { setupExtensionLeaderHooks } from './boot/setup-extension-leader-hooks.js';
import { setupExtensionOnboarding } from './boot/setup-extension-onboarding.js';
import { setupExtensionPanels } from './boot/setup-extension-panels.js';
import { setupExtensionPrelude } from './boot/setup-extension-prelude.js';
import { setupExtensionRemoteTerminal } from './boot/setup-extension-remote-terminal.js';
import { setupExtensionSprinkle } from './boot/setup-extension-sprinkle.js';
import { setupExtensionWritableVfs } from './boot/setup-extension-writable-vfs.js';
import { startFreezeWatchdog } from './boot/setup-freeze-watchdog.js';
import { runFirstRunDetection } from './boot/setup-onboarding.js';
import { setupStandaloneFinalize } from './boot/setup-standalone-finalize.js';
import { setupStandaloneKernel } from './boot/setup-standalone-kernel.js';
import { setupStandalonePanels } from './boot/setup-standalone-panels.js';
import { setupStandalonePrelude } from './boot/setup-standalone-prelude.js';
import { setupStandaloneRuntime } from './boot/setup-standalone-runtime.js';
import { setupSudoExtension } from './boot/setup-sudo.js';
import { setupSwRegistration } from './boot/setup-sw-registration.js';
import { setupVfs } from './boot/setup-vfs.js';
import { loadFiredWelcomeActions, persistFiredWelcomeActions } from './boot/setup-welcome-flow.js';
import { Layout } from './layout.js';
import type { OffscreenClient } from './offscreen-client.js';
import { applyProviderDefaults, getApiKey } from './provider-settings.js';
import { resolveUiRuntimeMode, type UiRuntimeMode } from './runtime-mode.js';
import { readSessionsIndex } from './session-freezer.js';
import { initTheme } from './theme.js';
import { initTooltips } from './tooltip.js';

const log = createLogger('main');

function wireAddMenu(layout: Layout, vfs: VirtualFS, client: OffscreenClient): void {
  const aggregator = createAggregator([
    createFileFolderProvider(vfs, ['/workspace', '/shared']),
    createSkillProvider(vfs),
    createSessionProvider(() => readSessionsIndex(vfs)),
    createScoopProvider(() => client.getScoops()),
  ]);
  layout.panels.chat.setAddMenu({ aggregator, capturePhoto, captureScreenshot });
}

/**
 * Sprinkle names whose `.shtml` file backs an inline dip rather than a
 * panel sprinkle. They live under `/shared/sprinkles/` for path-stability
 * reasons (the markdown image syntax `![](/shared/sprinkles/...)`
 * references them) but should never appear in the rail/picker, since the
 * inline dip is the sole intended rendering.
 */
const INLINE_DIP_SPRINKLES: ReadonlySet<string> = new Set(['welcome']);

// ---------------------------------------------------------------------------
// Extension mode — pure UI connecting to offscreen agent engine
// ---------------------------------------------------------------------------

async function mainExtension(app: HTMLElement, options?: { detached?: boolean }): Promise<void> {
  const isDetachedSelf = options?.detached === true;
  const layout = new Layout(app, !isDetachedSelf);
  await layout.panels.chat.initSession('session-cone');

  // Publish the AgentBridge proxy on the panel realm's globalThis. The
  // real bridge lives in the offscreen document; the proxy forwards
  // spawn requests through chrome.runtime.sendMessage.
  const { publishAgentBridgeProxy } = await import('../scoops/agent-bridge.js');
  publishAgentBridgeProxy();
  // Sudo responder on the side-panel realm. See `boot/setup-sudo.ts`.
  await setupSudoExtension({ log });

  let selectedScoop: RegisteredScoop | null = null;

  // Early-boot prelude: panel-VFS, mount-table recovery, preview-vfs
  // responder, skill-drop, terminal cost provider. See
  // `boot/setup-extension-prelude.ts`.
  const {
    localFs,
    useRpcVfs,
    previewVfsReader: previewVfsReaderBox,
  } = await setupExtensionPrelude({ layout, log });

  // Brain-icon callback box — `setupExtensionPanels` resolves the real
  // implementation; the forward ref lets `setupExtensionClient`'s
  // `onScoopSelect` reach it without an awkward swap.
  let syncThinkingButton: (scoop: RegisteredScoop) => void = () => undefined;

  // OffscreenClient + selectScoop. See `boot/setup-extension-client.ts`.
  const { client, selectScoop } = setupExtensionClient({
    layout,
    log,
    getSelectedScoop: () => selectedScoop,
    setSelectedScoop: (s) => {
      selectedScoop = s;
    },
    syncThinkingButtonForScoop: (s) => syncThinkingButton(s),
  });
  setupExtensionDetached({ client, layout, isDetachedSelf });

  // Under `slicc_opfs_vfs=opfs` route file-browser reads + preview-vfs
  // through the offscreen `VfsRpcHost` and construct a
  // `RemoteWritableVfsClient` for panel-side writers. Flag off:
  // `writableFs === localFs`. See `boot/setup-extension-writable-vfs.ts`.
  const writableHandle = await setupExtensionWritableVfs({
    client,
    layout,
    localFs,
    useRpcVfs,
    log,
  });
  const writableFs = writableHandle.writableFs;
  if (writableHandle.previewVfsReader) {
    previewVfsReaderBox.current = writableHandle.previewVfsReader;
  }

  setupExtensionRemoteTerminal({ client, layout, log });

  // Panel ⇄ orchestrator: agent handle, scoop/memory panels, brain
  // icon, clear chat / filesystem. See `boot/setup-extension-panels.ts`.
  syncThinkingButton = setupExtensionPanels({
    client,
    layout,
    localFs,
    writableFs,
    selectScoop,
    getSelectedScoop: () => selectedScoop,
    log,
  }).syncThinkingButtonForScoop;
  wireAddMenu(layout, localFs, client);

  // Persistent dedup ledger of welcome-flow licks — shared between the
  // orchestrator's final-lick and the welcome lick interceptor.
  const firedWelcomeActions = loadFiredWelcomeActions();

  // OnboardingOrchestrator + welcome-lick interceptor + inline-dip lick
  // forwarder. See `boot/setup-extension-onboarding.ts`.
  const { onboardingHandle, interceptWelcomeLick } = await setupExtensionOnboarding({
    client,
    layout,
    localFs,
    firedWelcomeActions,
    log,
  });
  const getExtOnboardingOrchestrator = () => onboardingHandle.get();

  // Sprinkle Manager + rail wiring + worker-relay sprinkle ops. See
  // `boot/setup-extension-sprinkle.ts`.
  const sprinkleManager = await setupExtensionSprinkle({
    layout,
    client,
    localFs,
    writableFs,
    useRpcVfs,
    inlineSprinkles: INLINE_DIP_SPRINKLES,
    interceptWelcomeLick,
    log,
  });

  await setupExtensionFollowerSprinkle({ layout, log });
  setupExtensionLeaderHooks({ sprinkleManager, client, chat: layout.panels.chat, log });

  // Drive the first-run flow locally. The deterministic onboarding
  // orchestrator owns the welcome dip + intro lines until the user
  // configures a provider — handing it to the cone would fatal with
  // "No API key configured for provider …" before the wizard appears.
  // The persistent dedup ledger guards against reload double-fires.
  runFirstRunDetection({
    vfs: localFs,
    storage: window.localStorage,
    firedWelcomeActions,
    persistFiredWelcomeActions,
    getOrchestrator: getExtOnboardingOrchestrator,
    log,
  });

  // Tail: watcher install + welcome marker migration + nuke listener +
  // UI fixture + telemetry + background enrichment. See
  // `boot/setup-extension-finalize.ts`.
  await setupExtensionFinalize({
    client,
    layout,
    chat: layout.panels.chat,
    sprinkleManager,
    localFs,
    writableFs,
    log,
  });
}

// ---------------------------------------------------------------------------
// Standalone via kernel worker (opt-in, ?kernel-worker=1)
//
// The agent engine moves into a DedicatedWorker. The page keeps the UI,
// the file-browser local VFS, and the WebSocket-backed `CDPClient`; the
// worker runs Orchestrator + scoops + WasmShell pool + a worker-side
// `BrowserAPI` whose CDP commands are forwarded back to the page's
// `CDPClient` via `startPageCdpForwarder`.
//
// What's wired today:
//   - Layout (split panels)
//   - Local VFS for file-browser + memory panel + preview-vfs fallback
//   - `BrowserAPI` (page-side) → `startPageCdpForwarder` → worker
//   - `OffscreenClient` over MessageChannel as the orchestrator-shim
//   - Chat panel ⇄ `client.createAgentHandle()`
//   - `panels.scoops` / `panels.memory` ⇄ `setOrchestrator(client)`
//   - `selectScoop` flow on scoop chip click
//
// What's deferred (smoke-test will hit these as gaps):
//   - Wizard / OnboardingOrchestrator (welcome.shtml, connect-llm dip)
//   - Panel-side terminal shell (would need PanelCdpProxy or similar)
//   - Sprinkle UI rendering (sprinkle-renderer needs panel-side wiring)
//   - Cost provider via shell `cost` command (no panel→worker query yet)
//   - Skill-drop install
//   - Tray runtime sync (page ↔ worker bridge for tray join URL)
//   - publishAgentBridgeProxy (terminal `agent` shell command)
//
// `?kernel-worker=1` makes the choice explicit so smoke testing the new
// path can't accidentally regress the inline path that ships today.
// ---------------------------------------------------------------------------

async function mainStandaloneWorker(app: HTMLElement, runtimeMode: UiRuntimeMode): Promise<void> {
  // Sudo hook + tray runtime config + page-side BrowserAPI (or cherry
  // follower transport) + eager CDP connect + per-instance id. See
  // `boot/setup-standalone-prelude.ts`.
  const {
    browser,
    realCdpTransport,
    cherryJoinUrl,
    cherryTransport,
    instanceId,
    isElectronOverlay,
  } = await setupStandalonePrelude({
    runtimeMode,
    envBaseUrl: import.meta.env.VITE_WORKER_BASE_URL ?? null,
    window,
    log,
  });

  const layout = new Layout(app, isElectronOverlay);
  setupElectronOverlay({ layout, isElectronOverlay, window, document });
  await layout.panels.chat.initSession('session-cone');
  log.info('Session initialized (kernel-worker mode)');

  // VFS handles (`localFs`, `panelReadVfs`, `writableFs`), the OPFS
  // cross-tab leader election under `slicc_opfs_vfs=opfs`, the
  // page-side mount-table recovery, and the page-side preview-vfs
  // BroadcastChannel responder. See `boot/setup-vfs.ts`.
  const vfsHandle = await setupVfs({ layout, log });
  const { useRpcVfs, opfsLeader } = vfsHandle;

  let selectedScoop: RegisteredScoop | null = null;

  // Kernel-worker spawn + migration splash + selectScoop + brain icon.
  // See `boot/setup-standalone-kernel.ts`.
  const kernel = setupStandaloneKernel({
    realCdpTransport,
    instanceId,
    layout,
    log,
    getSelectedScoop: () => selectedScoop,
    setSelectedScoop: (s) => {
      selectedScoop = s;
    },
  });
  const {
    client,
    hostReady,
    hostDispose,
    selectScoop,
    syncThinkingButtonForScoop,
    disarmMigrationSplash,
  } = kernel;

  // Wire panels: orchestrator shims, scope tooltip sources, scoop
  // select, clearChat (initial), brain icon, setLocalFS, attachWorkerVfs,
  // new-session clearChat (overwrites), frozen sessions, chat agent +
  // delete cb + onMessagesChanged glow. See `boot/setup-standalone-panels.ts`.
  const { agentHandle, frozenSessions } = await setupStandalonePanels({
    client,
    layout,
    vfsHandle,
    selectScoop,
    getSelectedScoop: () => selectedScoop,
    syncThinkingButtonForScoop,
    log,
  });
  const { localFs, writableFs } = vfsHandle;
  wireAddMenu(layout, localFs, client);

  // Post-panels runtime composite: host-ready join → onboarding →
  // dip-lick callback → sprinkle manager → leader-runtime + panel-RPC +
  // sprinkle-layout + tray bootstrap + trailers. See
  // `boot/setup-standalone-runtime.ts`.
  const firedWelcomeActions = loadFiredWelcomeActions();
  const { stopStorageSync, stopSprinkleHandler } = await setupStandaloneRuntime({
    runtimeMode,
    cherryJoinUrl,
    cherryTransport,
    layout,
    client,
    browser,
    agentHandle,
    realCdpTransport,
    vfsHandle,
    frozenSessions,
    hostReady,
    disarmMigrationSplash,
    instanceId,
    getSelectedScoop: () => selectedScoop,
    firedWelcomeActions,
    persistFiredWelcomeActions,
    inlineSprinkles: INLINE_DIP_SPRINKLES,
    window,
    log,
  });

  // Tail: panel-terminal mount + nuke listener + page-side unload
  // cleanup + UI fixture + telemetry + background enrichment of
  // pending-frozen sessions. See `boot/setup-standalone-finalize.ts`.
  await setupStandaloneFinalize({
    client,
    layout,
    writableFs,
    useRpcVfs,
    opfsLeader,
    stopStorageSync,
    stopSprinkleHandler,
    hostDispose,
    window,
    log,
  });
}

// ---------------------------------------------------------------------------
// Top-level dispatcher — picks the float-specific boot path.
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  startFreezeWatchdog();
  initTheme();
  initTooltips();

  const app = document.getElementById('app');
  if (!app) throw new Error('#app element not found');

  // Service-worker registration (preview SW + connect-mode SW detach). The
  // helper returns `'reload-pending'` when it has triggered a one-shot
  // `location.reload()` and we must abort the rest of `main()` so the
  // page tears down cleanly.
  const swResult = await setupSwRegistration();
  if (swResult === 'reload-pending') return;

  // Provider auto-discovery + defaults before any API-key probe. Both must
  // run before `bootstrapOAuthReplicas` so the OAuth bootstrap sees the
  // resolved provider list. See `providers/index.ts:registerProviders`.
  await registerProviders();
  applyProviderDefaults();

  // Pre-warm OAuth replicas so the kernel-worker starts with fresh tokens;
  // bounded so a hung IMS popup doesn't deadlock the UI.
  const { bootstrapOAuthReplicas } = await import('./oauth-bootstrap.js');
  await Promise.race([
    bootstrapOAuthReplicas().catch((err) => {
      log.error('OAuth bootstrap failed', err);
    }),
    new Promise<void>((resolve) => setTimeout(resolve, 10_000)),
  ]);

  // First-run no longer auto-opens the legacy "Add Account" dialog.
  // Provider configuration is owned by the deterministic onboarding flow.
  const apiKey = getApiKey();
  const _allowProviderlessTrayJoin = !apiKey && hasStoredTrayJoinUrl(window.localStorage);

  const isExtension = typeof chrome !== 'undefined' && !!chrome?.runtime?.id;
  const runtimeMode = resolveUiRuntimeMode(window.location.href, isExtension);

  if (runtimeMode === 'connect') {
    (globalThis as Record<string, unknown>).__slicc_connect_mode = true;
    const { mountConnectSurface } = await import('./connect-surface.js');
    await mountConnectSurface(app);
    return;
  }
  if (runtimeMode === 'extension-detached') {
    return mainExtension(app, { detached: true });
  }
  if (runtimeMode === 'extension') {
    return mainExtension(app);
  }
  return mainStandaloneWorker(app, runtimeMode);
}

main().catch((err) => {
  log.error('Fatal error', err);
  const app = document.getElementById('app');
  if (app) {
    const errorDiv = document.createElement('div');
    errorDiv.style.cssText = 'padding: 2rem; text-align: center;';
    const h1 = document.createElement('h1');
    h1.style.color = 'var(--s2-negative, #e34850)';
    h1.textContent = 'Failed to start';
    const p = document.createElement('p');
    p.style.color = 'var(--s2-content-tertiary, #717171)';
    p.textContent = err.message;
    errorDiv.appendChild(h1);
    errorDiv.appendChild(p);

    while (app.firstChild) app.removeChild(app.firstChild);
    app.appendChild(errorDiv);
  }
});
