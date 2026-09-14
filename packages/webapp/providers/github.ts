import { GLOBAL_FS_DB_NAME } from '../src/fs/global-db.js';
import { isWorkerServedSpa } from '../src/providers/adobe-oauth-state.js';
import {
  exchangeOAuthCode,
  getWorkerBaseUrl,
  refreshOAuthToken,
  revokeOAuthToken,
} from '../src/providers/oauth-code-exchange.js';
import { getOAuthPageOrigin, resolveOAuthDelegation } from '../src/providers/oauth-service.js';
import { createSilentRenewBackoff } from '../src/providers/silent-renew-backoff.js';
import type {
  OAuthLauncher,
  OAuthLoginOptions,
  OAuthTokenValidation,
  ProviderConfig,
} from '../src/providers/types.js';
import { getLocalApiBaseUrl } from '../src/shell/proxied-fetch.js';
import {
  ensureOAuthMaskReplica,
  getAccounts,
  saveOAuthAccount,
} from '../src/ui/provider-settings.js';

interface GitHubConfig {
  clientId: string;
  scopes: string;
  redirectUri?: string;
}

const configFiles = import.meta.glob('/packages/webapp/providers/github-config.json', {
  eager: true,
  import: 'default',
}) as Record<string, GitHubConfig>;

const githubConfig: GitHubConfig = configFiles['/packages/webapp/providers/github-config.json'] ?? {
  clientId: '',
  scopes: 'repo,read:user,user:email',
};

export type GithubOAuthStateExtension = {
  source: 'extension';
  extensionId: string;
  path: '/github';
  nonce: string;
};

export type GithubOAuthStateOpener = {
  source: 'opener';
  path: '/auth/callback';
  nonce: string;
};

export type GithubOAuthStateLocal = {
  source: 'local';
  port: number;
  path: '/auth/callback';
  nonce: string;
};

export type GithubOAuthStateRemote = {
  source: 'remote';
  origin: string;
  path: '/auth/callback';
  nonce: string;
};

export type GithubOAuthStateStandaloneCli = {
  port: number;
  path: '/auth/callback';
  nonce: string;
};

export type GithubOAuthState =
  | GithubOAuthStateExtension
  | GithubOAuthStateOpener
  | GithubOAuthStateLocal
  | GithubOAuthStateRemote
  | GithubOAuthStateStandaloneCli;

type ConnectModeGlobal = {
  __slicc_connect_mode?: unknown;
};

let runtimeClientId: string | null = null;
let runtimeWorkerBaseUrl: string | null = null;

export function resolveGithubOAuthRedirect(opts: {
  isExtension: boolean;
  isConnectMode: boolean;
  workerBaseUrl: string;
  runtimeWorkerBaseUrl: string | null;
  pageOrigin: string | null;
  pageHref: string | null;

  bridgeApiBaseUrl?: string | null;

  delegated?: boolean;
  extensionId: string;
  nonce: string;
}): { redirectUri: string; state: GithubOAuthState } {
  const {
    isExtension,
    isConnectMode,
    workerBaseUrl,
    pageOrigin,
    pageHref,
    bridgeApiBaseUrl,
    extensionId,
    nonce,
  } = opts;
  if (isExtension) {
    return {
      redirectUri: `${workerBaseUrl}/auth/callback`,
      state: { source: 'extension', extensionId, path: '/github', nonce },
    };
  }

  if (opts.delegated) {
    return {
      redirectUri: `${opts.runtimeWorkerBaseUrl ?? workerBaseUrl}/auth/callback`,
      state: { source: 'opener', path: '/auth/callback', nonce },
    };
  }
  if (isConnectMode) {
    const origin = pageOrigin ?? '';
    if (/^https?:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin)) {
      const port = parseInt(new URL(pageHref ?? origin).port || '8790', 10);
      return {
        redirectUri: `${workerBaseUrl}/auth/callback`,
        state: { source: 'local', port, path: '/auth/callback', nonce },
      };
    }
    return {
      redirectUri: `${workerBaseUrl}/auth/callback`,
      state: { source: 'remote', origin, path: '/auth/callback', nonce },
    };
  }

  if (bridgeApiBaseUrl && pageHref && isWorkerServedSpa(pageHref)) {
    let bridgePort: number | null = null;
    try {
      const parsed = new URL(bridgeApiBaseUrl);
      if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') {
        bridgePort = parseInt(parsed.port || '5710', 10);
      }
    } catch {
      bridgePort = null;
    }
    if (bridgePort !== null && !Number.isNaN(bridgePort)) {
      return {
        redirectUri: `${opts.runtimeWorkerBaseUrl ?? workerBaseUrl}/auth/callback`,
        state: { source: 'local', port: bridgePort, path: '/auth/callback', nonce },
      };
    }
  }

  return {
    redirectUri: `${opts.runtimeWorkerBaseUrl ?? pageOrigin ?? ''}/auth/callback`,
    state: {
      port: parseInt(new URL(pageHref ?? pageOrigin ?? 'http://localhost:5710').port || '5710', 10),
      path: '/auth/callback',
      nonce,
    },
  };
}

