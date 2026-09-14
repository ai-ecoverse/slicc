import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  IDLE_COMPACTION_DEFAULTS,
  IDLE_COMPACTION_MIN_TOKENS_KEY,
  IDLE_COMPACTION_MINUTES_KEY,
  readIdleCompactionSettings,
} from '../../src/core/idle-compaction-settings.js';

function installStorage(entries: Record<string, string> = {}): Map<string, string> {
  const store = new Map(Object.entries(entries));
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: (key: string) => store.get(key) ?? null },
  });
  return store;
}

describe('idle compaction settings', () => {
  afterEach(() => {
    Reflect.deleteProperty(globalThis as object, 'localStorage');
    vi.restoreAllMocks();
  });

  it('exposes the fixed idle window and minimum context size', () => {
    expect(IDLE_COMPACTION_DEFAULTS).toEqual({ idleMinutes: 30, minTokens: 200_000 });
  });

  it('keeps the frozen defaults unmutated by a caller of the reader', () => {
    installStorage({ [IDLE_COMPACTION_MINUTES_KEY]: '2' });
    expect(readIdleCompactionSettings().idleMinutes).toBe(2);

    expect(IDLE_COMPACTION_DEFAULTS.idleMinutes).toBe(30);
    expect(Object.isFrozen(IDLE_COMPACTION_DEFAULTS)).toBe(true);
  });

  describe('without storage', () => {
    it('falls back to the defaults where there is no localStorage at all', () => {
      Reflect.deleteProperty(globalThis as object, 'localStorage');
      expect(readIdleCompactionSettings()).toEqual(IDLE_COMPACTION_DEFAULTS);
    });

    it('falls back when localStorage exists but has no getItem', () => {
      Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {} });
      expect(readIdleCompactionSettings()).toEqual(IDLE_COMPACTION_DEFAULTS);
    });

    it('falls back when touching localStorage throws', () => {
      Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        get() {
          throw new DOMException('denied', 'SecurityError');
        },
      });
      expect(readIdleCompactionSettings()).toEqual(IDLE_COMPACTION_DEFAULTS);
    });

    it('falls back when getItem itself throws', () => {
      Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        value: {
          getItem() {
            throw new Error('quota');
          },
        },
      });
      expect(readIdleCompactionSettings()).toEqual(IDLE_COMPACTION_DEFAULTS);
    });
  });

  describe('overrides', () => {
    beforeEach(() => {
      installStorage();
    });

    it('reads both knobs from storage', () => {
      installStorage({
        [IDLE_COMPACTION_MINUTES_KEY]: '0.05',
        [IDLE_COMPACTION_MIN_TOKENS_KEY]: '0',
      });
      expect(readIdleCompactionSettings()).toEqual({ idleMinutes: 0.05, minTokens: 0 });
    });

    it('overrides one knob without disturbing the other', () => {
      installStorage({ [IDLE_COMPACTION_MIN_TOKENS_KEY]: '1000' });
      expect(readIdleCompactionSettings()).toEqual({ idleMinutes: 30, minTokens: 1000 });
    });

    it('treats the value the shipped dialog wrote as the shipped default', () => {
      installStorage({ [IDLE_COMPACTION_MINUTES_KEY]: '30' });
      expect(readIdleCompactionSettings()).toEqual(IDLE_COMPACTION_DEFAULTS);
    });

    it('reads live, so a change between two reads is picked up', () => {
      const store = installStorage({ [IDLE_COMPACTION_MINUTES_KEY]: '5' });
      expect(readIdleCompactionSettings().idleMinutes).toBe(5);
      store.set(IDLE_COMPACTION_MINUTES_KEY, '6');
      expect(readIdleCompactionSettings().idleMinutes).toBe(6);
    });
  });

  describe('clamping', () => {
    it.each([
      ['', 30],
      ['   ', 30],
      ['abc', 30],
      ['NaN', 30],
      ['Infinity', 30],
      ['-Infinity', 30],
      ['[object Object]', 30],
    ])('ignores the unusable value %o and keeps the default', (raw, expected) => {
      installStorage({ [IDLE_COMPACTION_MINUTES_KEY]: raw });
      expect(readIdleCompactionSettings().idleMinutes).toBe(expected);
    });

    it('clamps an idle window below the floor up to 0.01 minutes', () => {
      installStorage({ [IDLE_COMPACTION_MINUTES_KEY]: '0' });
      expect(readIdleCompactionSettings().idleMinutes).toBe(0.01);
      installStorage({ [IDLE_COMPACTION_MINUTES_KEY]: '-90' });
      expect(readIdleCompactionSettings().idleMinutes).toBe(0.01);
    });

    it('clamps an idle window above a day down to a day', () => {
      installStorage({ [IDLE_COMPACTION_MINUTES_KEY]: '1e12' });
      expect(readIdleCompactionSettings().idleMinutes).toBe(1440);
    });

    it('clamps a negative token floor to zero and a huge one to ten million', () => {
      installStorage({ [IDLE_COMPACTION_MIN_TOKENS_KEY]: '-1' });
      expect(readIdleCompactionSettings().minTokens).toBe(0);
      installStorage({ [IDLE_COMPACTION_MIN_TOKENS_KEY]: '999999999999' });
      expect(readIdleCompactionSettings().minTokens).toBe(10_000_000);
    });
  });
});
