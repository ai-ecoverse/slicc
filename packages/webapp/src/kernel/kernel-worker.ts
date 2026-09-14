/// <reference lib="webworker" />

import { setPageLoadedAt } from '../base/page-load-time.js';
import { SPRINKLE_ROOTS } from '../base/sprinkle-roots.js';
import { BrowserAPI } from '../cdp/browser-api.js';
import { createPanelRpcTrayProvider } from '../cdp/panel-rpc-tray-provider.js';
import type { FeatureFlagFloat } from '../core/feature-flags.js';
import { initFeatureFlagsFromRemoteCache } from '../core/feature-flags-cache.js';
import {
  broadcastIfMixedBuildGraph,
  broadcastIfStaleAssetError,
  setStaleAssetInstanceId,
} from '../core/stale-asset-channel.js';
import type { VirtualFS } from '../fs/index.js';

import { registerProviders } from '../providers/index.js';
import {
  getLocalApiBaseUrl,
  setBridgeToken,
  setExtensionDelegateId,
  setLocalApiBaseUrl,
} from '../shell/proxied-fetch.js';
import type { SprinkleManagerProxySurface } from '../shell/sprinkle-manager-handle.js';
import { WorkerCdpProxy } from './cdp-worker-proxy.js';
import { Bridge } from './facade.js';
import { createKernelHost, type KernelHost } from './host.js';
import { makeSameOriginBypassFetch } from './kernel-worker-fetch-bypass.js';
import { makeKernelWorkerInitGuard } from './kernel-worker-init-guard.js';
import { getPanelRpcClient, type PanelRpcClient } from './panel-rpc.js';
import { createPanelTerminalHost } from './panel-terminal-host.js';
import { setSyncFsBridgeEnabled } from './realm/sync-fs-enabled.js';
import type { SyncFsNonce } from './realm/sync-fs-wire.js';
import { initTelemetry, trackError } from './telemetry.js';
import { createBridgeMessageChannelTransport } from './transport-message-channel.js';
import { startVfsRpcHost } from './vfs-rpc-host.js';

declare const self: DedicatedWorkerGlobalScope;

export interface KernelWorkerInitMsg {
  type: 'kernel-worker-init';
  kernelPort: MessagePort;
  cdpPort: MessagePort;
  localStorageSeed?: Record<string, string>;

  instanceId?: string;

  localApiBaseUrl?: string | null;

  syncFsBridgeEnabled?: boolean;

  syncFsChannelNonce?: SyncFsNonce | null;

  bridgeToken?: string | null;

  localLickWsUrl?: string | null;

  extensionDelegateId?: string | null;

  pageBuildId?: string | null;

  pageLoadedAt?: number | null;

  flagFloat?: FeatureFlagFloat | null;

  appPageUrl?: string | null;
}

export interface KernelWorkerReadyMsg {
  type: 'kernel-worker-ready';
}

export interface KernelWorkerBootProgressMsg {
  type: 'kernel-worker-boot-progress';
  stage?: string;
}

export interface KernelWorkerBootErrorMsg {
  type: 'kernel-worker-boot-error';
  message: string;

  code?: string;
  stack?: string;
}

function installFetchBypass(): void {
  const orig = globalThis.fetch;
  if (!orig) return;
  const selfOrigin = self?.location ? self.location.origin : undefined;
  globalThis.fetch = makeSameOriginBypassFetch(
    orig.bind(globalThis),
    selfOrigin,
    resolveBridgeProxyOrigin
  );
}

function resolveBridgeProxyOrigin(): string | null {
  const baseUrl = getLocalApiBaseUrl();
  if (!baseUrl) return null;
  try {
    return new URL(baseUrl).origin;
  } catch {
    return null;
  }
}

function installLocalStorageShim(seed: Record<string, string>): void {
  const store = new Map<string, string>(Object.entries(seed));
  const shim: Storage = {
    get length(): number {
      return store.size;
    },
    key(index: number): string | null {
      return Array.from(store.keys())[index] ?? null;
    },
    getItem(key: string): string | null {
      return store.has(key) ? store.get(key)! : null;
    },
    setItem(key: string, value: string): void {
      store.set(key, value);
    },
    removeItem(key: string): void {
      store.delete(key);
    },
    clear(): void {
      store.clear();
    },
  };

  Object.defineProperty(globalThis, 'localStorage', {
    value: shim,
    configurable: true,
    writable: true,
  });
}

