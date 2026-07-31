import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGetAccounts, mockGetOAuthAccountInfo, mockSaveOAuthAccount } = vi.hoisted(() => ({
  mockGetAccounts: vi.fn(),
  mockGetOAuthAccountInfo: vi.fn(),
  mockSaveOAuthAccount: vi.fn(),
}));

vi.mock('../../../src/providers/account-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/providers/account-store.js')>();
  return {
    ...actual,
    getAccounts: mockGetAccounts,
    getOAuthAccountInfo: mockGetOAuthAccountInfo,
    saveOAuthAccount: mockSaveOAuthAccount,
  };
});

vi.mock('../../../src/providers/oauth-service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/providers/oauth-service.js')>();
  return {
    ...actual,
    getOAuthPageOrigin: async () => ({
      origin: 'http://localhost:5710',
      href: 'http://localhost:5710/',
    }),
  };
});

import {
  getRegisteredProviderConfig,
  unregisterProviderConfig,
} from '../../../src/providers/index.js';
import type { FetchLike } from '../../../src/shell/mcp/oauth.js';
import {
  ensureMcpProviderRegistered,
  mcpProviderId,
  registerMcpProvider,
  removeMcpProvider,
  testOnlyResetMcpProviderState,
} from '../../../src/shell/mcp/provider.js';
import {
  testOnlyResetStoreCache,
  testOnlySetFsModule,
} from '../../../src/shell/mcp/provider-store-access.js';

// ── Stub fs module ─────────────────────────────────────────────────
//
// `provider-store-access` reads `/workspace/.mcp/servers.json` through a
// `VirtualFS.create(...).readFile(...)` chain. We inject a minimal stub
// instead of standing up a real LightningFS/IndexedDB instance so the
// idempotence test stays a pure unit test.

function makeFakeFsModule(storeJson: string | null) {
  const fakeFs = {
    readFile: async (path: string) => {
      if (path !== '/workspace/.mcp/servers.json' || storeJson === null) {
        throw new Error('ENOENT');
      }
      return storeJson;
    },
  };
  return {
    VirtualFS: {
      create: async () => fakeFs,
    },
  } as unknown as typeof import('../../../src/fs/index.js');
}

const SERVERS_JSON = JSON.stringify({
  version: 1,
  servers: {
    weather: {
      url: 'https://mcp.weather.example.com',
      auth: {
        providerId: 'mcp:weather',
        authorizationServer: 'https://auth.weather.example.com',
        clientId: 'client-abc',
        scope: 'read',
      },
    },
  },
});

function makeOAuthFetch(scopes: { login?: string; refresh?: string } = {}): FetchLike {
  return async (url, init) => {
    const json = (body: unknown) => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => JSON.stringify(body),
      json: async () => body,
      headers: { get: () => null },
    });
    if (url.includes('/.well-known/oauth-protected-resource')) {
      return json({ authorization_servers: ['https://auth.synth.example.com'] });
    }
    if (url.includes('/.well-known/oauth-authorization-server')) {
      return json({
        issuer: 'https://auth.synth.example.com',
        authorization_endpoint: 'https://auth.synth.example.com/authorize',
        token_endpoint: 'https://auth.synth.example.com/token',
        grant_types_supported: ['authorization_code', 'refresh_token'],
      });
    }
    if (url === 'https://auth.synth.example.com/token') {
      const grantType = new URLSearchParams(init?.body ?? '').get('grant_type');
      const scope = grantType === 'refresh_token' ? scopes.refresh : scopes.login;
      return json({
        access_token: grantType === 'refresh_token' ? 'rotated-token' : 'login-token',
        refresh_token: grantType === 'refresh_token' ? 'rotated-refresh' : 'login-refresh',
        expires_in: 3600,
        ...(scope === undefined ? {} : { scope }),
      });
    }
    throw new Error(`Unexpected OAuth request: ${url}`);
  };
}

const oauthLauncher = async (authorizeUrl: string): Promise<string> => {
  const url = new URL(authorizeUrl);
  return `http://localhost:5710/auth/callback?code=test-code&state=${url.searchParams.get('state')}`;
};

describe('ensureMcpProviderRegistered', () => {
  let hadIndexedDB = false;
  let originalIndexedDB: unknown;

  beforeEach(() => {
    testOnlyResetMcpProviderState();
    testOnlyResetStoreCache();
    // Drop any registry entry left over from a previous test run.
    unregisterProviderConfig(mcpProviderId('weather'));
    // The guard in `ensureMcpProviderRegistered` short-circuits when
    // `globalThis.indexedDB` is missing. These tests stub the FS module
    // directly, so we mark IDB as "present" with a sentinel to take the
    // FS-reading path.
    hadIndexedDB = 'indexedDB' in globalThis;
    originalIndexedDB = (globalThis as any).indexedDB;
    (globalThis as any).indexedDB = {};
  });

  afterEach(() => {
    testOnlySetFsModule(null);
    testOnlyResetMcpProviderState();
    unregisterProviderConfig(mcpProviderId('weather'));
    if (hadIndexedDB) {
      (globalThis as any).indexedDB = originalIndexedDB;
    } else {
      delete (globalThis as any).indexedDB;
    }
  });

  it('registers the provider on first call and is a no-op on subsequent calls', async () => {
    testOnlySetFsModule(makeFakeFsModule(SERVERS_JSON));

    const first = await ensureMcpProviderRegistered('weather');
    expect(first).toBe(true);
    const cfgFirst = getRegisteredProviderConfig(mcpProviderId('weather'));
    expect(cfgFirst).toBeDefined();
    expect(cfgFirst?.id).toBe('mcp:weather');
    expect(cfgFirst?.isOAuth).toBe(true);

    const second = await ensureMcpProviderRegistered('weather');
    expect(second).toBe(true);
    const cfgSecond = getRegisteredProviderConfig(mcpProviderId('weather'));
    // Same reference — the in-session cache short-circuits before
    // `buildProviderConfig` runs again.
    expect(cfgSecond).toBe(cfgFirst);
  });

  it('returns false when the server has no persisted auth entry', async () => {
    testOnlySetFsModule(makeFakeFsModule(null));
    const ok = await ensureMcpProviderRegistered('weather');
    expect(ok).toBe(false);
    expect(getRegisteredProviderConfig(mcpProviderId('weather'))).toBeUndefined();
  });

  it('re-registers after removeMcpProvider clears the session cache', async () => {
    testOnlySetFsModule(makeFakeFsModule(SERVERS_JSON));

    await ensureMcpProviderRegistered('weather');
    expect(getRegisteredProviderConfig(mcpProviderId('weather'))).toBeDefined();

    const removed = removeMcpProvider('weather');
    expect(removed).toBe(true);
    expect(getRegisteredProviderConfig(mcpProviderId('weather'))).toBeUndefined();

    const reRegistered = await ensureMcpProviderRegistered('weather');
    expect(reRegistered).toBe(true);
    expect(getRegisteredProviderConfig(mcpProviderId('weather'))).toBeDefined();
  });
});

