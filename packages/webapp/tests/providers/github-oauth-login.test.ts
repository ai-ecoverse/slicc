import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';

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
          oauthTokenDomains: ['github.com', '*.github.com', 'api.github.com'],
        };
      }
      return undefined;
    },
  };
});

describe('github.ts onOAuthLogin writes masked token to VFS', () => {
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

    // Mock window.location for redirect URI construction
    (globalThis as any).window = {
      location: { origin: 'http://localhost:5710', href: 'http://localhost:5710' },
      dispatchEvent: vi.fn(),
    };
    // `hasLocalDom()` in provider-settings requires BOTH window and
    // document to pick the direct-localStorage branch in
    // `saveAccountsAsync`. Without this, these page-context tests
    // would fall through to the worker panel-rpc branch and fail.
    (globalThis as any).document = {};
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    (globalThis as any).localStorage = originalLocalStorage;
    delete (globalThis as any).window;
    delete (globalThis as any).document;
  });

  it('behavioral: onOAuthLogin writes maskedValue to /workspace/.git/github-token, not the real token', async () => {
    // Mock fetch responses
    globalThis.fetch = vi.fn(async (url: any) => {
      const urlStr = String(url);

      // Runtime config — provide a client ID
      if (urlStr.includes('/api/runtime-config')) {
        return {
          ok: true,
          json: async () => ({
            oauth: { github: 'test-client-id' },
          }),
        } as any;
      }

      // Exchange code for token
      if (urlStr.includes('/oauth/token')) {
        return {
          ok: true,
          json: async () => ({
            access_token: 'ghp_REAL_must_not_leak',
            token_type: 'Bearer',
            scope: 'repo,read:user',
          }),
        } as any;
      }

      // GitHub user profile
      if (urlStr.includes('api.github.com/user')) {
        return {
          ok: true,
          json: async () => ({
            login: 'test-user',
            name: 'Test User',
            avatar_url: 'https://example.com/avatar.png',
            id: 12345,
          }),
        } as any;
      }

      // Secrets oauth-update endpoint
      if (urlStr.includes('/api/secrets/oauth-update')) {
        return {
          ok: true,
          json: async () => ({
            providerId: 'github',
            name: 'oauth.github.token',
            maskedValue: 'ghp_masked_safe',
            domains: ['github.com', '*.github.com', 'api.github.com'],
          }),
        } as any;
      }

      return { ok: false, status: 404 } as any;
    });

    // Import github provider
    const { config } = await import('../../providers/github.js');
    const { getAccounts } = await import('../../src/ui/provider-settings.js');
    const { VirtualFS } = await import('../../src/fs/index.js');
    const { GLOBAL_FS_DB_NAME } = await import('../../src/fs/global-db.js');

    // Create a fake launcher that extracts the nonce from the authorize URL
    // and returns it in the redirect URL
    const fakeLauncher = vi.fn(async (url: string) => {
      // Extract state param from the authorize URL
      const authUrl = new URL(url);
      const state = authUrl.searchParams.get('state');
      if (state) {
        const stateData = JSON.parse(atob(state));
        return `https://example.com/callback?code=fake-code&nonce=${stateData.nonce}`;
      }
      return 'https://example.com/callback?code=fake-code';
    });

    // Invoke onOAuthLogin
    let successCalled = false;
    await config.onOAuthLogin!(
      fakeLauncher,
      () => {
        successCalled = true;
      },
      undefined
    );

    expect(successCalled).toBe(true);

    // Read the token from VFS
    const fs = await VirtualFS.create({ dbName: GLOBAL_FS_DB_NAME });
    const tokenContent = await fs.readFile('/workspace/.git/github-token', { encoding: 'utf-8' });

    // Assert the masked value was written, NOT the real token
    expect(tokenContent).toBe('ghp_masked_safe');
    expect(tokenContent).not.toContain('ghp_REAL_must_not_leak');

    const account = getAccounts().find((candidate) => candidate.providerId === 'github');
    expect(account).not.toHaveProperty('refreshToken');
    expect(account).not.toHaveProperty('tokenExpiresAt');
  });

  it('writes the real token to localStorage Account but masked token to VFS', async () => {
    globalThis.fetch = vi.fn(async (url: any) => {
      const urlStr = String(url);
      if (urlStr.includes('/api/runtime-config')) {
        return {
          ok: true,
          json: async () => ({
            oauth: { github: 'test-client-id-2' },
          }),
        } as any;
      }
      if (urlStr.includes('/oauth/token')) {
        return {
          ok: true,
          json: async () => ({
            access_token: 'ghp_REAL_token_123',
            refresh_token: 'ghr_refresh_token_123',
            expires_in: 28_800,
            token_type: 'Bearer',
            scope: 'repo',
          }),
        } as any;
      }
      if (urlStr.includes('api.github.com/user')) {
        return {
          ok: true,
          json: async () => ({
            login: 'alice',
            id: 999,
          }),
        } as any;
      }
      if (urlStr.includes('/api/secrets/oauth-update')) {
        return {
          ok: true,
          json: async () => ({
            providerId: 'github',
            name: 'oauth.github.token',
            maskedValue: 'ghp_masked_xyz',
            domains: ['github.com'],
          }),
        } as any;
      }
      return { ok: false, status: 404 } as any;
    });

    const { config } = await import('../../providers/github.js');
    const { getAccounts } = await import('../../src/ui/provider-settings.js');
    const { VirtualFS } = await import('../../src/fs/index.js');
    const { GLOBAL_FS_DB_NAME } = await import('../../src/fs/global-db.js');

    const fakeLauncher = vi.fn(async (url: string) => {
      const authUrl = new URL(url);
      const state = authUrl.searchParams.get('state');
      if (state) {
        const stateData = JSON.parse(atob(state));
        return `https://x.com/callback?code=c&nonce=${stateData.nonce}`;
      }
      return 'https://x.com/callback?code=c';
    });

    const beforeLogin = Date.now();
    await config.onOAuthLogin!(fakeLauncher, () => {}, undefined);

    // Check localStorage has the real token
    const accounts = getAccounts();
    const githubAccount = accounts.find((a) => a.providerId === 'github');
    expect(githubAccount?.accessToken).toBe('ghp_REAL_token_123');
    expect(githubAccount?.refreshToken).toBe('ghr_refresh_token_123');
    expect(githubAccount?.tokenExpiresAt).toBeGreaterThanOrEqual(beforeLogin + 28_800_000);
    expect(githubAccount?.tokenExpiresAt).toBeLessThanOrEqual(Date.now() + 28_800_000);
    expect(githubAccount?.maskedValue).toBe('ghp_masked_xyz');

    // Check VFS has the masked token
    const fs = await VirtualFS.create({ dbName: GLOBAL_FS_DB_NAME });
    const vfsToken = await fs.readFile('/workspace/.git/github-token', { encoding: 'utf-8' });
    expect(vfsToken).toBe('ghp_masked_xyz');
    expect(vfsToken).not.toContain('ghp_REAL_token_123');
  });
});

