import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetLoggerDedupForTests } from '../../src/base/logger.js';
import {
  ACCOUNTS_KEY,
  CORRUPT_ACCOUNTS_KEY,
  readStoredAccounts,
  writeStoredAccounts,
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

describe('base/stored-accounts — writeStoredAccounts (#4146)', () => {
  let data: Record<string, string>;
  let consoleError: ReturnType<typeof vi.spyOn>;
  const json = (rows: object[]): string => JSON.stringify(rows);

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

  it('writes absent and parsable stores without a copy', () => {
    writeStoredAccounts('[]');
    writeStoredAccounts(json([{ providerId: 'openai', apiKey: 'sk-x' }]));
    expect(data).toEqual({ [ACCOUNTS_KEY]: json([{ providerId: 'openai', apiKey: 'sk-x' }]) });
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('copies unparsable or non-array JSON aside and logs one error without the contents', () => {
    const raw = '[{"providerId":"openai","apiKey":"sk-secret-value"},{"provid';
    data[ACCOUNTS_KEY] = raw;
    writeStoredAccounts('[]');
    expect(data).toEqual({ [ACCOUNTS_KEY]: '[]', [CORRUPT_ACCOUNTS_KEY]: raw });
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(consoleError.mock.calls[0])).not.toContain('sk-secret-value');

    data[ACCOUNTS_KEY] = '{"providerId":"adobe"}';
    writeStoredAccounts('[]');
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
    expect(() => writeStoredAccounts('[]', storage)).toThrow(/could not be backed up/);
    expect(storage.setItem).toHaveBeenCalledTimes(1);
    expect(storage.setItem).toHaveBeenCalledWith(CORRUPT_ACCOUNTS_KEY, raw);
  });

  it('drops the copy once a save deletes an account or clears its credentials', () => {
    const groq = { providerId: 'groq', apiKey: 'gsk' };
    const github = { providerId: 'github', apiKey: '', accessToken: 'gho' };
    data[ACCOUNTS_KEY] = json([groq, github]);
    data[CORRUPT_ACCOUNTS_KEY] = '[{"providerId":"anthropic","apiKey":"sk-ant';

    writeStoredAccounts(
      json([groq, { ...github, maskedValue: 'gho_m' }, { providerId: 'x', apiKey: 'k' }])
    );
    expect(data[CORRUPT_ACCOUNTS_KEY]).toBeDefined();

    writeStoredAccounts(json([groq, { providerId: 'github', apiKey: '', loggedOut: true }]));
    expect(data[CORRUPT_ACCOUNTS_KEY]).toBeUndefined();

    data[CORRUPT_ACCOUNTS_KEY] = '[{"provid';
    writeStoredAccounts('[]');
    expect(data[CORRUPT_ACCOUNTS_KEY]).toBeUndefined();
  });
});
