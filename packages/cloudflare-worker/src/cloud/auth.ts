import { createRemoteJWKSet, errors, jwtVerify } from 'jose';
import { getProxyConfig } from './proxy-config.js';

const JWKS_URLS: Record<string, string> = {
  prod: 'https://ims-na1.adobelogin.com/ims/keys',
  stg1: 'https://ims-na1-stg1.adobelogin.com/ims/keys',
};

const IMS_HOSTS: Record<string, string> = {
  prod: 'https://ims-na1.adobelogin.com',
  stg1: 'https://ims-na1-stg1.adobelogin.com',
};

const jwksSets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export function getJWKS(environment: string): ReturnType<typeof createRemoteJWKSet> {
  const env = environment || 'prod';
  let jwks = jwksSets.get(env);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(JWKS_URLS[env] || JWKS_URLS.prod!));
    jwksSets.set(env, jwks);
  }
  return jwks;
}

export function getImsHost(environment: string): string {
  return IMS_HOSTS[environment] || IMS_HOSTS.prod!;
}

export interface AuthResult {
  userId: string;
  email: string;
  userName: string;
  ownerOrg?: string;
  /** Token exp claim (Unix seconds). Used by the auth cache to cap TTL at
   * min(10min, tokenExp - now). Surfaced from JWT validation. */
  tokenExp?: number;
}

export class AuthError extends Error {
  constructor(
    public readonly code:
      | 'MISSING_TOKEN'
      | 'INVALID_TOKEN'
      | 'NOT_ALLOWED'
      | 'UPSTREAM_UNAVAILABLE',
    message: string
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

interface IMSProfile {
  email?: string;
  displayName?: string;
  name?: string;
  ownerOrg?: string;
}

async function fetchImsProfile(token: string, environment: string): Promise<IMSProfile> {
  let res: Response;
  try {
    res = await fetch(`${getImsHost(environment)}/ims/profile/v1`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch (err) {
    throw new AuthError(
      'UPSTREAM_UNAVAILABLE',
      `IMS profile fetch error: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (res.status >= 500) {
    throw new AuthError('UPSTREAM_UNAVAILABLE', `IMS profile returned ${res.status}`);
  }
  if (!res.ok) {
    throw new AuthError('INVALID_TOKEN', `IMS profile rejected token: ${res.status}`);
  }
  try {
    return (await res.json()) as IMSProfile;
  } catch (_err) {
    throw new AuthError('UPSTREAM_UNAVAILABLE', 'IMS profile returned non-JSON body');
  }
}

export function extractBearer(request: Request): string {
  const header = request.headers.get('Authorization');
  if (!header?.startsWith('Bearer ')) {
    throw new AuthError('MISSING_TOKEN', 'expected Authorization: Bearer <ims-access-token>');
  }
  return header.slice(7);
}

interface JWTPayload {
  iss?: string;
  sub?: string;
  user_id?: string;
  client_id?: string;
  type?: string;
  email?: string;
  ownerOrg?: string;
  given_name?: string;
  family_name?: string;
  exp?: number;
}

export interface ValidateBearerEnv {
  ADOBE_PROXY_ENDPOINT?: string;
  ALLOWED_EMAIL_DOMAIN: string;
  BLOCKED_EMAILS: string;
  REQUIRE_OWNER_ORG: string;
}

export async function validateBearer(token: string, env: ValidateBearerEnv): Promise<AuthResult> {
  const proxyConfig = await getProxyConfig(env);
  const environment = proxyConfig.imsEnvironment || 'prod';
  const expectedIssuer = getImsHost(environment);
  const jwks = getJWKS(environment);

  let payload: JWTPayload;
  try {
    const { payload: p } = await jwtVerify(token, jwks);
    payload = p as JWTPayload;
  } catch (err) {
    // Discriminate upstream failures (JWKS fetch issues) from token validity issues.
    // JWKS errors → 503 UPSTREAM_UNAVAILABLE (transient, retry later).
    // Token errors → 401 INVALID_TOKEN (client must re-authenticate).
    if (
      err instanceof errors.JWKSTimeout ||
      err instanceof errors.JWKSNoMatchingKey ||
      err instanceof errors.JWKSInvalid ||
      err instanceof errors.JWKSMultipleMatchingKeys
    ) {
      throw new AuthError(
        'UPSTREAM_UNAVAILABLE',
        `JWKS service unavailable: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    // Check for fetch errors from jose's createRemoteJWKSet (network issues).
    const msg = err instanceof Error ? err.message : String(err);
    if (/fetch failed|network|ECONNREFUSED|ETIMEDOUT/i.test(msg)) {
      throw new AuthError('UPSTREAM_UNAVAILABLE', `IMS JWKS unreachable: ${msg}`);
    }
    // Token validity errors → INVALID_TOKEN.
    throw new AuthError('INVALID_TOKEN', `JWT verification failed: ${msg}`);
  }

  if (payload.iss && payload.iss !== expectedIssuer) {
    throw new AuthError('INVALID_TOKEN', `issuer mismatch: ${payload.iss}`);
  }
  if (payload.client_id !== proxyConfig.clientId) {
    throw new AuthError('INVALID_TOKEN', `client_id mismatch: ${payload.client_id}`);
  }
  if (payload.type !== 'access_token') {
    throw new AuthError('INVALID_TOKEN', `token type is not access_token: ${payload.type}`);
  }

  let email = payload.email;
  let ownerOrg = payload.ownerOrg;
  let userName = '';
  if (!email || (env.REQUIRE_OWNER_ORG === 'true' && !ownerOrg)) {
    const profile = await fetchImsProfile(token, environment);
    email = email || profile.email;
    ownerOrg = ownerOrg || profile.ownerOrg;
    userName = profile.displayName || profile.name || '';
  }
  if (!email) throw new AuthError('INVALID_TOKEN', 'no email in token or profile');
  if (env.REQUIRE_OWNER_ORG === 'true' && !ownerOrg) {
    throw new AuthError('NOT_ALLOWED', `no ownerOrg for ${email}`);
  }

  const allowedDomains = (env.ALLOWED_EMAIL_DOMAIN || 'adobe.com').split(',').map((d) => d.trim());
  if (!allowedDomains.includes('*')) {
    const emailDomain = email.split('@')[1]?.toLowerCase();
    if (!emailDomain || !allowedDomains.includes(emailDomain)) {
      throw new AuthError('NOT_ALLOWED', `email domain not allowed: ${email}`);
    }
  }

  const blocked = (env.BLOCKED_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  if (blocked.includes(email.toLowerCase())) {
    throw new AuthError('NOT_ALLOWED', `email access denied: ${email}`);
  }

  if (!userName) {
    const given = payload.given_name ?? '';
    const family = payload.family_name ?? '';
    userName = [given, family].filter(Boolean).join(' ') || email;
  }

  return {
    userId: (payload.sub ?? payload.user_id ?? email) as string,
    email,
    userName,
    ownerOrg,
    tokenExp: payload.exp,
  };
}
