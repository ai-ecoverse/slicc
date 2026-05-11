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

describe('saveOAuthAccount — extension sync via chrome.storage.local + SW message', () => {
  let originalChrome: unknown;
  let originalLocalStorage: Storage;

  beforeEach(() => {
    originalChrome = (globalThis as any).chrome;
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
  });

  afterEach(() => {
    if (originalChrome === undefined) {
      delete (globalThis as any).chrome;
    } else {
      (globalThis as any).chrome = originalChrome;
    }
    (globalThis as any).localStorage = originalLocalStorage;
  });

  it('writes to chrome.storage.local + dispatches secrets.mask-oauth-token and caches maskedValue', async () => {
    const storageWrites: Record<string, unknown> = {};
    const sentMessages: { msg: unknown }[] = [];
    (globalThis as any).chrome = {
      runtime: {
        id: 'test-ext-id',
        lastError: undefined,
        sendMessage: vi.fn((msg: any, cb: (r: any) => void) => {
          sentMessages.push({ msg });
          if (msg?.type === 'secrets.mask-oauth-token' && msg.providerId === 'github') {
            cb({ maskedValue: 'ghp_masked_extension' });
          } else {
            cb({});
          }
        }),
      },
      storage: {
        local: {
          set: vi.fn(async (obj: Record<string, unknown>) => {
            Object.assign(storageWrites, obj);
          }),
          remove: vi.fn(async () => {}),
        },
      },
    };

    const { saveOAuthAccount, getAccounts } = await import('../../src/ui/provider-settings.js');
    await saveOAuthAccount({
      providerId: 'github',
      accessToken: 'ghp_real_extension',
    });

    // chrome.storage.local got the OAuth replica + DOMAINS pair
    expect(storageWrites['oauth.github.token']).toBe('ghp_real_extension');
    expect(storageWrites['oauth.github.token_DOMAINS']).toBe('github.com');

    // SW received the mask-oauth-token round-trip
    const askMask = sentMessages.find(
      (m) =>
        typeof m.msg === 'object' &&
        m.msg != null &&
        (m.msg as any).type === 'secrets.mask-oauth-token'
    );
    expect(askMask).toBeDefined();

    // maskedValue from the SW reply was cached in the Account
    const acct = getAccounts().find((a) => a.providerId === 'github');
    expect(acct?.maskedValue).toBe('ghp_masked_extension');
  });

  it('still resolves when chrome.runtime.lastError is set (SW unreachable)', async () => {
    (globalThis as any).chrome = {
      runtime: {
        id: 'test-ext-id',
        lastError: { message: 'message port closed' },
        sendMessage: vi.fn((_msg: any, cb: (r: any) => void) => {
          cb(undefined);
        }),
      },
      storage: {
        local: {
          set: vi.fn(async () => {}),
          remove: vi.fn(async () => {}),
        },
      },
    };

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

describe('Bootstrap-on-init re-push', () => {
  let originalFetch: typeof globalThis.fetch;
  let originalLocalStorage: Storage;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalLocalStorage = globalThis.localStorage;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    (globalThis as any).localStorage = originalLocalStorage;
  });

  it('bootstrap re-pushes saveOAuthAccount for each non-expired account', async () => {
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

    // Seed two non-expired accounts (github already has oauthTokenDomains in the mock at the top)
    lsData['slicc_accounts'] = JSON.stringify([
      {
        providerId: 'github',
        apiKey: '',
        accessToken: 'ghp_token1',
        userName: 'user1',
      },
      {
        providerId: 'expired',
        apiKey: '',
        accessToken: 'expired_token',
        tokenExpiresAt: Date.now() - 60000, // expired
        userName: 'user3',
      },
    ]);

    let postCallCount = 0;
    globalThis.fetch = vi.fn(async (url: any) => {
      if (String(url).includes('/api/secrets/oauth-update')) {
        postCallCount++;
        return {
          ok: true,
          json: async () => ({
            providerId: 'github',
            name: 'oauth.github.token',
            maskedValue: 'masked_test',
            domains: ['github.com'],
          }),
        } as any;
      }
      return { ok: false } as any;
    });

    // Import provider-settings and reset legacy cleanup flag
    const { __test__ } = await import('../../src/ui/provider-settings.js');
    __test__._resetLegacyCleanup();

    // Import and run the bootstrap function
    const { bootstrapOAuthReplicas } = await import('../../src/ui/oauth-bootstrap.js');
    await bootstrapOAuthReplicas();

    // Should have called saveOAuthAccount for github, but NOT expired
    expect(postCallCount).toBe(1);
  });
});
