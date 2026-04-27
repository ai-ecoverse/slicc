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
- `GET /handoff` — echoes the `msg` query parameter into an `x-slicc` response header so SLICC can emit a `navigate` lick and show the user an approval prompt
- `GET|POST /join/:token` — follower join and bootstrap polling flow
- `GET|POST /controller/:token` — leader attach flow and leader WebSocket upgrade
- `POST /webhook/:token/:webhookId` — forward webhook events into the live leader
- `GET /auth/callback` — OAuth callback relay page (decodes `state` param with port/path/nonce, redirects to localhost)

### Signaling model

- A leader first attaches through the controller capability.
- The elected leader opens a WebSocket to the Durable Object.
- Followers attach through the join capability and bootstrap over HTTP poll/answer/ice-candidate/retry actions.
- The Durable Object forwards control messages to the live leader and expires trays that are not reclaimed in time.

### TURN credentials

- TURN credentials are fetched with `CLOUDFLARE_TURN_KEY_ID` and `CLOUDFLARE_TURN_API_TOKEN`.
- `session-tray.ts` caches ICE servers and refreshes them before TTL expiry.
- `wrangler.jsonc` defines the key ID; the API token is stored as a Wrangler secret.

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
- The `/handoff` page is intentionally stateless; the `msg` query parameter is echoed into the `x-slicc` response header and the page body is only an informational preview.
- Keep signaling protocol changes aligned with the browser tray runtime in `packages/webapp/src/scoops/`.
- **When adding or changing routes**, update ALL THREE test/config locations:
  1. `tests/index.test.ts` — unit test that checks the routes list in the root 200 response
  2. `tests/deployed.test.ts` — smoke test that runs against the deployed staging worker (also checks routes list)
  3. The routes array in `src/index.ts` (the default 200 response)
     Missing any of these causes CI failures — the staging smoke test deploys the worker then verifies the routes match.
