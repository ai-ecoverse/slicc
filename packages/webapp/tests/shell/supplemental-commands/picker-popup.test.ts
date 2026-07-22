import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  canOpenPickerPopup,
  openPickerPopup,
  type PickerKind,
} from '../../../src/shell/supplemental-commands/picker-popup.js';

type Listener = (msg: unknown) => void;
type WindowRemovedListener = (windowId: number) => void;

describe('canOpenPickerPopup', () => {
  afterEach(() => {
    delete (globalThis as unknown as { chrome?: unknown }).chrome;
  });

  it('returns true when chrome.runtime.id and chrome.windows.create are present', () => {
    (globalThis as unknown as { chrome: unknown }).chrome = {
      runtime: { id: 'ext-id' },
      windows: { create: () => Promise.resolve({}) },
    };
    expect(canOpenPickerPopup()).toBe(true);
  });

  it('returns false outside the extension realm', () => {
    expect(canOpenPickerPopup()).toBe(false);
  });

  it('returns false when chrome.windows.create is missing', () => {
    (globalThis as unknown as { chrome: unknown }).chrome = {
      runtime: { id: 'ext-id' },
      windows: {},
    };
    expect(canOpenPickerPopup()).toBe(false);
  });
});

describe('openPickerPopup', () => {
  let listeners: Listener[];
  let createCalls: Array<{ url: string }>;
  let createImpl: () => Promise<unknown>;

  beforeEach(() => {
    listeners = [];
    createCalls = [];
    createImpl = () => Promise.resolve({ id: 1 });
    (globalThis as unknown as { chrome: unknown }).chrome = {
      runtime: {
        id: 'ext-id',
        getURL: (path: string) => `chrome-extension://ext-id/${path}`,
        onMessage: {
          addListener: (l: Listener) => {
            listeners.push(l);
          },
          removeListener: (l: Listener) => {
            listeners = listeners.filter((x) => x !== l);
          },
        },
      },
      windows: {
        create: (opts: { url: string }) => {
          createCalls.push({ url: opts.url });
          return createImpl();
        },
      },
    };
  });

  afterEach(() => {
    delete (globalThis as unknown as { chrome?: unknown }).chrome;
  });

  it.each<PickerKind>(['directory', 'usb-device', 'serial-port', 'hid-device'])(
    'opens picker-popup.html with kind=%s and resolves on matching message',
    async (kind) => {
      const promise = openPickerPopup(kind, [], `req-${kind}`);
      expect(createCalls).toHaveLength(1);
      expect(createCalls[0].url).toContain('picker-popup.html');
      expect(createCalls[0].url).toContain(`kind=${encodeURIComponent(kind)}`);
      expect(createCalls[0].url).toContain(`requestId=req-${kind}`);
      listeners[0]({
        source: 'picker-popup',
        kind,
        requestId: `req-${kind}`,
        granted: true,
        info: { vendorId: 1, productId: 2 },
      });
      const result = await promise;
      expect(result).toMatchObject({ granted: true, info: { vendorId: 1, productId: 2 } });
    }
  );

  it('encodes filters as JSON in the URL', async () => {
    const filters = [{ vendorId: 0x2e8a, productId: 0x0003 }];
    const promise = openPickerPopup('usb-device', filters, 'req-filters');
    const url = new URL(createCalls[0].url);
    expect(JSON.parse(decodeURIComponent(url.searchParams.get('filters') ?? '[]'))).toEqual(
      filters
    );
    listeners[0]({
      source: 'picker-popup',
      kind: 'usb-device',
      requestId: 'req-filters',
      cancelled: true,
    });
    await promise;
  });

  it('ignores messages with mismatched kind or requestId', async () => {
    const promise = openPickerPopup('serial-port', [], 'req-A');
    // Wrong source
    listeners[0]({
      source: 'something-else',
      kind: 'serial-port',
      requestId: 'req-A',
      cancelled: true,
    });
    // Wrong kind
    listeners[0]({
      source: 'picker-popup',
      kind: 'usb-device',
      requestId: 'req-A',
      cancelled: true,
    });
    // Wrong requestId
    listeners[0]({
      source: 'picker-popup',
      kind: 'serial-port',
      requestId: 'req-B',
      cancelled: true,
    });
    // Now match
    listeners[0]({
      source: 'picker-popup',
      kind: 'serial-port',
      requestId: 'req-A',
      cancelled: true,
    });
    const result = await promise;
    expect(result).toMatchObject({ cancelled: true });
  });

  it('resolves with error when chrome.windows.create rejects', async () => {
    createImpl = () => Promise.reject(new Error('window blocked'));
    const promise = openPickerPopup('hid-device', []);
    const result = await promise;
    expect(result).toMatchObject({ error: 'window blocked' });
    expect(listeners).toHaveLength(0);
  });

  it('removes its listener after a matching message resolves the promise', async () => {
    const promise = openPickerPopup('directory', [], 'req-cleanup');
    expect(listeners).toHaveLength(1);
    listeners[0]({
      source: 'picker-popup',
      kind: 'directory',
      requestId: 'req-cleanup',
      handleInIdb: true,
      idbKey: 'pendingMount:req-cleanup',
    });
    await promise;
    expect(listeners).toHaveLength(0);
  });

  it('throws when chrome.windows.create is not available', async () => {
    delete (globalThis as unknown as { chrome?: unknown }).chrome;
    await expect(openPickerPopup('usb-device', [])).rejects.toThrow(
      /chrome\.windows\.create not available/
    );
  });

  it('removes the runtime.onMessage listener when timeoutMs elapses', async () => {
    vi.useFakeTimers();
    try {
      const promise = openPickerPopup('usb-device', [], 'req-timeout', { timeoutMs: 1_000 });
      expect(listeners).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1_000);
      const result = await promise;
      expect(result).toMatchObject({ cancelled: true });
      expect(listeners).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('removes the listener and resolves cancelled when the popup window is closed', async () => {
    let removedListeners: WindowRemovedListener[] = [];
    (globalThis as unknown as { chrome: unknown }).chrome = {
      runtime: {
        id: 'ext-id',
        getURL: (path: string) => `chrome-extension://ext-id/${path}`,
        onMessage: {
          addListener: (l: Listener) => {
            listeners.push(l);
          },
          removeListener: (l: Listener) => {
            listeners = listeners.filter((x) => x !== l);
          },
        },
      },
      windows: {
        create: (opts: { url: string }) => {
          createCalls.push({ url: opts.url });
          return Promise.resolve({ id: 42 });
        },
        onRemoved: {
          addListener: (l: WindowRemovedListener) => {
            removedListeners.push(l);
          },
          removeListener: (l: WindowRemovedListener) => {
            removedListeners = removedListeners.filter((x) => x !== l);
          },
        },
      },
    };
    const promise = openPickerPopup('hid-device', [], 'req-closed');
    // Microtask hop so window.create resolves and popupWindowId is captured.
    await Promise.resolve();
    await Promise.resolve();
    expect(listeners).toHaveLength(1);
    expect(removedListeners).toHaveLength(1);
    removedListeners[0](42);
    const result = await promise;
    expect(result).toMatchObject({ cancelled: true });
    expect(listeners).toHaveLength(0);
    expect(removedListeners).toHaveLength(0);
  });

  it('ignores onRemoved events for other windows', async () => {
    let removedListeners: WindowRemovedListener[] = [];
    (globalThis as unknown as { chrome: unknown }).chrome = {
      runtime: {
        id: 'ext-id',
        getURL: (path: string) => `chrome-extension://ext-id/${path}`,
        onMessage: {
          addListener: (l: Listener) => {
            listeners.push(l);
          },
          removeListener: (l: Listener) => {
            listeners = listeners.filter((x) => x !== l);
          },
        },
      },
      windows: {
        create: () => Promise.resolve({ id: 7 }),
        onRemoved: {
          addListener: (l: WindowRemovedListener) => {
            removedListeners.push(l);
          },
          removeListener: (l: WindowRemovedListener) => {
            removedListeners = removedListeners.filter((x) => x !== l);
          },
        },
      },
    };
    const promise = openPickerPopup('serial-port', [], 'req-other');
    await Promise.resolve();
    await Promise.resolve();
    // Unrelated window id: must NOT settle the promise or tear down listeners.
    removedListeners[0](99);
    expect(listeners).toHaveLength(1);
    // Real message still wins.
    listeners[0]({
      source: 'picker-popup',
      kind: 'serial-port',
      requestId: 'req-other',
      cancelled: true,
    });
    const result = await promise;
    expect(result).toMatchObject({ cancelled: true });
    expect(listeners).toHaveLength(0);
  });
});
