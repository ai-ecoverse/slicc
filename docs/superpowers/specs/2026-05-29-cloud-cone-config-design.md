# Cloud cone configuration — model, secrets, and provider logins — design

## Goal

Let users configure a cloud cone's **LLM model**, **arbitrary secrets**, and **provider logins (API-key and OAuth)** instead of the current hardcoded "Adobe IMS + `adobe:claude-opus-4-6`". Two flows:

- **Create:** authenticate providers, enter secrets, and pick the model on the `/cloud` dashboard, then create the cone.
- **Resume:** see what's already provisioned (keys only), re-authenticate expired logins, and **add or delete** secrets/tokens, then resume.

This is an extension of the existing hosted-cone provisioning path, not a new runtime subsystem.

## Audience and scope

- **Audience**: existing cloud-cone users (Adobe employees, IMS-gated) on `sliccy.ai/cloud`.
- **In scope (v1)**: pick model; enter flat key/value secrets; provision API-key and interactive-OAuth provider logins via the dashboard's real browser; on resume view provisioned keys (names only), re-auth, **add and delete** secrets/tokens.
- **Out of scope**: see "Explicit non-goals".

## Background: current state and the constraints that shape this (all verified)

A cloud cone is an e2b sandbox running `node-server --hosted`; the webapp boots in `hosted-leader` mode. Today the worker ships only `ADOBE_IMS_TOKEN` (+ `_DOMAINS`) and the hosted boot hardcodes the model and one Adobe account. Constraints:

1. **No preboot file write.** `substrate.create()` accepts only env vars (`packages/cloud-core/src/substrates/e2b.ts:27`); `startCone` writes `/slicc/secrets.env` only *after* `create()` returns (`packages/cloud-core/src/operations/start.ts:167`,`:241`). The race-free preboot channel is an **env var** that `start.sh` writes to a file before launching node-server (`packages/dev-tools/e2b-template/start.sh:26`).
2. **`saveOAuthAccount` is OAuth-only.** `Account.apiKey` is required (`packages/webapp/src/ui/provider-settings.ts:151`); `saveOAuthAccount` hardcodes `apiKey: ''` (`:768`). API-key path is `addAccount(...)` (`:695`); removal is `removeAccount(...)` (`:711`). In non-extension mode `saveOAuthAccount` also POSTs `/api/secrets/oauth-update` (`:843`) — a node-server route absent on `www.sliccy.ai`.
3. **Secrets read path.** `EnvSecretStore.get()` re-reads its env file (`/slicc/secrets.env`) each call (`packages/node-server/src/secrets/env-secret-store.ts:27`,`:82`). `SecretProxyManager` builds the fetch-proxy masking from a live source and exposes `reload()` (`packages/node-server/src/secrets/proxy-manager.ts:30`,`:68`); the fetch-proxy calls the live instance per request (`packages/node-server/src/index.ts:1323`+). `reload()` is the established in-process refresh (`/api/secrets/oauth-update` uses it live, `:1182`). **No node-server process restart is needed for secret changes.**
4. **Resume = page reload.** `/api/leader-restart` does only a CDP `Page.reload` (`packages/node-server/src/leader-restart.ts:175`); resume currently just curls it (`packages/cloud-core/src/operations/resume.ts:30`).
5. **`/api/cloud/config` is taken.** It is the **public, unauthenticated** dashboard IMS/relay config endpoint (`packages/cloudflare-worker/src/cloud/handler-config.ts:1`, `index.ts:149`, `packages/webapp/cloud/app.js:7`). Cone config must be a different, authenticated, sandbox-scoped route.

## Architecture overview

