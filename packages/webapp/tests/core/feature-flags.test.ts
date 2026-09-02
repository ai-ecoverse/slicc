import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyHostFlagOverrides,
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
  it('lists the registered flags', () => {
    expect(listFlags()).toEqual([
      expect.objectContaining({
        id: 'experimental-settings',
        label: 'Experimental settings',
        defaultValue: 'on',
        userToggleable: false,
      }),
      expect.objectContaining({
        id: 'panel-layouts',
        label: 'Panel layouts',
        defaultValue: 'off',
        userToggleable: true,
      }),
      expect.objectContaining({
        id: 'agentic-memory',
        label: 'Agentic memory',
        description:
          'Curate session memory with a background agent instead of a one-shot extraction call.',
        defaultValue: 'off',
        userToggleable: true,
      }),
      expect.objectContaining({
        id: 'multiple-cones',
        label: 'Multiple cones',
        // Graduated (#2280) — on by default, still toggleable as an opt-out.
        defaultValue: 'on',
        userToggleable: true,
      }),
    ]);
    expect(listFlags()[0]).not.toHaveProperty('overridableFloats');
    expect(listFlags()[2]).not.toHaveProperty('floatDefaults');
  });

  it('gates panel layouts OFF by default on every float', () => {
    // Uniform across floats — no `floatDefaults` — so there is one answer to
    // "are panels on here", including inside a Cherry embed that pushes a layout.
    for (const float of [
      'standalone',
      'extension',
      'electron-overlay',
      'cherry',
      'follower',
    ] as const) {
      expect(resolveFlagValue('panel-layouts', float)).toBe('off');
    }
  });

  it('lets the USER turn panel layouts on — it is toggleable, unlike the settings gate', () => {
    expect(resolveFlagValue('panel-layouts', 'standalone', { 'panel-layouts': 'on' })).toBe('on');
  });

  it('gates agentic memory off on every float and accepts a local override', () => {
    for (const float of [
      'standalone',
      'extension',
      'electron-overlay',
      'extension-detached',
      'hosted-leader',
      'connect',
      'cherry',
      'follower',
    ] as const) {
      initFeatureFlags(float);
      expect(isFeatureEnabled('agentic-memory')).toBe(false);
    }

    initFeatureFlags('standalone');
    setFeatureFlagOverride('agentic-memory', 'on');
    expect(isFeatureEnabled('agentic-memory')).toBe(true);
  });

  it('turns multiple cones ON on every float and accepts a local opt-OUT (#2280)', () => {
    // Graduated: uniform across floats — the leader shell is the only gate, so
    // a follower or Cherry embed resolving `on` still wires nothing from it.
    for (const float of [
      'standalone',
      'extension',
      'electron-overlay',
      'extension-detached',
      'hosted-leader',
      'connect',
      'cherry',
      'follower',
    ] as const) {
      initFeatureFlags(float);
      expect(isFeatureEnabled('multiple-cones')).toBe(true);
    }

    initFeatureFlags('standalone');
    setFeatureFlagOverride('multiple-cones', 'off');
    expect(isFeatureEnabled('multiple-cones')).toBe(false);
  });

  it('uses float-aware bundled defaults', () => {
    expect(resolveFlagValue('experimental-settings', 'standalone')).toBe('on');
    expect(resolveFlagValue('experimental-settings', 'extension')).toBe('on');
    expect(resolveFlagValue('experimental-settings', 'cherry')).toBe('off');
  });

  it('ignores a string override for the central-only flag', () => {
    expect(
      resolveFlagValue('experimental-settings', 'standalone', {
        'experimental-settings': 'variant-a',
      })
    ).toBe('on');
  });

  it('ignores an override on a float where overrides are not permitted', () => {
    expect(
      resolveFlagValue('experimental-settings', 'cherry', {
        'experimental-settings': 'on',
      })
    ).toBe('off');
  });

  it('ignores a stored local override for the central-only flag', () => {
    localStorage.setItem(
      FEATURE_FLAG_STORAGE_KEY,
      JSON.stringify({ 'experimental-settings': 'on' })
    );

    initFeatureFlags('standalone', { 'experimental-settings': 'off' });

    expect(getFeatureValue('experimental-settings')).toBe('off');
  });

  it('resolves central value before the bundled default', () => {
    expect(resolveFlags('standalone', { 'experimental-settings': 'off' })).toEqual({
      'experimental-settings': 'off',
      'panel-layouts': 'off',
      'agentic-memory': 'off',
      'multiple-cones': 'on',
    });
    expect(
      resolveFlags(
        'standalone',
        { 'experimental-settings': 'off' },
        { 'experimental-settings': 'on' }
      )
    ).toEqual({
      'experimental-settings': 'off',
      'panel-layouts': 'off',
      'agentic-memory': 'off',
      'multiple-cones': 'on',
    });
  });

  it('round-trips string overrides through one localStorage key', () => {
    writeFeatureFlagOverrides({ 'experimental-settings': 'variant-b' });
    expect(localStorage.getItem(FEATURE_FLAG_STORAGE_KEY)).toBe(
      JSON.stringify({ 'experimental-settings': 'variant-b' })
    );
    expect(readFeatureFlagOverrides()).toEqual({ 'experimental-settings': 'variant-b' });
  });

  it('refuses to persist an override for the central-only flag', () => {
    setFeatureFlagOverride('experimental-settings', 'off');
    expect(readFeatureFlagOverrides()).toEqual({});
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

describe('applyHostFlagOverrides (Cherry-pushed session flags)', () => {
  it('applies a userToggleable flag for the active float', () => {
    initFeatureFlags('cherry');
    expect(applyHostFlagOverrides({ 'panel-layouts': 'on' })).toEqual({ 'panel-layouts': 'on' });
    expect(getFeatureValue('panel-layouts')).toBe('on');
  });

  it('drops a flag that is not userToggleable, even though the worker trusts centralValues for it', () => {
    initFeatureFlags('cherry');
    expect(applyHostFlagOverrides({ 'experimental-settings': 'on' })).toEqual({});
    expect(getFeatureValue('experimental-settings')).toBe('off');
  });

  it('drops an unrecognized id and a non-string value without throwing', () => {
    initFeatureFlags('cherry');
    expect(
      applyHostFlagOverrides({
        'not-a-real-flag': 'on',
        'panel-layouts': true as unknown as string,
      })
    ).toEqual({});
  });

  it('never persists to localStorage — session-only, like a pushed theme/layout', () => {
    initFeatureFlags('cherry');
    applyHostFlagOverrides({ 'panel-layouts': 'on' });
    expect(readFeatureFlagOverrides()).toEqual({});
  });

  it('is reset on the next initFeatureFlags call (next boot)', () => {
    initFeatureFlags('cherry');
    applyHostFlagOverrides({ 'panel-layouts': 'on' });
    expect(getFeatureValue('panel-layouts')).toBe('on');

    initFeatureFlags('cherry');
    expect(getFeatureValue('panel-layouts')).toBe('off');
  });

  it('a local user override still wins over a host-pushed value', () => {
    initFeatureFlags('cherry');
    applyHostFlagOverrides({ 'panel-layouts': 'on' });
    expect(resolveFlags('cherry', {}, { 'panel-layouts': 'off' })).toEqual(
      expect.objectContaining({ 'panel-layouts': 'off' })
    );
  });
});
