/**
 * Google Workspace Provider — OAuth login for Google APIs.
 *
 * Authentication:
 *   Authorization code grant via the generic OAuth token broker.
 *   Google issues refresh tokens, so tokens can be renewed without user interaction.
 *
 * Use cases:
 *   - Google Drive, Gmail, Calendar, Sheets, Docs access via oauth-token
 *   - Scopes can be customized per-request via `oauth-token google --scope "..."`
 */

import type { ProviderConfig, OAuthLauncher, OAuthLoginOptions } from '../src/providers/types.js';
import { saveOAuthAccount, getAccounts } from '../src/ui/provider-settings.js';
import { exchangeOAuthCode, revokeOAuthToken } from '../src/providers/oauth-code-exchange.js';

// ── Config ─────────────────────────────────────────────────────────

interface GoogleConfig {
  clientId: string;
  scopes: string;
}

const configFiles = import.meta.glob('/packages/webapp/providers/google-config.json', {
  eager: true,
  import: 'default',
}) as Record<string, GoogleConfig>;

const googleConfig: GoogleConfig = configFiles['/packages/webapp/providers/google-config.json'] ?? {
  clientId: '',
  scopes: 'openid email profile',
};

// ── Runtime config (fetches correct client ID per environment) ──────

let runtimeClientId: string | null = null;
let runtimeWorkerBaseUrl: string | null = null;

async function resolveClientId(): Promise<string> {
  if (runtimeClientId) return runtimeClientId;

  try {
    const localRes = await fetch('/api/runtime-config');
    if (localRes.ok) {
      const localData = (await localRes.json()) as {
        oauth?: { google?: string };
        trayWorkerBaseUrl?: string;
      };
      if (localData.oauth?.google) {
        runtimeClientId = localData.oauth.google;
        return runtimeClientId;
      }
      if (localData.trayWorkerBaseUrl) {
        runtimeWorkerBaseUrl = localData.trayWorkerBaseUrl;
        const workerRes = await fetch(`${localData.trayWorkerBaseUrl}/api/runtime-config`);
        if (workerRes.ok) {
          const workerData = (await workerRes.json()) as { oauth?: { google?: string } };
          if (workerData.oauth?.google) {
            runtimeClientId = workerData.oauth.google;
            return runtimeClientId;
          }
        }
      }
    }
  } catch {
    // Network error — fall through to build-time config
  }

  return googleConfig.clientId;
}

// ── Runtime detection ──────────────────────────────────────────────

const isExtension = typeof chrome !== 'undefined' && !!(chrome as any)?.runtime?.id;

// ── Helpers ────────────────────────────────────────────────────────

function getGoogleAccount() {
  return getAccounts().find((a) => a.providerId === 'google');
}

/** Extract the authorization code from a redirect URL (?code=...). */
function extractCodeFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.searchParams.get('code');
  } catch {
    return null;
  }
}

/** Fetch Google user profile (name + avatar). */
async function fetchUserProfile(accessToken: string): Promise<{ name?: string; avatar?: string }> {
  try {
    const res = await fetch('https://www.googleapis.com/oauth2/v1/userinfo?alt=json', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (res.ok) {
      const user = (await res.json()) as {
        name?: string;
        email?: string;
        picture?: string;
      };
      return {
        name: user.name || user.email,
        avatar: user.picture,
      };
    }
  } catch (err) {
    console.warn(
      '[google] Failed to fetch user profile:',
      err instanceof Error ? err.message : String(err)
    );
  }
  return {};
}

// ── Token access ───────────────────────────────────────────────────

async function getValidAccessToken(): Promise<string> {
  const account = getGoogleAccount();
  if (!account?.accessToken) throw new Error('Not logged in to Google — please log in first');

  // Check expiry with 60s buffer
  const expiresIn = (account.tokenExpiresAt ?? 0) - Date.now();
  if (expiresIn > 60000) return account.accessToken;

  // Token expired — Google issues refresh tokens, but refresh requires the
  // client secret (server-side). For now, prompt re-login.
  throw new Error('Google session expired — please log in again');
}

// ── Provider config ────────────────────────────────────────────────

export const config: ProviderConfig = {
  id: 'google',
  name: 'Google Workspace',
  description: 'Drive, Gmail, Calendar, Sheets — login with your Google account',
  requiresApiKey: false,
  requiresBaseUrl: false,
  isOAuth: true,

  onOAuthLogin: async (
    launcher: OAuthLauncher,
    onSuccess: () => void,
    options?: OAuthLoginOptions
  ) => {
    const clientId = await resolveClientId();
    if (!clientId) {
      throw new Error('Google OAuth not configured — no client ID available');
    }

    // Google uses space-separated scopes
    const scopes = options?.scopes ?? googleConfig.scopes;

    const redirectUri = isExtension
      ? `https://${(chrome as any).runtime.id}.chromiumapp.org/`
      : `${runtimeWorkerBaseUrl ?? window.location.origin}/auth/callback`;

    // Build OAuth state with port and CSRF nonce for the relay (CLI only)
    const oauthState = !isExtension
      ? btoa(
          JSON.stringify({
            port: parseInt(new URL(window.location.href).port || '5710', 10),
            path: '/auth/callback',
            nonce: crypto.randomUUID(),
          })
        )
      : undefined;
    const expectedNonce = oauthState ? JSON.parse(atob(oauthState)).nonce : null;

    const params = new URLSearchParams({
      client_id: clientId,
      scope: scopes,
      response_type: 'code',
      redirect_uri: redirectUri,
      access_type: 'offline', // Request refresh token
      prompt: 'consent', // Force consent to get refresh token
    });
    if (oauthState) params.set('state', oauthState);
    const authorizeUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params}`;

    const redirectUrl = await launcher(authorizeUrl);
    if (!redirectUrl) return;

    // Verify CSRF nonce from relay callback
    if (expectedNonce) {
      try {
        const callbackUrl = new URL(redirectUrl);
        const receivedNonce = callbackUrl.searchParams.get('nonce');
        if (receivedNonce !== expectedNonce) {
          console.error('[google] OAuth nonce mismatch — possible CSRF');
          return;
        }
      } catch (err) {
        console.warn(
          '[google] Nonce check skipped (URL parse failed):',
          err instanceof Error ? err.message : String(err)
        );
      }
    }

    // Extract authorization code
    const code = extractCodeFromUrl(redirectUrl);
    if (!code) {
      console.error('[google] Could not extract authorization code from redirect URL');
      return;
    }

    // Exchange code for tokens via the generic OAuth broker
    const tokenResult = await exchangeOAuthCode({
      provider: 'google',
      code,
      redirectUri,
    });

    // Fetch user profile
    const userProfile = await fetchUserProfile(tokenResult.access_token);

    // Save account (Google returns expires_in in seconds)
    saveOAuthAccount({
      providerId: 'google',
      accessToken: tokenResult.access_token,
      refreshToken: tokenResult.refresh_token,
      tokenExpiresAt: tokenResult.expires_in
        ? Date.now() + tokenResult.expires_in * 1000
        : undefined,
      userName: userProfile.name,
      userAvatar: userProfile.avatar,
    });

    onSuccess();
  },

  onOAuthLogout: async () => {
    const account = getGoogleAccount();
    if (account?.accessToken) {
      await revokeOAuthToken({ provider: 'google', accessToken: account.accessToken }).catch(
        (err) =>
          console.warn(
            '[google] Token revocation failed:',
            err instanceof Error ? err.message : String(err)
          )
      );
    }
    saveOAuthAccount({ providerId: 'google', accessToken: '' });
  },
};

export { getValidAccessToken };
