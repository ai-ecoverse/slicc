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

  onBootProgress?: (stage: string) => void;
}

export interface ReadyStallInfo {
  elapsedMs: number;

  stalls: number;

  stage?: string;
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

  onBootProgress?: (stage: string) => void;
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

  pauseReadyDeadline(): void;

  restartReadyDeadline(): void;

  dispose(): void;
}

function createReadyDeadline(options: {
  readyTimeoutMs: number;
  readyStallLimit: number;
  onReadyStall?: (info: ReadyStallInfo) => void;
  onBootProgress?: (stage: string) => void;
  onExhausted: (message: string) => void;
}): {
  pause(): void;
  restart(): void;
  arm(): void;
  clear(): void;
  noteProgress(stage: string | undefined): void;

  timedOut(): boolean;
} {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let paused = false;
  let stopped = false;
  let exhausted = false;
  let stalls = 0;
  let startedAt = Date.now();
  let stage: string | undefined;

  const clearTimer = (): void => {
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
  };
  const arm = (): void => {
    clearTimer();
    if (paused || stopped || exhausted) return;
    timeoutId = setTimeout(() => {
      if (paused || stopped || exhausted) return;
      stalls += 1;
      if (stalls < options.readyStallLimit) {
        options.onReadyStall?.({ elapsedMs: Date.now() - startedAt, stalls, stage });
        arm();
        return;
      }
      exhausted = true;
      clearTimer();
      const budget = options.readyTimeoutMs * options.readyStallLimit;
      const where = stage ? ` (last progress: ${stage})` : '';
      options.onExhausted(`Kernel worker did not signal ready within ${budget}ms${where}`);
    }, options.readyTimeoutMs);
  };

  return {
    pause() {
      if (stopped || exhausted) return;
      paused = true;
      clearTimer();
    },
    restart() {
      if (stopped || exhausted) return;
      paused = false;
      stalls = 0;
      startedAt = Date.now();
      arm();
    },
    arm,
    clear() {
      stopped = true;
      clearTimer();
    },
    noteProgress(next: string | undefined) {
      if (stopped || exhausted) return;
      if (next) {
        stage = next;
        options.onBootProgress?.(next);
      }

      if (paused) return;
      stalls = 0;
      arm();
    },
    timedOut: () => exhausted,
  };
}

function watchKernelReady(
  port: MessagePort,
  options: Pick<
    KernelWorkerBootstrapOptions<unknown>,
    'onReadyStall' | 'readyStallLimit' | 'onLateReady' | 'onBootProgress'
  >,
  readyTimeoutMs: number
): {
  ready: Promise<void>;
  cleanup: () => void;
  pauseReadyDeadline: () => void;
  restartReadyDeadline: () => void;
} {
  let cleanupReady: () => void = () => {};
  let pauseReadyDeadline: () => void = () => {};
  let restartReadyDeadline: () => void = () => {};
  const ready = new Promise<void>((resolve, reject) => {
    let listener: ((event: MessageEvent) => void) | null = null;
    const readyStallLimit = Math.max(1, options.readyStallLimit ?? (options.onReadyStall ? 3 : 1));
    const deadline = createReadyDeadline({
      readyTimeoutMs,
      readyStallLimit,
      onReadyStall: options.onReadyStall,
      onBootProgress: options.onBootProgress,
      onExhausted: (message) => {
        if (!options.onLateReady) cleanupReady();
        reject(new Error(message));
      },
    });
    pauseReadyDeadline = () => deadline.pause();
    restartReadyDeadline = () => deadline.restart();

    cleanupReady = (): void => {
      if (listener !== null) {
        port.removeEventListener('message', listener as EventListener);
        listener = null;
      }
      deadline.clear();
    };
    listener = (event: MessageEvent): void => {
      const data = event.data as
        | Partial<KernelWorkerReadyMsg>
        | Partial<KernelWorkerBootErrorMsg>
        | Partial<KernelWorkerBootProgressMsg>
        | null;

      if (data?.type === 'kernel-worker-boot-progress') {
        deadline.noteProgress((data as Partial<KernelWorkerBootProgressMsg>).stage);
        return;
      }
      if (data?.type === 'kernel-worker-ready') {
        cleanupReady();
        if (deadline.timedOut()) {
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
    deadline.arm();
  });
  return {
    ready,
    cleanup: () => cleanupReady(),
    pauseReadyDeadline: () => pauseReadyDeadline(),
    restartReadyDeadline: () => restartReadyDeadline(),
  };
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

  const {
    ready,
    cleanup: cleanupReady,
    pauseReadyDeadline,
    restartReadyDeadline,
  } = watchKernelReady(kernelChannel.port1, options, readyTimeoutMs);

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
    pauseReadyDeadline,
    restartReadyDeadline,
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
    onBootProgress: options.onBootProgress,
  });
}
