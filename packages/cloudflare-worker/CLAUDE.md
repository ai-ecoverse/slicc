# CLAUDE.md

Tray hub worker: tray session coordination, capability-token routing, TURN lookup, leader/follower
signaling for tray-connected runtimes; also serves the built webapp as static assets. Full detail:
[`docs/cloudflare-worker-details.md`](../../docs/cloudflare-worker-details.md).

## Layer stack

Import direction `shared/links/auth → routes → entry` (`src/index.ts` = composition root), enforced
by `npm run lint:layer-back-edges` (`layer-back-edge-baseline-cloudflare-worker.json`). Route modules
must not import each other sideways; helpers (`shared.ts`, `links.ts`, `auth/`, `session-tray-*`)
must not import routes or `index.ts`.

## Main Files

- `src/index.ts` — entry + public HTTP routing
- `src/session-tray.ts` — `SessionTrayDurableObject`: controller WS (leader), follower WebRTC
  signaling, preview bridge WS
- `src/preview-continuity.ts` — dual-controller preview transfer across roves (durable receipts)
- `src/webhook-home.ts` — `WebhookHomeDurableObject`: cone-scoped webhook indirection keyed by
  `coneId`
- `src/turn-credentials.ts` — TURN fetcher; `src/shared.ts` — cap tokens, `reclaimMsForTray`
- `src/links.ts` — `applySliccLinks` (RFC 8288 `Link` rel set on every response)
- Static-page/OAuth-relay handlers under `src/` (`handoff-page.ts`, `install-cli.ts`,
  `oauth-exchange.ts`, `auth/cloud-callback.ts`, …)
- `wrangler.jsonc` — bindings (`TRAY_HUB`, `CLOUD_SESSIONS`, `ASSETS`, `ASSET_ARCHIVE`,
  `CF_VERSION_METADATA`), staging env, flags
