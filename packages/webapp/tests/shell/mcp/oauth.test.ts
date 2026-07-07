import { describe, expect, it, vi } from 'vitest';
import {
  discoverAuth,
  dynamicRegister,
  exchangeCode,
  extractCodeFromUrl,
  type FetchLike,
  generatePkce,
  pickPkceMethod,
  refreshAccessToken,
  runAuthFlow,
} from '../../../src/shell/mcp/oauth.js';

// ── Test helpers ────────────────────────────────────────────────────

function jsonResponse(status: number, body: unknown): Awaited<ReturnType<FetchLike>> {
  const text = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Err',
    text: async () => text,
    json: async () => body,
    headers: { get: () => null },
  };
}

function makeFetchStub(
  handlers: Array<{ matchUrl: string | RegExp; handler: (url: string, init?: any) => any }>
): FetchLike {
  const calls: Array<{ url: string; init?: any }> = [];
  const fn: FetchLike = async (url, init) => {
    calls.push({ url, init });
    for (const h of handlers) {
      const m = typeof h.matchUrl === 'string' ? url === h.matchUrl : h.matchUrl.test(url);
      if (m) return h.handler(url, init);
    }
    throw new Error(`Unexpected fetch ${url}`);
  };
  (fn as any).calls = calls;
  return fn;
}

// ── Discovery ───────────────────────────────────────────────────────

