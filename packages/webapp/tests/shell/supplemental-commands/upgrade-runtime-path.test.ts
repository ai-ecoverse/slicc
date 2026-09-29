import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initFeatureFlags, setFeatureFlagOverride } from '../../../src/core/feature-flags.js';
import { upgradeRuntimePath } from '../../../src/shell/supplemental-commands/upgrade-command.js';

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

describe('upgradeRuntimePath', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', memoryStorage());
    initFeatureFlags('standalone');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps bundled skills in scope until no-default-skills is on', () => {
    const skill = 'packages/vfs-root/workspace/skills/delegation/SKILL.md';
    const policy = 'packages/vfs-root/etc/sudoers';
    expect(upgradeRuntimePath(skill)).toBe('/workspace/skills/delegation/SKILL.md');
    expect(upgradeRuntimePath(policy)).toBe('/etc/sudoers');

    setFeatureFlagOverride('no-default-skills', 'on');
    expect(upgradeRuntimePath(skill)).toBeNull();
    expect(upgradeRuntimePath(policy)).toBe('/etc/sudoers');
    expect(upgradeRuntimePath('packages/vfs-root/shared/sprinkles/welcome/welcome.shtml')).toBe(
      '/shared/sprinkles/welcome/welcome.shtml'
    );
  });
});
