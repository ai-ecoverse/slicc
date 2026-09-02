import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  IDLE_COMPACTION_DEFAULTS,
  IDLE_COMPACTION_MIN_TOKENS_KEY,
  IDLE_COMPACTION_MINUTES_KEY,
  readIdleCompactionSettings,
  writeIdleCompactionSettings,
} from '../../src/core/idle-compaction-settings.js';

/** The node test environment has no `localStorage`; the settings module wants a Map-backed one. */
const storage = new Map<string, string>();
beforeAll(() => {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => void storage.set(key, String(value)),
      removeItem: (key: string) => void storage.delete(key),
    },
  });
});

afterEach(() => {
  localStorage.removeItem(IDLE_COMPACTION_MINUTES_KEY);
  localStorage.removeItem(IDLE_COMPACTION_MIN_TOKENS_KEY);
});

describe('idle compaction settings', () => {
  it('falls back to the defaults without overrides', () => {
    expect(readIdleCompactionSettings()).toEqual(IDLE_COMPACTION_DEFAULTS);
  });

  it('round-trips valid overrides through localStorage', () => {
    writeIdleCompactionSettings({ idleMinutes: 25, minTokens: 80_000 });
    expect(localStorage.getItem(IDLE_COMPACTION_MINUTES_KEY)).toBe('25');
    expect(readIdleCompactionSettings()).toEqual({ idleMinutes: 25, minTokens: 80_000 });
  });

  it('ignores garbage and sub-floor values, and an undefined write clears the override', () => {
    localStorage.setItem(IDLE_COMPACTION_MINUTES_KEY, 'soon');
    localStorage.setItem(IDLE_COMPACTION_MIN_TOKENS_KEY, '5');
    expect(readIdleCompactionSettings()).toEqual(IDLE_COMPACTION_DEFAULTS);

    writeIdleCompactionSettings({ idleMinutes: 3 });
    expect(readIdleCompactionSettings().idleMinutes).toBe(3);
    writeIdleCompactionSettings({ idleMinutes: undefined });
    expect(localStorage.getItem(IDLE_COMPACTION_MINUTES_KEY)).toBeNull();
    writeIdleCompactionSettings({ minTokens: 0 });
    expect(localStorage.getItem(IDLE_COMPACTION_MIN_TOKENS_KEY)).toBeNull();
    expect(readIdleCompactionSettings()).toEqual(IDLE_COMPACTION_DEFAULTS);
  });
});