describe('discoverAuth', () => {
  it('fetches PRM then ASM and returns normalized endpoints', async () => {
    const fetchImpl = makeFetchStub([
      {
        matchUrl: 'https://mcp.example.com/.well-known/oauth-protected-resource',
        handler: () =>
          jsonResponse(200, {
            resource: 'https://mcp.example.com',
            authorization_servers: ['https://auth.example.com/'],
          }),
      },
      {
        matchUrl: 'https://auth.example.com/.well-known/oauth-authorization-server',
        handler: () =>
          jsonResponse(200, {
            issuer: 'https://auth.example.com',
            authorization_endpoint: 'https://auth.example.com/authorize',
            token_endpoint: 'https://auth.example.com/token',
            registration_endpoint: 'https://auth.example.com/register',
            code_challenge_methods_supported: ['S256'],
            grant_types_supported: ['authorization_code', 'refresh_token'],
          }),
      },
    ]);
    const meta = await discoverAuth('https://mcp.example.com/some/path', undefined, fetchImpl);
    expect(meta.authorizationEndpoint).toBe('https://auth.example.com/authorize');
    expect(meta.tokenEndpoint).toBe('https://auth.example.com/token');
    expect(meta.registrationEndpoint).toBe('https://auth.example.com/register');
    expect(meta.codeChallengeMethods).toEqual(['S256']);
    expect(meta.grantTypes).toContain('refresh_token');
    expect(meta.discoveryPath).toBe('prm');
  });

  it('uses an explicit resourceMetadataUrl when provided', async () => {
    const fetchImpl = makeFetchStub([
      {
        matchUrl: 'https://other.example.com/.well-known/oauth-protected-resource',
        handler: () => jsonResponse(200, { authorization_servers: ['https://auth.example.com'] }),
      },
      {
        matchUrl: /authorization-server$/,
        handler: () =>
          jsonResponse(200, {
            issuer: 'https://auth.example.com',
            authorization_endpoint: 'https://auth.example.com/authorize',
            token_endpoint: 'https://auth.example.com/token',
          }),
      },
    ]);
    const meta = await discoverAuth(
      'https://mcp.example.com',
      'https://other.example.com/.well-known/oauth-protected-resource',
      fetchImpl
    );
    expect(meta.tokenEndpoint).toBe('https://auth.example.com/token');
    expect(meta.discoveryPath).toBe('prm');
  });

  it('falls back to ASM at server origin when PRM 404s', async () => {
    const fetchImpl = makeFetchStub([
      {
        matchUrl: 'https://mcp.example.com/.well-known/oauth-protected-resource',
        handler: () => jsonResponse(404, { error: 'not_found' }),
      },
      {
        matchUrl: 'https://mcp.example.com/.well-known/oauth-authorization-server',
        handler: () =>
          jsonResponse(200, {
            issuer: 'https://mcp.example.com',
            authorization_endpoint: 'https://mcp.example.com/authorize',
            token_endpoint: 'https://mcp.example.com/token',
            registration_endpoint: 'https://mcp.example.com/register',
            code_challenge_methods_supported: ['S256'],
          }),
      },
    ]);
    const meta = await discoverAuth('https://mcp.example.com/mcp', undefined, fetchImpl);
    expect(meta.discoveryPath).toBe('asm-origin-fallback');
    expect(meta.issuer).toBe('https://mcp.example.com');
    expect(meta.authorizationEndpoint).toBe('https://mcp.example.com/authorize');
    expect(meta.tokenEndpoint).toBe('https://mcp.example.com/token');
    expect(meta.registrationEndpoint).toBe('https://mcp.example.com/register');
  });

  it('falls back when PRM is 200 but lists no authorization_servers', async () => {
    const fetchImpl = makeFetchStub([
      {
        matchUrl: 'https://mcp.example.com/.well-known/oauth-protected-resource',
        handler: () => jsonResponse(200, { resource: 'https://mcp.example.com' }),
      },
      {
        matchUrl: 'https://mcp.example.com/.well-known/oauth-authorization-server',
        handler: () =>
          jsonResponse(200, {
            issuer: 'https://mcp.example.com',
            authorization_endpoint: 'https://mcp.example.com/authorize',
            token_endpoint: 'https://mcp.example.com/token',
          }),
      },
    ]);
    const meta = await discoverAuth('https://mcp.example.com', undefined, fetchImpl);
    expect(meta.discoveryPath).toBe('asm-origin-fallback');
    expect(meta.tokenEndpoint).toBe('https://mcp.example.com/token');
  });

  it('throws with both URLs in the message when PRM and ASM-at-origin both 404', async () => {
    const fetchImpl = makeFetchStub([
      {
        matchUrl: 'https://mcp.example.com/.well-known/oauth-protected-resource',
        handler: () => jsonResponse(404, { error: 'not_found' }),
      },
      {
        matchUrl: 'https://mcp.example.com/.well-known/oauth-authorization-server',
        handler: () => jsonResponse(404, { error: 'not_found' }),
      },
    ]);
    const err = (await discoverAuth('https://mcp.example.com', undefined, fetchImpl).catch(
      (e: unknown) => e
    )) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain('https://mcp.example.com/.well-known/oauth-protected-resource');
    expect(err.message).toContain('https://mcp.example.com/.well-known/oauth-authorization-server');
    expect(err.message).toContain('404');
  });

  it('throws clearly when ASM-at-origin fallback is missing required endpoints', async () => {
    const fetchImpl = makeFetchStub([
      {
        matchUrl: 'https://mcp.example.com/.well-known/oauth-protected-resource',
        handler: () => jsonResponse(404, { error: 'not_found' }),
      },
      {
        matchUrl: 'https://mcp.example.com/.well-known/oauth-authorization-server',
        handler: () => jsonResponse(200, { issuer: 'https://mcp.example.com' }),
      },
    ]);
    const err = (await discoverAuth('https://mcp.example.com', undefined, fetchImpl).catch(
      (e: unknown) => e
    )) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain('missing required endpoints');
    expect(err.message).toContain('https://mcp.example.com/.well-known/oauth-authorization-server');
    expect(err.message).toContain('https://mcp.example.com/.well-known/oauth-protected-resource');
  });
});

// ── DCR ─────────────────────────────────────────────────────────────

