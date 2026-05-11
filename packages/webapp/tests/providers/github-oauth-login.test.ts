import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    (globalThis as any).localStorage = originalLocalStorage;
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

    await config.onOAuthLogin!(fakeLauncher, () => {}, undefined);

    // Check localStorage has the real token
    const accounts = getAccounts();
    const githubAccount = accounts.find((a) => a.providerId === 'github');
    expect(githubAccount?.accessToken).toBe('ghp_REAL_token_123');
    expect(githubAccount?.maskedValue).toBe('ghp_masked_xyz');

    // Check VFS has the masked token
    const fs = await VirtualFS.create({ dbName: GLOBAL_FS_DB_NAME });
    const vfsToken = await fs.readFile('/workspace/.git/github-token', { encoding: 'utf-8' });
    expect(vfsToken).toBe('ghp_masked_xyz');
    expect(vfsToken).not.toContain('ghp_REAL_token_123');
  });
});
