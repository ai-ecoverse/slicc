import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FEATURE_FLAG_STORAGE_KEY,
  initFeatureFlags,
  isFeatureEnabled,
} from '../../../src/core/feature-flags.js';
import { createFlagsCommand } from '../../../src/shell/supplemental-commands/flags-command.js';
import { mockCommandContext } from '../helpers/mock-command-context.js';

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

describe('flags command', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', memoryStorage());
    initFeatureFlags('hosted-leader');
    delete (globalThis as { __slicc_panelRpc?: unknown }).__slicc_panelRpc;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete (globalThis as { __slicc_panelRpc?: unknown }).__slicc_panelRpc;
  });

  it('prints help without writing an override', async () => {
    const cmd = createFlagsCommand();
    for (const args of [[], ['--help'], ['-h'], ['set', '--help'], ['get', '--help']]) {
      const result = await cmd.execute(args, mockCommandContext());
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('flags');
    }
    expect(localStorage.getItem(FEATURE_FLAG_STORAGE_KEY)).toBeNull();
  });

  it('sets and gets a toggleable flag in this realm', async () => {
    const cmd = createFlagsCommand();
    const set = await cmd.execute(['set', 'no-default-skills', 'on'], mockCommandContext());
    expect(set).toMatchObject({ exitCode: 0, stdout: 'no-default-skills=on\n' });
    expect(isFeatureEnabled('no-default-skills')).toBe(true);

    const got = await cmd.execute(['get', 'no-default-skills'], mockCommandContext());
    expect(got).toMatchObject({ exitCode: 0, stdout: 'on\n' });

    const off = await cmd.execute(['set', 'no-default-skills', 'OFF'], mockCommandContext());
    expect(off.exitCode).toBe(0);
    expect(isFeatureEnabled('no-default-skills')).toBe(false);
  });

  it('refuses an unknown id and a flag this float cannot override', async () => {
    const cmd = createFlagsCommand();
    const unknown = await cmd.execute(['set', 'not-a-flag', 'on'], mockCommandContext());
    expect(unknown.exitCode).toBe(1);
    expect(unknown.stderr).toContain('unknown flag');

    const central = await cmd.execute(
      ['set', 'experimental-settings', 'off'],
      mockCommandContext()
    );
    expect(central.exitCode).toBe(1);
    expect(central.stderr).toContain('cannot be overridden');
    expect(isFeatureEnabled('experimental-settings')).toBe(true);
  });

  it('writes through the page and mirrors the stored JSON into this realm', async () => {
    const call = vi.fn(async () => ({
      overridesJson: JSON.stringify({ 'no-default-skills': 'on' }),
    }));
    (globalThis as { __slicc_panelRpc?: { call: typeof call } }).__slicc_panelRpc = { call };

    const result = await createFlagsCommand().execute(
      ['set', 'no-default-skills', 'on'],
      mockCommandContext()
    );

    expect(result.exitCode).toBe(0);
    expect(call).toHaveBeenCalledWith('feature-flag-set', {
      id: 'no-default-skills',
      value: 'on',
    });
    expect(isFeatureEnabled('no-default-skills')).toBe(true);
  });
});
