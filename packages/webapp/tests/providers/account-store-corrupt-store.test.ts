import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetLoggerDedupForTests } from '../../src/base/logger.js';
import {
  addAccount,
  getAccounts,
  removeAccount,
  saveOAuthAccount,
} from '../../src/providers/account-store.js';

/**
 * #4146: `getAccounts()` reads a present-but-unparsable `slicc_accounts` as
 * `[]`, and every writer replaces the whole array. Before the fix, the next
 * login saved `[thatOneAccount]` over every other provider's keys and OAuth
 * masks. Now the raw value is moved to `slicc_accounts.corrupt` first and the
 * login still goes through.
 */

vi.mock('../../src/providers/index.js', async () => {
  const actual = await vi.importActual('../../src/providers/index.js');
  return {
    ...actual,
    getRegisteredProviderConfig: (id: string) =>
      id === 'github'
        ? {
            id: 'github',
            name: 'GitHub',
            requiresApiKey: false,
            requiresBaseUrl: false,
            isOAuth: true,
            oauthTokenDomains: ['github.com'],
          }
        : undefined,
  };
});

const ACCOUNTS = 'slicc_accounts';
const CORRUPT = 'slicc_accounts.corrupt';
// A store cut off mid-write: other providers' secrets are still in it.
const TRUNCATED =
  '[{"providerId":"anthropic","apiKey":"sk-ant-kept"},{"providerId":"openai","apiKey":"sk-op';

describe('account-store — present but unparsable slicc_accounts (#4146)', () => {
  let data: Record<string, string>;
  let consoleError: ReturnType<typeof vi.spyOn>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    data = {};
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => data[k] ?? null,
      setItem: (k: string, v: string) => {
        data[k] = v;
      },
      removeItem: (k: string) => {
        delete data[k];
      },
    });
    // Page context, so saves write localStorage directly instead of panel-rpc.
    vi.stubGlobal('window', {});
    vi.stubGlobal('document', {});
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ maskedValue: 'gho_masked' }),
    })) as unknown as typeof globalThis.fetch;
    resetLoggerDedupForTests();
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    consoleError.mockRestore();
    vi.unstubAllGlobals();
  });

  it('addAccount moves the corrupt value aside and saves the new key', () => {
    data[ACCOUNTS] = TRUNCATED;
    expect(getAccounts()).toEqual([]);

    addAccount('groq', 'gsk-new');

    expect(data[CORRUPT]).toBe(TRUNCATED);
    expect(getAccounts()).toEqual([{ providerId: 'groq', apiKey: 'gsk-new' }]);
    const logged = consoleError.mock.calls.find((c: unknown[]) => String(c).includes(CORRUPT));
    expect(logged).toBeDefined();
    expect(JSON.stringify(logged)).not.toContain('sk-ant-kept');
  });

  it('saveOAuthAccount moves the corrupt value aside and the login completes', async () => {
    data[ACCOUNTS] = TRUNCATED;

    await saveOAuthAccount({ providerId: 'github', accessToken: 'gho_real' });

    expect(data[CORRUPT]).toBe(TRUNCATED);
    expect(getAccounts()).toEqual([
      expect.objectContaining({
        providerId: 'github',
        accessToken: 'gho_real',
        maskedValue: 'gho_masked',
      }),
    ]);
  });

  it('removeAccount does not overwrite the corrupt value unpreserved', async () => {
    data[ACCOUNTS] = TRUNCATED;

    await removeAccount('groq');

    expect(data[CORRUPT]).toBe(TRUNCATED);
    expect(data[ACCOUNTS]).toBe('[]');
  });

  it('keeps the corrupt value and fails the save when no copy can be kept', () => {
    data[ACCOUNTS] = TRUNCATED;
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => data[k] ?? null,
      setItem: (k: string, v: string) => {
        if (k === CORRUPT) throw new Error('blocked');
        data[k] = v;
      },
      removeItem: (k: string) => {
        delete data[k];
      },
    });

    expect(() => addAccount('groq', 'gsk-new')).toThrow(/could not be backed up/);
    expect(data[ACCOUNTS]).toBe(TRUNCATED);
  });

  it('reads an absent store as [] and saves without a quarantine copy', () => {
    expect(getAccounts()).toEqual([]);

    addAccount('groq', 'gsk-new');

    expect(getAccounts()).toEqual([{ providerId: 'groq', apiKey: 'gsk-new' }]);
    expect(data[CORRUPT]).toBeUndefined();
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('leaves a valid store to the normal read-modify-write', async () => {
    const anthropic = { providerId: 'anthropic', apiKey: 'sk-ant-kept' };
    data[ACCOUNTS] = JSON.stringify([anthropic]);

    addAccount('groq', 'gsk-new');
    await saveOAuthAccount({ providerId: 'github', accessToken: 'gho_real' });

    expect(getAccounts().map((a) => a.providerId)).toEqual(['anthropic', 'groq', 'github']);
    expect(getAccounts()[0]).toEqual(anthropic);
    expect(data[CORRUPT]).toBeUndefined();
    expect(consoleError).not.toHaveBeenCalled();
  });
});