describe('github.ts onOAuthLogin in worker context (no window)', () => {
  let originalFetch: typeof globalThis.fetch;
  let originalLocalStorage: Storage;
  let originalWindow: any;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalLocalStorage = globalThis.localStorage;
    originalWindow = (globalThis as any).window;

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
    // Worker realm: explicitly remove the window global so the github
    // provider must resolve page origin via panel-RPC.
    delete (globalThis as any).window;

    // Stand-in panel-RPC bridge that answers `page-info` from the
    // simulated page and forwards `save-oauth-accounts` to the
    // worker-side localStorage stub (mirroring the real page handler
    // which writes through to `window.localStorage`).
    (globalThis as any).__slicc_panelRpc = {
      call: vi.fn(async (op: string, payload?: unknown) => {
        if (op === 'page-info') {
          return {
            origin: 'http://localhost:5711',
            href: 'http://localhost:5711/?cone=1',
            title: '',
          };
        }
        if (op === 'save-oauth-accounts') {
          const { accountsJson } = payload as { accountsJson: string };
          return { storedJson: accountsJson };
        }
        throw new Error(`unexpected op ${op}`);
      }),
      dispose: () => {},
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    (globalThis as any).localStorage = originalLocalStorage;
    if (originalWindow === undefined) {
      delete (globalThis as any).window;
    } else {
      (globalThis as any).window = originalWindow;
    }
    delete (globalThis as any).__slicc_panelRpc;
  });

  it('resolves redirectUri and state port via panel-RPC instead of throwing "window is not defined"', async () => {
    let observedAuthorizeUrl = '';
    globalThis.fetch = vi.fn(async (url: any) => {
      const urlStr = String(url);
      if (urlStr.includes('/api/runtime-config')) {
        return {
          ok: true,
          json: async () => ({ oauth: { github: 'worker-client-id' } }),
        } as any;
      }
      if (urlStr.includes('/oauth/token')) {
        return {
          ok: true,
          json: async () => ({
            access_token: 'ghp_worker_token',
            token_type: 'Bearer',
            scope: 'repo',
          }),
        } as any;
      }
      if (urlStr.includes('api.github.com/user')) {
        return {
          ok: true,
          json: async () => ({ login: 'worker-user', id: 7 }),
        } as any;
      }
      if (urlStr.includes('/api/secrets/oauth-update')) {
        return {
          ok: true,
          json: async () => ({
            providerId: 'github',
            name: 'oauth.github.token',
            maskedValue: 'ghp_masked_worker',
            domains: ['github.com'],
          }),
        } as any;
      }
      return { ok: false, status: 404 } as any;
    });

    const { config } = await import('../../providers/github.js');

    const fakeLauncher = vi.fn(async (url: string) => {
      observedAuthorizeUrl = url;
      const authUrl = new URL(url);
      const state = authUrl.searchParams.get('state');
      const stateData = state ? JSON.parse(atob(state)) : null;
      return `https://x.com/callback?code=worker-code&nonce=${stateData?.nonce ?? ''}`;
    });

    // Must NOT throw "window is not defined"
    await expect(config.onOAuthLogin!(fakeLauncher, () => {}, undefined)).resolves.toBeUndefined();

    // Authorize URL must carry a state with the page port (5711) reconstructed
    // from the panel-RPC page-info response, not the default 5710.
    const auth = new URL(observedAuthorizeUrl);
    const stateRaw = auth.searchParams.get('state');
    expect(stateRaw).toBeTruthy();
    const stateData = JSON.parse(atob(stateRaw!));
    expect(stateData.port).toBe(5711);

    // redirect_uri must point at the page origin returned by panel-RPC
    expect(auth.searchParams.get('redirect_uri')).toBe('http://localhost:5711/auth/callback');
  });
});

