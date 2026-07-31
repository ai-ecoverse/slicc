import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  coerceFeatureFlagValue,
  FEATURE_FLAG_STORAGE_KEY,
  getFeatureValue,
  initFeatureFlags,
  isFeatureEnabled,
  listFlags,
  readFeatureFlagOverrides,
  resolveFlags,
  resolveFlagValue,
  setFeatureFlagOverride,
  writeFeatureFlagOverrides,
} from '../../src/core/feature-flags.js';

function makeMemoryStorage(): Storage {
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

beforeEach(() => {
  vi.stubGlobal('localStorage', makeMemoryStorage());
  initFeatureFlags('standalone');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('feature flag registry', () => {
  it('lists the experimental settings string flag', () => {
    expect(listFlags()).toEqual([
      expect.objectContaining({
        id: 'experimental-settings',
        label: 'Experimental settings',
        defaultValue: 'on',
        userToggleable: true,
      }),
    ]);
  });

  it('uses float-aware bundled defaults', () => {
    expect(resolveFlagValue('experimental-settings', 'standalone')).toBe('on');
    expect(resolveFlagValue('experimental-settings', 'extension')).toBe('on');
    expect(resolveFlagValue('experimental-settings', 'cherry')).toBe('off');
  });

  it('applies a permitted string override', () => {
    expect(
      resolveFlagValue('experimental-settings', 'standalone', {
        'experimental-settings': 'variant-a',
      })
    ).toBe('variant-a');
  });

  it('ignores an override on a float where overrides are not permitted', () => {
    expect(
      resolveFlagValue('experimental-settings', 'cherry', {
        'experimental-settings': 'on',
      })
    ).toBe('off');
  });

  it('resolves local override before central value before bundled default', () => {
    expect(resolveFlags('standalone', { 'experimental-settings': 'off' })).toEqual({
      'experimental-settings': 'off',
    });
    expect(
      resolveFlags(
        'standalone',
        { 'experimental-settings': 'off' },
        { 'experimental-settings': 'on' }
      )
    ).toEqual({ 'experimental-settings': 'on' });
  });

  it('round-trips string overrides through one localStorage key', () => {
    writeFeatureFlagOverrides({ 'experimental-settings': 'variant-b' });
    expect(localStorage.getItem(FEATURE_FLAG_STORAGE_KEY)).toBe(
      JSON.stringify({ 'experimental-settings': 'variant-b' })
    );
    expect(readFeatureFlagOverrides()).toEqual({ 'experimental-settings': 'variant-b' });
  });

  it('updates and clears the active float override', () => {
    setFeatureFlagOverride('experimental-settings', 'off');
    expect(getFeatureValue('experimental-settings')).toBe('off');
    setFeatureFlagOverride('experimental-settings', undefined);
    expect(getFeatureValue('experimental-settings')).toBe('on');
  });

  it('does not persist an override for cherry', () => {
    initFeatureFlags('cherry');
    setFeatureFlagOverride('experimental-settings', 'on');
    expect(readFeatureFlagOverrides()).toEqual({});
    expect(getFeatureValue('experimental-settings')).toBe('off');
  });

  it('falls back to defaults for corrupt or malformed storage', () => {
    localStorage.setItem(FEATURE_FLAG_STORAGE_KEY, '{not-json');
    expect(getFeatureValue('experimental-settings')).toBe('on');
    localStorage.setItem(
      FEATURE_FLAG_STORAGE_KEY,
      JSON.stringify({
        'experimental-settings': false,
        unknown: 'on',
      })
    );
    expect(readFeatureFlagOverrides()).toEqual({});
  });

  it('does not throw when localStorage is unavailable', () => {
    vi.stubGlobal('localStorage', undefined);
    expect(() => writeFeatureFlagOverrides({ 'experimental-settings': 'off' })).not.toThrow();
    expect(readFeatureFlagOverrides()).toEqual({});
    expect(getFeatureValue('experimental-settings')).toBe('on');
  });

  it('uses the documented boolean coercion', () => {
    for (const value of ['on', 'ON', ' true ', '1']) {
      expect(coerceFeatureFlagValue(value)).toBe(true);
    }
    for (const value of ['off', 'false', '0', 'variant-a', '', undefined]) {
      expect(coerceFeatureFlagValue(value)).toBe(false);
    }
    initFeatureFlags('standalone', { 'experimental-settings': 'true' });
    expect(isFeatureEnabled('experimental-settings')).toBe(true);
  });

  it('degrades an unknown runtime id without throwing', () => {
    const unknownId = 'not-registered' as 'experimental-settings';
    expect(resolveFlagValue(unknownId, 'standalone')).toBeUndefined();
    expect(isFeatureEnabled(unknownId)).toBe(false);
  });
});
