# CLAUDE.md

This file covers the tray hub worker in `packages/cloudflare-worker/`.

## Scope

The worker provides tray session coordination, capability-token routing, TURN credential lookup, and leader/follower signaling for tray-connected SLICC runtimes.

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
- `GET|POST /join/:token` — follower join and bootstrap polling flow
- `GET|POST /controller/:token` — leader attach flow and leader WebSocket upgrade
- `POST /webhook/:token/:webhookId` — forward webhook events into the live leader

### Signaling model

- A leader first attaches through the controller capability.
- The elected leader opens a WebSocket to the Durable Object.
- Followers attach through the join capability and bootstrap over HTTP poll/answer/ice-candidate/retry actions.
- The Durable Object forwards control messages to the live leader and expires trays that are not reclaimed in time.

### TURN credentials

- TURN credentials are fetched with `CLOUDFLARE_TURN_KEY_ID` and `CLOUDFLARE_TURN_API_TOKEN`.
- `session-tray.ts` caches ICE servers and refreshes them before TTL expiry.
- `wrangler.jsonc` defines the key ID; the API token is stored as a Wrangler secret.

## Commands

### Worker and deploy

```bash
npx wrangler dev --config packages/cloudflare-worker/wrangler.jsonc
npx wrangler deploy --env staging --config packages/cloudflare-worker/wrangler.jsonc
npx wrangler deploy --config packages/cloudflare-worker/wrangler.jsonc
WORKER_BASE_URL=https://... npx vitest run tests/worker/deployed.test.ts
```

### QA flows that use the worker

```bash
npm run qa:setup
npm run qa:leader
npm run qa:follower
npm run qa:extension
```

These live at the repo root because they coordinate the worker with browser runtimes.

## CI and Deployment

- Worker deploy automation lives in `.github/workflows/worker.yml`.
- Required repo configuration:
  - secret: `CLOUDFLARE_API_TOKEN`
  - variable: `CLOUDFLARE_ACCOUNT_ID`
- Wrangler surfaces deployed URLs that are used by `tests/worker/deployed.test.ts`.

## Operational Notes

- Treat the worker as coordination infrastructure, not canonical session storage.
- Keep signaling protocol changes aligned with the browser tray runtime in `packages/webapp/src/scoops/`.
- When modifying routes or tokens, update both the worker tests and the consuming runtime docs.