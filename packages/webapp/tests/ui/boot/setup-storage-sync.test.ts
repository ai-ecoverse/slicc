/**
 * Focused tests for the `setupStorageSync()` boot stage. The
 * interceptor behavior itself is covered exhaustively by
 * `tests/kernel/page-storage-sync.test.ts`; these tests pin the
 * stage-level contract that lives in `setup-storage-sync.ts`:
 *
 *   - Returns a working `stopStorageSync` cleanup handle.
 *   - Pushes a seed snapshot of the current `localStorage` over the
 *     supplied transport.
 *   - Drops the three unforwardable junk keys
 *     (`setItem`/`removeItem`/`clear`) and NUL-bearing keys.
 *
 * Runs in the `node` environment with a fake `window`/`localStorage`,
 * matching `tests/kernel/page-storage-sync.test.ts` \u2014 jsdom's
 * `window.localStorage` is not reliably available under Node 22's
 * built-in localStorage shim.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PanelToOffscreenMessage } from '../../../../chrome-extension/src/messages.js';

import { setupStorageSync } from '../../../src/ui/boot/setup-storage-sync.js';

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

const fakeWindow: {
  localStorage: FakeStorage;
  addEventListener(): void;
  removeEventListener(): void;
} = {
  localStorage: makeFakeStorage(),
  addEventListener() {},
  removeEventListener() {},
};

beforeEach(() => {
  fakeWindow.localStorage = makeFakeStorage();
  (globalThis as { window?: typeof fakeWindow }).window = fakeWindow;
});

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe('setupStorageSync', () => {
  it('pushes a seed snapshot of localStorage over the transport', () => {
    fakeWindow.localStorage.setItem('alpha', '1');
    fakeWindow.localStorage.setItem('beta', '2');
    const sent: PanelToOffscreenMessage[] = [];

    const handle = setupStorageSync({
      client: { sendRaw: (m) => sent.push(m) },
      localStorage: fakeWindow.localStorage,
    });

    const setMsgs = sent.filter(
      (m): m is Extract<PanelToOffscreenMessage, { type: 'local-storage-set' }> =>
        m.type === 'local-storage-set'
    );
    const byKey = new Map(setMsgs.map((m) => [m.key, m.value]));
    expect(byKey.get('alpha')).toBe('1');
    expect(byKey.get('beta')).toBe('2');
    expect(typeof handle.stopStorageSync).toBe('function');
    handle.stopStorageSync();
  });

  it('drops the three unforwardable junk keys from the seed snapshot', () => {
    fakeWindow.localStorage.setItem('setItem', 'junk');
    fakeWindow.localStorage.setItem('removeItem', 'junk');
    fakeWindow.localStorage.setItem('clear', 'junk');
    fakeWindow.localStorage.setItem('real', 'value');
    const sent: PanelToOffscreenMessage[] = [];

    const handle = setupStorageSync({
      client: { sendRaw: (m) => sent.push(m) },
      localStorage: fakeWindow.localStorage,
    });

    const seedKeys = sent
      .filter(
        (m): m is Extract<PanelToOffscreenMessage, { type: 'local-storage-set' }> =>
          m.type === 'local-storage-set'
      )
      .map((m) => m.key);
    expect(seedKeys).toContain('real');
    expect(seedKeys).not.toContain('setItem');
    expect(seedKeys).not.toContain('removeItem');
    expect(seedKeys).not.toContain('clear');
    handle.stopStorageSync();
  });

  it('drops keys containing NUL from the seed snapshot', () => {
    fakeWindow.localStorage.setItem('clean', 'ok');
    fakeWindow.localStorage.setItem('nul\u0000key', 'bad');
    const sent: PanelToOffscreenMessage[] = [];

    const handle = setupStorageSync({
      client: { sendRaw: (m) => sent.push(m) },
      localStorage: fakeWindow.localStorage,
    });

    const seedKeys = sent
      .filter(
        (m): m is Extract<PanelToOffscreenMessage, { type: 'local-storage-set' }> =>
          m.type === 'local-storage-set'
      )
      .map((m) => m.key);
    expect(seedKeys).toContain('clean');
    expect(seedKeys.every((k) => !k.includes('\u0000'))).toBe(true);
    handle.stopStorageSync();
  });

  it('returns a stopStorageSync callable that disposes the interceptor', () => {
    const sendRaw = vi.fn();
    const handle = setupStorageSync({
      client: { sendRaw },
      localStorage: fakeWindow.localStorage,
    });
    expect(() => handle.stopStorageSync()).not.toThrow();
  });
});