let host: KernelHost | null = null;
let stopTerminalHost: (() => void) | null = null;
let stopVfsRpcHost: (() => void) | null = null;
let stopSpeechAssetsResponder: (() => void) | null = null;
let panelRpcClient: PanelRpcClient | null = null;

interface KernelWorkerGlobals {
  __slicc_sprinkleManager?: SprinkleManagerProxySurface;
  __slicc_panelRpc?: PanelRpcClient;
}

const initGuard = makeKernelWorkerInitGuard((init) => boot(init));

self.addEventListener('message', (event: MessageEvent) => {
  const data = event.data as { type?: string };
  if (data?.type !== 'kernel-worker-init') return;
  initGuard.handle(event.data as KernelWorkerInitMsg);
});

function checkMixedBuildGraph(init: KernelWorkerInitMsg): () => void {
  const mixed = broadcastIfMixedBuildGraph(init.pageBuildId, __SLICC_BUILD_ID__);
  return () => {
    if (mixed) {
      trackError('mixed-build-graph', `page ${init.pageBuildId} worker ${__SLICC_BUILD_ID__}`);
    }
  };
}

function configureWorkerEnvironment(init: KernelWorkerInitMsg): void {
  installFetchBypass();

  setLocalApiBaseUrl(init.localApiBaseUrl ?? null);
  setBridgeToken(init.bridgeToken ?? null);
  setSyncFsBridgeEnabled(init.syncFsBridgeEnabled ?? false);

  setPageLoadedAt(init.pageLoadedAt ?? null);

  setExtensionDelegateId(init.extensionDelegateId ?? null);

  installLocalStorageShim(init.localStorageSeed ?? {});

  if (init.flagFloat) initFeatureFlagsFromRemoteCache(init.flagFloat);
}

async function boot(init: KernelWorkerInitMsg): Promise<void> {
  setStaleAssetInstanceId(init.instanceId);
  const beaconMixedBuildGraph = checkMixedBuildGraph(init);

  const emitBootProgress = (stage: string): void => {
    init.kernelPort.postMessage({
      type: 'kernel-worker-boot-progress',
      stage,
    } satisfies KernelWorkerBootProgressMsg);
  };
  try {
    configureWorkerEnvironment(init);

    void initTelemetry()
      .then(beaconMixedBuildGraph)
      .catch(() => {});

    await registerProviders();
    emitBootProgress('providers-registered');

    const bridgeTransport = createBridgeMessageChannelTransport(init.kernelPort);
    const bridge = new Bridge(bridgeTransport);
    const callbacks = Bridge.createCallbacks(bridge);

    const cdpProxy = new WorkerCdpProxy(init.cdpPort);
    await cdpProxy.connect();
    emitBootProgress('cdp-connected');
    const browser = new BrowserAPI(cdpProxy);

    const stubContainer = {} as unknown as HTMLElement;

    host = await createKernelHost({
      container: stubContainer,
      browser,
      bridge,
      callbacks,
      logger: console,
      localLickWsUrl: init.localLickWsUrl ?? null,
      syncFsChannelNonce: init.syncFsChannelNonce ?? null,
      appPageUrl: init.appPageUrl ?? null,

      onBootProgress: emitBootProgress,
    });

    const { createSprinkleManagerProxyOverChannel } = await import(
      '../scoops/sprinkle-bridge-channel.js'
    );
    const sprinkleProxy = createSprinkleManagerProxyOverChannel({ instanceId: init.instanceId });
    (globalThis as KernelWorkerGlobals).__slicc_sprinkleManager = sprinkleProxy;

    const watcher = host.sharedFs?.getWatcher();
    if (watcher) {
      let reloadTimer: ReturnType<typeof setTimeout> | null = null;
      const pendingReloads = new Set<string>();
      for (const root of SPRINKLE_ROOTS) {
        watcher.watch(
          root,
          (path) => path.endsWith('.shtml'),
          (events) => {
            for (const e of events) {
              const base = e.path
                .split('/')
                .pop()
                ?.replace(/\.shtml$/, '');
              if (base) pendingReloads.add(base);
            }
            if (reloadTimer) return;
            reloadTimer = setTimeout(() => {
              reloadTimer = null;
              for (const name of pendingReloads) {
                sprinkleProxy.reload(name).catch(() => {});
              }
              pendingReloads.clear();
            }, 300);
          }
        );
      }
    }

    const { createPanelRpcClient } = await import('./panel-rpc.js');
    panelRpcClient = createPanelRpcClient({ instanceId: init.instanceId });
    (globalThis as KernelWorkerGlobals).__slicc_panelRpc = panelRpcClient;

    browser.setTrayTargetProvider(createPanelRpcTrayProvider(getPanelRpcClient));

    const surfaces = await startSharedFsSurfaces({
      host,
      transport: bridgeTransport,
      browser,
      instanceId: init.instanceId,
    });
    if (surfaces) {
      stopTerminalHost = surfaces.stopTerminalHost;
      stopVfsRpcHost = surfaces.stopVfsRpcHost;
      stopSpeechAssetsResponder = surfaces.stopSpeechAssetsResponder;
    }

    init.kernelPort.postMessage({ type: 'kernel-worker-ready' } satisfies KernelWorkerReadyMsg);
  } catch (err) {
    handleBootFailure(init.kernelPort, err);
  }
}