describe('resolveClientId captures runtimeWorkerBaseUrl from runtime-config', () => {
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
    (globalThis as any).document = {};
    // Fresh module graph so the module-level `runtimeClientId` /
    // `runtimeWorkerBaseUrl` start null and `resolveClientId` actually runs.
    vi.resetModules();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    (globalThis as any).localStorage = originalLocalStorage;
    delete (globalThis as any).window;
    delete (globalThis as any).document;
  });

  it('builds redirect_uri from the runtime-config worker base, not the www.sliccy.ai fallback', async () => {
    const STAGING_WORKER = 'https://slicc-staging.example.workers.dev';

    // Worker-served thin-bridge SPA: page on :8787 carrying the bridge launch
    // param, with a local node-server bridge on :5710. `getWorkerBaseUrl()`
    // has no stored override so it returns the production default
    // (www.sliccy.ai) — the fallback we must NOT redirect to.
    (globalThis as any).window = {
      location: {
        origin: 'http://localhost:8787',
        href: 'http://localhost:8787/?bridge=ws://localhost:5710/cdp&bridgeToken=abc',
      },
      dispatchEvent: vi.fn(),
    };

    let observedAuthorizeUrl = '';
    globalThis.fetch = vi.fn(async (url: any) => {
      const urlStr = String(url);
      // Runtime config carries BOTH the client id and the worker base that
      // supplied it (staging in dev mode).
      if (urlStr.includes('/api/runtime-config')) {
        return {
          ok: true,
          json: async () => ({
            oauth: { github: 'staging-client-id' },
            trayWorkerBaseUrl: STAGING_WORKER,
          }),
        } as any;
      }
      if (urlStr.includes('/oauth/token')) {
        return {
          ok: true,
          json: async () => ({
            access_token: 'ghp_staging_token',
            token_type: 'Bearer',
            scope: 'repo',
          }),
        } as any;
      }
      if (urlStr.includes('api.github.com/user')) {
        return { ok: true, json: async () => ({ login: 'staging-user', id: 42 }) } as any;
      }
      if (urlStr.includes('/api/secrets/oauth-update')) {
        return {
          ok: true,
          json: async () => ({
            providerId: 'github',
            name: 'oauth.github.token',
            maskedValue: 'ghp_masked_staging',
            domains: ['github.com'],
          }),
        } as any;
      }
      return { ok: false, status: 404 } as any;
    });

    const { config } = await import('../../providers/github.js');
    const { setLocalApiBaseUrl } = await import('../../src/shell/proxied-fetch.js');
    // Configure the local node-server bridge so the thin-bridge branch fires.
    setLocalApiBaseUrl('http://localhost:5710');

    const fakeLauncher = vi.fn(async (url: string) => {
      observedAuthorizeUrl = url;
      const authUrl = new URL(url);
      const state = authUrl.searchParams.get('state');
      const stateData = state ? JSON.parse(atob(state)) : null;
      return `https://x.com/callback?code=staging-code&nonce=${stateData?.nonce ?? ''}`;
    });

    await config.onOAuthLogin!(fakeLauncher, () => {}, undefined);

    const auth = new URL(observedAuthorizeUrl);
    // The client id came from the local runtime-config.
    expect(auth.searchParams.get('client_id')).toBe('staging-client-id');
    // The redirect_uri must be built from the SAME worker that supplied the
    // client id (the staging relay), NOT the production www.sliccy.ai fallback.
    expect(auth.searchParams.get('redirect_uri')).toBe(`${STAGING_WORKER}/auth/callback`);
    expect(auth.searchParams.get('redirect_uri')).not.toBe('https://www.sliccy.ai/auth/callback');
  });
});

