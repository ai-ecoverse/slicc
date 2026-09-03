# Cloudflare Worker — Deep Reference

Companion to [`packages/cloudflare-worker/CLAUDE.md`](../packages/cloudflare-worker/CLAUDE.md).
This file holds the multi-paragraph detail that would otherwise inflate the guide
past its character budget. Invariants and safety rules stay in the guide; expansions
live here.

## <a name="public-routes"></a>Public Routes — full semantics

Every route below must also appear in `src/index.ts`, `tests/index.test.ts`, and
`tests/deployed.test.ts` per the routes-mirror rule in the guide.

| Route                                  | Description                                                                                                                                |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /tray`                           | Create a tray; return join/controller/webhook capability URLs                                                                              |
| `GET /handoff`                         | Convert `?upskill=`, `?handoff=`, or `?msg=` into RFC 8288 `Link` header                                                                   |
| `GET /install-cli`                     | POSIX installer script for the Go `slicc` follower CLI (`curl -fsSL …/install-cli \| sh`); covers macOS/Linux/WSL/Git Bash                 |
| `GET /install-cli.ps1`                 | Native-Windows PowerShell installer (`irm …/install-cli.ps1 \| iex`) — installs to `%LOCALAPPDATA%\Programs\slicc`, persists the user PATH |
| `GET /download/slicc-cli/:target`      | 302 to the newest release asset for a CLI target (`darwin-arm64`, …); scans past binary-less releases; real HTTP errors, no SPA fallback   |
| `GET /.well-known/api-catalog`         | RFC 9264 linkset for all public routes                                                                                                     |
| `GET /llms.txt`                        | LLM markdown digest                                                                                                                        |
| `GET\|HEAD /privacy`                   | 301 to www.sliccy.com/privacy (App Store Connect link)                                                                                     |
| `GET\|HEAD /status`                    | Public health document (`{ status, service, timestamp, version }`); no auth, `Cache-Control: no-store`                                     |
| `GET /rel/:name`                       | Dereferenceable docs for SLICC rel URIs (`handoff`, `upskill`, `successor-version`)                                                        |
| `GET\|POST /join/:token`               | Follower join and bootstrap polling (HTTP poll/answer/ice-candidate/retry actions)                                                         |
| `GET\|POST /controller/:token`         | Leader attach and WS upgrade                                                                                                               |
| `POST /webhook/:token/:webhookId`      | Forward webhook events into the live leader                                                                                                |
| `POST /api/tray/:trayId/preview`       | Mint a preview token; body `{ path, bridge?, maxTabs?, quiet?, webhookId? }`; response `{ previewToken, url }`                             |
| `POST /api/tray/:trayId/preview/stop`  | Revoke a preview token; body `{ previewToken }`                                                                                            |
| `GET /api/tray/:trayId/previews`       | List active previews for a tray                                                                                                            |
| `POST /api/tray/:trayId/biscotto`      | Mint a guest seat; body `{ label, ttlMs?, gates? }`; response `{ id, url, label, expiresAt?, gates }`                                      |
| `POST /api/tray/:trayId/biscotto/stop` | Revoke a seat; body `{ id }`. Idempotent; keeps the first `revokedAt`                                                                      |
| `GET /api/tray/:trayId/biscotti`       | List seats for a tray. **Never returns seat tokens** — a listing of live capabilities would be a set of working guest URLs                 |
| `GET <token>.sliccy.now/*`             | Preview HTTP pipe — streams file from leader via DO; 30s timeout; bridge mode injects the preview-bridge script                            |
| `GET __slicc/preview-bridge.js`        | Bundled preview bootstrap (bridge-enabled previews only; build-generated, not committed)                                                   |
| `WS __slicc/bridge`                    | Preview bridge WS (`slicc.preview-bridge.v1.<connId>`); relays CDP + attributed `emit`; hibernated via `setWebSocketAutoResponse`          |
| `POST __slicc/emit`                    | Fallback beacon relay for `window.slicc.emit` on page unload                                                                               |
| `GET /auth/callback`                   | OAuth callback relay; capture hop for the cloud dashboard (no `state` → `postMessage` to opener)                                           |
| `GET /auth/mcp-callback`               | MCP OAuth capture hop; preserves opaque `state` and posts the untouched callback URL to the same-origin opener                             |
| `GET /api/flags`                       | Resolve `{ float, flags }` string values for `?float=<float>`; unknown/invalid profiles fall back to `base`                                |

## <a name="cone-configuration"></a>Cone Configuration flow

`ConeConfig` = `{ model, accounts[], secrets[] }` (types in
`@slicc/cloud-core/cone-config`) lets users pick the cone's model, provide flat
secrets, and provision provider logins. `src/cloud/cone-config-bridge.ts` handles the
start/resume flows:

- **start:** validates config, splits into `/slicc/secrets.env` and
  `/slicc/cone-config.json`. No config ⇒ synthesizes an Adobe default from the cloud
  bearer.
- **resume:** merges a `coneConfigDelta` into both files in-sandbox, then reloads the
  leader via `POST /api/secrets/reload` → `Page.reload`.
- **Adobe oauth expiry:** every path that synthesizes an Adobe `{kind:'oauth'}`
  account stamps `tokenExpiresAt` via `imsTokenExpiry` in
  `@slicc/cloud-core/cone-config` (decodes the IMS JWT's `created_at + expires_in`
  with `atob`).
- **DO index:** `CloudSessionsDurableObject` persists a **names-only**
  `coneConfigIndex` per cone — never values.

## <a name="signaling"></a>Signaling Model — protocol detail

- Leader attaches via controller capability + WS to the DO.
- **Last-key-holder-wins reconnect**: a leader reconnect with matching credentials
  closes the stale socket and accepts the new one rather than rejecting. Workerd does
  not reliably deliver `webSocketClose` on dropped/half-open connections; rejecting
  the rightful reconnect deadlocks it. Full ghost-leader analysis:
  [`deploying-tray-worker` skill](../.agents/skills/deploying-tray-worker/SKILL.md).
- Followers attach via the join capability; bootstrap over HTTP poll
  (poll/answer/ice-candidate/retry actions).
- **Superseded tray** (`POST /api/tray/:trayId/supersede`, leader-only): once a tray is
  marked superseded, both `/join/:token` shapes answer `308 Permanent Redirect` +
  `Location: <joinUrl>`, an RFC 8288 `Link: <joinUrl>; rel="successor-version"` header
  (RFC 5829), and a JSON body carrying `code: "TRAY_SUPERSEDED"` + `joinUrl` with
  `result.action: "redirect"` on the attach shape (issue #1957). 308 over 409 because
  the old tray's leader socket never reconnects — nothing is retryable — and over
  301/302/307 because the move is permanent and the attach `POST`'s method and body
  must survive it.
  - **Three channels, one address, deliberately.** `Location` is for a client that lets
    its platform follow the redirect; the link is for one that suppresses it (all five
    SLICC followers do); the body is for a hub-shape a client cannot decode. Every
    follower prefers the link, and treats any named replacement as a hop regardless of
    status or `action`.
  - **`Location` carries `json=true` when the superseded request had it; the link never
    does.** A followed request that lost the parameter lands on the SPA fallback, which
    answers `200` + HTML for a `GET` probe and would make a live replacement look dead.
    The link stays bare because it is what followers persist as the session's join URL.
  - **`?redirect=manual` opts out**, and the answer is then the pre-#1957 `409` +
    link + body — no `Location`. It exists for the browser follower alone, which cannot
    suppress redirect-following (`redirect: 'manual'` in `fetch` yields an
    opaque-redirect filtered response: no status, headers, or body, even same-origin).
    Left to the platform, a chain of superseded trays is walked end to end and arrives
    as ONE observable hop, so `MAX_SUPERSEDE_REDIRECTS` counts 1 for a chain of any
    length and a cycle burns the browser's own redirect limit in immediate re-POSTs.
    Being told about one hop at a time is what the other four followers get by
    suppressing redirects themselves. The parameter is a per-request probe detail: it
    is never stored and never copied onto `Location`, and the webapp strips it (with
    `json`) from any URL it persists.
  - Both header targets are normalized through `URL`, so a stored join URL cannot inject
    a header delimiter. A replacement that does not parse keeps the old `409` +
    `action: "fail"` shape — a redirect needs a target.
  - `Access-Control-Expose-Headers: Link` is set on the capability CORS surface so a
    cross-origin follower can read the link. Note that `applySliccLinks` skips 3xx, so
    a supersede response carries the successor link **without** the standard rel set.
  - Shipped pre-#1957 followers degrade rather than break: their platforms follow the
    308 and re-POST, so they connect to the replacement but do not persist it, and
    re-walk the redirect on each reconnect until updated.
- **Superseded webhook deliveries** answer the same way: `POST /webhook/:token/:webhookId`
  on a superseded tray returns `308` + `Location: <replacement webhook URL>/:webhookId`
  (the delivery's query string carried over) + `code: "TRAY_SUPERSEDED"`. This is the
  half of the problem the join surface does not cover: a webhook URL embeds the tray id,
  an external service caches it for the life of a long job, and a tray reset mid-job used
  to turn the callback into a bare `410 TRAY_EXPIRED` that a fire-and-forget sender drops
  on the floor — a lick that never arrives and nothing reporting an error.
  - **The replacement's webhook URL is stored separately** (`supersededByWebhookUrl`)
    because it is not derivable: the join URL carries the join token, a delivery needs the
    webhook token. It is optional on `/supersede`, so a leader that predates it leaves the
    webhook surface on its old `410`. An unparseable value is refused at write time.
  - **`?redirect=manual` does not apply here**, unlike on `/join`. That opt-out exists so
    a client which cannot suppress redirects can be _told_ about a hop instead, and a
    webhook sender has no channel to be told through: it will not read a `Link` header or
    parse a SLICC body, and a query string it happens to carry is not a request for
    different semantics. The redirect is the only thing that saves the delivery.
  - **Ordering in the relay is load-bearing: capability token → supersede → expiry gate →
    live-leader check.** After the token because `Location` names the replacement's webhook
    _capability_, which is a secret — an unauthenticated redirect would hand it to anyone
    who guessed a tray id. Before the expiry gate (which is why `/webhook/*` dispatches
    ahead of it in the DO's `fetch`, like `/join`) because the callback that needs
    redirecting is precisely the one arriving after the old tray died. A test pins both.
- Preview bridge tabs (`serve --bridge`) attach via `/__slicc/bridge` WS. DO relays
  `bridge.cdp.request`/`bridge.cdp.response` between leader and each bridge socket,
  keyed by `connId`. On leader (re)connect the DO replays `bridge.connected` for every
  live bridge socket. Hibernated via `setWebSocketAutoResponse`.

## <a name="static-assets"></a>Static Asset Serving — full rules

- Worker serves `dist/ui/` via Cloudflare Workers Static Assets (`ASSETS` binding).
- `wantsJSON()` in `shared.ts` checks `?json=true` for content negotiation.
- GET/HEAD to `/join/:token` and `/controller/:token` without `?json=true` → SPA.
- Unmatched paths without `?json=true` → SPA fallback.
- `?json=true`, POST, and WebSocket upgrades → API/JSON.
- **Cherry embed (`?cherry=1`):** `frame-ancestors` is set from
  `ALLOWED_CHERRY_HOST_ORIGINS`. A bare `*` also adds any explicit
  `chrome-extension://` origins (CSP `*` does not authorize extension ancestors).
  Every non-cherry response gets `frame-ancestors 'none'`. Cherry responses set
  `Cache-Control: no-store` and `Vary: Sec-Fetch-Dest` to prevent cache mixing.
- **25 MiB per-asset cap:** Cloudflare rejects any `dist/ui/` file over 25 MiB; the CI
  `cloudflare-worker` job runs `npm run build -w @slicc/cloudflare-worker`
  (`wrangler deploy --dry-run`) as a hard gate.
- **`Document-Isolation-Policy: isolate-and-credentialless`** is set on non-cherry,
  non-electron SPA responses — per-document cross-origin isolation (SharedArrayBuffer
  for vpod guest networking) without COOP/COEP. The cherry and electron branches must
  stay header-free: they are always embedded and never need SAB.
- `ASSET_ARCHIVE` (R2) retains hashed `/assets/*` across deploys;
  `serveAssetWithArchiveFallback` tries `ASSETS`, then R2, then stale-asset reload;
  bucket GC is 14 days.

## <a name="cloud-routes"></a>Cloud Cones routes

All `/api/cloud/*` require `Authorization: Bearer <ims-access-token>` and route to
`env.CLOUD_SESSIONS.idFromName(userId)`.

| Route                         | Description                                                                 |
| ----------------------------- | --------------------------------------------------------------------------- |
| `GET /cloud`                  | Dashboard SPA (CSP-enforced)                                                |
| `GET /auth/cloud-callback`    | IMS popup callback (HTML)                                                   |
| `GET /auth/cloud-callback.js` | IMS popup callback (JS, served inline by worker)                            |
| `POST /api/cloud/start`       | Start a new cone (auth + cap-checked); optional `coneConfig` bundle         |
| `GET /api/cloud/list`         | Per-user cone list (reconciled with e2b per call)                           |
| `GET /api/cloud/cone-config`  | `?sandboxId=<id>`: names-only config index (model + account + secret names) |
| `POST /api/cloud/pause`       | Pause a cone                                                                |
| `POST /api/cloud/resume`      | Resume a paused cone; optional `coneConfigDelta`                            |
| `POST /api/cloud/kill`        | Kill a cone (idempotent)                                                    |
| `POST /api/cloud/sign-out`    | Invalidate auth cache for the bearer                                        |
| `GET /api/cloud/admin/stats`  | Admin-gated by `ADMIN_USER_IDS`                                             |
