import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock provider config so saveOAuthAccount sees a hardcoded oauthTokenDomains.
vi.mock('../../src/providers/index.js', async () => {
  const actual = await vi.importActual('../../src/providers/index.js');
  return {
    ...actual,
    getRegisteredProviderConfig: (id: string) => {
      if (id === 'adobe') {
        return {
          id: 'adobe',
          name: 'Adobe',
          requiresApiKey: false,
          requiresBaseUrl: false,
          isOAuth: true,
          oauthTokenDomains: ['ims-na1.adobelogin.com', '*.adobelogin.com', '*.adobe.io'],
        };
      }
      return undefined;
    },
  };
});

describe('OAuth extra-domains store', () => {
  let lsData: Record<string, string>;
  let originalLocalStorage: Storage;

  beforeEach(() => {
    originalLocalStorage = globalThis.localStorage;
    lsData = {};
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
    (globalThis as any).localStorage = originalLocalStorage;
  });

  it('round-trips extra domains per-provider', async () => {
    const { setExtraOAuthDomains, getExtraOAuthDomains } =
      await import('../../src/ui/provider-settings.js');
    expect(getExtraOAuthDomains('adobe')).toEqual([]);
    setExtraOAuthDomains('adobe', ['admin.da.live', '*.da.live']);
    expect(getExtraOAuthDomains('adobe')).toEqual(['admin.da.live', '*.da.live']);
    setExtraOAuthDomains('github', ['hub.example.com']);
    expect(getExtraOAuthDomains('adobe')).toEqual(['admin.da.live', '*.da.live']);
    expect(getExtraOAuthDomains('github')).toEqual(['hub.example.com']);
  });

  it('setExtraOAuthDomains([]) clears the provider entry', async () => {
    const { setExtraOAuthDomains, getExtraOAuthDomains, getAllExtraOAuthDomains } =
      await import('../../src/ui/provider-settings.js');
    setExtraOAuthDomains('adobe', ['admin.da.live']);
    setExtraOAuthDomains('github', ['hub.example.com']);
    expect(getAllExtraOAuthDomains()).toEqual({
      adobe: ['admin.da.live'],
      github: ['hub.example.com'],
    });
    setExtraOAuthDomains('adobe', []);
    expect(getExtraOAuthDomains('adobe')).toEqual([]);
    expect(getAllExtraOAuthDomains()).toEqual({ github: ['hub.example.com'] });
  });

  it('trims whitespace and drops empty entries on write', async () => {
    const { setExtraOAuthDomains, getExtraOAuthDomains } =
      await import('../../src/ui/provider-settings.js');
    setExtraOAuthDomains('adobe', ['  admin.da.live  ', '', '   ', '*.da.live']);
    expect(getExtraOAuthDomains('adobe')).toEqual(['admin.da.live', '*.da.live']);
  });

  it('survives malformed localStorage payloads', async () => {
    lsData['slicc_oauth_extra_domains'] = '{not json';
    const { getExtraOAuthDomains, getAllExtraOAuthDomains } =
      await import('../../src/ui/provider-settings.js');
    expect(getExtraOAuthDomains('adobe')).toEqual([]);
    expect(getAllExtraOAuthDomains()).toEqual({});
  });
});

describe('saveOAuthAccount — merges provider defaults + extras', () => {
  let originalFetch: typeof globalThis.fetch;
  let lsData: Record<string, string>;
  let originalLocalStorage: Storage;
  let postedDomains: string[] | null;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalLocalStorage = globalThis.localStorage;
    lsData = {};
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

    postedDomains = null;
    globalThis.fetch = vi.fn(async (url: any, init?: any) => {
      if (String(url).includes('/api/secrets/oauth-update')) {
        const body = JSON.parse(init.body);
        postedDomains = body.domains;
        return {
          ok: true,
          json: async () => ({
            providerId: 'adobe',
            name: 'oauth.adobe.token',
            maskedValue: 'masked_test',
            domains: body.domains,
          }),
        } as any;
      }
      return { ok: false } as any;
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    (globalThis as any).localStorage = originalLocalStorage;
  });

  it('POSTs defaults only when no extras configured', async () => {
    const { saveOAuthAccount } = await import('../../src/ui/provider-settings.js');
    await saveOAuthAccount({ providerId: 'adobe', accessToken: 'eyJrealtoken' });
    expect(postedDomains).toEqual(['ims-na1.adobelogin.com', '*.adobelogin.com', '*.adobe.io']);
  });

  it('POSTs defaults + extras merged when extras configured', async () => {
    const { saveOAuthAccount, setExtraOAuthDomains } =
      await import('../../src/ui/provider-settings.js');
    setExtraOAuthDomains('adobe', ['admin.da.live', '*.da.live']);
    await saveOAuthAccount({ providerId: 'adobe', accessToken: 'eyJrealtoken' });
    expect(postedDomains).toEqual([
      'ims-na1.adobelogin.com',
      '*.adobelogin.com',
      '*.adobe.io',
      'admin.da.live',
      '*.da.live',
    ]);
  });

  it('deduplicates case-insensitively when an extra duplicates a default', async () => {
    const { saveOAuthAccount, setExtraOAuthDomains } =
      await import('../../src/ui/provider-settings.js');
    setExtraOAuthDomains('adobe', ['IMS-NA1.ADOBELOGIN.COM', 'admin.da.live']);
    await saveOAuthAccount({ providerId: 'adobe', accessToken: 'eyJrealtoken' });
    // First-seen wins (provider defaults preserved); duplicate dropped.
    expect(postedDomains).toEqual([
      'ims-na1.adobelogin.com',
      '*.adobelogin.com',
      '*.adobe.io',
      'admin.da.live',
    ]);
  });
});
