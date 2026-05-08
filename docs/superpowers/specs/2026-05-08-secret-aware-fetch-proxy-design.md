# Secret-aware fetch proxy in CLI and extension

**Status:** Design  
**Date:** 2026-05-08  
**Branch:** `feat/git-auth-secrets-bridge`

## Context

slicc has a secret-management story (`docs/secrets.md`) that lets users put API keys and tokens in `~/.slicc/secrets.env` (CLI) or `chrome.storage.local` (extension), with the agent only ever seeing deterministic masked values. The fetch proxy on the CLI unmasks at the network boundary if the destination domain is in the secret's allowlist. The model works for `Authorization: Bearer …`, `X-API-Key: …`, JSON body fields, query params — anything where the masked value sits as a literal substring of the outgoing request.

Three cracks in the model surfaced in production use:

1. **HTTP Basic auth (the git case).** isomorphic-git authenticates with `Authorization: Basic base64('x-access-token:<token>')`. When `<token>` is masked, the masked value disappears inside the base64 blob and the literal-substring matcher misses it. Upstream gets the masked PAT and 401s. Bruce hit this trying to `git push` a skill repo to GitHub from inside slicc and worked around it by writing the real PAT to a file the agent could `cat`.

2. **The extension has no fetch proxy at all.** Today CLAUDE.md says "Network behavior differs by runtime: CLI routes git/fetch traffic through `/api/fetch-proxy`; the extension uses direct fetch." That's correct — the extension has only `mount.s3-sign-and-forward` and `mount.da-sign-and-forward` SW handlers for specific mount-backend traffic. Generic agent-initiated HTTP from the extension has no secret injection; `docs/secrets.md` documents this with: _"For arbitrary HTTP secret injection (e.g. $GITHUB_TOKEN in a curl call from bash), the extension still has no equivalent — that's the fetch-proxy injection, which requires a server backend."_

3. **`oauth-token` returns the real OAuth token to agent stdout.** `oauth-token github` prints the raw access token. Anything the agent does with it — `curl -H "Authorization: Bearer $(oauth-token github)" …` — happens with the real value in the agent's reach. Different threat model than `.env` secrets, undocumented, agent can `cat`/echo/exfil.

This spec closes all three.

## Goals

After this lands:

1. **`git push`** of a private repo works in both CLI and extension when the user has put a fine-grained GitHub PAT in the secret store (`.env` for CLI, options-page tab in extension). The agent never holds the real PAT.
2. **`curl -H "Authorization: Bearer $(oauth-token github)" …`** works in both modes. `oauth-token` returns a masked Bearer token; the proxy/SW unmasks at the network boundary; the agent never holds the real OAuth token.
3. **`upskill https://github.com/me/private-skill`** works against private repos, with PAT injection at the network boundary. (The most consequential of the direct-fetch migrations.)
4. **Generic `curl https://x-access-token:$GITHUB_TOKEN@github.com/foo`** with URL-embedded credentials works (small but explicit case).
5. The same `<NAME>` + `<NAME>_DOMAINS` schema works across `.env`, `chrome.storage.local`, and (new) the in-memory OAuth replica store on node-server.

## Non-goals (v1)

- **Streaming.** Both request and response bodies are buffered through the proxy/SW. Today's CLI proxy already buffers requests and streams responses; the extension SW will buffer both. Documented size limit, deferred to a follow-up. Multi-GB git clones / file downloads are out of scope.
- **Cancel-on-disconnect** for SW fetches. Fire-and-forget like the existing mount handlers.
- **Full OAuth-token storage move into the secret store** (Option Y). v1 keeps OAuth tokens dual-stored: webapp localStorage (for fast LLM streaming) + proxy-side replica (for unmask). Follow-up PR can unify.
- **API keys.** Stay in `slicc_accounts` localStorage; not agent-exposed today, no shell surface. Migrating them to the secret store is consistent but not load-bearing.
- **Multi-Authorization-value headers, Digest, NTLM.**
- **Glob-pattern OAuth domain config.** Use exact + simple `*.host` wildcard.
- **The handful of supplemental commands that load static assets via direct `fetch()`** (`magick-wasm.ts`, Pyodide loader). Asset-loading is not user-driven; leave direct.

## Threat model recap

The model we're enforcing for every secret in the system:

