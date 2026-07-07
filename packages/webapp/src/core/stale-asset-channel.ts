/**
 * Realm-agnostic detection + worker→page signal for stale-chunk recovery after
 * a deploy (#1330). DOM-free at module scope (only `BroadcastChannel`, in the
 * page AND the kernel worker), so both realms import it. Mirrors the split-out
 * shape of `nuke-channel.ts`.
 */
import { createLogger } from './logger.js';

const log = createLogger('stale-asset');

// Module-script context ONLY — never a bare "MIME type" / "failed to fetch",
// which would false-positive on unrelated tool/upload/provider errors.
const DYNAMIC_IMPORT_ERROR_RE =
  /dynamically imported module|importing a module script failed|expected a javascript module|module script/i;

/** True for the cross-browser dynamic-import / module-script load failure family. */
export function isDynamicImportError(msg: string): boolean {
  return DYNAMIC_IMPORT_ERROR_RE.test(msg);
}

/** Same-origin channel a failing worker uses to ask its owning page to reload. */
export const STALE_ASSET_RELOAD_CHANNEL = 'slicc-stale-asset-reload';

export interface StaleAssetReloadMsg {
  type: 'stale-asset-reload';
  instanceId: string;
  /**
   * Set true only by the CONE turn-time trigger — the one dropped turn a user
   * can resubmit. The page marks a replay pending before reloading; after boot
   * the restored thread's last unanswered user turn is re-sent once. Boot-time
   * and page `vite:preloadError` reloads leave this false (no dropped turn).
   */
  replayTurn?: boolean;
}

let workerInstanceId: string | null = null;

/** Kernel worker records `init.instanceId` at boot start. Dev-warns if absent. */
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

/**
 * Post an instanceId-stamped reload request. No-op until an id is set. Pass
 * `replayTurn = true` (cone turn-time trigger only) to mark the dropped turn
 * for one-shot auto-resubmit after the recovery reload.
 */
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

/** Broadcast iff `err` is a dynamic-import failure. Called from the worker
 *  `boot()` catch — lives here (not in `kernel-worker.ts`) so it is unit-testable
 *  without triggering that module's load-time `self.addEventListener` side effect. */
export function broadcastIfStaleAssetError(err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  if (isDynamicImportError(msg)) broadcastStaleAssetReload();
}

/**
 * Page-side listener PRIMITIVE. Invokes `onReload` only for a broadcast stamped
 * with the page's own `instanceId`. Returns a fresh disposer per call (like
 * `installNukeReloadListener`); single-install is enforced by the page wrapper
 * `installWorkerStaleAssetReloadListener`.
 */
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
