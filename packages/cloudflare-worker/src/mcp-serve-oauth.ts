import { sha256Hex } from '@slicc/shared-ts';
import type {
  McpOAuthClient,
  McpOAuthCode,
  McpOAuthPending,
  McpOAuthToken,
  McpServeRecord,
} from './shared.js';
import { timingSafeEqual } from './timing-safe-equal.js';

export interface McpHttpResult {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface ConsentChallenge {
  pendingId: string;
  generation: number;
  clientName: string;
  redirectUri: string;
}

const ACCESS_TTL_S = 60 * 60;
const REFRESH_TTL_S = 30 * 24 * 60 * 60;
const CODE_TTL_MS = 60_000;
const PENDING_TTL_MS = 10 * 60_000;
const MAX_CLIENTS = 50;
const MAX_TOKENS = 50;
const JSON_TYPE = 'application/json; charset=utf-8';

export function unauthorized(resourceOrigin: string): McpHttpResult {
  const metadata = `${resourceOrigin}/.well-known/oauth-protected-resource`;
  return json(
    401,
    { error: 'unauthorized' },
    { 'www-authenticate': `Bearer resource_metadata="${metadata}", scope="mcp"` }
  );
}

export function protectedResourceMetadata(resourceOrigin: string): McpHttpResult {
  return json(200, {
    resource: `${resourceOrigin}/mcp`,
    authorization_servers: [resourceOrigin],
    bearer_methods_supported: ['header'],
    scopes_supported: ['mcp'],
  });
}

export function authorizationServerMetadata(resourceOrigin: string): McpHttpResult {
  return json(200, {
    issuer: resourceOrigin,
    authorization_endpoint: `${resourceOrigin}/oauth/authorize`,
    token_endpoint: `${resourceOrigin}/oauth/token`,
    registration_endpoint: `${resourceOrigin}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: ['mcp'],
  });
}

export function registerClient(serve: McpServeRecord, body: string, nowIso: string): McpHttpResult {
  const parsed = readRegistration(body);
  if (parsed.error)
    return json(400, { error: 'invalid_client_metadata', error_description: parsed.error });
  if (serve.clients.length >= MAX_CLIENTS) {
    return json(400, { error: 'invalid_client_metadata', error_description: 'too many clients' });
  }
  const client: McpOAuthClient = {
    clientId: crypto.randomUUID(),
    clientName: parsed.clientName || 'MCP client',
    redirectUris: parsed.redirectUris,
    registeredAt: nowIso,
  };
  serve.clients.push(client);
  return json(201, {
    client_id: client.clientId,
    client_name: client.clientName,
    redirect_uris: client.redirectUris,
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
  });
}

export function beginAuthorization(
  serve: McpServeRecord,
  search: string,
  now: number
): { error: McpHttpResult } | { challenge: ConsentChallenge } {
  prune(serve, now);
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const client = serve.clients.find((item) => item.clientId === params.get('client_id'));
  const redirectUri = params.get('redirect_uri') ?? '';
  if (!client?.redirectUris.includes(redirectUri)) {
    return {
      error: json(400, {
        error: 'invalid_request',
        error_description: 'unknown client or redirect_uri',
      }),
    };
  }
  const problem = authorizeProblem(params);
  if (problem) return { error: redirectError(redirectUri, params.get('state') ?? '', problem) };
  const pending: McpOAuthPending = {
    id: randomSecret(),
    clientId: client.clientId,
    redirectUri,
    state: params.get('state') ?? '',
    codeChallenge: params.get('code_challenge') ?? '',
    generation: serve.grantGeneration,
    expiresAt: now + PENDING_TTL_MS,
  };
  serve.pending.push(pending);
  return {
    challenge: {
      pendingId: pending.id,
      generation: serve.grantGeneration,
      clientName: client.clientName,
      redirectUri,
    },
  };
}

export async function decideAuthorization(
  serve: McpServeRecord,
  body: string,
  contentType: string,
  now: number
): Promise<McpHttpResult> {
  prune(serve, now);
  const form = readForm(body, contentType);
  const pendingId = form.get('pending') ?? '';
  const generation = Number(form.get('generation') ?? '');
  const decision = form.get('decision') ?? '';
  const index = serve.pending.findIndex((item) => timingSafeEqual(item.id, pendingId));
  const pending = index >= 0 ? serve.pending[index] : undefined;
  if (!pending)
    return json(400, { error: 'invalid_request', error_description: 'unknown consent request' });

  if (generation !== pending.generation || generation !== serve.grantGeneration) {
    return json(400, { error: 'invalid_request', error_description: 'consent is stale' });
  }
  serve.pending.splice(index, 1);
  if (decision !== 'accept')
    return redirectError(pending.redirectUri, pending.state, 'access_denied');
  const code = randomSecret();
  const codeRecord: McpOAuthCode = {
    codeHash: await sha256Hex(code),
    clientId: pending.clientId,
    redirectUri: pending.redirectUri,
    codeChallenge: pending.codeChallenge,
    grantGeneration: serve.grantGeneration,
    expiresAt: now + CODE_TTL_MS,
  };
  serve.codes.push(codeRecord);
  return redirect(appendQuery(pending.redirectUri, { code, state: pending.state }));
}

export async function exchangeToken(
  serve: McpServeRecord,
  body: string,
  contentType: string,
  now: number
): Promise<McpHttpResult> {
  prune(serve, now);
  const form = readForm(body, contentType);
  const grant = form.get('grant_type') ?? '';
  if (grant === 'authorization_code') return exchangeCode(serve, form, now);
  if (grant === 'refresh_token') return exchangeRefresh(serve, form, now);
  return json(400, { error: 'unsupported_grant_type' });
}

export async function accessGrant(
  serve: McpServeRecord,
  authorization: string,
  now: number
): Promise<'ok' | 'missing' | 'stale'> {
  const bearer = bearerToken(authorization);
  if (!bearer) return 'missing';
  const hash = await sha256Hex(bearer);
  const token = serve.tokens.find((item) => timingSafeEqual(item.accessHash, hash));
  if (!token || token.accessExpiresAt <= now) return 'missing';
  if (token.grantGeneration !== serve.grantGeneration) return 'stale';
  return 'ok';
}

export function redirectUriAllowed(uri: string): boolean {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  const scheme = url.protocol.replace(/:$/, '').toLowerCase();
  if (
    scheme === 'javascript' ||
    scheme === 'data' ||
    scheme === 'file' ||
    scheme === 'vbscript' ||
    scheme === 'blob'
  ) {
    return false;
  }
  if (scheme === 'https') return true;
  if (scheme === 'http') {
    const host = url.hostname.replace(/^\[|\]$/g, '');
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
  }
  return /^[a-z][a-z0-9+.-]*$/.test(scheme) && uri.length > scheme.length + 1;
}

export function dropStaleGrants(serve: McpServeRecord): void {
  serve.tokens = serve.tokens.filter((token) => token.grantGeneration === serve.grantGeneration);
  serve.codes = serve.codes.filter((code) => code.grantGeneration === serve.grantGeneration);
}

async function exchangeCode(
  serve: McpServeRecord,
  form: URLSearchParams,
  now: number
): Promise<McpHttpResult> {
  const code = form.get('code') ?? '';
  const hash = code ? await sha256Hex(code) : '';
  const index = serve.codes.findIndex((item) => timingSafeEqual(item.codeHash, hash));
  const stored = index >= 0 ? serve.codes[index] : undefined;
  if (!stored || stored.expiresAt <= now) return json(400, { error: 'invalid_grant' });
  const clientId = form.get('client_id') ?? '';
  const redirectUri = form.get('redirect_uri') ?? '';
  if (stored.clientId !== clientId || stored.redirectUri !== redirectUri)
    return json(400, { error: 'invalid_grant' });
  if (stored.grantGeneration !== serve.grantGeneration)
    return json(400, { error: 'invalid_grant' });
  const verifier = form.get('code_verifier') ?? '';
  if (!(await pkceMatches(verifier, stored.codeChallenge)))
    return json(400, { error: 'invalid_grant' });
  serve.codes.splice(index, 1);
  return issueToken(serve, clientId, now);
}

async function exchangeRefresh(
  serve: McpServeRecord,
  form: URLSearchParams,
  now: number
): Promise<McpHttpResult> {
  const refresh = form.get('refresh_token') ?? '';
  const hash = refresh ? await sha256Hex(refresh) : '';
  const index = serve.tokens.findIndex((item) => timingSafeEqual(item.refreshHash, hash));
  const stored = index >= 0 ? serve.tokens[index] : undefined;
  if (!stored || stored.refreshExpiresAt <= now) return json(400, { error: 'invalid_grant' });
  if (stored.grantGeneration !== serve.grantGeneration) return unauthorizedRefresh();
  serve.tokens.splice(index, 1);
  return issueToken(serve, stored.clientId, now);
}

async function issueToken(
  serve: McpServeRecord,
  clientId: string,
  now: number
): Promise<McpHttpResult> {
  const access = randomSecret();
  const refresh = randomSecret();
  const record: McpOAuthToken = {
    accessHash: await sha256Hex(access),
    refreshHash: await sha256Hex(refresh),
    clientId,
    grantGeneration: serve.grantGeneration,
    accessExpiresAt: now + ACCESS_TTL_S * 1000,
    refreshExpiresAt: now + REFRESH_TTL_S * 1000,
  };
  serve.tokens.push(record);
  if (serve.tokens.length > MAX_TOKENS) serve.tokens.splice(0, serve.tokens.length - MAX_TOKENS);
  return json(200, {
    access_token: access,
    token_type: 'Bearer',
    expires_in: ACCESS_TTL_S,
    refresh_token: refresh,
    scope: 'mcp',
  });
}

function authorizeProblem(params: URLSearchParams): string | null {
  if (params.get('response_type') !== 'code') return 'unsupported_response_type';
  if ((params.get('code_challenge_method') ?? '') !== 'S256') return 'invalid_request';
  if (!(params.get('code_challenge') ?? '')) return 'invalid_request';
  const scope = params.get('scope');
  if (scope?.split(' ').every((part) => part !== 'mcp')) return 'invalid_scope';
  return null;
}

function readRegistration(body: string): {
  clientName: string;
  redirectUris: string[];
  error?: string;
} {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return { clientName: '', redirectUris: [], error: 'invalid JSON' };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { clientName: '', redirectUris: [], error: 'invalid JSON' };
  }
  const method = readString(value, 'token_endpoint_auth_method');
  if (method && method !== 'none') {
    return { clientName: '', redirectUris: [], error: 'token_endpoint_auth_method must be none' };
  }
  const uris = Object.getOwnPropertyDescriptor(value, 'redirect_uris')?.value;
  const redirectUris = Array.isArray(uris)
    ? uris.filter((item): item is string => typeof item === 'string')
    : [];
  if (redirectUris.length === 0 || redirectUris.some((uri) => !redirectUriAllowed(uri))) {
    return { clientName: '', redirectUris: [], error: 'redirect_uris are not allowed' };
  }
  return { clientName: readString(value, 'client_name') ?? '', redirectUris };
}

function readForm(body: string, contentType: string): URLSearchParams {
  if (!contentType.includes('json')) return new URLSearchParams(body);
  const params = new URLSearchParams();
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return params;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return params;
  for (const key of Object.keys(value)) {
    const item = Object.getOwnPropertyDescriptor(value, key)?.value;
    if (typeof item === 'string') params.set(key, item);
  }
  return params;
}

async function pkceMatches(verifier: string, challenge: string): Promise<boolean> {
  if (verifier.length < 43 || verifier.length > 128) return false;
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  );
  return timingSafeEqual(base64Url(digest), challenge);
}

function prune(serve: McpServeRecord, now: number): void {
  serve.pending = serve.pending.filter((item) => item.expiresAt > now);
  serve.codes = serve.codes.filter((item) => item.expiresAt > now);
  serve.tokens = serve.tokens.filter((item) => item.refreshExpiresAt > now);
}

function redirectError(redirectUri: string, state: string, error: string): McpHttpResult {
  return redirect(appendQuery(redirectUri, { error, ...(state ? { state } : {}) }));
}

function redirect(location: string): McpHttpResult {
  return { status: 302, headers: { location, 'cache-control': 'no-store' }, body: '' };
}

function unauthorizedRefresh(): McpHttpResult {
  return json(401, { error: 'invalid_grant', error_description: 'grant is stale' });
}

function appendQuery(uri: string, query: Record<string, string>): string {
  const url = new URL(uri);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return url.toString();
}

function json(status: number, payload: unknown, extra?: Record<string, string>): McpHttpResult {
  return {
    status,
    headers: { 'content-type': JSON_TYPE, 'cache-control': 'no-store', ...extra },
    body: JSON.stringify(payload),
  };
}

function bearerToken(authorization: string): string {
  if (!authorization.startsWith('Bearer ')) return '';
  return authorization.slice('Bearer '.length).trim();
}

function randomSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function readString(value: object, key: string): string | undefined {
  const found = Object.getOwnPropertyDescriptor(value, key)?.value;
  if (typeof found === 'string') return found;
  return undefined;
}
