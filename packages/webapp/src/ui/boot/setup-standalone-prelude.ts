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

import {
  LEADER_EXT_ID_QUERY_NAME,
  LEADER_RUNTIME_QUERY_NAME,
  LEADER_RUNTIME_QUERY_VALUE,
} from '../../../../chrome-extension/src/messages.js';
import type { CherryHostTransport } from '../../cdp/cherry-host-transport.js';
import type { BrowserAPI, CDPTransport } from '../../cdp/index.js';
import type { LickEvent } from '../../scoops/lick-manager.js';
import {
  DEFAULT_PRODUCTION_TRAY_WORKER_BASE_URL,
  DEFAULT_STAGING_TRAY_WORKER_BASE_URL,
  fetchRuntimeConfig,
  resolveTrayRuntimeConfig,
} from '../../scoops/tray-runtime-config.js';
import {
  setBridgeToken,
  setExtensionDelegateId,
  setLocalApiBaseUrl,
} from '../../shell/proxied-fetch.js';
import { showCdpSupersededBanner } from '../cdp-superseded-banner.js';
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

/**
 * Minimal page→worker seam the extension-bridge lick handler depends on —
 * the `OffscreenClient.sendForwardedLick` method that relays a navigate lick
 * into the worker-resident `LickManager` (the same path the tray leader uses).
 */
export interface LickForwardingClient {
  sendForwardedLick(event: LickEvent): void;
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
  /**
   * Per-process bridge token paired with `localApiBaseUrl`. Sent as the
   * `X-Bridge-Token` header on cross-origin /api/* fetches so the local
   * node-server's thin-bridge middleware accepts the call. Forwarded to
   * the kernel worker so its proxied-fetch realm authenticates the same
   * way as the page realm. `null` outside thin-bridge mode.
   */
  bridgeToken: string | null;
  /**
   * Absolute lick-WS URL on the local node-server (e.g.
   * `ws://localhost:5710/licks-ws`), derived from the bridge launch
   * params alongside `localApiBaseUrl`. Forwarded to the kernel worker
   * so the worker-resident `/licks-ws` bridge dials the node-server
   * directly instead of the hosted UI origin (which can't speak the
   * lick wire). `null` outside thin-bridge mode.
   */
  localLickWsUrl: string | null;
  /**
   * Extension id of the thin-bridge leader's extension, resolved from the
   * `?ext=<id>` launch param when running as the externally-connectable
   * hosted leader page. Forwarded to the kernel worker so its proxied-fetch
   * realm can bridge cross-origin shell fetches to the extension Port through
   * the page. `null` outside the thin-bridge extension leader.
   */
  extensionDelegateId: string | null;
  /**
   * Late-binds the kernel client that injects extension-bridge licks into the
   * worker `LickManager`. Set ONLY on the extension-leader CDP path: the
   * bridge transport (and its `onLick` handler) is constructed here, before
   * `spawnKernelWorker` mints the client, so the caller calls this once the
   * client exists. `undefined` on every other path (no extension bridge → no
   * lick seam). No new `chrome.runtime` listener is involved — the lick
   * arrives on the existing welcomed bridge Port.
   */
  attachLickForwardingClient?: (client: LickForwardingClient) => void;
}