describe('resolveGithubOAuthRedirect (per-runtime redirect_uri + state)', () => {
  const base = {
    workerBaseUrl: 'https://www.sliccy.ai',
    runtimeWorkerBaseUrl: null as string | null,
    extensionId: '',
    nonce: 'n1',
  };

  it('extension → worker relay + source:extension', async () => {
    const { resolveGithubOAuthRedirect } = await import('../../providers/github.js');
    const r = resolveGithubOAuthRedirect({
      ...base,
      isExtension: true,
      isConnectMode: false,
      pageOrigin: null,
      pageHref: null,
      extensionId: 'a'.repeat(32),
    });
    expect(r.redirectUri).toBe('https://www.sliccy.ai/auth/callback');
    expect(r.state).toMatchObject({ source: 'extension', path: '/github' });
  });

  it('connect mode on localhost → registered relay + source:local with the page port', async () => {
    const { resolveGithubOAuthRedirect } = await import('../../providers/github.js');
    const r = resolveGithubOAuthRedirect({
      ...base,
      isExtension: false,
      isConnectMode: true,
      pageOrigin: 'http://localhost:8790',
      pageHref: 'http://localhost:8790/?connect=1',
    });
    // Routes through the registered relay (NOT the localhost origin), bounces back via port.
    expect(r.redirectUri).toBe('https://www.sliccy.ai/auth/callback');
    expect(r.state).toMatchObject({ source: 'local', port: 8790, path: '/auth/callback' });
  });

  it('connect mode on a deployed origin → registered relay + source:remote with origin', async () => {
    const { resolveGithubOAuthRedirect } = await import('../../providers/github.js');
    const r = resolveGithubOAuthRedirect({
      ...base,
      isExtension: false,
      isConnectMode: true,
      pageOrigin: 'https://www.sliccy.ai',
      pageHref: 'https://www.sliccy.ai/?connect=1',
    });
    expect(r.redirectUri).toBe('https://www.sliccy.ai/auth/callback');
    expect(r.state).toMatchObject({
      source: 'remote',
      origin: 'https://www.sliccy.ai',
      path: '/auth/callback',
    });
  });

  it('standalone CLI → runtimeWorkerBaseUrl relay + port bounce, no source (unchanged)', async () => {
    const { resolveGithubOAuthRedirect } = await import('../../providers/github.js');
    const r = resolveGithubOAuthRedirect({
      ...base,
      isExtension: false,
      isConnectMode: false,
      runtimeWorkerBaseUrl: 'https://www.sliccy.ai',
      pageOrigin: 'http://localhost:5710',
      pageHref: 'http://localhost:5710/',
    });
    expect(r.redirectUri).toBe('https://www.sliccy.ai/auth/callback');
    expect(r.state).toMatchObject({ port: 5710, path: '/auth/callback' });
    expect(r.state.source).toBeUndefined();
  });

  it('worker-served thin-bridge → relay + source:local with BRIDGE port (5710), not page port (8787)', async () => {
    const { resolveGithubOAuthRedirect } = await import('../../providers/github.js');
    const r = resolveGithubOAuthRedirect({
      ...base,
      isExtension: false,
      isConnectMode: false,
      runtimeWorkerBaseUrl: 'https://www.sliccy.ai',
      // Worker-served SPA on wrangler `:8787` carrying the bridge launch
      // param (`?bridge=ws://localhost:5710/cdp&bridgeToken=…`).
      pageOrigin: 'http://localhost:8787',
      pageHref: 'http://localhost:8787/?bridge=ws://localhost:5710/cdp&bridgeToken=abc',
      bridgeApiBaseUrl: 'http://localhost:5710',
    });
    expect(r.redirectUri).toBe('https://www.sliccy.ai/auth/callback');
    expect(r.state).toMatchObject({
      source: 'local',
      port: 5710,
      path: '/auth/callback',
    });
    // CRITICAL: state.port must be the bridge port (5710), NOT the page port
    // (8787). The worker relay bounces `?code` to `localhost:<port>/auth/callback`;
    // routing to :8787 hits wrangler's capture page which only postMessages the
    // opener (severed by GitHub COOP). :5710 hits node-server's callback which
    // POSTs to its same-origin loopback `/api/oauth-result`.
    expect(r.state.port).toBe(5710);
    expect(r.state.port).not.toBe(8787);
  });

  it('worker-served thin-bridge with no bridgeApiBaseUrl → falls through to legacy CLI branch', async () => {
    const { resolveGithubOAuthRedirect } = await import('../../providers/github.js');
    const r = resolveGithubOAuthRedirect({
      ...base,
      isExtension: false,
      isConnectMode: false,
      runtimeWorkerBaseUrl: 'https://www.sliccy.ai',
      pageOrigin: 'http://localhost:8787',
      pageHref: 'http://localhost:8787/?bridge=ws://localhost:5710/cdp',
      // No bridgeApiBaseUrl — should NOT take the thin-bridge branch.
      bridgeApiBaseUrl: null,
    });
    // Legacy fall-through uses the page port (8787) and the legacy state shape
    // (no `source` field).
    expect(r.state).toMatchObject({ port: 8787, path: '/auth/callback' });
    expect(r.state.source).toBeUndefined();
  });

  it('worker-served thin-bridge with a non-localhost bridgeApiBaseUrl → falls through to legacy branch', async () => {
    const { resolveGithubOAuthRedirect } = await import('../../providers/github.js');
    const r = resolveGithubOAuthRedirect({
      ...base,
      isExtension: false,
      isConnectMode: false,
      runtimeWorkerBaseUrl: 'https://www.sliccy.ai',
      pageOrigin: 'http://localhost:8787',
      pageHref: 'http://localhost:8787/?bridge=ws://localhost:5710/cdp',
      bridgeApiBaseUrl: 'https://example.com',
    });
    // The hostname guard rejects non-loopback bridges; legacy branch fires
    // with the page port.
    expect(r.state).toMatchObject({ port: 8787, path: '/auth/callback' });
    expect(r.state.source).toBeUndefined();
  });

  it('non-worker-served page with bridgeApiBaseUrl → still takes legacy CLI branch (no ?bridge param)', async () => {
    const { resolveGithubOAuthRedirect } = await import('../../providers/github.js');
    const r = resolveGithubOAuthRedirect({
      ...base,
      isExtension: false,
      isConnectMode: false,
      runtimeWorkerBaseUrl: 'https://www.sliccy.ai',
      // No `?bridge=` param → not worker-served per `isWorkerServedSpa`.
      pageOrigin: 'http://localhost:5710',
      pageHref: 'http://localhost:5710/',
      bridgeApiBaseUrl: 'http://localhost:5710',
    });
    expect(r.state).toMatchObject({ port: 5710, path: '/auth/callback' });
    expect(r.state.source).toBeUndefined();
  });
});
