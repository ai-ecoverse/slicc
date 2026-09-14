import { installStaleAssetReloadListener } from '../../core/stale-asset-channel.js';

const STORAGE_KEY = 'slicc:stale-asset-reloaded-at';

export const RELOAD_WINDOW_MS = 60_000;

const REPLAY_KEY = 'slicc:stale-asset-replay';

export function markStaleAssetReplayPending(
  storage: Pick<Storage, 'setItem'> = window.sessionStorage
): void {
  try {
    storage.setItem(REPLAY_KEY, '1');
  } catch {}
}

export function consumeStaleAssetReplayPending(
  storage: Pick<Storage, 'getItem' | 'removeItem'> = window.sessionStorage
): boolean {
  try {
    if (storage.getItem(REPLAY_KEY) !== '1') return false;
    storage.removeItem(REPLAY_KEY);
    return true;
  } catch {
    return false;
  }
}

export interface GuardedReloadDeps {
  reload: () => void;
  storage: Pick<Storage, 'getItem' | 'setItem'>;
  now: () => number;
  windowMs: number;
  storageKey: string;
}

function defaultDeps(): GuardedReloadDeps {
  return {
    reload: () => window.location.reload(),
    storage: window.sessionStorage,
    now: () => Date.now(),
    windowMs: RELOAD_WINDOW_MS,
    storageKey: STORAGE_KEY,
  };
}

export function decideStaleReload(
  lastReloadAt: number | null,
  now: number,
  windowMs: number
): boolean {
  return lastReloadAt === null || now - lastReloadAt >= windowMs;
}

export function guardedReload(deps: GuardedReloadDeps = defaultDeps()): boolean {
  let raw: string | null;
  try {
    raw = deps.storage.getItem(deps.storageKey);
  } catch {
    return false;
  }
  const parsed = raw === null ? null : Number(raw);
  const lastReloadAt = parsed !== null && Number.isFinite(parsed) ? parsed : null;
  const now = deps.now();
  if (!decideStaleReload(lastReloadAt, now, deps.windowMs)) return false;
  try {
    deps.storage.setItem(deps.storageKey, String(now));
  } catch {
    return false;
  }
  deps.reload();
  return true;
}

let vitePreloadHandler: ((e: Event) => void) | null = null;
let activeDeps: GuardedReloadDeps | null = null;

export function setupPreloadErrorReload(deps?: Partial<GuardedReloadDeps>): void {
  if (vitePreloadHandler) return;
  activeDeps = { ...defaultDeps(), ...deps };
  vitePreloadHandler = (e: Event) => {
    if (guardedReload(activeDeps!)) e.preventDefault();
  };
  window.addEventListener('vite:preloadError', vitePreloadHandler);
}

let workerListenerDispose: (() => void) | null = null;

export function installWorkerStaleAssetReloadListener(instanceId: string): () => void {
  if (workerListenerDispose) return workerListenerDispose;
  workerListenerDispose = installStaleAssetReloadListener(instanceId, (replayTurn) => {
    if (replayTurn) markStaleAssetReplayPending();
    guardedReload(activeDeps ?? undefined);
  });
  return workerListenerDispose;
}

export function __resetForTest(): void {
  if (vitePreloadHandler) window.removeEventListener('vite:preloadError', vitePreloadHandler);
  vitePreloadHandler = null;
  activeDeps = null;
  if (workerListenerDispose) workerListenerDispose();
  workerListenerDispose = null;
}
