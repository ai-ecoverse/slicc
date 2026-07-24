/**
 * GitHub Provider — pure OAuth + git authentication.
 *
 * Scope:
 *   This provider exists ONLY to give slicc a GitHub identity for
 *   git push/pull/clone, the `oauth-token github` shell command, and
 *   masking of `*.github.com` traffic through the fetch-proxy. It
 *   intentionally exposes NO LLM models — slicc's previous attempt to
 *   reach Copilot through this token never worked because GitHub's
 *   `copilot_internal/v2/token` endpoint is restricted to specific
 *   OAuth client IDs (notably the VS Code Copilot Chat client), and
 *   slicc's OAuth App is not on that allowlist. The Copilot LLM
 *   surface lives in the sibling `github-copilot.ts` provider, which
 *   uses GitHub's device-code flow with the VS Code client ID.
 *
 * Authentication:
 *   Authorization-code grant via the generic OAuth token broker.
 *   CLI mode:       popup → /auth/callback relay → code → worker exchange
 *   Extension mode: chrome.identity.launchWebAuthFlow → code → worker exchange
 *
 * Git integration:
 *   The OAuth token is written to /workspace/.git/github-token in the global
 *   VFS so isomorphic-git picks it up for push / pull / clone.
 */

import { GLOBAL_FS_DB_NAME } from '../src/fs/global-db.js';
import { isWorkerServedSpa } from '../src/providers/adobe-oauth-state.js';
import {
  exchangeOAuthCode,
  getWorkerBaseUrl,
  revokeOAuthToken,
} from '../src/providers/oauth-code-exchange.js';
import { getOAuthPageOrigin } from '../src/providers/oauth-service.js';
import type { OAuthLauncher, OAuthLoginOptions, ProviderConfig } from '../src/providers/types.js';
import { getLocalApiBaseUrl } from '../src/shell/proxied-fetch.js';
import { getAccounts, getOAuthAccountInfo, saveOAuthAccount } from '../src/ui/provider-settings.js';

// ── Config ─────────────────────────────────────────────────────────

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

// ── Runtime config (fetches correct client ID per environment) ──────

let runtimeClientId: string | null = null;
let runtimeWorkerBaseUrl: string | null = null;

/**
 * Decide the GitHub OAuth `redirect_uri` + `state` for the current runtime.
 * Pure (exported for tests).
 *
 * GitHub OAuth Apps allow a single registered callback — the worker's
 * `/auth/callback` relay — so every runtime redirects there and the relay
 * bounces the code back via `state`:
 *  - **extension** → `source:'extension'` (relay bounces to chromiumapp.org)
 *  - **connect mode** (webapp served by the worker; page origin is NOT the
 *    registered callback) → `source:'local'`+port for localhost, else
 *    `source:'remote'`+origin — must route through the relay, then a capture
 *    page on the bounced origin postMessages the code back
 *  - **worker-served thin-bridge** (SPA on `:8787` (wrangler) / hosted leader
 *    `www.sliccy.ai` with a local `:5710` node-server bridge) → relay bounces
 *    to the **node-server bridge port** (NOT the page port), because the
 *    node-server's `/auth/callback` page POSTs `?code` to its own loopback
 *    `/api/oauth-result` and the cone polls that endpoint cross-origin. The
 *    worker's capture page would only `postMessage(window.opener)` — but
 *    GitHub's COOP `same-origin` severs `window.opener`, so that branch
 *    never delivers. Detection: `isWorkerServedSpa(pageHref)` (the SPA was
 *    launched with `?bridge=…`) AND a `bridgeApiBaseUrl` is set.
 *  - **standalone CLI** → existing port-based local bounce (node-server serves
 *    the capture page on localhost; `runtimeWorkerBaseUrl` is the prod relay)
 */