- `src/cloud/*` — `/api/cloud/*` glue (see [Cloud Cones](#cloud-cones-sliccyaicloud)); sandbox
  lifecycle lives in `@slicc/cloud-core`

## Tray Hub Architecture

`TRAY_HUB` maps each tray to one `SessionTrayDurableObject` (capabilities, leader/follower state,
reconnect windows, ICE cache).

### Public Routes

Full inventory + semantics: [docs § Public Routes](../../docs/cloudflare-worker-details.md#public-routes).

**Routes-mirror rule:** every new route MUST appear in all three or CI fails — the `src/index.ts`
routes array (default `GET /` body), and routes-list assertions in `tests/index.test.ts` +
`tests/deployed.test.ts`.

### Feature Flag Configuration

`FEATURE_FLAGS` (`wrangler.jsonc`) JSON var: `{ base, floats }` (per-float maps overlay `base`);
invalid profiles → `{ float: "default", flags: base }`. Keep prod + `env.staging` aligned; 5-min
cache, changes need deploy. Keys must be in the webapp `FeatureFlagId` registry (`lint:dead-flags`
fails undeclared). [`docs/feature-flags.md`](../../docs/feature-flags.md).

### Signaling Model

Leader attaches via controller capability + WS to the DO. **Last-key-holder-wins reconnect** — a
matching-credential reconnect closes the stale socket; rejecting deadlocks on workerd's unreliable
`webSocketClose`. Followers attach via join capability (HTTP-poll bootstrap); bridge tabs
(`serve --bridge`) via `/__slicc/bridge` WS, relaying CDP keyed by `connId`.
[docs § Signaling](../../docs/cloudflare-worker-details.md#signaling).

### Supersede (redirect semantics)

A superseded tray answers `308` + `Location` on **both** `/join/:token` and
`/webhook/:token/:webhookId`, dispatching **before** the DO's `ensureTrayIsActive()` gate.
**Only a FULL follower is redirected on `/join`:** a `biscotto` guest instead gets a terminal
`410 TRAY_EXPIRED` (no `Location`/link/`joinUrl`) — forwarding the successor's join token would
silently promote a guest.

### Webhook homes (session-lineage-stable)

Webhook URLs survive roves. `/wh/<coneId>.<secret>/<id>` → `WEBHOOK_HOMES.idFromName(coneId)`, a
`WebhookHomeDurableObject` that verifies the secret and INTERNAL-FORWARDS to the current tray
(`/internal/webhook/:id`), invisible to sender. Invariants:

- **Rebind is two-factor** — home's rebind secret AND target tray confirming the controller token
  (`/internal/confirm-controller`): a leaked coneId cannot steer deliveries. Leader resends secrets
  on each `POST /tray` to rebind, never remint.
- **Home record** stores secret HASHES only, in DO storage never KV (KV would still serve the dead
  tray the instant after a rebind). `WEBHOOK_HOME_TTL_MS` (90d) self-expiry; `revoke` → permanent 410. New DO class needs binding `WEBHOOK_HOMES` + migration tag `v3-webhook-homes`
  (`new_sqlite_classes`); prod + staging aligned.

Delivery/replay/limits, legacy `/webhook/<trayId>` (`supersededByWebhookUrl` 308), rotation, schema:
[docs](../../docs/cloudflare-worker-details.md#signaling).

### Biscotti (guest seats)

`TrayRecord.biscotti` holds revocable guest seats. `resolveJoinCapability` (`src/shared.ts`) is
the **single default-deny point** for `/join/:token`: `{ trust: 'full' }` for the tray join token,
`{ trust: 'biscotto' }` for a live seat, `null` otherwise (revoked/expired seats compared before
filtering, so existence never leaks by timing). Mint/revoke/list (`src/session-tray-biscotto.ts`)
gated on the **controller** token. **Trust travels on the controller socket, never the peer's
`hello`:** the DO stamps `trust` + `biscotto` onto `follower.join_requested` (leader-only); client
`controllerId` mismatch vs stored `ControllerRecord.biscottoId` → `409 JOIN_CAPABILITY_MISMATCH`.
What a seat may _send_ is gated leader-side by `packages/webapp/src/scoops/tray-leader/biscotto-gate.ts`.

### TURN Credentials & Follower Push

TURN uses `CLOUDFLARE_TURN_KEY_ID` + `CLOUDFLARE_TURN_API_TOKEN`. APNS push (`src/apns.ts`) fans
out leader `push.send` (metadata only). **Provider JWTs minted by exactly one DO**
(`src/apns-provider-token.ts`, `idFromName('__apns_provider_token')`) — Apple throttles token
creation per team+key, so per-tray minting broke its floor. Secrets, cap, events:
[docs § TURN & Push](../../docs/cloudflare-worker-details.md#turn-push).

### Tray Kind (desktop / hosted)

`TrayRecord.kind` is `'desktop' | 'hosted'` (default `'desktop'`). Reclaim TTL via
`reclaimMsForTray(tray)` (`shared.ts`): hosted = 30 days (`HOSTED_TRAY_RECLAIM_TTL_MS`), desktop =
1 hour (`TRAY_RECLAIM_TTL_MS`).

### Static Assets & R2

Worker serves `dist/ui/` via Static Assets (`ASSETS`); `?json=true`/POST/WS → API, else SPA.
`frame-ancestors`/isolation headers branch on cherry (`?cherry=1`) vs electron vs plain SPA.
**25 MiB per-asset cap** (CI `wrangler deploy --dry-run` gates it). `ASSET_ARCHIVE` (R2) retains
hashed `/assets/*` across deploys (14-day GC). [docs](../../docs/cloudflare-worker-details.md#static-assets).

## Commands

```bash
npm run build -w @slicc/webapp   # build webapp first (static assets)
CFG=packages/cloudflare-worker/wrangler.jsonc
npx wrangler dev --config "$CFG"
# Read-only prerequisite for any live deploy or secret mutation:
node packages/cloudflare-worker/scripts/verify-preview-lifecycle.mjs sliccy-now-basic-storage
npx wrangler deploy --env staging --config "$CFG"   # omit --env staging for prod
cd packages/cloudflare-worker && WORKER_BASE_URL=https://... npm test -- tests/deployed.test.ts
```

## CI and Deployment

`release-native.mjs --gate=worker` gates production. Hub + preview configs deploy as a pair
(shared DO/token format); asset-changing deploys archive R2 first; routes-only failures non-fatal.
The `verify-preview-lifecycle.mjs` gate (above) blocks deployment when `sliccy-now-basic-storage`
lacks a `previews/` object-age lifecycle rule. TTL math, token scopes, retries, staging deploy,
`serve --bridge`, operator setup:
[deploying-tray-worker](../../.agents/skills/deploying-tray-worker/SKILL.md). Extension: `npm run start:extension`.

## Operational Notes

- Worker is coordination infrastructure, not a canonical session store.
- `GET /status`: unauthenticated liveness probe; body is exactly
  `{ status, service, timestamp, version }` (`version` from `CF_VERSION_METADATA`, `unknown` when
  unbound), never config/binding names. [Signals](../../docs/operational-telemetry.md).
- `/handoff` is stateless; every response wrapped by `applySliccLinks` (`src/links.ts`).
- Keep signaling protocol changes aligned with `packages/webapp/src/scoops/`.

## Cloud Cones (sliccy.ai/cloud)

All `/api/cloud/*` require `Authorization: Bearer <ims-access-token>` and route to
`env.CLOUD_SESSIONS.idFromName(userId)` (per-user): IMS auth, `checkCapsForRun` cone caps, DO-backed
`Registry`, Adobe `/v1/config` sync, rate limit + error envelopes.
[Route table](../../docs/cloudflare-worker-details.md#cloud-routes).

### Cone Configuration

`ConeConfig` = `{ model, accounts[], secrets[] }` (`@slicc/cloud-core/cone-config`);
`cone-config-bridge.ts` bridges start/resume into the sandbox. Safety invariant:
`CloudSessionsDurableObject` persists a **names-only** `coneConfigIndex`, never values.
[Flow](../../docs/cloudflare-worker-details.md#cone-configuration).

### Wrangler Config (cloud)

Vars: `ADOBE_PROXY_ENDPOINT`; `ALLOWED_EMAIL_DOMAIN` (CSV, default `adobe.com`, `*` = any);
`BLOCKED_EMAILS` (CSV); `REQUIRE_OWNER_ORG` (`true` → ownerOrg-holders);
`CONE_CAP_RUNNING`/`CONE_CAP_PAUSED` (default 1/5); `ADMIN_USER_IDS` (CSV IMS userIds). Secret:
`E2B_API_KEY`. **v1 → v2:** `REQUIRE_OWNER_ORG=true`, `ALLOWED_EMAIL_DOMAIN="*"`, deploy.

### Stable API Contract (worker ↔ sandbox)

Deprecation obligation — paused cones from older templates can't be patched:

- Loopback: `POST /api/leader-restart`, `GET /api/hosted-bootstrap`, `POST /api/cloud-status`
- `/slicc/secrets.env` (worker writes via SDK); `/tmp/slicc-join.json` (worker reads)
- `start.sh` envs: `ADOBE_IMS_TOKEN`, `ADOBE_IMS_TOKEN_DOMAINS`, `SLICC_TRAY_WORKER_BASE_URL`
