# GitHub OAuth Provider

Add a GitHub connector provider to Slicc, enabling OAuth-based authentication for git operations, GitHub API access, and user identity display.

## Goals

1. OAuth login via GitHub OAuth App (authorization code grant)
2. Git bridge: auto-write token to `/workspace/.git/github-token` for isomorphic-git
3. GitHub API access: standard user token for repos, issues, PRs via `api.github.com`

## Non-Goals

- GitHub Models marketplace (LLM provider) -- future work
- GitHub App (fine-grained permissions, expiring tokens) -- future migration if needed
- Shell commands for GitHub API (`github repos list`, etc.) -- additive, separate effort
- Proxying GitHub API calls through the worker

## Architecture

### OAuth Flow

GitHub OAuth App uses authorization code grant (`response_type=code`), unlike Adobe's implicit grant (`response_type=token`). The code-to-token exchange requires a server-side secret.

```
User clicks "Login with GitHub"
  -> Browser opens github.com/login/oauth/authorize?client_id=...&scope=repo,read:user
  -> User authorizes
  -> GitHub redirects to sliccy.ai/auth/callback?code=ABC123&state=...
  -> Existing relay page redirects to localhost (same relay Adobe uses)
  -> Provider extracts `code` from query params
  -> Provider POSTs code to tray hub worker: POST /github/token
  -> Worker exchanges code + client_secret for access_token via GitHub API
  -> Worker returns { access_token, scope, token_type }
  -> Provider fetches user profile from api.github.com/user
  -> Provider saves account via saveOAuthAccount()
  -> Provider writes token to /workspace/.git/github-token (git bridge)
  -> Provider dispatches `github-token-changed` event
```

Extension mode: `chrome.identity.launchWebAuthFlow` handles the redirect with `extensionRedirectUri` set to `https://{extId}.chromiumapp.org/github`.

### Git Token Bridge

The provider writes the OAuth token to the same VFS path that `git-commands.ts` already reads: `/workspace/.git/github-token` in the global VFS (`slicc-fs-global`).

Cache invalidation: `git-commands.ts` caches the token in memory (`githubTokenLoaded` flag). The provider dispatches a `github-token-changed` custom event on `window` after writing or deleting the token. `GitCommands` listens and resets its cache.

No changes to the git auth plumbing itself -- `getOnAuth()` already returns `{ username: 'x-access-token', password: token }` for isomorphic-git.

### Logout

Revoking a GitHub OAuth token requires the client secret (Basic auth with `client_id:client_secret`). The provider calls `POST /github/revoke` on the tray hub worker, which makes the actual revocation call to GitHub.

```
Provider -> POST /github/revoke { access_token }
Worker -> DELETE api.github.com/applications/{client_id}/token (Basic auth)
Provider -> clear saveOAuthAccount()
Provider -> delete /workspace/.git/github-token
Provider -> dispatch github-token-changed event
```

## Files

### Create

**`packages/webapp/providers/github.ts`** -- OAuth provider module.

Exports `config: ProviderConfig` with:
- `id: 'github'`
- `isOAuth: true`
- `requiresApiKey: false`
- `requiresBaseUrl: false`
- `onOAuthLogin()` -- build authorize URL, call launcher, exchange code via worker, fetch profile, save account, write git token, dispatch event
- `onOAuthLogout()` -- call worker revoke route, clear account, delete git token, dispatch event

