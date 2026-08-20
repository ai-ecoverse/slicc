# CLAUDE.md

Tray hub worker in `packages/cloudflare-worker/`: tray session coordination,
capability-token routing, TURN credential lookup, and leader/follower signaling for
tray-connected SLICC runtimes; also serves the built webapp as static assets.

Deep reference: [`docs/cloudflare-worker-details.md`](../../docs/cloudflare-worker-details.md).

## Main Files

- `src/index.ts` — entry + public HTTP routing
- `src/session-tray.ts` — `SessionTrayDurableObject`: controller WS (leader), follower
  WebRTC signaling, preview bridge WS
- `src/turn-credentials.ts` — Cloudflare TURN credential fetcher
- `src/shared.ts` — capability tokens; `reclaimMsForTray`;
  `TRAY_RECLAIM_TTL_MS`/`HOSTED_TRAY_RECLAIM_TTL_MS`
- `src/links.ts` — `applySliccLinks` (RFC 8288 `Link` rel set on every response)
- `src/handoff-page.ts`, `src/api-catalog.ts`, `src/install-cli.ts`, `src/llms-txt.ts`,
  `src/privacy.ts`, `src/rel-docs.ts`, `src/flags.ts` — public route handlers
- `src/oauth-exchange.ts`, `src/oauth-registry.ts`, `src/auth/cloud-callback.ts` —
  OAuth relays (`/auth/callback`, `/auth/cloud-callback`)
- `src/cloud/*` — `/api/cloud/*` handlers, `CloudSessionsDurableObject`, IMS auth,
  `checkCapsForRun` cone caps, DO-backed `Registry`, Adobe proxy `/v1/config` sync,
  `rate-limit.ts`, `error-envelope.ts`
- `wrangler.jsonc` — bindings (`TRAY_HUB`, `CLOUD_SESSIONS`, `ASSETS`, `ASSET_ARCHIVE`,
  `CF_VERSION_METADATA`), staging env, feature flags

Sandbox lifecycle lives in `@slicc/cloud-core`; `src/cloud/` is adapter glue.

## Tray Hub Architecture

`TRAY_HUB` maps each tray to one `SessionTrayDurableObject`, tracking capabilities,
leader/follower state, reconnect windows, and cached ICE servers.

### Public Routes

