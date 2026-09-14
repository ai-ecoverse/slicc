import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { callSecretsBridge } from '../../src/core/secrets-bridge-client.js';
import { setExtensionDelegateId } from '../../src/shell/proxied-fetch.js';

Object.defineProperty(globalThis, 'window', { value: {}, configurable: true });
Object.defineProperty(globalThis, 'document', { value: {}, configurable: true });

vi.mock('../../src/core/secrets-bridge-client.js', () => ({
  callSecretsBridge: vi.fn(),
}));

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

  it('names the resolved target when a 2xx comes back without a mask', async () => {
    globalThis.fetch = vi.fn(
      async () => ({ ok: true, json: async () => ({ routes: ['/tray', '/join'] }) }) as any
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { saveOAuthAccount } = await import('../../src/ui/provider-settings.js');
    await saveOAuthAccount({ providerId: 'github', accessToken: 'ghp_real_token' });

    const logged = warn.mock.calls.find((c) =>
      c.some((a) => String(a).includes('missing maskedValue'))
    );
    expect(logged).toBeDefined();
    expect(JSON.stringify(logged)).toContain('/api/secrets/oauth-update');
    warn.mockRestore();
  });

  it('persists granted scopes and surfaces them via getOAuthAccountInfo', async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: false }) as any);

    const { saveOAuthAccount, getOAuthAccountInfo } = await import(
      '../../src/ui/provider-settings.js'
    );
    await saveOAuthAccount({
      providerId: 'github',
      accessToken: 'ghp_scoped',
      scopes: 'repo,read:user,workflow',
    });

    expect(getOAuthAccountInfo('github')?.scopes).toBe('repo,read:user,workflow');
  });

  it('preserves the stored scopes when a silent renewal omits them', async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: false }) as any);

    const { saveOAuthAccount, getOAuthAccountInfo } = await import(
      '../../src/ui/provider-settings.js'
    );
    await saveOAuthAccount({
      providerId: 'github',
      accessToken: 'ghp_first',
      scopes: 'repo,read:user',
    });
    await saveOAuthAccount({ providerId: 'github', accessToken: 'ghp_renewed' });

    expect(getOAuthAccountInfo('github')?.scopes).toBe('repo,read:user');
  });

  it('stores unknown scopes when a fresh login explicitly reports no scope', async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: false }) as any);

    const { saveOAuthAccount, getOAuthAccountInfo } = await import(
      '../../src/ui/provider-settings.js'
    );
    await saveOAuthAccount({
      providerId: 'github',
      accessToken: 'ghp_stale',
      scopes: 'repo,read:user',
    });
    await saveOAuthAccount({
      providerId: 'github',
      accessToken: 'ghp_fresh',
      scopes: undefined,
    });

    expect(getOAuthAccountInfo('github')?.scopes).toBeUndefined();
  });

  it('clears scopes on the logout write (accessToken: "")', async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: false }) as any);

    const { saveOAuthAccount, getAccounts } = await import('../../src/ui/provider-settings.js');
    await saveOAuthAccount({
      providerId: 'github',
      accessToken: 'ghp_first',
      scopes: 'repo,read:user',
    });
    await saveOAuthAccount({ providerId: 'github', accessToken: '' });

    expect(getAccounts().find((a) => a.providerId === 'github')?.scopes).toBeUndefined();
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

    expect(storageWrites['oauth.github.token']).toBeUndefined();

    const askMask = sentMessages.find((m) => m.msg?.type === 'secrets.mask-oauth-token');
    expect(askMask).toBeDefined();
    expect(askMask?.msg.accessToken).toBe('ghp_real_extension');
    expect(askMask?.msg.domains).toBe('github.com');

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
    };
    (globalThis as any).localStorage.setItem(
      'slicc_accounts',
      JSON.stringify([{ providerId: 'github', apiKey: '', accessToken: 'ghp_x' }])
    );

    const { removeAccount, getAccounts } = await import('../../src/ui/provider-settings.js');
    await expect(removeAccount('github')).resolves.toBeUndefined();

    const del = sent.find((m) => m?.type === 'secrets.delete' && m.name === 'oauth.github.token');
    expect(del).toBeDefined();

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

    lsData['slicc_accounts'] = JSON.stringify([
      {
        providerId: 'github',
        apiKey: '',
        accessToken: 'ghp_token1',
        userName: 'user1',
        scopes: 'repo,read:user',
      },
      {
        providerId: 'expired',
        apiKey: '',
        accessToken: 'expired_token',
        tokenExpiresAt: Date.now() - 60000,
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

    const { __test__ } = await import('../../src/ui/provider-settings.js');
    __test__._resetLegacyCleanup();

    const { bootstrapOAuthReplicas } = await import('../../src/ui/oauth-bootstrap.js');
    await bootstrapOAuthReplicas();

    expect(postCallCount).toBe(1);
    const bootstrapped = JSON.parse(lsData['slicc_accounts']);
    expect(
      bootstrapped.find((a: { providerId: string }) => a.providerId === 'github')?.scopes
    ).toBe('repo,read:user');
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

    lsData['slicc_accounts'] = JSON.stringify([
      {
        providerId: 'github',
        apiKey: '',
        accessToken: 'ghp_old',
        tokenExpiresAt: Date.now() - 60000,
        userName: 'user1',
      },
    ]);

    let renewCount = 0;
    const renewSpy = vi.fn(async () => {
      renewCount++;
      return 'ghp_new';
    });

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

    (providersMod as any).getRegisteredProviderConfig = original;
  });
});

