import { describe, expect, it } from 'vitest';
import {
  corruptValueKey,
  type QuarantineStorage,
  replaceStoredValue,
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
      const old = key in data ? key.length + data[key].length : 0;
      if (used() - old + key.length + value.length > capacity) throw quotaError();
      data[key] = value;
    },
    removeItem: (key) => {
      delete data[key];
    },
  };
  return { data, storage };
}

const isArray = (raw: string): boolean => {
  try {
    return Array.isArray(JSON.parse(raw));
  } catch {
    return false;
  }
};

describe('storage-quarantine', () => {
  it('names the quarantine key after the store', () => {
    expect(corruptValueKey('slicc_accounts')).toBe('slicc_accounts.corrupt');
  });

  it('writes absent and readable values without a copy', () => {
    const { data, storage } = makeStorage({});
    expect(replaceStoredValue(storage, 'k', '[1]', isArray)).toBe(false);
    expect(replaceStoredValue(storage, 'k', '[2]', isArray)).toBe(false);
    expect(data).toEqual({ k: '[2]' });
  });

  it('copies an unreadable value aside, replacing an older copy, then writes', () => {
    const { data, storage } = makeStorage({ k: '[{bad', 'k.corrupt': 'older' });
    expect(replaceStoredValue(storage, 'k', '[]', isArray)).toBe(true);
    expect(data).toEqual({ k: '[]', 'k.corrupt': '[{bad' });
  });

  it('leaves the original in place and throws when there is no room for the copy', () => {
    // Room for the original or its copy, never both: a move would have to empty `k` first.
    const raw = '[{"truncated":';
    const { data, storage } = makeStorage({ k: raw }, 'k'.length + raw.length + 12);
    expect(() => replaceStoredValue(storage, 'k', '[]', isArray)).toThrow(
      /could not be backed up to k\.corrupt, so nothing was saved and k was left as it was/
    );
    expect(data).toEqual({ k: raw });
  });

  it('keeps the original next to its copy when the replacement write fails', () => {
    const raw = '[{"truncated":';
    const big = `[${'"x",'.repeat(10)}"x"]`;
    const { data, storage } = makeStorage({ k: raw }, 2 * (raw.length + 10));
    expect(() => replaceStoredValue(storage, 'k', big, isArray)).toThrow(/quota/);
    expect(data).toEqual({ k: raw, 'k.corrupt': raw });
    expect(replaceStoredValue(storage, 'k', '[]', isArray)).toBe(true);
    expect(data).toEqual({ k: '[]', 'k.corrupt': raw });
  });

  it('says so when another writer changed the value while the copy failed', () => {
    const { data, storage } = makeStorage({ k: '[{bad' });
    storage.setItem = (key, value) => {
      data.k = '[1]';
      if (key === 'k.corrupt') throw new Error('blocked');
      data[key] = value;
    };
    expect(() => replaceStoredValue(storage, 'k', '[]', isArray)).toThrow(/changed while/);
  });
});
