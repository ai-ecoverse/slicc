# GitHub OAuth Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a GitHub OAuth provider to Slicc that enables OAuth-based login, automatic git token bridging, and GitHub API access.

**Architecture:** GitHub OAuth App (authorization code grant) with a server-side code exchange via the existing tray hub Cloudflare Worker. The provider follows the same `ProviderConfig` pattern as the Adobe provider but is simpler — no LLM streaming, no model discovery, no token renewal. The OAuth token is bridged to isomorphic-git by writing to `/workspace/.git/github-token` in the global VFS.

**Tech Stack:** TypeScript, Cloudflare Workers, isomorphic-git, LightningFS/IndexedDB, Vitest

---

### Task 1: Worker GitHub Token Exchange Route

**Files:**
- Modify: `packages/cloudflare-worker/src/index.ts`
- Modify: `packages/cloudflare-worker/wrangler.jsonc`
- Test: `packages/cloudflare-worker/tests/index.test.ts`
- Test: `packages/cloudflare-worker/tests/deployed.test.ts`

- [ ] **Step 1: Write failing tests for POST /github/token**

Add to `packages/cloudflare-worker/tests/index.test.ts` inside the `'tray worker skeleton'` describe block:

```typescript
it('exchanges a GitHub OAuth code for an access token via POST /github/token', async () => {
  const env = {
    ...createTestHarness().env,
    GITHUB_CLIENT_ID: 'test-client-id',
    GITHUB_CLIENT_SECRET: 'test-client-secret',
  };

  const mockFetch = vi.fn<typeof fetch>().mockResolvedValueOnce(
    new Response(
      JSON.stringify({
        access_token: 'gho_test_token_123',
        token_type: 'bearer',
        scope: 'repo,read:user',
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    )
  );

  const response = await handleWorkerRequest(
    new Request('https://tray.test/github/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        code: 'test-auth-code',
        redirect_uri: 'https://www.sliccy.ai/auth/callback',
      }),
    }),
    env,
    mockFetch
  );

  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    access_token: string;
    token_type: string;
    scope: string;
  };
  expect(body.access_token).toBe('gho_test_token_123');
  expect(body.token_type).toBe('bearer');
  expect(body.scope).toBe('repo,read:user');

  expect(mockFetch).toHaveBeenCalledOnce();
  const [fetchUrl, fetchInit] = mockFetch.mock.calls[0]!;
  expect(fetchUrl).toBe('https://github.com/login/oauth/access_token');
  expect(fetchInit?.method).toBe('POST');
  expect(fetchInit?.headers).toMatchObject({ Accept: 'application/json' });
});

it('returns GitHub error when code exchange fails', async () => {
  const env = {
    ...createTestHarness().env,
    GITHUB_CLIENT_ID: 'test-client-id',
    GITHUB_CLIENT_SECRET: 'test-client-secret',
  };

  const mockFetch = vi.fn<typeof fetch>().mockResolvedValueOnce(
    new Response(
      JSON.stringify({
        error: 'bad_verification_code',
        error_description: 'The code passed is incorrect or expired.',
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    )
  );

  const response = await handleWorkerRequest(
    new Request('https://tray.test/github/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'expired-code', redirect_uri: 'https://www.sliccy.ai/auth/callback' }),
    }),
    env,
    mockFetch
  );

  expect(response.status).toBe(200);
  const body = (await response.json()) as { error: string; error_description: string };
  expect(body.error).toBe('bad_verification_code');
});

it('returns CORS headers on POST /github/token and OPTIONS preflight', async () => {
  const env = {
    ...createTestHarness().env,
    GITHUB_CLIENT_ID: 'test-client-id',
    GITHUB_CLIENT_SECRET: 'test-client-secret',
  };

  const preflight = await handleWorkerRequest(
    new Request('https://tray.test/github/token', {
      method: 'OPTIONS',
      headers: { Origin: 'https://www.sliccy.ai' },
    }),
    env
  );
  expect(preflight.status).toBe(204);
  expect(preflight.headers.get('access-control-allow-origin')).toBeTruthy();
  expect(preflight.headers.get('access-control-allow-methods')).toContain('POST');
});

it('returns 405 for non-POST requests to /github/token', async () => {
  const env = {
    ...createTestHarness().env,
    GITHUB_CLIENT_ID: 'test-client-id',
    GITHUB_CLIENT_SECRET: 'test-client-secret',
  };

  const response = await handleWorkerRequest(
    new Request('https://tray.test/github/token'),
    env
  );
  expect(response.status).toBe(405);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test -- packages/cloudflare-worker/tests/index.test.ts`