Route inventory: `POST /tray`, `GET /handoff`, `GET /install-cli`,
`GET /install-cli.ps1`, `GET /download/slicc-cli/:target`,
`GET /.well-known/api-catalog`, `GET /llms.txt`, `GET|HEAD /privacy`,
`GET|HEAD /status`, `GET /rel/:name`, `GET|POST /join/:token`,
`GET|POST /controller/:token`, `POST /webhook/:token/:webhookId`,
`POST /api/tray/:trayId/preview`, `POST /api/tray/:trayId/preview/stop`,
`GET /api/tray/:trayId/previews`, `GET <token>.sliccy.now/*`,
`GET __slicc/preview-bridge.js`, `WS __slicc/bridge`, `POST __slicc/emit`,
`GET /auth/callback`, `GET /auth/mcp-callback`, `GET /api/flags`. Per-route semantics:
[docs/cloudflare-worker-details.md § Public Routes](../../docs/cloudflare-worker-details.md#public-routes).

**Routes-mirror rule:** every new route MUST appear in

1. `src/index.ts` routes array (the default `GET /` body)
2. `tests/index.test.ts` routes-list assertion
3. `tests/deployed.test.ts` routes-list assertion

Missing any of these fails CI.

### Feature Flag Configuration

`FEATURE_FLAGS` in `wrangler.jsonc` is a JSON var
`{ base: Record<string,string>, floats: Record<string, Record<string,string>> }`.
Floats overlay `base`; invalid profiles → `{ float: "default", flags: base }`. Keep
production and `env.staging` aligned. 5-min cache; config changes need deploy. Keep
`/api/flags` in the routes array + both routes-list assertions.

### Signaling Model

Leader attaches via controller capability + WS to the DO. **Last-key-holder-wins
reconnect** — a leader reconnect with matching credentials closes the stale socket;
rejecting deadlocks on workerd's unreliable `webSocketClose`. Followers attach via the
join capability and bootstrap over HTTP poll. Preview bridge tabs (`serve --bridge`)
attach via `/__slicc/bridge` WS; DO relays `bridge.cdp.request`/`bridge.cdp.response`
keyed by `connId`, replays `bridge.connected` on leader (re)connect, hibernates via
`setWebSocketAutoResponse`. Ghost-leader analysis + full protocol:
[docs/cloudflare-worker-details.md § Signaling](../../docs/cloudflare-worker-details.md#signaling),
[deploying-tray-worker skill](../../.agents/skills/deploying-tray-worker/SKILL.md).

### TURN Credentials

Fetched with `CLOUDFLARE_TURN_KEY_ID` (in `wrangler.jsonc`) and
`CLOUDFLARE_TURN_API_TOKEN` (Wrangler secret). Follower push (#2062): `src/apns.ts` signs an ES256 JWT from `APNS_TEAM_ID` / `APNS_KEY_ID` / `APNS_PRIVATE_KEY` (`.p8` PEM) and posts to `api(.sandbox).push.apple.com` with `APNS_TOPIC`; the tray DO stores ≤16 `push.register` tokens per tray and fans out leader `push.send` (`turn_end`, time-sensitive `sudo_request`, metadata only), dropping tokens APNs reports dead. All four secrets or pushing is silently off. `session-tray.ts` caches ICE servers
and refreshes before TTL expiry.

### Tray Kind (desktop / hosted)

`TrayRecord.kind` is `'desktop' | 'hosted'` (default `'desktop'`). `POST /tray` reads
optional `kind`. Reclaim TTL branches through `reclaimMsForTray(tray)` in `shared.ts`:
`HOSTED_TRAY_RECLAIM_TTL_MS = 30 days` (hosted), `TRAY_RECLAIM_TTL_MS = 1 hour`
(desktop).

### Static Assets & R2

Worker serves `dist/ui/` via Static Assets (`ASSETS`); `?json=true`/POST/WS → API,
else SPA. **Cherry embed (`?cherry=1`):** `frame-ancestors` from
`ALLOWED_CHERRY_HOST_ORIGINS` (bare `*` also enumerates `chrome-extension://` origins);
non-cherry → `frame-ancestors 'none'`; cherry sets `Cache-Control: no-store` +
`Vary: Sec-Fetch-Dest`. **Non-cherry, non-electron SPA responses also carry
`Document-Isolation-Policy: isolate-and-credentialless`** — per-document
cross-origin isolation (SAB for vpod guest networking) without COOP/COEP;
cherry/electron branches must stay header-free (embedded, never need SAB). **25 MiB per-asset cap** — CI runs `wrangler deploy --dry-run`
as a hard gate. `ASSET_ARCHIVE` (R2) retains hashed `/assets/*` across deploys;
`serveAssetWithArchiveFallback` tries `ASSETS` → R2 → stale-asset reload; bucket GC
14 days. Full rules:
[docs/cloudflare-worker-details.md § Static Assets](../../docs/cloudflare-worker-details.md#static-assets);
ops: [deploying-tray-worker skill](../../.agents/skills/deploying-tray-worker/SKILL.md).

## Commands

```bash
# Build webapp first (required for static assets)
npm run build -w @slicc/webapp

npx wrangler dev --config packages/cloudflare-worker/wrangler.jsonc
npx wrangler deploy --env staging --config packages/cloudflare-worker/wrangler.jsonc
npx wrangler deploy --config packages/cloudflare-worker/wrangler.jsonc
cd packages/cloudflare-worker && WORKER_BASE_URL=https://... npm test -- tests/deployed.test.ts
```

Extension testing with the worker: `npm run start:extension`.

## CI and Deployment

`release-native.mjs --gate=worker` gates production. Hub + preview configs deploy as a
pair (shared DO/token format); R2 uploads always precede deploy. Routes-only failures
are non-fatal. Required: `CLOUDFLARE_API_TOKEN` (Workers Edit, R2 R/W, Zone Routes
Edit) + account ID. Retry logic, staging deploy, local `serve --bridge`:
[deploying-tray-worker skill](../../.agents/skills/deploying-tray-worker/SKILL.md).

## Operational Notes

- Worker is coordination infrastructure, not canonical session storage.
- `GET /status`: post-deploy liveness probe; `version` from `CF_VERSION_METADATA`
  binding (declared for default + `staging`; `unknown` when unbound). Unauthenticated
  — body is exactly `{ status, service, timestamp, version }`, never config/binding
  names. Signals: [`docs/operational-telemetry.md`](../../docs/operational-telemetry.md).
- `/handoff` is stateless; query params → single RFC 8288 `Link` header.
- Every response is wrapped by `applySliccLinks` (`src/links.ts`).
- Keep signaling protocol changes aligned with `packages/webapp/src/scoops/`.

## Cloud Cones (sliccy.ai/cloud)

Shipped via Plan D. All `/api/cloud/*` require
`Authorization: Bearer <ims-access-token>` and route to
`env.CLOUD_SESSIONS.idFromName(userId)` for per-user state. Route table:
[docs/cloudflare-worker-details.md § Cloud Routes](../../docs/cloudflare-worker-details.md#cloud-routes).

### Cone Configuration

`ConeConfig` = `{ model, accounts[], secrets[] }` (in `@slicc/cloud-core/cone-config`);
`src/cloud/cone-config-bridge.ts` handles start (writes `/slicc/secrets.env` +
`/slicc/cone-config.json`; no-config synthesizes Adobe default) and resume (merges
`coneConfigDelta`, reloads leader via `POST /api/secrets/reload` → `Page.reload`).
Adobe `{kind:'oauth'}` accounts stamp `tokenExpiresAt` via `imsTokenExpiry` (IMS JWT
`created_at + expires_in`). `CloudSessionsDurableObject` persists a **names-only**
`coneConfigIndex` — never values. Detail:
[docs/cloudflare-worker-details.md § Cone Configuration](../../docs/cloudflare-worker-details.md#cone-configuration).

### Wrangler Config (cloud)

Vars: `ADOBE_PROXY_ENDPOINT`; `ALLOWED_EMAIL_DOMAIN` (CSV, default `adobe.com`; `*` =
any); `BLOCKED_EMAILS` (CSV); `REQUIRE_OWNER_ORG` (`true` expands to ownerOrg-holders);
`CONE_CAP_RUNNING`, `CONE_CAP_PAUSED` (default 1/5); `ADMIN_USER_IDS` (CSV of IMS
userIds). Secret: `E2B_API_KEY` (worker-only).

### v1 → v2 Expansion

```bash
npx wrangler secret put REQUIRE_OWNER_ORG  # value: true
# update ALLOWED_EMAIL_DOMAIN in wrangler.jsonc to "*"
npx wrangler deploy
```

### Stable API Contract (worker ↔ sandbox)

Deprecation obligation — paused cones from older templates cannot be patched
in-place:

- `POST /api/leader-restart` (loopback in sandbox)
- `GET /api/hosted-bootstrap` (loopback in sandbox)
- `POST /api/cloud-status` (loopback in sandbox)
- `/slicc/secrets.env` — sandbox file the worker writes via SDK
- `/tmp/slicc-join.json` — sandbox file the worker reads via SDK
- `ADOBE_IMS_TOKEN`, `ADOBE_IMS_TOKEN_DOMAINS`, `SLICC_TRAY_WORKER_BASE_URL` — envs
  consumed by `start.sh`
