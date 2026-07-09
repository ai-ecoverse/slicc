import { afterEach, describe, expect, it, vi } from 'vitest';
import { wipeLocalStorageState } from '../../../src/shell/supplemental-commands/wipe-local-storage-state.js';

describe('wipeLocalStorageState', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('unregisters service workers, deletes every IDB, and removes every OPFS root entry', async () => {
    const unregister = vi.fn(async () => true);
    const getRegistrations = vi.fn(async () => [{ unregister }, { unregister }]);

    const deleted: string[] = [];
    const deleteDatabase = vi.fn((name: string) => {
      deleted.push(name);
      const req: {
        onsuccess: (() => void) | null;
        onerror: (() => void) | null;
        onblocked: (() => void) | null;
      } = {
        onsuccess: null,
        onerror: null,
        onblocked: null,
      };
      // Resolve asynchronously like the real API.
      queueMicrotask(() => req.onsuccess?.());
      return req;
    });
    vi.stubGlobal('indexedDB', {
      databases: async () => [
        { name: 'slicc-fs' },
        { name: 'agent-sessions' },
        { name: undefined },
      ],
      deleteDatabase,
    });

    const removeEntry = vi.fn(async (_name: string, _opts?: { recursive: boolean }) => undefined);
    const entries = ['slicc-fs', 'slicc-fs-global', 'leftover-mount'];
    async function* keys(): AsyncIterableIterator<string> {
      for (const name of entries) yield name;
    }
    vi.stubGlobal('navigator', {
      serviceWorker: { getRegistrations },
      storage: { getDirectory: async () => ({ keys, removeEntry }) },
    });

    await wipeLocalStorageState();

    expect(getRegistrations).toHaveBeenCalledTimes(1);
    expect(unregister).toHaveBeenCalledTimes(2);

    // The `undefined`-named db is skipped; the two named ones are deleted.
    expect(deleted).toEqual(['slicc-fs', 'agent-sessions']);

    expect(removeEntry).toHaveBeenCalledTimes(entries.length);
    for (const name of entries) {
      expect(removeEntry).toHaveBeenCalledWith(name, { recursive: true });
    }
  });

  it('resolves cleanly when OPFS is unavailable', async () => {
    vi.stubGlobal('indexedDB', { databases: async () => [], deleteDatabase: vi.fn() });
    vi.stubGlobal('navigator', {
      serviceWorker: { getRegistrations: async () => [] },
      storage: {},
    });

    await expect(wipeLocalStorageState()).resolves.toBeUndefined();
  });

  it('never rejects when a step throws (best-effort)', async () => {
    vi.stubGlobal('indexedDB', {
      databases: async () => {
        throw new Error('databases unsupported');
      },
      deleteDatabase: vi.fn(),
    });
    vi.stubGlobal('navigator', {
      serviceWorker: {
        getRegistrations: async () => {
          throw new Error('no sw');
        },
      },
      storage: {
        getDirectory: async () => {
          throw new Error('opfs blocked');
        },
      },
    });

    await expect(wipeLocalStorageState()).resolves.toBeUndefined();
  });
});
