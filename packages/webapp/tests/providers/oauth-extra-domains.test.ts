import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
    const { setExtraOAuthDomains, getExtraOAuthDomains } = await import(
      '../../src/ui/provider-settings.js'
    );
    expect(getExtraOAuthDomains('adobe')).toEqual([]);
    setExtraOAuthDomains('adobe', ['admin.da.live', '*.da.live']);
    expect(getExtraOAuthDomains('adobe')).toEqual(['admin.da.live', '*.da.live']);
    setExtraOAuthDomains('github', ['hub.example.com']);
    expect(getExtraOAuthDomains('adobe')).toEqual(['admin.da.live', '*.da.live']);
    expect(getExtraOAuthDomains('github')).toEqual(['hub.example.com']);
  });

  it('setExtraOAuthDomains([]) clears the provider entry', async () => {
    const { setExtraOAuthDomains, getExtraOAuthDomains, getAllExtraOAuthDomains } = await import(
      '../../src/ui/provider-settings.js'
    );
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
    const { setExtraOAuthDomains, getExtraOAuthDomains } = await import(
      '../../src/ui/provider-settings.js'
    );
    setExtraOAuthDomains('adobe', ['  admin.da.live  ', '', '   ', '*.da.live']);
    expect(getExtraOAuthDomains('adobe')).toEqual(['admin.da.live', '*.da.live']);
  });

  it('survives malformed localStorage payloads', async () => {
    lsData['slicc_oauth_extra_domains'] = '{not json';
    const { getExtraOAuthDomains, getAllExtraOAuthDomains } = await import(
      '../../src/ui/provider-settings.js'
    );
    expect(getExtraOAuthDomains('adobe')).toEqual([]);
    expect(getAllExtraOAuthDomains()).toEqual({});
  });
});

