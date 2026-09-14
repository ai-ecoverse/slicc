import type { CDPTransport } from '../cdp/transport.js';
import type { FeatureFlagFloat } from '../core/feature-flags.js';
import { startPageCdpForwarder } from './cdp-page-forwarder.js';
import type {
  KernelWorkerBootErrorMsg,
  KernelWorkerBootProgressMsg,
  KernelWorkerInitMsg,
  KernelWorkerReadyMsg,
} from './kernel-worker.js';
import type { SyncFsNonce } from './realm/sync-fs-wire.js';
import { createPanelMessageChannelTransport } from './transport-message-channel.js';

export type PanelKernelTransport = ReturnType<typeof createPanelMessageChannelTransport>;

export interface WorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  terminate(): void;

  addEventListener?(type: 'error', listener: () => void): void;
}

export interface KernelWorkerSpawnOptions<TClient> {
  workerUrl?: string | URL;

  realCdpTransport: CDPTransport;

  reconnectCdp?: () => Promise<void>;

  makeClient: (transport: PanelKernelTransport) => TClient;

  readyTimeoutMs?: number;

  localStorageSeed?: Record<string, string>;

  instanceId?: string;

  localApiBaseUrl?: string | null;

  bridgeToken?: string | null;

  syncFsBridgeEnabled?: boolean;

  syncFsChannelNonce?: SyncFsNonce | null;

  localLickWsUrl?: string | null;

  extensionDelegateId?: string | null;

  flagFloat?: FeatureFlagFloat | null;

  onWorkerScriptError?: () => void;

  onReadyStall?: (info: ReadyStallInfo) => void;

  readyStallLimit?: number;

  onLateReady?: () => void;
}

export interface ReadyStallInfo {
  elapsedMs: number;

  stalls: number;
}

export interface KernelWorkerBootstrapOptions<TClient> {
  worker: WorkerLike;
  realCdpTransport: CDPTransport;

  reconnectCdp?: () => Promise<void>;

  makeClient: (transport: PanelKernelTransport) => TClient;
  readyTimeoutMs?: number;
  localStorageSeed?: Record<string, string>;

  instanceId?: string;

  localApiBaseUrl?: string | null;

  syncFsBridgeEnabled?: boolean;

  syncFsChannelNonce?: SyncFsNonce | null;

  bridgeToken?: string | null;

  localLickWsUrl?: string | null;

  extensionDelegateId?: string | null;

  flagFloat?: FeatureFlagFloat | null;

  onWorkerScriptError?: () => void;

  onReadyStall?: (info: ReadyStallInfo) => void;

  readyStallLimit?: number;

  onLateReady?: () => void;
}

export function collectLocalStorageSeed(): Record<string, string> {
  const seed: Record<string, string> = {};
  if (typeof localStorage === 'undefined') return seed;
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key === null) continue;
    const value = localStorage.getItem(key);
    if (value === null) continue;
    seed[key] = value;
  }
  return seed;
}

export interface SpawnedKernelHost<TClient> {
  client: TClient;

  ready: Promise<void>;

  dispose(): void;
}

function watchKernelReady(
  port: MessagePort,
  options: Pick<
    KernelWorkerBootstrapOptions<unknown>,
    'onReadyStall' | 'readyStallLimit' | 'onLateReady'
  >,
  readyTimeoutMs: number
): { ready: Promise<void>; cleanup: () => void } {
  let cleanupReady: () => void = () => {};
  const ready = new Promise<void>((resolve, reject) => {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let listener: ((event: MessageEvent) => void) | null = null;

    const clearTimer = (): void => {
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
    };

    const readyStallLimit = Math.max(1, options.readyStallLimit ?? (options.onReadyStall ? 3 : 1));
    const startedAt = Date.now();
    let stalls = 0;
    let timedOut = false;

    const armReadyTimeout = (): void => {
      clearTimer();
      timeoutId = setTimeout(() => {
        stalls += 1;
        if (stalls < readyStallLimit) {
          options.onReadyStall?.({ elapsedMs: Date.now() - startedAt, stalls });
          armReadyTimeout();
          return;
        }
        if (options.onLateReady) {
          clearTimer();
        } else {
          cleanupReady();
        }
        timedOut = true;
        reject(
          new Error(
            `Kernel worker did not signal ready within ${readyTimeoutMs * readyStallLimit}ms`
          )
        );
      }, readyTimeoutMs);
    };

    cleanupReady = (): void => {
      if (listener !== null) {
        port.removeEventListener('message', listener as EventListener);
        listener = null;
      }
      clearTimer();
    };
    listener = (event: MessageEvent): void => {
      const data = event.data as
        | Partial<KernelWorkerReadyMsg>
        | Partial<KernelWorkerBootErrorMsg>
        | Partial<KernelWorkerBootProgressMsg>
        | null;

      if (data?.type === 'kernel-worker-boot-progress') {
        stalls = 0;
        armReadyTimeout();
        return;
      }
      if (data?.type === 'kernel-worker-ready') {
        cleanupReady();
        if (timedOut) {
          options.onLateReady?.();
          return;
        }
        resolve();
        return;
      }

      if (data?.type === 'kernel-worker-boot-error') {
        cleanupReady();
        const detail = (data as Partial<KernelWorkerBootErrorMsg>).message ?? 'unknown error';
        const code = (data as Partial<KernelWorkerBootErrorMsg>).code;
        const error = new Error(`Kernel worker boot failed: ${detail}`);
        if (code) (error as Error & { code?: string }).code = code;
        reject(error);
      }
    };
    port.addEventListener('message', listener as EventListener);
    armReadyTimeout();
  });
  return { ready, cleanup: () => cleanupReady() };
}

