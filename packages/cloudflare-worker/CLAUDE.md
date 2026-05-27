# CLAUDE.md

This file covers the tray hub worker in `packages/cloudflare-worker/`.

## Scope

The worker provides tray session coordination, capability-token routing, TURN credential lookup, and leader/follower signaling for tray-connected SLICC runtimes. It also serves the built SLICC webapp as static assets to browser visitors.

## Main Files

- `src/index.ts` — worker entry point and public HTTP routing
- `src/session-tray.ts` — `SessionTrayDurableObject` state machine
- `src/tray-signaling.ts` — shared signaling message types
- `src/turn-credentials.ts` — Cloudflare TURN credential fetcher
- `src/shared.ts` — capability token and response helpers
- `wrangler.jsonc` — Wrangler config, Durable Object binding, staging env

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
- `GET /auth/callback` — OAuth callback relay page (decodes `state` param with source/port/path/nonce, redirects to localhost for `source:'local'`, extension for `source:'extension'`, or allowlisted remote origin for `source:'remote'`)

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
- `POST /api/cloud/start` — start a new cone (auth + cap-checked)
- `GET  /api/cloud/list` — per-user cone list (reconciled with e2b per call)
- `POST /api/cloud/pause` — pause a cone
- `POST /api/cloud/resume` — resume a paused cone (refreshes IMS token in sandbox)
- `POST /api/cloud/kill` — kill a cone (idempotent)
- `POST /api/cloud/sign-out` — invalidate the auth cache entry for the bearer
- `GET  /api/cloud/admin/stats` — admin-gated by `ADMIN_USER_IDS`

All `/api/cloud/*` require `Authorization: Bearer <ims-access-token>` and route to `env.CLOUD_SESSIONS.idFromName(userId)` for per-user state. Lifecycle business logic lives inside the DurableObject (atomic via `state.blockConcurrencyWhile`), not in worker handlers.

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
