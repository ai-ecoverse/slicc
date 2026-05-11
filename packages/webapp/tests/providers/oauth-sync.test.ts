import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the getRegisteredProviderConfig to return github with oauthTokenDomains
vi.mock('../../src/providers/index.js', async () => {
  const actual = await vi.importActual('../../src/providers/index.js');
  return {
    ...actual,
    getRegisteredProviderConfig: (id: string) => {
      if (id === 'github') {
        return {
          id: 'github',
          name: 'GitHub',
          requiresApiKey: false,
          requiresBaseUrl: false,
          isOAuth: true,
          oauthTokenDomains: ['github.com'],
        };
      }
      return undefined;
    },
  };
});

describe('saveOAuthAccount — CLI sync to /api/secrets/oauth-update', () => {
  let originalFetch: typeof globalThis.fetch;
  let originalLocalStorage: Storage;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalLocalStorage = globalThis.localStorage;
    const lsData: Record<string, string> = {};
    (globalThis as any).localStorage = {
      getItem: (k: string) => lsData[k] ?? null,
      setItem: (k: string, v: string) => {
        lsData[k] = v;
      },
      removeItem: (k: string) => {
        delete lsData[k];
      },
      clear: () => {
        for (const k of Object.keys(lsData)) delete lsData[k];
      },
    };
    delete (globalThis as any).chrome;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    (globalThis as any).localStorage = originalLocalStorage;
  });

  it('caches maskedValue in the Account after a successful POST', async () => {
    let fetchCalled = false;
    globalThis.fetch = vi.fn(async (url: any) => {
      if (String(url).includes('/api/secrets/oauth-update')) {
        fetchCalled = true;
        return {
          ok: true,
          json: async () => ({
            providerId: 'github',
            name: 'oauth.github.token',
            maskedValue: 'ghp_masked_sentinel',
            domains: ['github.com'],
          }),
        } as any;
      }
      return { ok: false } as any;
    });

    const { saveOAuthAccount, getAccounts } = await import('../../src/ui/provider-settings.js');
    await saveOAuthAccount({
      providerId: 'github',
      accessToken: 'ghp_real_token',
      userName: 'test',
      userAvatar: undefined,
    });
    expect(fetchCalled).toBe(true);
    const accounts = getAccounts();
    const info = accounts.find((a) => a.providerId === 'github');
    console.log('Account:', info);
    expect(info?.maskedValue).toBe('ghp_masked_sentinel');
  });

  it('still resolves successfully when the POST fails (errors are logged, not thrown)', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('network down');
    });
    const { saveOAuthAccount } = await import('../../src/ui/provider-settings.js');
    await expect(
      saveOAuthAccount({
        providerId: 'github',
        accessToken: 'ghp_x',
      })
    ).resolves.toBeUndefined();
  });
});

describe('github.ts writes masked token to /workspace/.git/github-token', () => {
  // This test documents the POLICY that github.ts must follow after Task 4.7:
  // After saveOAuthAccount, use getOAuthAccountInfo to retrieve maskedValue
  // and pass it to writeGitToken (NOT the real token).
  it('policy: maskedValue is available after saveOAuthAccount for use in writeGitToken', async () => {
    const originalFetch = globalThis.fetch;
    const lsData: Record<string, string> = {};
    (globalThis as any).localStorage = {
      getItem: (k: string) => lsData[k] ?? null,
      setItem: (k: string, v: string) => {
        lsData[k] = v;
      },
      removeItem: (k: string) => {
        delete lsData[k];
      },
      clear: () => {
        for (const k of Object.keys(lsData)) delete lsData[k];
      },
    };
    delete (globalThis as any).chrome;

    globalThis.fetch = vi.fn(async (url: any) => {
      if (String(url).includes('/api/secrets/oauth-update')) {
        return {
          ok: true,
          json: async () => ({
            providerId: 'github',
            name: 'oauth.github.token',
            maskedValue: 'ghp_masked_safe',
            domains: ['github.com'],
          }),
        } as any;
      }
      return { ok: false } as any;
    });

    const { saveOAuthAccount, getOAuthAccountInfo } =
      await import('../../src/ui/provider-settings.js');
    await saveOAuthAccount({
      providerId: 'github',
      accessToken: 'ghp_REAL_must_not_leak',
    });

    const info = getOAuthAccountInfo('github');
    expect(info?.maskedValue).toBe('ghp_masked_safe');
    // github.ts:532 must use info.maskedValue for writeGitToken, never info.token
    expect(info?.token).toBe('ghp_REAL_must_not_leak');

    globalThis.fetch = originalFetch;
  });
});