describe('registerMcpProvider', () => {
  beforeEach(() => {
    testOnlyResetMcpProviderState();
    unregisterProviderConfig(mcpProviderId('synthetic'));
    mockGetAccounts.mockReset().mockReturnValue([]);
    mockGetOAuthAccountInfo.mockReset().mockReturnValue(null);
    mockSaveOAuthAccount.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    testOnlyResetMcpProviderState();
    unregisterProviderConfig(mcpProviderId('synthetic'));
  });

  it('is idempotent — second call leaves the registry entry unchanged', () => {
    registerMcpProvider({
      name: 'synthetic',
      serverUrl: 'https://mcp.synth.example.com',
      auth: {
        providerId: 'mcp:synthetic',
        authorizationServer: 'https://auth.synth.example.com',
        clientId: 'c1',
      },
    });
    const first = getRegisteredProviderConfig(mcpProviderId('synthetic'));
    expect(first).toBeDefined();

    registerMcpProvider({
      name: 'synthetic',
      serverUrl: 'https://mcp.synth.example.com',
      auth: {
        providerId: 'mcp:synthetic',
        authorizationServer: 'https://auth.synth.example.com',
        clientId: 'c1',
      },
    });
    const second = getRegisteredProviderConfig(mcpProviderId('synthetic'));
    expect(second).toBe(first);
  });

  it('persists only the scope reported by the token endpoint on login', async () => {
    registerMcpProvider({
      name: 'synthetic',
      serverUrl: 'https://mcp.synth.example.com',
      auth: {
        providerId: 'mcp:synthetic',
        authorizationServer: 'https://auth.synth.example.com',
        clientId: 'c1',
        scope: 'requested:wide',
      },
      fetchImpl: makeOAuthFetch({ login: 'granted:read' }),
      launcher: oauthLauncher,
    });

    const config = getRegisteredProviderConfig(mcpProviderId('synthetic'));
    await config?.onOAuthLogin?.(oauthLauncher, vi.fn());

    expect(mockSaveOAuthAccount).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: 'mcp:synthetic',
        accessToken: 'login-token',
        scopes: 'granted:read',
      })
    );
  });

  it('persists an unknown scope when the token endpoint omits it', async () => {
    registerMcpProvider({
      name: 'synthetic',
      serverUrl: 'https://mcp.synth.example.com',
      auth: {
        providerId: 'mcp:synthetic',
        authorizationServer: 'https://auth.synth.example.com',
        clientId: 'c1',
        scope: 'requested:wide',
      },
      fetchImpl: makeOAuthFetch(),
      launcher: oauthLauncher,
    });

    const config = getRegisteredProviderConfig(mcpProviderId('synthetic'));
    await config?.onOAuthLogin?.(oauthLauncher, vi.fn());

    const saved = mockSaveOAuthAccount.mock.calls[0]?.[0];
    expect(saved).toHaveProperty('scopes', undefined);
  });

  it.each([
    ['uses the refreshed grant when reported', 'rotated:read', 'rotated:read'],
    ['preserves the stored grant when refresh omits scope', undefined, 'stored:read'],
  ])('%s', async (_label, refreshScope, expectedScope) => {
    mockGetOAuthAccountInfo.mockReturnValue({ token: 'old-token', expired: true });
    mockGetAccounts.mockReturnValue([
      {
        providerId: 'mcp:synthetic',
        apiKey: '',
        accessToken: 'old-token',
        refreshToken: 'old-refresh',
        scopes: 'stored:read',
      },
    ]);
    registerMcpProvider({
      name: 'synthetic',
      serverUrl: 'https://mcp.synth.example.com',
      auth: {
        providerId: 'mcp:synthetic',
        authorizationServer: 'https://auth.synth.example.com',
        clientId: 'c1',
        scope: 'requested:wide',
      },
      fetchImpl: makeOAuthFetch({ refresh: refreshScope }),
    });

    const config = getRegisteredProviderConfig(mcpProviderId('synthetic'));
    await expect(config?.onSilentRenew?.()).resolves.toBe('rotated-token');
    expect(mockSaveOAuthAccount).toHaveBeenCalledWith(
      expect.objectContaining({ scopes: expectedScope })
    );
  });
});
