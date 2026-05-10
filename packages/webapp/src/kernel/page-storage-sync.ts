/**
 * Live page→worker `localStorage` sync.
 *
 * The kernel worker has no real `localStorage` (Web Workers don't get
 * one). Boot-time, the page seeds a Map-backed shim in the worker via
 * `KernelWorkerInitMsg.localStorageSeed`. After boot, page-side writes
 * need to keep flowing so settings changes (provider swap, model
 * pick, tray join URL paste) are visible to the agent immediately.
 *
 * Two write paths are intercepted:
 *
 *   1. **Same-tab writes** — anything calling `localStorage.setItem(k, v)`
 *      / `removeItem(k)` / `clear()` on the page. We override the
 *      methods on the *instance* (`window.localStorage`), not on
 *      `Storage.prototype`, so `sessionStorage` is untouched and we
 *      don't conflict with other libraries.
 *
 *   2. **Cross-tab writes** — `storage` events fire on the page when
 *      *another* tab writes to localStorage. Subscribed via
 *      `window.addEventListener('storage', …)` and forwarded to the
 *      worker the same way.
 *
 * Worker side: `OffscreenBridge` handles `local-storage-set` /
 * `-remove` / `-clear` by calling the corresponding method on
 * `globalThis.localStorage` — which IS the shim. The shim's
 * `setItem`/etc. just update its internal Map; no echo back to the
 * page (the page is the source of truth).
 *
 * A future bidirectional channel (e.g. for the agent persisting state
 * via `localStorage`) is a possible follow-up, but today the agent's
 * persistence is IndexedDB-backed (orchestrator state, sessions,
 * mounts) so the read-only-from-worker shape is sufficient.
 *
 * Returns a `dispose()` to restore the originals — useful for tests.
 */

import type {
  LocalStorageSetMsg,
  LocalStorageRemoveMsg,
  LocalStorageClearMsg,
  PanelToOffscreenMessage,
} from '../../../chrome-extension/src/messages.js';

export interface PageStorageSyncSink {
  /** Send a panel→host message; same shape `OffscreenClient.send` uses. */
  send(message: PanelToOffscreenMessage): void;
}

/**
 * Cross-tab `storage` events serialize the key with NUL termination
 * in some browsers, which silently truncates a key like `"x\0y"` to
 * `"x"`. The same-tab write path is unaffected (we proxy the call
 * directly without going through serialization), but we still drop
 * NUL-bearing keys defensively so the two paths can never disagree
 * on whether a write is reflected in the worker. Same-shape keys are
 * not a real workload (no SLICC writer produces them) — this is
 * defense-in-depth against a buggy third-party caller.
 *
 * Returns true when the key is OK to forward.
 */
function isForwardableKey(key: string): boolean {
  return !key.includes('\0');
}

export function installPageStorageSync(sink: PageStorageSyncSink): () => void {
  if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') {
    return () => undefined;
  }

  const ls = window.localStorage;
  const origSetItem = ls.setItem.bind(ls);
  const origRemoveItem = ls.removeItem.bind(ls);
  const origClear = ls.clear.bind(ls);

  ls.setItem = (key: string, value: string): void => {
    origSetItem(key, value);
    if (!isForwardableKey(key)) {
      console.warn('[page-storage-sync] dropping localStorage write with NUL in key', key);
      return;
    }
    sink.send({ type: 'local-storage-set', key, value } satisfies LocalStorageSetMsg);
  };
  ls.removeItem = (key: string): void => {
    origRemoveItem(key);
    if (!isForwardableKey(key)) {
      console.warn('[page-storage-sync] dropping localStorage remove with NUL in key', key);
      return;
    }
    sink.send({ type: 'local-storage-remove', key } satisfies LocalStorageRemoveMsg);
  };
  ls.clear = (): void => {
    origClear();
    sink.send({ type: 'local-storage-clear' } satisfies LocalStorageClearMsg);
  };

  // Cross-tab writes: when another tab calls localStorage.setItem(),
  // a `storage` event fires here. The browser already updated this
  // window's localStorage; we just forward to the worker.
  const onStorage = (event: StorageEvent): void => {
    if (event.storageArea !== ls) return;
    if (event.key === null) {
      // `localStorage.clear()` from another tab.
      sink.send({ type: 'local-storage-clear' } satisfies LocalStorageClearMsg);
      return;
    }
    if (!isForwardableKey(event.key)) return;
    if (event.newValue === null) {
      sink.send({
        type: 'local-storage-remove',
        key: event.key,
      } satisfies LocalStorageRemoveMsg);
      return;
    }
    sink.send({
      type: 'local-storage-set',
      key: event.key,
      value: event.newValue,
    } satisfies LocalStorageSetMsg);
  };
  window.addEventListener('storage', onStorage);

  return () => {
    ls.setItem = origSetItem;
    ls.removeItem = origRemoveItem;
    ls.clear = origClear;
    window.removeEventListener('storage', onStorage);
  };
}
