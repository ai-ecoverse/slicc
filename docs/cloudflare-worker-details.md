# Cloudflare Worker — Deep Reference

Companion to [`packages/cloudflare-worker/CLAUDE.md`](../packages/cloudflare-worker/CLAUDE.md).
This file holds the multi-paragraph detail that would otherwise inflate the guide
past its character budget. Invariants and safety rules stay in the guide; expansions
live here.

## <a name="public-routes"></a>Public Routes — full semantics

Every route below must also appear in `src/index.ts`, `tests/index.test.ts`, and
`tests/deployed.test.ts` per the routes-mirror rule in the guide.

`POST /api/tray/:trayId/preview-transfer` transfers previews through the source
tray's `/internal/preview/transfer`. Authorization is `Bearer <source controllerToken>`;
JSON contains `targetTrayId` and `targetControllerToken`. Only these three fields
reach the owner. The edge caps the body at 8 KiB with a 10-second read deadline,
and bounds the owner request at 60 seconds. Neither capability is logged.
Success is `{ transferred: true, count }`; owner errors remain `403` (ownership),
`409` (conflict), or `503` (pending/unavailable). A timeout returns `503`:
retain both credentials and retry the same source and target, since the durable
operation may still complete and identical retries are idempotent.

| Route                                      | Description                                                                                                                                |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /tray`                               | Create a tray; return join/controller/webhook capability URLs                                                                              |
| `GET /handoff`                             | Convert `?upskill=`, `?handoff=`, or `?msg=` into RFC 8288 `Link` header                                                                   |
| `GET /install-cli`                         | POSIX installer script for the Go `slicc` follower CLI (`curl -fsSL …/install-cli \| sh`); covers macOS/Linux/WSL/Git Bash                 |
| `GET /install-cli.ps1`                     | Native-Windows PowerShell installer (`irm …/install-cli.ps1 \| iex`) — installs to `%LOCALAPPDATA%\Programs\slicc`, persists the user PATH |
| `GET /download/slicc-cli/:target`          | 302 to the newest release asset for a CLI target (`darwin-arm64`, …); scans past binary-less releases; real HTTP errors, no SPA fallback   |
| `GET /.well-known/api-catalog`             | RFC 9264 linkset for all public routes                                                                                                     |
| `GET /llms.txt`                            | LLM markdown digest                                                                                                                        |
| `GET\|HEAD /privacy`                       | 301 to www.sliccy.com/privacy (App Store Connect link)                                                                                     |
| `GET\|HEAD /status`                        | Public health document (`{ status, service, timestamp, version }`); no auth, `Cache-Control: no-store`                                     |
| `GET /rel/:name`                           | Dereferenceable docs for SLICC rel URIs (`handoff`, `upskill`, `successor-version`)                                                        |
| `GET\|POST /join/:token`                   | Follower join and bootstrap polling (HTTP poll/answer/ice-candidate/retry actions)                                                         |
| `GET\|POST /controller/:token`             | Leader attach and WS upgrade                                                                                                               |
| `POST /webhook/:token/:webhookId`          | Forward webhook events into the live leader                                                                                                |
| `POST /wh/:token/:webhookId`               | Durably accept a stable-home webhook delivery; explicit acknowledgement or alarm replay                                                    |
| `POST /api/tray/:trayId/webhook/rotate`    | Rotate the stable delivery capability on the same home; authenticated, retry-safe                                                          |
| `POST /webhooks/:coneId/:webhookId/revoke` | Permanently revoke a registration before deleting its local definition                                                                     |
| `POST /api/tray/:trayId/preview`           | Mint a preview token; body `{ path, bridge?, maxTabs?, quiet?, webhookId? }`; response `{ previewToken, url }`                             |
| `POST /api/tray/:trayId/preview/stop`      | Revoke a preview token; body `{ previewToken }`                                                                                            |
| `POST /api/tray/:trayId/preview-transfer`  | Transfer previews to `targetTrayId` using source Bearer plus `targetControllerToken`; retain credentials and retry on `503`                |
| `GET /api/tray/:trayId/previews`           | List active previews for a tray                                                                                                            |
| `POST /api/tray/:trayId/biscotto`          | Mint a guest seat; body `{ label, ttlMs?, gates? }`; response `{ id, url, label, expiresAt?, gates }`                                      |
| `POST /api/tray/:trayId/biscotto/stop`     | Revoke a seat; body `{ id }`. Idempotent; keeps the first `revokedAt`                                                                      |
| `GET /api/tray/:trayId/biscotti`           | List seats for a tray. **Never returns seat tokens** — a listing of live capabilities would be a set of working guest URLs                 |
| `GET <token>.sliccy.now/*`                 | Preview HTTP pipe — streams file from leader via DO; 30s timeout; bridge mode injects the preview-bridge script                            |
| `GET __slicc/preview-bridge.js`            | Bundled preview bootstrap (bridge-enabled previews only; build-generated, not committed)                                                   |
| `WS __slicc/bridge`                        | Preview bridge WS (`slicc.preview-bridge.v1.<connId>`); relays CDP + attributed `emit`; hibernated via `setWebSocketAutoResponse`          |
| `POST __slicc/emit`                        | Fallback beacon relay for `window.slicc.emit` on page unload                                                                               |
| `GET /auth/callback`                       | OAuth callback relay; capture hop for the cloud dashboard (no `state` → `postMessage` to opener)                                           |
| `GET /auth/mcp-callback`                   | MCP OAuth capture hop; preserves opaque `state` and posts the untouched callback URL to the same-origin opener                             |
| `GET /api/flags`                           | Resolve `{ float, flags }` string values for `?float=<float>`; unknown/invalid profiles fall back to `base`                                |

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
  - **Only a FULL follower is redirected.** The successor URL carries the replacement
    tray's full join token, and a `biscotto` guest seat has no claim on it: a seat is a
    revocable seat on _this_ cone's transcript and dies with the tray by design, so
    forwarding it would silently promote a guest to a full follower of the new tray (a
    guest→full escalation). `handleJoin` branches on `capability.trust` — a guest on a
    superseded tray gets the existing terminal `410 TRAY_EXPIRED` with no `Location`,
    no link, and no `joinUrl` in the body. Browser and iOS wire validators reject
    `TRAY_SUPERSEDED` without a `joinUrl`; an optional field in a decoded native model
    does not make that response compatible. Reusing `TRAY_EXPIRED` needs no Swift or Go
    protocol change. Revoked and invalid capabilities still receive `403` before this gate.
  - `Access-Control-Expose-Headers: Link` is set on the capability CORS surface so a
    cross-origin follower can read the link. Note that `applySliccLinks` skips 3xx, so
    a supersede response carries the successor link **without** the standard rel set.
  - Shipped pre-#1957 followers degrade rather than break: their platforms follow the
    308 and re-POST, so they connect to the replacement but do not persist it, and
    re-walk the redirect on each reconnect until updated.
- **Webhook deliveries are session-lineage-stable, not tray-superseded (#2812).** The webhook URL is
  `POST /wh/<coneId>.<secret>/<webhookId>` — `coneId` names the leader-session lineage shared
  by its WorkUnits, not an individual agent cone or the tray instance,
  so it survives every rove. It routes to `WEBHOOK_HOMES.idFromName(coneId)`, a
  `WebhookHomeDurableObject` (`src/webhook-home.ts`) that verifies the secret against a
  stored hash and INTERNAL-FORWARDS the delivery to whichever tray it is currently bound to
  (`/internal/webhook/:webhookId` on the tray, which runs the same relay a public delivery
  runs, minus the public token check — the home already authenticated). No redirect, no
  capability in any response header: a reset is invisible to the external sender. This is
  the half of the problem the join surface does not cover — a webhook URL is cached by an
  external service for the life of a long job, and #1957's 308 only helped a sender that
  followed POST redirects, while leaking the replacement's capability in `Location`.
  - **The home stores `{ coneId, secretHash, rebindSecretHash, currentTrayId, revokedAt?,
lastReboundAt }` in DO storage, never KV** — the read matters the instant after a
    rebind, which is exactly when KV would still serve the tray that just died. Only secret
    HASHES are stored, so a leaked storage does not leak a working capability.
  - **The leader owns the management identity privately.** Before its first `POST /tray`,
    it generates and durably persists `coneId`, delivery secret, and rebind secret in
    manager-private IndexedDB state scoped to the worker URL (trailing slashes normalized).
    This record is independent of `LeaderTraySession`: clear/reset, failed creates, lost
    responses, retries, and reloads retain it. The rebind secret never enters the VFS,
    public status, localStorage mirrors, or follower messages; this is not a defense
    against arbitrary same-origin code. Existing private sessions migrate before publication.
    Every subsequent create presents the same identity and must confirm the stable binding.
    Old hubs may return legacy webhook URLs only before any stable binding is acknowledged.
    Identity-less clients (including older/native leaders) receive the legacy `/webhook/`
    capability and never access `WEBHOOK_HOMES`; their supersede redirect contract is unchanged.
    Stable-aware creates additionally require a private `createAttemptId` (32–128 URL-safe
    alphanumeric, `_` or `-` characters). Persist it before `POST /tray`, retain it across
    errors/lost responses/reload until the returned session is durable, and mint a fresh one
    for the next deliberate reset. The worker derives an opaque tray address from the cone ID,
    rebind secret and attempt ID, so retries reuse the original DO, timestamp and capabilities
    rather than leaking a tray on each failed bind. Knowing a public tray ID cannot replay
    creation without the private credentials. Never use the cone ID alone as the retry key:
    resets must create distinct trays. Cone IDs and both secrets accept only 1–128 URL-safe
    alphanumeric, `_` or `-` characters; dots and URL delimiters are rejected before creation.
    Rotation first persists a private intent containing the old controller session and two
    fresh cryptographic random replacements (`secret` and `rebindSecret`). Both hashes and
    a receipt covering the old and new secrets, tray and controller commit atomically.
    Old management credentials cannot rebind, revoke, or initiate another rotation.
    Exact receipt replay is read-only, requires presenting both replacements, and works
    even after source expiry/rebind; it never reveals secrets absent from the request.
    Legacy deterministic pending intents without replacements are retained and refused
    locally before HTTP; they require explicit operator reconciliation, not automatic
    reminting or clearing, because the old operation may have committed.
    If its response is lost, reload replays the exact persisted rotation before any
    attach/rebind/reset. Ambiguous transport/server failures retain the intent and block
    rebinding; definitive HTTP refusals (`400`/`401`/`403`/`404`/`405`/`410`/`422`) drop
    the rejected intent so startup is not permanently blocked by stale authority.
    Atomic IndexedDB compare-and-swap reconciles against the identity originally read:
    late responses cannot restore a revoked secret or clear another tab's newer intent.
    A newer pending rotation still blocks reconnect until its replay completes.
  - **Replacement is resumable.** `LeaderTrayManager.reset()` persists the source tray;
    the ordinary session store holds the newly created target before attach. Reset and
    stale-session recovery transfer previews before superseding the source. A failed
    transfer retains both records and reload retries the same pair. Only the source's
    `410 PREVIEW_TARGET_UNAVAILABLE` proves no freeze occurred and permits a fresh target.
    Generic `403`/`410` do not. A frozen pair instead confirms retained target controller
    ownership and finishes the same import/locator/activation sequence after target expiry.
    That does not revive the expired leader session: the manager persists the completed
    target as its next source and attempts one bounded extra rove. Thus partially moved
    locators are never abandoned by blindly replacing a frozen target.
  - **Rebind is two-factor (the strong option).** The home requires BOTH its own rebind
    secret AND the target tray confirming the presented controller token
    (`/internal/confirm-controller`, a round trip per rebind). A leaked `coneId` + rebind
    secret alone cannot steer deliveries at a tray the caller does not lead. The first bind
    (cone creation) has no prior secret, so it is claimed by the first caller who proves
    controller ownership of the initial tray.
  - **Lifecycle.** A home self-expires after `WEBHOOK_HOME_TTL_MS` (90d) with no rebind
    (`410 HOME_EXPIRED`); `revoke` (rebind-secret-gated) tombstones it permanently
    (`410 HOME_REVOKED`, never resurrects). A bind failure at create time fails the create;
    the leader retains its identity for retry instead of silently falling back to a
    tray-scoped webhook URL.
  - **Durable acceptance, not completed work.** The home schedules an alarm and persists
    every delivery before forwarding or returning `202`. Replay removes an event only
    on an explicit `x-slicc-webhook-ack: delivered|filtered` success response, or registration
    revocation, or bounded explicit rejection. Missing registrations (`404` with JSON
    `accepted: false, code: WEBHOOK_NOT_REGISTERED`) and unresolved targets (`422` with
    `accepted: false, code: WEBHOOK_TARGET_UNRESOLVED`) get three consecutive explicit
    rejection attempts, at least 30 seconds apart, then terminate as dead letters.
    Registration repair during this grace period allows normal delivery. Arrivals cannot
    accelerate the budget. While an explicitly rejected ID waits for retry, other IDs may
    proceed; later events for that same ID cannot bypass it. Scheduling scans the bounded
    queue, with no separate partition registry or cursor. Ambiguous responses, generic errors, malformed response bodies
    and timeouts retain the head indefinitely and reset any rejection streak. Delivery is
    at-least-once: a lost acknowledgement or crash can replay an event; this does not
    guarantee exactly-once agent work or downstream side effects.
  - **Backpressure, never eviction.** Limits are 100 events and 120 KiB for the encoded
    home record (including base64/JSON overhead and 256 bytes per event reserved for retry metadata),
    64 KiB per request body, and eight
    pending home requests. Queue saturation returns `429 WEBHOOK_QUEUE_FULL`; request
    saturation returns `429 WEBHOOK_HOME_BUSY` (both `Retry-After: 30`); oversized bodies
    return `413`. Accepted events have no queue TTL and are never dropped to admit new
    work. The 90-day home admission expiry is not an event-retention TTL. An alarm retries
    every 30 seconds while blocked, including when bind precedes leader connect; successful
    head removal schedules remaining backlog after one second.
  - **Bounded terminal archive.** Queue removal and the full dead-letter receipt commit
    in one atomic DO multi-key put. `webhook-home.deadLetterCount` records the lifetime
    total; `webhook-dead-letter:0` through `:99` retain the latest 100 terminal receipts,
    each with sequence, `outcome: rejected`, reason, failure time and original delivery.
    Once full, new terminal outcomes replace the oldest terminal details, not pending
    work. This is at most about 12 MiB separate from queue capacity; archived outcomes
    cannot starve admission. These are operator-only DO records, not public responses or
    automatic replay: inspect/export them with privileged storage tooling before retention
    wraps, repair the registration and explicitly resubmit if needed. Do not replay a
    revoked registration. `202` is durable acceptance, not guaranteed eventual delivery.
    Bounded rejection plus backoff bypass preserves per-ID FIFO without a full partition
    scheduler: unrelated work can proceed on the next drain while a typo retries.
    After explicit rejection, eligible backlog schedules a one-second alarm; otherwise
    retry remains 30 seconds. A burst still receives normal bounded-queue backpressure.
    Partitioning alone would not reclaim the 100 slots consumed by unknown IDs.
  - **Rotation and deletion.** Rotation atomically changes the delivery-secret hash and
    retry receipt on the same home, preserving identity, rebind authority, registrations
    and queued events. Exact authenticated retries are safe even after the source tray
    expires or the home rebinds; private pending intent provides reload recovery.
    Registration deletion writes a permanent `revoked-registration:<sha256(webhookId)>`
    tombstone before removing that ID's queued events. Valid-secret deliveries then return
    `410 WEBHOOK_REVOKED`; tombstones are not aged out or evicted. The manager removes the
    local definition only after hub acknowledgement; failure leaves it available to retry.
- **Legacy tray-scoped webhook (`/webhook/:token/:webhookId`) — migration only.** Retained
  so an already-cached pre-#2812 URL keeps working. On a superseded tray it answers `308` +
  `Location: <replacement webhook URL>/:webhookId` + `code: "TRAY_SUPERSEDED"`, driven by
  `supersededByWebhookUrl` (stored separately from `supersededByJoinUrl` — the tokens do
  not derive from each other). The leader still supersedes on both abandonment paths
  (recovery and reset), so a legacy URL is reliably forwarded; new registrations get the
  stable `/wh/` shape instead. `?redirect=manual` does not apply to a webhook sender (it has
  no channel to be told about a hop). Relay ordering is load-bearing: capability token →
  supersede → expiry gate → live-leader check, which is why `/webhook/*` dispatches ahead of
  the expiry gate in the DO's `fetch`, like `/join`. A test pins both.
- Preview bridge tabs (`serve --bridge`) attach via `/__slicc/bridge` WS. DO relays
  `bridge.cdp.request`/`bridge.cdp.response` between leader and each bridge socket,
  keyed by `connId`. On leader (re)connect the DO replays `bridge.connected` for every
  live bridge socket. Hibernated via `setWebSocketAutoResponse`.
- Preview continuity (`preview-continuity.ts`) uses authenticated transfer, not a public
  redirect: the source and target controller capabilities authorize moving the original
  preview records intact. Each token's original tray remains its durable locator, updated
  directly to the newest owner on every rove (no growing forwarding chain). The URL,
  served root, entry path, bridge flag, tab cap and webhook scope do not change. Old
  controllers can list/stop only their transferred previews, not new target previews.
  A durable pending transfer fails closed with `503` until the same source/target pair
  is retried; import receipts prevent replay from resurrecting revoked previews.
  Bridge sockets close with retryable `1012` and reconnect to the new owner. Persistent
  snapshots move their existing R2 keys and expiry unchanged: no byte copy, TTL renewal,
  or source-side cleanup after transfer. The new owner retains expiry/revoke cleanup.
  Persistent upload authorization records a timestamped 120-second lease (at most
  eight active writes per preview). Lost authorization/release responses and vanished
  edges recover concurrency on the next authorization after expiry. Expired candidates
  cannot commit; every retry uses a fresh R2 key, never overwriting canonical bytes.
  Legacy string leases migrate once on first use. Expired keys collapse into one
  unresolved-write flag, rather than accumulating unbounded key bookkeeping.
  Expiry/revoke sweeps the prefix and retains a non-serving cleanup tombstone for at
  most 24 hours; cleanup records do not consume the ten active preview slots. Neither
  retries nor releases extend that horizon or the serving TTL. Body, R2 put, upload
  authorization, commit and release waits have 30-second deadlines.
  An unfinished transfer intentionally retains its non-serving locator-recovery ledger
  beyond this operational cleanup horizon until the same transfer is retried. That
  ledger does not consume active preview slots or permit uploads/serving; it is not
  evidence that an old R2 write was cancelled.
  **Lease timeout is not R2 cancellation.** Independent, mandatory R2 lifecycle
  expiration on `previews/` catches writes materializing after local cleanup ends,
  including edge eviction and indefinitely failing prefix deletion. The 90-day
  object-age backstop allows the full 30-day pending window plus 30-day finalized
  retention, and measures age from object creation, not lease authorization. See the
  worker deployment skill for provisioning and the fail-closed deployment gate.

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