async function resolveClientId(): Promise<string> {
  if (runtimeClientId) return runtimeClientId;

  if (isExtension) {
    try {
      const res = await fetch(`${getWorkerBaseUrl()}/api/runtime-config`);
      if (res.ok) {
        const data = (await res.json()) as { oauth?: { github?: string } };
        if (data.oauth?.github) {
          runtimeClientId = data.oauth.github;
          return runtimeClientId;
        }
      }
    } catch {}
    return githubConfig.clientId;
  }

  try {
    const localRes = await fetch('/api/runtime-config');
    if (localRes.ok) {
      const localData = (await localRes.json()) as {
        oauth?: { github?: string };
        trayWorkerBaseUrl?: string;
      };
      if (localData.oauth?.github) {
        runtimeClientId = localData.oauth.github;

        if (localData.trayWorkerBaseUrl) {
          runtimeWorkerBaseUrl = localData.trayWorkerBaseUrl;
        }
        return runtimeClientId;
      }

      if (localData.trayWorkerBaseUrl) {
        runtimeWorkerBaseUrl = localData.trayWorkerBaseUrl;
        const workerRes = await fetch(`${localData.trayWorkerBaseUrl}/api/runtime-config`);
        if (workerRes.ok) {
          const workerData = (await workerRes.json()) as { oauth?: { github?: string } };
          if (workerData.oauth?.github) {
            runtimeClientId = workerData.oauth.github;
            return runtimeClientId;
          }
        }
      }
    }
  } catch {}

  return githubConfig.clientId;
}

const isExtension =
  typeof globalThis !== 'undefined' &&
  typeof (globalThis as { chrome?: { runtime?: { id?: string } } }).chrome?.runtime?.id ===
    'string';

function getGitHubAccount() {
  return getAccounts().find((a) => a.providerId === 'github');
}

export function extractCodeFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.searchParams.get('code');
  } catch {
    return null;
  }
}

interface GitHubUserProfile {
  name?: string;
  avatar?: string;

  login?: string;

  id?: number;
}

async function fetchUserProfile(accessToken: string): Promise<GitHubUserProfile> {
  try {
    const res = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/vnd.github+json',
      },
    });
    if (res.ok) {
      const user = (await res.json()) as {
        id?: number;
        login?: string;
        name?: string;
        avatar_url?: string;
      };
      return {
        name: user.name || user.login,
        avatar: user.avatar_url,
        login: user.login,
        id: user.id,
      };
    }
  } catch (err) {
    console.warn(
      '[github] Failed to fetch user profile:',
      err instanceof Error ? err.message : String(err)
    );
  }
  return {};
}

export function buildNoreplyEmail(id: number, login: string): string {
  return `${id}+${login}@users.noreply.github.com`;
}

async function writeGitToken(token: string): Promise<void> {
  try {
    const { VirtualFS } = await import('../src/fs/index.js');
    const fs = await VirtualFS.create({ dbName: GLOBAL_FS_DB_NAME });
    await fs.writeFile('/workspace/.git/github-token', token);
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('github-token-changed'));
    }
  } catch (err) {
    console.warn(
      '[github] Failed to write git token:',
      err instanceof Error ? err.message : String(err)
    );
  }
}

async function clearGitToken(): Promise<void> {
  try {
    const { VirtualFS } = await import('../src/fs/index.js');
    const fs = await VirtualFS.create({ dbName: GLOBAL_FS_DB_NAME });
    await fs.rm('/workspace/.git/github-token');
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('github-token-changed'));
    }
  } catch {}
}

