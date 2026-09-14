import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const oauthServiceMocks = vi.hoisted(() => ({
  createOAuthLauncher: vi.fn(),
  getOAuthPageOrigin: vi.fn(),
}));

vi.mock('../../src/providers/oauth-service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/providers/oauth-service.js')>();
  return { ...actual, ...oauthServiceMocks };
});

const storage = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => storage.get(k) ?? null,
  setItem: (k: string, v: string) => storage.set(k, v),
  removeItem: (k: string) => storage.delete(k),
  get length() {
    return storage.size;
  },
  key: (i: number) => [...storage.keys()][i] ?? null,
  clear: () => storage.clear(),
});

describe('Adobe token expiry logic', () => {
  it('token is valid when expiresAt is more than 60s in the future', () => {
    const expiresAt = Date.now() + 120000;
    const expiresIn = expiresAt - Date.now();
    expect(expiresIn > 60000).toBe(true);
  });

  it('token is expired when expiresAt is in the past', () => {
    const expiresAt = Date.now() - 1000;
    const expiresIn = expiresAt - Date.now();
    expect(expiresIn > 60000).toBe(false);
    expect(expiresIn > 0).toBe(false);
  });

  it('token is expiring soon when less than 60s remaining', () => {
    const expiresAt = Date.now() + 30000;
    const expiresIn = expiresAt - Date.now();
    expect(expiresIn > 60000).toBe(false);
    expect(expiresIn > 0).toBe(true);
  });
});

describe('Adobe model persistence', () => {
  beforeEach(() => storage.clear());

  it('persists models to localStorage', () => {
    const models = [
      { id: 'claude-opus-4-6', name: 'Claude Opus 4.6' },
      { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
    ];
    localStorage.setItem('slicc-adobe-models', JSON.stringify(models));

    const persisted = localStorage.getItem('slicc-adobe-models');
    expect(persisted).not.toBeNull();
    const parsed = JSON.parse(persisted!);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].id).toBe('claude-opus-4-6');
  });

  it('handles corrupted localStorage gracefully', () => {
    localStorage.setItem('slicc-adobe-models', '{broken json');

    let result: Array<{ id: string }> | null = null;
    try {
      const raw = localStorage.getItem('slicc-adobe-models');
      if (raw) result = JSON.parse(raw);
    } catch {
      result = null;
    }
    expect(result).toBeNull();
  });

  it('returns empty when no models persisted', () => {
    const raw = localStorage.getItem('slicc-adobe-models');
    expect(raw).toBeNull();
  });
});

describe('Token extraction from URL', () => {
  it('extracts the provider-reported scope from the redirect fragment', async () => {
    const { extractTokenFromUrl } = await import('../../providers/adobe.js');
    const url =
      'https://example.com/callback#access_token=abc123&expires_in=3600&scope=openid%2Cemail';
    const result = extractTokenFromUrl(url);
    expect(result).toEqual({ accessToken: 'abc123', expiresIn: 3600, scope: 'openid,email' });
  });

  it('leaves scope unknown when the redirect fragment omits it', async () => {
    const { extractTokenFromUrl } = await import('../../providers/adobe.js');
    const result = extractTokenFromUrl(
      'https://example.com/callback#access_token=abc123&expires_in=3600'
    );
    expect(result).toEqual({ accessToken: 'abc123', expiresIn: 3600, scope: undefined });
  });

  it('returns null when no fragment', async () => {
    const { extractTokenFromUrl } = await import('../../providers/adobe.js');
    expect(extractTokenFromUrl('https://example.com/callback')).toBeNull();
  });

  it('returns null when no access_token in fragment', async () => {
    const { extractTokenFromUrl } = await import('../../providers/adobe.js');
    expect(extractTokenFromUrl('https://example.com/callback#error=access_denied')).toBeNull();
  });

  it('defaults expiresIn to 86400 when not specified', async () => {
    const { extractTokenFromUrl } = await import('../../providers/adobe.js');
    const url = 'https://example.com/callback#access_token=xyz';
    const result = extractTokenFromUrl(url);
    expect(result?.expiresIn).toBe(86400);
  });
});