export function resolveGithubOAuthRedirect(opts: {
  isExtension: boolean;
  isConnectMode: boolean;
  workerBaseUrl: string;
  runtimeWorkerBaseUrl: string | null;
  pageOrigin: string | null;
  pageHref: string | null;
  /**
   * Local node-server bridge origin (`http://localhost:5710`) when the SPA
   * is worker-served and a thin-bridge is configured. Threaded in by the
   * caller from `getLocalApiBaseUrl()` so the helper stays pure.
   */
  bridgeApiBaseUrl?: string | null;
  extensionId: string;
  nonce: string;
}): { redirectUri: string; state: Record<string, unknown> } {
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
  // Worker-served thin-bridge: SPA at `:8787` (wrangler) or hosted leader at
  // `www.sliccy.ai` with a local node-server bridge. Route the relay back to
  // the bridge port (whose `/auth/callback` always POSTs the result to
  // `/api/oauth-result`, which the SPA polls) — postMessage back to the SPA
  // can't work here regardless of `window.opener` state, since the callback
  // page's origin (the local node-server) never matches the SPA's own
  // origin, and the receiving listener only accepts same-origin messages.
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
      // Prefer `runtimeWorkerBaseUrl` (the node-server's runtime-config
      // pointed at the active prod/staging relay); fall back to the
      // build-time `workerBaseUrl` when the runtime config hasn't been
      // resolved yet (cold boot from a worker-served SPA with no node-
      // server poll). Either way it's the registered GitHub callback.
      return {
        redirectUri: `${opts.runtimeWorkerBaseUrl ?? workerBaseUrl}/auth/callback`,
        state: { source: 'local', port: bridgePort, path: '/auth/callback', nonce },
      };
    }
    // Fall through to the legacy standalone-CLI branch when the bridge base
    // is set but not parseable as a localhost origin — never makes it worse.
  }
  // Standalone CLI — unchanged: node-server's runtime-config supplies the prod
  // relay as runtimeWorkerBaseUrl, and node-server serves the localhost capture.
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

  // Extension mode: there is no local server, so go straight to the worker.
  // (A relative /api/runtime-config would resolve to chrome-extension://<id>/...
  // and 404.)
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
    } catch {
      // Fall through to build-time config
    }
    return githubConfig.clientId;
  }

  // Try fetching from the local runtime-config first (works when served from
  // the worker directly — the worker injects oauth.github into the response).
  // In dev mode, the node-server doesn't have OAuth config, but it returns
  // trayWorkerBaseUrl pointing to the correct worker (staging in dev mode).
  // In that case, fetch the worker's runtime-config to get the client ID.
  try {
    const localRes = await fetch('/api/runtime-config');
    if (localRes.ok) {
      const localData = (await localRes.json()) as {
        oauth?: { github?: string };
        trayWorkerBaseUrl?: string;
      };
      if (localData.oauth?.github) {
        runtimeClientId = localData.oauth.github;
        // Capture the worker base that supplied this client id so the
        // OAuth `redirect_uri` is built from the same worker (the active
        // prod/staging relay), not the production fallback.
        if (localData.trayWorkerBaseUrl) {
          runtimeWorkerBaseUrl = localData.trayWorkerBaseUrl;
        }
        return runtimeClientId;
      }
      // Dev mode: local server has no OAuth config — fetch from the worker
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
  } catch {
    // Network error — fall through to build-time config
  }

  // Fall back to build-time config
  return githubConfig.clientId;
}

// ── Runtime detection ──────────────────────────────────────────────

const isExtension =
  typeof globalThis !== 'undefined' &&
  typeof (globalThis as { chrome?: { runtime?: { id?: string } } }).chrome?.runtime?.id ===
    'string';

// ── Helpers ────────────────────────────────────────────────────────

function getGitHubAccount() {
  return getAccounts().find((a) => a.providerId === 'github');
}

/** Extract the authorization code from a redirect URL (?code=...). */
export function extractCodeFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.searchParams.get('code');
  } catch {
    return null;
  }
}

interface GitHubUserProfile {
  /** Display name to surface in the UI (full name or login fallback). */
  name?: string;
  avatar?: string;
  /** GitHub login (username). */
  login?: string;
  /** Numeric account id, used to compose the privacy-preserving noreply email. */
  id?: number;
}

/** Fetch GitHub user profile (name + avatar + login + id). */
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

/**
 * Compose GitHub's privacy-preserving "noreply" email for a given account.
 * Format: `<id>+<login>@users.noreply.github.com`. This is the safe default
 * — it works even when the user has "Keep my email addresses private"
 * enabled, and never leaks a real email address.
 */
export function buildNoreplyEmail(id: number, login: string): string {
  return `${id}+${login}@users.noreply.github.com`;
}

// ── Git token bridge ───────────────────────────────────────────────

/** Write the GitHub token to the global VFS for isomorphic-git. */
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

/** Clear the GitHub token from the global VFS. */
async function clearGitToken(): Promise<void> {
  try {
    const { VirtualFS } = await import('../src/fs/index.js');
    const fs = await VirtualFS.create({ dbName: GLOBAL_FS_DB_NAME });
    await fs.rm('/workspace/.git/github-token');
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('github-token-changed'));
    }
  } catch {
    // Ignore if file doesn't exist
  }
}

