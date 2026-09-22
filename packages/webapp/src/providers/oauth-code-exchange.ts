import {
  DEFAULT_PRODUCTION_TRAY_WORKER_BASE_URL,
  TRAY_WORKER_STORAGE_KEY,
} from '../scoops/tray-runtime-config.js';
import {
  BridgeTokenRequiredError,
  bridgeRefreshBlocked,
  noteBridgeTokenRequired,
} from './bridge-token-required.js';

export function getWorkerBaseUrl(): string {
  try {
    const stored = localStorage.getItem(TRAY_WORKER_STORAGE_KEY);
    if (stored) return stored.replace(/\/$/, '');
  } catch {}
  return DEFAULT_PRODUCTION_TRAY_WORKER_BASE_URL;
}

export interface TokenResponse {
  access_token: string;
  token_type?: string;
  scope?: string;
  refresh_token?: string;
  expires_in?: number;
}

interface OAuthTokenEndpointBody {
  access_token?: string;
  token_type?: string;
  scope?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

function toTokenResponse(body: OAuthTokenEndpointBody): TokenResponse {
  return {
    access_token: body.access_token as string,
    token_type: body.token_type,
    scope: body.scope,
    refresh_token: body.refresh_token,
    expires_in: body.expires_in,
  };
}

async function parseTokenResponse(res: Response): Promise<TokenResponse> {
  let body: OAuthTokenEndpointBody;
  try {
    body = (await res.json()) as OAuthTokenEndpointBody;
  } catch {
    throw new Error(`Token exchange failed (HTTP ${res.status}): non-JSON response`);
  }

  if (!res.ok && res.status !== 200) {
    const msg =
      body.error_description ?? body.error ?? `Token exchange failed (HTTP ${res.status})`;
    throw new Error(msg);
  }

  if (body.error) {
    const msg = body.error_description ?? body.error;
    throw new Error(msg);
  }

  return toTokenResponse(body);
}

export async function exchangeOAuthCode(opts: {
  provider: string;
  code: string;
  redirectUri: string;
}): Promise<TokenResponse> {
  const url = `${getWorkerBaseUrl()}/oauth/token`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      provider: opts.provider,
      code: opts.code,
      redirect_uri: opts.redirectUri,
    }),
  });

  return parseTokenResponse(res);
}

export async function refreshOAuthToken(opts: {
  provider: string;
  refreshToken: string;
}): Promise<TokenResponse> {
  if (bridgeRefreshBlocked()) throw new BridgeTokenRequiredError();
  const url = `${getWorkerBaseUrl()}/oauth/token`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      provider: opts.provider,
      refresh_token: opts.refreshToken,
    }),
  });

  if (res.status === 403 && typeof res.clone === 'function') {
    const blockedBody = await res.clone().text();
    if (noteBridgeTokenRequired(res.status, blockedBody)) throw new BridgeTokenRequiredError();
  }

  return parseTokenResponse(res);
}

export async function revokeOAuthToken(opts: {
  provider: string;
  accessToken: string;
}): Promise<void> {
  const url = `${getWorkerBaseUrl()}/oauth/revoke`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      provider: opts.provider,
      access_token: opts.accessToken,
    }),
  });

  if (res.status === 204 || res.ok) return;

  if (res.status === 400) {
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error === 'unsupported') return;
    } catch {}
  }

  throw new Error(`Token revocation failed (HTTP ${res.status})`);
}
