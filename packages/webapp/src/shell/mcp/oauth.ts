import { createLogger } from '../../base/logger.js';
import { deriveCodeChallenge, generateCodeVerifier, randomState } from '../../providers/pkce.js';

const log = createLogger('mcp-oauth');

export interface ProtectedResourceMetadata {
  resource?: string;
  authorization_servers?: string[];
  scopes_supported?: string[];
}

export interface AuthorizationServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  scopes_supported?: string[];
  code_challenge_methods_supported?: string[];
  grant_types_supported?: string[];
}

export interface DiscoveredAuth {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  supportedScopes?: string[];
  codeChallengeMethods?: string[];
  grantTypes?: string[];
  issuer: string;

  discoveryPath?: 'prm' | 'asm-origin-fallback';
}

export interface DynamicRegistrationResult {
  clientId: string;
  registrationClientUri?: string;
}

export interface TokenResponse {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  scope?: string;
  tokenType?: string;
}

export type FetchLike = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string }
) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  text(): Promise<string>;
  json(): Promise<unknown>;
  headers?: { get(name: string): string | null };
}>;

interface DiscoveryValidationContext {
  discoveryPath: 'prm' | 'asm-origin-fallback';
  prmUrl: string;
  prmReason: string | null;
  asmUrl: string;
  asmReason: string | null;
}

function assertValidAuthorizationServerMetadata(
  asm: AuthorizationServerMetadata | null,
  context: DiscoveryValidationContext
): asserts asm is AuthorizationServerMetadata {
  const { discoveryPath, prmUrl, prmReason, asmUrl, asmReason } = context;
  if (!asm) {
    if (discoveryPath === 'asm-origin-fallback') {
      throw new Error(
        `MCP OAuth discovery failed. ` +
          `PRM (${prmUrl}): ${prmReason}. ` +
          `ASM fallback (${asmUrl}): ${asmReason}.`
      );
    }
    throw new Error(`ASM fetch failed: ${asmReason} (${asmUrl})`);
  }
  if (asm.authorization_endpoint && asm.token_endpoint) return;
  if (discoveryPath === 'asm-origin-fallback') {
    throw new Error(
      `MCP OAuth discovery failed. ` +
        `PRM (${prmUrl}): ${prmReason}. ` +
        `ASM fallback (${asmUrl}) is missing required endpoints ` +
        `(authorization_endpoint, token_endpoint).`
    );
  }
  throw new Error(`ASM at ${asmUrl} is missing required endpoints`);
}

export async function discoverAuth(
  serverUrl: string,
  resourceMetadataUrl: string | undefined,
  fetchImpl: FetchLike
): Promise<DiscoveredAuth> {
  const serverOrigin = new URL(serverUrl).origin;
  const prmUrl = resourceMetadataUrl ?? `${serverOrigin}/.well-known/oauth-protected-resource`;

  let prm: ProtectedResourceMetadata | null = null;
  let prmReason: string | null = null;
  log.debug('Fetching PRM', { prmUrl });
  try {
    const prmRes = await fetchImpl(prmUrl, { headers: { Accept: 'application/json' } });
    if (!prmRes.ok) {
      prmReason = `${prmRes.status} ${prmRes.statusText}`;
    } else {
      const body = (await prmRes.json()) as ProtectedResourceMetadata;
      if (!body.authorization_servers || body.authorization_servers.length === 0) {
        prmReason = 'lists no authorization_servers';
      } else {
        prm = body;
      }
    }
  } catch (err) {
    prmReason = err instanceof Error ? err.message : String(err);
  }

  let asBase: string;
  let asmUrl: string;
  let discoveryPath: 'prm' | 'asm-origin-fallback';
  if (prm?.authorization_servers && prm.authorization_servers.length > 0) {
    asBase = prm.authorization_servers[0].replace(/\/+$/, '');
    asmUrl = `${asBase}/.well-known/oauth-authorization-server`;
    discoveryPath = 'prm';
    log.debug('Discovery via PRM', { prmUrl, asmUrl });
  } else {
    asBase = serverOrigin;
    asmUrl = `${serverOrigin}/.well-known/oauth-authorization-server`;
    discoveryPath = 'asm-origin-fallback';
    log.debug('PRM unavailable; falling back to ASM at server origin', {
      prmUrl,
      prmReason,
      asmUrl,
    });
  }

  let asm: AuthorizationServerMetadata | null = null;
  let asmReason: string | null = null;
  log.debug('Fetching ASM', { asmUrl });
  try {
    const asmRes = await fetchImpl(asmUrl, { headers: { Accept: 'application/json' } });
    if (!asmRes.ok) {
      asmReason = `${asmRes.status} ${asmRes.statusText}`;
    } else {
      asm = (await asmRes.json()) as AuthorizationServerMetadata;
    }
  } catch (err) {
    asmReason = err instanceof Error ? err.message : String(err);
  }

  assertValidAuthorizationServerMetadata(asm, {
    discoveryPath,
    prmUrl,
    prmReason,
    asmUrl,
    asmReason,
  });
  return {
    issuer: asm.issuer || asBase,
    authorizationEndpoint: asm.authorization_endpoint,
    tokenEndpoint: asm.token_endpoint,
    registrationEndpoint: asm.registration_endpoint,
    supportedScopes: asm.scopes_supported ?? prm?.scopes_supported,
    codeChallengeMethods: asm.code_challenge_methods_supported,
    grantTypes: asm.grant_types_supported,
    discoveryPath,
  };
}