// ── Git identity bridge ────────────────────────────────────────────

/**
 * Seed `user.name` and `user.email` in the global git config from the
 * authenticated GitHub identity. Idempotent — only fills in values that are
 * not already set, so any prior `git config --global user.{name,email} ...`
 * customizations are preserved.
 *
 * Email defaults to GitHub's privacy-preserving noreply address
 * (`<id>+<login>@users.noreply.github.com`) so we don't expose a real email
 * unless the user explicitly chooses to override it later.
 */
export async function syncGitIdentityFromGitHub(profile: GitHubUserProfile): Promise<void> {
  if (!profile.login || profile.id === undefined) {
    // Profile fetch failed or token doesn't grant the needed scope; skip
    // silently — git identity stays at whatever the user already configured.
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

// ── Token access ───────────────────────────────────────────────────

async function getValidAccessToken(): Promise<string> {
  const account = getGitHubAccount();
  if (!account?.accessToken) throw new Error('Not logged in to GitHub — please log in first');
  // GitHub OAuth tokens don't expire (unless revoked), so no renewal logic needed
  return account.accessToken;
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

  // Pure git/auth provider — no LLM models exposed. Copilot lives in
  // its own sibling provider (`github-copilot.ts`).
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

    // All runtimes redirect through the worker's /auth/callback relay (the single
    // registered OAuth App callback); the relay forwards to the correct final
    // destination via `state`. See resolveGithubOAuthRedirect for the per-runtime
    // logic. `getOAuthPageOrigin()` resolves origin/href even when invoked from a
    // shell command inside the kernel DedicatedWorker (which has no `window`).
    const pageInfo = isExtension ? null : await getOAuthPageOrigin();
    const nonce = crypto.randomUUID();
    const extensionId = isExtension
      ? (chrome as unknown as { runtime: { id: string } }).runtime.id
      : '';
    const { redirectUri, state: stateData } = resolveGithubOAuthRedirect({
      isExtension,
      isConnectMode: !!(globalThis as Record<string, unknown>).__slicc_connect_mode,
      workerBaseUrl: getWorkerBaseUrl(),
      runtimeWorkerBaseUrl,
      pageOrigin: pageInfo?.origin ?? null,
      pageHref: pageInfo?.href ?? null,
      // Worker-served thin-bridge mode: when the SPA is loaded by the
      // worker (wrangler `:8787` / hosted leader) and a local node-server
      // bridge is configured, route the relay back to the bridge port so
      // its `/auth/callback` page can POST `?code` to its loopback
      // `/api/oauth-result` (postMessage can't reach the SPA cross-origin
      // regardless of `window.opener` state — see `resolveGithubOAuthRedirect`).
      bridgeApiBaseUrl: getLocalApiBaseUrl(),
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

    // Verify CSRF nonce from relay callback
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

    // Extract authorization code from redirect URL
    const code = extractCodeFromUrl(redirectUrl);
    if (!code) {
      console.error('[github] Could not extract authorization code from redirect URL');
      return;
    }

    // Exchange code for token via the generic OAuth broker
    const tokenResult = await exchangeOAuthCode({
      provider: 'github',
      code,
      redirectUri,
    });

    // Fetch user profile
    const userProfile = await fetchUserProfile(tokenResult.access_token);

    // Save account
    await saveOAuthAccount({
      providerId: 'github',
      accessToken: tokenResult.access_token,
      userName: userProfile.name,
      userAvatar: userProfile.avatar,
    });

    // Bridge token to isomorphic-git — use the masked value, not the real token
    const info = getOAuthAccountInfo('github');
    const masked = info?.maskedValue;
    if (masked) {
      await writeGitToken(masked);
    } else {
      await clearGitToken();
    }

    // Seed git user.name / user.email so commits are attributed to the
    // authenticated GitHub identity instead of the placeholder
    // "User <user@example.com>". Idempotent: existing values are preserved.
    await syncGitIdentityFromGitHub(userProfile);

    onSuccess();
  },

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
    // Clear git token from VFS
    await clearGitToken();
    // Clear github account
    await saveOAuthAccount({ providerId: 'github', accessToken: '' });
  },

  /**
   * Opens https://github.com/logout to clear the GitHub browser session.
   * Note: GitHub's actual logout is a CSRF-protected POST form; a GET
   * navigation is best-effort and may not fully clear the session in all
   * browser contexts. See spec PR notes for details.
   */
  getOAuthLogoutUrl: (_account) => 'https://github.com/logout',
};

export { getValidAccessToken };
