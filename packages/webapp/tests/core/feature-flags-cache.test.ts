import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getFeatureValue, initFeatureFlags } from '../../src/core/feature-flags.js';
import {
  type FeatureFlagsRemoteStorage,
  featureFlagsRemoteCacheKey,
  initFeatureFlagsFromRemoteCache,
  resolveFeatureFlagsRemoteStorage,
  writeFeatureFlagsRemoteCache,
} from '../../src/core/feature-flags-cache.js';

function makeMemoryStorage(): FeatureFlagsRemoteStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
  };
}

beforeEach(() => {
  initFeatureFlags('standalone');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('feature flag remote cache', () => {
  it('round-trips cached flags through storage on init', () => {
    const storage = makeMemoryStorage();
    writeFeatureFlagsRemoteCache(storage, 'standalone', { 'panel-layouts': 'on' });

    initFeatureFlagsFromRemoteCache('standalone', storage);

    expect(getFeatureValue('panel-layouts')).toBe('on');
  });

  it('ignores a cached array payload and falls back to defaults', () => {
    const storage = makeMemoryStorage();
    storage.setItem(featureFlagsRemoteCacheKey('standalone'), JSON.stringify(['panel-layouts']));

    initFeatureFlagsFromRemoteCache('standalone', storage);

    // Bundled default for panel-layouts is 'off'.
    expect(getFeatureValue('panel-layouts')).toBe('off');
  });

  it('rejects a cache whose values are not all strings', () => {
    const storage = makeMemoryStorage();
    storage.setItem(
      featureFlagsRemoteCacheKey('standalone'),
      JSON.stringify({ 'panel-layouts': true })
    );

    initFeatureFlagsFromRemoteCache('standalone', storage);

    expect(getFeatureValue('panel-layouts')).toBe('off');
  });

  it('ignores malformed JSON in the cache', () => {
    const storage = makeMemoryStorage();
    storage.setItem(featureFlagsRemoteCacheKey('standalone'), '{not-json');

    expect(() => initFeatureFlagsFromRemoteCache('standalone', storage)).not.toThrow();
    expect(getFeatureValue('panel-layouts')).toBe('off');
  });

  it('swallows setItem failures so fetched values stay active', () => {
    const storage: FeatureFlagsRemoteStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error('quota exceeded');
      },
    };

    expect(() =>
      writeFeatureFlagsRemoteCache(storage, 'standalone', { 'panel-layouts': 'on' })
    ).not.toThrow();
  });

  it('prefers an explicitly provided storage over the global', () => {
    const explicit = makeMemoryStorage();
    expect(resolveFeatureFlagsRemoteStorage(explicit)).toBe(explicit);
    expect(resolveFeatureFlagsRemoteStorage(null)).toBeNull();
  });

  it('resolves the global localStorage when none is passed', () => {
    const global = makeMemoryStorage();
    vi.stubGlobal('localStorage', global);
    expect(resolveFeatureFlagsRemoteStorage()).toBe(global);
  });
});