async function writeGitTokenFromOAuthReplica(opts?: { clearOnFailure?: boolean }): Promise<void> {
  const replica = await ensureOAuthMaskReplica('github');
  if (replica.maskedValue) {
    await writeGitToken(replica.maskedValue);
    return;
  }
  if (opts?.clearOnFailure) {
    await clearGitToken();
  }
}

export async function syncGitIdentityFromGitHub(profile: GitHubUserProfile): Promise<void> {
  if (!profile.login || profile.id === undefined) {
    return;
  }

  try {
    const { VirtualFS } = await import('../src/fs/index.js');
    const { readGlobalGitConfigValue, writeGlobalGitConfigValue } = await import(
      '../src/git/git-config.js'
    );
    const fs = await VirtualFS.create({ dbName: GLOBAL_FS_DB_NAME });

    const desiredName = profile.name || profile.login;
    const desiredEmail = buildNoreplyEmail(profile.id, profile.login);

    const existingName = await readGlobalGitConfigValue(fs, 'user.name');
    if (!existingName && desiredName) {
      await writeGlobalGitConfigValue(fs, 'user.name', desiredName);
    }

    const existingEmail = await readGlobalGitConfigValue(fs, 'user.email');
    if (!existingEmail) {
      await writeGlobalGitConfigValue(fs, 'user.email', desiredEmail);
    }
  } catch (err) {
    console.warn(
      '[github] Failed to seed git identity:',
      err instanceof Error ? err.message : String(err)
    );
  }
}

const silentRenewBackoff = createSilentRenewBackoff();

async function renewGitHubToken(): Promise<string | null> {
  try {
    const account = getGitHubAccount();
    if (!account?.refreshToken) return null;

    const tokenResult = await refreshOAuthToken({
      provider: 'github',
      refreshToken: account.refreshToken,
    });
    await saveOAuthAccount({
      providerId: 'github',
      accessToken: tokenResult.access_token,
      refreshToken: tokenResult.refresh_token,
      tokenExpiresAt: tokenResult.expires_in
        ? Date.now() + tokenResult.expires_in * 1000
        : undefined,
      userName: account.userName,
      userAvatar: account.userAvatar,
      scopes: tokenResult.scope ?? account.scopes,
    });

    await writeGitTokenFromOAuthReplica({ clearOnFailure: true });
    return tokenResult.access_token;
  } catch (err) {
    console.warn(
      '[github] Silent renewal failed:',
      err instanceof Error ? err.message : String(err)
    );
    return null;
  }
}

const VALIDATE_TIMEOUT_MS = 10_000;

async function validateGitHubToken(): Promise<OAuthTokenValidation> {
  const accessToken = getGitHubAccount()?.accessToken;
  if (!accessToken) return { status: 'unknown', detail: 'no stored token' };
  try {
    const res = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/vnd.github+json',
      },
      signal: AbortSignal.timeout(VALIDATE_TIMEOUT_MS),
    });
    if (res.ok) {
      const user = (await res.json().catch(() => ({}))) as { login?: string; name?: string };
      return { status: 'accepted', userName: user.name || user.login };
    }
    return classifyGitHubRejection(res);
  } catch (err) {
    return { status: 'unknown', detail: err instanceof Error ? err.message : String(err) };
  }
}

function classifyGitHubRejection(res: Response): OAuthTokenValidation {
  const detail = `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`;
  if (res.status === 401) return { status: 'rejected', detail };
  if (res.status === 403 && isRateLimited(res)) {
    return { status: 'unknown', detail: `${detail} (rate limited)` };
  }
  return { status: 'unknown', detail };
}

function isRateLimited(res: Response): boolean {
  return res.headers.get('x-ratelimit-remaining') === '0' || res.headers.has('retry-after');
}

async function syncGitTokenBridge(): Promise<void> {
  await writeGitTokenFromOAuthReplica();
}

async function getValidAccessToken(): Promise<string> {
  const account = getGitHubAccount();
  if (!account?.accessToken) throw new Error('Not logged in to GitHub — please log in first');

  const expiresIn = (account.tokenExpiresAt ?? Number.POSITIVE_INFINITY) - Date.now();
  if (expiresIn > 60000) {
    await syncGitTokenBridge();
    return account.accessToken;
  }

  const newToken = await silentRenewBackoff.run(() => renewGitHubToken());
  if (newToken) return newToken;

  const refreshedAccount = getGitHubAccount();
  const refreshedExpiresIn =
    (refreshedAccount?.tokenExpiresAt ?? Number.POSITIVE_INFINITY) - Date.now();
  if (refreshedExpiresIn > 0 && refreshedAccount?.accessToken) {
    await syncGitTokenBridge();
    return refreshedAccount.accessToken;
  }

  throw new Error('GitHub session expired — please log in again');
}

