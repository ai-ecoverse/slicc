import { createLogger } from '../base/logger.js';

const log = createLogger('stale-asset');

const DYNAMIC_IMPORT_ERROR_RE =
  /dynamically imported module|importing a module script failed|expected a javascript module|module script/i;

export function isDynamicImportError(msg: string): boolean {
  return DYNAMIC_IMPORT_ERROR_RE.test(msg);
}

export const STALE_ASSET_RELOAD_CHANNEL = 'slicc-stale-asset-reload';

export interface StaleAssetReloadMsg {
  type: 'stale-asset-reload';
  instanceId: string;

  replayTurn?: boolean;
}

let workerInstanceId: string | null = null;

export function setStaleAssetInstanceId(id: string | undefined): void {
  if (!id) {
    workerInstanceId = null;
    if (import.meta.env?.DEV) {
      log.warn('no instanceId for kernel worker; stale-asset reload signal disabled');
    }
    return;
  }
  workerInstanceId = id;
}

export function broadcastStaleAssetReload(replayTurn = false): void {
  if (!workerInstanceId || typeof BroadcastChannel !== 'function') return;
  const channel = new BroadcastChannel(STALE_ASSET_RELOAD_CHANNEL);
  try {
    channel.postMessage({
      type: 'stale-asset-reload',
      instanceId: workerInstanceId,
      replayTurn,
    } satisfies StaleAssetReloadMsg);
  } finally {
    channel.close();
  }
}

export function broadcastIfStaleAssetError(err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  if (isDynamicImportError(msg)) broadcastStaleAssetReload();
}

export function broadcastIfMixedBuildGraph(
  pageBuildId: string | null | undefined,
  workerBuildId: string
): boolean {
  if (!pageBuildId || pageBuildId === workerBuildId) return false;
  log.warn(`mixed build graph: page ${pageBuildId} vs worker ${workerBuildId} — requesting reload`);
  broadcastStaleAssetReload();
  return true;
}

export function installStaleAssetReloadListener(
  instanceId: string,
  onReload: (replayTurn: boolean) => void
): () => void {
  if (typeof BroadcastChannel !== 'function') return () => {};
  const channel = new BroadcastChannel(STALE_ASSET_RELOAD_CHANNEL);
  const handler = (event: MessageEvent): void => {
    const data = event.data as StaleAssetReloadMsg | undefined;
    if (data?.type !== 'stale-asset-reload' || data.instanceId !== instanceId) return;
    onReload(data.replayTurn === true);
  };
  channel.addEventListener('message', handler);
  return () => {
    channel.removeEventListener('message', handler);
    channel.close();
  };
}
