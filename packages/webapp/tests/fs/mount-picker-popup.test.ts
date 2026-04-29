import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  openMountPickerPopup,
  loadAndClearPendingHandle,
  reactivateHandle,
} from '../../src/fs/mount-picker-popup.js';

/** Minimal mock of FileSystemDirectoryHandle. */
function mockHandle(name: string): FileSystemDirectoryHandle {
  return { kind: 'directory', name } as unknown as FileSystemDirectoryHandle;
}

/** Write a handle directly to the popup's IDB store (simulating mount-popup.js). */
async function seedHandle(idbKey: string, handle: FileSystemDirectoryHandle): Promise<void> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open('slicc-pending-mount', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('handles');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  const tx = db.transaction('handles', 'readwrite');
  tx.objectStore('handles').put(handle, idbKey);
  await new Promise<void>((resolve) => {
    tx.oncomplete = () => resolve();
  });
  db.close();
}

async function readHandle(idbKey: string): Promise<FileSystemDirectoryHandle | null> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open('slicc-pending-mount', 1);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  const tx = db.transaction('handles', 'readonly');
  const result = await new Promise<FileSystemDirectoryHandle | null>((resolve) => {
    const req = tx.objectStore('handles').get(idbKey);
    req.onsuccess = () => resolve((req.result as FileSystemDirectoryHandle | undefined) ?? null);
    req.onerror = () => resolve(null);
  });
  db.close();
  return result;
}

describe('loadAndClearPendingHandle', () => {
  beforeEach(async () => {
    indexedDB.deleteDatabase('slicc-pending-mount');
  });

  it('returns null when no handle is stored under the key', async () => {
    const result = await loadAndClearPendingHandle('missing-key');
    expect(result).toBeNull();
  });

  it('returns the stored handle and removes it from IDB', async () => {
    const handle = mockHandle('my-project');
    await seedHandle('pendingMount:request-1', handle);
    const result = await loadAndClearPendingHandle('pendingMount:request-1');
    expect(result).not.toBeNull();
    expect(result?.name).toBe('my-project');
    // Subsequent read should be empty (load-and-clear semantics)
    const after = await readHandle('pendingMount:request-1');
    expect(after).toBeNull();
  });

  it('only clears the targeted key, leaving other entries intact', async () => {
    await seedHandle('pendingMount:a', mockHandle('a'));
    await seedHandle('pendingMount:b', mockHandle('b'));
    await loadAndClearPendingHandle('pendingMount:a');
    const survivor = await readHandle('pendingMount:b');
    expect(survivor?.name).toBe('b');
  });
});

describe('reactivateHandle', () => {
  it('is a no-op when handle has no requestPermission method', async () => {
    const handle = mockHandle('legacy-handle');
    await expect(reactivateHandle(handle)).resolves.toBeUndefined();
  });

  it('resolves when permission is granted', async () => {
    const requestPermission = vi.fn().mockResolvedValue('granted');
    const handle = {
      kind: 'directory',
      name: 'granted-folder',
      requestPermission,
    } as unknown as FileSystemDirectoryHandle;
    await reactivateHandle(handle);
    expect(requestPermission).toHaveBeenCalledWith({ mode: 'readwrite' });
  });

  it('throws with the handle name and state when permission is denied', async () => {
    const handle = {
      kind: 'directory',
      name: 'denied-folder',
      requestPermission: vi.fn().mockResolvedValue('denied'),
    } as unknown as FileSystemDirectoryHandle;
    await expect(reactivateHandle(handle)).rejects.toThrow(
      'Permission denied for "denied-folder" (denied)'
    );
  });

  it('throws when permission stays in "prompt" state (user dismissed without choosing)', async () => {
    // The File System Access API spec defines `prompt` alongside granted/denied
    // — Chromium can return it when the user closes the permission dialog
    // without making a choice. Treat it the same as denied: no readwrite
    // access, fail fast with a useful message.
    const handle = {
      kind: 'directory',
      name: 'unresolved-folder',
      requestPermission: vi.fn().mockResolvedValue('prompt'),
    } as unknown as FileSystemDirectoryHandle;
    await expect(reactivateHandle(handle)).rejects.toThrow(
      'Permission denied for "unresolved-folder" (prompt)'
    );
  });
});

describe('openMountPickerPopup', () => {
  type Listener = (msg: unknown) => void;
  let listeners: Listener[];
  let createCalls: Array<{ url: string }>;
  let createImpl: () => Promise<unknown>;

  beforeEach(() => {
    listeners = [];
    createCalls = [];
    createImpl = () => Promise.resolve({});
    vi.useFakeTimers();
    (globalThis as unknown as { chrome: unknown }).chrome = {
      runtime: {
        getURL: (path: string) => `chrome-extension://test-id/${path}`,
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
    vi.useRealTimers();
    delete (globalThis as unknown as { chrome?: unknown }).chrome;
  });

  it('opens a popup window pointed at mount-popup.html with the request id', async () => {
    const promise = openMountPickerPopup('test-req-1');
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0].url).toContain('mount-popup.html');
    expect(createCalls[0].url).toContain('requestId=test-req-1');
    // Resolve via popup message
    listeners[0]({
      source: 'mount-popup',
      requestId: 'test-req-1',
      handleInIdb: true,
      idbKey: 'pendingMount:test-req-1',
    });
    const result = await promise;
    expect(result).toMatchObject({ handleInIdb: true, idbKey: 'pendingMount:test-req-1' });
  });

  it('generates a fallback request id when none is provided', async () => {
    const promise = openMountPickerPopup();
    expect(createCalls[0].url).toMatch(/requestId=mount-[a-z0-9]+/);
    listeners[0]({ source: 'mount-popup', requestId: extractRequestId(createCalls[0].url) });
    await promise;
  });

  it('ignores messages with mismatched request ids', async () => {
    const promise = openMountPickerPopup('req-A');
    listeners[0]({ source: 'mount-popup', requestId: 'req-B', cancelled: true });
    listeners[0]({ source: 'something-else', requestId: 'req-A', cancelled: true });
    // Still pending — only the matching message resolves
    listeners[0]({ source: 'mount-popup', requestId: 'req-A', cancelled: true });
    const result = await promise;
    expect(result).toMatchObject({ cancelled: true });
  });

  it('resolves with cancelled when 60s timeout fires', async () => {
    const promise = openMountPickerPopup('timeout-req');
    vi.advanceTimersByTime(60_000);
    const result = await promise;
    expect(result).toMatchObject({ cancelled: true });
    // Listener was unregistered on timeout
    expect(listeners).toHaveLength(0);
  });

  it('resolves with error when chrome.windows.create rejects', async () => {
    createImpl = () => Promise.reject(new Error('window blocked'));
    const promise = openMountPickerPopup('err-req');
    const result = await promise;
    expect(result).toMatchObject({ error: 'Failed to open directory picker window' });
    expect(listeners).toHaveLength(0);
  });

  it('removes listener and clears timer after a successful resolve', async () => {
    const promise = openMountPickerPopup('cleanup-req');
    expect(listeners).toHaveLength(1);
    listeners[0]({ source: 'mount-popup', requestId: 'cleanup-req', handleInIdb: true });
    await promise;
    expect(listeners).toHaveLength(0);
    // Advancing past the timeout shouldn't double-resolve or throw
    vi.advanceTimersByTime(120_000);
  });
});

function extractRequestId(url: string): string {
  const match = url.match(/requestId=([^&]+)/);
  if (!match) throw new Error(`No requestId in url: ${url}`);
  return decodeURIComponent(match[1]);
}
