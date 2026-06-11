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
import { startFreezeWatchdog } from './boot/setup-freeze-watchdog.js';
import { setupSwRegistration } from './boot/setup-sw-registration.js';
import { applyProviderDefaults } from './provider-settings.js';
import { resolveUiRuntimeMode } from './runtime-mode.js';

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

  // Service-worker registration (preview SW + connect-mode SW detach). The
  // helper returns `'reload-pending'` when it has triggered a one-shot
  // `location.reload()` and we must abort the rest of `main()` so the
  // page tears down cleanly.
  const swResult = await setupSwRegistration();
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
    return mountWcUiExtension(app, log);
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