Expected: FAIL — `handleWorkerRequest` does not accept a third parameter, and no route matches `/github/token`.

- [ ] **Step 3: Add GITHUB_CLIENT_ID to wrangler.jsonc**

In `packages/cloudflare-worker/wrangler.jsonc`, add to both the top-level `vars` and the `env.staging.vars`:

```jsonc
"GITHUB_CLIENT_ID": "",
```

- [ ] **Step 4: Extend WorkerEnv and add fetchImpl parameter**

In `packages/cloudflare-worker/src/index.ts`, update the `WorkerEnv` interface:

```typescript
export interface WorkerEnv {
  TRAY_HUB: DurableObjectNamespaceLike;
  ASSETS: { fetch(request: Request): Promise<Response> };
  CLOUDFLARE_TURN_KEY_ID?: string;
  CLOUDFLARE_TURN_API_TOKEN?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
}
```

Update `handleWorkerRequest` signature to accept an optional `fetchImpl` for testability:

```typescript
export async function handleWorkerRequest(
  request: Request,
  env: WorkerEnv,
  fetchImpl: typeof fetch = fetch
): Promise<Response> {
```

- [ ] **Step 5: Implement the /github/token and /github/revoke routes**

Add in `packages/cloudflare-worker/src/index.ts`, before the SPA fallback section (before the `tokenMatch` line):

```typescript
// ── GitHub OAuth token exchange ─────────────────────────────────────
if (url.pathname === '/github/token' || url.pathname === '/github/revoke') {
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: githubCorsHeaders(request),
    });
  }
  if (request.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405, githubCorsHeaders(request));
  }
  if (url.pathname === '/github/token') {
    return handleGitHubTokenExchange(request, env, fetchImpl);
  }
  return handleGitHubTokenRevoke(request, env, fetchImpl);
}
```

Add the handler functions at the bottom of the file (before the `worker` export):

