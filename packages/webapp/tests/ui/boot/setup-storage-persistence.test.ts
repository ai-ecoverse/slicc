import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetStoragePersistenceForTest,
  requestStoragePersistence,
  setupStoragePersistence,
} from '../../../src/ui/boot/setup-storage-persistence.js';

interface StorageStub {
  persisted?: () => Promise<boolean>;
  persist?: () => Promise<boolean>;
}

async function withNavigatorStorage(storage: StorageStub | undefined, fn: () => Promise<void>) {
  const globals = globalThis as { navigator?: { storage?: StorageStub } };
  const had = Object.hasOwn(globals, 'navigator');
  const previous = globals.navigator;
  Object.defineProperty(globals, 'navigator', {
    value: storage === undefined ? {} : { storage },
    configurable: true,
    writable: true,
  });
  try {
    await fn();
  } finally {
    if (had) {
      Object.defineProperty(globals, 'navigator', {
        value: previous,
        configurable: true,
        writable: true,
      });
    } else {
      delete globals.navigator;
    }
  }
}

describe('requestStoragePersistence', () => {
  beforeEach(() => {
    __resetStoragePersistenceForTest();
  });

  it('requests persistence and reports the grant', async () => {
    const persist = vi.fn(async () => true);
    const outcome = await requestStoragePersistence({ persisted: async () => false, persist });

    expect(outcome).toBe('granted');
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it('does not re-request when the bucket is already persistent', async () => {
    const persist = vi.fn(async () => true);
    const outcome = await requestStoragePersistence({ persisted: async () => true, persist });

    expect(outcome).toBe('already-persisted');
    expect(persist).not.toHaveBeenCalled();
  });

  it('reports a denial distinctly from an unsupported runtime', async () => {
    expect(
      await requestStoragePersistence({ persisted: async () => false, persist: async () => false })
    ).toBe('denied');
    expect(await requestStoragePersistence({})).toBe('unsupported');
    expect(await requestStoragePersistence(undefined)).toBe('unsupported');
  });

  it('still requests when only persist() is implemented', async () => {
    const persist = vi.fn(async () => true);
    expect(await requestStoragePersistence({ persist })).toBe('granted');
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it('swallows a rejecting storage API rather than throwing at the caller', async () => {
    const outcome = await requestStoragePersistence({
      persisted: async () => false,
      persist: async () => {
        throw new Error('SecurityError');
      },
    });

    expect(outcome).toBe('failed');
  });

  it('treats a rejecting persisted() as a failure, not a silent skip', async () => {
    const persist = vi.fn(async () => true);
    const outcome = await requestStoragePersistence({
      persisted: async () => {
        throw new Error('nope');
      },
      persist,
    });

    expect(outcome).toBe('failed');
    expect(persist).not.toHaveBeenCalled();
  });

  it('does not reject when property access on the storage manager throws', async () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error('hardened');
        },
      }
    ) as StorageStub;

    await expect(requestStoragePersistence(hostile)).resolves.toBe('failed');
  });

  it('reads navigator.storage when no argument is passed', async () => {
    const persist = vi.fn(async () => true);
    await withNavigatorStorage({ persisted: async () => false, persist }, async () => {
      expect(await requestStoragePersistence()).toBe('granted');
    });
    expect(persist).toHaveBeenCalledTimes(1);
  });
});

describe('setupStoragePersistence', () => {
  beforeEach(() => {
    __resetStoragePersistenceForTest();
  });

  it('fires the request and returns synchronously — boot never awaits it', async () => {
    let resolvePersist: (value: boolean) => void = () => {};
    const persist = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolvePersist = resolve;
        })
    );

    await withNavigatorStorage({ persisted: async () => false, persist }, async () => {
      expect(setupStoragePersistence()).toBeUndefined();

      await vi.waitFor(() => expect(persist).toHaveBeenCalledTimes(1));
      resolvePersist(true);
      await Promise.resolve();
    });
  });

  it('requests at most once per page', async () => {
    const persist = vi.fn(async () => true);
    await withNavigatorStorage({ persisted: async () => false, persist }, async () => {
      setupStoragePersistence();
      setupStoragePersistence();
      setupStoragePersistence();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(persist).toHaveBeenCalledTimes(1);
  });

  it('does not leak an unhandled rejection when the outcome logger throws', async () => {
    vi.resetModules();
    vi.doMock('../../../src/base/logger.js', () => ({
      createLogger: () => ({
        debug: () => {},
        info: () => {
          throw new Error('logger blew up');
        },
        warn: () => {},
        error: () => {},
      }),
    }));

    const rejections: unknown[] = [];
    const onUnhandled = (reason: unknown) => rejections.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const mod = await import('../../../src/ui/boot/setup-storage-persistence.js');
      await withNavigatorStorage(
        { persisted: async () => false, persist: async () => true },
        async () => {
          mod.setupStoragePersistence();

          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      );
    } finally {
      process.off('unhandledRejection', onUnhandled);
      vi.doUnmock('../../../src/base/logger.js');
      vi.resetModules();
    }

    expect(rejections).toEqual([]);
  });

  it('does not throw or reject when the storage API is missing or hostile', async () => {
    await withNavigatorStorage(undefined, async () => {
      expect(() => setupStoragePersistence()).not.toThrow();
    });

    __resetStoragePersistenceForTest();
    await withNavigatorStorage(
      {
        persist: () => Promise.reject(new Error('SecurityError')),
      },
      async () => {
        expect(() => setupStoragePersistence()).not.toThrow();
        await Promise.resolve();
        await Promise.resolve();
      }
    );
  });
});
