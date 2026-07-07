// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  broadcastStaleAssetReload,
  setStaleAssetInstanceId,
} from '../../../src/core/stale-asset-channel.js';
import {
  __resetForTest,
  decideStaleReload,
  guardedReload,
  installWorkerStaleAssetReloadListener,
  RELOAD_WINDOW_MS,
  setupPreloadErrorReload,
} from '../../../src/ui/boot/setup-preload-error-reload.js';
import {
  installFakeBroadcastChannel,
  resetFakeBroadcastChannel,
} from '../../helpers/fake-broadcast-channel.js';

function makeStorage(initial: Record<string, string> = {}, opts: { throwOn?: 'get' | 'set' } = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => {
      if (opts.throwOn === 'get') throw new Error('storage disabled');
      return map.get(k) ?? null;
    },
    setItem: (k: string, v: string) => {
      if (opts.throwOn === 'set') throw new Error('storage disabled');
      map.set(k, v);
    },
  };
}

describe('decideStaleReload', () => {
  it('reloads when no prior timestamp; suppresses within window; allows past window', () => {
    expect(decideStaleReload(null, 1_000, RELOAD_WINDOW_MS)).toBe(true);
    expect(decideStaleReload(1_000, 1_000 + 5_000, RELOAD_WINDOW_MS)).toBe(false);
    expect(decideStaleReload(1_000, 1_000 + RELOAD_WINDOW_MS, RELOAD_WINDOW_MS)).toBe(true);
  });
});

describe('guardedReload', () => {
  it('reloads once, persists, suppresses in-window, reloads again past window', () => {
    const reload = vi.fn();
    const storage = makeStorage();
    let t = 10_000;
    const deps = { reload, storage, now: () => t, windowMs: RELOAD_WINDOW_MS, storageKey: 'k' };
    expect(guardedReload(deps)).toBe(true);
    t += 5_000;
    expect(guardedReload(deps)).toBe(false);
    t += RELOAD_WINDOW_MS;
    expect(guardedReload(deps)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
  });
  it('fail-closed on storage throw (get or set): no reload, no throw', () => {
    const reload = vi.fn();
    for (const throwOn of ['get', 'set'] as const) {
      expect(() =>
        guardedReload({
          reload,
          storage: makeStorage({}, { throwOn }),
          now: () => 1,
          windowMs: RELOAD_WINDOW_MS,
          storageKey: 'k',
        })
      ).not.toThrow();
    }
    expect(reload).not.toHaveBeenCalled();
  });
});

describe('setupPreloadErrorReload (page trigger)', () => {
  beforeEach(() => __resetForTest());
  afterEach(() => __resetForTest());

  it('reloads on vite:preloadError; preventDefaults only when it reloads; suppresses in-window', () => {
    const reload = vi.fn();
    const storage = makeStorage();
    let t = 1_000;
    setupPreloadErrorReload({
      reload,
      storage,
      now: () => t,
      windowMs: RELOAD_WINDOW_MS,
      storageKey: 'k',
    });

    const e1 = new Event('vite:preloadError', { cancelable: true });
    window.dispatchEvent(e1);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(e1.defaultPrevented).toBe(true);

    t += 5_000;
    const e2 = new Event('vite:preloadError', { cancelable: true });
    window.dispatchEvent(e2);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(e2.defaultPrevented).toBe(false);
  });
});

describe('installWorkerStaleAssetReloadListener (worker trigger)', () => {
  beforeEach(() => {
    __resetForTest();
    installFakeBroadcastChannel();
  });
  afterEach(() => {
    setStaleAssetInstanceId(undefined);
    resetFakeBroadcastChannel();
    __resetForTest();
  });

  it('runs the guarded reload on a matching-instanceId broadcast, ignores non-matching', async () => {
    const reload = vi.fn();
    setupPreloadErrorReload({
      reload,
      storage: makeStorage(),
      now: () => 1_000,
      windowMs: RELOAD_WINDOW_MS,
      storageKey: 'k',
    });
    installWorkerStaleAssetReloadListener('inst-A');

    setStaleAssetInstanceId('inst-B'); // other worker
    broadcastStaleAssetReload();
    await Promise.resolve();
    expect(reload).not.toHaveBeenCalled();

    setStaleAssetInstanceId('inst-A'); // our worker
    broadcastStaleAssetReload();
    await Promise.resolve();
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