export function bootstrapKernelWorker<TClient>(
  options: KernelWorkerBootstrapOptions<TClient>
): SpawnedKernelHost<TClient> {
  const { worker, realCdpTransport } = options;
  const readyTimeoutMs = options.readyTimeoutMs ?? 30_000;
  const localStorageSeed = options.localStorageSeed ?? {};

  const kernelChannel = new MessageChannel();
  const cdpChannel = new MessageChannel();

  const panelTransport = createPanelMessageChannelTransport(kernelChannel.port1);
  const client = options.makeClient(panelTransport);

  if (options.onWorkerScriptError) {
    options.worker.addEventListener?.('error', () => options.onWorkerScriptError!());
  }

  const stopForwarder = startPageCdpForwarder(cdpChannel.port1, realCdpTransport, {
    ...(options.reconnectCdp ? { reconnect: options.reconnectCdp } : {}),
  });

  const { ready, cleanup: cleanupReady } = watchKernelReady(
    kernelChannel.port1,
    options,
    readyTimeoutMs
  );

  const init: KernelWorkerInitMsg = {
    type: 'kernel-worker-init',
    kernelPort: kernelChannel.port2,
    cdpPort: cdpChannel.port2,
    localStorageSeed,
    instanceId: options.instanceId,
    localApiBaseUrl: options.localApiBaseUrl ?? null,
    bridgeToken: options.bridgeToken ?? null,
    syncFsBridgeEnabled: options.syncFsBridgeEnabled ?? false,
    syncFsChannelNonce: options.syncFsChannelNonce ?? null,
    localLickWsUrl: options.localLickWsUrl ?? null,
    extensionDelegateId: options.extensionDelegateId ?? null,

    pageBuildId: __SLICC_BUILD_ID__,

    pageLoadedAt: globalThis.performance?.timeOrigin ?? Date.now(),
    flagFloat: options.flagFloat ?? null,

    appPageUrl: globalThis.location?.href ?? null,
  };
  worker.postMessage(init, [kernelChannel.port2, cdpChannel.port2]);

  let disposed = false;
  return {
    client,
    ready,
    dispose() {
      if (disposed) return;
      disposed = true;

      cleanupReady();
      stopForwarder();
      try {
        worker.postMessage({ type: 'kernel-worker-shutdown' });
      } catch {}
      worker.terminate();
      kernelChannel.port1.close();
      cdpChannel.port1.close();
    },
  };
}

export function spawnKernelWorker<TClient>(
  options: KernelWorkerSpawnOptions<TClient>
): SpawnedKernelHost<TClient> {
  const worker = options.workerUrl
    ? new Worker(options.workerUrl, { type: 'module' })
    : new Worker(new URL('./kernel-worker.ts', import.meta.url), { type: 'module' });
  return bootstrapKernelWorker({
    worker,
    realCdpTransport: options.realCdpTransport,
    reconnectCdp: options.reconnectCdp,
    makeClient: options.makeClient,
    readyTimeoutMs: options.readyTimeoutMs,
    localStorageSeed: options.localStorageSeed ?? collectLocalStorageSeed(),
    instanceId: options.instanceId,
    localApiBaseUrl: options.localApiBaseUrl,
    bridgeToken: options.bridgeToken,
    syncFsBridgeEnabled: options.syncFsBridgeEnabled,
    syncFsChannelNonce: options.syncFsChannelNonce,
    localLickWsUrl: options.localLickWsUrl,
    extensionDelegateId: options.extensionDelegateId,
    flagFloat: options.flagFloat,
    onWorkerScriptError: options.onWorkerScriptError,
    onReadyStall: options.onReadyStall,
    readyStallLimit: options.readyStallLimit,
    onLateReady: options.onLateReady,
  });
}
