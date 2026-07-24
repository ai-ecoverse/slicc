import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/providers/index.js', async () => {
  const actual = await vi.importActual('../../src/providers/index.js');
  return {
    ...actual,
    getRegisteredProviderConfig: (id: string) =>
      id === 'github'
        ? {
            id: 'github',
            name: 'GitHub',
            requiresApiKey: false,
            requiresBaseUrl: false,
            isOAuth: true,
            oauthTokenDomains: ['github.com', '*.github.com', 'api.github.com'],
          }
        : undefined,
  };
});

const ACCOUNT_KEY = 'slicc_accounts';

function seedGitHubAccount(account: Record<string, unknown>): void {
  localStorage.setItem(
    ACCOUNT_KEY,
    JSON.stringify([{ providerId: 'github', apiKey: '', ...account }])
  );
}

function createRefreshFetch(maskedValue = 'ghp_masked_new'): typeof fetch {
  return vi.fn(async (url: string | URL | Request) => {
    const urlString = String(url);
    if (urlString.includes('/oauth/token')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          access_token: 'ghp_new_access',
          refresh_token: 'ghr_rotated_refresh',
          expires_in: 28_800,
        }),
      } as Response;
    }
    if (urlString.includes('/api/secrets/oauth-update')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ maskedValue }),
      } as Response;
    }
    return { ok: false, status: 404, json: async () => ({}) } as Response;
  }) as typeof fetch;
}

describe('GitHub token renewal', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(async () => {
    vi.resetModules();
    originalFetch = globalThis.fetch;
    const data = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => data.set(key, value),
      removeItem: (key: string) => data.delete(key),
      clear: () => data.clear(),
      key: (index: number) => [...data.keys()][index] ?? null,
      get length() {
        return data.size;
      },
    });
    vi.stubGlobal('window', { dispatchEvent: vi.fn() });
    vi.stubGlobal('document', {});
    vi.stubGlobal('chrome', undefined);

    const { VirtualFS } = await import('../../src/fs/index.js');
    const { GLOBAL_FS_DB_NAME } = await import('../../src/fs/global-db.js');
    const fs = await VirtualFS.create({ dbName: GLOBAL_FS_DB_NAME });
    await fs.rm('/workspace/.git/github-token').catch(() => {});
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.unstubAllGlobals();
  });

  it('returns null without a stored refresh token and makes no request', async () => {
    seedGitHubAccount({ accessToken: 'ghp_permanent' });
    globalThis.fetch = vi.fn() as typeof fetch;
    const { config } = await import('../../providers/github.js');

    await expect(config.onSilentRenew!()).resolves.toBeNull();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('persists rotated credentials and rewrites the git-token bridge', async () => {
    seedGitHubAccount({
      accessToken: 'ghp_old_access',
      refreshToken: 'ghr_old_refresh',
      tokenExpiresAt: Date.now() - 1,
      userName: 'octocat',
      userAvatar: 'https://example.com/octocat.png',
      maskedValue: 'ghp_masked_old',
    });
    globalThis.fetch = createRefreshFetch();
    const beforeRenew = Date.now();
    const { config } = await import('../../providers/github.js');
    const { getAccounts } = await import('../../src/ui/provider-settings.js');
    const { VirtualFS } = await import('../../src/fs/index.js');
    const { GLOBAL_FS_DB_NAME } = await import('../../src/fs/global-db.js');

    await expect(config.onSilentRenew!()).resolves.toBe('ghp_new_access');

    const account = getAccounts().find((candidate) => candidate.providerId === 'github');
    expect(account).toMatchObject({
      accessToken: 'ghp_new_access',
      refreshToken: 'ghr_rotated_refresh',
      userName: 'octocat',
      maskedValue: 'ghp_masked_new',
    });
    expect(account?.tokenExpiresAt).toBeGreaterThanOrEqual(beforeRenew + 28_800_000);
    expect(account?.tokenExpiresAt).toBeLessThanOrEqual(Date.now() + 28_800_000);

    const tokenRequest = vi
      .mocked(globalThis.fetch)
      .mock.calls.find(([url]) => String(url).includes('/oauth/token'));
    expect(JSON.parse(String(tokenRequest?.[1]?.body))).toEqual({
      provider: 'github',
      refresh_token: 'ghr_old_refresh',
    });

    const fs = await VirtualFS.create({ dbName: GLOBAL_FS_DB_NAME });
    await expect(fs.readFile('/workspace/.git/github-token', { encoding: 'utf-8' })).resolves.toBe(
      'ghp_masked_new'
    );
  });

  it('clears a stale git-token bridge when the refreshed account has no masked value', async () => {
    seedGitHubAccount({
      accessToken: 'ghp_old_access',
      refreshToken: 'ghr_old_refresh',
      tokenExpiresAt: Date.now() - 1,
      maskedValue: 'ghp_masked_old',
    });
    globalThis.fetch = createRefreshFetch('');
    const { VirtualFS } = await import('../../src/fs/index.js');
    const { GLOBAL_FS_DB_NAME } = await import('../../src/fs/global-db.js');
    const fs = await VirtualFS.create({ dbName: GLOBAL_FS_DB_NAME });
    await fs.writeFile('/workspace/.git/github-token', 'ghp_masked_old');
    const { config } = await import('../../providers/github.js');

    await expect(config.onSilentRenew!()).resolves.toBe('ghp_new_access');
    await expect(
      fs.readFile('/workspace/.git/github-token', { encoding: 'utf-8' })
    ).rejects.toThrow();
  });

  it('returns null when the refresh request fails', async () => {
    seedGitHubAccount({
      accessToken: 'ghp_old_access',
      refreshToken: 'ghr_old_refresh',
      tokenExpiresAt: Date.now() - 1,
    });
    globalThis.fetch = vi.fn(async () => {
      throw new Error('network unavailable');
    }) as typeof fetch;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { config } = await import('../../providers/github.js');

    await expect(config.onSilentRenew!()).resolves.toBeNull();
    expect(warn).toHaveBeenCalledWith('[github] Silent renewal failed:', 'network unavailable');
    warn.mockRestore();
  });

  it('returns permanent and fresh access tokens without renewal', async () => {
    globalThis.fetch = vi.fn() as typeof fetch;
    const { getValidAccessToken } = await import('../../providers/github.js');

    seedGitHubAccount({ accessToken: 'ghp_permanent' });
    await expect(getValidAccessToken()).resolves.toBe('ghp_permanent');

    seedGitHubAccount({
      accessToken: 'ghp_fresh',
      refreshToken: 'ghr_fresh',
      tokenExpiresAt: Date.now() + 3_600_000,
    });
    await expect(getValidAccessToken()).resolves.toBe('ghp_fresh');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('transparently renews an expiring access token', async () => {
    seedGitHubAccount({
      accessToken: 'ghp_expiring',
      refreshToken: 'ghr_old_refresh',
      tokenExpiresAt: Date.now() + 30_000,
    });
    globalThis.fetch = createRefreshFetch();
    const { getValidAccessToken } = await import('../../providers/github.js');

    await expect(getValidAccessToken()).resolves.toBe('ghp_new_access');
  });
});
