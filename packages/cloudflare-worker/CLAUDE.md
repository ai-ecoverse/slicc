# CLAUDE.md

Tray hub worker: tray session coordination, capability-token routing, TURN credential
lookup, leader/follower signaling for tray-connected SLICC runtimes; also serves the
built webapp as static assets.

Deep reference: [`docs/cloudflare-worker-details.md`](../../docs/cloudflare-worker-details.md).

## Main Files

- `src/index.ts` — entry + public HTTP routing
- `src/session-tray.ts` — `SessionTrayDurableObject`: controller WS (leader), follower
  WebRTC signaling, preview bridge WS
- `src/turn-credentials.ts` — TURN credential fetcher
- `src/shared.ts` — capability tokens; `reclaimMsForTray`;
  `TRAY_RECLAIM_TTL_MS`/`HOSTED_TRAY_RECLAIM_TTL_MS`
- `src/links.ts` — `applySliccLinks` (RFC 8288 `Link` rel set on every response)
- Public route handlers: `handoff-page.ts`, `api-catalog.ts`, `install-cli.ts`,
  `llms-txt.ts`, `privacy.ts`, `rel-docs.ts`, `flags.ts`
- OAuth relays (`/auth/callback`, `/auth/cloud-callback`): `oauth-exchange.ts`,
  `oauth-registry.ts`, `auth/cloud-callback.ts`
- `wrangler.jsonc` — bindings (`TRAY_HUB`, `CLOUD_SESSIONS`, `ASSETS`, `ASSET_ARCHIVE`,
  `CF_VERSION_METADATA`), staging env, feature flags
- `src/cloud/*` — `/api/cloud/*` handlers, `CloudSessionsDurableObject`, IMS auth,
  `checkCapsForRun` cone caps, DO-backed `Registry`, Adobe `/v1/config` sync,
  `rate-limit.ts`, `error-envelope.ts`

Sandbox lifecycle lives in `@slicc/cloud-core`; `src/cloud/` is adapter glue.

## Tray Hub Architecture

`TRAY_HUB` maps each tray to one `SessionTrayDurableObject`, tracking capabilities,
leader/follower state, reconnect windows, cached ICE servers.

### Public Routes