describe('dynamicRegister', () => {
  it('POSTs the expected body and returns clientId + registrationClientUri', async () => {
    let captured: any = null;
    const fetchImpl = makeFetchStub([
      {
        matchUrl: 'https://auth.example.com/register',
        handler: (_url, init) => {
          captured = init;
          return jsonResponse(201, {
            client_id: 'abc-123',
            registration_client_uri: 'https://auth.example.com/register/abc-123',
          });
        },
      },
    ]);
    const asMeta = {
      issuer: 'https://auth.example.com',
      authorizationEndpoint: 'https://auth.example.com/authorize',
      tokenEndpoint: 'https://auth.example.com/token',
      registrationEndpoint: 'https://auth.example.com/register',
    };
    const result = await dynamicRegister(asMeta, 'http://127.0.0.1:5710/cb', fetchImpl);
    expect(result.clientId).toBe('abc-123');
    expect(result.registrationClientUri).toBe('https://auth.example.com/register/abc-123');
    const body = JSON.parse(captured.body);
    expect(body.client_name).toBe('SLICC');
    expect(body.redirect_uris).toEqual(['http://127.0.0.1:5710/cb']);
    expect(body.token_endpoint_auth_method).toBe('none');
    expect(body.grant_types).toEqual(['authorization_code', 'refresh_token']);
  });

  it('throws when registration_endpoint is missing', async () => {
    const fetchImpl = makeFetchStub([]);
    await expect(
      dynamicRegister(
        {
          issuer: 'x',
          authorizationEndpoint: 'x',
          tokenEndpoint: 'x',
        },
        'http://127.0.0.1/cb',
        fetchImpl
      )
    ).rejects.toThrow(/registration_endpoint/);
  });

  it('omits refresh_token from grant_types when AS metadata excludes it', async () => {
    let captured: any = null;
    const fetchImpl = makeFetchStub([
      {
        matchUrl: 'https://auth.example.com/register',
        handler: (_url, init) => {
          captured = init;
          return jsonResponse(201, { client_id: 'abc-123' });
        },
      },
    ]);
    await dynamicRegister(
      {
        issuer: 'https://auth.example.com',
        authorizationEndpoint: 'https://auth.example.com/authorize',
        tokenEndpoint: 'https://auth.example.com/token',
        registrationEndpoint: 'https://auth.example.com/register',
        grantTypes: ['authorization_code'],
      },
      'http://127.0.0.1/cb',
      fetchImpl
    );
    const body = JSON.parse(captured.body);
    expect(body.grant_types).toEqual(['authorization_code']);
  });

  it('keeps refresh_token when AS metadata is absent (no grant_types_supported)', async () => {
    let captured: any = null;
    const fetchImpl = makeFetchStub([
      {
        matchUrl: 'https://auth.example.com/register',
        handler: (_url, init) => {
          captured = init;
          return jsonResponse(201, { client_id: 'abc-123' });
        },
      },
    ]);
    await dynamicRegister(
      {
        issuer: 'https://auth.example.com',
        authorizationEndpoint: 'https://auth.example.com/authorize',
        tokenEndpoint: 'https://auth.example.com/token',
        registrationEndpoint: 'https://auth.example.com/register',
      },
      'http://127.0.0.1/cb',
      fetchImpl
    );
    const body = JSON.parse(captured.body);
    expect(body.grant_types).toEqual(['authorization_code', 'refresh_token']);
  });

  it('keeps refresh_token when AS advertises it explicitly', async () => {
    let captured: any = null;
    const fetchImpl = makeFetchStub([
      {
        matchUrl: 'https://auth.example.com/register',
        handler: (_url, init) => {
          captured = init;
          return jsonResponse(201, { client_id: 'abc-123' });
        },
      },
    ]);
    await dynamicRegister(
      {
        issuer: 'https://auth.example.com',
        authorizationEndpoint: 'https://auth.example.com/authorize',
        tokenEndpoint: 'https://auth.example.com/token',
        registrationEndpoint: 'https://auth.example.com/register',
        grantTypes: ['authorization_code', 'refresh_token'],
      },
      'http://127.0.0.1/cb',
      fetchImpl
    );
    const body = JSON.parse(captured.body);
    expect(body.grant_types).toEqual(['authorization_code', 'refresh_token']);
  });
});

// ── PKCE ────────────────────────────────────────────────────────────

