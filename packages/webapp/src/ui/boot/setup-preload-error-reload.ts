/**
 * Page-side stale-asset recovery (#1330). Owns the one guarded reload every
 * trigger shares, the page `vite:preloadError` handler (page-owned lazy chunks),
 * and the worker-broadcast listener. Sibling to `setup-nuke-reload-listener.ts`.
 */
import { installStaleAssetReloadListener } from '../../core/stale-asset-channel.js';

const STORAGE_KEY = 'slicc:stale-asset-reloaded-at';
/** Must exceed the ~30 s host-ready boot timeout so a stale re-error at boot is
 *  suppressed (loop-proof) while a genuinely new deploy later still reloads. */
export const RELOAD_WINDOW_MS = 60_000;

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

/** Pure guard: reload iff never reloaded or the window has elapsed. */
export function decideStaleReload(
  lastReloadAt: number | null,
  now: number,
  windowMs: number
): boolean {
  return lastReloadAt === null || now - lastReloadAt >= windowMs;
}

/**
 * Reload at most once per `windowMs` per tab. Fail-closed: if `sessionStorage`
 * can't be read or written we do NOT reload (never reload without a persistable
 * guard, or a broken deploy could loop). Returns whether it reloaded.
 */
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

/** Install the page `vite:preloadError` handler (idempotent). Call FIRST in
 *  `main()`. `preventDefault()` only when we actually reload. */
export function setupPreloadErrorReload(deps?: Partial<GuardedReloadDeps>): void {
  if (vitePreloadHandler) return;
  activeDeps = { ...defaultDeps(), ...deps };
  vitePreloadHandler = (e: Event) => {
    // Invariant: activeDeps is assigned above, before this handler is created and
    // registered, and only cleared by __resetForTest — so it's non-null whenever
    // the handler fires.
    if (guardedReload(activeDeps!)) e.preventDefault();
  };
  window.addEventListener('vite:preloadError', vitePreloadHandler);
}

let workerListenerDispose: (() => void) | null = null;

/** Install the instanceId-scoped worker-broadcast listener (idempotent). MUST be
 *  called BEFORE `spawnKernelWorker()` — BroadcastChannel doesn't buffer and the
 *  worker posts init synchronously. Runs the same `guardedReload`. */
export function installWorkerStaleAssetReloadListener(instanceId: string): () => void {
  if (workerListenerDispose) return workerListenerDispose;
  workerListenerDispose = installStaleAssetReloadListener(instanceId, () => {
    guardedReload(activeDeps ?? undefined);
  });
  return workerListenerDispose;
}

/** Test-only: detach handlers + clear module state. */
export function __resetForTest(): void {
  if (vitePreloadHandler) window.removeEventListener('vite:preloadError', vitePreloadHandler);
  vitePreloadHandler = null;
  activeDeps = null;
  if (workerListenerDispose) workerListenerDispose();
  workerListenerDispose = null;
}
