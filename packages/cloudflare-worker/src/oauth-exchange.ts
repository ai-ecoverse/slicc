/**
 * Generic OAuth token exchange and revocation handlers.
 *
 * These handlers look up the provider in the OAUTH_PROVIDERS registry,
 * inject the server-side client credentials, and proxy the request to the
 * upstream OAuth provider. The browser never sees the client secret.
 */

import { jsonResponse } from './shared.js';
import { OAUTH_PROVIDERS, type OAuthProviderDef } from './oauth-registry.js';

// ── CORS helper ───────────���────────────────────────────────────────

function oauthCorsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get('Origin') ?? '*';
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

/** Handle CORS preflight for OAuth endpoints. */
export function handleOAuthPreflight(request: Request): Response {
  return new Response(null, { status: 204, headers: oauthCorsHeaders(request) });
}

// ── Credential resolution ─────��────────────────────────────────────

type EnvRecord = Record<string, unknown>;

function resolveCredentials(
  env: EnvRecord,
  def: OAuthProviderDef
): { clientId: string; clientSecret: string } | null {
  const clientId = env[def.clientIdEnvKey];
  const clientSecret = env[def.clientSecretEnvKey];
  if (typeof clientId !== 'string' || !clientId) return null;
  if (typeof clientSecret !== 'string' || !clientSecret) return null;
  return { clientId, clientSecret };
}

// ── Token exchange ─────────────────────��───────────────────────────

export async function handleOAuthToken(
  request: Request,
  env: EnvRecord,
  fetchImpl: typeof fetch = fetch
): Promise<Response> {
  const cors = oauthCorsHeaders(request);

  let body: { provider?: string; code?: string; redirect_uri?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return jsonResponse(
      { error: 'invalid_request', error_description: 'Invalid JSON body' },
      400,
      cors
    );
  }

  const { provider, code, redirect_uri } = body;

  if (!provider) {
    return jsonResponse(
      { error: 'invalid_request', error_description: 'Missing "provider" field' },
      400,
      cors
    );
  }

  const def = OAUTH_PROVIDERS[provider];
  if (!def) {
    return jsonResponse(
      { error: 'unknown_provider', error_description: `Unknown OAuth provider "${provider}"` },
      400,
      cors
    );
  }

  if (!code) {
    return jsonResponse(
      { error: 'invalid_request', error_description: 'Missing "code" field' },
      400,
      cors
    );
  }

  const creds = resolveCredentials(env, def);
  if (!creds) {
    return jsonResponse(
      {
        error: 'server_error',
        error_description: `OAuth provider "${provider}" is not configured on this worker`,
      },
      501,
      cors
    );
  }

  const upstream = await fetchImpl(def.tokenEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      code,
      redirect_uri,
      grant_type: 'authorization_code',
    }),
  });

  const responseBody = await upstream.text();
  return new Response(responseBody, {
    status: upstream.status,
    headers: { 'Content-Type': 'application/json', ...cors },
  });
}

// ── Token revocation ──────────────────────────────────────────────��

export async function handleOAuthRevoke(
  request: Request,
  env: EnvRecord,
  fetchImpl: typeof fetch = fetch
): Promise<Response> {
  const cors = oauthCorsHeaders(request);

  let body: { provider?: string; access_token?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return jsonResponse(
      { error: 'invalid_request', error_description: 'Invalid JSON body' },
      400,
      cors
    );
  }

  const { provider, access_token } = body;

  if (!provider) {
    return jsonResponse(
      { error: 'invalid_request', error_description: 'Missing "provider" field' },
      400,
      cors
    );
  }

  const def = OAUTH_PROVIDERS[provider];
  if (!def) {
    return jsonResponse(
      { error: 'unknown_provider', error_description: `Unknown OAuth provider "${provider}"` },
      400,
      cors
    );
  }

  if (!access_token) {
    return jsonResponse(
      { error: 'invalid_request', error_description: 'Missing "access_token" field' },
      400,
      cors
    );
  }

  if (!def.revokeEndpoint) {
    return jsonResponse(
      {
        error: 'unsupported',
        error_description: `Provider "${provider}" does not support token revocation`,
      },
      400,
      cors
    );
  }

  const creds = resolveCredentials(env, def);
  if (!creds) {
    return jsonResponse(
      {
        error: 'server_error',
        error_description: `OAuth provider "${provider}" is not configured on this worker`,
      },
      501,
      cors
    );
  }

  const revokeUrl =
    typeof def.revokeEndpoint === 'function'
      ? def.revokeEndpoint(creds.clientId)
      : def.revokeEndpoint;
  const method = def.revokeMethod ?? 'post-body';

  let upstream: Response;

  if (method === 'delete-basic') {
    // GitHub-style: DELETE with HTTP Basic auth
    const credentials = btoa(`${creds.clientId}:${creds.clientSecret}`);
    upstream = await fetchImpl(revokeUrl, {
      method: 'DELETE',
      headers: {
        Authorization: `Basic ${credentials}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ access_token }),
    });
  } else {
    // RFC 7009 style: POST with form-encoded body
    upstream = await fetchImpl(revokeUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams({
        token: access_token,
        token_type_hint: 'access_token',
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
      }),
    });
  }

  if (upstream.status === 204) {
    return new Response(null, { status: 204, headers: cors });
  }

  const responseBody = await upstream.text();
  return new Response(responseBody, {
    status: upstream.status,
    headers: { 'Content-Type': 'application/json', ...cors },
  });
}
