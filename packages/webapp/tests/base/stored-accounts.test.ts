import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetLoggerDedupForTests } from '../../src/base/logger.js';
import {
  ACCOUNTS_KEY,
  CORRUPT_ACCOUNTS_KEY,
  preserveCorruptAccounts,
  readStoredAccounts,
} from '../../src/base/stored-accounts.js';
import * as accountStore from '../../src/providers/account-store.js';

function stubStorage(value: string | null): void {
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => (key === ACCOUNTS_KEY ? value : null),
    setItem: vi.fn(),
    removeItem: vi.fn(),
  });
}

describe('base/stored-accounts', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns [] when nothing is stored', () => {
    stubStorage(null);
    expect(readStoredAccounts()).toEqual([]);
  });

  it('returns [] for unparsable or non-array JSON', () => {
    stubStorage('{not json');
    expect(readStoredAccounts()).toEqual([]);
    stubStorage('{"providerId":"adobe"}');
    expect(readStoredAccounts()).toEqual([]);
  });

  it('keeps well-formed entries and drops malformed ones', () => {
    const good = { providerId: 'adobe', apiKey: '', accessToken: 'tok' };
    stubStorage(JSON.stringify([good, null, { providerId: 'x' }, { apiKey: 'k' }, 'str']));
    expect(readStoredAccounts()).toEqual([good]);
  });

  it('providers/account-store re-exports the same storage key (#3743)', () => {
    expect(accountStore.ACCOUNTS_KEY).toBe(ACCOUNTS_KEY);
    expect(ACCOUNTS_KEY).toBe('slicc_accounts');
  });
});

describe('base/stored-accounts — preserveCorruptAccounts (#4146)', () => {
  let data: Record<string, string>;
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    data = {};
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => data[key] ?? null,
      setItem: (key: string, value: string) => {
        data[key] = value;
      },
      removeItem: (key: string) => {
        delete data[key];
      },
    });
    resetLoggerDedupForTests();
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleError.mockRestore();
    vi.unstubAllGlobals();
  });

  it('leaves an absent or parsable store alone', () => {
    preserveCorruptAccounts();
    expect(data).toEqual({});
    data[ACCOUNTS_KEY] = '[]';
    preserveCorruptAccounts();
    data[ACCOUNTS_KEY] = JSON.stringify([{ providerId: 'openai', apiKey: 'sk-x' }]);
    preserveCorruptAccounts();
    expect(data[CORRUPT_ACCOUNTS_KEY]).toBeUndefined();
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('copies unparsable or non-array JSON aside and logs one error without the contents', () => {
    const raw = '[{"providerId":"openai","apiKey":"sk-secret-value"},{"provid';
    data[ACCOUNTS_KEY] = raw;
    preserveCorruptAccounts();
    expect(data[CORRUPT_ACCOUNTS_KEY]).toBe(raw);
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(consoleError.mock.calls[0])).not.toContain('sk-secret-value');

    data[ACCOUNTS_KEY] = '{"providerId":"adobe"}';
    preserveCorruptAccounts();
    expect(data[CORRUPT_ACCOUNTS_KEY]).toBe('{"providerId":"adobe"}');
  });

  it('throws and keeps the value when it cannot be copied aside', () => {
    const raw = '[{"providerId":"openai","apiKey":"sk-x"';
    const storage = {
      getItem: (key: string) => (key === ACCOUNTS_KEY ? raw : null),
      setItem: vi.fn(() => {
        throw new Error('SecurityError');
      }),
    };
    expect(() => preserveCorruptAccounts(storage)).toThrow(/could not be backed up/);
    expect(storage.setItem).toHaveBeenCalledTimes(1);
    expect(storage.setItem).toHaveBeenCalledWith(CORRUPT_ACCOUNTS_KEY, raw);
  });
});
