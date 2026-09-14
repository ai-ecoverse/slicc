import type {
  LocalStorageClearMsg,
  LocalStorageRemoveMsg,
  LocalStorageSetMsg,
  PanelToOffscreenMessage,
} from './messages.js';

export interface PageStorageSyncSink {
  send(message: PanelToOffscreenMessage): void;
}

function isForwardableKey(key: string): boolean {
  return !key.includes('\0');
}

export function installPageStorageSync(sink: PageStorageSyncSink): () => void {
  if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') {
    return () => undefined;
  }

  const ls = window.localStorage;

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

  const onStorage = (event: StorageEvent): void => {
    if (event.storageArea !== ls) return;
    if (event.key === null) {
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
