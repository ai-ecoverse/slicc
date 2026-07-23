# CLAUDE.md

This file covers the tray hub worker in `packages/cloudflare-worker/`.

## Scope

The worker provides tray session coordination, capability-token routing, TURN credential
lookup, and leader/follower signaling for tray-connected SLICC runtimes. It also serves
the built SLICC webapp as static assets to browser visitors.

## Main Files

| Path                                                                                   | Purpose                                                                                                             |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `src/index.ts`                                                                         | Worker entry point and public HTTP routing                                                                          |
| `src/session-tray.ts`                                                                  | `SessionTrayDurableObject` — manages controller WS (leader), follower WebRTC signaling, and preview bridge WS       |
| `src/turn-credentials.ts`                                                              | Cloudflare TURN credential fetcher                                                                                  |
| `src/shared.ts`                                                                        | Capability token helpers; `reclaimMsForTray`; `TRAY_RECLAIM_TTL_MS`/`HOSTED_TRAY_RECLAIM_TTL_MS`; DO-internal types |
| `src/links.ts`                                                                         | `applySliccLinks` — RFC 8288 `Link` rel set on every response                                                       |
| `src/handoff-page.ts`                                                                  | `/handoff` route — converts `?upskill=`/`?handoff=`/`?msg=` into `Link` response header                             |
| `src/api-catalog.ts`                                                                   | `/.well-known/api-catalog` (RFC 9264 linkset) builder                                                               |
| `src/llms-txt.ts`                                                                      | `/llms.txt` builder                                                                                                 |
| `src/rel-docs.ts`                                                                      | `/rel/:name` — dereferenceable docs for SLICC custom rels                                                           |
| `src/oauth-exchange.ts`, `src/oauth-registry.ts`                                       | OAuth callback relay (`/auth/callback`)                                                                             |
| `src/auth/cloud-callback.ts`                                                           | `/auth/cloud-callback` IMS popup callback for the cloud dashboard                                                   |
| `src/cloud/cloud-sessions-do.ts`                                                       | `CloudSessionsDurableObject` — per-user state for `/api/cloud/*`                                                    |
| `src/cloud/handlers.ts`, `handler-signout.ts`, `handler-admin.ts`, `handler-config.ts` | HTTP handlers for `/api/cloud/*`                                                                                    |
| `src/cloud/auth.ts`, `auth-cache.ts`, `auth-middleware.ts`                             | IMS bearer auth: extraction, verification, caching, and middleware                                                  |
| `src/cloud/local-registry.ts`                                                          | `Registry` backed by DO storage — worker counterpart of node-server's `FileRegistry`                                |
| `src/cloud/error-envelope.ts`                                                          | `errorResponse`/`okResponse` JSON helpers for `/api/cloud/*` replies                                                |
| `src/cloud/proxy-config.ts`                                                            | Adobe LLM proxy `/v1/config` sync — keeps dashboard popup in sync                                                   |
| `src/cloud/rate-limit.ts`                                                              | Per-user rate limiting on cloud endpoints                                                                           |
| `wrangler.jsonc`                                                                       | Wrangler config, DO bindings (`TRAY_HUB`, `CLOUD_SESSIONS`), staging env, asset binding                             |

This package depends on `@slicc/cloud-core` (see
[`packages/cloud-core/CLAUDE.md`](../cloud-core/CLAUDE.md)) for sandbox lifecycle logic.
The worker-local `src/cloud/` files are adapter glue — operation logic lives in
cloud-core.

## Tray Hub Architecture

### Durable Objects

- Each tray maps to one `SessionTrayDurableObject` instance via the `TRAY_HUB` binding.
- Tray state tracks issued capability tokens, leader attachment state, follower bootstrap
  state, reconnect windows, and cached ICE servers.

### Public Routes