```
www.sliccy.ai  (same origin for both surfaces ⇒ shared localStorage)
  ├── /                  ← full webapp; NEW slim "?connect=1" mode logs into providers
  │                        (OAuth popups + API-key entry) → writes slicc_accounts
  │                        (connect mode SUPPRESSES the /api/secrets/oauth-update replica sync)
  ├── /cloud             ← dashboard SPA (packages/webapp/cloud/app.js)
  │                        create: assemble ConeConfig (values); resume: read index, edit, send delta
  └── /api/cloud/*       ← start (full bundle); cone-config GET (names only, AUTH, ?sandboxId);
                           resume (delta)

        ↓ worker                                   CloudSessionsDurableObject
   create: env (base64) SLICC_CONE_CONFIG_JSON ─►  per-cone names-only INDEX
           + env (base64) secrets payload            { model, accountProviderIds[],
   resume: SDK writeFile (running sandbox)             accountMeta[], secretNames[] } — NO values
        ↓ (e2b SDK)

e2b sandbox (node-server --hosted)
  ├── start.sh decodes envs → /slicc/secrets.env (flat secrets) + /slicc/cone-config.json
  │   ({model,accounts}); then UNSETS the env vars
  ├── EnvSecretStore reads /slicc/secrets.env  (worker-owned; node-server does NOT derive it)
  ├── GET /api/hosted-bootstrap → { model, accounts }   (extended; from cone-config.json)
  ├── NEW POST /api/secrets/reload (loopback) → secretProxy.reload()
  └── webapp hosted boot → reconcile selected-model + accounts (add/save/remove, managed-only)
```

Interactive OAuth runs in the user's **real browser** (`?connect=1`) — the cone's headless Chromium cannot (`adobe.ts` `silentRenewToken()` returns `null` in hosted mode).

## The `ConeConfig` bundle and its two-file landing

`ConeConfig` is the single **logical** bundle the dashboard sends to the worker. It lives as types + validate/merge helpers in a **side-effect-free `@slicc/cloud-core/cone-config` subpath** (the root `@slicc/cloud-core` re-exports `createE2bSubstrate` and depends on `e2b`/Node — the webapp must import only the subpath; add the `exports` map entry):

```jsonc
// ConeConfig (logical) — dashboard → worker
{
  "model": "anthropic:claude-opus-4-6",
  "accounts": [
    { "providerId": "adobe",     "kind": "oauth",  "accessToken": "…", "tokenExpiresAt": 0, "userName": "…" },
    { "providerId": "anthropic", "kind": "apikey", "apiKey": "…" }
  ],
  "secrets": [
    { "name": "GITHUB_TOKEN", "value": "…", "domains": ["api.github.com", "github.com"] }
  ]
}
```

The worker lands it in **two sandbox files**, resolving the secret-store handoff (constraint 3) without node-server deriving anything:

- **`/slicc/secrets.env`** ← `secrets[]` (flat), comma-joining `domains` to `NAME_DOMAINS=a,b`. This is the file `EnvSecretStore` already reads and `startCone` already writes — we generalize today's IMS-only write to all flat secrets, keeping the `filterSecretsEnv` `E2B_API_KEY` stripping (`packages/cloud-core/src/secrets-filter.ts`). No clobber: the worker owns this file end-to-end.
- **`/slicc/cone-config.json`** ← `{ model, accounts[] }`, served to the webapp via `/api/hosted-bootstrap`.

`domains` is canonically **`string[]`** (matches `Secret.domains` in `packages/node-server/src/secrets/types.ts`); each account carries an explicit **`kind`**.

The **resume delta** (upserts carry values; deletes carry only keys):

```jsonc
{ "model": "…?", "upsert": { "accounts": [...], "secrets": [...] }, "delete": { "providerIds": ["openai"], "secretNames": ["OLD_TOKEN"] } }
```

## Account provisioning in the cone (OAuth vs API-key, managed-only delete)

The hosted-leader boot **reconciles** `localStorage` accounts to match `cone-config.json` accounts:

- `kind: 'oauth'` → `saveOAuthAccount({ providerId, accessToken, refreshToken?, tokenExpiresAt?, … })`.
- `kind: 'apikey'` → `addAccount(providerId, apiKey, baseUrl?, deployment?, apiVersion?)`.
- **Delete is managed-only:** the cone removes (`removeAccount`) only providers it is **managing** (the set in `cone-config.json`/the DO index) that are absent from the current bundle. It never deletes an account a user might have added in-cone. Cloud authority is scoped to cloud-provisioned accounts.

Unknown `providerId`s are skipped with a warning; never crash boot.

## Producing the bundle: the dashboard + `?connect=1`

Reuse the real webapp for logins, exploiting same-origin (`/cloud` and `/` are both `www.sliccy.ai`, sharing `localStorage`; `slicc_accounts` holds the real token client-side).

