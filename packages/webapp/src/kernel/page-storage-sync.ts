/**
 * Live page→worker `localStorage` sync (Phase 2.7 polish).
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
 * page (the page is the source of truth in this Phase).
 *
 * Phase 3+ may want a real bidirectional channel (e.g. for the agent
 * persisting state via `localStorage`), but today the agent's
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
    sink.send({ type: 'local-storage-set', key, value } satisfies LocalStorageSetMsg);
  };
  ls.removeItem = (key: string): void => {
    origRemoveItem(key);
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