Full route inventory + per-route semantics:
[docs § Public Routes](../../docs/cloudflare-worker-details.md#public-routes) — covers
`/tray`, `/handoff`, `/join/:token`, `/controller/:token`, `/webhook/*`,
`/api/tray/:trayId/*`, `<token>.sliccy.now/*`, `__slicc/*`, `/auth/*`, `/api/flags`.

**Routes-mirror rule:** every new route MUST appear in all three or CI fails —
`src/index.ts` routes array (the default `GET /` body), and the routes-list assertions
in `tests/index.test.ts` and `tests/deployed.test.ts`.

### Feature Flag Configuration

`FEATURE_FLAGS` (`wrangler.jsonc`) is a JSON var
`{ base: Record<string,string>, floats: Record<string, Record<string,string>> }`.
Floats overlay `base`; invalid profiles → `{ float: "default", flags: base }`. Keep
production and `env.staging` aligned; 5-min cache, config changes need deploy.

### Signaling Model

Leader attaches via controller capability + WS to the DO. **Last-key-holder-wins
reconnect** — a matching-credential reconnect closes the stale socket; rejecting
deadlocks on workerd's unreliable `webSocketClose`. Followers attach via the join
capability, bootstrap over HTTP poll. Preview bridge tabs (`serve --bridge`) attach
via `/__slicc/bridge` WS; the DO relays `bridge.cdp.request`/`bridge.cdp.response`
keyed by `connId`, replays `bridge.connected` on leader (re)connect, hibernates via
`setWebSocketAutoResponse`. Ghost-leader analysis + full protocol:
[docs § Signaling](../../docs/cloudflare-worker-details.md#signaling),
[deploying-tray-worker skill](../../.agents/skills/deploying-tray-worker/SKILL.md).

### Supersede (redirect semantics, #1957)

A superseded tray answers `308` + `Location` (plus a `successor-version` link and a JSON
body) on **both** `/join/:token` and `/webhook/:token/:webhookId`, so a stale capability
URL routes to the replacement instead of dead-ending. `/join` and `/webhook/*` therefore
dispatch **before** `ensureTrayIsActive()` in the DO's `fetch`; the webhook relay applies
that gate itself, after the capability token and after the supersede check.

**Adding a capability that hands out a URL means storing its replacement on supersede.**
`supersededByJoinUrl` and `supersededByWebhookUrl` are separate fields because one carries
the join token and the other the webhook token — neither is derivable from the other, and
the webhook one exists because an external service caches that URL for the life of a long
job. Rules, ordering rationale, and the `json=true` convention:
[docs § Signaling](../../docs/cloudflare-worker-details.md#signaling).

### Biscotti (guest seats)

`TrayRecord.biscotti` holds revocable guest seats. `resolveJoinCapability`
(`src/shared.ts`) is the **single default-deny point** for `/join/:token`:
`{ trust: 'full' }` for the tray join token, `{ trust: 'biscotto' }` for a live seat,
`null` otherwise (revoked/expired seats are compared before filtering so their
existence does not leak by timing). Mint/revoke/list (`src/session-tray-biscotto.ts`)
are gated on the **controller** token — a seat is never an issuing authority.

**Trust travels on the controller socket, never the peer's `hello`.** The DO stamps
`trust` + `biscotto` onto `follower.join_requested` (leader-only). Since
`controllerId` is client-supplied, trust is re-derived from the presented token every
request; a mismatch against stored `ControllerRecord.biscottoId` is a 409
`JOIN_CAPABILITY_MISMATCH` both directions (a guest cannot inherit a full follower's
id, nor a full follower be shadowed by a guessed one). What a seat may _send_ is
enforced leader-side (`packages/webapp/src/scoops/tray-leader/biscotto-gate.ts`).

### TURN Credentials & Follower Push

TURN fetched with `CLOUDFLARE_TURN_KEY_ID` (`wrangler.jsonc`) +
`CLOUDFLARE_TURN_API_TOKEN` (secret); `session-tray.ts` caches ICE servers, refreshes
before TTL. Push (`src/apns.ts`): ES256 JWT from `APNS_TEAM_ID` / `APNS_KEY_ID` /
`APNS_PRIVATE_KEY` (`.p8` PEM) posted to `api(.sandbox).push.apple.com` with
`APNS_TOPIC`. The tray DO stores ≤16 `push.register` tokens per tray and fans out
leader `push.send` (`turn_end`, time-sensitive `sudo_request`, metadata only),
dropping tokens APNs reports dead; missing any secret → push silently off. **Provider
JWTs are minted by exactly one DO** (`src/apns-provider-token.ts`,
`idFromName('__apns_provider_token')`, storage-backed) — Apple throttles token
creation per team+key, so per-tray minting broke Apple's 20-min floor once trays
hibernated.

### Tray Kind (desktop / hosted)

`TrayRecord.kind` is `'desktop' | 'hosted'` (default `'desktop'`); `POST /tray` reads
optional `kind`. Reclaim TTL branches via `reclaimMsForTray(tray)` (`shared.ts`):
`HOSTED_TRAY_RECLAIM_TTL_MS` = 30 days, `TRAY_RECLAIM_TTL_MS` = 1 hour (desktop).

### Static Assets & R2

Worker serves `dist/ui/` via Static Assets (`ASSETS`); `?json=true`/POST/WS → API,
else SPA. **Cherry embed (`?cherry=1`):** `frame-ancestors` from
`ALLOWED_CHERRY_HOST_ORIGINS` (bare `*` also enumerates `chrome-extension://`);
non-cherry → `frame-ancestors 'none'`. Non-cherry, non-electron SPA responses carry
`Document-Isolation-Policy: isolate-and-credentialless` (SAB for vpod guest networking
without COOP/COEP); cherry/electron stay header-free. **25 MiB per-asset cap** — CI
`wrangler deploy --dry-run` gates it. `ASSET_ARCHIVE` (R2) retains hashed `/assets/*`
across deploys via `serveAssetWithArchiveFallback` (`ASSETS` → R2 → stale reload).
Full rules:
[docs § Static Assets](../../docs/cloudflare-worker-details.md#static-assets);
ops: [deploying-tray-worker skill](../../.agents/skills/deploying-tray-worker/SKILL.md).

## Commands

```bash
npm run build -w @slicc/webapp   # build webapp first (static assets)
CFG=packages/cloudflare-worker/wrangler.jsonc
npx wrangler dev --config "$CFG"
npx wrangler deploy --env staging --config "$CFG"   # drop --env staging for prod
cd packages/cloudflare-worker && WORKER_BASE_URL=https://... npm test -- tests/deployed.test.ts
```

Extension testing with the worker: `npm run start:extension`.

## CI and Deployment

`release-native.mjs --gate=worker` gates production. Hub + preview configs deploy as a
pair (shared DO/token format); R2 uploads precede deploy; routes-only failures
non-fatal. Needs `CLOUDFLARE_API_TOKEN` (Workers Edit, R2 R/W, Zone Routes Edit) +
account ID. Retry logic, staging deploy, local `serve --bridge`:
[deploying-tray-worker](../../.agents/skills/deploying-tray-worker/SKILL.md).

## Operational Notes

- Worker is coordination infrastructure, not canonical session store.
- `GET /status`: post-deploy liveness probe; `version` from `CF_VERSION_METADATA`
  (declared for default + `staging`; `unknown` when unbound). Unauthenticated — body
  is exactly `{ status, service, timestamp, version }`, never config/binding names.
  Signals: [`docs/operational-telemetry.md`](../../docs/operational-telemetry.md).
- `/handoff` is stateless; query params → single RFC 8288 `Link` header. Every response
  is wrapped by `applySliccLinks` (`src/links.ts`).
- Keep signaling protocol changes aligned with `packages/webapp/src/scoops/`.

## Cloud Cones (sliccy.ai/cloud)

All `/api/cloud/*` require `Authorization: Bearer <ims-access-token>` and route to
`env.CLOUD_SESSIONS.idFromName(userId)` for per-user state. Route table:
[docs § Cloud Routes](../../docs/cloudflare-worker-details.md#cloud-routes).

### Cone Configuration

`ConeConfig` = `{ model, accounts[], secrets[] }` (`@slicc/cloud-core/cone-config`);
`src/cloud/cone-config-bridge.ts` handles start (writes `/slicc/secrets.env` +
`/slicc/cone-config.json`; no-config → Adobe default) and resume (merges
`coneConfigDelta`, reloads leader via `POST /api/secrets/reload` → `Page.reload`).
Adobe `{kind:'oauth'}` accounts stamp `tokenExpiresAt` via `imsTokenExpiry`.
`CloudSessionsDurableObject` persists a **names-only** `coneConfigIndex` — never
values.
[docs § Cone Configuration](../../docs/cloudflare-worker-details.md#cone-configuration).

### Wrangler Config (cloud)

Vars: `ADOBE_PROXY_ENDPOINT`; `ALLOWED_EMAIL_DOMAIN` (CSV, default `adobe.com`, `*` =
any); `BLOCKED_EMAILS` (CSV); `REQUIRE_OWNER_ORG` (`true` → ownerOrg-holders);
`CONE_CAP_RUNNING`/`CONE_CAP_PAUSED` (default 1/5); `ADMIN_USER_IDS` (CSV of IMS
userIds). Secret: `E2B_API_KEY` (worker-only).

### v1 → v2 Expansion

`npx wrangler secret put REQUIRE_OWNER_ORG` (`true`), set `ALLOWED_EMAIL_DOMAIN` to `"*"`
in `wrangler.jsonc`, then `npx wrangler deploy`.

### Stable API Contract (worker ↔ sandbox)

Deprecation obligation — paused cones from older templates cannot be patched in-place:

- Sandbox loopback: `POST /api/leader-restart`, `GET /api/hosted-bootstrap`,
  `POST /api/cloud-status`
- `/slicc/secrets.env` (worker writes via SDK); `/tmp/slicc-join.json` (worker reads)
- `ADOBE_IMS_TOKEN`, `ADOBE_IMS_TOKEN_DOMAINS`, `SLICC_TRAY_WORKER_BASE_URL` — `start.sh` envs
