import { LEADER_EXT_ID_QUERY_NAME } from '@slicc/shared-ts';
import {
  LEADER_RUNTIME_QUERY_NAME,
  LEADER_RUNTIME_QUERY_VALUE,
} from '../../base/leader-runtime-query.js';
import {
  CdpBridgeRejectedError,
  classifyCdpConnectFailure,
} from '../../cdp/cdp-reconnect-policy.js';
import type { CherryHostTransport } from '../../cdp/cherry-host-transport.js';
import type { BrowserAPI, CDPTransport } from '../../cdp/index.js';
import { hasChromeRuntimeConnect } from '../../core/runtime-env.js';

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
import { showCdpBridgeRejectedBanner, showCdpSupersededBanner } from '../cdp-superseded-banner.js';
import type { UiRuntimeMode } from '../runtime-mode.js';
import { shouldUseRuntimeModeTrayDefaults } from '../runtime-mode.js';
import { type BridgeLaunchParams, parseBridgeLaunchParams } from './bridge-launch-params.js';
import { setupSudoStandalone } from './setup-sudo.js';
import type { BootStageLogger } from './types.js';

export interface StandalonePreludeDeps {
  runtimeMode: UiRuntimeMode;
  envBaseUrl: string | null;
  window: Window;
  log: BootStageLogger;

  sleep?: (ms: number) => Promise<void>;
}

export interface LickForwardingClient {
  sendForwardedLick(event: LickEvent): void;
}

export interface StandalonePreludeResult {
  browser: BrowserAPI;
  realCdpTransport: CDPTransport;

  hasLocalCdpSurface: boolean;
  cherryJoinUrl?: string;
  cherryTransport?: CherryHostTransport;
  instanceId: string;
  isElectronOverlay: boolean;

  localApiBaseUrl: string | null;

  bridgeToken: string | null;

  localLickWsUrl: string | null;

  extensionDelegateId: string | null;

  attachLickForwardingClient?: (client: LickForwardingClient) => void;
}

function mintInstanceId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `slicc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

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

export { hasChromeRuntimeConnect } from '../../core/runtime-env.js';

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
      if (err instanceof CdpBridgeRejectedError) {
        log.error('CDP bridge rejected the session token; stopped reconnecting', err.message);
        return;
      }
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

async function createExtensionLeaderBrowser(
  BrowserAPICtor: new (transport?: CDPTransport) => BrowserAPI,
  extensionId: string,
  log: BootStageLogger
): Promise<{
  browser: BrowserAPI;
  attachLickForwardingClient: (client: LickForwardingClient) => void;
}> {
  const { ExtensionBridgeTransport } = await import('../../cdp/extension-bridge-transport.js');
  const { mapDiscoveryPayloadToLickEvent, mapNavigatePayloadToLickEvent } = await import(
    '../../scoops/lick-ws-bridge.js'
  );

  const PENDING_LICK_CAP = 50;
  let lickClient: LickForwardingClient | null = null;
  const pendingLicks: LickEvent[] = [];
  let overflowWarned = false;
  const attachLickForwardingClient = (client: LickForwardingClient): void => {
    lickClient = client;
    for (const event of pendingLicks) client.sendForwardedLick(event);
    pendingLicks.length = 0;
  };

  const pushMappedLick = (event: LickEvent | null): void => {
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
  };
  const browser = new BrowserAPICtor(
    new ExtensionBridgeTransport({
      extensionId,
      onLick: (lick) => {
        pushMappedLick(mapNavigatePayloadToLickEvent(lick));
      },
      onDiscovery: (discovery) => {
        pushMappedLick(mapDiscoveryPayloadToLickEvent(discovery));
      },
      onOpenSettings: () => {
        globalThis.dispatchEvent(new CustomEvent('slicc:open-settings-from-panel'));
      },
    })
  );
  await connectWithBoundedRetry(browser, undefined, log);
  return { browser, attachLickForwardingClient };
}

async function connectStandaloneCdp(options: {
  browser: BrowserAPI;
  bridge: BridgeLaunchParams | null;
  log: BootStageLogger;
  document: Document;
  sleep?: (ms: number) => Promise<void>;
}): Promise<void> {
  const { browser, bridge, log, document, sleep } = options;

  browser.setCdpConnectFailureClassifier(classifyCdpConnectFailure);
  browser.setCdpBridgeRejectedHandler(() => showCdpBridgeRejectedBanner(document));
  if (bridge) {
    log.info('Routing CDP through local standalone bridge', {
      url: bridge.url,
      role: bridge.role ?? '(unset)',
    });
  }
  const connectOpts = bridge ? { url: bridge.url, protocols: bridge.subprotocol } : undefined;

  if (bridge?.role === 'follower') {
    log.info('Skipping CDP connect for follower overlay tab');

    browser.primeConnectOptions(connectOpts);
    return;
  }

  await connectWithBoundedRetry(browser, connectOpts, log, undefined, sleep);

  browser.setCdpSupersededHandler(() => showCdpSupersededBanner(document));
}

export async function setupStandalonePrelude(
  deps: StandalonePreludeDeps
): Promise<StandalonePreludeResult> {
  const { runtimeMode, envBaseUrl, window: win, log, sleep } = deps;
  const isElectronOverlay = runtimeMode === 'electron-overlay';

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

  const useExtensionBridge = !!extLeader && hasChromeRuntimeConnect();
  const bridge =
    runtimeMode === 'cherry' || useExtensionBridge
      ? null
      : parseBridgeLaunchParams(win.location.search);
  if (bridge?.apiBaseUrl) {
    localApiBaseUrl = bridge.apiBaseUrl;
    setLocalApiBaseUrl(bridge.apiBaseUrl);

    bridgeToken = bridge.token;
    setBridgeToken(bridge.token);
  }

  if (bridge?.lickWsUrl) {
    localLickWsUrl = bridge.lickWsUrl;
  }

  const hasLocalCdpSurface = runtimeMode === 'cherry' || useExtensionBridge || bridge !== null;

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

    extensionDelegateId = extLeader.extensionId;
    setExtensionDelegateId(extLeader.extensionId);
  } else {
    browser = new BrowserAPI();

    await connectStandaloneCdp({
      browser,
      bridge,
      log,
      document: win.document,
      sleep,
    });
  }
  const realCdpTransport = browser.getUnderlyingTransport();

  (globalThis as unknown as { __slicc_browser: BrowserAPI }).__slicc_browser = browser;

  return {
    browser,
    realCdpTransport,
    hasLocalCdpSurface,
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
