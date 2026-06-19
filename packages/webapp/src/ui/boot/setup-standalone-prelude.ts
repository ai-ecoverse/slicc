/**
 * `setup-standalone-prelude.ts` — early boot for the standalone-worker
 * float: installs the sudo manual-test hook, resolves the tray
 * runtime-config (staging vs. production worker base URL),
 * instantiates the page-side `BrowserAPI` (or wires the cherry
 * follower transport when running embedded), proactively connects
 * the underlying `CDPClient`, publishes `globalThis.__slicc_browser`,
 * and mints the per-instance `instanceId` used to scope panel-RPC
 * channels.
 *
 * Extracted verbatim from `mainStandaloneWorker` (~main.ts:264–358).
 * The CDP eager-connect is load-bearing: the worker-side `BrowserAPI`
 * has its own `ensureConnected()`, but every `cdp-cmd` envelope it
 * forwards lands in `startPageCdpForwarder` → `realTransport.send(...)`.
 * Without the eager connect the first agent CDP command throws
 * "CDP client is not connected".
 */

import type { CherryHostTransport } from '../../cdp/cherry-host-transport.js';
import type { BrowserAPI, CDPTransport } from '../../cdp/index.js';
import {
  DEFAULT_PRODUCTION_TRAY_WORKER_BASE_URL,
  DEFAULT_STAGING_TRAY_WORKER_BASE_URL,
  fetchRuntimeConfig,
  resolveTrayRuntimeConfig,
} from '../../scoops/tray-runtime-config.js';
import { setLocalApiBaseUrl } from '../../shell/proxied-fetch.js';
import type { UiRuntimeMode } from '../runtime-mode.js';
import { shouldUseRuntimeModeTrayDefaults } from '../runtime-mode.js';
import { parseBridgeLaunchParams } from './bridge-launch-params.js';
import { setupSudoStandalone } from './setup-sudo.js';
import type { BootStageLogger } from './types.js';

export interface StandalonePreludeDeps {
  runtimeMode: UiRuntimeMode;
  envBaseUrl: string | null;
  window: Window;
  log: BootStageLogger;
}

export interface StandalonePreludeResult {
  browser: BrowserAPI;
  realCdpTransport: CDPTransport;
  cherryJoinUrl?: string;
  cherryTransport?: CherryHostTransport;
  instanceId: string;
  isElectronOverlay: boolean;
  /**
   * Local node-server origin to use for proxied /api/* requests in
   * thin-bridge mode (where the hosted leader serves the UI but has no
   * local /api surface). `null` when not running behind a bridge.
   * Forwarded to the kernel worker so its proxied-fetch realm targets
   * the same origin as the page realm.
   */
  localApiBaseUrl: string | null;
}

function mintInstanceId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `slicc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Backoff schedule for the initial CDP bridge connect (ms). Total bounded
 * window ≈ 3.1s — long enough to cover the worst observed packaged-CLI
 * race (Chrome opens the hosted leader before `server.listen()` finishes
 * binding), short enough not to noticeably delay boot when the bridge is
 * genuinely down. Exported for tests.
 */
export const CDP_BRIDGE_CONNECT_RETRY_DELAYS_MS: readonly number[] = [100, 200, 400, 800, 1600];

export async function connectWithBoundedRetry(
  browser: BrowserAPI,
  options: Parameters<BrowserAPI['connect']>[0],
  log: BootStageLogger,
  delays: readonly number[] = CDP_BRIDGE_CONNECT_RETRY_DELAYS_MS,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))
): Promise<void> {
  const attempts = delays.length + 1;
  let lastError: unknown = null;
  for (let i = 0; i < attempts; i++) {
    try {
      await browser.connect(options);
      if (i > 0) {
        log.info('CDP bridge connect succeeded after retry', { attempt: i + 1 });
      }
      return;
    } catch (err) {
      lastError = err;
      if (i < delays.length) {
        const delay = delays[i] ?? 0;
        await sleep(delay);
      }
    }
  }
  log.warn(
    'Initial CDP connect failed after retries; worker-forwarded commands will retry on demand',
    lastError instanceof Error ? lastError.message : String(lastError)
  );
}

export async function setupStandalonePrelude(
  deps: StandalonePreludeDeps
): Promise<StandalonePreludeResult> {
  const { runtimeMode, envBaseUrl, window: win, log } = deps;
  const isElectronOverlay = runtimeMode === 'electron-overlay';
  log.info('starting standalone with kernel worker');

  const { BrowserAPI } = await import('../../cdp/index.js');

  await setupSudoStandalone({ log });

  const runtimeConfig = await fetchRuntimeConfig();
  const runtimeDefaultWorkerBaseUrl = shouldUseRuntimeModeTrayDefaults(
    isElectronOverlay ? 'electron-overlay' : 'standalone',
    runtimeConfig !== null
  )
    ? __DEV__
      ? DEFAULT_STAGING_TRAY_WORKER_BASE_URL
      : DEFAULT_PRODUCTION_TRAY_WORKER_BASE_URL
    : null;
  await resolveTrayRuntimeConfig({
    locationHref: win.location.href,
    storage: win.localStorage,
    envBaseUrl,
    defaultWorkerBaseUrl: runtimeDefaultWorkerBaseUrl,
    runtimeConfigFetcher: async () => runtimeConfig,
  });

  let browser: BrowserAPI;
  let cherryJoinUrl: string | undefined;
  let cherryTransport: CherryHostTransport | undefined;
  let localApiBaseUrl: string | null = null;
  if (runtimeMode === 'cherry') {
    const { setupCherryFollower } = await import('../main-cherry.js');
    const cherry = await setupCherryFollower();
    browser = cherry.browser;
    cherryJoinUrl = cherry.joinUrl;
    cherryTransport = cherry.transport;
  } else {
    browser = new BrowserAPI();
    const bridge = parseBridgeLaunchParams(win.location.search);
    if (bridge) {
      log.info('Routing CDP through local standalone bridge', { url: bridge.url });
      // Thin-bridge: the hosted leader at sliccy.ai has no /api surface,
      // so route proxied /api/* requests at the local node-server origin
      // we just learned about from the bridge launch params. The kernel
      // worker has its own proxied-fetch realm; the caller forwards this
      // value into `spawnKernelWorker`.
      if (bridge.apiBaseUrl) {
        localApiBaseUrl = bridge.apiBaseUrl;
        setLocalApiBaseUrl(bridge.apiBaseUrl);
      }
    }
    const connectOpts = bridge ? { url: bridge.url, protocols: bridge.subprotocol } : undefined;
    // Bounded retry — the packaged CLI launches Chrome before the local
    // /cdp bridge has finished `server.listen()` in some races, so the
    // very first connect can lose to the bridge by a few hundred ms.
    // Retry with capped backoff so we recover from the boot race without
    // hanging boot if the bridge truly never comes up.
    await connectWithBoundedRetry(browser, connectOpts, log);
  }
  const realCdpTransport = browser.getTransport();

  // Expose the page-side BrowserAPI so the OAuth intercept launcher
  // (active-transport.ts) can resolve a CDP transport from the main
  // thread — the kernel-worker publishes its own __slicc_browser in
  // host.ts, but the settings dialog and OAuth click handlers run on
  // the page realm where that global isn't visible.
  (globalThis as Record<string, unknown>).__slicc_browser = browser;

  return {
    browser,
    realCdpTransport,
    cherryJoinUrl,
    cherryTransport,
    instanceId: mintInstanceId(),
    isElectronOverlay,
    localApiBaseUrl,
  };
}
