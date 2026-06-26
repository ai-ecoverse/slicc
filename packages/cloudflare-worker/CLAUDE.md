# CLAUDE.md

This file covers the tray hub worker in `packages/cloudflare-worker/`.

## Scope

The worker provides tray session coordination, capability-token routing, TURN credential lookup, and leader/follower signaling for tray-connected SLICC runtimes. It also serves the built SLICC webapp as static assets to browser visitors.

## Main Files

| Path                                                                                                                 | Purpose                                                                                                                                                                                                                                                                                         |
| -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/index.ts`                                                                                                       | Worker entry point and public HTTP routing                                                                                                                                                                                                                                                      |
| `src/session-tray.ts`                                                                                                | `SessionTrayDurableObject` state machine                                                                                                                                                                                                                                                        |
| `src/tray-signaling.ts`                                                                                              | Shared signaling message types                                                                                                                                                                                                                                                                  |
| `src/turn-credentials.ts`                                                                                            | Cloudflare TURN credential fetcher                                                                                                                                                                                                                                                              |
| `src/shared.ts`                                                                                                      | Capability token + response helpers; `reclaimMsForTray`; the `TRAY_RECLAIM_TTL_MS` / `HOSTED_TRAY_RECLAIM_TTL_MS` consts                                                                                                                                                                        |
| `src/links.ts`                                                                                                       | `applySliccLinks` — adds the standard RFC 8288 `Link` rel set to every response                                                                                                                                                                                                                 |
| `src/handoff-page.ts`                                                                                                | `/handoff` route handler — converts `?upskill=` / `?handoff=` / `?msg=` into a `Link` response header                                                                                                                                                                                           |
| `src/api-catalog.ts`                                                                                                 | `/.well-known/api-catalog` (RFC 9264 linkset) response builder                                                                                                                                                                                                                                  |
| `src/llms-txt.ts`                                                                                                    | `/llms.txt` response builder                                                                                                                                                                                                                                                                    |
| `src/rel-docs.ts`                                                                                                    | `/rel/:name` response builder — dereferenceable docs for SLICC custom rels                                                                                                                                                                                                                      |
| `src/oauth-exchange.ts`, `src/oauth-registry.ts`                                                                     | OAuth callback relay (`/auth/callback`) — decodes the `state` envelope and routes to localhost / extension / allowlisted remote                                                                                                                                                                 |
| `src/auth/cloud-callback.ts`                                                                                         | `/auth/cloud-callback` IMS popup callback for the cloud dashboard                                                                                                                                                                                                                               |
| `src/cloud/cloud-sessions-do.ts`                                                                                     | `CloudSessionsDurableObject` — per-user state for `/api/cloud/*`. Wraps `@slicc/cloud-core` ops under `blockConcurrencyWhile`                                                                                                                                                                   |
| `src/cloud/handlers.ts`, `src/cloud/handler-signout.ts`, `src/cloud/handler-admin.ts`, `src/cloud/handler-config.ts` | HTTP handlers for the `/api/cloud/*` routes; delegate to the DO                                                                                                                                                                                                                                 |
| `src/cloud/auth.ts`, `src/cloud/auth-cache.ts`, `src/cloud/auth-middleware.ts`                                       | IMS bearer auth: extraction + verification, caching, and the middleware that wraps `/api/cloud/*` handlers                                                                                                                                                                                      |
| `src/cloud/caps.ts`                                                                                                  | `checkCapsForRun` — per-user cone cap enforcement (`CONE_CAP_RUNNING`, `CONE_CAP_PAUSED`); called from `resumeConeOp` (inside `blockConcurrencyWhile`). The start-path counterpart lives in `@slicc/cloud-core`'s `reserveSlot`, which does the cap check + atomic slot reservation in one step |
| `src/cloud/local-registry.ts`                                                                                        | `Registry` implementation backed by DurableObject storage — the worker counterpart of node-server's `FileRegistry`                                                                                                                                                                              |
| `src/cloud/error-envelope.ts`                                                                                        | `errorResponse(status, code, message, details?)` and `okResponse(payload?)` helpers — the JSON shape used by `/api/cloud/*` replies; handlers map `CloudError.code` to HTTP statuses at the call site                                                                                           |
| `src/cloud/proxy-config.ts`                                                                                          | Pulls IMS client_id / scopes / environment from the Adobe LLM proxy's `/v1/config` so the dashboard popup stays in sync                                                                                                                                                                         |
| `src/cloud/rate-limit.ts`                                                                                            | Per-user rate limiting on the cloud endpoints                                                                                                                                                                                                                                                   |
| `wrangler.jsonc`                                                                                                     | Wrangler config, Durable Object bindings (`TRAY_HUB`, `CLOUD_SESSIONS`), staging env, asset binding                                                                                                                                                                                             |

This package depends on `@slicc/cloud-core` (see [`packages/cloud-core/CLAUDE.md`](../cloud-core/CLAUDE.md)) for sandbox lifecycle logic. The worker-local `src/cloud/` files are adapter glue (auth, DO storage, HTTP plumbing) — operation logic lives in cloud-core.

## Tray Hub Architecture

### Durable Objects

- Each tray maps to one `SessionTrayDurableObject` instance via the `TRAY_HUB` binding.
- Tray state tracks issued capability tokens, leader attachment state, follower bootstrap state, reconnect windows, and cached ICE servers.

### Public routes

- `POST /tray` — create a tray and issue join/controller/webhook capability URLs
- `GET /handoff` — accepts `?upskill=<github-url>`, `?handoff=<text>`, or legacy `?msg=verb:payload` and emits an RFC 8288 `Link` response header carrying the SLICC handoff or upskill rel so SLICC can emit a `navigate` lick and show the user an approval prompt
- `GET /.well-known/api-catalog` — RFC 9264 linkset describing every public route (`application/linkset+json`)
- `GET /llms.txt` — markdown digest for LLM consumers (llmstxt.org spec)
- `GET /status` — public health document (RFC 8631 status rel): `{ status, service, timestamp }`
- `GET /rel/:name` — dereferenceable docs for the SLICC custom rel URIs (`/rel/handoff`, `/rel/upskill`)
- `GET|POST /join/:token` — follower join and bootstrap polling flow
- `GET|POST /controller/:token` — leader attach flow and leader WebSocket upgrade
- `POST /webhook/:token/:webhookId` — forward webhook events into the live leader
- `POST /api/tray/:trayId/preview` — mint a preview token (Bearer = controllerToken); response `{ previewToken, url }`. The URL is a `<token>.preview.<env>.sliccy.ai` host that routes back to this worker via the wildcard route.
- `POST /api/tray/:trayId/preview/stop` — revoke a previewToken (Bearer = controllerToken); response `{ revoked }`.
- `GET /api/tray/:trayId/previews` — list active previews for a tray (Bearer = controllerToken).
- `GET <token>.preview.<env>.sliccy.ai/*` — preview HTTP pipe (`src/preview-handler.ts`). Parses the token from the host, resolves the `PreviewRecord` via DO `/internal/preview/resolve`, sends `preview.request` to the live leader over the controller WS, awaits `preview.response` chunks (30s timeout via `PreviewAssembler`), reassembles, and streams the bytes back. No `Access-Control-Allow-Origin` — preview subdomains can't fetch each other. 502 on disconnected leader / timeout, 404 / 403 / 500 forwarded from the leader.
- `GET /auth/callback` — OAuth callback relay page (decodes `state` param with source/port/path/nonce, redirects to localhost for `source:'local'`, extension for `source:'extension'`, or allowlisted remote origin for `source:'remote'`). **Capture hop:** when hit with a provider response (`?code`/`?error`) and **no `state`** — i.e. the relay already bounced back to the dashboard's own origin — it instead serves a tiny page that `postMessage`s `{ type:'oauth-callback', redirectUrl }` to `window.opener`. This is the completion path for the webapp-served-by-worker (connect/cloud) context, which has no node-server callback page; the webapp's `launchOAuthCli` waits for that message. Used by connect-mode GitHub login (see `packages/webapp/providers/github.ts` `resolveGithubOAuthRedirect`).

### Signaling model

- A leader first attaches through the controller capability.
- The elected leader opens a WebSocket to the Durable Object.
- Followers attach through the join capability and bootstrap over HTTP poll/answer/ice-candidate/retry actions.
- The Durable Object forwards control messages to the live leader and expires trays that are not reclaimed in time.

### TURN credentials

- TURN credentials are fetched with `CLOUDFLARE_TURN_KEY_ID` and `CLOUDFLARE_TURN_API_TOKEN`.
- `session-tray.ts` caches ICE servers and refreshes them before TTL expiry.
- `wrangler.jsonc` defines the key ID; the API token is stored as a Wrangler secret.

### Tray kind (desktop / hosted)

`TrayRecord.kind` is `'desktop' | 'hosted'`, defaulting to `'desktop'` when absent.
`POST /tray` reads an optional `kind` from the request body (no body = desktop;
malformed body = 400). The reclaim TTL is `HOSTED_TRAY_RECLAIM_TTL_MS = 30 days`
for hosted trays, `TRAY_RECLAIM_TTL_MS = 1 hour` for desktop trays — branched
through the pure helper `reclaimMsForTray(tray)` in `shared.ts`. Hosted trays
support laptop-orchestrated sandboxes that pause for days at a time.

### Static Asset Serving

- The worker serves the built webapp (`dist/ui/`) via Cloudflare Workers Static Assets.
- `wrangler.jsonc` configures `assets.directory` pointing to `../../dist/ui/` with binding name `ASSETS`.
- Content negotiation uses `wantsJSON()` in `shared.ts` — checks for `?json=true` query parameter.
- GET/HEAD requests to `/join/:token` and `/controller/:token` without `?json=true` get the SPA (webapp handles tray joining client-side).
- GET/HEAD requests to unmatched paths without `?json=true` get an SPA fallback.
- Requests with `?json=true`, POST requests, and WebSocket upgrades always get the API/JSON response.
- The browser tray follower code (`packages/webapp/src/scoops/tray-follower.ts`) appends `?json=true` to all fetch calls to ensure API responses.
- The webapp must be built (`npm run build -w @slicc/webapp`) before the worker can be deployed.
- **Cherry embed (`?cherry=1`)**: `serveSPA` branches on `url.searchParams.get('cherry') === '1'`. A cherry request gets `Content-Security-Policy: frame-ancestors <origins>`, where `<origins>` is resolved from the space-separated `ALLOWED_CHERRY_HOST_ORIGINS` env var by the pure helper `resolveCherryFrameAncestors`:
  - empty / unset → `'none'` (deny — the embed cannot be framed; default)
  - one or more origins → that allowlist verbatim, space-separated
  - contains a bare `*` token (alone or mixed with origins) → `*` (the CSP wildcard wins; permits embedding from arbitrary third-party pages)

  Every **non-cherry** response gets `frame-ancestors 'none'` regardless of the env var — the wildcard only relaxes the follower (`?cherry=1`) surface, never the leader/top-level SPA. Cherry responses also set `Cache-Control: no-store` and `Vary: Sec-Fetch-Dest` so a cherry (iframe) response and a non-cherry (top-level) response can never share a cache entry — the framing policy differs between the two and must not leak across them. Using `*` opts in to arbitrary third-party framing of the cherry follower; the leader UI stays top-level-only (no clickjacking surface).

- **25 MiB per-asset cap**: Cloudflare Workers Static Assets reject any single file in `dist/ui/` over 25 MiB, and `wrangler deploy` (incl. `--dry-run`) fails hard with `Asset too large`. A webapp change that bundles a large binary (e.g. the 33 MB `biome_wasm_bg.wasm`, stripped by `packages/webapp/vite-plugins/strip-biome-wasm-asset.ts`) breaks the deploy. The `cloudflare-worker` CI job runs `npm run build -w @slicc/cloudflare-worker` (the same `wrangler deploy --dry-run`) as a hard gate after building the webapp. The other deploy steps in that same job are `continue-on-error: true` and the finalize/smoke steps skip (rather than fail) when no deploy succeeds, so before this gate an oversized asset passed the PR and only broke later in the separate `release` workflow. The dry-run gate now fails the PR up front.

## Commands

### Worker and deploy

```bash
# Build webapp first (required for static assets)
npm run build -w @slicc/webapp

npx wrangler dev --config packages/cloudflare-worker/wrangler.jsonc
npx wrangler deploy --env staging --config packages/cloudflare-worker/wrangler.jsonc
npx wrangler deploy --config packages/cloudflare-worker/wrangler.jsonc
cd packages/cloudflare-worker && WORKER_BASE_URL=https://... npm test -- tests/deployed.test.ts
```

### Extension testing with the worker

```bash
npm run start:extension
```

This lives at the repo root because it coordinates the worker with browser runtimes.

## CI and Deployment

- Worker deploy automation lives in `.github/workflows/worker.yml`.
- Required repo configuration:
  - secret: `CLOUDFLARE_API_TOKEN`
  - variable: `CLOUDFLARE_ACCOUNT_ID`
- Wrangler surfaces deployed URLs that are used by `packages/cloudflare-worker/tests/deployed.test.ts`.

## Operational Notes

- Treat the worker as coordination infrastructure, not canonical session storage.
- The `/handoff` page is intentionally stateless; the recognised query parameters are translated into a single RFC 8288 `Link` response header and the page body is only an informational preview.
- Every worker response is wrapped by `applySliccLinks` (see `src/links.ts`) so a standard rel set (`api-catalog`, `service-desc`, `service-doc`, `status`, `https://llmstxt.org/rel/llms-txt`, `terms-of-service`, `license`) ships on every reply alongside any route-specific Link entries.
- Keep signaling protocol changes aligned with the browser tray runtime in `packages/webapp/src/scoops/`.
- **When adding or changing routes**, update ALL THREE test/config locations:
  1. `tests/index.test.ts` — unit test that checks the routes list in the root 200 response
  2. `tests/deployed.test.ts` — smoke test that runs against the deployed staging worker (also checks routes list)
  3. The routes array in `src/index.ts` (the default 200 response)
     Missing any of these causes CI failures — the staging smoke test deploys the worker then verifies the routes match.

## Cloud cones (sliccy.ai/cloud)

Web feature shipped via Plan D. Spec at `docs/superpowers/specs/2026-05-26-cloud-cones-on-sliccy-ai-design.md`.

### Routes

- `GET  /cloud` — dashboard SPA (CSP-enforced)
- `GET  /auth/cloud-callback` — IMS popup callback (HTML)
- `GET  /auth/cloud-callback.js` — IMS popup callback (JS, served inline by worker)
- `POST /api/cloud/start` — start a new cone (auth + cap-checked); optional `coneConfig` bundle (see below)
- `GET  /api/cloud/list` — per-user cone list (reconciled with e2b per call)
- `GET  /api/cloud/cone-config` — `?sandboxId=<id>`: returns the cone's **names-only** config index (model + account providerIds + secret names; no values) so the dashboard can show provisioned keys while the cone is paused
- `POST /api/cloud/pause` — pause a cone
- `POST /api/cloud/resume` — resume a paused cone (refreshes IMS token in sandbox); optional `coneConfigDelta` (see below)
- `POST /api/cloud/kill` — kill a cone (idempotent)
- `POST /api/cloud/sign-out` — invalidate the auth cache entry for the bearer
- `GET  /api/cloud/admin/stats` — admin-gated by `ADMIN_USER_IDS`

All `/api/cloud/*` require `Authorization: Bearer <ims-access-token>` and route to `env.CLOUD_SESSIONS.idFromName(userId)` for per-user state. Lifecycle business logic lives inside the DurableObject (atomic via `state.blockConcurrencyWhile`), not in worker handlers.

### Cone configuration (model, secrets, provider logins)

A `ConeConfig` bundle (`{ model, accounts[], secrets[] }`, types + helpers in the side-effect-free `@slicc/cloud-core/cone-config` subpath) lets users pick the cone's model, provide flat secrets, and provision provider logins (API-key and OAuth). `accounts` carry `kind: 'oauth' | 'apikey'`. Flow (`src/cloud/cone-config-bridge.ts`):

- **start:** `coneConfig` is validated (`validateConeConfig` + narrow `assertModelHasAccount` — the model's provider must have an account unless auth-optional), then `bundleToFiles` splits it into `/slicc/secrets.env` (flat secrets, what `startCone` already writes) and `/slicc/cone-config.json` (`{model,accounts}`). No `coneConfig` ⇒ the worker synthesizes the Adobe default from the cloud bearer (back-compat with old dashboards that send only `{ name }`). Body size is capped at `MAX_CONE_CONFIG_BYTES`.
- **resume:** `coneConfigDelta` (`{ model?, upsert{accounts,secrets}, delete{providerIds,secretNames} }`) is merged into both files in-sandbox (read-modify-write, preserving unchanged values), then node-server is reloaded via the ordered hook `POST /api/secrets/reload` → leader-restart `Page.reload`. Pre-feature cones (only `secrets.env`, no `cone-config.json`) get a degenerate bundle synthesized on first resume.
- **Adobe oauth account expiry:** every site that synthesizes an Adobe `{kind:'oauth'}` account from a bare IMS bearer — the start back-compat path (`cone-config-bridge.ts`), the resume re-push (`cloud-sessions-do.ts`), and node-server's CLI legacy branch (`hosted-bootstrap.ts`) — stamps `tokenExpiresAt` via the shared, dependency-free `imsTokenExpiry` helper in `@slicc/cloud-core/cone-config` (decodes the IMS JWT's `created_at + expires_in` with `atob`, not `node:Buffer`). Without it, the window-less kernel-worker cone treats the still-valid token as expired (it cannot silent-renew) and throws "Adobe session expired" on the first turn.
- **DO index:** `CloudSessionsDurableObject` persists a **names-only** `coneConfigIndex` on each `ConeEntry` (model + providerIds + secret names; **never values**), surfaced by `GET /api/cloud/cone-config`. The worker is a transient relay — it never persists bundle values and never logs them.

### Wrangler config

Vars (in `wrangler.jsonc`):

- `ADOBE_PROXY_ENDPOINT` — Adobe LLM proxy URL. Default `https://adobe-llm-proxy.paolo-moz.workers.dev`. Worker fetches `/v1/config` to learn IMS client_id + scopes + environment, keeping dashboard popup config in sync with what the cone needs to call the proxy.
- `ALLOWED_EMAIL_DOMAIN` — CSV, default `adobe.com`. Set to `*` to allow any domain.
- `BLOCKED_EMAILS` — CSV denylist (emails explicitly blocked even if domain allowed).
- `REQUIRE_OWNER_ORG` — `true` for v2 expansion to any ownerOrg-holder.
- `CONE_CAP_RUNNING`, `CONE_CAP_PAUSED` — per-user caps (default 1 / 5).
- `ADMIN_USER_IDS` — CSV of IMS userIds with admin access.

Secrets (`wrangler secret put`):

- `E2B_API_KEY` — Adobe team e2b key. Worker-only; never reachable from browser.

GitHub Actions secrets (for CI worker deploy + template build):

- `E2B_API_KEY` — same value; scoped to the Adobe team workspace.

### v1 → v2 expansion

```bash
npx wrangler secret put REQUIRE_OWNER_ORG  # value: true
# update ALLOWED_EMAIL_DOMAIN in wrangler.jsonc to "*"
npx wrangler deploy
```

### Stable API contract (worker ↔ sandbox)

Worker depends on these surfaces inside paused-cone images. **Breaking changes require a deprecation cycle** because paused cones from older templates cannot be patched in-place:

- `POST /api/leader-restart` (loopback in sandbox) — re-kicks the leader.
- `GET  /api/hosted-bootstrap` (loopback in sandbox) — page reads ADOBE_IMS_TOKEN.
- `POST /api/cloud-status` (loopback in sandbox) — page reports join state.
- `/slicc/secrets.env` — sandbox file the worker writes via SDK.
- `/tmp/slicc-join.json` — sandbox file the worker reads via SDK.
- `ADOBE_IMS_TOKEN`, `ADOBE_IMS_TOKEN_DOMAINS`, `SLICC_TRAY_WORKER_BASE_URL` — envs consumed by `start.sh`.

### Routes-mirror rule (applies to /api/cloud/\* too)

Per the existing tray hub rule — every new route must appear in three places:

- `src/index.ts` routes array (the default `GET /` body)
- `tests/index.test.ts` routes-list assertion
- `tests/deployed.test.ts` routes-list assertion
