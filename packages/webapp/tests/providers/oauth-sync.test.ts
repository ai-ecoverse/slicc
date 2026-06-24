import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { callSecretsBridge } from '../../src/core/secrets-bridge-client.js';
import { setExtensionDelegateId } from '../../src/shell/proxied-fetch.js';

// Stub window+document at module scope so `hasLocalDom()` in
// provider-settings.ts is true for every test in this suite — these
// cover page-context OAuth flows (settings UI, github writeGitToken,
// bootstrap-on-init). Without this, the worker-aware
// `saveAccountsAsync` would take the panel-rpc branch.
Object.defineProperty(globalThis, 'window', { value: {}, configurable: true });
Object.defineProperty(globalThis, 'document', { value: {}, configurable: true });

// The extension-delegate (thin-bridge) topology routes secret CRUD over the
// secrets.crud Port; mock that transport so we can assert the call sites use it
// instead of REST.
vi.mock('../../src/core/secrets-bridge-client.js', () => ({
  callSecretsBridge: vi.fn(),
}));

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

  it('logoutOAuthAccount DELETEs the CLI replica at /api/secrets/oauth/<id>', async () => {
    const calls: { url: string; method?: string }[] = [];
    globalThis.fetch = vi.fn(async (url: any, init: any) => {
      calls.push({ url: String(url), method: init?.method });
      return { ok: true, status: 200 } as any;
    });
    (globalThis as any).localStorage.setItem(
      'slicc_accounts',
      JSON.stringify([{ providerId: 'github', apiKey: '', accessToken: 'ghp_x' }])
    );

    const { logoutOAuthAccount } = await import('../../src/ui/provider-settings.js');
    await expect(logoutOAuthAccount('github')).resolves.toBeUndefined();

    // The CLI branch of deleteOAuthReplica must issue the replica DELETE so the
    // node-server OauthSecretStore is cleared (local clear ≠ server clear hazard).
    const del = calls.find(
      (c) => c.url.includes('/api/secrets/oauth/github') && c.method === 'DELETE'
    );
    expect(del).toBeDefined();
  });
});

