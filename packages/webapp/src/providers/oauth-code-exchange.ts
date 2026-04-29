/**
 * Client-side utilities for OAuth authorization code exchange.
 *
 * These call the generic `/oauth/token` and `/oauth/revoke` endpoints on the
 * SLICC Cloudflare Worker, which holds the client secrets server-side and
 * proxies the request to the upstream OAuth provider.
 *
 * Implicit-grant providers (e.g. Adobe IMS) do not need these utilities —
 * they extract the token directly from the redirect URL fragment.
 */

import {
  TRAY_WORKER_STORAGE_KEY,
  DEFAULT_PRODUCTION_TRAY_WORKER_BASE_URL,
} from '../scoops/tray-runtime-config.js';

/** Resolve the worker base URL (localStorage override → production default). */
export function getWorkerBaseUrl(): string {
  try {
    const stored = localStorage.getItem(TRAY_WORKER_STORAGE_KEY);
    if (stored) return stored.replace(/\/$/, '');
  } catch {
    /* localStorage may be unavailable */
  }
  return DEFAULT_PRODUCTION_TRAY_WORKER_BASE_URL;
}

export interface TokenResponse {
  access_token: string;
  token_type?: string;
  scope?: string;
  refresh_token?: string;
  expires_in?: number;
}

/**
 * Exchange an OAuth authorization code for tokens via the worker's
 * generic token broker (`POST /oauth/token`).
 *
 * The worker looks up the provider in its registry, injects the client
 * secret, and forwards the request to the upstream token endpoint.
 *
 * @throws Error if the exchange fails or returns an OAuth error.
 */
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

  let body: Record<string, unknown>;
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    throw new Error(`Token exchange failed (HTTP ${res.status}): non-JSON response`);
  }

  if (!res.ok && res.status !== 200) {
    const msg =
      (body.error_description as string) ??
      (body.error as string) ??
      `Token exchange failed (HTTP ${res.status})`;
    throw new Error(msg);
  }

  // GitHub returns 200 even for errors — check for error field
  if (body.error) {
    const msg = (body.error_description as string) ?? (body.error as string);
    throw new Error(msg);
  }

  return body as unknown as TokenResponse;
}

/**
 * Revoke an OAuth token via the worker's generic broker (`POST /oauth/revoke`).
 *
 * Silently succeeds if the worker returns 204 (token revoked) or if
 * the provider does not support revocation.
 *
 * @throws Error only on network or unexpected server errors.
 */
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

  // 204 = revoked, 200 = provider returned a body (also OK)
  if (res.status === 204 || res.ok) return;

  // Don't throw for unsupported revocation — it's not critical
  if (res.status === 400) {
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error === 'unsupported') return;
    } catch {
      /* ignore parse failure */
    }
  }

  throw new Error(`Token revocation failed (HTTP ${res.status})`);
}
