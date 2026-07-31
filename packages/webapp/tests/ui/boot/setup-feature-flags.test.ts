import { afterEach, describe, expect, it, vi } from 'vitest';
import { FEATURE_FLAG_STORAGE_KEY, isFeatureEnabled } from '../../../src/core/feature-flags.js';
import {
  FEATURE_FLAGS_REMOTE_STORAGE_KEY,
  featureFlagsRemoteCacheKey,
} from '../../../src/core/feature-flags-remote.js';
import { setupFeatureFlagsForPage } from '../../../src/ui/boot/setup-feature-flags.js';

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, String(value)),
    removeItem: (key) => void values.delete(key),
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
  } as Storage;
}

afterEach(() => vi.unstubAllGlobals());

describe('feature flag page boot', () => {
  it('applies the last-known-good cache before the lazy refresh starts', async () => {
    const storage = memoryStorage();
    storage.setItem(
      featureFlagsRemoteCacheKey('cherry'),
      JSON.stringify({ 'experimental-settings': 'on' })
    );
    const fetchImpl = vi.fn(() => Promise.resolve(new Response(null, { status: 503 })));
    vi.stubGlobal('fetch', fetchImpl);

    setupFeatureFlagsForPage({
      locationHref: 'https://app.example/?cherry=1',
      storage,
      envBaseUrl: null,
      isDev: false,
      isExtension: false,
    });

    expect(isFeatureEnabled('experimental-settings')).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());
  });

  it('boots ?cherry=1 synchronously and refreshes its float-isolated cache lazily', async () => {
    const storage = memoryStorage();
    const enabled = JSON.stringify({ 'experimental-settings': 'on' });
    storage.setItem(FEATURE_FLAG_STORAGE_KEY, enabled);
    storage.setItem(FEATURE_FLAGS_REMOTE_STORAGE_KEY, enabled);
    storage.setItem(featureFlagsRemoteCacheKey('standalone'), enabled);
    const fetchImpl = vi.fn(() => Promise.resolve(new Response(null, { status: 503 })));
    vi.stubGlobal('fetch', fetchImpl);

    const runtimeMode = setupFeatureFlagsForPage({
      locationHref: 'https://app.example/?cherry=1',
      storage,
      envBaseUrl: null,
      isDev: false,
      isExtension: false,
    });

    expect(runtimeMode).toBe('cherry');
    expect(isFeatureEnabled('experimental-settings')).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://app.example/api/flags?float=cherry',
      expect.objectContaining({ cache: 'no-store' })
    );
    expect(storage.getItem(featureFlagsRemoteCacheKey('cherry'))).toBeNull();
  });
});
