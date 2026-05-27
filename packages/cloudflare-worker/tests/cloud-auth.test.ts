import { describe, it, expect, beforeAll, vi, afterEach } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair, type CryptoKey } from 'jose';
import { validateBearer, AuthError, extractBearer } from '../src/cloud/auth.js';
import { clearProxyConfigCache } from '../src/cloud/proxy-config.js';

const ENV = {
  ADOBE_PROXY_ENDPOINT: 'https://proxy.test',
  ALLOWED_EMAIL_DOMAIN: 'adobe.com',
  BLOCKED_EMAILS: '',
  REQUIRE_OWNER_ORG: 'false',
};

let privateKey: CryptoKey;
let publicKey: CryptoKey;
let kid: string;
let fetchSpy: ReturnType<typeof vi.spyOn>;

async function makeToken(claims: Record<string, unknown>): Promise<string> {
  return await new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid })
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(privateKey);
}

beforeAll(async () => {
  // Generate keypair once for all tests to avoid JWKS cache issues
  const kp = await generateKeyPair('RS256');
  privateKey = kp.privateKey;
  publicKey = kp.publicKey;
  const jwk = await exportJWK(publicKey);
  kid = 'test-kid';
  jwk.kid = kid;
  jwk.alg = 'RS256';
  jwk.use = 'sig';

  // Stub global fetch so jose's createRemoteJWKSet returns our key + IMS profile
  // returns nothing surprising. Must also mock proxy /v1/config.
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes('/v1/config')) {
      return new Response(
        JSON.stringify({
          clientId: 'test-client',
          scopes: 'openid',
          imsEnvironment: 'prod',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (url.includes('/ims/keys')) {
      return new Response(JSON.stringify({ keys: [jwk] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.includes('/ims/profile/v1')) {
      return new Response(JSON.stringify({ email: 'test@adobe.com', displayName: 'Test' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
});

afterEach(() => {
  // Clear call history between tests and flush proxy config cache
  fetchSpy.mockClear();
  clearProxyConfigCache();
});

describe('validateBearer', () => {
  it('accepts a well-formed Adobe token', async () => {
    const token = await makeToken({
      iss: 'https://ims-na1.adobelogin.com',
      sub: 'usr-1',
      client_id: 'test-client',
      type: 'access_token',
      email: 'test@adobe.com',
      given_name: 'Test',
      family_name: 'User',
    });
    const result = await validateBearer(token, ENV);
    expect(result.userId).toBe('usr-1');
    expect(result.email).toBe('test@adobe.com');
    expect(result.userName).toBe('Test User');
    expect(result.tokenExp).toBeGreaterThan(0);
  });

  it('rejects a token with non-adobe.com email', async () => {
    const token = await makeToken({
      iss: 'https://ims-na1.adobelogin.com',
      sub: 'usr-2',
      client_id: 'test-client',
      type: 'access_token',
      email: 'evil@example.com',
    });
    await expect(validateBearer(token, ENV)).rejects.toMatchObject({
      name: 'AuthError',
      code: 'NOT_ALLOWED',
    });
  });

  it('rejects a denylisted email', async () => {
    const token = await makeToken({
      iss: 'https://ims-na1.adobelogin.com',
      sub: 'usr-3',
      client_id: 'test-client',
      type: 'access_token',
      email: 'banned@adobe.com',
    });
    await expect(
      validateBearer(token, { ...ENV, BLOCKED_EMAILS: 'banned@adobe.com' })
    ).rejects.toMatchObject({ code: 'NOT_ALLOWED' });
  });

  it('rejects a token without ownerOrg when REQUIRE_OWNER_ORG=true', async () => {
    const token = await makeToken({
      iss: 'https://ims-na1.adobelogin.com',
      sub: 'usr-4',
      client_id: 'test-client',
      type: 'access_token',
      email: 'test@adobe.com',
    });
    // Profile mock returns no ownerOrg either.
    await expect(
      validateBearer(token, { ...ENV, REQUIRE_OWNER_ORG: 'true' })
    ).rejects.toMatchObject({ code: 'NOT_ALLOWED' });
  });

  it('rejects a token with wrong client_id', async () => {
    const token = await makeToken({
      iss: 'https://ims-na1.adobelogin.com',
      sub: 'usr-5',
      client_id: 'OTHER-client',
      type: 'access_token',
      email: 'test@adobe.com',
    });
    await expect(validateBearer(token, ENV)).rejects.toMatchObject({ code: 'INVALID_TOKEN' });
  });

  it('throws UPSTREAM_UNAVAILABLE when JWKS fetch fails', async () => {
    // Clear proxy config cache to force a fresh fetch
    clearProxyConfigCache();

    // Mock fetch to fail for the IMS keys URL. The JWKS cache from earlier
    // tests has already cached keys, so we need to use a *different*
    // environment to force jose to make a new JWKS fetch that will fail.
    fetchSpy.mockImplementation(async (input: RequestInfo | URL) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('/v1/config')) {
        return new Response(
          JSON.stringify({
            clientId: 'test-client',
            scopes: 'openid',
            imsEnvironment: 'stg1', // <-- different env to bypass JWKS cache
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      if (url.includes('/ims/keys')) {
        throw new Error('network error: ECONNREFUSED');
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    // Token for stg1 environment (different issuer)
    const token = await makeToken({
      iss: 'https://ims-na1-stg1.adobelogin.com',
      sub: 'usr-6',
      client_id: 'test-client',
      type: 'access_token',
      email: 'test@adobe.com',
    });

    await expect(validateBearer(token, ENV)).rejects.toMatchObject({
      name: 'AuthError',
      code: 'UPSTREAM_UNAVAILABLE',
    });
  });
});

describe('extractBearer', () => {
  it('throws MISSING_TOKEN for missing Authorization header', () => {
    expect(() => extractBearer(new Request('https://x/'))).toThrow(AuthError);
    expect(() => extractBearer(new Request('https://x/'))).toThrow(/expected Authorization/);
  });

  it('extracts Bearer token correctly', () => {
    const req = new Request('https://x/', { headers: { Authorization: 'Bearer abc123' } });
    expect(extractBearer(req)).toBe('abc123');
  });
});

describe('authenticateRequest (middleware)', () => {
  it('maps UPSTREAM_UNAVAILABLE to 503', async () => {
    // Clear proxy config cache to force a fresh fetch with a new environment
    clearProxyConfigCache();

    // Mock fetch to fail JWKS for a stg1 token (bypass cached prod JWKS)
    fetchSpy.mockImplementation(async (input: RequestInfo | URL) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('/v1/config')) {
        return new Response(
          JSON.stringify({
            clientId: 'test-client',
            scopes: 'openid',
            imsEnvironment: 'stg1',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      if (url.includes('/ims/keys')) {
        throw new Error('network error: ECONNREFUSED');
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const token = await makeToken({
      iss: 'https://ims-na1-stg1.adobelogin.com',
      sub: 'usr-upstream',
      client_id: 'test-client',
      type: 'access_token',
      email: 'test@adobe.com',
    });

    const { authenticateRequest } = await import('../src/cloud/auth-middleware.js');
    const req = new Request('https://x/', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const result = await authenticateRequest(req, ENV);

    // Should be a Response, not AuthResult
    expect(result).toBeInstanceOf(Response);
    const res = result as Response;
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).toMatchObject({ error: 'UPSTREAM_UNAVAILABLE' });
  });
});