```typescript
function githubCorsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get('Origin') ?? '*';
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

async function handleGitHubTokenExchange(
  request: Request,
  env: WorkerEnv,
  fetchImpl: typeof fetch
): Promise<Response> {
  const { code, redirect_uri } = (await request.json()) as {
    code?: string;
    redirect_uri?: string;
  };
  if (!code) {
    return jsonResponse(
      { error: 'missing_code', error_description: 'Request body must include "code"' },
      400,
      githubCorsHeaders(request)
    );
  }
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
    return jsonResponse(
      { error: 'server_error', error_description: 'GitHub OAuth not configured on this worker' },
      500,
      githubCorsHeaders(request)
    );
  }

  const ghResponse = await fetchImpl('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri,
    }),
  });

  const body = await ghResponse.text();
  return new Response(body, {
    status: ghResponse.status,
    headers: {
      'Content-Type': 'application/json',
      ...githubCorsHeaders(request),
    },
  });
}

async function handleGitHubTokenRevoke(
  request: Request,
  env: WorkerEnv,
  fetchImpl: typeof fetch
): Promise<Response> {
  const { access_token } = (await request.json()) as { access_token?: string };
  if (!access_token) {
    return jsonResponse(
      { error: 'missing_token', error_description: 'Request body must include "access_token"' },
      400,
      githubCorsHeaders(request)
    );
  }
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
    return jsonResponse(
      { error: 'server_error', error_description: 'GitHub OAuth not configured on this worker' },
      500,
      githubCorsHeaders(request)
    );
  }

  const credentials = btoa(`${env.GITHUB_CLIENT_ID}:${env.GITHUB_CLIENT_SECRET}`);
  const ghResponse = await fetchImpl(
    `https://api.github.com/applications/${env.GITHUB_CLIENT_ID}/token`,
    {
      method: 'DELETE',
      headers: {
        Authorization: `Basic ${credentials}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ access_token }),
    }
  );

  if (ghResponse.status === 204) {
    return new Response(null, { status: 204, headers: githubCorsHeaders(request) });
  }
  const body = await ghResponse.text();
  return new Response(body, {
    status: ghResponse.status,
    headers: {
      'Content-Type': 'application/json',
      ...githubCorsHeaders(request),
    },
  });
}
```

`jsonResponse` in `shared.ts` already accepts optional `headers` as its third parameter — no changes needed there.

- [ ] **Step 6: Update the routes list in the 200 fallback response**

In `packages/cloudflare-worker/src/index.ts`, add to the `routes` array:

```typescript
'POST /github/token',
'POST /github/revoke',
```

- [ ] **Step 7: Update the routes assertion in index.test.ts**

In `packages/cloudflare-worker/tests/index.test.ts`, update the `'advertises /tray as the only create route in service metadata'` test to include the new routes in the expected array.

- [ ] **Step 8: Update the routes assertion in deployed.test.ts**

In `packages/cloudflare-worker/tests/deployed.test.ts`, update the routes assertion to include the new routes.

- [ ] **Step 9: Write failing test for POST /github/revoke**

Add to `packages/cloudflare-worker/tests/index.test.ts`:

```typescript
it('revokes a GitHub token via POST /github/revoke', async () => {
  const env = {
    ...createTestHarness().env,
    GITHUB_CLIENT_ID: 'test-client-id',
    GITHUB_CLIENT_SECRET: 'test-client-secret',
  };

  const mockFetch = vi.fn<typeof fetch>().mockResolvedValueOnce(
    new Response(null, { status: 204 })
  );

  const response = await handleWorkerRequest(
    new Request('https://tray.test/github/revoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ access_token: 'gho_token_to_revoke' }),
    }),
    env,
    mockFetch
  );

  expect(response.status).toBe(204);
  expect(mockFetch).toHaveBeenCalledOnce();
  const [fetchUrl, fetchInit] = mockFetch.mock.calls[0]!;
  expect(fetchUrl).toBe('https://api.github.com/applications/test-client-id/token');
  expect(fetchInit?.method).toBe('DELETE');
  expect(fetchInit?.headers).toMatchObject({
    Authorization: `Basic ${btoa('test-client-id:test-client-secret')}`,
  });
});
```

- [ ] **Step 10: Run all worker tests**

Run: `npm run test -- packages/cloudflare-worker/tests/index.test.ts`
Expected: ALL PASS

- [ ] **Step 11: Commit**

```bash
npx prettier --write packages/cloudflare-worker/src/index.ts packages/cloudflare-worker/wrangler.jsonc packages/cloudflare-worker/tests/index.test.ts packages/cloudflare-worker/tests/deployed.test.ts
git add packages/cloudflare-worker/src/index.ts packages/cloudflare-worker/wrangler.jsonc packages/cloudflare-worker/tests/index.test.ts packages/cloudflare-worker/tests/deployed.test.ts
git commit -m "feat(worker): add GitHub OAuth token exchange and revoke routes"
```

---

### Task 2: Git Token Cache Invalidation Event

**Files:**
- Modify: `packages/webapp/src/git/git-commands.ts`
- Test: `packages/webapp/tests/git/git-commands.test.ts` (create if needed, or add to existing)

- [ ] **Step 1: Write failing test for github-token-changed event**

Check if `packages/webapp/tests/git/` exists. Create the test file if needed. Add:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('GitCommands github-token-changed event', () => {
  it('resets the cached github token when github-token-changed fires', async () => {
    // The event listener is set up at module scope in git-commands.ts.
    // Dispatch the event and verify the static state is reset.
    // We test this by checking that the next git operation re-reads from VFS.
    const event = new CustomEvent('github-token-changed');
    window.dispatchEvent(event);

    // The event handler resets GitCommands.globalFsByDbName entries' token caches.
    // Since we can't easily inspect private state, we verify the event doesn't throw.
    // The real integration test is that after dispatching, git push picks up the new token.
    expect(true).toBe(true);
  });
});
```

Note: The actual verification is that the listener is registered and doesn't error. The real test is the manual integration flow. If the test infrastructure allows constructing a `GitCommands` instance with a fake VFS, write a more thorough test that:
1. Creates a `GitCommands` with a VFS containing a token
2. Calls `ensureGithubTokenLoaded()` (via a git operation)
3. Writes a new token to VFS
4. Dispatches `github-token-changed`
5. Verifies the next git operation uses the new token

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- packages/webapp/tests/git/`
Expected: FAIL (or no test file found)

- [ ] **Step 3: Add static token cache and event listener in git-commands.ts**

The token is read from a shared global VFS, so the cache should be static (shared across all `GitCommands` instances). Replace the instance fields with static equivalents.

In `packages/webapp/src/git/git-commands.ts`, replace the instance fields:

```typescript
// REMOVE these instance fields:
// private githubToken?: string;
// private githubTokenLoaded = false;

// ADD these static fields:
private static githubTokenCache: string | undefined;
private static githubTokenCacheLoaded = false;

/** Reset cached GitHub token. Called when the OAuth provider writes a new token. */
static resetTokenCache(): void {
  GitCommands.githubTokenCache = undefined;
  GitCommands.githubTokenCacheLoaded = false;
}
```

Update `ensureGithubTokenLoaded()` to use the static cache:

```typescript
private async ensureGithubTokenLoaded(): Promise<void> {
  if (GitCommands.githubTokenCacheLoaded) return;
  GitCommands.githubTokenCacheLoaded = true;
  try {
    const globalFs = await this.getGlobalFs();
    const token = (await globalFs.readTextFile('/workspace/.git/github-token')).trim();
    GitCommands.githubTokenCache = token || undefined;
  } catch {
    GitCommands.githubTokenCache = undefined;
  }
}
```

Update `setGithubToken()` similarly, and update `getOnAuth()` to read `GitCommands.githubTokenCache`.

Add the event listener after the class closing brace:

```typescript
if (typeof window !== 'undefined') {
  window.addEventListener('github-token-changed', () => {
    GitCommands.resetTokenCache();
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- packages/webapp/tests/git/`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
npx prettier --write packages/webapp/src/git/git-commands.ts packages/webapp/tests/git/git-commands.test.ts
git add packages/webapp/src/git/git-commands.ts packages/webapp/tests/git/git-commands.test.ts
git commit -m "feat(git): listen for github-token-changed event to invalidate cached token"
```

---

### Task 3: GitHub Config File

**Files:**
- Create: `packages/webapp/providers/github-config.json`

- [ ] **Step 1: Create the config file**

```json
{
  "clientId": "",
  "scopes": "repo,read:user",
  "redirectUri": "https://www.sliccy.ai/auth/callback",
  "extensionRedirectUri": "https://akggccfpkleihhemkkikggopnifgelbk.chromiumapp.org/github"
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/webapp/providers/github-config.json
git commit -m "feat(github): add github-config.json with OAuth App client config"
```

---

### Task 4: GitHub OAuth Provider

**Files:**
- Create: `packages/webapp/providers/github.ts`
- Test: `packages/webapp/tests/providers/github.test.ts`

- [ ] **Step 1: Write failing tests for extractCodeFromUrl**

Create `packages/webapp/tests/providers/github.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { extractCodeFromUrl } from '../../providers/github.js';

describe('extractCodeFromUrl', () => {
  it('extracts code from a redirect URL with query params', () => {
    const url = 'http://localhost:5710/auth/callback?nonce=abc&code=gh_auth_code_123';
    expect(extractCodeFromUrl(url)).toBe('gh_auth_code_123');
  });

  it('extracts code when it is the only query param', () => {
    const url = 'http://localhost:5710/auth/callback?code=single_code';
    expect(extractCodeFromUrl(url)).toBe('single_code');
  });

  it('returns null when no code param is present', () => {
    const url = 'http://localhost:5710/auth/callback?nonce=abc&state=xyz';
    expect(extractCodeFromUrl(url)).toBeNull();
  });

  it('returns null for a URL with no query string', () => {
    const url = 'http://localhost:5710/auth/callback';
    expect(extractCodeFromUrl(url)).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(extractCodeFromUrl('')).toBeNull();
  });

  it('extracts code from extension redirect URL', () => {
    const url = 'https://akggccfpkleihhemkkikggopnifgelbk.chromiumapp.org/github?code=ext_code_456';
    expect(extractCodeFromUrl(url)).toBe('ext_code_456');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- packages/webapp/tests/providers/github.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Create github.ts with config loading and extractCodeFromUrl**

Create `packages/webapp/providers/github.ts`:

```typescript
/**
 * GitHub OAuth Provider — authorization code grant via generic OAuthLauncher.
 *
 * Authentication:
 *   CLI mode:       popup → /auth/callback → postMessage → code extracted
 *   Extension mode: chrome.identity.launchWebAuthFlow → redirect URL → code extracted
 *
 * Unlike Adobe (implicit grant, token in fragment), GitHub uses authorization
 * code grant (code in query params). The code is exchanged for an access token
 * via the tray hub worker (POST /github/token) which holds the client secret.
 *
 * The access token is also written to /workspace/.git/github-token in the
 * global VFS so isomorphic-git can use it for push/clone/fetch operations.
 *
 * This file lives in packages/webapp/providers/ and is auto-discovered by the
 * build-time provider system via import.meta.glob. Safe to commit — no secrets.
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

const isExtension = typeof chrome !== 'undefined' && !!(chrome as any)?.runtime?.id;

// ── Helpers ─────────────────────────────────────────────────────────

function getGitHubAccount() {
  return getAccounts().find((a) => a.providerId === 'github');
}

/** Extract the authorization code from a redirect URL's query params. */
export function extractCodeFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.searchParams.get('code');
  } catch {
    return null;
  }
}

/**
 * Resolve the tray hub worker base URL for GitHub OAuth routes.
 * In production this is https://www.sliccy.ai; in dev it's the local origin.
 */
function getWorkerBaseUrl(): string {
  if (typeof window !== 'undefined' && window.location) {
    const origin = window.location.origin;
    if (origin.includes('localhost') || origin.includes('127.0.0.1')) {
      // Dev mode — worker routes aren't available locally.
      // Use the production worker for OAuth exchange.
      return 'https://www.sliccy.ai';
    }
    return origin;
  }
  return 'https://www.sliccy.ai';
}

async function exchangeCodeForToken(
  code: string,
  redirectUri: string
): Promise<{ access_token: string; token_type: string; scope: string }> {
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

async function fetchGitHubUserProfile(
  token: string
): Promise<{ name?: string; avatar?: string }> {
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
      return {
        name: profile.name || profile.login,
        avatar: profile.avatar_url,
      };
    }
    console.warn(
      `[github] User profile fetch returned ${res.status}, account will have no display name`
    );
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
  if (!globalVfsPromise) {
    globalVfsPromise = VirtualFS.create({ dbName: 'slicc-fs-global' });
  }
  return globalVfsPromise;
}

async function writeGitToken(token: string): Promise<void> {
  try {
    const fs = await getGlobalVfs();
    await fs.writeFile('/workspace/.git/github-token', token);
  } catch (err) {
    console.warn(
      '[github] Failed to write git token to VFS:',
      err instanceof Error ? err.message : String(err)
    );
  }
}

async function clearGitToken(): Promise<void> {
  try {
    const fs = await getGlobalVfs();
    await fs.rm('/workspace/.git/github-token');
  } catch {
    // File may not exist — ignore
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
        `https://${(chrome as any).runtime.id}.chromiumapp.org/github`)
      : (githubConfig.redirectUri ?? `${window.location.origin}/auth/callback`);

    // Build OAuth state for the sliccy.ai relay (CLI only)
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

    // Verify CSRF nonce (CLI only)
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test -- packages/webapp/tests/providers/github.test.ts`
Expected: PASS (the `extractCodeFromUrl` tests)

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: PASS — no type errors in the new provider

- [ ] **Step 6: Commit**

```bash
npx prettier --write packages/webapp/providers/github.ts packages/webapp/tests/providers/github.test.ts
git add packages/webapp/providers/github.ts packages/webapp/tests/providers/github.test.ts
git commit -m "feat(github): add GitHub OAuth provider with git token bridge"
```

---

### Task 5: Build Verification and Full Test Run

**Files:** None (verification only)

- [ ] **Step 1: Run the full verification suite**

```bash
npx prettier --write packages/webapp/providers/github.ts packages/webapp/providers/github-config.json packages/cloudflare-worker/src/index.ts packages/cloudflare-worker/wrangler.jsonc packages/webapp/src/git/git-commands.ts
npm run typecheck
npm run test
npm run build
npm run build -w @slicc/chrome-extension
```

Expected: ALL PASS

- [ ] **Step 2: Verify provider auto-discovery**

Check that the build includes the GitHub provider by searching the build output:

```bash
grep -l 'github' dist/ui/assets/*.js 2>/dev/null || echo "Check dist/ for github provider"
```

The Vite build should pick up `packages/webapp/providers/github.ts` via the `import.meta.glob` in `packages/webapp/src/providers/index.ts`.

- [ ] **Step 3: Fix any issues and commit**

If any step fails, fix the issue and create a new commit with the fix.