- **Connect:** "Connect a provider / set model" opens `https://www.sliccy.ai/?connect=1` — a slim webapp boot mode mounting only provider-settings + accounts UI + model picker (no kernel/orchestrator). It **suppresses the `/api/secrets/oauth-update` replica sync** (constraint 2 — that route doesn't exist there and the dashboard only needs the `localStorage` account). The user logs in, returns; the account is in shared `localStorage`.
- **Assemble:** the dashboard reads selected accounts' real tokens from `slicc_accounts` plus a flat-secret form, and builds the bundle/delta.
- **F6 validation:** the dashboard rejects a model whose provider has no provisioned account (unless auth-optional). The **worker re-validates narrowly** — it only checks provider-prefix/account-presence (it has `cloud-core` + `jose`, not the pi-ai model catalog); full model-id validation stays dashboard-side.

## Worker injection + the DurableObject index

- **Create.** `POST /api/cloud/start` gains `coneConfig`. The worker passes **two base64-encoded env vars** at `substrate.create`: `SLICC_CONE_CONFIG_JSON` (`{model,accounts}`) and the flat-secrets payload (generalizing today's `ADOBE_IMS_TOKEN`). It enforces a **max serialized size** and returns **redacted** validation errors. `start.sh` base64-decodes each to `/slicc/cone-config.json` and `/slicc/secrets.env` before launching node-server, then **unsets the env vars** so they don't linger in the process env. The worker records a **names-only index** in `CloudSessionsDurableObject`: `{ model, accountProviderIds, accountMeta:[{providerId,kind,tokenExpiresAt?}], secretNames }` — never values.
- **Resume.** Dashboard first `GET /api/cloud/cone-config?sandboxId=…` (authenticated, user-scoped — **not** the public `/api/cloud/config`) → returns the DO names-only index (works while paused). After edits, `POST /api/cloud/resume` carries the **delta**. The worker resumes (`connect`), then runs a **concrete ordered hook**: (1) read-modify-write `/slicc/secrets.env` and `/slicc/cone-config.json` (it holds existing values, so kept entries are preserved; apply `upsert`, drop `delete`, set `model`); (2) `POST /api/secrets/reload` (new loopback) → `secretProxy.reload()`; (3) `POST /api/leader-restart` → `Page.reload`. It then updates the DO index. Both reloads are required (constraint 3): masks are `HMAC(session_id+name,value)`, so the pipeline (node-server) and the agent (page) must refresh together.
- **F5 default for no-config requests.** Absent `coneConfig` (today's dashboard sends only `{ name }`) → default bundle: model `adobe:claude-opus-4-6` + an Adobe `oauth` account from the authenticated cloud IMS bearer (`handlers.ts`, `cloud-sessions-do.ts:160`). Old dashboards keep working.
- **F3 migration.** A pre-feature paused cone has only `secrets.env`, no `cone-config.json` or DO index (`resume.ts:66`). First resume: synthesize a degenerate `cone-config.json` (Adobe account from the bearer + default model), seed the DO index, leave `secrets.env` intact. No old cone loses its Adobe bootstrap.
- The worker never persists bundle **values** (only the names-only index) and never logs them.

## Cone consumption (node-server + webapp boot)

- **node-server `--hosted`**: `EnvSecretStore` reads the worker-written `/slicc/secrets.env` (no derivation). `GET /api/hosted-bootstrap` is extended from `{ adobeImsToken }` to `{ model, accounts }`, sourced from `/slicc/cone-config.json` (falling back to the legacy `ADOBE_IMS_TOKEN` secret for un-migrated cones). A **new loopback `POST /api/secrets/reload`** calls `secretProxy.reload()`.
- **webapp hosted-leader boot** (`packages/webapp/src/ui/main.ts`): set `localStorage['selected-model'] = model` (replacing the hardcode) and run the managed-only account reconcile.

## Resume / refresh / delete semantics

- Unchanged flat secrets/model survive a plain resume (snapshot + merge never drops omitted entries).
- **Add** = upsert with value; **delete** = listed in `delete` → removed from both files + DO index; the reload reconciles `localStorage`/secret store (managed-only `removeAccount`; fetch-proxy drops deleted flat secrets after `secretProxy.reload()`). Takes effect on the running cone — no kill needed.
- **Renew** an expiring OAuth token = reconnect in the dashboard (`?connect=1`; refresh-token providers silently), included as an `upsert`.

## Error handling and edge cases

- Expired/invalid token at boot → provider calls surface the existing auth-error lick; remedy reconnect+resume.
- Unknown `providerId` → skipped with warning.
- Model whose provider is unauthed → dashboard rejects; worker re-validates (provider-prefix/account-presence).
- Malformed/oversized `coneConfig`/delta, or env payload over the max size → 400 with redacted error; no sandbox mutation.
- Non-POSIX secret name → existing `fetchSecretEnvVars` filter drops it from `$ENV`.
- Pre-feature cone first resume → degenerate-bundle synthesis.
- DO index drift → tolerated; the sandbox files are the functional source of truth; the next apply re-syncs.
- e2b write failure / resume race → existing start error handling + resume `ALREADY_RUNNING` guard.

## Security considerations

- Bundle **values** transit the worker but are never persisted (only the names-only DO index) and never logged.
- Preboot env payloads are **base64-encoded**, size-capped, and **unset** by `start.sh` after writing the files (no lingering secrets in the process env / `printenv`).
- `/slicc/*` files are plaintext in the user's **own isolated** sandbox — same trust level as `secrets.env` today.
- `GET /api/cloud/cone-config` is authenticated and user/sandbox-scoped (unlike the public `/api/cloud/config`).
- `?connect=1` only writes `localStorage` (replica sync suppressed); the dashboard sends only explicitly selected accounts/secrets.

## Testing

- **Unit**: `ConeConfig`/delta validate + merge (cloud-core `cone-config` subpath, no e2b import); dashboard assembly, account-select, F6 validation; webapp boot reconcile (add vs save vs remove per `kind`, managed-only delete, model seed); node-server two-file consumption + extended `/api/hosted-bootstrap` + new `/api/secrets/reload`; DO names-only index.
- **Integration**: worker start (base64 env preboot, size cap, unset) and resume (read-modify-write delta to **both** files → ordered reload hook → DO index) via a `SandboxSubstrate` mock; F3 migration from a `secrets.env`-only sandbox; F5 default-bundle path; route auth on `cone-config`.
- **Manual QA**: create with a non-Adobe model + one API-key + one OAuth provider → model selected, calls succeed; pause; on resume see provisioned keys, delete one secret + one login and add a new secret → deleted gone (no kill), new one works after reload; expire a token → reconnect + resume restores.

## File-level change inventory

| Area | File(s) | Change |
| --- | --- | --- |
| Bundle types | `packages/cloud-core/src/cone-config.*` + `package.json` `exports` | side-effect-free `./cone-config` subpath: `ConeConfig`/delta types + validate/merge (no e2b/Node) |
| Webapp import | `packages/webapp` boot code | import the `@slicc/cloud-core/cone-config` subpath (type + helpers only) |
| Worker API | `packages/cloudflare-worker/src/cloud/*`, `cloud-sessions-do.ts`, `index.ts` routes | `start` accepts `coneConfig`; NEW auth'd `GET /api/cloud/cone-config?sandboxId`; `resume` delta; base64 envs + size cap + redacted errors; F5 default + narrow F6 re-validate; no value persistence/logging |
| DO index | `cloud-sessions-do.ts` | names-only index `{ model, accountProviderIds, accountMeta, secretNames }` |
| Cloud-core ops | `operations/start.ts`, `resume.ts` | start: two base64 envs; resume: read-modify-write **both** files + ordered hook (reload endpoint then leader-restart); F3 migration |
| Template | `e2b-template/start.sh` | base64-decode both envs → `secrets.env` + `cone-config.json` preboot; UNSET envs after |
| node-server | `hosted-bootstrap.ts`, NEW `/api/secrets/reload`, secret load | `EnvSecretStore` reads worker-written `secrets.env`; `/api/hosted-bootstrap` → `{ model, accounts }`; loopback reload endpoint |
| connect mode | `packages/webapp/src/ui/` (+ `runtime-mode.ts`, provider-settings replica guard) | slim `?connect=1` boot; suppress `/api/secrets/oauth-update` replica sync |
| dashboard | `packages/webapp/cloud/app.js`, `index.html`, `styles.css` | create form (auth + secrets + model); resume manager (index keys, add/delete/reauth); bundle/delta assembly; F6 validation |

## Explicit non-goals (v1)

- **Live in-session configuration** over the tray data channel — deferred; bundle/delta format stays forward-compatible.
- **Saved/portable credential profiles** — deferred.
- **Autonomous in-cone token refresh** — v1 uses reconnect-then-resume.
- **Worker-side server OAuth** — all OAuth stays in the dashboard's real browser.
- **In-cone manual account management / multi-follower credential coordination** — unchanged; cloud authority is scoped to cloud-managed accounts.