No `register()` (not an LLM provider), no `getModelIds()` (no models), no silent renewal (tokens don't expire).

Internal functions:
- `extractCodeFromUrl(url: string): string | null` -- parse `?code=` from redirect URL query params
- `exchangeCodeForToken(code: string, redirectUri: string): Promise<{ access_token: string; scope: string; token_type: string }>` -- POST to worker `/github/token`
- `fetchGitHubUserProfile(token: string): Promise<{ name: string; avatar: string }>` -- GET `api.github.com/user`
- `writeGitToken(token: string): Promise<void>` -- open global VFS via `VirtualFS.create({ dbName: 'slicc-fs-global' })`, write to `/workspace/.git/github-token`
- `clearGitToken(): Promise<void>` -- delete from global VFS (same instance)
- `dispatchTokenChanged(): void` -- dispatch `github-token-changed` on window

VFS access: the provider opens the same IndexedDB-backed global VFS that `GitCommands` uses (`slicc-fs-global`). This is safe -- LightningFS handles concurrent access to the same database. Adobe's provider doesn't need VFS (tokens in localStorage only); GitHub's provider does because git auth reads from a VFS file.

**`packages/webapp/providers/github-config.json`** -- Client config (no secrets).

```json
{
  "clientId": "",
  "scopes": "repo,read:user",
  "redirectUri": "https://www.sliccy.ai/auth/callback",
  "extensionRedirectUri": "https://akggccfpkleihhemkkikggopnifgelbk.chromiumapp.org/github"
}
```

`clientId` populated after the GitHub OAuth App is created. Provider throws a clear error if empty.

### Modify

**`packages/cloudflare-worker/src/index.ts`** -- Add two routes.

`POST /github/token`:
- Body: `{ "code": "...", "redirect_uri": "..." }`
- Reads `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` from worker env
- POSTs to `https://github.com/login/oauth/access_token` with `Accept: application/json`
- Returns GitHub's response as-is: `{ "access_token": "...", "token_type": "bearer", "scope": "..." }`
- CORS: allow `sliccy.ai` + `localhost:*`

`POST /github/revoke`:
- Body: `{ "access_token": "..." }`
- Calls `DELETE https://api.github.com/applications/{client_id}/token` with Basic auth (`client_id:client_secret`)
- Returns `204` on success, forwards error on failure

**`packages/cloudflare-worker/wrangler.jsonc`** -- Add `GITHUB_CLIENT_ID` as a plain var.

`GITHUB_CLIENT_SECRET` is set via `npx wrangler secret put GITHUB_CLIENT_SECRET` (not in config).

**`packages/webapp/src/git/git-commands.ts`** -- Listen for `github-token-changed` event.

Add event listener that resets `githubToken = undefined` and `githubTokenLoaded = false`. The next git operation re-reads from VFS.

### Unchanged

- `packages/webapp/src/providers/oauth-service.ts` -- generic launcher, works as-is
- `packages/webapp/src/ui/provider-settings.ts` -- already handles OAuth providers
- `packages/webapp/src/providers/types.ts` -- `ProviderConfig` has all needed fields
- `packages/webapp/src/ui/main.ts` / `packages/chrome-extension/src/offscreen.ts` -- auto-discovery handles registration

## Scopes

| Scope | Grants | Reason |
|---|---|---|
| `repo` | Full access to private and public repos | Git push/clone/fetch on private repos, GitHub API (issues, PRs, file contents) |
| `read:user` | Read user profile | Display name and avatar in account UI |

Not requested: `delete_repo`, `admin:org`, `gist`, `workflow`. Scopes can be expanded later -- existing tokens would need re-authorization.

## Manual Setup (Not Code)

1. Create GitHub OAuth App at `github.com/settings/developers` under `ai-ecoverse` org
   - Authorization callback URL: `https://www.sliccy.ai/auth/callback`
   - Homepage URL: `https://www.sliccy.ai`
2. Copy client ID into `github-config.json`
3. Set worker secret: `npx wrangler secret put GITHUB_CLIENT_SECRET`

## CORS

The `/github/token` and `/github/revoke` worker routes need CORS headers:
- `Access-Control-Allow-Origin`: `https://www.sliccy.ai` (production), `http://localhost:*` (dev)
- `Access-Control-Allow-Methods`: `POST, OPTIONS`
- `Access-Control-Allow-Headers`: `Content-Type`
- Handle `OPTIONS` preflight requests

## Error Handling

- Empty `clientId` in config: throw with message guiding to github-config.json setup
- User cancels OAuth popup: `launcher()` returns null, login aborts silently
- Worker code exchange fails: surface GitHub's `error_description` to console, abort login
- Profile fetch fails: proceed with login (account has no display name/avatar, same as Adobe's pattern)
- Git token write fails: log warning, login still succeeds (OAuth account saved, git bridge is best-effort)
- Revocation fails on logout: log warning, clear local state anyway (same as Adobe's pattern)

## Testing

- Unit test `extractCodeFromUrl()` with valid/invalid redirect URLs
- Unit test worker routes with mocked GitHub API responses (success, error, bad code)
- Integration: verify `github-token-changed` event triggers cache reset in `GitCommands`
- Manual: full OAuth flow in CLI mode and extension mode
