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

describe('performFollowerSwitchOut', () => {
  it('stop following: clears BOTH keys, stops follower, reloads', () => {
    const storage = memStorage({ [TRAY_JOIN_STORAGE_KEY]: 'j', [TRAY_WORKER_STORAGE_KEY]: 'w' });
    const stopFollower = vi.fn();
    const reload = vi.fn();
    performFollowerSwitchOut({ workerBaseUrl: null }, { storage, stopFollower, reload });
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
      { storage, stopFollower: vi.fn(), reload }
    );
    expect(storage.has(TRAY_JOIN_STORAGE_KEY)).toBe(false);
    expect(storage.getItem(TRAY_WORKER_STORAGE_KEY)).toBe('https://www.sliccy.ai');
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
