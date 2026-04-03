/**
 * GitHub OAuth Provider — authorization code grant via generic OAuthLauncher.
 *
 * Unlike Adobe (implicit grant, token in fragment), GitHub uses authorization
 * code grant (code in query params). The code is exchanged for an access token
 * via the tray hub worker (POST /github/token) which holds the client secret.
 *
 * The access token is also written to /workspace/.git/github-token in the
 * global VFS so isomorphic-git can use it for push/clone/fetch operations.
 */

import type { ProviderConfig, OAuthLauncher } from '../src/providers/types.js';
import { saveOAuthAccount, getAccounts } from '../src/ui/provider-settings.js';
import { VirtualFS } from '../src/fs/index.js';

// ── Config ──────────────────────────────────────────────────────────

interface GitHubConfig {
  clientId: string;
  scopes: string;
  redirectUri?: string;
  extensionRedirectUri?: string;
}

const configFiles = import.meta.glob('/packages/webapp/providers/github-config.json', {
  eager: true,
  import: 'default',
}) as Record<string, GitHubConfig>;

const githubConfig: GitHubConfig = configFiles['/packages/webapp/providers/github-config.json'] ?? {
  clientId: '',
  scopes: 'repo,read:user',
};

// ── Runtime detection ───────────────────────────────────────────────

interface ChromeRuntime {
  runtime?: { id?: string };
}
declare const chrome: ChromeRuntime | undefined;

const isExtension = typeof chrome !== 'undefined' && !!chrome?.runtime?.id;

// ── Shared helpers ──────────────────────────────────────────────────

function getGitHubAccount() {
  return getAccounts().find((a) => a.providerId === 'github');
}

/** Extract authorization code from redirect URL query params (?code=...). */
export function extractCodeFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.searchParams.get('code');
  } catch {
    return null;
  }
}

// ── Worker base URL resolution ──────────────────────────────────────

function getWorkerBaseUrl(): string {
  if (typeof window !== 'undefined' && window.location) {
    const origin = window.location.origin;
    if (origin.includes('localhost') || origin.includes('127.0.0.1')) {
      return 'https://www.sliccy.ai';
    }
    return origin;
  }
  return 'https://www.sliccy.ai';
}

// ── Token exchange via worker ───────────────────────────────────────

interface TokenResponse {
  access_token: string;
  token_type: string;
  scope: string;
}

async function exchangeCodeForToken(code: string, redirectUri: string): Promise<TokenResponse> {
  const res = await fetch(`${getWorkerBaseUrl()}/github/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, redirect_uri: redirectUri }),
  });
  const body = (await res.json()) as {
    access_token?: string;
    token_type?: string;
    scope?: string;
    error?: string;
    error_description?: string;
  };
  if (body.error) {
    throw new Error(`GitHub OAuth error: ${body.error_description ?? body.error}`);
  }
  if (!body.access_token) {
    throw new Error('GitHub OAuth: no access_token in response');
  }
  return {
    access_token: body.access_token,
    token_type: body.token_type ?? 'bearer',
    scope: body.scope ?? '',
  };
}

// ── User profile ────────────────────────────────────────────────────

async function fetchGitHubUserProfile(token: string): Promise<{ name?: string; avatar?: string }> {
  try {
    const res = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
      },
    });
    if (res.ok) {
      const profile = (await res.json()) as {
        login?: string;
        name?: string;
        avatar_url?: string;
      };
      return { name: profile.name || profile.login, avatar: profile.avatar_url };
    }
    console.warn(`[github] User profile fetch returned ${res.status}`);
  } catch (err) {
    console.warn(
      '[github] Failed to fetch user profile:',
      err instanceof Error ? err.message : String(err)
    );
  }
  return {};
}

// ── VFS git token bridge ────────────────────────────────────────────

let globalVfsPromise: Promise<VirtualFS> | null = null;

function getGlobalVfs(): Promise<VirtualFS> {
  if (!globalVfsPromise) globalVfsPromise = VirtualFS.create({ dbName: 'slicc-fs-global' });
  return globalVfsPromise;
}

async function writeGitToken(token: string): Promise<void> {
  try {
    const fs = await getGlobalVfs();
    await fs.writeFile('/workspace/.git/github-token', token);
  } catch (err) {
    console.warn(
      '[github] Failed to write git token:',
      err instanceof Error ? err.message : String(err)
    );
  }
}

async function clearGitToken(): Promise<void> {
  try {
    const fs = await getGlobalVfs();
    await fs.rm('/workspace/.git/github-token');
  } catch {
    /* file may not exist */
  }
}

function dispatchTokenChanged(): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('github-token-changed'));
  }
}

// ── Provider config ─────────────────────────────────────────────────

export const config: ProviderConfig = {
  id: 'github',
  name: 'GitHub',
  description: 'GitHub authentication for git operations and API access',
  requiresApiKey: false,
  requiresBaseUrl: false,
  isOAuth: true,

  onOAuthLogin: async (launcher: OAuthLauncher, onSuccess: () => void) => {
    if (!githubConfig.clientId) {
      throw new Error(
        'GitHub OAuth client ID not configured — set it in packages/webapp/providers/github-config.json'
      );
    }

    const redirectUri = isExtension
      ? (githubConfig.extensionRedirectUri ??
        `https://${chrome?.runtime?.id ?? ''}.chromiumapp.org/github`)
      : (githubConfig.redirectUri ?? `${window.location.origin}/auth/callback`);

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
      client_id: githubConfig.clientId,
      scope: githubConfig.scopes,
      redirect_uri: redirectUri,
    });
    if (oauthState) params.set('state', oauthState);
    const authorizeUrl = `https://github.com/login/oauth/authorize?${params}`;

    const redirectUrl = await launcher(authorizeUrl);
    if (!redirectUrl) return;

    // CSRF nonce check (CLI only)
    if (expectedNonce) {
      try {
        const callbackUrl = new URL(redirectUrl);
        const receivedNonce = callbackUrl.searchParams.get('nonce');
        if (receivedNonce !== expectedNonce) {
          console.error('[github] OAuth nonce mismatch — possible CSRF');
          return;
        }
      } catch (err) {
        console.warn(
          '[github] Nonce check skipped:',
          err instanceof Error ? err.message : String(err)
        );
      }
    }

    const code = extractCodeFromUrl(redirectUrl);
    if (!code) {
      console.error('[github] Could not extract authorization code from redirect URL');
      return;
    }

    const tokenResult = await exchangeCodeForToken(code, redirectUri);
    const userProfile = await fetchGitHubUserProfile(tokenResult.access_token);

    saveOAuthAccount({
      providerId: 'github',
      accessToken: tokenResult.access_token,
      userName: userProfile.name,
      userAvatar: userProfile.avatar,
    });

    await writeGitToken(tokenResult.access_token);
    dispatchTokenChanged();
    onSuccess();
  },

  onOAuthLogout: async () => {
    const account = getGitHubAccount();
    if (account?.accessToken) {
      try {
        await fetch(`${getWorkerBaseUrl()}/github/revoke`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ access_token: account.accessToken }),
        });
      } catch (err) {
        console.warn(
          '[github] Failed to revoke token:',
          err instanceof Error ? err.message : String(err)
        );
      }
    }
    saveOAuthAccount({ providerId: 'github', accessToken: '' });
    await clearGitToken();
    dispatchTokenChanged();
  },
};
