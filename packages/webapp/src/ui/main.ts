/**
 * Main entry point for the SLICC UI — the `@slicc/webcomponents` shell.
 *
 * Boot paths by float:
 * - standalone / electron-overlay / hosted-leader / cherry → `mountWcUiLive`
 *   (kernel worker on the page, tray sync, panel RPC)
 * - extension side panel / detached popout → `mountWcUiExtension`
 *   (OffscreenClient to the offscreen agent engine)
 * - `?connect=1` → the slim provider-login surface for the cloud dashboard
 * - `?ui-fixture` → the design-time chat fixture (no kernel)
 *
 * The legacy Layout/ChatPanel UI was removed in the WC migration
 * (PR #961); its stylesheets survive only as the scoped dialog subset in
 * `legacy-styles.ts`.
 */

import { createLogger } from '../core/index.js';
// Auto-discover and register all providers (built-in + external).
// IMPORTANT: This import must also appear in packages/chrome-extension/src/offscreen.ts
// — the extension agent engine runs in the offscreen document, not in this file.
import { registerProviders } from '../providers/index.js';
import { parseBridgeLaunchParams } from './boot/bridge-launch-params.js';
import { startFreezeWatchdog } from './boot/setup-freeze-watchdog.js';
import { setupNukeReloadListener } from './boot/setup-nuke-reload-listener.js';
import { setupSwRegistration } from './boot/setup-sw-registration.js';
import { applyProviderDefaults } from './provider-settings.js';
import { resolveUiRuntimeMode } from './runtime-mode.js';
import { initTelemetry } from './telemetry.js';

const log = createLogger('main');

/** `?ui-fixture` (any value) selects the design-time chat fixture. */
function isFixtureRequested(href: string): boolean {
  try {
    return new URL(href).searchParams.has('ui-fixture');
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const app = document.getElementById('app');
  if (!app) throw new Error('#app element not found');

  const isExtension = typeof chrome !== 'undefined' && !!chrome?.runtime?.id;
  const runtimeMode = resolveUiRuntimeMode(window.location.href, isExtension);

  // Design-time fixture: the WC shell over the synthetic chat session,
  // no kernel, no providers — exits before any heavy boot work.
  if (isFixtureRequested(window.location.href)) {
    const { mountWcUiPreview } = await import('./wc/wc-shell.js');
    mountWcUiPreview(app);
    return;
  }

  startFreezeWatchdog();

  // Page-side `nuke-reload` listener. The agent shell runs in a
  // worker / offscreen context where `location.reload()` is a no-op,
  // so `nuke <launch-code>` broadcasts a reload request that this
  // window-context listener acts on (clearing select localStorage
  // keys, then reloading). Idempotent — safe to call across re-inits.
  setupNukeReloadListener();

  // Initialize RUM telemetry for the page/panel realm — `trackShellCommand`,
  // `trackChatSubmit`, sprinkle `viewblock`, settings `signup`, and panel JS
  // `error` are silent no-ops until `sampleRUM` is bound here. Mirrors the
  // offscreen init (see chrome-extension/src/offscreen.ts). Skipped for the
  // `?connect=1` login-only surface, which has no kernel and no shell.
  // Fire-and-forget — telemetry init must never block the boot.
  if (runtimeMode !== 'connect') {
    initTelemetry().catch(() => {});
  }

  // Service-worker registration (preview SW + connect-mode SW detach). The
  // helper returns `'reload-pending'` when it has triggered a one-shot
  // `location.reload()` and we must abort the rest of `main()` so the
  // page tears down cleanly. In thin-bridge mode we forward the parsed
  // bridge `{ apiBaseUrl, token }` so the LLM-proxy SW rewrites
  // cross-origin LLM fetches at the local node-server's origin with the
  // bridge token attached, instead of hitting `https://www.sliccy.ai`'s
  // non-existent `/api/fetch-proxy`. `setupStandalonePrelude` parses the
  // same params again for the page-realm `proxied-fetch.ts` wiring; the
  // duplicate parse keeps the SW boot independent of the kernel-worker
  // bring-up order.
  const bridge = parseBridgeLaunchParams(window.location.search);
  const swResult = await setupSwRegistration(
    bridge ? { apiBaseUrl: bridge.apiBaseUrl, token: bridge.token } : null
  );
  if (swResult === 'reload-pending') return;

  // Provider auto-discovery + defaults before any OAuth probe. Both must
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

  if (runtimeMode === 'connect') {
    (globalThis as Record<string, unknown>).__slicc_connect_mode = true;
    const { loadLegacyStyles } = await import('./legacy-styles.js');
    await loadLegacyStyles();
    const { mountConnectSurface } = await import('./connect-surface.js');
    await mountConnectSurface(app);
    return;
  }

  if (isExtension) {
    const { mountWcUiExtension } = await import('./wc/wc-extension.js');
    return mountWcUiExtension(app, log, runtimeMode === 'extension-detached');
  }

  const { mountWcUiLive } = await import('./wc/wc-live.js');
  return mountWcUiLive(app, log, runtimeMode);
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