describe('setExtraOAuthDomainsAsync — DOM vs worker path', () => {
  let lsData: Record<string, string>;
  let originalLocalStorage: Storage;
  let originalWindow: unknown;
  let originalDocument: unknown;
  let originalPanelRpc: unknown;

  beforeEach(() => {
    originalLocalStorage = globalThis.localStorage;
    originalWindow = (globalThis as { window?: unknown }).window;
    originalDocument = (globalThis as { document?: unknown }).document;
    originalPanelRpc = (globalThis as { __slicc_panelRpc?: unknown }).__slicc_panelRpc;
    lsData = {};
    (globalThis as { localStorage: Storage }).localStorage = {
      get length(): number {
        return Object.keys(lsData).length;
      },
      key: (i: number) => Object.keys(lsData)[i] ?? null,
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
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  afterEach(() => {
    (globalThis as { localStorage: Storage }).localStorage = originalLocalStorage;
    if (originalWindow === undefined) {
      delete (globalThis as { window?: unknown }).window;
    } else {
      (globalThis as { window: unknown }).window = originalWindow;
    }
    if (originalDocument === undefined) {
      delete (globalThis as { document?: unknown }).document;
    } else {
      (globalThis as { document: unknown }).document = originalDocument;
    }
    if (originalPanelRpc === undefined) {
      delete (globalThis as { __slicc_panelRpc?: unknown }).__slicc_panelRpc;
    } else {
      (globalThis as { __slicc_panelRpc?: unknown }).__slicc_panelRpc = originalPanelRpc;
    }
    vi.resetModules();
  });

  it('page context (has DOM): writes directly to localStorage, no bridge call', async () => {
    (globalThis as { window: unknown }).window = {};
    (globalThis as { document: unknown }).document = {};
    const calls: Array<{ op: string; payload: unknown }> = [];
    (globalThis as { __slicc_panelRpc?: unknown }).__slicc_panelRpc = {
      call: async (op: string, payload: unknown) => {
        calls.push({ op, payload });
        throw new Error('bridge must not be called in page context');
      },
      dispose: () => {},
    };
    const { setExtraOAuthDomainsAsync, getExtraOAuthDomains } = await import(
      '../../src/ui/provider-settings.js'
    );
    await setExtraOAuthDomainsAsync('adobe', ['admin.hlx.page', '*.aem.page']);
    expect(getExtraOAuthDomains('adobe')).toEqual(['admin.hlx.page', '*.aem.page']);
    expect(calls).toEqual([]);
  });

  it('worker context (no DOM): routes through panel-rpc and mirrors store into shim', async () => {
    const calls: Array<{ op: string; payload: unknown }> = [];
    let bridgeStore: Record<string, string[]> = {};
    (globalThis as { __slicc_panelRpc?: unknown }).__slicc_panelRpc = {
      call: async (op: string, payload: unknown) => {
        calls.push({ op, payload });
        const { providerId, domains } = payload as { providerId: string; domains: string[] };

        if (domains.length === 0) {
          delete bridgeStore[providerId];
        } else {
          bridgeStore = { ...bridgeStore, [providerId]: domains };
        }
        return { storeAfter: bridgeStore };
      },
      dispose: () => {},
    };
    const { setExtraOAuthDomainsAsync, getExtraOAuthDomains } = await import(
      '../../src/ui/provider-settings.js'
    );
    await setExtraOAuthDomainsAsync('adobe', ['admin.hlx.page']);
    expect(calls).toEqual([
      { op: 'oauth-extras-set', payload: { providerId: 'adobe', domains: ['admin.hlx.page'] } },
    ]);

    expect(lsData.slicc_oauth_extra_domains).toBe(JSON.stringify({ adobe: ['admin.hlx.page'] }));
    expect(getExtraOAuthDomains('adobe')).toEqual(['admin.hlx.page']);
  });

  it('worker context with no bridge available throws a clear error', async () => {
    delete (globalThis as { __slicc_panelRpc?: unknown }).__slicc_panelRpc;
    const { setExtraOAuthDomainsAsync } = await import('../../src/ui/provider-settings.js');
    await expect(setExtraOAuthDomainsAsync('adobe', ['x.example.com'])).rejects.toThrow(
      /no DOM and no panel-rpc client/i
    );
  });

  it('worker-shim mirror failure does NOT propagate — page write is durable', async () => {
    (globalThis as { __slicc_panelRpc?: unknown }).__slicc_panelRpc = {
      call: async () => ({ storeAfter: { adobe: ['mirrored.example.com'] } }),
      dispose: () => {},
    };

    let originalSetItem: ((k: string, v: string) => void) | null = null;

    const { setLogLevel, getLogLevel, LogLevel } = await import('../../src/base/logger.js');
    const priorLevel = getLogLevel();
    setLogLevel(LogLevel.WARN);
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      originalSetItem = globalThis.localStorage.setItem.bind(globalThis.localStorage);
      Object.defineProperty(globalThis.localStorage, 'setItem', {
        configurable: true,
        writable: true,
        value: () => {
          throw new Error('simulated worker-shim quota');
        },
      });
      const { setExtraOAuthDomainsAsync } = await import('../../src/ui/provider-settings.js');

      await expect(
        setExtraOAuthDomainsAsync('adobe', ['mirrored.example.com'])
      ).resolves.toBeUndefined();

      expect(consoleWarnSpy).toHaveBeenCalledTimes(1);
      const call = consoleWarnSpy.mock.calls[0]!;

      expect(call[0]).toBe('[provider-settings]');
      expect(call[1]).toMatch(/worker-shim mirror failed/i);
      expect(call[1]).toMatch(/reload to refresh/i);
      expect(call[2]).toMatchObject({ providerId: 'adobe' });
    } finally {
      if (originalSetItem) {
        Object.defineProperty(globalThis.localStorage, 'setItem', {
          configurable: true,
          writable: true,
          value: originalSetItem,
        });
      }
      consoleWarnSpy.mockRestore();
      setLogLevel(priorLevel);
    }
  });
});

describe('saveOAuthAccount — merges provider defaults + extras', () => {
  let originalFetch: typeof globalThis.fetch;
  let lsData: Record<string, string>;
  let originalLocalStorage: Storage;
  let postedDomains: string[] | null;
  let originalWindow: unknown;
  let originalDocument: unknown;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalLocalStorage = globalThis.localStorage;
    originalWindow = (globalThis as { window?: unknown }).window;
    originalDocument = (globalThis as { document?: unknown }).document;
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

    (globalThis as { window: unknown }).window = {};
    (globalThis as { document: unknown }).document = {};

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
    if (originalWindow === undefined) {
      delete (globalThis as { window?: unknown }).window;
    } else {
      (globalThis as { window: unknown }).window = originalWindow;
    }
    if (originalDocument === undefined) {
      delete (globalThis as { document?: unknown }).document;
    } else {
      (globalThis as { document: unknown }).document = originalDocument;
    }
  });

  it('POSTs defaults only when no extras configured', async () => {
    const { saveOAuthAccount } = await import('../../src/ui/provider-settings.js');
    await saveOAuthAccount({ providerId: 'adobe', accessToken: 'eyJrealtoken' });
    expect(postedDomains).toEqual(['ims-na1.adobelogin.com', '*.adobelogin.com', '*.adobe.io']);
  });

  it('POSTs defaults + extras merged when extras configured', async () => {
    const { saveOAuthAccount, setExtraOAuthDomains } = await import(
      '../../src/ui/provider-settings.js'
    );
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
    const { saveOAuthAccount, setExtraOAuthDomains } = await import(
      '../../src/ui/provider-settings.js'
    );
    setExtraOAuthDomains('adobe', ['IMS-NA1.ADOBELOGIN.COM', 'admin.da.live']);
    await saveOAuthAccount({ providerId: 'adobe', accessToken: 'eyJrealtoken' });

    expect(postedDomains).toEqual([
      'ims-na1.adobelogin.com',
      '*.adobelogin.com',
      '*.adobe.io',
      'admin.da.live',
    ]);
  });
});

