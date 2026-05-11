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
 *      / `removeItem(k)` / `clear()` on the page. We use two strategies:
 *
 *      - **Real `Storage` instances** (Chrome production): patch
 *        `Storage.prototype` and filter by `this === ls`. Chrome's
 *        `Storage` host object has `[LegacyOverrideBuiltIns]` semantics,
 *        which means `Object.defineProperty` on the *instance* writes the
 *        function's `.toString()` into the underlying key-value store rather
 *        than creating a JS own-property that shadows the prototype.
 *      - **Plain-object fakes** (Node.js / test environments where
 *        `ls instanceof Storage` is false): use `Object.defineProperty` on
 *        the instance with `enumerable: false` so method names don't appear
 *        as phantom storage keys when iterating.
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

  // Real Storage instances in Chrome have [LegacyOverrideBuiltIns]: calling
  // Object.defineProperty on the instance writes to the underlying key-value
  // store rather than creating a JS own-property. Patch Storage.prototype
  // instead, filtered to ls only. For plain-object fakes (test environments
  // where ls instanceof Storage is false) use Object.defineProperty.
  const isRealStorage = typeof Storage !== 'undefined' && ls instanceof Storage;

  const origSetItem = isRealStorage ? Storage.prototype.setItem : ls.setItem.bind(ls);
  const origRemoveItem = isRealStorage ? Storage.prototype.removeItem : ls.removeItem.bind(ls);
  const origClear = isRealStorage ? Storage.prototype.clear : ls.clear.bind(ls);

  if (isRealStorage) {
    const proto = Storage.prototype;
    proto.setItem = function (key: string, value: string): void {
      (origSetItem as typeof proto.setItem).call(this, key, value);
      if (this !== ls) return;
      if (!isForwardableKey(key)) {
        console.warn('[page-storage-sync] dropping localStorage write with NUL in key', key);
        return;
      }
      sink.send({ type: 'local-storage-set', key, value } satisfies LocalStorageSetMsg);
    };
    proto.removeItem = function (key: string): void {
      (origRemoveItem as typeof proto.removeItem).call(this, key);
      if (this !== ls) return;
      if (!isForwardableKey(key)) {
        console.warn('[page-storage-sync] dropping localStorage remove with NUL in key', key);
        return;
      }
      sink.send({ type: 'local-storage-remove', key } satisfies LocalStorageRemoveMsg);
    };
    proto.clear = function (): void {
      (origClear as typeof proto.clear).call(this);
      if (this !== ls) return;
      sink.send({ type: 'local-storage-clear' } satisfies LocalStorageClearMsg);
    };
  } else {
    // Plain-object fake (tests): Object.defineProperty creates a real JS
    // own-property that shadows the object's own methods. Use enumerable:false
    // so method names don't appear as phantom keys when iterating.
    const define = (name: 'setItem' | 'removeItem' | 'clear', value: unknown): void => {
      Object.defineProperty(ls, name, {
        value,
        writable: true,
        configurable: true,
        enumerable: false,
      });
    };

    define('setItem', (key: string, value: string): void => {
      (origSetItem as Storage['setItem'])(key, value);
      if (!isForwardableKey(key)) {
        console.warn('[page-storage-sync] dropping localStorage write with NUL in key', key);
        return;
      }
      sink.send({ type: 'local-storage-set', key, value } satisfies LocalStorageSetMsg);
    });
    define('removeItem', (key: string): void => {
      (origRemoveItem as Storage['removeItem'])(key);
      if (!isForwardableKey(key)) {
        console.warn('[page-storage-sync] dropping localStorage remove with NUL in key', key);
        return;
      }
      sink.send({ type: 'local-storage-remove', key } satisfies LocalStorageRemoveMsg);
    });
    define('clear', (): void => {
      (origClear as Storage['clear'])();
      sink.send({ type: 'local-storage-clear' } satisfies LocalStorageClearMsg);
    });
  }

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
    if (isRealStorage) {
      Storage.prototype.setItem = origSetItem as typeof Storage.prototype.setItem;
      Storage.prototype.removeItem = origRemoveItem as typeof Storage.prototype.removeItem;
      Storage.prototype.clear = origClear as typeof Storage.prototype.clear;
    } else {
      const define = (name: 'setItem' | 'removeItem' | 'clear', value: unknown): void => {
        Object.defineProperty(ls, name, {
          value,
          writable: true,
          configurable: true,
          enumerable: false,
        });
      };
      define('setItem', origSetItem);
      define('removeItem', origRemoveItem);
      define('clear', origClear);
    }
    window.removeEventListener('storage', onStorage);
  };
}