describe('PKCE selection + generation', () => {
  it('prefers S256 when supported list is undefined', () => {
    expect(pickPkceMethod(undefined)).toBe('S256');
  });
  it('prefers S256 when both are listed', () => {
    expect(pickPkceMethod(['plain', 'S256'])).toBe('S256');
  });
  it('falls back to plain when only plain is listed', () => {
    expect(pickPkceMethod(['plain'])).toBe('plain');
  });

  it('generates a base64url-safe verifier and SHA-256 challenge for S256', async () => {
    const pkce = await generatePkce('S256');
    expect(pkce.method).toBe('S256');
    expect(pkce.codeVerifier).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(pkce.codeChallenge).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(pkce.codeChallenge).not.toBe(pkce.codeVerifier);
  });

  it('returns verifier === challenge for the plain method', async () => {
    const pkce = await generatePkce('plain');
    expect(pkce.method).toBe('plain');
    expect(pkce.codeChallenge).toBe(pkce.codeVerifier);
  });
});

// ── extractCodeFromUrl ──────────────────────────────────────────────

describe('extractCodeFromUrl', () => {
  it('parses code + state from a redirect URL', () => {
    expect(extractCodeFromUrl('http://127.0.0.1:5710/cb?code=abc&state=xyz')).toEqual({
      code: 'abc',
      state: 'xyz',
    });
  });
  it('returns nulls for an unparseable URL', () => {
    expect(extractCodeFromUrl('not a url')).toEqual({ code: null, state: null });
  });
});

// ── exchangeCode ────────────────────────────────────────────────────

describe('exchangeCode', () => {
  it('returns token + computed expiresAt on success', async () => {
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const fetchImpl = makeFetchStub([
      {
        matchUrl: 'https://auth.example.com/token',
        handler: () =>
          jsonResponse(200, {
            access_token: 'AT-1',
            refresh_token: 'RT-1',
            expires_in: 3600,
            scope: 'read',
            token_type: 'Bearer',
          }),
      },
    ]);
    const t = await exchangeCode({
      tokenEndpoint: 'https://auth.example.com/token',
      clientId: 'cid',
      code: 'CODE',
      codeVerifier: 'VER',
      redirectUri: 'http://127.0.0.1/cb',
      fetchImpl,
    });
    expect(t.accessToken).toBe('AT-1');
    expect(t.refreshToken).toBe('RT-1');
    expect(t.expiresAt).toBe(now + 3600_000);
    expect(t.scope).toBe('read');
    vi.restoreAllMocks();
  });

  it('throws when the AS returns an OAuth error body', async () => {
    const fetchImpl = makeFetchStub([
      {
        matchUrl: 'https://auth.example.com/token',
        handler: () => jsonResponse(400, { error: 'invalid_grant', error_description: 'bad code' }),
      },
    ]);
    await expect(
      exchangeCode({
        tokenEndpoint: 'https://auth.example.com/token',
        clientId: 'cid',
        code: 'CODE',
        codeVerifier: 'VER',
        redirectUri: 'http://127.0.0.1/cb',
        fetchImpl,
      })
    ).rejects.toThrow(/invalid_grant/);
  });
});

// ── refreshAccessToken ──────────────────────────────────────────────

describe('refreshAccessToken', () => {
  it('posts a refresh_token grant and returns a rotated token', async () => {
    let captured: any = null;
    const fetchImpl = makeFetchStub([
      {
        matchUrl: 'https://auth.example.com/token',
        handler: (_url, init) => {
          captured = init;
          return jsonResponse(200, {
            access_token: 'AT-2',
            refresh_token: 'RT-2',
            expires_in: 60,
          });
        },
      },
    ]);
    const t = await refreshAccessToken({
      tokenEndpoint: 'https://auth.example.com/token',
      clientId: 'cid',
      refreshToken: 'RT-1',
      scope: 'read write',
      fetchImpl,
    });
    expect(t.accessToken).toBe('AT-2');
    expect(t.refreshToken).toBe('RT-2');
    expect(captured.body).toContain('grant_type=refresh_token');
    expect(captured.body).toContain('refresh_token=RT-1');
    expect(captured.body).toContain('scope=read+write');
  });

  it('propagates token endpoint errors', async () => {
    const fetchImpl = makeFetchStub([
      {
        matchUrl: 'https://auth.example.com/token',
        handler: () => jsonResponse(400, { error: 'invalid_grant' }),
      },
    ]);
    await expect(
      refreshAccessToken({
        tokenEndpoint: 'https://auth.example.com/token',
        clientId: 'cid',
        refreshToken: 'RT-stale',
        fetchImpl,
      })
    ).rejects.toThrow(/invalid_grant/);
  });
});