| Route                                 | Description                                                                                                                                               |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /tray`                          | Create a tray; return join/controller/webhook capability URLs                                                                                             |
| `GET /handoff`                        | Convert `?upskill=`, `?handoff=`, or `?msg=` into RFC 8288 `Link` header                                                                                  |
| `GET /.well-known/api-catalog`        | RFC 9264 linkset for all public routes                                                                                                                    |
| `GET /llms.txt`                       | LLM markdown digest                                                                                                                                       |
| `GET /status`                         | Health document (`{ status, service, timestamp }`)                                                                                                        |
| `GET /rel/:name`                      | Dereferenceable docs for SLICC custom rel URIs                                                                                                            |
| `GET\|POST /join/:token`              | Follower join and bootstrap polling (HTTP poll/answer/ice-candidate/retry actions)                                                                        |
| `GET\|POST /controller/:token`        | Leader attach and WS upgrade                                                                                                                              |
| `POST /webhook/:token/:webhookId`     | Forward webhook events into the live leader                                                                                                               |
| `POST /api/tray/:trayId/preview`      | Mint a preview token; body `{ path, bridge?, maxTabs?, quiet?, webhookId? }`; response `{ previewToken, url }`                                            |
| `POST /api/tray/:trayId/preview/stop` | Revoke a preview token; body `{ previewToken }`                                                                                                           |
| `GET /api/tray/:trayId/previews`      | List active previews for a tray                                                                                                                           |
| `GET <token>.sliccy.now/*`            | Preview HTTP pipe — streams file from leader via DO; 30s timeout; bridge mode injects `<script src="/__slicc/preview-bridge.js">`                         |
| `GET __slicc/preview-bridge.js`       | Bundled preview bootstrap (bridge-enabled previews only; build-generated, not committed)                                                                  |
| `WS __slicc/bridge`                   | Preview bridge WS (`slicc.preview-bridge.v1.<connId>`); relays CDP + attributed `emit` between tabs and leader; hibernated via `setWebSocketAutoResponse` |
| `POST __slicc/emit`                   | Fallback beacon relay for `window.slicc.emit` on page unload                                                                                              |
| `GET /auth/callback`                  | OAuth callback relay; also a capture hop for the cloud dashboard (no `state` → `postMessage` to `window.opener`)                                          |

**Routes-mirror rule:** every new route must appear in three places:

1. `src/index.ts` routes array (the default `GET /` body)
2. `tests/index.test.ts` routes-list assertion
3. `tests/deployed.test.ts` routes-list assertion

Missing any of these causes CI failures.

### Signaling Model

- A leader attaches through the controller capability and opens a WebSocket to the DO.
- **Last-key-holder-wins reconnect** — a leader reconnect with matching credentials
  closes the stale socket and accepts the new one rather than rejecting. Workerd doesn't
  reliably deliver `webSocketClose` on dropped/half-open connections; rejecting the
  rightful reconnect would deadlock it. See `docs/tray-worker-operations.md` for the
  full ghost-leader analysis.
- Followers attach through the join capability; bootstrap over HTTP poll.
- Preview bridge tabs (`serve --bridge`) attach via `/__slicc/bridge` WS. DO relays
  `bridge.cdp.request`/`bridge.cdp.response` between the leader and each bridge socket,
  keyed by `connId`. On leader (re)connect the DO replays `bridge.connected` for every
  live bridge socket.

### TURN Credentials

TURN credentials are fetched with `CLOUDFLARE_TURN_KEY_ID` and
`CLOUDFLARE_TURN_API_TOKEN`. `session-tray.ts` caches ICE servers and refreshes them
before TTL expiry. The key ID is in `wrangler.jsonc`; the API token is a Wrangler
secret.

### Tray Kind (desktop / hosted)

`TrayRecord.kind` is `'desktop' | 'hosted'`, defaulting to `'desktop'` when absent.
`POST /tray` reads an optional `kind` from the request body. The reclaim TTL is
`HOSTED_TRAY_RECLAIM_TTL_MS = 30 days` for hosted trays, `TRAY_RECLAIM_TTL_MS = 1 hour`
for desktop trays — branched through `reclaimMsForTray(tray)` in `shared.ts`.

### Static Asset Serving

- Worker serves `dist/ui/` via Cloudflare Workers Static Assets (`ASSETS` binding).
- `wantsJSON()` in `shared.ts` checks `?json=true` for content negotiation.
- GET/HEAD to `/join/:token` and `/controller/:token` without `?json=true` → SPA.
- Unmatched paths without `?json=true` → SPA fallback.
- `?json=true`, POST, and WebSocket upgrades → API/JSON.
- **Cherry embed (`?cherry=1`):** `frame-ancestors` is set from the
  `ALLOWED_CHERRY_HOST_ORIGINS` env var. A bare `*` also adds any explicit
  `chrome-extension://` origins (CSP `*` does not authorize extension ancestors).
  Every non-cherry response gets `frame-ancestors 'none'`. Cherry responses set
  `Cache-Control: no-store` and `Vary: Sec-Fetch-Dest` to prevent cache mixing.
- **25 MiB per-asset cap:** Cloudflare rejects any `dist/ui/` file over 25 MiB; the
  CI `cloudflare-worker` job runs `npm run build -w @slicc/cloudflare-worker`
  (`wrangler deploy --dry-run`) as a hard gate.

### R2 Asset Archive

The `ASSET_ARCHIVE` R2 binding keeps content-hashed `/assets/*` chunks available across
deploys so long-lived tabs don't 404 on lazy-loaded chunks from older builds.
`serveAssetWithArchiveFallback` in `src/index.ts` serves from `ASSETS`; falls back to
R2; degrades to the stale-asset reload if R2 also misses. 14-day bucket lifecycle GC.

See [`docs/tray-worker-operations.md`](../../docs/tray-worker-operations.md) for the
full ops runbook: bucket creation, lifecycle rules, API token required permissions,
upload gate mechanics, and the 2026-07-13 incident.

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

## CI and Deployment

The automated release gates production deployment with `release-native.mjs --gate=worker`.
The hub (`wrangler.jsonc`) and preview worker (`wrangler-preview.jsonc`) **must deploy as
a pair** — they share the same DO and preview URL token format. The R2 archive upload
runs unconditionally before every deploy. Routes-only failures are non-fatal (script
already live). Required secrets: `CLOUDFLARE_API_TOKEN` (Workers Edit + R2 R/W + Zone
Routes Edit) and `CLOUDFLARE_ACCOUNT_ID`.

See [`docs/tray-worker-operations.md`](../../docs/tray-worker-operations.md) for: retry
logic, routes-only failure classification, the staging deployment guide, and the local
`serve --bridge` test setup.

## Operational Notes

- Treat the worker as coordination infrastructure, not canonical session storage.
- The `/handoff` page is stateless; query parameters are translated into a single RFC
  8288 `Link` response header.
- Every worker response is wrapped by `applySliccLinks` (see `src/links.ts`) — standard
  rel set ships on every reply.
- Keep signaling protocol changes aligned with the browser tray runtime in
  `packages/webapp/src/scoops/`.

## Cloud Cones (sliccy.ai/cloud)

Web feature shipped via Plan D. All `/api/cloud/*` require
`Authorization: Bearer <ims-access-token>` and route to
`env.CLOUD_SESSIONS.idFromName(userId)` for per-user state.

### Routes

| Route                         | Description                                                                 |
| ----------------------------- | --------------------------------------------------------------------------- |
| `GET /cloud`                  | Dashboard SPA (CSP-enforced)                                                |
| `GET /auth/cloud-callback`    | IMS popup callback (HTML)                                                   |
| `GET /auth/cloud-callback.js` | IMS popup callback (JS, served inline by worker)                            |
| `POST /api/cloud/start`       | Start a new cone (auth-checked); optional `coneConfig` bundle               |
| `GET /api/cloud/list`         | Per-user cone list (reconciled with e2b per call)                           |
| `GET /api/cloud/cone-config`  | `?sandboxId=<id>`: names-only config index (model + account + secret names) |
| `POST /api/cloud/pause`       | Pause a cone                                                                |
| `POST /api/cloud/resume`      | Resume a paused cone; optional `coneConfigDelta`                            |
| `POST /api/cloud/kill`        | Kill a cone (idempotent)                                                    |
| `POST /api/cloud/sign-out`    | Invalidate auth cache for the bearer                                        |
| `GET /api/cloud/admin/stats`  | Admin-gated by `ADMIN_USER_IDS`                                             |

### Cone Configuration

A `ConeConfig` bundle (`{ model, accounts[], secrets[] }`, types in
`@slicc/cloud-core/cone-config`) lets users pick the cone's model, provide flat secrets,
and provision provider logins. `src/cloud/cone-config-bridge.ts` handles the start/resume
flows:

- **start:** validates config, splits into `/slicc/secrets.env` and
  `/slicc/cone-config.json`. No config ⇒ synthesizes Adobe default from the cloud bearer.
- **resume:** merges a `coneConfigDelta` into both files in-sandbox, then reloads the
  leader via `POST /api/secrets/reload` → `Page.reload`.
- **Adobe oauth expiry:** every path that synthesizes an Adobe `{kind:'oauth'}` account
  stamps `tokenExpiresAt` via `imsTokenExpiry` in `@slicc/cloud-core/cone-config`
  (decodes the IMS JWT's `created_at + expires_in` with `atob`).
- **DO index:** `CloudSessionsDurableObject` persists a **names-only** `coneConfigIndex`
  per cone — never values.

E2B is the sandbox-capacity authority; the worker does not impose separate running or
paused cone-count limits. Per-user endpoint token buckets in `src/cloud/rate-limit.ts`
remain the abuse-protection boundary.

`LocalRegistry` keeps the existing `{ sessions: ConeEntry[] }` storage schema and wraps
its append, update, and remove read-modify-write operations in Durable Object storage
transactions. Slow E2B create/connect/poll work remains outside `blockConcurrencyWhile`.

### Wrangler Config (cloud)

Vars in `wrangler.jsonc`:

- `ADOBE_PROXY_ENDPOINT` — Adobe LLM proxy URL.
- `ALLOWED_EMAIL_DOMAIN` — CSV, default `adobe.com`. Set to `*` to allow any domain.
- `BLOCKED_EMAILS` — CSV denylist.
- `REQUIRE_OWNER_ORG` — `true` for expansion to any ownerOrg-holder.
- `ADMIN_USER_IDS` — CSV of IMS userIds with admin access.
- `SLICC_E2B_TEMPLATE_NAME` — optional sandbox template alias. Production leaves it unset and defaults to `slicc`; Wrangler staging sets `slicc-staging`, matching the alias built by `worker-staging.yml`.

Secrets (`wrangler secret put`): `E2B_API_KEY` (Adobe team key; worker-only).

### v1 → v2 Expansion

```bash
npx wrangler secret put REQUIRE_OWNER_ORG  # value: true
# update ALLOWED_EMAIL_DOMAIN in wrangler.jsonc to "*"
npx wrangler deploy
```

### Stable API Contract (worker ↔ sandbox)

These surfaces inside paused-cone images have a deprecation obligation — paused cones
from older templates cannot be patched in-place:

- `POST /api/leader-restart` (loopback in sandbox)
- `GET /api/hosted-bootstrap` (loopback in sandbox)
- `POST /api/cloud-status` (loopback in sandbox)
- `/slicc/secrets.env` — sandbox file the worker writes via SDK
- `/tmp/slicc-join.json` — sandbox file the worker reads via SDK
- `ADOBE_IMS_TOKEN`, `ADOBE_IMS_TOKEN_DOMAINS`, `SLICC_TRAY_WORKER_BASE_URL` — envs
  consumed by `start.sh`