function handleBootFailure(kernelPort: MessagePort, err: unknown): never {
  broadcastIfStaleAssetError(err);
  try {
    const message = err instanceof Error ? err.message : String(err);
    const code = (err as { code?: unknown } | null)?.code;
    kernelPort.postMessage({
      type: 'kernel-worker-boot-error',
      message,
      ...(typeof code === 'string' ? { code } : {}),
      ...(err instanceof Error && err.stack ? { stack: err.stack } : {}),
    } satisfies KernelWorkerBootErrorMsg);
  } catch {}
  throw err;
}

type BridgeTransport = Parameters<typeof createPanelTerminalHost>[0]['transport'];

interface SharedFsSurfaces {
  stopTerminalHost: () => void;
  stopVfsRpcHost: () => void;
  stopSpeechAssetsResponder: () => void;
}

async function startSharedFsSurfaces(deps: {
  host: KernelHost;
  transport: BridgeTransport;
  browser: BrowserAPI;
  instanceId: string | undefined;
}): Promise<SharedFsSurfaces | null> {
  const sharedFs = deps.host.sharedFs;
  if (!sharedFs) {
    console.warn('[kernel-worker] shared FS unavailable; terminal sessions will fail to open');
    return null;
  }

  const hasLocalNodeServer = () => deps.host.capabilityBroker.adapter === 'node-rest';
  const handle = createPanelTerminalHost({
    transport: deps.transport,
    fs: sharedFs,
    browser: deps.browser,
    processManager: deps.host.processManager,

    sudoManager: deps.host.orchestrator.getSudoManager(),
    webhook: { hasLocalNodeServer },
    crontask: { hasLocalNodeServer },
    logger: console,
  });
  const vfsHandle = startVfsRpcHost({
    transport: deps.transport,
    client: sharedFs,
    writableClient: sharedFs,

    getWatcher: () => sharedFs.getWatcher(),
    logger: console,
  });
  const stopSpeechAssetsResponder = await startSpeechAssetsResponder(sharedFs, deps.instanceId);
  return {
    stopTerminalHost: handle.stop,
    stopVfsRpcHost: vfsHandle.stop,
    stopSpeechAssetsResponder,
  };
}

async function startSpeechAssetsResponder(
  sharedFs: VirtualFS,
  instanceId: string | undefined
): Promise<() => void> {
  const { installSpeechAssetsResponder } = await import('./speech-assets-bridge.js');
  const { ensureSpeechAssetsStaged } = await import('../speech/ensure-speech-assets.js');
  const { createProxiedFetch } = await import('../shell/proxied-fetch.js');
  const speechFetch = createProxiedFetch();
  return installSpeechAssetsResponder({
    instanceId,
    ensure: (onProgress) =>
      ensureSpeechAssetsStaged({ fs: sharedFs, fetch: speechFetch }, onProgress),
  });
}

self.addEventListener('message', (event: MessageEvent) => {
  const data = event.data as { type?: string };
  if (data?.type !== 'kernel-worker-shutdown') return;
  stopTerminalHost?.();
  stopTerminalHost = null;
  stopVfsRpcHost?.();
  stopVfsRpcHost = null;
  stopSpeechAssetsResponder?.();
  stopSpeechAssetsResponder = null;
  panelRpcClient?.dispose();
  panelRpcClient = null;
  void host?.dispose();
});