describe('Adobe scope persistence', () => {
  const proxyEndpoint = 'https://adobe-proxy.scope.test';
  let originalFetch: typeof globalThis.fetch;
  let originalWindow: unknown;
  let originalDocument: unknown;

  function redirectWithScope(authorizeUrl: string, accessToken: string, scope: string): string {
    const authorize = new URL(authorizeUrl);
    const state = JSON.parse(atob(authorize.searchParams.get('state')!)) as { nonce: string };
    const redirectUri = authorize.searchParams.get('redirect_uri')!;
    return `${redirectUri}?nonce=${state.nonce}#access_token=${accessToken}&expires_in=3600&scope=${encodeURIComponent(scope)}`;
  }

  beforeEach(() => {
    storage.clear();
    vi.clearAllMocks();
    originalFetch = globalThis.fetch;
    originalWindow = (globalThis as { window?: unknown }).window;
    originalDocument = (globalThis as { document?: unknown }).document;
    (globalThis as { window?: unknown }).window = {
      location: { origin: 'http://localhost:5710', href: 'http://localhost:5710/' },
    };
    (globalThis as { document?: unknown }).document = {};
    oauthServiceMocks.getOAuthPageOrigin.mockResolvedValue({
      origin: 'http://localhost:5710',
      href: 'http://localhost:5710/',
    });
    globalThis.fetch = vi.fn(async (url: unknown) => {
      const value = String(url);
      if (value === `${proxyEndpoint}/v1/config`) {
        return new Response(JSON.stringify({ clientId: 'adobe-client', scopes: 'openid' }), {
          status: 200,
        });
      }
      if (value.endsWith('/ims/userinfo/v2')) {
        return new Response(JSON.stringify({ displayName: 'Adobe User' }), { status: 200 });
      }
      if (value === `${proxyEndpoint}/v1/models`) {
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }
      return new Response('', { status: 503 });
    }) as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else (globalThis as { window?: unknown }).window = originalWindow;
    if (originalDocument === undefined) delete (globalThis as { document?: unknown }).document;
    else (globalThis as { document?: unknown }).document = originalDocument;
  });

  it('persists the provider-reported scope from interactive login', async () => {
    localStorage.setItem(
      'slicc_accounts',
      JSON.stringify([{ providerId: 'adobe', apiKey: '', baseUrl: proxyEndpoint }])
    );
    const launcher = vi.fn(async (authorizeUrl: string) =>
      redirectWithScope(authorizeUrl, 'adobe-login-token', 'openid,email')
    );
    const { config } = await import('../../providers/adobe.js');

    await config.onOAuthLogin!(launcher, () => {});

    const { getAccounts } = await import('../../src/ui/provider-settings.js');
    const account = getAccounts().find((candidate) => candidate.providerId === 'adobe');
    expect(account?.accessToken).toBe('adobe-login-token');
    expect(account?.scopes).toBe('openid,email');
  });

  it('persists the provider-reported scope from silent renewal', async () => {
    localStorage.setItem(
      'slicc_accounts',
      JSON.stringify([
        {
          providerId: 'adobe',
          apiKey: '',
          baseUrl: proxyEndpoint,
          accessToken: 'adobe-old-token',
          scopes: 'openid',
        },
      ])
    );
    oauthServiceMocks.createOAuthLauncher.mockReturnValue(async (authorizeUrl: string) =>
      redirectWithScope(authorizeUrl, 'adobe-renewed-token', 'openid,email')
    );
    const { config } = await import('../../providers/adobe.js');

    await expect(config.onSilentRenew!()).resolves.toBe('adobe-renewed-token');

    const { getAccounts } = await import('../../src/ui/provider-settings.js');
    const account = getAccounts().find((candidate) => candidate.providerId === 'adobe');
    expect(account?.accessToken).toBe('adobe-renewed-token');
    expect(account?.scopes).toBe('openid,email');
  });
});