describe('saveOAuthAccount — extension sync via SW message (SW owns chrome.storage, #847)', () => {
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

  it('dispatches secrets.mask-oauth-token WITH the token + domains (SW owns the write) and caches maskedValue', async () => {
    const storageWrites: Record<string, unknown> = {};
    const sentMessages: { msg: any }[] = [];
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
      // Present here, but #847: saveOAuthAccount must NOT use it — oauth-token
      // runs in the offscreen document, which has no chrome.storage. The token
      // travels in the SW message and the SW does the write.
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

    // saveOAuthAccount must NOT write chrome.storage itself (offscreen has none).
    expect(storageWrites['oauth.github.token']).toBeUndefined();

    // The SW round-trip carries the token + comma-joined domains so the SW can
    // write them.
    const askMask = sentMessages.find((m) => m.msg?.type === 'secrets.mask-oauth-token');
    expect(askMask).toBeDefined();
    expect(askMask?.msg.accessToken).toBe('ghp_real_extension');
    expect(askMask?.msg.domains).toBe('github.com');

    // maskedValue from the SW reply was cached in the Account
    const acct = getAccounts().find((a) => a.providerId === 'github');
    expect(acct?.maskedValue).toBe('ghp_masked_extension');
  });

  it('works from an offscreen-like context with NO chrome.storage (the actual #847 env)', async () => {
    const sent: any[] = [];
    (globalThis as any).chrome = {
      runtime: {
        id: 'test-ext-id',
        lastError: undefined,
        sendMessage: vi.fn((msg: any, cb: (r: any) => void) => {
          sent.push(msg);
          cb(
            msg?.type === 'secrets.mask-oauth-token' ? { maskedValue: 'ghp_masked_offscreen' } : {}
          );
        }),
      },
      // NO `storage` at all — the real offscreen shape that threw before the fix.
    };

    const { saveOAuthAccount, getAccounts } = await import('../../src/ui/provider-settings.js');
    await expect(
      saveOAuthAccount({ providerId: 'github', accessToken: 'ghp_off' })
    ).resolves.toBeUndefined();

    const askMask = sent.find((m) => m?.type === 'secrets.mask-oauth-token');
    expect(askMask?.accessToken).toBe('ghp_off');
    expect(getAccounts().find((a) => a.providerId === 'github')?.maskedValue).toBe(
      'ghp_masked_offscreen'
    );
  });

  it('removeAccount routes the replica delete through the SW (offscreen has no chrome.storage, #847)', async () => {
    const sent: any[] = [];
    (globalThis as any).chrome = {
      runtime: {
        id: 'test-ext-id',
        lastError: undefined,
        sendMessage: vi.fn((msg: any, cb: (r: any) => void) => {
          sent.push(msg);
          cb({ ok: true });
        }),
      },
      // NO `storage` — the real offscreen shape. A direct
      // chrome.storage.local.remove would throw here (the twin of the
      // masking bug, reachable via `mcp delete`).
    };
    (globalThis as any).localStorage.setItem(
      'slicc_accounts',
      JSON.stringify([{ providerId: 'github', apiKey: '', accessToken: 'ghp_x' }])
    );

    const { removeAccount, getAccounts } = await import('../../src/ui/provider-settings.js');
    await expect(removeAccount('github')).resolves.toBeUndefined();

    // Replica removal went through the SW secrets.delete message (deleteSecret
    // removes both `oauth.<id>.token` and its `_DOMAINS` companion).
    const del = sent.find((m) => m?.type === 'secrets.delete' && m.name === 'oauth.github.token');
    expect(del).toBeDefined();
    // The account row is gone afterward.
    expect(getAccounts().find((a) => a.providerId === 'github')).toBeUndefined();
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

describe('saveOAuthAccount / replica delete — extension-delegate (thin-bridge) topology', () => {
  let originalLocalStorage: Storage;

  beforeEach(() => {
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
    // No chrome.runtime.id here, but a delegate id was wired at boot →
    // resolveSecretTopology() returns 'extension-delegate'.
    delete (globalThis as any).chrome;
    setExtensionDelegateId('delegate-ext-id');
    vi.mocked(callSecretsBridge).mockReset();
  });

  afterEach(() => {
    setExtensionDelegateId(null);
    (globalThis as any).localStorage = originalLocalStorage;
  });

  it('masks the OAuth token via callSecretsBridge (not REST) and caches maskedValue', async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    vi.mocked(callSecretsBridge).mockResolvedValueOnce({ maskedValue: 'ghp_masked_bridge' });

    const { saveOAuthAccount, getAccounts } = await import('../../src/ui/provider-settings.js');
    await saveOAuthAccount({ providerId: 'github', accessToken: 'ghp_real_bridge' });

    expect(callSecretsBridge).toHaveBeenCalledWith(
      'secrets.mask-oauth-token',
      expect.objectContaining({
        providerId: 'github',
        accessToken: 'ghp_real_bridge',
        domains: 'github.com',
      })
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getAccounts().find((a) => a.providerId === 'github')?.maskedValue).toBe(
      'ghp_masked_bridge'
    );
  });

  it('deletes the replica via callSecretsBridge secrets.delete (not REST)', async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    vi.mocked(callSecretsBridge).mockResolvedValue({ ok: true });
    (globalThis as any).localStorage.setItem(
      'slicc_accounts',
      JSON.stringify([{ providerId: 'github', apiKey: '', accessToken: 'ghp_x' }])
    );

    const { logoutOAuthAccount } = await import('../../src/ui/provider-settings.js');
    await expect(logoutOAuthAccount('github')).resolves.toBeUndefined();

    expect(callSecretsBridge).toHaveBeenCalledWith('secrets.delete', {
      name: 'oauth.github.token',
    });
    expect(fetchMock).not.toHaveBeenCalled();
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

    const { saveOAuthAccount, getOAuthAccountInfo } = await import(
      '../../src/ui/provider-settings.js'
    );
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

  it('bootstrap invokes onSilentRenew for expired account when hook is defined', async () => {
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

    // Seed one expired account whose provider config has onSilentRenew
    lsData['slicc_accounts'] = JSON.stringify([
      {
        providerId: 'github',
        apiKey: '',
        accessToken: 'ghp_old',
        tokenExpiresAt: Date.now() - 60000, // expired
        userName: 'user1',
      },
    ]);

    let renewCount = 0;
    const renewSpy = vi.fn(async () => {
      renewCount++;
      return 'ghp_new';
    });

    // Re-mock provider config to include onSilentRenew for github
    const providersMod = await import('../../src/providers/index.js');
    const original = providersMod.getRegisteredProviderConfig;
    (providersMod as any).getRegisteredProviderConfig = (id: string) => {
      if (id === 'github') {
        return {
          id: 'github',
          name: 'GitHub',
          requiresApiKey: false,
          requiresBaseUrl: false,
          isOAuth: true,
          oauthTokenDomains: ['github.com'],
          onSilentRenew: renewSpy,
        };
      }
      return original(id);
    };

    globalThis.fetch = vi.fn(async () => ({ ok: false }) as any);

    const { __test__ } = await import('../../src/ui/provider-settings.js');
    __test__._resetLegacyCleanup();

    const { bootstrapOAuthReplicas } = await import('../../src/ui/oauth-bootstrap.js');
    await bootstrapOAuthReplicas();

    expect(renewCount).toBe(1);

    // Restore
    (providersMod as any).getRegisteredProviderConfig = original;
  });
});
