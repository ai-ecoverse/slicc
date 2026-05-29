import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import { config } from '../../providers/openai-codex.js';

describe('openai-codex provider config', () => {
  it('is an OAuth provider with codex token domains', () => {
    expect(config.id).toBe('openai-codex');
    expect(config.isOAuth).toBe(true);
    expect(config.requiresApiKey).toBe(false);
    expect(config.onOAuthLoginIntercepted).toBeTypeOf('function');
    expect(config.oauthTokenDomains).toContain('chatgpt.com');
    expect(config.oauthTokenDomains).toContain('auth.openai.com');
  });

  it('exposes the codex model catalog tagged for the openai api', () => {
    const models = config.getModelIds!();
    const ids = models.map((m) => m.id);
    expect(ids).toContain('gpt-5.3-codex');
    expect(ids).toContain('gpt-5.5');
    expect(models.length).toBe(6);
    for (const m of models) {
      // api: 'openai' → provider-settings rewrites to `openai-codex-openai`
      expect(m.api).toBe('openai');
      expect(m.reasoning).toBe(true);
      expect((m as { thinkingLevelMap?: Record<string, string> }).thinkingLevelMap).toEqual({
        xhigh: 'xhigh',
        minimal: 'low',
      });
    }
    expect(config.defaultModelId).toBe('gpt-5.5');
  });
});

describe('openai-codex onOAuthLoginIntercepted', () => {
  let originalFetch: typeof globalThis.fetch;
  let originalLocalStorage: Storage;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalLocalStorage = globalThis.localStorage;
    const lsData: Record<string, string> = {};
    (globalThis as unknown as { localStorage: Storage }).localStorage = {
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
      key: () => null,
      length: 0,
    } as unknown as Storage;
    delete (globalThis as { chrome?: unknown }).chrome;
    // page context: saveAccountsAsync writes localStorage directly when
    // both window and document exist.
    (globalThis as { window?: unknown }).window = {
      location: { origin: 'http://localhost:5710', href: 'http://localhost:5710' },
      dispatchEvent: vi.fn(),
    };
    (globalThis as { document?: unknown }).document = {};
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    (globalThis as unknown as { localStorage: Storage }).localStorage = originalLocalStorage;
    delete (globalThis as { window?: unknown }).window;
    delete (globalThis as { document?: unknown }).document;
  });

  it('builds a PKCE codex authorize URL, exchanges the code, and saves the account', async () => {
    // Fake JWT access token carrying account id, plan, and profile email.
    // Encoded as real base64url (RFC 7515): the `_marker` field forces a
    // `+` and `/` into the standard base64, which become `-`/`_` here — so
    // this exercises decodeJwtPayload's base64url handling (plain `atob`
    // would throw on these characters).
    const jwtPayload = btoa(
      JSON.stringify({
        'https://api.openai.com/auth': {
          chatgpt_account_id: 'acct_test_123',
          chatgpt_plan_type: 'team',
        },
        'https://api.openai.com/profile': { email: 'dev@example.com' },
        _marker: '>>>???',
      })
    )
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    expect(jwtPayload).toMatch(/[-_]/);
    const accessToken = `header.${jwtPayload}.sig`;

    let tokenBody: URLSearchParams | undefined;
    globalThis.fetch = vi.fn(async (url: unknown, init?: unknown) => {
      const urlStr = String(url);
      if (urlStr === 'https://auth.openai.com/oauth/token') {
        tokenBody = new URLSearchParams(String((init as { body?: unknown })?.body));
        return {
          ok: true,
          json: async () => ({
            access_token: accessToken,
            refresh_token: 'codex_refresh_abc',
            expires_in: 3600,
            token_type: 'Bearer',
          }),
        } as unknown as Response;
      }
      return { ok: false, status: 404, text: async () => 'nope' } as unknown as Response;
    }) as typeof globalThis.fetch;

    let capturedAuthorizeUrl = '';
    const fakeLauncher = vi.fn(
      async (cfg: { authorizeUrl: string; redirectUriPattern: string }) => {
        capturedAuthorizeUrl = cfg.authorizeUrl;
        expect(cfg.redirectUriPattern).toBe('http://localhost:1455/auth/callback*');
        const authUrl = new URL(cfg.authorizeUrl);
        const state = authUrl.searchParams.get('state');
        return `http://localhost:1455/auth/callback?code=fake-code&state=${state}`;
      }
    );

    let successCalled = false;
    await config.onOAuthLoginIntercepted!(
      fakeLauncher,
      () => {
        successCalled = true;
      },
      undefined
    );

    expect(successCalled).toBe(true);

    // Authorize URL carries the codex-CLI PKCE params.
    const auth = new URL(capturedAuthorizeUrl);
    expect(auth.origin + auth.pathname).toBe('https://auth.openai.com/oauth/authorize');
    expect(auth.searchParams.get('client_id')).toBe('app_EMoamEEZ73f0CkXaXp7hrann');
    expect(auth.searchParams.get('redirect_uri')).toBe('http://localhost:1455/auth/callback');
    expect(auth.searchParams.get('code_challenge_method')).toBe('S256');
    expect(auth.searchParams.get('code_challenge')).toBeTruthy();
    expect(auth.searchParams.get('codex_cli_simplified_flow')).toBe('true');
    expect(auth.searchParams.get('id_token_add_organizations')).toBe('true');

    // Token exchange used the captured code + the matching verifier.
    expect(tokenBody?.get('grant_type')).toBe('authorization_code');
    expect(tokenBody?.get('code')).toBe('fake-code');
    expect(tokenBody?.get('client_id')).toBe('app_EMoamEEZ73f0CkXaXp7hrann');
    expect(tokenBody?.get('code_verifier')).toBeTruthy();

    // Account persisted with the real token.
    const { getAccounts } = await import('../../src/ui/provider-settings.js');
    const account = getAccounts().find((a) => a.providerId === 'openai-codex');
    expect(account?.accessToken).toBe(accessToken);
    expect(account?.refreshToken).toBe('codex_refresh_abc');
    expect(account?.userName).toBe('dev@example.com (Team)');
    // Profile picture: Gravatar keyed by the SHA-256 of the verified
    // email, with d=404 so accounts without a Gravatar fall back to
    // initials.
    const emailSha256 = 'eb2b6c0d061bbd5caa545b6d1184a1887b11dba0b1d7fd8ca5b42ebf0ad7d3a8';
    expect(account?.userAvatar).toBe(`https://www.gravatar.com/avatar/${emailSha256}?s=128&d=404`);
  });

  it('throws on OAuth state mismatch', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('token endpoint must not be called on state mismatch');
    }) as typeof globalThis.fetch;

    const fakeLauncher = vi.fn(
      async () => `http://localhost:1455/auth/callback?code=c&state=WRONG_STATE`
    );

    await expect(
      config.onOAuthLoginIntercepted!(fakeLauncher, () => {}, undefined)
    ).rejects.toThrow(/state mismatch/i);
  });

  it('throws when the OAuth callback omits state entirely (strict CSRF binding)', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('token endpoint must not be called when state is missing');
    }) as typeof globalThis.fetch;

    // Callback with a code but no `state` — must be rejected exactly like a
    // mismatch, not silently accepted.
    const fakeLauncher = vi.fn(async () => `http://localhost:1455/auth/callback?code=c`);

    await expect(
      config.onOAuthLoginIntercepted!(fakeLauncher, () => {}, undefined)
    ).rejects.toThrow(/state mismatch/i);
  });
});
