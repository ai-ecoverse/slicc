import { describe, expect, it, vi } from 'vitest';
import {
  TRAY_JOIN_STORAGE_KEY,
  TRAY_WORKER_STORAGE_KEY,
} from '../../src/scoops/tray-runtime-config.js';
import { performFollowerSwitchOut } from '../../src/ui/follower-switch-out.js';

function memStorage(entries: Record<string, string> = {}) {
  const map = new Map(Object.entries(entries));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    has: (k: string) => map.has(k),
  };
}

// A page URL with no follower marker; the default for tests that don't exercise
// URL normalization.
const PLAIN_HREF = 'https://www.sliccy.ai/';

describe('performFollowerSwitchOut', () => {
  it('stop following: clears BOTH keys, stops follower, reloads', () => {
    const storage = memStorage({ [TRAY_JOIN_STORAGE_KEY]: 'j', [TRAY_WORKER_STORAGE_KEY]: 'w' });
    const stopFollower = vi.fn();
    const reload = vi.fn();
    performFollowerSwitchOut(
      { workerBaseUrl: null },
      { storage, stopFollower, getHref: () => PLAIN_HREF, replaceHref: vi.fn(), reload }
    );
    expect(storage.has(TRAY_JOIN_STORAGE_KEY)).toBe(false);
    expect(storage.has(TRAY_WORKER_STORAGE_KEY)).toBe(false);
    expect(stopFollower).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('become leader: clears join key, sets worker key, reloads (never starts leader in place)', () => {
    const storage = memStorage({ [TRAY_JOIN_STORAGE_KEY]: 'j' });
    const reload = vi.fn();
    performFollowerSwitchOut(
      { workerBaseUrl: 'https://www.sliccy.ai' },
      { storage, stopFollower: vi.fn(), getHref: () => PLAIN_HREF, replaceHref: vi.fn(), reload }
    );
    expect(storage.has(TRAY_JOIN_STORAGE_KEY)).toBe(false);
    expect(storage.getItem(TRAY_WORKER_STORAGE_KEY)).toBe('https://www.sliccy.ai');
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('strips a …/join/<token> entry URL before reload so it does not re-enter follower', () => {
    const storage = memStorage({ [TRAY_JOIN_STORAGE_KEY]: 'j' });
    const replaceHref = vi.fn();
    const reload = vi.fn();
    performFollowerSwitchOut(
      { workerBaseUrl: null },
      {
        storage,
        stopFollower: vi.fn(),
        getHref: () => 'https://www.sliccy.ai/join/tray-1.cap-token',
        replaceHref,
        reload,
      }
    );
    expect(replaceHref).toHaveBeenCalledWith('https://www.sliccy.ai/');
    // URL rewrite happens before the reload.
    expect(replaceHref.mock.invocationCallOrder[0]).toBeLessThan(
      reload.mock.invocationCallOrder[0]
    );
  });

  it('strips a ?tray= entry URL before reload', () => {
    const join = 'https://www.sliccy.ai/join/tray-1.cap-token';
    const replaceHref = vi.fn();
    const reload = vi.fn();
    performFollowerSwitchOut(
      { workerBaseUrl: null },
      {
        storage: memStorage(),
        stopFollower: vi.fn(),
        getHref: () => `http://localhost:5710/?tray=${encodeURIComponent(join)}`,
        replaceHref,
        reload,
      }
    );
    expect(replaceHref).toHaveBeenCalledWith('http://localhost:5710/');
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('does not rewrite the URL when there is no follower marker', () => {
    const replaceHref = vi.fn();
    const reload = vi.fn();
    performFollowerSwitchOut(
      { workerBaseUrl: null },
      {
        storage: memStorage(),
        stopFollower: vi.fn(),
        getHref: () => PLAIN_HREF,
        replaceHref,
        reload,
      }
    );
    expect(replaceHref).not.toHaveBeenCalled();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('still reloads when storage writes throw (quota / private mode)', () => {
    const throwingStorage = {
      getItem: () => null,
      setItem: () => {
        throw new DOMException('quota', 'QuotaExceededError');
      },
      removeItem: () => {
        throw new DOMException('denied', 'SecurityError');
      },
    };
    const reload = vi.fn();
    const stopFollower = vi.fn();
    expect(() =>
      performFollowerSwitchOut(
        { workerBaseUrl: null },
        {
          storage: throwingStorage,
          stopFollower,
          getHref: () => PLAIN_HREF,
          replaceHref: vi.fn(),
          reload,
        }
      )
    ).not.toThrow();
    expect(stopFollower).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('still reloads when replaceHref throws (e.g. history.replaceState rejects)', () => {
    const reload = vi.fn();
    expect(() =>
      performFollowerSwitchOut(
        { workerBaseUrl: null },
        {
          storage: memStorage(),
          stopFollower: vi.fn(),
          getHref: () => 'https://www.sliccy.ai/join/tok',
          replaceHref: () => {
            throw new Error('replaceState failed');
          },
          reload,
        }
      )
    ).not.toThrow();
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