- The agent (offscreen document, bash WASM, sandboxed iframes, scoops) never holds the real value of any configured secret.
- The agent sees a deterministic masked value (HMAC-SHA256, format-preserving) it can use in shell commands as if it were real.
- The masked value is unmasked **only** at the network boundary (`/api/fetch-proxy` in CLI, `fetch-proxy.fetch` SW handler in extension), **only** if the URL host matches the secret's `_DOMAINS` allowlist.
- A masked value bound for a non-allowlisted domain in a request header → 403. In a request body → pass-through (the masked value is harmless, and rejecting would break the agent's own LLM API calls which contain masked values in conversation context — same rule as today).
- Real values echoed back in upstream response bodies/headers are scrubbed back to masked before reaching the agent.

## Architecture

### File map

```
NEW
├── packages/webapp/src/core/secrets-pipeline.ts
│   Platform-agnostic mask/unmask/scrub. Used by both node-server proxy
│   and chrome-extension SW. Includes new helpers:
│     - unmaskAuthorizationBasic(value, ctx) → string | { forbidden }
│     - unmaskUrlCredentials(url, ctx) → string | { forbidden }
│   plus wraps the existing literal-substring path. Exposes a SecretGetter
│   interface (platform-injected).
│
└── packages/chrome-extension/src/fetch-proxy-shared.ts
    Pure SW handler logic, extracted from service-worker.ts for testability.
    Inputs: { url, method, headers, body }, SecretGetter.
    Outputs: { status, headers, bodyBase64 }.
    Wraps secrets-pipeline; performs upstream fetch; scrubs response.

REFACTORED
├── packages/node-server/src/secrets/proxy-manager.ts
│   Becomes a thin wrapper around secrets-pipeline.
│   Holds two secret stores in a chained list:
│     1. read-only EnvSecretStore (unchanged; .env-loaded)
│     2. NEW writable in-memory OauthSecretStore (populated by webapp)
│   unmask consults both; same domain enforcement.
│
├── packages/node-server/src/secrets/oauth-secret-store.ts (NEW)
│   In-memory writable store. set(name, value, domains) / delete(name) / list().
│   Process-local, lost on restart (webapp re-pushes on bootstrap).
│
├── packages/chrome-extension/src/service-worker.ts
│   New message handler: `fetch-proxy.fetch`. Mirrors mount.* shape:
│     in:  { url, method, headers, body }
│     out: { status, headers, bodyBase64 }  via single sendResponse
│
├── packages/webapp/src/shell/  (just-bash SecureFetch wrapper)
│   The CENTRAL hook for agent-side outbound HTTP.
│     CLI branch:       → POST /api/fetch-proxy        (unchanged)
│     Extension branch: → chrome.runtime.sendMessage('fetch-proxy.fetch', ...)
│   Gains a small pre-send + post-receive OAuth-pipeline pass.
│   git-http.ts, node-fetch-adapter, bash curl/wget/fetch all flow through this.
│
├── packages/webapp/src/shell/supplemental-commands/oauth-token-command.ts
│   Returns masked Bearer (mask() on the real token, prefix-preserving).
│
├── packages/webapp/src/providers/oauth-service.ts (modified)
│   On login/refresh/logout: writes to local `slicc_accounts` AS BEFORE
│   AND syncs to proxy-side store:
│     CLI:        POST /api/secrets/oauth-update {providerId, token, domains}
│                 DELETE /api/secrets/oauth/:providerId
│     Extension:  chrome.storage.local.set/remove
│   Sync errors are logged but do not block login (fail-open for UX).
│
└── packages/node-server/src/index.ts
    New endpoints: POST /api/secrets/oauth-update,
                   DELETE /api/secrets/oauth/:providerId.
    (No GET /list — webapp is source of truth and re-pushes are idempotent.)

ADDITIONS
├── packages/webapp/src/providers/types.ts
│   ProviderConfig gains `oauthTokenDomains?: string[]`.
│
├── packages/webapp/src/providers/built-in/*.ts
│   Set oauthTokenDomains for built-in OAuth providers (adobe, github).
│
├── Bash-env population in extension mode
│   Mirror CLI: when scoop init builds the WasmShell env, populate masked
│   values from chrome.storage.local secrets. Today extension agent's env is empty.
│
├── docs/secrets.md updates
│   - Platform-support matrix: extension flips from "Requires server backend"
│     to "✅ via SW fetch proxy".
│   - New section explaining the dual-storage OAuth model.
│   - Migration note for users coming from the file-on-disk PAT workaround.
│
└── Direct-fetch migration in supplemental-commands
    See "Direct-fetch migration scope" below.
```

### CLI request flow (git push)

```
Agent shell:
  $ git config github.token $GITHUB_TOKEN     # $GITHUB_TOKEN is masked
  $ git push origin main

webapp:
  isomorphic-git → getOnAuth → { username: 'x-access-token', password: <masked> }
                 → Authorization: Basic base64('x-access-token:<masked>')

git-http.ts CLI branch → SecureFetch → POST /api/fetch-proxy
                                       X-Target-URL: https://github.com/...
                                       Authorization: Basic <b64>

node-server proxy:
  proxy-manager.unmaskHeaders {
    secrets-pipeline.unmaskAuthorizationBasic detects Basic, decodes,
    runs masked→real on user:pass. Source secret found in EnvSecretStore.
    Domain check uses targetHostname. Re-encodes header.
  }
  Derives unmasked targetUrl from the (possibly-mutated) X-Target-URL header.
  fetch(unmaskedTargetUrl, fetchInit) → real Basic upstream → 200

  Stream response back; scrubResponseBody/Headers replaces real→masked
  if upstream echoed any secret value. Agent gets clean response.
```

### CLI request flow (oauth-token + curl)

```
Agent shell:
  $ curl -H "Authorization: Bearer $(oauth-token github)" https://api.github.com/user

oauth-token-command.ts:
  Reads real token from webapp's getOAuthAccountInfo.
  Computes masked = mask('oauth.github.token', realToken).
  Prints masked to stdout.

curl (just-bash supplemental):
  Authorization: Bearer <masked> sent through SecureFetch → /api/fetch-proxy

node-server proxy:
  unmaskHeaders → existing literal-substring path catches Bearer <masked>.
  Source secret found in OauthSecretStore (webapp pushed it at login).
  Domain check uses targetHostname (api.github.com matches *.github.com).
  Authorization rewritten to Bearer <real>.
  Upstream → 200.

  Response scrubbed.
```

### Extension request flow (git push)

```
isomorphic-git → getOnAuth → ... Authorization: Basic base64(...)

git-http.ts extension branch → SecureFetch.extension →
  chrome.runtime.sendMessage('fetch-proxy.fetch', { url, method, headers, body })

SW handler (fetch-proxy-shared):
  Read SecretGetter view of chrome.storage.local.
  Run secrets-pipeline.unmaskHeaders (same module as CLI side).
  Run unmaskUrlCredentials on url (if userinfo present).
  fetch(url, ...) → upstream.
  Read response body to ArrayBuffer; scrubResponseBody/Headers; encode bodyBase64.
  sendResponse({ status, headers, bodyBase64 }).

git-http.ts:
  Decode bodyBase64 → wrap as single-chunk AsyncIterableIterator<Uint8Array>
  → return to isomorphic-git.
```

### Extension OAuth login (sync)

```
User clicks Login on options page → chrome.identity.launchWebAuthFlow → token returned.

oauth-service:
  - Save to webapp's slicc_accounts localStorage (UNCHANGED — keeps LLM streaming fast).
  - chrome.storage.local.set({
      'oauth.github.token': realToken,
      'oauth.github.token_DOMAINS': '*.github.com,api.github.com',
    }).
  - SW now sees the token via chromeStorageSecretGetter on next request.
```

### CLI OAuth login (sync)

```
chrome popup → /auth/callback → postMessage → webapp receives token.

oauth-service:
  - Save to webapp's slicc_accounts localStorage (UNCHANGED).
  - POST /api/secrets/oauth-update { providerId: 'github', token: realToken,
                                     domains: ['*.github.com', 'api.github.com'] }
  - node-server's OauthSecretStore now has the entry.
  - On next /api/fetch-proxy call, proxy unmasks against both stores.
```

### Bootstrap recovery (CLI restart)

```
Webapp init (after a node-server restart or first connection):
  Read all OAuth accounts from local slicc_accounts.
  For each non-expired entry: POST /api/secrets/oauth-update (idempotent).

  No GET endpoint needed; webapp is the source of truth and the push is
  idempotent — the in-memory store either accepts the new value or
  overwrites with the same. Simpler than diff-based reconciliation.
```

### Bootstrap recovery (extension reload)

`chrome.storage.local` persists; no re-sync needed.

## Implementation phases

Ordered for incremental landing. Each phase ends in a green commit.

### Phase 1: Extract `secrets-pipeline` (shared core)

- Move `unmaskHeaders` / `unmaskBody` / `scrubResponse{Headers,Body}` from `packages/node-server/src/secrets/proxy-manager.ts` into a new `packages/webapp/src/core/secrets-pipeline.ts`.
- Define the `SecretGetter` interface (`get(name)`, `list()`).
- `proxy-manager.ts` becomes a thin wrapper that injects `EnvSecretStore` as the SecretGetter.
- All existing CLI tests under `packages/node-server/tests/secrets/` keep passing unchanged.
- New tests under `packages/webapp/tests/core/secrets-pipeline.test.ts` for the platform-agnostic surface.

### Phase 2: CLI Basic-auth + URL-embedded credential support

- In `secrets-pipeline.ts` add:
  - `unmaskAuthorizationBasic(value, ctx)` — detect `^Basic <b64>$`, decode, run masked→real on `user:pass`, re-encode. Domain enforcement on decoded form.
  - `unmaskUrlCredentials(url, ctx)` — parse URL, replace masked values in userinfo if domain matches.
- `unmaskHeaders` calls the Basic helper for `authorization` headers (case-insensitive).
- `index.ts` `/api/fetch-proxy` derives `targetUrl` from the (post-unmask) header copy, and passes the URL through `unmaskUrlCredentials` before `fetch()`.
- Tests under `packages/node-server/tests/secrets/proxy-manager.test.ts` (extended) and `secrets-pipeline.test.ts`.

### Phase 3: Extension SW fetch proxy

- New `packages/chrome-extension/src/fetch-proxy-shared.ts`:
  - `executeFetchProxy({url, method, headers, body}, secretGetter): Promise<{status, headers, bodyBase64}>`
  - Calls `secrets-pipeline.unmaskHeaders` + `unmaskBody` + `unmaskUrlCredentials`.
  - Performs `fetch(...)`; reads response to ArrayBuffer; scrubs; encodes.
- New SW message handler `fetch-proxy.fetch` registered in `service-worker.ts`. Reads `chrome.storage.local` via existing `chromeStorageSecretGetter`. Returns single sendResponse.
- Update `packages/webapp/src/shell/` `SecureFetch` extension branch: route through `chrome.runtime.sendMessage('fetch-proxy.fetch', ...)`.
- Update `packages/webapp/src/git/git-http.ts` extension branch: same route. The extension-branch logic in `git-http.ts` reduces to a thin shim over SecureFetch; the proxy hand-off lives entirely in SecureFetch. (Fold rather than duplicate.)
- Bash env population: extend the existing CLI env-injection (the code that calls `getMaskedEntries`) to also run in extension mode, reading from `chrome.storage.local` via `chromeStorageSecretGetter`.
- Tests under `packages/chrome-extension/tests/fetch-proxy-shared.test.ts` and `service-worker.test.ts` (extended).

### Phase 4: OAuth masking + dual-storage sync

- `packages/webapp/src/providers/types.ts`: add `oauthTokenDomains?: string[]` to `ProviderConfig`.
- Set `oauthTokenDomains` on each existing built-in OAuth provider config:
  - `packages/webapp/providers/github.ts` → `['*.github.com', 'api.github.com', 'raw.githubusercontent.com']`
  - `packages/webapp/providers/adobe.ts` (or wherever the Adobe IMS provider lives) → Adobe IMS hosts.
  - Other OAuth-isOAuth providers in `packages/webapp/providers/` and `packages/webapp/src/providers/built-in/` get audited the same way.
- `packages/webapp/src/shell/supplemental-commands/oauth-token-command.ts`: mask the token before printing. Use a synthetic name like `oauth.<providerId>.token` for the mask key.
- `packages/webapp/providers/github.ts` line ~15: the existing auto-write of the OAuth token to `/workspace/.git/github-token` becomes a write of the **masked** token. The agent can `cat` the file but only sees the mask; isomorphic-git reads it (via `git-commands.ts:loadGithubToken`), builds `Authorization: Basic base64('x-access-token:<masked>')`, the Basic-aware unmask at the proxy/SW boundary turns it into the real token upstream. **Net result: `git push` works automatically after GitHub OAuth login, no explicit `git config github.token` step required.**
- `packages/webapp/src/providers/oauth-service.ts`: add sync logic. After login/refresh/logout, push to `/api/secrets/oauth-update` (CLI) or `chrome.storage.local` (extension). Errors logged but non-blocking.
- `packages/node-server/src/secrets/oauth-secret-store.ts` (new): writable in-memory store.
- `packages/node-server/src/secrets/proxy-manager.ts`: chain OauthSecretStore + EnvSecretStore in unmask lookup.
- `packages/node-server/src/index.ts`: new endpoints `POST /api/secrets/oauth-update` and `DELETE /api/secrets/oauth/:providerId`. Localhost-only (no extra auth — same posture as the rest of node-server's local-only API).
- Bootstrap: webapp on init pushes all currently-valid OAuth tokens to `/api/secrets/oauth-update` (idempotent).
- Tests for: masked oauth-token output, sync on login/refresh/logout, bootstrap re-push, end-to-end OAuth Bearer through proxy.

### Phase 5: Direct-fetch migration

Audit + migrate the user-driven direct-fetch sites. Leave asset loaders alone.

| File                     | Sites   | Action                                                                                                                                                          |
| ------------------------ | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `magick-wasm.ts:70`      | 1       | **Leave** (WASM asset)                                                                                                                                          |
| `man-command.ts:42`      | 1       | **Migrate** to SecureFetch                                                                                                                                      |
| `models-command.ts:50`   | 1       | **Migrate** (verify URL is external)                                                                                                                            |
| `crontask-command.ts:94` | 1       | **Leave** (`/api/crontasks`, local)                                                                                                                             |
| `webhook-command.ts:59`  | 1       | **Leave** (`/api/webhooks`, local)                                                                                                                              |
| `upskill-command.ts`     | 7       | **Migrate all** — most important. Each fetch reviewed individually.                                                                                             |
| `node-command.ts`        | several | **Audit carefully**; sandbox already has its own fetch-proxy handler. Verify it routes through SecureFetch in extension mode and that we don't duplicate logic. |

For each migrated site: replace `fetch(url, init)` with the equivalent SecureFetch call (`ctx.fetch` for shell-context commands; the appropriate alternative for non-shell paths). Add tests where the site's HTTP behavior is non-trivial (especially `upskill-command.ts`).

Migration policy added to `docs/secrets.md`: agent-context outbound HTTP routes through SecureFetch by default; asset-loading and local-API exceptions called out by name.

### Phase 6: Documentation

- `docs/secrets.md`:
  - Update platform-support matrix: extension flips to ✅ for arbitrary HTTP secret injection.
  - New "OAuth tokens as secrets" subsection explaining the masked-output model + dual-storage sync.
  - Migration note for users on the file-PAT workaround.
- Root `CLAUDE.md`: update the "Network behavior differs by runtime" line — both modes now have a fetch proxy.
- `packages/webapp/CLAUDE.md`, `packages/chrome-extension/CLAUDE.md`, `packages/node-server/CLAUDE.md`: small navigation-only updates.
- README.md: update if it mentions GitHub auth.

## Test strategy

Unit:

- `packages/webapp/tests/core/secrets-pipeline.test.ts` — Bearer (regression), Basic-auth-aware, URL-embedded credentials, scrub paths, domain enforcement edge cases (case-insensitive, glob patterns).
- `packages/node-server/tests/secrets/proxy-manager.test.ts` — refactor preservation; OauthSecretStore + EnvSecretStore chained lookup.
- `packages/node-server/tests/secrets/oauth-store-endpoints.test.ts` — POST/DELETE/GET round-trip; auth check; rejects unknown providers; rejects missing domains.
- `packages/chrome-extension/tests/fetch-proxy-shared.test.ts` — pure handler with mocked `chrome.storage.local` + `fetch`; assert real value never appears in any returned payload (string-search).
- `packages/chrome-extension/tests/service-worker.test.ts` — handler registration + dispatch.
- `packages/webapp/tests/shell/oauth-token-command.test.ts` — masked output; real never crosses stdout.
- `packages/webapp/tests/providers/oauth-sync.test.ts` — login/refresh/logout sync; bootstrap re-push.
- `packages/webapp/tests/shell/supplemental-commands/upskill-command.test.ts` — extended for SecureFetch routing on private repo URLs.

Integration:

- `packages/webapp/tests/git/git-auth-extension.test.ts` — mock isomorphic-git, mock SW handler, assert real PAT goes upstream + masked stays in agent context.
- `packages/webapp/tests/git/git-auth-cli.test.ts` — mock proxy, assert Basic-auth round-trip end-to-end.

Manual smoke (in PR body, not automated):

- CLI: `git push` against private repo with PAT in `.env`.
- CLI: `curl -H "Authorization: Bearer $(oauth-token github)" https://api.github.com/user`.
- Extension: same two flows after side-loading the build with PAT in options page / OAuth logged in.
- Extension: `upskill` against a private GitHub skill repo.

## Error handling

- Basic-auth decode failure (invalid base64, no colon) → leave header unchanged. No throw.
- URL-embedded creds parse failure → leave URL unchanged.
- Domain mismatch on header unmask → 403 (CLI) / equivalent error response (extension SW).
- Domain mismatch on body unmask → leave unchanged (matches existing).
- Upstream fetch error → propagate as response with the appropriate status.
- `chrome.storage.local` read error in SW → fail closed.
- OAuth sync error (network blip on push) → log, don't block login flow. Webapp re-tries on next request via 403 retry path.
- Real value echoed in upstream response body → scrubbed (existing behavior preserved).

## Risks

1. **Phase 5 (`upskill-command.ts` migration) regression risk.** This command has 7 fetch sites, complex flow (download → unzip → install). Migration is mostly mechanical, but a misrouted fetch could break public-repo skill installs. Mitigation: extensive test coverage on this command, manual smoke against both public and private repos.

2. **`node-command.ts` sandbox fetch-proxy.** This file already has its own fetch-proxy handler for the sandbox iframe. Care needed to ensure the sandbox path keeps working and the SecureFetch path covers the right cases. Mitigation: read carefully before touching; add a test asserting sandbox fetch still functions.

3. **OAuth sync race conditions.** Multiple SLICC instances against one node-server, last-write-wins on OauthSecretStore. Acceptable for v1 (single-user local tool), but flag in docs.

4. **Bash env population timing.** Env vars are set when the WasmShell is created. If the user adds a secret via options page after the shell starts, the new secret won't appear in `$GITHUB_TOKEN` until shell restart or scoop reload. Document this as v1 behavior; consider a "reload secrets" UI button as v2.

5. **The 50-100ms cost of pushing OAuth tokens to node-server on login** is acceptable. The 0ms cost of LLM streaming reading from webapp localStorage stays untouched.

6. **Service worker IIFE bundling.** The SW is built as a single IIFE (no shared chunks). The new `fetch-proxy-shared.ts` will be bundled into the SW. Since `secrets-pipeline.ts` is also imported by the SW, both modules need to compile cleanly into the IIFE bundle. Vite/esbuild should handle this; verify during impl.

## Open questions / follow-ups

- **OAuth storage unification (Option Y).** v1 keeps webapp localStorage as source of truth. A follow-up PR can collapse to a single store, removing the dual-storage sync. Worth doing eventually for architectural cleanliness.
- **API keys in the secret store.** Same shape as OAuth Y. Follow-up.
- **Streaming.** Both for large git pushes (request body) and large clones (response body). Currently buffered. Port-based streaming pattern is net-new infra; defer.
- **Cancel-on-disconnect** for SW fetches.
- **Multi-Authorization-value, Digest, NTLM** for the proxy.
- **Glob-pattern OAuth domain matching** beyond `*.host`.
- **A "reload secrets" UI button** in extension options that broadcasts to scoops to refresh env.

## Suggested PR shape

Six commits, mirroring the implementation phases. Run repo-wide gates before opening: `npx prettier --write` on every touched file, then `npm run typecheck`, `npm run test`, `npm run test:coverage`, `npm run build`, `npm run build -w @slicc/chrome-extension`. CI's `prettier --check` is the most common failure.
