/**
 * Main entry point for the SLICC UI — the `@slicc/webcomponents` shell.
 *
 * Boot paths by float:
 * - standalone / electron-overlay / hosted-leader → `mountWcUiLive`
 *   (kernel worker on the page, tray sync, panel RPC)
 * - follower / cherry → `mountWcUiFollower`
 *   (no kernel, tray follower sync, no OAuth bootstrap)
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
import { hasChromeRuntimeConnect, isExtensionRealm } from '../core/runtime-env.js';
import { initTelemetry } from '../kernel/telemetry.js';
// Auto-discover and register all providers (built-in + external).
// IMPORTANT: This import must also appear in packages/chrome-extension/src/offscreen.ts
// — the extension agent engine runs in the offscreen document, not in this file.
import { registerProviders } from '../providers/index.js';
import { parseBridgeLaunchParams } from './boot/bridge-launch-params.js';
import { installExtensionFetchDelegate } from './boot/setup-extension-fetch-delegate.js';
import { setupFeatureFlagsForPage } from './boot/setup-feature-flags.js';
import { startFreezeWatchdog } from './boot/setup-freeze-watchdog.js';
import { setupNukeReloadListener } from './boot/setup-nuke-reload-listener.js';
import { setupPreloadErrorReload } from './boot/setup-preload-error-reload.js';
import { parseExtensionLeaderParams } from './boot/setup-standalone-prelude.js';
import { setupStoragePersistence } from './boot/setup-storage-persistence.js';
import { setupSwRegistration } from './boot/setup-sw-registration.js';
import { applyProviderDefaults } from './provider-settings.js';

const log = createLogger('main');

/**
 * Page-realm flag read by `shell/float-topology.ts` (and providers that
 * mirror it). Named so the connect-mode boot path casts through a known
 * shape instead of an open string-keyed bag.
 */
type ConnectModeGlobal = {
  __slicc_connect_mode?: unknown;
};

/** `?ui-fixture` (any value) selects the design-time chat fixture. */
function isFixtureRequested(href: string): boolean {
  try {
    return new URL(href).searchParams.has('ui-fixture');
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  // Recover a long-lived tab that crashes on a now-gone content-hashed chunk
  // after a deploy (#1330). Installed before any dynamic import() so page-owned
  // lazy-chunk failures are always caught. Harmless on the ?ui-fixture surface.
  setupPreloadErrorReload();

  const app = document.getElementById('app');
  if (!app) throw new Error('#app element not found');

  const isExtension = isExtensionRealm();
  // Use one boot helper for runtime detection and flag hydration so the float
  // sent to the worker and used for the local cache cannot diverge.
  const runtimeMode = setupFeatureFlagsForPage({
    locationHref: window.location.href,
    storage: window.localStorage,
    envBaseUrl: import.meta.env.VITE_WORKER_BASE_URL ?? null,
    isDev: __DEV__,
    isExtension,
  });

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

  // Ask the browser to mark this origin's storage persistent. SLICC's whole
  // VFS is an OPFS tree, and OPFS is best-effort quota storage: on a nearly
  // full disk Chromium evicts whole buckets — the entire tree, silently —
  // unless the bucket is persistent. Fire-and-forget, never prompts, and the
  // answer improves with site engagement, so it is re-requested every boot.
  setupStoragePersistence();

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
  // Extension-delegate leader tab (`?slicc=leader&ext=<id>`): the hosted
  // origin has no `/api/fetch-proxy`, so the LLM-proxy SW must route
  // cross-origin LLM fetches through the extension's fetch proxy. Detect it
  // here (page realm CAN open a `chrome.runtime` Port even though
  // `chrome.runtime.id` is undefined on an externally-connectable page) and
  // hand the SW the delegate config; `installExtensionFetchDelegate` below
  // wires the page-side relay before the kernel worker starts.
  const extLeader =
    runtimeMode === 'cherry' ? null : parseExtensionLeaderParams(window.location.search);
  const extensionDelegate = !!extLeader && hasChromeRuntimeConnect();
  const swResult = await setupSwRegistration(
    bridge ? { apiBaseUrl: bridge.apiBaseUrl, token: bridge.token } : null,
    extensionDelegate && extLeader ? { extensionId: extLeader.extensionId } : null
  );
  if (swResult === 'reload-pending') return;

  // Follower fast-path: a tray follower (and the cherry embed) needs neither
  // the local OAuth bootstrap (it uses the leader's credentials over the tray
  // channel) nor the kernel worker. Dispatch here, before the OAuth wait, so
  // the follower paints + connects without that dead time.
  if (!isExtension && (runtimeMode === 'follower' || runtimeMode === 'cherry')) {
    const { mountWcUiFollower } = await import('./wc/wc-follower.js');
    return mountWcUiFollower(app, log, runtimeMode);
  }

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
    (globalThis as ConnectModeGlobal).__slicc_connect_mode = true;
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

  // Wire the page-side delegated-fetch relay BEFORE the kernel worker boots
  // (inside mountWcUiLive) so the first LLM fetch can be served.
  if (extensionDelegate && extLeader) {
    installExtensionFetchDelegate(extLeader.extensionId);
  }

  const { mountWcUiLive } = await import('./wc/wc-live.js');
  return mountWcUiLive(app, log, runtimeMode);
}

/**
 * Absolute-last-resort surface when even the recovery chunk cannot load
 * (offline plus boot failure). Inline on purpose: no imports, error text
 * and a reload only — never a wipe the user can't be warned about.
 */
function renderMinimalRecovery(app: HTMLElement, err: unknown): void {
  const box = document.createElement('div');
  box.style.cssText = 'padding:2rem;text-align:center;font-family:system-ui;';
  const h1 = document.createElement('h1');
  h1.textContent = 'Failed to start';
  const p = document.createElement('p');
  p.textContent = err instanceof Error ? err.message : String(err);
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = 'Reload';
  btn.addEventListener('click', () => location.reload());
  box.append(h1, p, btn);
  app.replaceChildren(box);
}

/**
 * Boot-failure path. The recovery screen — error message, one-click
 * "Reset local data & reload" (same wipe as `nuke`), plain "Reload" —
 * lives in a lazy chunk to keep the main entry lean; page-realm dynamic
 * imports keep working in every observed failure mode (including the
 * module-worker wedge), with {@link renderMinimalRecovery} as the inline
 * fallback. A kernel-ready timeout then runs the worker triage (#1982):
 * a wedged browser gets the restart-first variant instead of a
 * destructive wipe suggestion that cannot fix it.
 */
async function bootRecovery(app: HTMLElement, err: unknown): Promise<void> {
  let renderScreen: typeof import('./boot/recovery-screen.js').renderBootRecoveryScreen;
  try {
    ({ renderBootRecoveryScreen: renderScreen } = await import('./boot/recovery-screen.js'));
  } catch {
    renderMinimalRecovery(app, err);
    return;
  }
  renderScreen(app, err);
  if (!(err instanceof Error && err.message.includes('did not signal ready'))) return;
  try {
    // The default screen above stays interactive while the ≤3 s probes run.
    const { triageModuleWorkerHealth } = await import('./boot/worker-triage.js');
    const verdict = await triageModuleWorkerHealth();
    if (verdict === 'browser-wedged') renderScreen(app, err, { verdict });
  } catch {
    /* triage is best-effort; the default recovery screen stands */
  }
}

main().catch((err) => {
  log.error('Fatal error', err);
  const app = document.getElementById('app');
  if (!app) return;
  void bootRecovery(app, err);
});