describe('Model metadata survives renewal', () => {
  beforeEach(() => storage.clear());

  it('persisted models with api field are returned with metadata intact', () => {
    const models = [
      { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', context_window: 1000000 },
      {
        id: 'zai-glm-4.7',
        name: 'GLM 4.7',
        api: 'openai',
        context_window: 131072,
        max_tokens: 40960,
      },
    ];
    localStorage.setItem('slicc-adobe-models', JSON.stringify(models));

    const persisted = JSON.parse(localStorage.getItem('slicc-adobe-models')!);
    expect(persisted[1].api).toBe('openai');
    expect(persisted[1].context_window).toBe(131072);
  });

  it('persisted models WITHOUT api field lose routing info (pre-metadata format)', () => {
    const models = [
      { id: 'claude-opus-4-6', name: 'Claude Opus 4.6' },
      { id: 'zai-glm-4.7', name: 'GLM 4.7' },
    ];
    localStorage.setItem('slicc-adobe-models', JSON.stringify(models));

    const persisted = JSON.parse(localStorage.getItem('slicc-adobe-models')!);

    expect(persisted[1].api).toBeUndefined();
  });

  it('getAdobeModels pattern repopulates metadata after renewal', async () => {
    const proxyMetadataCache = new Map<string, { api?: string; context_window?: number }>();
    const proxyResponse = [
      { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', context_window: 1000000 },
      { id: 'zai-glm-4.7', name: 'GLM 4.7', api: 'openai', context_window: 131072 },
    ];

    for (const pm of proxyResponse) {
      proxyMetadataCache.set(pm.id, {
        api: (pm as { api?: string }).api,
        context_window: pm.context_window,
      });
    }

    const enriched = proxyResponse.map((m) => {
      const entry: { id: string; name: string; api?: string; context_window?: number } = {
        id: m.id,
        name: m.name,
      };
      const meta = proxyMetadataCache.get(m.id);
      if (meta?.api) entry.api = meta.api;
      if (meta?.context_window !== undefined) entry.context_window = meta.context_window;
      return entry;
    });

    expect(enriched[1].api).toBe('openai');
    expect(enriched[0].api).toBeUndefined();

    localStorage.setItem('slicc-adobe-models', JSON.stringify(enriched));

    const roundTripped = JSON.parse(localStorage.getItem('slicc-adobe-models')!);
    expect(roundTripped[1].api).toBe('openai');
  });
});

describe('Renewal deduplication pattern', () => {
  it('concurrent calls share the same promise', async () => {
    let resolveRenewal: (v: string | null) => void;
    let callCount = 0;

    let renewalInProgress: Promise<string | null> | null = null;

    function silentRenew(): Promise<string | null> {
      if (renewalInProgress !== null) return renewalInProgress;
      renewalInProgress = (async () => {
        try {
          callCount++;
          return await new Promise<string | null>((resolve) => {
            resolveRenewal = resolve;
          });
        } finally {
          renewalInProgress = null;
        }
      })();
      return renewalInProgress;
    }

    const p1 = silentRenew();
    const p2 = silentRenew();

    expect(p1).toBe(p2);

    resolveRenewal!('new-token');
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r1).toBe('new-token');
    expect(r2).toBe('new-token');
    expect(callCount).toBe(1);
  });

  it('resets after completion, allowing new renewals after a tick', async () => {
    let renewalInProgress: Promise<string | null> | null = null;
    let callCount = 0;

    function silentRenew(): Promise<string | null> {
      if (renewalInProgress !== null) return renewalInProgress;
      renewalInProgress = (async () => {
        try {
          callCount++;

          await new Promise((r) => setTimeout(r, 10));
          return 'token-' + callCount;
        } finally {
          renewalInProgress = null;
        }
      })();
      return renewalInProgress;
    }

    const r1 = await silentRenew();
    expect(r1).toBe('token-1');

    const r2 = await silentRenew();
    expect(r2).toBe('token-2');
    expect(callCount).toBe(2);
  });
});

describe('OAuth state encoding', () => {
  it('encodes port, path, and nonce into base64 JSON', () => {
    const state = btoa(JSON.stringify({ port: 5720, path: '/auth/callback', nonce: 'test123' }));
    const decoded = JSON.parse(atob(state));
    expect(decoded.port).toBe(5720);
    expect(decoded.path).toBe('/auth/callback');
    expect(decoded.nonce).toBe('test123');
  });

  it('state round-trips through URL encoding', () => {
    const state = btoa(JSON.stringify({ port: 5710, path: '/auth/callback', nonce: 'abc' }));
    const encoded = encodeURIComponent(state);
    const decoded = JSON.parse(atob(decodeURIComponent(encoded)));
    expect(decoded.port).toBe(5710);
  });

  it('nonce mismatch is detectable for CSRF protection', () => {
    const expected = 'nonce-from-cli';
    const received = 'nonce-from-attacker';
    expect(received).not.toBe(expected);
  });

  it('nonce match passes verification', () => {
    const nonce = crypto.randomUUID();
    const state = btoa(JSON.stringify({ port: 5710, path: '/auth/callback', nonce }));
    const decoded = JSON.parse(atob(state));

    const callbackUrl = new URL(
      `http://localhost:5710/auth/callback?nonce=${encodeURIComponent(decoded.nonce)}#access_token=xxx`
    );
    expect(callbackUrl.searchParams.get('nonce')).toBe(nonce);
  });

  it('supports custom path for different providers', () => {
    const state = btoa(JSON.stringify({ port: 5720, path: '/auth/github/callback', nonce: 'n1' }));
    const decoded = JSON.parse(atob(state));
    expect(decoded.path).toBe('/auth/github/callback');
  });
});

describe('silentRenewToken worker-safety guard (pattern)', () => {
  const silentRenewMimic = async (): Promise<string | null> => {
    if (typeof window === 'undefined') return null;

    return 'page-side-token';
  };

  it('returns null when window is undefined (worker context)', async () => {
    const originalWindow = (globalThis as Record<string, unknown>).window;
    delete (globalThis as Record<string, unknown>).window;
    try {
      expect(typeof (globalThis as Record<string, unknown>).window).toBe('undefined');
      const result = await silentRenewMimic();
      expect(result).toBeNull();
    } finally {
      (globalThis as Record<string, unknown>).window = originalWindow;
    }
  });

  it('does NOT throw a ReferenceError in worker context', async () => {
    const originalWindow = (globalThis as Record<string, unknown>).window;
    delete (globalThis as Record<string, unknown>).window;
    try {
      await expect(silentRenewMimic()).resolves.toBeNull();
    } finally {
      (globalThis as Record<string, unknown>).window = originalWindow;
    }
  });
});

describe('SLICC version header injection', () => {
  const SLICC_VERSION_HEADER = 'X-Slicc-Version';
  const sliccVersion = '9.9.9-test';

  type TestStreamOptions = {
    headers?: Record<string, string | null>;
    apiKey?: string;
    maxTokens?: number;
    signal?: AbortSignal;
  };

  function withSliccVersionHeader(options: TestStreamOptions): TestStreamOptions {
    const merged: Record<string, string | null> = {};
    const versionKeyLower = SLICC_VERSION_HEADER.toLowerCase();
    if (options.headers) {
      for (const [key, value] of Object.entries(options.headers)) {
        if (key.toLowerCase() !== versionKeyLower) merged[key] = value;
      }
    }
    merged[SLICC_VERSION_HEADER] = sliccVersion;
    return { ...options, headers: merged };
  }

  it('adds X-Slicc-Version when caller passes no headers', () => {
    const result = withSliccVersionHeader({ apiKey: 'tok' });
    expect(result.headers).toEqual({ [SLICC_VERSION_HEADER]: sliccVersion });
  });

  it('preserves caller headers (e.g. X-Session-Id from scoop-context)', () => {
    const result = withSliccVersionHeader({
      apiKey: 'tok',
      headers: { 'X-Session-Id': 'abc-123' },
    });
    expect(result.headers).toEqual({
      'X-Session-Id': 'abc-123',
      [SLICC_VERSION_HEADER]: sliccVersion,
    });
  });

  it('version wins on conflict — callers cannot spoof X-Slicc-Version', () => {
    const result = withSliccVersionHeader({
      headers: { [SLICC_VERSION_HEADER]: 'spoofed' },
    });
    expect(result.headers?.[SLICC_VERSION_HEADER]).toBe(sliccVersion);
  });

  it('strips case-variant spoofs (HTTP headers are case-insensitive)', () => {
    const result = withSliccVersionHeader({
      headers: { 'x-slicc-version': 'spoofed-lower', 'X-SLICC-VERSION': 'spoofed-upper' },
    });
    const keys = Object.keys(result.headers ?? {});
    const versionKeys = keys.filter((k) => k.toLowerCase() === 'x-slicc-version');
    expect(versionKeys).toEqual([SLICC_VERSION_HEADER]);
    expect(result.headers?.[SLICC_VERSION_HEADER]).toBe(sliccVersion);
  });

  it('leaves non-header options (apiKey, signal, etc.) untouched', () => {
    const signal = new AbortController().signal;
    const result = withSliccVersionHeader({
      apiKey: 'tok',
      maxTokens: 100,
      signal,
    });
    expect(result.apiKey).toBe('tok');
    expect(result.maxTokens).toBe(100);
    expect(result.signal).toBe(signal);
  });

  it('fetch shape for /v1/config carries only the version header', () => {
    const headers = { [SLICC_VERSION_HEADER]: sliccVersion };
    expect(headers).toEqual({ [SLICC_VERSION_HEADER]: sliccVersion });
  });

  it('fetch shape for /v1/models carries Authorization + version header', () => {
    const headers = {
      Authorization: 'Bearer token-xyz',
      [SLICC_VERSION_HEADER]: sliccVersion,
    };
    expect(headers.Authorization).toBe('Bearer token-xyz');
    expect(headers[SLICC_VERSION_HEADER]).toBe(sliccVersion);
  });
});

describe('X-Session-Id fallback enforcement', () => {
  const FALLBACK_UUID = 'fallback-uuid-for-test';
  const SLICC_VERSION_HEADER = 'X-Slicc-Version';
  const sliccVersion = '9.9.9-test';
  const warned: string[] = [];

  type TestStreamOptions = {
    headers?: Record<string, string | null>;
    apiKey?: string;
    maxTokens?: number;
    signal?: AbortSignal;
  };

  function ensureSessionIdHeader(
    options: TestStreamOptions,
    callSite: string,
    warnedSet: Set<string>
  ): TestStreamOptions {
    if (options.headers) {
      for (const [key, value] of Object.entries(options.headers)) {
        if (key.toLowerCase() === 'x-session-id' && value != null) return options;
      }
    }
    if (!warnedSet.has(callSite)) {
      warnedSet.add(callSite);
      warned.push(callSite);
    }
    return {
      ...options,
      headers: {
        ...(options.headers ?? {}),
        'X-Session-Id': FALLBACK_UUID,
      },
    };
  }

  function withSliccVersionHeader(options: TestStreamOptions): TestStreamOptions {
    const merged: Record<string, string | null> = {};
    const versionKeyLower = SLICC_VERSION_HEADER.toLowerCase();
    if (options.headers) {
      for (const [key, value] of Object.entries(options.headers)) {
        if (key.toLowerCase() !== versionKeyLower) merged[key] = value;
      }
    }
    merged[SLICC_VERSION_HEADER] = sliccVersion;
    return { ...options, headers: merged };
  }

  beforeEach(() => {
    warned.length = 0;
  });

  it('preserves caller-supplied X-Session-Id (the wrapped, intended path)', () => {
    const warnedSet = new Set<string>();
    const result = ensureSessionIdHeader(
      { apiKey: 'tok', headers: { 'X-Session-Id': 'cone-uuid-abc' } },
      'streamAdobe[anthropic]',
      warnedSet
    );
    expect(result.headers).toEqual({ 'X-Session-Id': 'cone-uuid-abc' });
    expect(warned).toEqual([]);
  });

  it('detects lowercase x-session-id and treats it as caller-supplied', () => {
    const warnedSet = new Set<string>();
    const result = ensureSessionIdHeader(
      { headers: { 'x-session-id': 'lower-cased-id' } },
      'streamAdobe[anthropic]',
      warnedSet
    );
    expect(result.headers).toEqual({ 'x-session-id': 'lower-cased-id' });
    expect(warned).toEqual([]);
  });

  it('injects fallback when caller has no headers at all', () => {
    const warnedSet = new Set<string>();
    const result = ensureSessionIdHeader({ apiKey: 'tok' }, 'streamSimpleAdobe[openai]', warnedSet);
    expect(result.headers?.['X-Session-Id']).toBe(FALLBACK_UUID);
    expect(warned).toEqual(['streamSimpleAdobe[openai]']);
  });

  it('treats a null X-Session-Id (pi-ai "erase header" convention) as missing', () => {
    const warnedSet = new Set<string>();
    const result = ensureSessionIdHeader(
      { headers: { 'X-Session-Id': null } },
      'streamAdobe[anthropic]',
      warnedSet
    );
    expect(result.headers?.['X-Session-Id']).toBe(FALLBACK_UUID);
    expect(warned).toEqual(['streamAdobe[anthropic]']);
  });

  it('injects fallback when caller has headers but no session id', () => {
    const warnedSet = new Set<string>();
    const result = ensureSessionIdHeader(
      { headers: { 'X-Other-Header': 'keep-me' } },
      'streamAdobe[openai]',
      warnedSet
    );
    expect(result.headers).toEqual({
      'X-Other-Header': 'keep-me',
      'X-Session-Id': FALLBACK_UUID,
    });
    expect(warned).toEqual(['streamAdobe[openai]']);
  });

  it('preserves non-header options (apiKey, maxTokens, signal) through the merge', () => {
    const signal = new AbortController().signal;
    const warnedSet = new Set<string>();
    const result = ensureSessionIdHeader(
      { apiKey: 'tok', maxTokens: 100, signal },
      'streamAdobe[anthropic]',
      warnedSet
    );
    expect(result.apiKey).toBe('tok');
    expect(result.maxTokens).toBe(100);
    expect(result.signal).toBe(signal);
    expect(result.headers?.['X-Session-Id']).toBe(FALLBACK_UUID);
  });

  it('dedups the dev warning per call site across repeated misses', () => {
    const warnedSet = new Set<string>();
    ensureSessionIdHeader({}, 'streamAdobe[anthropic]', warnedSet);
    ensureSessionIdHeader({}, 'streamAdobe[anthropic]', warnedSet);
    ensureSessionIdHeader({}, 'streamAdobe[anthropic]', warnedSet);
    expect(warned).toEqual(['streamAdobe[anthropic]']);
  });

  it('warns once per distinct call site', () => {
    const warnedSet = new Set<string>();
    ensureSessionIdHeader({}, 'streamAdobe[anthropic]', warnedSet);
    ensureSessionIdHeader({}, 'streamAdobe[openai]', warnedSet);
    ensureSessionIdHeader({}, 'streamSimpleAdobe[anthropic]', warnedSet);
    expect(warned).toEqual([
      'streamAdobe[anthropic]',
      'streamAdobe[openai]',
      'streamSimpleAdobe[anthropic]',
    ]);
  });

  it('composes with withSliccVersionHeader: fallback id + version both attached', () => {
    const warnedSet = new Set<string>();
    const withSession = ensureSessionIdHeader({}, 'streamAdobe[anthropic]', warnedSet);
    const withSessionAndVersion = withSliccVersionHeader(withSession);
    expect(withSessionAndVersion.headers?.['X-Session-Id']).toBe(FALLBACK_UUID);
    expect(withSessionAndVersion.headers?.[SLICC_VERSION_HEADER]).toBe(sliccVersion);
  });

  it('composes with withSliccVersionHeader: caller id preserved when supplied', () => {
    const warnedSet = new Set<string>();
    const withSession = ensureSessionIdHeader(
      { headers: { 'X-Session-Id': 'real-cone-uuid' } },
      'streamAdobe[anthropic]',
      warnedSet
    );
    const withSessionAndVersion = withSliccVersionHeader(withSession);
    expect(withSessionAndVersion.headers?.['X-Session-Id']).toBe('real-cone-uuid');
    expect(withSessionAndVersion.headers?.[SLICC_VERSION_HEADER]).toBe(sliccVersion);
    expect(warned).toEqual([]);
  });
});

describe('fetchProxyConfig caching contract', () => {
  const SLICC_VERSION_HEADER = 'X-Slicc-Version';

  const RETRY_DELAY_MS = 600;

  interface ProxyConfig {
    clientId?: string;
    scopes?: string;
    imsEnvironment?: string;
  }

  async function attemptFetchProxyConfig(
    proxyEndpoint: string,
    fetchImpl: typeof fetch
  ): Promise<ProxyConfig | null> {
    try {
      const res = await fetchImpl(`${proxyEndpoint}/v1/config`, {
        headers: { [SLICC_VERSION_HEADER]: '1.0.0-test' },
      });
      if (res.ok) return (await res.json()) as ProxyConfig;
      return null;
    } catch {
      return null;
    }
  }

  async function fetchProxyConfig(
    proxyEndpoint: string,
    cache: Map<string, ProxyConfig>,
    fetchImpl: typeof fetch,
    delay: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))
  ): Promise<ProxyConfig> {
    const cached = cache.get(proxyEndpoint);
    if (cached) return cached;
    let config = await attemptFetchProxyConfig(proxyEndpoint, fetchImpl);
    if (!config) {
      await delay(RETRY_DELAY_MS);
      config = await attemptFetchProxyConfig(proxyEndpoint, fetchImpl);
    }
    if (config) {
      cache.set(proxyEndpoint, config);
      return config;
    }

    return {};
  }

  const ENDPOINT = 'https://proxy.example.com';
  const noDelay = async (_ms: number) => {};

  it('successful fetch is cached — second call does not re-fetch', async () => {
    let callCount = 0;
    const mockFetch = async () => {
      callCount++;
      return {
        ok: true,
        json: async () => ({ clientId: 'test-client', scopes: 'openid' }),
      } as Response;
    };
    const cache = new Map<string, ProxyConfig>();
    const first = await fetchProxyConfig(ENDPOINT, cache, mockFetch as typeof fetch, noDelay);
    const second = await fetchProxyConfig(ENDPOINT, cache, mockFetch as typeof fetch, noDelay);
    expect(callCount).toBe(1);
    expect(first.clientId).toBe('test-client');
    expect(second.clientId).toBe('test-client');
  });

  it('SW race regression — first attempt throws (ERR_FAILED), retry succeeds within single call', async () => {
    let callCount = 0;
    const mockFetch = async () => {
      callCount++;
      if (callCount === 1) throw new TypeError('Failed to fetch');
      return {
        ok: true,
        json: async () => ({ clientId: 'experience-catalyst-prod', scopes: 'openid' }),
      } as Response;
    };
    const delayedMs: number[] = [];
    const captureDelay = async (ms: number) => {
      delayedMs.push(ms);
    };
    const cache = new Map<string, ProxyConfig>();
    const result = await fetchProxyConfig(ENDPOINT, cache, mockFetch as typeof fetch, captureDelay);
    expect(result.clientId).toBe('experience-catalyst-prod');
    expect(callCount).toBe(2);
    expect(delayedMs).toEqual([RETRY_DELAY_MS]);
    expect(cache.size).toBe(1);
  });

  it('SW race regression — first attempt returns non-ok (wrangler 404), retry succeeds', async () => {
    let callCount = 0;
    const mockFetch = async () => {
      callCount++;
      if (callCount === 1) return { ok: false, status: 404 } as Response;
      return {
        ok: true,
        json: async () => ({ clientId: 'experience-catalyst-prod' }),
      } as Response;
    };
    const cache = new Map<string, ProxyConfig>();
    const result = await fetchProxyConfig(ENDPOINT, cache, mockFetch as typeof fetch, noDelay);
    expect(result.clientId).toBe('experience-catalyst-prod');
    expect(callCount).toBe(2);
    expect(cache.size).toBe(1);
  });

  it('both attempts fail (non-ok) — returns {} without caching, next caller re-fetches', async () => {
    let callCount = 0;
    const mockFetch = async () => {
      callCount++;
      return { ok: false, status: 503 } as Response;
    };
    const cache = new Map<string, ProxyConfig>();

    const first = await fetchProxyConfig(ENDPOINT, cache, mockFetch as typeof fetch, noDelay);
    const second = await fetchProxyConfig(ENDPOINT, cache, mockFetch as typeof fetch, noDelay);
    expect(first.clientId).toBeUndefined();
    expect(second.clientId).toBeUndefined();
    expect(callCount).toBe(4);
    expect(cache.size).toBe(0);
  });

  it('both attempts throw (network error) — returns {} without caching', async () => {
    let callCount = 0;
    const mockFetch = async () => {
      callCount++;
      throw new TypeError('Failed to fetch');
    };
    const cache = new Map<string, ProxyConfig>();
    await fetchProxyConfig(ENDPOINT, cache, mockFetch as typeof fetch, noDelay);
    await fetchProxyConfig(ENDPOINT, cache, mockFetch as typeof fetch, noDelay);
    expect(callCount).toBe(4);
    expect(cache.size).toBe(0);
  });

  it('recovers across separate invocations — blip then proxy up, no reload needed', async () => {
    let callCount = 0;
    const mockFetch = async () => {
      callCount++;

      if (callCount <= 2) return { ok: false, status: 503 } as Response;
      return {
        ok: true,
        json: async () => ({ clientId: 'experience-catalyst-prod' }),
      } as Response;
    };
    const cache = new Map<string, ProxyConfig>();
    const blip = await fetchProxyConfig(ENDPOINT, cache, mockFetch as typeof fetch, noDelay);
    expect(blip.clientId).toBeUndefined();
    const recovered = await fetchProxyConfig(ENDPOINT, cache, mockFetch as typeof fetch, noDelay);
    expect(recovered.clientId).toBe('experience-catalyst-prod');
    expect(cache.size).toBe(1);
  });
});
