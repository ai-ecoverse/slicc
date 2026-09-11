# CLAUDE.md

Tray hub worker: tray session coordination, capability-token routing, TURN credential
lookup, leader/follower signaling for tray-connected SLICC runtimes; also serves the built
webapp as static assets. Deep reference:
[`docs/cloudflare-worker-details.md`](../../docs/cloudflare-worker-details.md).

## Main Files

- `src/index.ts` — entry + public HTTP routing
- `src/session-tray.ts` — `SessionTrayDurableObject`: controller WS (leader), follower
  WebRTC signaling, preview bridge WS
- `src/preview-continuity.ts` — dual-controller preview transfer; original token trays
  remain direct locators across roves, with durable retry receipts and unchanged R2 expiry
- `src/webhook-home.ts` — `WebhookHomeDurableObject`: stable cone-scoped webhook
  indirection (#2812); keyed by `coneId`, resolves to the current tray, forwards deliveries
- `src/turn-credentials.ts` — TURN fetcher
- `src/shared.ts` — capability tokens; `reclaimMsForTray`;
  `TRAY_RECLAIM_TTL_MS`/`HOSTED_TRAY_RECLAIM_TTL_MS`
- `src/links.ts` — `applySliccLinks` (RFC 8288 `Link` rel set on every response)
- Public route handlers: `handoff-page.ts`, `api-catalog.ts`, `install-cli.ts`,
  `llms-txt.ts`, `privacy.ts`, `rel-docs.ts`, `flags.ts`
- OAuth relays (`/auth/callback`, `/auth/cloud-callback`): `oauth-exchange.ts`,
  `oauth-registry.ts`, `auth/cloud-callback.ts`
- `wrangler.jsonc` — bindings (`TRAY_HUB`, `CLOUD_SESSIONS`, `ASSETS`, `ASSET_ARCHIVE`,
  `CF_VERSION_METADATA`), staging env, flags
- `src/cloud/*` — `/api/cloud/*` handlers, `CloudSessionsDurableObject`, IMS auth,
  `checkCapsForRun` cone caps, DO-backed `Registry`, Adobe `/v1/config` sync,
  `rate-limit.ts`, `error-envelope.ts`. Sandbox lifecycle lives in `@slicc/cloud-core`;
  `src/cloud/` is adapter glue.

## Tray Hub Architecture

`TRAY_HUB` maps each tray to one `SessionTrayDurableObject`, tracking capabilities,
leader/follower state, reconnect windows, cached ICE servers.

### Public Routes

Full route inventory + per-route semantics:
[docs § Public Routes](../../docs/cloudflare-worker-details.md#public-routes).

**Routes-mirror rule:** every new route MUST appear in all three or CI fails —
`src/index.ts` routes array (the default `GET /` body) and the routes-list assertions in
`tests/index.test.ts` + `tests/deployed.test.ts`.

### Feature Flag Configuration

`FEATURE_FLAGS` (`wrangler.jsonc`) is a JSON var
`{ base: Record<string,string>, floats: Record<string, Record<string,string>> }`.
Floats overlay `base`; invalid profiles → `{ float: "default", flags: base }`. Keep prod
and `env.staging` aligned; 5-min cache, config changes need deploy.

### Signaling Model

Leader attaches via controller capability + WS to the DO. **Last-key-holder-wins
reconnect** — a matching-credential reconnect closes the stale socket; rejecting
deadlocks on workerd's unreliable `webSocketClose`. Followers attach via the join
capability, bootstrap over HTTP poll. Preview bridge tabs (`serve --bridge`) attach via
`/__slicc/bridge` WS and relay CDP keyed by `connId`, hibernating via
`setWebSocketAutoResponse`. Ghost-leader analysis + protocol:
[docs § Signaling](../../docs/cloudflare-worker-details.md#signaling).

### Supersede (redirect semantics)

A superseded tray answers `308` + `Location` (plus a `successor-version` link and JSON
body) on **both** `/join/:token` and `/webhook/:token/:webhookId`. Both dispatch
**before** `ensureTrayIsActive()` in the DO's `fetch`; the webhook relay applies that gate
itself, after the capability token and the supersede check.

**Only a FULL follower is redirected on `/join`.** The successor URL carries the
replacement tray's full join token; a `biscotto` guest seat has no claim on it, so
`handleJoin` branches on `capability.trust` and answers a guest on a superseded tray with a
terminal `410 TRAY_EXPIRED` (no `Location`, no link, no `joinUrl`) rather than forwarding
it — otherwise the redirect would silently promote a guest to a full follower of the new
tray. Reuse the existing terminal `TRAY_EXPIRED` contract: browser and iOS wire validators
reject `TRAY_SUPERSEDED` without a `joinUrl`, even if a native decoded model makes that
field optional. No Swift or Go protocol change is needed.

**The webhook surface is session-lineage-stable (#2812), not per-WorkUnit.** A webhook URL is
`/wh/<coneId>.<secret>/<id>`, routed to `WEBHOOK_HOMES.idFromName(coneId)` — a
`WebhookHomeDurableObject` that verifies the secret and INTERNAL-FORWARDS to whichever tray
is current (`/internal/webhook/:id` on the tray, which runs the relay minus the public token
check). No redirect, no capability in a response header: a rove is invisible to an external
sender. The leader mints `coneId` + the delivery + rebind secrets once, persists them in
manager-private, worker-URL-scoped IndexedDB (not public session/status or the VFS), and
sends the same three on every `POST /tray` so the worker REBINDS the home instead of minting
a new URL. **Rebind is two-factor**: the home's own rebind secret AND the target tray
confirming the controller token (`/internal/confirm-controller`), so a leaked coneId cannot
steer deliveries at a tray the caller does not lead. Stable-aware creates also require a
private `createAttemptId`, persisted before the request and retained until the returned session
is durable. The cone ID, rebind secret and attempt derive an opaque tray address: failed binds
and lost responses reuse the original tray/capabilities; deliberate resets mint a fresh attempt.
Identity-less clients keep the legacy `/webhook/<trayId>...` shape with NO home dependency.
Its `supersededByWebhookUrl` 308 remains for those clients and already-cached URLs;
`supersededByJoinUrl` still drives the join surface. Ordering, `json=true` convention:
[docs § Signaling](../../docs/cloudflare-worker-details.md#signaling).

### WebhookHome lifecycle

Stores `{ coneId, secretHash, rebindSecretHash, currentTrayId, revokedAt?, lastReboundAt }`
in DO storage (never KV — the read matters the instant after a rebind, when KV would still
serve the old tray). Only secret HASHES are stored. A home self-expires after
`WEBHOOK_HOME_TTL_MS` (90d) with no rebind; `revoke` tombstones it permanently
(`revokedAt` → 410, never resurrects). New DO class means a `wrangler.jsonc` binding
(`WEBHOOK_HOMES`) + migration tag (`v3-webhook-homes`, `new_sqlite_classes`), prod +
`env.staging` aligned.

Every delivery is durably enqueued before forwarding or `202`; acceptance is not completed
agent work. Replay is at-least-once and removes an event only after an explicit
`delivered|filtered` acknowledgement, registration revocation, or three explicit
unknown-registration/unresolved-target rejections at least 30 seconds apart. Rejections
atomically move to a separate latest-100 terminal archive with a durable lifetime counter;
older terminal details may be replaced, never pending work. Ambiguous/transient responses
retain the event and reset the rejection streak. Explicit rejection backoff permits other
IDs to proceed, preserving FIFO within each ID. Limits: 100 events, 120 KiB encoded home
record (including retry-metadata reservation), 64 KiB request
body, eight pending requests; saturation rejects new work with `429`, never evicts accepted
events. There is no accepted-event TTL. Durable alarms retry after 30 seconds when blocked,
or one second after successful head removal with backlog.

Rotation atomically replaces both delivery and management hashes and an exact retry receipt
on the same home, retaining identity and queued work. The manager persists fresh random
replacements in private pending intent before HTTP. Exact replay requires both replacements;
old management secrets cannot authorize fresh mutations. Legacy deterministic pending intents
fail closed without clearing storage. Registration deletion persists permanent hashed-ID
tombstones before discarding that ID's queue; local definitions are removed only after hub
acknowledgement. See [lifecycle details](../../docs/cloudflare-worker-details.md#signaling)
for error semantics and limits.

### Biscotti (guest seats)

`TrayRecord.biscotti` holds revocable guest seats. `resolveJoinCapability`
(`src/shared.ts`) is the **single default-deny point** for `/join/:token`:
`{ trust: 'full' }` for the tray join token, `{ trust: 'biscotto' }` for a live seat,
`null` otherwise (revoked/expired seats compared before filtering so their existence does
not leak by timing). Mint/revoke/list (`src/session-tray-biscotto.ts`) are gated on the
**controller** token — a seat is never an issuing authority.

**Trust travels on the controller socket, never the peer's `hello`.** The DO stamps
`trust` + `biscotto` onto `follower.join_requested` (leader-only). Since `controllerId`
is client-supplied, trust is re-derived from the presented token per request; a mismatch
against stored `ControllerRecord.biscottoId` is a 409 `JOIN_CAPABILITY_MISMATCH` both
directions (no guest inherits a full follower's id, no full follower is shadowed by a
guess). What a seat may _send_ is enforced leader-side (`biscotto-gate.ts` in
`packages/webapp/src/scoops/tray-leader/`).

### TURN Credentials & Follower Push

TURN fetched with `CLOUDFLARE_TURN_KEY_ID` (`wrangler.jsonc`) +
`CLOUDFLARE_TURN_API_TOKEN` (secret); `session-tray.ts` caches ICE servers, refreshes
before TTL. Push (`src/apns.ts`): ES256 JWT from `APNS_TEAM_ID` / `APNS_KEY_ID` /
`APNS_PRIVATE_KEY` (`.p8` PEM) posted to `api(.sandbox).push.apple.com` with `APNS_TOPIC`.
The tray DO stores ≤16 `push.register` tokens per tray and fans out leader `push.send`
(`turn_end`, time-sensitive `sudo_request`, metadata only), dropping dead tokens; a
missing secret → push off. **Provider JWTs are minted by exactly one DO**
(`src/apns-provider-token.ts`, `idFromName('__apns_provider_token')`, storage-backed) —
Apple throttles token creation per team+key, so per-tray minting broke its 20-min floor.

### Tray Kind (desktop / hosted)

`TrayRecord.kind` is `'desktop' | 'hosted'` (default `'desktop'`; `POST /tray` reads
optional `kind`). Reclaim TTL branches via `reclaimMsForTray(tray)` (`shared.ts`):
`HOSTED_TRAY_RECLAIM_TTL_MS` = 30 days, `TRAY_RECLAIM_TTL_MS` = 1 hour.

### Static Assets & R2

Worker serves `dist/ui/` via Static Assets (`ASSETS`); `?json=true`/POST/WS → API, else
SPA. **Cherry embed (`?cherry=1`):** `frame-ancestors` from `ALLOWED_CHERRY_HOST_ORIGINS`
(bare `*` also enumerates `chrome-extension://`); non-cherry → `frame-ancestors 'none'`.
Non-cherry, non-electron SPA responses carry
`Document-Isolation-Policy: isolate-and-credentialless` (SAB without COOP/COEP);
cherry/electron stay header-free. **25 MiB per-asset cap**, CI `wrangler deploy --dry-run`
gates it. `ASSET_ARCHIVE` (R2) retains hashed `/assets/*` across deploys via
`serveAssetWithArchiveFallback` (`ASSETS` → R2 → stale reload). Full rules:
[docs § Static Assets](../../docs/cloudflare-worker-details.md#static-assets).

## Commands

```bash
npm run build -w @slicc/webapp   # build webapp first (static assets)
CFG=packages/cloudflare-worker/wrangler.jsonc
npx wrangler dev --config "$CFG"
# Mandatory read-only prerequisite for any live deploy or secret mutation:
node packages/cloudflare-worker/scripts/verify-preview-lifecycle.mjs sliccy-now-basic-storage
npx wrangler deploy --env staging --config "$CFG"   # drop --env staging for prod
cd packages/cloudflare-worker && WORKER_BASE_URL=https://... npm test -- tests/deployed.test.ts
```

## CI and Deployment

`release-native.mjs --gate=worker` gates production. Hub + preview configs deploy as a
pair (shared DO/token format); R2 uploads precede deploy; routes-only failures non-fatal.
Bounded preview leases require an enabled `previews/` object-age lifecycle rule on
`sliccy-now-basic-storage` (shared production/staging `PREVIEW_STORAGE`): provision
90-day expiry before rollout. The read-only `verify-preview-lifecycle.mjs` gate fails
deployment if absent/unsafe/unreadable; it never mutates bucket policy. The minimum
safe age is >60 days (30d pending + 30d ready), the maximum accepted age is 90 days.
This is separate from the asset archive's 14-day rule. Preserve the preview rule even
after rollback so arbitrarily late R2 writes eventually expire; see the runbook for
operator setup and permissions. Local dev/dry-run builds do not need the gate.
Needs `CLOUDFLARE_API_TOKEN` (Workers Edit, R2 R/W, Zone Routes Edit) + account ID. Retry
logic, staging deploy, `serve --bridge`:
[deploying-tray-worker](../../.agents/skills/deploying-tray-worker/SKILL.md).

Extension testing with the worker: `npm run start:extension`.

## Operational Notes

- Worker is coordination infrastructure, not canonical session store.
- `GET /status`: post-deploy liveness probe; `version` from `CF_VERSION_METADATA`
  (default + `staging`; `unknown` when unbound). Unauthenticated — body is exactly
  `{ status, service, timestamp, version }`, never config/binding names. Signals:
  [`docs/operational-telemetry.md`](../../docs/operational-telemetry.md).
- `/handoff` is stateless; query params → single RFC 8288 `Link` header. Every response
  wrapped by `applySliccLinks` (`src/links.ts`).
- Keep signaling protocol changes aligned with `packages/webapp/src/scoops/`.

## Cloud Cones (sliccy.ai/cloud)

All `/api/cloud/*` require `Authorization: Bearer <ims-access-token>` and route to
`env.CLOUD_SESSIONS.idFromName(userId)` (per-user state). Routes:
[docs § Cloud Routes](../../docs/cloudflare-worker-details.md#cloud-routes).

### Cone Configuration

`ConeConfig` = `{ model, accounts[], secrets[] }` (`@slicc/cloud-core/cone-config`);
`src/cloud/cone-config-bridge.ts` handles start (writes `/slicc/secrets.env` +
`/slicc/cone-config.json`; no-config → Adobe default) and resume (merges
`coneConfigDelta`, reloads leader via `POST /api/secrets/reload`).
`CloudSessionsDurableObject` persists a **names-only** `coneConfigIndex`, never values.
[docs § Cone Configuration](../../docs/cloudflare-worker-details.md#cone-configuration).

### Wrangler Config (cloud)

Vars: `ADOBE_PROXY_ENDPOINT`; `ALLOWED_EMAIL_DOMAIN` (CSV, default `adobe.com`, `*` =
any); `BLOCKED_EMAILS` (CSV); `REQUIRE_OWNER_ORG` (`true` → ownerOrg-holders);
`CONE_CAP_RUNNING`/`CONE_CAP_PAUSED` (default 1/5); `ADMIN_USER_IDS` (CSV of IMS userIds).
Secret: `E2B_API_KEY` (worker-only).

### v1 → v2 Expansion

`npx wrangler secret put REQUIRE_OWNER_ORG` (`true`), set `ALLOWED_EMAIL_DOMAIN` to `"*"`,
then `npx wrangler deploy`.

### Stable API Contract (worker ↔ sandbox)

Deprecation obligation — paused cones from older templates can't be patched in-place:

- Sandbox loopback: `POST /api/leader-restart`, `GET /api/hosted-bootstrap`,
  `POST /api/cloud-status`
- `/slicc/secrets.env` (worker writes via SDK); `/tmp/slicc-join.json` (worker reads)
- `ADOBE_IMS_TOKEN`, `ADOBE_IMS_TOKEN_DOMAINS`, `SLICC_TRAY_WORKER_BASE_URL` — `start.sh` envs