describe('saveOAuthAccount — worker-context bridge routing (#701)', () => {
  let originalFetch: typeof globalThis.fetch;
  let lsData: Record<string, string>;
  let originalLocalStorage: Storage;
  let originalWindow: unknown;
  let originalDocument: unknown;
  let originalPanelRpc: unknown;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalLocalStorage = globalThis.localStorage;
    originalWindow = (globalThis as { window?: unknown }).window;
    originalDocument = (globalThis as { document?: unknown }).document;
    originalPanelRpc = (globalThis as { __slicc_panelRpc?: unknown }).__slicc_panelRpc;
    lsData = {};
    (globalThis as { localStorage: Storage }).localStorage = {
      get length(): number {
        return Object.keys(lsData).length;
      },
      key: (i: number) => Object.keys(lsData)[i] ?? null,
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
    delete (globalThis as { chrome?: unknown }).chrome;

    globalThis.fetch = vi.fn(async () => {
      return {
        ok: true,
        json: async () => ({ providerId: 'mcp:secrets', maskedValue: 'mask-x' }),
      } as unknown as Response;
    }) as unknown as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    (globalThis as { localStorage: Storage }).localStorage = originalLocalStorage;
    if (originalWindow === undefined) {
      delete (globalThis as { window?: unknown }).window;
    } else {
      (globalThis as { window: unknown }).window = originalWindow;
    }
    if (originalDocument === undefined) {
      delete (globalThis as { document?: unknown }).document;
    } else {
      (globalThis as { document: unknown }).document = originalDocument;
    }
    if (originalPanelRpc === undefined) {
      delete (globalThis as { __slicc_panelRpc?: unknown }).__slicc_panelRpc;
    } else {
      (globalThis as { __slicc_panelRpc?: unknown }).__slicc_panelRpc = originalPanelRpc;
    }
    vi.resetModules();
  });

  it('worker context (no DOM): routes saves through panel-rpc and mirrors to shim', async () => {
    const calls: Array<{ op: string; payload: unknown }> = [];
    const pageStore: Record<string, string> = {};
    (globalThis as { __slicc_panelRpc?: unknown }).__slicc_panelRpc = {
      call: async (op: string, payload: unknown) => {
        calls.push({ op, payload });
        if (op === 'save-oauth-accounts') {
          const { accountsJson } = payload as { accountsJson: string };
          pageStore.slicc_accounts = accountsJson;
          return { storedJson: accountsJson };
        }
        throw new Error(`unexpected op ${op}`);
      },
      dispose: () => {},
    };
    const { saveOAuthAccount } = await import('../../src/ui/provider-settings.js');
    await saveOAuthAccount({
      providerId: 'mcp:secrets',
      accessToken: 'tok-fresh',
      refreshToken: 'rt-fresh',
      tokenExpiresAt: 9_999_999_999_999,
    });

    const saves = calls.filter((c) => c.op === 'save-oauth-accounts');
    expect(saves.length).toBeGreaterThanOrEqual(1);

    expect(pageStore.slicc_accounts).toBeDefined();
    const stored = JSON.parse(pageStore.slicc_accounts!);
    expect(Array.isArray(stored)).toBe(true);
    expect(stored[0]).toMatchObject({
      providerId: 'mcp:secrets',
      accessToken: 'tok-fresh',
      refreshToken: 'rt-fresh',
    });

    expect(lsData.slicc_accounts).toBe(pageStore.slicc_accounts);
  });

  it('worker context with no bridge available throws a clear error', async () => {
    delete (globalThis as { __slicc_panelRpc?: unknown }).__slicc_panelRpc;
    const { saveOAuthAccount } = await import('../../src/ui/provider-settings.js');
    await expect(
      saveOAuthAccount({ providerId: 'mcp:secrets', accessToken: 'tok' })
    ).rejects.toThrow(/no DOM and no panel-rpc client/i);
  });
});
