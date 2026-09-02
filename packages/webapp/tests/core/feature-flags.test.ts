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
        // Graduated (#2280): on by default, out of Settings → Experimental,
        // and carved out for Cherry.
        defaultValue: 'on',
        floatDefaults: { cherry: 'off' },
        userToggleable: false,
      }),
      expect.objectContaining({
        id: 'compact-on-idle',
        label: 'Compact on idle',
        defaultValue: 'off',
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

  it('turns multiple cones ON everywhere except a Cherry embed (#2280)', () => {
    // Graduated. Cherry is the one carve-out: a garnish in someone else's
    // page stays single-cone, the same shape as `experimental-settings`.
    for (const float of [
      'standalone',
      'extension',
      'electron-overlay',
      'extension-detached',
      'hosted-leader',
      'connect',
      'follower',
    ] as const) {
      initFeatureFlags(float);
      expect(isFeatureEnabled('multiple-cones')).toBe(true);
    }

    initFeatureFlags('cherry');
    expect(isFeatureEnabled('multiple-cones')).toBe(false);
  });

  it('ignores a user override of multiple cones — it left the settings UI (#2280)', () => {
    // `userToggleable: false` is what removes the row from Settings →
    // Experimental, and `canOverride` makes that stick at the resolver: a
    // stale `off` from before the graduation cannot keep a user on one cone,
    // and a Cherry host cannot push `on` into its embed.
    // A stale `off` written before the graduation survives in storage — what
    // changes is that the resolver stops honouring it.
    localStorage.setItem(FEATURE_FLAG_STORAGE_KEY, JSON.stringify({ 'multiple-cones': 'off' }));
    initFeatureFlags('standalone');
    expect(readFeatureFlagOverrides()['multiple-cones']).toBe('off');
    expect(isFeatureEnabled('multiple-cones')).toBe(true);

    // And nothing can write a new one, so the settings row could not come back
    // by the back door.
    localStorage.removeItem(FEATURE_FLAG_STORAGE_KEY);
    setFeatureFlagOverride('multiple-cones', 'off');
    expect(readFeatureFlagOverrides()['multiple-cones']).toBeUndefined();

    initFeatureFlags('cherry');
    expect(applyHostFlagOverrides({ 'multiple-cones': 'on' })).toEqual({});
    expect(isFeatureEnabled('multiple-cones')).toBe(false);
  });

  it('still lets the worker turn multiple cones off centrally (#2280)', () => {
    // The remaining kill switch now that the flag is not user-facing. Central
    // values are checked BEFORE the bundled default, so a `base` entry would
    // also outrank the Cherry carve-out — which is why the definition says a
    // central `base` value needs a matching `floats.cherry` one.
    initFeatureFlags('standalone', { 'multiple-cones': 'off' });
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
      'compact-on-idle': 'off',
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
      'compact-on-idle': 'off',
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