export const config: ProviderConfig = {
  id: 'github',
  name: 'GitHub',
  description:
    'Sign in with GitHub for git authentication (push/pull/clone) and the `oauth-token github` shell command. Does not expose LLM models — use the GitHub Copilot provider for those.',
  requiresApiKey: false,
  requiresBaseUrl: false,
  isOAuth: true,
  oauthTokenDomains: ['github.com', '*.github.com', 'api.github.com', 'raw.githubusercontent.com'],

  getModelIds: () => [],

  onOAuthLogin: async (
    launcher: OAuthLauncher,
    onSuccess: () => void,
    options?: OAuthLoginOptions
  ) => {
    const clientId = await resolveClientId();
    if (!clientId) {
      throw new Error('GitHub OAuth not configured — no client ID available');
    }

    const scopes = options?.scopes ?? githubConfig.scopes;

    const pageInfo = isExtension ? null : await getOAuthPageOrigin();

    const delegated = isExtension ? false : await resolveOAuthDelegation();
    const nonce = crypto.randomUUID();
    const extensionId = isExtension
      ? (chrome as unknown as { runtime: { id: string } }).runtime.id
      : '';
    const { redirectUri, state: stateData } = resolveGithubOAuthRedirect({
      isExtension,
      isConnectMode: !!(globalThis as ConnectModeGlobal).__slicc_connect_mode,
      workerBaseUrl: getWorkerBaseUrl(),
      runtimeWorkerBaseUrl,
      pageOrigin: pageInfo?.origin ?? null,
      pageHref: pageInfo?.href ?? null,

      bridgeApiBaseUrl: getLocalApiBaseUrl(),
      delegated,
      extensionId,
      nonce,
    });
    const oauthState = btoa(JSON.stringify(stateData));
    const expectedNonce = nonce;

    const params = new URLSearchParams({
      client_id: clientId,
      scope: scopes,
      redirect_uri: redirectUri,
    });
    if (oauthState) params.set('state', oauthState);
    const authorizeUrl = `https://github.com/login/oauth/authorize?${params}`;

    const redirectUrl = await launcher(authorizeUrl);
    if (!redirectUrl) return;

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
          '[github] Nonce check skipped (URL parse failed):',
          err instanceof Error ? err.message : String(err)
        );
      }
    }

    const code = extractCodeFromUrl(redirectUrl);
    if (!code) {
      console.error('[github] Could not extract authorization code from redirect URL');
      return;
    }

    const tokenResult = await exchangeOAuthCode({
      provider: 'github',
      code,
      redirectUri,
    });

    const userProfile = await fetchUserProfile(tokenResult.access_token);

    await saveOAuthAccount({
      providerId: 'github',
      accessToken: tokenResult.access_token,
      refreshToken: tokenResult.refresh_token,
      tokenExpiresAt: tokenResult.expires_in
        ? Date.now() + tokenResult.expires_in * 1000
        : undefined,
      userName: userProfile.name,
      userAvatar: userProfile.avatar,

      scopes: tokenResult.scope,
    });

    await writeGitTokenFromOAuthReplica({ clearOnFailure: true });

    await syncGitIdentityFromGitHub(userProfile);

    onSuccess();
  },

  onSilentRenew: renewGitHubToken,
  onValidateToken: validateGitHubToken,
  getValidAccessToken,

  onOAuthLogout: async () => {
    const account = getGitHubAccount();
    if (account?.accessToken) {
      await revokeOAuthToken({ provider: 'github', accessToken: account.accessToken }).catch(
        (err) =>
          console.warn(
            '[github] Token revocation failed:',
            err instanceof Error ? err.message : String(err)
          )
      );
    }

    await clearGitToken();

    await saveOAuthAccount({ providerId: 'github', accessToken: '' });
  },

  getOAuthLogoutUrl: (_account) => 'https://github.com/logout',
};

export { getValidAccessToken };
