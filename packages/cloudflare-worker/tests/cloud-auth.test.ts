import { describe, it, expect, beforeAll, beforeEach, vi, afterEach } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair, type KeyLike } from 'jose';
import { validateBearer, AuthError, extractBearer } from '../src/cloud/auth.js';

const ENV = {
  IMS_ENVIRONMENT: 'prod',
  IMS_CLIENT_ID: 'test-client',
  ALLOWED_EMAIL_DOMAIN: 'adobe.com',
  BLOCKED_EMAILS: '',
  REQUIRE_OWNER_ORG: 'false',
};

let privateKey: KeyLike;
let publicKey: KeyLike;
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
  // returns nothing surprising.
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
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
  // Clear call history between tests
  fetchSpy.mockClear();
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
});

describe('extractBearer', () => {
  it('throws MISSING_TOKEN for missing Authorization header', () => {
    expect(() => extractBearer(new Request('https://x/'))).toThrowError(AuthError);
    expect(() => extractBearer(new Request('https://x/'))).toThrowError(/expected Authorization/);
  });

  it('extracts Bearer token correctly', () => {
    const req = new Request('https://x/', { headers: { Authorization: 'Bearer abc123' } });
    expect(extractBearer(req)).toBe('abc123');
  });
});
