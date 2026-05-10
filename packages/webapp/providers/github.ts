/**
 * GitHub Provider — OAuth login + GitHub Models LLM access.
 *
 * Authentication:
 *   Authorization code grant via the generic OAuth token broker.
 *   CLI mode:       popup → /auth/callback relay → code extracted → worker exchanges
 *   Extension mode: chrome.identity.launchWebAuthFlow → code extracted → worker exchanges
 *
 * LLM access:
 *   GitHub Models (models.inference.ai.azure.com) is an OpenAI-compatible API
 *   authenticated with the GitHub OAuth token. Routes through pi-ai's
 *   streamOpenAICompletions.
 *
 * Git integration:
 *   The OAuth token is written to /workspace/.git/github-token in the global VFS
 *   so isomorphic-git picks it up for push/pull/clone operations.
 */

import type {
  ProviderConfig,
  OAuthLauncher,
  OAuthLoginOptions,
  ModelMetadata,
} from '../src/providers/types.js';
import {
  registerApiProvider,
  streamOpenAICompletions,
  streamSimpleOpenAICompletions,
  createAssistantMessageEventStream,
} from '@earendil-works/pi-ai';
import type {
  Api,
  Model,
  Context,
  SimpleStreamOptions,
  OpenAICompletionsOptions,
} from '@earendil-works/pi-ai';
import { saveOAuthAccount, getAccounts } from '../src/ui/provider-settings.js';
import {
  exchangeOAuthCode,
  revokeOAuthToken,
  getWorkerBaseUrl,
} from '../src/providers/oauth-code-exchange.js';
import { GLOBAL_FS_DB_NAME } from '../src/fs/global-db.js';

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

const isExtension = typeof chrome !== 'undefined' && !!(chrome as any)?.runtime?.id;

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
    const { readGlobalGitConfigValue, writeGlobalGitConfigValue } =
      await import('../src/git/git-config.js');
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

// ── GitHub Models ──────────────────────────────────────────────────

// New unified GitHub Models endpoint (replaces the old Azure inference endpoint).
// Model IDs use vendor-prefixed format: "openai/gpt-4.1"
const GITHUB_MODELS_BASE = 'https://models.github.ai/inference';

/**
 * Models available via GitHub Models free tier (no Copilot subscription required).
 * gpt-4o / gpt-4o-mini / o3-mini are deprecated; o4-mini requires a paid Copilot plan.
 * Model IDs use the vendor-prefixed format required by the models.github.ai endpoint.
 */
const GITHUB_MODELS: Array<{ id: string; name: string } & ModelMetadata> = [
  {
    id: 'openai/gpt-4.1',
    name: 'GPT-4.1',
    api: 'openai',
    context_window: 1047576,
    max_tokens: 32768,
    reasoning: false,
    input: ['text', 'image'],
  },
  {
    id: 'openai/gpt-4.1-mini',
    name: 'GPT-4.1 mini',
    api: 'openai',
    context_window: 1047576,
    max_tokens: 32768,
    reasoning: false,
    input: ['text', 'image'],
  },
];

// ── Stream functions ───────────────────────────────────────────────

function makeErrorOutput(model: Model<Api>, error: unknown) {
  return {
    type: 'error' as const,
    reason: 'error' as const,
    error: {
      role: 'assistant' as const,
      content: [],
      api: 'github-openai' as Api,
      provider: 'github',
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: 'error' as const,
      errorMessage: error instanceof Error ? error.message : String(error),
      timestamp: Date.now(),
    },
  };
}

const streamGitHub = (
  model: Model<Api>,
  context: Context,
  options: OpenAICompletionsOptions = {}
) => {
  const stream = createAssistantMessageEventStream();
  (async () => {
    try {
      const accessToken = await getValidAccessToken();
      const proxyModel = {
        ...model,
        baseUrl: GITHUB_MODELS_BASE,
        api: 'openai-completions' as Api,
        compat: {
          ...(model as any).compat,
          supportsStore: false,
          supportsDeveloperRole: false,
          // models.github.ai/inference does not support stream_options.include_usage
          // (causes 500 after ~30s timeout) or max_completion_tokens (use max_tokens).
          supportsUsageInStreaming: false,
          maxTokensField: 'max_tokens',
        },
      };
      const inner = streamOpenAICompletions(proxyModel as any, context, {
        ...options,
        apiKey: accessToken,
      } as any);
      for await (const event of inner) stream.push(event as any);
      stream.end();
    } catch (error) {
      console.error(
        '[github] Stream error:',
        error instanceof Error ? error.message : String(error)
      );
      stream.push(makeErrorOutput(model, error) as any);
      stream.end();
    }
  })();
  return stream;
};

const streamSimpleGitHub = (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => {
  const stream = createAssistantMessageEventStream();
  (async () => {
    try {
      const accessToken = await getValidAccessToken();
      const proxyModel = {
        ...model,
        baseUrl: GITHUB_MODELS_BASE,
        api: 'openai-completions' as Api,
        compat: {
          ...(model as any).compat,
          supportsStore: false,
          supportsDeveloperRole: false,
          // models.github.ai/inference does not support stream_options.include_usage
          // (causes 500 after ~30s timeout) or max_completion_tokens (use max_tokens).
          supportsUsageInStreaming: false,
          maxTokensField: 'max_tokens',
        },
      };
      const inner = streamSimpleOpenAICompletions(proxyModel as any, context, {
        ...options,
        apiKey: accessToken,
      } as any);
      for await (const event of inner) stream.push(event as any);
      stream.end();
    } catch (error) {
      console.error(
        '[github] Stream error:',
        error instanceof Error ? error.message : String(error)
      );
      stream.push(makeErrorOutput(model, error) as any);
      stream.end();
    }
  })();
  return stream;
};

// ── Provider config ────────────────────────────────────────────────

export const config: ProviderConfig = {
  id: 'github',
  name: 'GitHub',
  description: 'GitHub Models + git authentication — login with your GitHub account',
  requiresApiKey: false,
  requiresBaseUrl: false,
  isOAuth: true,
  defaultModelId: 'gpt-4.1', // substring-matched against openai/gpt-4.1

  getModelIds: () => GITHUB_MODELS,

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

    // Both flows redirect through the worker's /auth/callback relay. The relay
    // reads the `state` param (source=local|extension) and forwards to the
    // correct final destination. Using one registered URL per OAuth App lets
    // GitHub OAuth Apps (single-callback) work for both CLI and extension.
    const redirectUri = isExtension
      ? `${getWorkerBaseUrl()}/auth/callback`
      : `${runtimeWorkerBaseUrl ?? window.location.origin}/auth/callback`;

    const nonce = crypto.randomUUID();
    const extensionId = isExtension
      ? (chrome as unknown as { runtime: { id: string } }).runtime.id
      : '';
    const stateData = isExtension
      ? { source: 'extension', extensionId, path: '/github', nonce }
      : {
          port: parseInt(new URL(window.location.href).port || '5710', 10),
          path: '/auth/callback',
          nonce,
        };
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
    saveOAuthAccount({
      providerId: 'github',
      accessToken: tokenResult.access_token,
      userName: userProfile.name,
      userAvatar: userProfile.avatar,
    });

    // Bridge token to isomorphic-git
    await writeGitToken(tokenResult.access_token);

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
    // Clear account
    saveOAuthAccount({ providerId: 'github', accessToken: '' });
  },
};

// ── Registration ───────────────────────────────────────────────────

export function register(): void {
  registerApiProvider({
    api: 'github-openai' as Api,
    stream: streamGitHub as any,
    streamSimple: streamSimpleGitHub as any,
  });
}

export { getValidAccessToken };
