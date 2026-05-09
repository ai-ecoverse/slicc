/**
 * Tests for `installPageStorageSync` — page-side hook that forwards
 * `localStorage` writes to the kernel worker's shim over the wire.
 *
 * Pins:
 *   - `localStorage.setItem(k, v)` writes to the page AND posts
 *     `local-storage-set` over the wire.
 *   - `removeItem(k)` posts `local-storage-remove`.
 *   - `clear()` posts `local-storage-clear`.
 *   - `storage` events from other tabs forward to the wire too.
 *   - `dispose()` restores the original Storage methods (so a teardown
 *     between tests doesn't leak interceptors).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { installPageStorageSync } from '../../src/kernel/page-storage-sync.js';
import type { PanelToOffscreenMessage } from '../../../chrome-extension/src/messages.js';

interface FakeStorage extends Storage {
  _store: Map<string, string>;
}

function makeFakeStorage(): FakeStorage {
  const store = new Map<string, string>();
  const fake = {
    _store: store,
    get length() {
      return store.size;
    },
    key(i: number): string | null {
      return Array.from(store.keys())[i] ?? null;
    },
    getItem(k: string): string | null {
      return store.has(k) ? (store.get(k) ?? null) : null;
    },
    setItem(k: string, v: string): void {
      store.set(k, v);
    },
    removeItem(k: string): void {
      store.delete(k);
    },
    clear(): void {
      store.clear();
    },
  };
  return fake as FakeStorage;
}

let storageListener: ((event: StorageEvent) => void) | null = null;
const fakeWindow = {
  get localStorage(): FakeStorage {
    return (fakeWindow as unknown as { _ls: FakeStorage })._ls;
  },
  addEventListener(type: string, listener: (event: StorageEvent) => void): void {
    if (type === 'storage') storageListener = listener;
  },
  removeEventListener(type: string): void {
    if (type === 'storage') storageListener = null;
  },
};

beforeEach(() => {
  storageListener = null;
  (fakeWindow as unknown as { _ls: FakeStorage })._ls = makeFakeStorage();
  (globalThis as { window?: typeof fakeWindow }).window = fakeWindow;
});

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe('installPageStorageSync', () => {
  it('forwards setItem to the wire', () => {
    const sent: PanelToOffscreenMessage[] = [];
    const dispose = installPageStorageSync({ send: (m) => sent.push(m) });

    fakeWindow.localStorage.setItem('foo', 'bar');

    expect(fakeWindow.localStorage.getItem('foo')).toBe('bar');
    expect(sent).toEqual([{ type: 'local-storage-set', key: 'foo', value: 'bar' }]);
    dispose();
  });

  it('forwards removeItem to the wire', () => {
    const sent: PanelToOffscreenMessage[] = [];
    fakeWindow.localStorage.setItem('seed', 'value');
    const dispose = installPageStorageSync({ send: (m) => sent.push(m) });

    fakeWindow.localStorage.removeItem('seed');

    expect(fakeWindow.localStorage.getItem('seed')).toBeNull();
    expect(sent).toEqual([{ type: 'local-storage-remove', key: 'seed' }]);
    dispose();
  });

  it('forwards clear to the wire', () => {
    const sent: PanelToOffscreenMessage[] = [];
    fakeWindow.localStorage.setItem('a', '1');
    fakeWindow.localStorage.setItem('b', '2');
    const dispose = installPageStorageSync({ send: (m) => sent.push(m) });

    fakeWindow.localStorage.clear();

    expect(fakeWindow.localStorage.length).toBe(0);
    expect(sent).toEqual([{ type: 'local-storage-clear' }]);
    dispose();
  });

  it('forwards storage events from other tabs', () => {
    const sent: PanelToOffscreenMessage[] = [];
    const dispose = installPageStorageSync({ send: (m) => sent.push(m) });
    expect(storageListener).not.toBeNull();

    storageListener!({
      key: 'x',
      newValue: 'y',
      oldValue: null,
      storageArea: fakeWindow.localStorage as unknown as Storage,
      url: 'http://localhost:5720/',
    } as unknown as StorageEvent);
    storageListener!({
      key: 'gone',
      newValue: null,
      oldValue: 'old',
      storageArea: fakeWindow.localStorage as unknown as Storage,
      url: 'http://localhost:5720/',
    } as unknown as StorageEvent);
    storageListener!({
      key: null,
      newValue: null,
      oldValue: null,
      storageArea: fakeWindow.localStorage as unknown as Storage,
      url: 'http://localhost:5720/',
    } as unknown as StorageEvent);

    expect(sent).toEqual([
      { type: 'local-storage-set', key: 'x', value: 'y' },
      { type: 'local-storage-remove', key: 'gone' },
      { type: 'local-storage-clear' },
    ]);
    dispose();
  });

  it('ignores storage events from a different storage area', () => {
    const sent: PanelToOffscreenMessage[] = [];
    const otherArea = makeFakeStorage();
    const dispose = installPageStorageSync({ send: (m) => sent.push(m) });

    storageListener!({
      key: 'x',
      newValue: 'y',
      oldValue: null,
      storageArea: otherArea as unknown as Storage,
      url: 'http://localhost:5720/',
    } as unknown as StorageEvent);

    expect(sent).toEqual([]);
    dispose();
  });

  it('dispose restores original methods', () => {
    const sent: PanelToOffscreenMessage[] = [];
    const dispose = installPageStorageSync({ send: (m) => sent.push(m) });

    dispose();
    fakeWindow.localStorage.setItem('after', 'dispose');

    expect(fakeWindow.localStorage.getItem('after')).toBe('dispose');
    expect(sent).toEqual([]); // no wire traffic after dispose
    expect(storageListener).toBeNull();
  });

  it('returns a no-op dispose when window/localStorage is unavailable', () => {
    delete (globalThis as { window?: unknown }).window;
    const sent: PanelToOffscreenMessage[] = [];
    const dispose = installPageStorageSync({ send: (m) => sent.push(m) });
    expect(dispose).toBeInstanceOf(Function);
    dispose();
    expect(sent).toEqual([]);
  });

  it('drops setItem with a NUL byte in the key (defensive)', () => {
    const sent: PanelToOffscreenMessage[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const dispose = installPageStorageSync({ send: (m) => sent.push(m) });

    fakeWindow.localStorage.setItem('x\0y', 'value');

    // The same-tab write still hits page localStorage…
    expect(fakeWindow.localStorage.getItem('x\0y')).toBe('value');
    // …but is NOT forwarded over the wire (cross-tab `storage`
    // events truncate at NUL in some browsers, so reflecting the
    // same-tab write would create a sync mismatch).
    expect(sent).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    dispose();
  });

  it('drops removeItem with a NUL byte in the key', () => {
    const sent: PanelToOffscreenMessage[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const dispose = installPageStorageSync({ send: (m) => sent.push(m) });
    fakeWindow.localStorage.removeItem('x\0y');
    expect(sent).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    dispose();
  });

  it('drops cross-tab storage events with NUL in the key', () => {
    const sent: PanelToOffscreenMessage[] = [];
    const dispose = installPageStorageSync({ send: (m) => sent.push(m) });
    storageListener?.({
      key: 'x\0y',
      newValue: 'value',
      oldValue: null,
      storageArea: fakeWindow.localStorage,
      url: '',
    } as unknown as StorageEvent);
    expect(sent).toEqual([]);
    dispose();
  });
});
