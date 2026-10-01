import { afterEach, describe, expect, it, vi } from 'vitest';
import { ACCOUNTS_KEY, readStoredAccounts } from '../../src/base/stored-accounts.js';
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