export async function dynamicRegister(
  asMetadata: DiscoveredAuth,
  redirectUri: string,
  fetchImpl: FetchLike
): Promise<DynamicRegistrationResult> {
  if (!asMetadata.registrationEndpoint) {
    throw new Error('Authorization server does not advertise a registration_endpoint (RFC 7591)');
  }

  const supportedGrants = asMetadata.grantTypes;
  const grantTypes =
    supportedGrants && supportedGrants.length > 0 && !supportedGrants.includes('refresh_token')
      ? ['authorization_code']
      : ['authorization_code', 'refresh_token'];
  const body = JSON.stringify({
    client_name: 'SLICC',
    redirect_uris: [redirectUri],
    token_endpoint_auth_method: 'none',
    grant_types: grantTypes,
    response_types: ['code'],
  });
  const res = await fetchImpl(asMetadata.registrationEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body,
  });
  if (!res.ok) {
    throw new Error(`DCR failed: ${res.status} ${res.statusText}`);
  }
  const reg = (await res.json()) as { client_id?: string; registration_client_uri?: string };
  if (!reg.client_id) throw new Error('DCR response missing client_id');
  return { clientId: reg.client_id, registrationClientUri: reg.registration_client_uri };
}

export interface PkcePair {
  codeVerifier: string;
  codeChallenge: string;
  method: 'S256' | 'plain';
}

export function pickPkceMethod(supported: string[] | undefined): 'S256' | 'plain' {
  if (!supported || supported.length === 0) return 'S256';
  if (supported.includes('S256')) return 'S256';
  if (supported.includes('plain')) return 'plain';
  return 'S256';
}

export async function generatePkce(method: 'S256' | 'plain'): Promise<PkcePair> {
  const codeVerifier = generateCodeVerifier();
  if (method === 'plain') {
    return { codeVerifier, codeChallenge: codeVerifier, method };
  }
  return { codeVerifier, codeChallenge: await deriveCodeChallenge(codeVerifier), method };
}

export interface RunAuthFlowOptions {
  asMetadata: DiscoveredAuth;
  clientId: string;
  redirectUri: string;
  scope?: string;

  launcher: (authorizeUrl: string) => Promise<string | null>;
  fetchImpl: FetchLike;
}

export function extractCodeFromUrl(url: string): { code: string | null; state: string | null } {
  try {
    const parsed = new URL(url);
    return {
      code: parsed.searchParams.get('code'),
      state: parsed.searchParams.get('state'),
    };
  } catch {
    return { code: null, state: null };
  }
}

export async function runAuthFlow(opts: RunAuthFlowOptions): Promise<TokenResponse> {
  const method = pickPkceMethod(opts.asMetadata.codeChallengeMethods);
  const pkce = await generatePkce(method);
  const state = randomState();
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    code_challenge: pkce.codeChallenge,
    code_challenge_method: pkce.method,
    state,
  });
  if (opts.scope) params.set('scope', opts.scope);
  const authorizeUrl = `${opts.asMetadata.authorizationEndpoint}?${params.toString()}`;

  const redirectUrl = await opts.launcher(authorizeUrl);
  if (!redirectUrl) throw new Error('MCP OAuth flow cancelled or timed out');
  const { code, state: returnedState } = extractCodeFromUrl(redirectUrl);
  if (!code) throw new Error('MCP OAuth redirect missing `code` parameter');

  if (returnedState !== state) {
    throw new Error('MCP OAuth state mismatch — possible CSRF');
  }
  return exchangeCode({
    tokenEndpoint: opts.asMetadata.tokenEndpoint,
    clientId: opts.clientId,
    code,
    codeVerifier: pkce.codeVerifier,
    redirectUri: opts.redirectUri,
    fetchImpl: opts.fetchImpl,
  });
}

interface RawTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
}

function parseTokenResponse(raw: RawTokenResponse): TokenResponse {
  if (raw.error || !raw.access_token) {
    throw new Error(
      `Token endpoint error: ${raw.error ?? 'no_access_token'}${raw.error_description ? ` — ${raw.error_description}` : ''}`
    );
  }
  return {
    accessToken: raw.access_token,
    refreshToken: raw.refresh_token,
    expiresAt: raw.expires_in ? Date.now() + raw.expires_in * 1000 : undefined,
    scope: raw.scope,
    tokenType: raw.token_type,
  };
}

export interface ExchangeCodeOptions {
  tokenEndpoint: string;
  clientId: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
  fetchImpl: FetchLike;
}

export async function exchangeCode(opts: ExchangeCodeOptions): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: opts.code,
    redirect_uri: opts.redirectUri,
    client_id: opts.clientId,
    code_verifier: opts.codeVerifier,
  }).toString();
  const res = await opts.fetchImpl(opts.tokenEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body,
  });
  const raw = (await res.json()) as RawTokenResponse;
  if (!res.ok && !raw.access_token) {
    throw new Error(
      `Token exchange failed: ${res.status} ${res.statusText}${raw.error ? ` (${raw.error})` : ''}`
    );
  }
  return parseTokenResponse(raw);
}

export interface RefreshTokenOptions {
  tokenEndpoint: string;
  clientId: string;
  refreshToken: string;
  scope?: string;
  fetchImpl: FetchLike;
}

export async function refreshAccessToken(opts: RefreshTokenOptions): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: opts.refreshToken,
    client_id: opts.clientId,
  });
  if (opts.scope) body.set('scope', opts.scope);
  const res = await opts.fetchImpl(opts.tokenEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: body.toString(),
  });
  const raw = (await res.json()) as RawTokenResponse;
  if (!res.ok && !raw.access_token) {
    throw new Error(
      `Token refresh failed: ${res.status} ${res.statusText}${raw.error ? ` (${raw.error})` : ''}`
    );
  }
  return parseTokenResponse(raw);
}