describe('ensureOAuthMaskReplica — remask a held token (#2921)', () => {
  let originalFetch: typeof globalThis.fetch;
  let originalChrome: unknown;
  let originalLocalStorage: Storage;

  function installLocalStorage(): Record<string, string> {
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
    return lsData;
  }

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalChrome = (globalThis as any).chrome;
    originalLocalStorage = globalThis.localStorage;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalChrome === undefined) {
      delete (globalThis as any).chrome;
    } else {
      (globalThis as any).chrome = originalChrome;
    }
    (globalThis as any).localStorage = originalLocalStorage;
  });

  it('returns an existing distinct replica without writing', async () => {
    const lsData = installLocalStorage();
    delete (globalThis as any).chrome;
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    lsData['slicc_accounts'] = JSON.stringify([
      {
        providerId: 'github',
        apiKey: '',
        accessToken: 'gho_REAL',
        maskedValue: 'gho_masked_existing',
      },
    ]);

    const { ensureOAuthMaskReplica } = await import('../../src/ui/provider-settings.js');
    const result = await ensureOAuthMaskReplica('github');
    expect(result).toEqual({ maskedValue: 'gho_masked_existing' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('CLI: remasks when maskedValue is missing and persists the replica', async () => {
    const lsData = installLocalStorage();
    delete (globalThis as any).chrome;
    lsData['slicc_accounts'] = JSON.stringify([
      { providerId: 'github', apiKey: '', accessToken: 'gho_REAL' },
    ]);
    globalThis.fetch = vi.fn(async (url: unknown) => {
      if (String(url).includes('/api/secrets/oauth-update')) {
        return {
          ok: true,
          json: async () => ({ maskedValue: 'gho_masked_cli' }),
        } as Response;
      }
      return { ok: false } as Response;
    });

    const { ensureOAuthMaskReplica, getOAuthAccountInfo } = await import(
      '../../src/ui/provider-settings.js'
    );
    const result = await ensureOAuthMaskReplica('github');
    expect(result).toEqual({ maskedValue: 'gho_masked_cli' });
    expect(getOAuthAccountInfo('github')?.maskedValue).toBe('gho_masked_cli');
    expect(getOAuthAccountInfo('github')?.token).toBe('gho_REAL');
  });

  it('CLI: names the replica when the mask write fails', async () => {
    const lsData = installLocalStorage();
    delete (globalThis as any).chrome;
    lsData['slicc_accounts'] = JSON.stringify([
      { providerId: 'github', apiKey: '', accessToken: 'gho_REAL' },
    ]);
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 503 }) as Response);

    const { ensureOAuthMaskReplica, getOAuthAccountInfo } = await import(
      '../../src/ui/provider-settings.js'
    );
    const result = await ensureOAuthMaskReplica('github');
    expect(result.error).toMatch(/replica/i);
    expect(result.maskedValue).toBeUndefined();
    expect(getOAuthAccountInfo('github')?.maskedValue).toBeUndefined();
    expect(getOAuthAccountInfo('github')?.token).toBe('gho_REAL');
  });

  it('extension: remasks via SW persistOAuthMaskViaServiceWorker', async () => {
    const lsData = installLocalStorage();
    lsData['slicc_accounts'] = JSON.stringify([
      { providerId: 'github', apiKey: '', accessToken: 'gho_REAL' },
    ]);
    (globalThis as any).chrome = {
      runtime: {
        id: 'test-ext-id',
        lastError: undefined,
        sendMessage: vi.fn((_msg: unknown, cb: (r: unknown) => void) => {
          cb({ maskedValue: 'gho_masked_sw' });
        }),
      },
    };

    const { ensureOAuthMaskReplica, getOAuthAccountInfo } = await import(
      '../../src/ui/provider-settings.js'
    );
    const result = await ensureOAuthMaskReplica('github');
    expect(result).toEqual({ maskedValue: 'gho_masked_sw' });
    expect(getOAuthAccountInfo('github')?.maskedValue).toBe('gho_masked_sw');
  });

  it('refuses a replica that equals the access token', async () => {
    const lsData = installLocalStorage();
    delete (globalThis as any).chrome;
    lsData['slicc_accounts'] = JSON.stringify([
      {
        providerId: 'github',
        apiKey: '',
        accessToken: 'gho_REAL',
        maskedValue: 'gho_REAL',
      },
    ]);
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ maskedValue: 'gho_REAL' }),
    })) as unknown as typeof fetch;

    const { ensureOAuthMaskReplica } = await import('../../src/ui/provider-settings.js');
    const result = await ensureOAuthMaskReplica('github');
    expect(result.maskedValue).toBeUndefined();
    expect(result.error).toBe('mask replica equals the access token');
  });

  it('retries remask when the access token rotates during the replica write', async () => {
    const lsData = installLocalStorage();
    delete (globalThis as any).chrome;
    lsData['slicc_accounts'] = JSON.stringify([
      { providerId: 'github', apiKey: '', accessToken: 'gho_OLD' },
    ]);
    let posts = 0;
    const posted: string[] = [];
    globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { accessToken?: string };
      posted.push(body.accessToken ?? '');
      posts++;
      if (posts === 1) {
        lsData['slicc_accounts'] = JSON.stringify([
          { providerId: 'github', apiKey: '', accessToken: 'gho_NEW' },
        ]);
        return {
          ok: true,
          json: async () => ({ maskedValue: 'gho_masked_old' }),
        } as Response;
      }
      return {
        ok: true,
        json: async () => ({ maskedValue: 'gho_masked_new' }),
      } as Response;
    });

    const { ensureOAuthMaskReplica, getOAuthAccountInfo } = await import(
      '../../src/ui/provider-settings.js'
    );
    const result = await ensureOAuthMaskReplica('github');
    expect(posted).toEqual(['gho_OLD', 'gho_NEW']);
    expect(result).toEqual({ maskedValue: 'gho_masked_new' });
    expect(getOAuthAccountInfo('github')?.token).toBe('gho_NEW');
    expect(getOAuthAccountInfo('github')?.maskedValue).toBe('gho_masked_new');
  });
});