function mintInstanceId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `slicc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Parse the extension-leader launch params. Returns the extension id when the
 * URL is the pinned leader tab (`?slicc=leader`) AND carries the SW-injected
 * `?ext=<id>`; otherwise null. Pure + exported for tests.
 */
export function parseExtensionLeaderParams(search: string): { extensionId: string } | null {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(search);
  } catch {
    return null;
  }
  if (params.get(LEADER_RUNTIME_QUERY_NAME) !== LEADER_RUNTIME_QUERY_VALUE) return null;
  const extensionId = params.get(LEADER_EXT_ID_QUERY_NAME);
  if (!extensionId) return null;
  return { extensionId };
}

/** True when the page realm can open a `chrome.runtime` Port (externally
 *  connectable leader tab). `chrome.runtime.id` is intentionally NOT required
 *  — it is undefined on external pages. */
export function hasChromeRuntimeConnect(): boolean {
  const runtime = (globalThis as { chrome?: { runtime?: { connect?: unknown } } }).chrome?.runtime;
  return typeof runtime?.connect === 'function';
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

/**
 * Build the extension-leader `BrowserAPI` over an `ExtensionBridgeTransport`
 * and wire its `onLick` sink. The kernel client that owns the page→worker
 * inject seam doesn't exist yet (`spawnKernelWorker` runs after the prelude),
 * so the `onLick` closure reads a deferred slot the caller late-binds via the
 * returned `attachLickForwardingClient`. The lick rides the existing welcomed
 * bridge Port — no new `chrome.runtime` listener is added to the webapp. The
 * standalone `/licks-ws` navigate mapping is reused so the handoff-approval /
 * upskill-actionable behavior matches that path.
 */
async function createExtensionLeaderBrowser(
  BrowserAPICtor: new (transport?: CDPTransport) => BrowserAPI,
  extensionId: string,
  log: BootStageLogger
): Promise<{
  browser: BrowserAPI;
  attachLickForwardingClient: (client: LickForwardingClient) => void;
}> {
  const { ExtensionBridgeTransport } = await import('../../cdp/extension-bridge-transport.js');
  const { mapNavigatePayloadToLickEvent } = await import('../../scoops/lick-ws-bridge.js');
  // The kernel client that injects licks into the worker `LickManager` is
  // late-bound — `spawnKernelWorker` mints it after this prelude returns. Until
  // it attaches, buffer mapped licks in arrival order instead of dropping them,
  // then flush once on attach (closing the pre-attach drop window). The buffer
  // is bounded so a page re-advertising the same `Link` header on every response
  // during a stuck boot can't grow it unboundedly; on overflow the OLDEST entry
  // is dropped with a single warn. Dedup is still handled downstream by the
  // worker's `navigateFingerprint`, so none is done here.
  const PENDING_LICK_CAP = 50;
  let lickClient: LickForwardingClient | null = null;
  const pendingLicks: LickEvent[] = [];
  let overflowWarned = false;
  const attachLickForwardingClient = (client: LickForwardingClient): void => {
    lickClient = client;
    for (const event of pendingLicks) client.sendForwardedLick(event);
    pendingLicks.length = 0;
  };
  const browser = new BrowserAPICtor(
    new ExtensionBridgeTransport({
      extensionId,
      onLick: (lick) => {
        const event = mapNavigatePayloadToLickEvent(lick as unknown as Record<string, unknown>);
        if (!event) return;
        if (lickClient) {
          lickClient.sendForwardedLick(event);
          return;
        }
        if (pendingLicks.length >= PENDING_LICK_CAP) {
          pendingLicks.shift();
          if (!overflowWarned) {
            overflowWarned = true;
            log.warn(
              `extension-bridge lick buffer overflow (cap ${PENDING_LICK_CAP}); dropping oldest pending licks until the kernel client attaches`
            );
          }
        }
        pendingLicks.push(event);
      },
      onOpenSettings: () => {
        // The side-panel follower handed a provider sign-in to this leader tab
        // (login can't complete in the cross-origin panel iframe). Re-broadcast
        // as a window event the WC nav layer listens for (`wc-nav.ts`), which
        // opens the Settings dialog — same surface as the `add-ai` / error-card
        // paths. The nav layer wires late (after this prelude), but open-settings
        // is user-triggered well after boot, so the listener is always up by then.
        globalThis.dispatchEvent(new CustomEvent('slicc:open-settings-from-panel'));
      },
    })
  );
  await connectWithBoundedRetry(browser, undefined, log);
  return { browser, attachLickForwardingClient };
}

export async function setupStandalonePrelude(
  deps: StandalonePreludeDeps
): Promise<StandalonePreludeResult> {
  const { runtimeMode, envBaseUrl, window: win, log } = deps;
  const isElectronOverlay = runtimeMode === 'electron-overlay';
  // This prelude only builds the page-side runtime (BrowserAPI + CDP). The
  // kernel worker, if any, is spawned later by mountWcUiLive — the follower /
  // cherry paths call this prelude too and never spawn it. (Don't reword this
  // to imply a kernel worker boots here; it doesn't.)
  log.info('setting up standalone page runtime (BrowserAPI + CDP)', { runtimeMode });

  const { BrowserAPI } = await import('../../cdp/index.js');

  await setupSudoStandalone({ log });

  let browser: BrowserAPI;
  let cherryJoinUrl: string | undefined;
  let cherryTransport: CherryHostTransport | undefined;
  let localApiBaseUrl: string | null = null;
  let bridgeToken: string | null = null;
  let localLickWsUrl: string | null = null;
  let extensionDelegateId: string | null = null;
  let attachLickForwardingClient: ((client: LickForwardingClient) => void) | undefined;
  const extLeader =
    runtimeMode === 'cherry' ? null : parseExtensionLeaderParams(win.location.search);

  // Parse the standalone-bridge launch params up front so the local
  // node-server API base + bridge token are wired BEFORE the runtime-config
  // fetch below. In thin-bridge / electron-overlay mode the overlay iframe is
  // served cross-origin from the hosted leader (sliccy.ai), which has no /api
  // surface, so a same-origin `/api/runtime-config` fetch never reaches the
  // node-server that holds the `--join`-derived `trayJoinUrl`. Routing the
  // fetch through `resolveApiUrl()` + `apiHeaders()` (configured here) targets
  // `http://localhost:<servePort>` with `X-Bridge-Token`. The bridge is only
  // meaningful on the non-cherry, non-extension-leader CDP path; elsewhere
  // `parseBridgeLaunchParams` returns null and the fetch stays same-origin
  // (legacy bundled-UI path) — no regression.
  const useExtensionBridge = !!extLeader && hasChromeRuntimeConnect();
  const bridge =
    runtimeMode === 'cherry' || useExtensionBridge
      ? null
      : parseBridgeLaunchParams(win.location.search);
  if (bridge?.apiBaseUrl) {
    localApiBaseUrl = bridge.apiBaseUrl;
    setLocalApiBaseUrl(bridge.apiBaseUrl);
    // Pair the API base with the bridge token: the local node-server enforces
    // `X-Bridge-Token` on cross-origin /api/* in thin-bridge mode (origin
    // allowlist alone is insufficient — any script on sliccy.ai could
    // otherwise reach /api). Token never appears on a query string or in
    // logs; it's only used as a request header.
    bridgeToken = bridge.token;
    setBridgeToken(bridge.token);
  }
  // Forward the lick-WS URL so the kernel worker dials the node-server's
  // `/licks-ws` rather than deriving it from the hosted UI origin. Stays null
  // when the bridge URL didn't parse — the worker falls back to the legacy
  // same-origin assumption.
  if (bridge?.lickWsUrl) {
    localLickWsUrl = bridge.lickWsUrl;
  }

  const runtimeConfig = await fetchRuntimeConfig();
  const runtimeDefaultWorkerBaseUrl = shouldUseRuntimeModeTrayDefaults(
    runtimeMode,
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

  if (runtimeMode === 'cherry') {
    const { setupCherryFollower } = await import('../main-cherry.js');
    const cherry = await setupCherryFollower();
    browser = cherry.browser;
    cherryJoinUrl = cherry.joinUrl;
    cherryTransport = cherry.transport;
  } else if (extLeader && hasChromeRuntimeConnect()) {
    log.info('Routing CDP through the extension bridge (leader tab)');
    const leader = await createExtensionLeaderBrowser(BrowserAPI, extLeader.extensionId, log);
    browser = leader.browser;
    attachLickForwardingClient = leader.attachLickForwardingClient;
    // Thin-bridge: this page realm can `chrome.runtime.connect(<extensionId>)`
    // to the extension's fetch-proxy. Record the id locally (set on the page
    // realm + forwarded to the kernel worker) so cross-origin shell fetches
    // route through the extension's host_permissions CORS bypass instead of
    // the (absent) local /api/fetch-proxy.
    extensionDelegateId = extLeader.extensionId;
    setExtensionDelegateId(extLeader.extensionId);
  } else {
    browser = new BrowserAPI();
    // `bridge` (parsed up front, before the runtime-config fetch) carries the
    // local node-server origin + token already wired into `setLocalApiBaseUrl`
    // / `setBridgeToken` above. Here we only need its CDP-routing fields.
    if (bridge) {
      log.info('Routing CDP through local standalone bridge', {
        url: bridge.url,
        role: bridge.role ?? '(unset)',
      });
    }
    const connectOpts = bridge ? { url: bridge.url, protocols: bridge.subprotocol } : undefined;
    // Overlay followers (Electron auto-follow tabs) MUST NOT dial /cdp —
    // that capability belongs to the pinned leader tab. Skip the eager
    // connect so multiple overlay tabs don't all race to drive Chrome.
    if (bridge?.role === 'follower') {
      log.info('Skipping CDP connect for follower overlay tab');
      // Prime (but don't dial) the bridge connect options. The follower
      // overlay stays off the single-client `/cdp` slot at boot, but if it
      // later acts as a tray follower its target federation runs
      // `BrowserAPI.listPages()` → `ensureConnected()`. Without these options
      // captured, that lazy connect falls back to `getDefaultCdpUrl()` (the
      // hosted-leader origin, which has no `/cdp`) and the listing fails, so
      // the follower's local pages never reach the leader's `list-tabs`.
      // `connectOpts` is always defined here (a follower role implies a bridge).
      browser.primeConnectOptions(connectOpts);
    } else {
      // Bounded retry — the packaged CLI launches Chrome before the local
      // /cdp bridge has finished `server.listen()` in some races, so the
      // very first connect can lose to the bridge by a few hundred ms.
      // Retry with capped backoff so we recover from the boot race without
      // hanging boot if the bridge truly never comes up.
      await connectWithBoundedRetry(browser, connectOpts, log);
      // If another SLICC tab/window later seizes the single CDP proxy slot, the
      // reconnect guard stops this tab from re-dialing (which would restart the
      // eviction war). Surface that to the user with a banner rather than letting
      // browser automation fail silently here. Standalone-only — the page realm
      // owns the real `/cdp` client; cherry/extension floats never supersede.
      browser.setCdpSupersededHandler(() => showCdpSupersededBanner(win.document));
    }
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
    bridgeToken,
    localLickWsUrl,
    extensionDelegateId,
    attachLickForwardingClient,
  };
}
