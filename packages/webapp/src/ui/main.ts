import { createLogger } from '../core/index.js';
import { hasChromeRuntimeConnect, isExtensionRealm } from '../core/runtime-env.js';
import { initTelemetry } from '../kernel/telemetry.js';

import { registerProviders } from '../providers/index.js';
import {
  assertLocalBridgeAcceptsToken,
  setBridgeToken,
  setLocalApiBaseUrl,
} from '../shell/proxied-fetch.js';
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
import { releaseTrayLeaderOnFatalBoot } from './tray-leader-fatal.js';

const log = createLogger('main');

type ConnectModeGlobal = {
  __slicc_connect_mode?: unknown;
};

function isFixtureRequested(href: string): boolean {
  try {
    return new URL(href).searchParams.has('ui-fixture');
  } catch {
    return false;
  }
}

function startLiveModelCatalog(): void {
  void import('./boot/setup-model-catalog.js')
    .then(({ setupModelCatalog }) =>
      setupModelCatalog({
        locationHref: window.location.href,
        storage: window.localStorage,
        envBaseUrl: import.meta.env.VITE_WORKER_BASE_URL ?? null,
        isDev: __DEV__,
      })
    )
    .catch(() => {});
}

async function main(): Promise<void> {
  setupPreloadErrorReload();

  const app = document.getElementById('app');
  if (!app) throw new Error('#app element not found');

  const isExtension = isExtensionRealm();

  const runtimeMode = setupFeatureFlagsForPage({
    locationHref: window.location.href,
    storage: window.localStorage,
    envBaseUrl: import.meta.env.VITE_WORKER_BASE_URL ?? null,
    isDev: __DEV__,
    isExtension,
  });

  if (isFixtureRequested(window.location.href)) {
    const { mountWcUiPreview } = await import('./wc/wc-shell.js');
    mountWcUiPreview(app);
    return;
  }

  startFreezeWatchdog();

  setupNukeReloadListener();

  setupStoragePersistence();

  if (runtimeMode !== 'connect') {
    initTelemetry({ isExtensionRealm: isExtension }).catch(() => {});
  }

  const bridge = parseBridgeLaunchParams(window.location.search);

  const extLeader =
    runtimeMode === 'cherry' ? null : parseExtensionLeaderParams(window.location.search);
  const extensionDelegate = !!extLeader && hasChromeRuntimeConnect();
  const swResult = await setupSwRegistration(
    bridge ? { apiBaseUrl: bridge.apiBaseUrl, token: bridge.token } : null,
    extensionDelegate && extLeader ? { extensionId: extLeader.extensionId } : null
  );
  if (swResult === 'reload-pending') return;

  if (!isExtension && (runtimeMode === 'follower' || runtimeMode === 'cherry')) {
    const { bootFollowerFloat } = await import('./wc/wc-follower.js');
    return bootFollowerFloat(app, log, runtimeMode);
  }

  await registerProviders();
  applyProviderDefaults();
  startLiveModelCatalog();

  if (bridge?.apiBaseUrl && !extensionDelegate) {
    setLocalApiBaseUrl(bridge.apiBaseUrl);
    setBridgeToken(bridge.token);

    await assertLocalBridgeAcceptsToken();
  }

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
    const { bootExtensionFloat } = await import('./wc/wc-extension.js');
    return bootExtensionFloat(app, log, runtimeMode === 'extension-detached');
  }

  if (extensionDelegate && extLeader) {
    installExtensionFetchDelegate(extLeader.extensionId);
  }

  const { bootLeaderFloat } = await import('./wc/wc-live.js');
  return bootLeaderFloat(app, log, runtimeMode);
}

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
    const { triageModuleWorkerHealth } = await import('./boot/worker-triage.js');
    const verdict = await triageModuleWorkerHealth();
    if (verdict === 'browser-wedged') renderScreen(app, err, { verdict });
  } catch {}
}

main().catch((err) => {
  log.error('Fatal error', err);

  releaseTrayLeaderOnFatalBoot();
  const app = document.getElementById('app');
  if (!app) return;
  void bootRecovery(app, err);
});