// ── runAuthFlow ─────────────────────────────────────────────────────

describe('runAuthFlow', () => {
  const asMeta = {
    issuer: 'https://auth.example.com',
    authorizationEndpoint: 'https://auth.example.com/authorize',
    tokenEndpoint: 'https://auth.example.com/token',
    codeChallengeMethods: ['S256'],
  };

  it('runs the full PKCE flow end-to-end and returns the access token', async () => {
    let capturedAuthorizeUrl = '';
    let capturedTokenBody = '';
    const fetchImpl = makeFetchStub([
      {
        matchUrl: 'https://auth.example.com/token',
        handler: (_url, init) => {
          capturedTokenBody = init.body;
          return jsonResponse(200, { access_token: 'AT-flow', expires_in: 10 });
        },
      },
    ]);
    const launcher = async (url: string) => {
      capturedAuthorizeUrl = url;
      const state = new URL(url).searchParams.get('state');
      return `http://127.0.0.1:5710/cb?code=THE_CODE&state=${state}`;
    };
    const t = await runAuthFlow({
      asMetadata: asMeta,
      clientId: 'cid',
      redirectUri: 'http://127.0.0.1:5710/cb',
      scope: 'read',
      launcher,
      fetchImpl,
    });
    expect(t.accessToken).toBe('AT-flow');
    const u = new URL(capturedAuthorizeUrl);
    expect(u.searchParams.get('response_type')).toBe('code');
    expect(u.searchParams.get('client_id')).toBe('cid');
    expect(u.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:5710/cb');
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(u.searchParams.get('scope')).toBe('read');
    expect(capturedTokenBody).toContain('grant_type=authorization_code');
    expect(capturedTokenBody).toContain('code=THE_CODE');
  });

  it('rejects when the launcher returns null (cancelled)', async () => {
    const fetchImpl = makeFetchStub([]);
    await expect(
      runAuthFlow({
        asMetadata: asMeta,
        clientId: 'cid',
        redirectUri: 'http://127.0.0.1/cb',
        launcher: async () => null,
        fetchImpl,
      })
    ).rejects.toThrow(/cancelled|timed out/);
  });

  it('rejects on state mismatch (CSRF guard)', async () => {
    const fetchImpl = makeFetchStub([]);
    await expect(
      runAuthFlow({
        asMetadata: asMeta,
        clientId: 'cid',
        redirectUri: 'http://127.0.0.1/cb',
        launcher: async () => 'http://127.0.0.1/cb?code=X&state=WRONG',
        fetchImpl,
      })
    ).rejects.toThrow(/state mismatch/);
  });

  it('rejects when state is missing from the callback (CSRF guard)', async () => {
    // We always send a `state` on the authorize request, so a callback
    // that omits it must be rejected as a CSRF signal — not silently
    // proceed to token exchange.
    const fetchImpl = makeFetchStub([]);
    await expect(
      runAuthFlow({
        asMetadata: asMeta,
        clientId: 'cid',
        redirectUri: 'http://127.0.0.1/cb',
        launcher: async () => 'http://127.0.0.1/cb?code=X',
        fetchImpl,
      })
    ).rejects.toThrow(/state mismatch/);
  });

  it('rejects when the redirect URL is missing a code', async () => {
    const fetchImpl = makeFetchStub([]);
    await expect(
      runAuthFlow({
        asMetadata: asMeta,
        clientId: 'cid',
        redirectUri: 'http://127.0.0.1/cb',
        launcher: async () => 'http://127.0.0.1/cb?error=access_denied',
        fetchImpl,
      })
    ).rejects.toThrow(/missing `code`/);
  });
});
