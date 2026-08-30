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

Route inventory lives in `src/index.ts` (the default `GET /` body). Per-route
semantics: [docs/cloudflare-worker-details.md § Public Routes](../../docs/cloudflare-worker-details.md#public-routes).

**Routes-mirror rule:** every new route MUST appear in

1. `src/index.ts` routes array (the default `GET /` body)
2. `tests/index.test.ts` routes-list assertion
3. `tests/deployed.test.ts` routes-list assertion

Missing any of these fails CI.

### Feature Flag Configuration

`FEATURE_FLAGS` in `wrangler.jsonc`:
`{ base: Record<string,string>, floats: Record<string, Record<string,string>> }`.
Floats overlay `base`; invalid profiles fall back to `base`. 5-min cache;
config changes need deploy. Keep `/api/flags` in the routes array + both
routes-list assertions. Align production and `env.staging`.

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

### Biscotti (guest seats)

`TrayRecord.biscotti` holds revocable guest seats. `resolveJoinCapability`
(`src/shared.ts`) is the **single default-deny point** for `/join/:token`:
`{ trust: 'full' }` / `{ trust: 'biscotto' }` / `null` (revoked seats are
compared before filter so existence does not leak by timing). Mint/revoke/list
in `src/session-tray-biscotto.ts`, gated on the **controller** token.

**Trust travels on the controller socket, never the peer's `hello`.** The DO
stamps `trust` + `biscotto` onto `follower.join_requested`. `controllerId` is
client-supplied, so trust is re-derived from the presented token; mismatch vs
`ControllerRecord.biscottoId` → 409 `JOIN_CAPABILITY_MISMATCH` both ways.
What a seat may _send_ is leader-side (`biscotto-gate.ts`).

### TURN Credentials

Fetched with `CLOUDFLARE_TURN_KEY_ID` (`wrangler.jsonc`) and
`CLOUDFLARE_TURN_API_TOKEN` (Wrangler secret). Follower push: `src/apns.ts`
signs an ES256 JWT (`APNS_TEAM_ID` / `APNS_KEY_ID` / `APNS_PRIVATE_KEY`) and
posts to `api(.sandbox).push.apple.com` (`APNS_TOPIC`). The tray DO stores
≤16 `push.register` tokens and fans out leader `push.send` (`turn_end`,
time-sensitive `sudo_request`, metadata only), dropping tokens APNs reports
dead. All four secrets or pushing is silently off. **Provider JWTs are minted
by exactly one DO** (`src/apns-provider-token.ts`,
`idFromName('__apns_provider_token')`): Apple throttles per team+key.
`session-tray.ts` caches ICE servers and refreshes before TTL expiry.

### Tray Kind (desktop / hosted)

`TrayRecord.kind` is `'desktop' | 'hosted'` (default `'desktop'`). `POST /tray` reads
optional `kind`. Reclaim TTL branches through `reclaimMsForTray(tray)` in `shared.ts`:
`HOSTED_TRAY_RECLAIM_TTL_MS = 30 days` (hosted), `TRAY_RECLAIM_TTL_MS = 1 hour`
(desktop).

### Static Assets & R2

Worker serves `dist/ui/` via `ASSETS`; `?json=true`/POST/WS → API, else SPA.
**Cherry (`?cherry=1`):** `frame-ancestors` from `ALLOWED_CHERRY_HOST_ORIGINS`
(`*` also enumerates `chrome-extension://`); non-cherry → `'none'`; cherry
sets `Cache-Control: no-store` + `Vary: Sec-Fetch-Dest`. Non-cherry,
non-electron SPA also sets `Document-Isolation-Policy:
isolate-and-credentialless` (SAB for vpod without COOP/COEP) — cherry/electron
must stay header-free. **25 MiB per-asset cap** (`wrangler deploy --dry-run`).
`ASSET_ARCHIVE` (R2) keeps hashed `/assets/*`; fallback `ASSETS` → R2 →
stale-reload; GC 14 days. Full rules:
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

`release-native.mjs --gate=worker` gates production. Hub + preview configs deploy
as a pair; R2 uploads precede deploy. Routes-only failures are non-fatal.
Token: Workers Edit, R2 R/W, Zone Routes Edit. Retry / staging / `serve --bridge`:
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

`ConeConfig` = `{ model, accounts[], secrets[] }` (`@slicc/cloud-core/cone-config`).
`cone-config-bridge.ts` writes `/slicc/secrets.env` + `/slicc/cone-config.json` on
start (Adobe default if empty) and merges `coneConfigDelta` on resume (`POST
/api/secrets/reload` → `Page.reload`). OAuth accounts stamp `tokenExpiresAt` via
`imsTokenExpiry`. The DO persists a **names-only** `coneConfigIndex`. Detail:
[docs/cloudflare-worker-details.md § Cone Configuration](../../docs/cloudflare-worker-details.md#cone-configuration).

### Wrangler Config (cloud)

Vars: `ADOBE_PROXY_ENDPOINT`; `ALLOWED_EMAIL_DOMAIN` (CSV, default `adobe.com`; `*` =
any); `BLOCKED_EMAILS` (CSV); `REQUIRE_OWNER_ORG` (`true` expands to ownerOrg-holders);
`CONE_CAP_RUNNING`, `CONE_CAP_PAUSED` (default 1/5); `ADMIN_USER_IDS` (CSV of IMS
userIds). Secret: `E2B_API_KEY` (worker-only). Open-domain → ownerOrg-gated
runbook: [docs/cloudflare-worker-details.md § v1 → v2 Expansion](../../docs/cloudflare-worker-details.md#v1-v2-expansion).

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
