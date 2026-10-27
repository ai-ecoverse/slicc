import { describe, expect, it } from 'vitest';
import {
  corruptValueKey,
  type QuarantineStorage,
  quarantineCorruptValue,
} from '../src/storage-quarantine.js';

function quotaError(): Error {
  return Object.assign(new Error('The quota has been exceeded.'), { name: 'QuotaExceededError' });
}

/** Map-backed storage that throws a QuotaExceededError once `used` would pass `capacity`. */
function makeStorage(initial: Record<string, string>, capacity = Number.POSITIVE_INFINITY) {
  const data: Record<string, string> = { ...initial };
  const used = (): number => Object.entries(data).reduce((n, [k, v]) => n + k.length + v.length, 0);
  const storage: Required<QuarantineStorage> = {
    getItem: (key) => data[key] ?? null,
    setItem: (key, value) => {
      const next =
        used() - (key in data ? key.length + data[key].length : 0) + key.length + value.length;
      if (next > capacity) throw quotaError();
      data[key] = value;
    },
    removeItem: (key) => {
      delete data[key];
    },
  };
  return { data, storage };
}

describe('storage-quarantine', () => {
  it('names the quarantine key after the store', () => {
    expect(corruptValueKey('slicc_accounts')).toBe('slicc_accounts.corrupt');
  });

  it('copies the value aside, replacing an older copy', () => {
    const { data, storage } = makeStorage({ k: '{bad', 'k.corrupt': 'older' });
    expect(quarantineCorruptValue(storage, 'k', '{bad')).toBe(true);
    expect(data).toEqual({ k: '{bad', 'k.corrupt': '{bad' });
  });

  it('moves the value when there is no room for a copy', () => {
    const raw = '{"truncated":';
    const { data, storage } = makeStorage({ k: raw }, 'k'.length + raw.length + 12);
    expect(quarantineCorruptValue(storage, 'k', raw)).toBe(true);
    expect(data).toEqual({ 'k.corrupt': raw });
  });

  it('puts the value back and reports failure when even a move does not fit', () => {
    const raw = '{"truncated":';
    const { data, storage } = makeStorage({ k: raw }, 'k'.length + raw.length);
    expect(quarantineCorruptValue(storage, 'k', raw)).toBe(false);
    expect(data).toEqual({ k: raw });
  });

  it('leaves the value alone on a non-quota failure', () => {
    const { data, storage } = makeStorage({ k: '{bad' });
    storage.setItem = () => {
      throw new Error('SecurityError');
    };
    expect(quarantineCorruptValue(storage, 'k', '{bad')).toBe(false);
    expect(data).toEqual({ k: '{bad' });
  });

  it('cannot move without removeItem', () => {
    const { data, storage } = makeStorage({ k: '{bad' }, 5);
    const { removeItem: _omit, ...getSetOnly } = storage;
    expect(quarantineCorruptValue(getSetOnly, 'k', '{bad')).toBe(false);
    expect(data).toEqual({ k: '{bad' });
  });

  it('reports failure when the original cannot be removed', () => {
    const { data, storage } = makeStorage({ k: '{bad' }, 5);
    storage.removeItem = () => {
      throw new Error('locked');
    };
    expect(quarantineCorruptValue(storage, 'k', '{bad')).toBe(false);
    expect(data).toEqual({ k: '{bad' });
  });
});
