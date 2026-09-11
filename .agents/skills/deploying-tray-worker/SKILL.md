---
name: deploying-tray-worker
description: |
  Use when deploying or debugging the Cloudflare tray hub worker: staging deploys, R2 asset archive (binding, serving, hash invariant, upload gate, GC), ghost-leader reconnect, preview bridge protocol, CI retry logic, routes-only failure classification, and the staging test guide. Also triggered by error strings like 'LEADER_ONLY', 'routes reconcile', 'R2', or 'wrangler deploy'.
---

# deploying-tray-worker

## Quick Reference

Run these commands from the repository root unless a command changes directories.

```bash
# Verify the active Cloudflare account.
npx wrangler whoami

# Build the UI required by the hub worker.
npm run build -w @slicc/webapp

# Read-only, fail-closed prerequisite BEFORE any deploy or secret mutation.
# Requires CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN in the environment.
node packages/cloudflare-worker/scripts/verify-preview-lifecycle.mjs sliccy-now-basic-storage

# Upload assets to R2 BEFORE deploying (mandatory gate).
node packages/cloudflare-worker/scripts/upload-assets-to-r2.mjs \
  slicc-asset-archive-staging --dir dist/ui/assets

# Deploy the staging hub and preview workers as a pair.
cd packages/cloudflare-worker
npx wrangler deploy --config wrangler.jsonc --env staging
npx wrangler deploy --config wrangler-preview.jsonc --env staging

# Verify R2 buckets and retention rules.
npx wrangler r2 bucket list
npx wrangler r2 bucket lifecycle list slicc-asset-archive
npx wrangler r2 bucket lifecycle list slicc-asset-archive-staging

# Run deployed worker smoke tests.
WORKER_BASE_URL=https://... npm test -- tests/deployed.test.ts
```

Use this skill as the operational runbook for `packages/cloudflare-worker/`. See
[`packages/cloudflare-worker/CLAUDE.md`](../../../packages/cloudflare-worker/CLAUDE.md)
for the protocol and module map. See
[`docs/architecture.md`](../../../docs/architecture.md#multi-browser-sync-tray-architecture)
for tray signaling architecture and the leader/follower message matrix.

---

## Operate the R2 Asset Archive

**Goal:** Keep content-hashed `/assets/*` chunks available across deploys so
long-lived browser tabs don't crash when lazy-loaded chunks from an older build
disappear. The worker serves archived chunks from R2 on an `ASSETS` miss, degrading
gracefully to the shipped stale-asset reload if retention doesn't cover a chunk.

### Check bindings and buckets

`wrangler.jsonc` defines an `ASSET_ARCHIVE` R2 binding per environment:
`slicc-asset-archive` (production) and `slicc-asset-archive-staging` (staging).
The worker's `WorkerEnv` type includes `ASSET_ARCHIVE: R2Bucket`.

### Trace the serving path (`serveAssetWithArchiveFallback`)

A dedicated handler in `src/index.ts` intercepts `GET`/`HEAD` requests to paths
matching the strict hashed-asset predicate (e.g., `/assets/anthropic-messages-DP3-Xd3J.js`):

- **Present asset** (current build has it): serve from `ASSETS` unchanged, honoring
  Range/conditional headers.
- **Miss** (asset absent from current build): attempt to fetch from R2 with full `200`
  - immutable `Cache-Control`. Intentionally does **not** implement conditional (304/412)
    or Range (206) — all requests receive the full body and validators (`ETag`,
    `Last-Modified`). Archive miss or R2 error falls back to the shell (or bodyless
    response for `HEAD`), triggering the existing stale-asset reload.
- **Cache API** (edge): GET requests cache the full `200` under a canonical key;
  HEAD bypasses the cache.

### Enforce the hash invariant

Every `/assets/*` filename must carry a content hash (e.g., `-DP3-Xd3J`). The upload
script (`packages/cloudflare-worker/scripts/upload-assets-to-r2.mjs`) fails the deploy
if any `dist/ui/assets/*` name lacks a hash, and the worker's routing predicate enforces
the same rule (defined in the shared `asset-archive.mjs` module).

### Run the upload gate before every deploy

Every deploy path (prod automated via `publish-worker.sh`, prod manual via `worker.yml`,
staging via `ci.yml` and `worker-staging.yml`) runs the upload step **before the first
`wrangler deploy` attempt**. The production release script also runs it when its
worker/UI change gate skips deployment. The upload re-puts the **entire current asset
set** to the archive (no skip-if-exists; refreshes `last-modified` which the GC relies
on) with retries and bounded concurrency, failing the release hard if any file fails to
upload or the hash invariant is violated. Auth: `CLOUDFLARE_API_TOKEN` (must have R2
Object Read & Write on both buckets) and `CLOUDFLARE_ACCOUNT_ID`.

The R2 API rate-limits bursts of `wrangler r2 object put` calls with `429` / error code
`971` ("Please wait and consider throttling your request speed"). Concurrency defaults to
`4` (`--concurrency <n>` to override) and each file gets 5 attempts with jittered
exponential backoff. Raising concurrency re-trips the limit on the ~390-file asset set.

The limit is account-wide, so the other R2 uploaders share it and carry the same
backoff: `packages/dev-tools/tools/storybook-screenshots-upload.mjs` (bucket
`slicc-pr-screenshots`) and the inline uploader in
`.github/workflows/ios-screenshots.yml`. Change one, check the others.

### Maintain age-based garbage collection

An R2 object-lifecycle rule on each bucket deletes objects with `last-modified` older
than 14 days. Because every deploy re-puts its full current set, stable chunks
(vendor/shared) survive ≥14 days after supersession. Build-unique chunks may fall
outside the window after 14 days; tabs importing such chunks then degrade to the
stale-asset reload. **Option B** (manifest-touch, future work) would give all chunks
≥14 days post-supersession via a manifest of deployed key lists and a copy-in-place
touch loop; it is an additive upgrade requiring no re-spec.

The R2 refresh is intentionally unconditional across releases: a worker-deploy skip
streak is unbounded, so relying only on the 14-day TTL could eventually delete
still-current archived chunks.

### Use the shared MIME map

Shared in `src/asset-archive.mjs` (used by both worker and upload script):
`.js`/`.mjs`→`text/javascript`, `.css`→`text/css`, `.json`/`.map`→`application/json`,
`.wasm`→`application/wasm`, `.woff2`→`font/woff2`, `.svg`→`image/svg+xml`;
fallback `application/octet-stream`.

### Verify archive behavior

Unit tests in `tests/index.test.ts` verify present-asset, miss (archive hit/miss),
HEAD, Range/conditional requests (full `200`, not 206/304), cache behavior, and error
handling. Deployed smoke tests in `tests/deployed.test.ts` verify (staging-only) R2
archive recovery and (both envs) present-asset fetch via the live worker.

---

## Provision R2 Prerequisites

These manual Cloudflare operations **must exist before CI deploys**, else the
read-only lifecycle prerequisite or asset upload step will fail. Obtain operator
authorization before provisioning or changing live configuration; deployment scripts
never change lifecycle rules automatically.

### 0. Mandatory preview-upload cleanup backstop

Both production and staging hub/preview workers bind `PREVIEW_STORAGE` to
`sliccy-now-basic-storage`. This is **not** either `ASSET_ARCHIVE` bucket below;
do not apply the asset archive's 14-day retention to preview storage.

Provision an **enabled, object-age expiration of 90 days, scoped exactly to
`previews/`** in that bucket before deploying bounded upload leases. The runtime
maximum TTL is 30 days (`MAX_PREVIEW_TTL_MS`), but a snapshot can remain pending
for 30 days and finalize for another 30 days: its earliest bytes can still be live
at age 60 days. Therefore 45 days is unsafe. The deploy verifier accepts
`60 < days <= 90`, with 90 days the operator setup policy.

DO cleanup retires tombstones after 24 hours, even when R2 is unavailable. An R2
put can settle arbitrarily later; object-age expiration starts from the object's
write, not the preview mint or tombstone retirement. The lifecycle rule is the
independent eventual-deletion backstop for those late objects. Expiration is
asynchronous (90 days is eligibility age, not a deletion-time SLA). Keep this
rule enabled after rollback or disabling uploads too: in-flight writes can still
arrive.

Operator setup (with authorized Cloudflare credentials supplied via environment,
never saved to a repository file):

```bash
# Inspect first. Do not blindly replace the bucket's full lifecycle configuration.
npx wrangler r2 bucket lifecycle list sliccy-now-basic-storage

# If an equivalent enabled previews/ age rule does not already exist, add it.
# Positional third argument is the exact object-key prefix (no leading slash).
npx wrangler r2 bucket lifecycle add sliccy-now-basic-storage preview-retention-90d previews/ --expire-days 90

# Mandatory read-back check; repeat safely (GET only, no provisioning).
node packages/cloudflare-worker/scripts/verify-preview-lifecycle.mjs sliccy-now-basic-storage
```

If the named rule already exists, inspect rather than adding a duplicate. Existing
unrelated rules and objects must remain unchanged. An enabled bucket-wide or
overlapping prefix rule that expires objects at age <=60 days (or on an absolute
date) conflicts even if the 90-day rule is present; a narrower `previews/...`
rule can also prematurely delete some previews. If inspection reveals a conflict,
stop deployment and have the bucket owner explicitly reconcile it while preserving
retention for unrelated data. Do not remove or rescope a broad rule without
inventorying the other prefixes it protects. There is no automatic policy rewrite.

The token needs **Account → Workers R2 Storage → Read** (or the existing Edit
superset) covering `sliccy-now-basic-storage` for the lifecycle GET. Object-only
credentials are not enough for bucket configuration inspection; the worker's
R2 binding still handles runtime object access separately. Preserve all other
deployment token permissions listed below when adding this access.

`publish-worker.sh`, `worker.yml`, `worker-staging.yml`, and the staging deploy
in `ci.yml` run this read-only gate before deployment and before secret uploads.
Production release skips still refresh the asset archive but do not read preview
lifecycle policy. On the deploy path, archive refresh precedes this gate so a
preview prerequisite failure cannot prevent retention refresh.
Network/timeout failures, HTTP 429 and 5xx receive at most three GET attempts,
each bounded to 30 seconds, with 1s then 2s backoff. Exhaustion fails closed with
instructions to check Cloudflare status/network and rerun. HTTP 401/403 fail
immediately with token/account and R2 configuration-read permission guidance.
Other HTTP failures, missing/disabled/unsafe rules, unsuccessful API envelopes and
malformed responses fail without retry; there is no warning-only bypass. Errors
never print upstream bodies, headers or exception messages.
Manual production/staging deployments, including preview-only or secret updates
that can activate a version, must run the same check first. Local `wrangler dev`
and `deploy --dry-run` builds are excluded because they do not ship a version.
Provisioning is a required rollout step: CI will intentionally remain blocked until
an authorized operator completes it.

### 1. Create R2 buckets

```bash
npx wrangler r2 bucket create slicc-asset-archive
npx wrangler r2 bucket create slicc-asset-archive-staging
```

Verify:

```bash
npx wrangler r2 bucket list
```

### 2. Apply 14-day object-lifecycle rule

For each bucket, set a lifecycle rule to delete objects with `last-modified > 14 days`:

```bash
npx wrangler r2 bucket lifecycle add slicc-asset-archive retention-14d --expire-days 14
npx wrangler r2 bucket lifecycle add slicc-asset-archive-staging retention-14d --expire-days 14
```

Verify:

```bash
npx wrangler r2 bucket lifecycle list slicc-asset-archive
npx wrangler r2 bucket lifecycle list slicc-asset-archive-staging
```

Each should output:

```
Age: 14 days → Expiration
```

### 3. `CLOUDFLARE_API_TOKEN` — required permission set (ALL of these)

The deploy `CLOUDFLARE_API_TOKEN` secret is used for **the whole worker deploy**,
not just R2. When editing or recreating it (**Account Settings → API Tokens →
Edit token**), it MUST keep every scope below — dropping any one wedges releases:

- **Account → Workers Scripts → Edit** — deploy the worker script + Static Assets.
- **Account → Workers R2 Storage → Edit** (R2 Object Read & Write) on **both** buckets
  (`slicc-asset-archive`, `slicc-asset-archive-staging`).
- **Zone → Workers Routes → Edit** _and_ **Zone → Zone → Read** for **all three
  zones**: `sliccy.ai` (hub: `www.sliccy.ai/*`), `sliccy.now` (preview prod:
  `*.sliccy.now/*`), and `sliccy.dev` (preview staging: `*.sliccy.dev/*`).
  Alternatively, grant an **All Zones** resource scope for both Workers Routes
  and Zone Read.

> ⚠️ **Incident (2026-07-13):** granting R2 to this token dropped its
> **Zone/Workers-Routes** scope. The worker script still deployed, but `wrangler deploy`
> failed reconciling routes (`"does not have 'All Zones' permissions"`), which aborted
> the release **before** the GitHub-release/Chrome/npm publish steps. `publish-worker.sh`
> now treats a routes-only deploy failure as non-fatal (version already live), but the
> token should still carry the routes scope so route _changes_ apply. When editing the
> token, add scopes; never replace the whole set with only R2.

---

## Debug Ghost-Leader Reconnect

**Why last-key-holder-wins:** A leader-WS upgrade that presents a `controllerId`+
`leaderKey` NOT matching the elected leader is rejected `403 LEADER_ONLY`. A matching
one that arrives while the DO still holds a previous `leaderSocket` is **not** rejected
— the DO closes the stale socket and accepts the new one.

**Rationale:** Stale sockets are ghost connections. `workerd` does not reliably deliver
`webSocketClose` on a dropped/half-open leader connection, and a DO eviction can drop
the socket without a close event. 409-rejecting the rightful leader's reconnect would
deadlock it: it retries the same session, exhausts its ~20 attempts, gives up with no
tray, and the extension side-panel follower then can't join — surfacing as "Tray leader
WebSocket failed before leader.connected" with no tray URL.

**Safety:** The stale `leaderSocket` is nulled before `close()` so its (possibly
synchronous) `webSocketClose` is a no-op and can't clear the freshly-accepted leader.

---

## Debug the Preview Bridge Protocol

The preview bridge (`serve --bridge`) lets the leader drive a visited page as a
synthetic CDP target over a WebSocket hosted by the Durable Object.

### Continuity across tray resets and roves

`POST /api/tray/:trayId/preview-transfer` authenticates the source controller
with Bearer and accepts JSON `{ targetTrayId, targetControllerToken }`. The edge
forwards only those fields plus `controllerToken` to the source owner's
`/internal/preview/transfer`. Request bodies are capped at 8 KiB / 10 seconds;
the owner call is bounded at 60 seconds. A `503` is ambiguous: retain the same
source and target credentials and retry idempotently, not with a new target.
Never log either capability. Contract and error meanings:
[`docs/cloudflare-worker-details.md`](../../../docs/cloudflare-worker-details.md#public-routes).

The transfer imports original preview records and
updates each token's original-tray locator directly to the current owner. The public
URL, root/entry jail, bridge scope, tab cap and webhook identity stay unchanged across
repeated roves; no controller secret appears in a redirect. Both hub and dedicated
preview worker resolve the locator before serving content, bridge sockets or emits.

Persist the source/target pair before starting this handoff; a failed or interrupted
transfer returns `503` and must retry the SAME pair before old-tray reset. The source
is frozen until completion. Durable import receipts prevent a retry from resurrecting
revoked previews. Existing bridge sockets close with `1012` and reconnect (new connId).
Only `410 PREVIEW_TARGET_UNAVAILABLE` proves the source has not frozen and permits
discarding the cached target. Generic `403`/`410` do not. Once frozen, retained target
controller ownership permits finishing that exact pair even after target reclaim expiry.
Import does not revive its leader session: the manager durably promotes the completed
expired target to the next source, then attempts one bounded extra rove to a fresh tray.
Never retarget a frozen source: some original-token locators may already have moved.
Persistent snapshots keep their existing R2 keys, upload credentials and expiry; only
the new owner cleans up expired/revoked archives. Do not renew the TTL during roves.
Upload authorization durably leases a unique candidate R2 key for 120 seconds (up to
eight active writes per preview). Expired candidates cannot commit; retries never
overwrite canonical objects. Lost release/authorization responses and vanished edges
recover concurrency on the next authorization; expired keys collapse into one
unresolved-write flag. Legacy string leases migrate once on first use.
Body reads, R2 puts, authorization, commit and release have 30-second deadlines.
Expiry/revoke retains a non-serving cleanup tombstone and repeats prefix sweeps for
at most 24 hours, without consuming active preview slots. Unfinished transfers
intentionally retain their non-serving locator-recovery ledger until the same transfer
is retried, independently of this operational cleanup horizon. That ledger cannot serve
content, accept uploads, or consume active preview slots. Timeout is NOT cancellation:
the mandatory independent 90-day R2 lifecycle on `previews/` catches arbitrarily late
writes after local cleanup ends. Do not shorten this below the maximum 30-day pending
window plus 30-day finalized retention. Run the lifecycle deployment gate before
deploying, including manual deployments; never rely on edge callbacks to reclaim bytes.
Run `preview-continuity.test.ts` for local multi-DO continuity and failure regressions.

### Stable webhook lifecycle

Preview webhook identity follows the leader-session lineage, not individual WorkUnits.
Management secrets live in manager-private IndexedDB, outside public session/status,
VFS and follower messages. Stable-aware `POST /tray` also carries a private `createAttemptId`
(32–128 URL-safe alphanumeric, `_`, `-` characters), persisted before the request and retained
until its session is durable. Retry the same identity AND attempt after bind failure or a lost
response: the worker derives an authenticated opaque tray address and reuses its original
capabilities. Mint a new attempt for a deliberate reset, never reuse a fixed cone-based tray ID.
Identity-less clients retain `/webhook/` URLs and do not depend on webhook-home availability.
Cone IDs and both secrets must be URL-safe, dot-free components (1–128 characters).
Rotation replaces both delivery and management hashes atomically on the same home with a
retry receipt covering old/new secrets, tray and controller. Private pending intent stores
fresh random replacements before HTTP and resumes exact lost-response requests before rebind.
Old management credentials cannot create fresh mutations; completed receipt replay is read-only
and requires the caller to already present both replacements. Legacy deterministic pending
intents lacking replacements are retained and refused locally for operator reconciliation.
Transport failures, malformed success replies, `408`, `409`, `429` and server errors
retain that intent. Definitive HTTP refusals (`400`/`401`/`403`/`404`/`405`/`410`/`422`)
drop it so leader startup can continue. Identity changes use atomic IndexedDB
compare-and-swap: a late tab response cannot restore a revoked secret or remove another
tab's newer pending rotation. If another rotation remains pending, reconnect stays
fail-closed until its replay completes.
Deletion persists a permanent hashed registration tombstone before discarding that ID's
queue, and removes its local definition only after hub acknowledgement.

The home durably enqueues before forwarding or `202`. Acceptance is not completed agent
work: replay is at-least-once and requires explicit delivery/filter acknowledgement.
Explicit `404 WEBHOOK_NOT_REGISTERED` / `422 WEBHOOK_TARGET_UNRESOLVED` responses with
`accepted: false` get three consecutive attempts at least 30 seconds apart, then atomically
leave the FIFO with a durable dead-letter receipt. Ambiguous/transient responses never
exhaust a budget and reset the rejection streak. The latest 100 terminal receipts live in
`webhook-dead-letter:0` through `:99`; `webhook-home.deadLetterCount` is the lifetime total.
Only older terminal details are overwritten; the archive cannot consume active queue slots.
Inspect/export through privileged DO storage tooling; no public archive or automatic replay.
Explicit rejection backoff can be bypassed by other IDs, never later events of the same ID.
Eligible independent backlog runs after one second; ambiguous outcomes remain blocking.
Accepted events have no queue TTL or eviction. Limits: 100 events, 120 KiB encoded home
record, 64 KiB body, eight pending requests. Capacity returns `429` with `Retry-After: 30`;
oversized bodies return `413`. Alarms retry blocked heads after 30 seconds and remaining
backlog after successful removal after one second. The 90-day home admission expiry is
separate from event retention. See
[`docs/cloudflare-worker-details.md`](../../../docs/cloudflare-worker-details.md#signaling)
for the lifecycle contract.

### Wire format

The bridge tab connects over `WS <token>.sliccy.now|dev/__slicc/bridge`
(Sec-WebSocket-Protocol: `slicc.preview-bridge.v1.<connId>`). Messages from the
browser tab to the DO are plain JSON objects; the key field is `t`:

| `t` value | Direction | Meaning                                                                                              |
| --------- | --------- | ---------------------------------------------------------------------------------------------------- |
| `cdp.res` | tab → DO  | CDP response: `{ t:'cdp.res', id, result \| error }`, relayed to the leader as `bridge.cdp.response` |
| `emit`    | tab → DO  | Attributed event: `{ t:'emit', name, detail }` (see below)                                           |
| `cdp.req` | DO → tab  | CDP request: `{ t:'cdp.req', id, method, params, sessionId }`                                        |

### Attributed emit

`window.slicc.emit(name, detail)` is sent over the bridge WS as
`{ t:'emit', name, detail }`. The DO knows which socket it came from, so it
looks up the record's `webhookId` and sends a `webhook.event` envelope stamped
with attribution headers:

```
x-slicc-preview-conn: <connId>
x-slicc-preview-token: <token>
```

The leader threads that `headers` map through unchanged (no signature or body
mutation), and `formatWebhookLick` renders the envelope as a distinct
**Preview Event** tied to `preview:<token>:<connId>`.

> **Why identity rides in headers, not the body:** the page's `detail` is
> delivered verbatim. Embedding `connId`/`token` in the body would require the
> DO to merge them into an arbitrary JSON object it doesn't own. Headers keep
> the attribution out-of-band so the lick pipeline can parse it without
> touching `detail`.

### Unattributed POST fallback

`POST <token>.sliccy.now|dev/__slicc/emit` is the fallback beacon relay for
`window.slicc.emit(name, detail)` when the bridge WS isn't open (e.g., page
unload). The DO looks up the record's `webhookId` and sends the `webhook.event`
envelope to the leader **without** the attribution headers, so
`formatWebhookLick` renders it as a plain webhook lick rather than a Preview
Event. Only available when `PreviewRecord.bridge` is true.

### Synthetic error for gone sockets

On leader (re)connect the DO replays `bridge.connected` for every live bridge
socket so a leader reload doesn't orphan open tabs. A `bridge.cdp.request` for
a socket that has since closed is answered with a **synthetic error** — this
lets the leader fail fast (immediate error response) instead of waiting for a
30-second timeout.

---

## Deploy Through CI

### Deploy both workers together

The hub (`wrangler.jsonc`) and the preview worker (`wrangler-preview.jsonc`) share the
same Durable Object (bound in the preview config via `script_name`) and the same preview
URL token format (`buildPreviewUrl` in `@slicc/shared-ts` ↔ `previewTokenFromHost` in
`src/preview-host.ts`). They **must** be deployed as a pair — a hub-only deploy that
changes the URL format leaves the stale preview worker unable to parse the new URLs,
causing every `serve` preview to 404 "Preview not found". The automated release
(`scripts/publish-worker.sh`) and the manual `worker.yml` dispatch both deploy both
workers.

### Check deploy gating

The automated semantic-release path gates production deployment with
`release-native.mjs --gate=worker`, comparing the previous release tag to `HEAD` (or
`HEAD^` when `HEAD` is the generated `chore(release):` version-bump commit so that
commit alone doesn't open the gate). Changes under the worker, served webapp/UI
packages, shared worker dependencies, root package metadata, or hosted e2b template
inputs deploy both workers and run the live smoke tests. First releases always deploy;
releases with only unrelated changes refresh the R2 archive and exit before the template
push, secret writes, both `wrangler deploy` calls, and deployed smoke tests.

### Inspect retry logic

Production hub and preview deploys each retry up to six times with a 15-second delay.
Each attempt enables Wrangler debug logging; exhausting all attempts prints that worker's
debug log to CI stderr before failing.

### Classify routes-only failures as non-fatal

`deploy_with_retry` captures each attempt's combined output and, on failure, classifies
it with `release-native.mjs --classify-deploy-log` (pure `isRoutesReconcileOnlyFailure`,
unit-tested). A failure is treated as a successful deploy (with a loud warning) when
BOTH signals are present:

1. The worker version **uploaded** (`Uploaded <name> (<n> sec)` — new script + assets
   are live).
2. The routes-API call **failed** (`A request to the Cloudflare API (…/workers/routes)
failed` — only route reconciliation failed, e.g. the token lost Zone → Workers Routes
   → Edit).

Requiring the upload line rules out a pre-deploy routes failure (version never went
live). Wrangler phrases the routes failure two ways — the hub wraps it in "Some triggers
failed to deploy", the preview worker surfaces the bare routes-API auth error — so the
classifier keys off the upload + routes-API-failure signals rather than the "triggers
failed" wrapper. Routes are set-once/stable, so the new version is already serving; the
release continues to the GitHub-release/Chrome/npm publish steps, and the warning flags
that any _changed_ routes did not apply until the token's routes scope is restored.
Any other failure (script upload, bindings, asset-too-large) still retries and then
fails hard.

### Configure the required repository values

- Secret: `CLOUDFLARE_API_TOKEN`
- Variable: `CLOUDFLARE_ACCOUNT_ID`

---

## Deploy and Test Staging

### Verify the Cloudflare account

Production and staging workers live on the **AEM Demo** account
(`155ec15a52a18a14801e04b019da5e5a`). Verify with `npx wrangler whoami` — if it shows
a different account, re-authenticate:

```bash
npx wrangler login   # interactive — pick "AEM Demo" in the browser
```

### Deploy both workers together

| Worker   | Config                   | Staging name             | Routes                     |
| -------- | ------------------------ | ------------------------ | -------------------------- |
| Main hub | `wrangler.jsonc`         | `slicc-tray-hub-staging` | `*.workers.dev` (API + UI) |
| Preview  | `wrangler-preview.jsonc` | `slicc-preview-staging`  | `*.sliccy.dev/*`           |

### Provide the required UI assets first

The hub worker serves the webapp via Cloudflare Workers Static Assets from `dist/ui/`.
A bare worktree only has `electron-overlay-entry.js` — the staging deploy will succeed
but every page load returns 404.

**From a worktree**, symlink the main repo's built UI before deploying:

```bash
trash dist/ui
ln -s /path/to/main-repo/dist/ui dist/ui
```

**From the main repo**, build the UI:

```bash
npm run build -w @slicc/webapp
```

### Upload assets to R2, then deploy

The R2 upload gate **must** run before the first `wrangler deploy` attempt (see
"Run the upload gate before every deploy" above). Then deploy both workers as a pair:

```bash
# From the repository root:
node packages/cloudflare-worker/scripts/upload-assets-to-r2.mjs \
  --bucket slicc-asset-archive-staging --dir dist/ui/assets

cd packages/cloudflare-worker
npx wrangler deploy --config wrangler.jsonc --env staging
npx wrangler deploy --config wrangler-preview.jsonc --env staging
cd -  # return to repo root
```

### Test `serve` against staging

The `serve` command mints preview URLs via the tray hub. It needs:

1. A **leader tray session** connected to the staging hub.
2. Tray API calls to be **same-origin** (no CORS).

**Use `--lead` from the main repo** (not the worktree — it has no node-server):

```bash
cd /path/to/main-repo
npm run dev -- --lead https://slicc-tray-hub-staging.minivelos.workers.dev
```

This loads the webapp from the staging hub (same-origin → no CORS) and auto-connects
as a tray leader.

**Do NOT use `SLICC_TRAY_WORKER_BASE_URL`** — it overrides only the tray WebSocket
target while the UI loads from a different origin, causing cross-origin "Failed to
fetch" errors on every tray API call.

**Do NOT use `host leave --leader <url>`** from a localhost-served UI for the same
CORS reason.

### Run the staging test checklist

Once `npm run dev -- --lead <staging-url>` is running and the tray is connected:

```bash
# In Slicc shell:
echo '<h1>test</h1>' > /workspace/test/index.html
serve /workspace/test
# → should print a https://<token>.sliccy.dev URL
```

- **Hibernation**: wait ~2 min idle, reload the URL — should not 502
- **Cache**: reload within 5s — should be faster (CF cache hit)
- **Staleness**: edit the file, wait 5s, reload — new content
- **ETag**: `curl -I <url>`, copy `etag`, then `curl -H 'If-None-Match: "<etag>"' <url>` → 304

### Test `serve --bridge` locally without a deploy

The hub worker serves previews itself (`src/preview-handler.ts`) and `previewTokenFromHost`
accepts `<token>.localhost[:port]`, so the whole driveable-preview bridge is testable
against a single local `wrangler dev` — no separate deploy required:

```bash
# 1. Hub worker — MUST use --env staging (its routes:[] lets wrangler dev honor
#    the real per-request Host, so the tray's capability URLs AND the
#    <token>.localhost preview subdomains stay local). Plain `wrangler dev` uses
#    the prod routes (www.sliccy.ai/*), so the controller URL points at prod.
npx wrangler dev --config packages/cloudflare-worker/wrangler.jsonc --env staging \
  --port 8787 --ip 127.0.0.1

# 2. Leader → local hub. BRIDGE_DEV_ALLOWED_ORIGINS whitelists the leader's
#    localhost origin for the /cdp bridge WS upgrade.
BRIDGE_DEV_ALLOWED_ORIGINS=http://localhost:8787 \
  npm run dev -- --lead http://localhost:8787

# 3. In the Slicc shell: `serve --bridge <dir>` mints http://<token>.localhost:8787/
```

Reach the worker via **localhost:8787**, not `127.0.0.1:8787` — `buildPreviewUrl`'s
lookup table only has a `localhost:8787` row. Browsers resolve `*.localhost` to
loopback; the `.localhost` host is dev-only.

## Follower push (APNs, #2062)

Four secrets, all or nothing: `APNS_TEAM_ID`, `APNS_KEY_ID`, `APNS_PRIVATE_KEY` (the `.p8` PEM, newlines intact — `npx wrangler secret put APNS_PRIVATE_KEY < AuthKey_XXXX.p8`), `APNS_TOPIC` (`com.sliccy.follower`). Missing → the DO logs `push.send ignored` once and nothing else changes. Staging talks to whatever gateway the registering phone asked for (`environment` on `push.register`: debug builds = sandbox, TestFlight/App Store = production), so a TestFlight build against staging needs the production key. Verify with a time-sensitive test: run a headless leader, background the phone, `sudo` something — the banner must arrive within seconds; a 403 `InvalidProviderToken` in `wrangler tail` means the key id / team id pair is wrong.

**Provider JWTs come from one DO, not per tray.** Apple throttles token creation per
(team id, key id) — not per connection — and answers `429 TooManyProviderTokenUpdates`
above one mint per 20 minutes. Every tray DO borrows from
`idFromName('__apns_provider_token')` via `POST /internal/apns-token`, which persists the
JWT to its own storage so hibernation costs nothing (#2432). Never reintroduce per-DO
minting: the tray DO hibernates between messages, so mint rate would scale with
`active trays × wake cycles`, not with time.

**Probe the worker→Apple leg without a phone.** Register a syntactically valid but
fabricated device token and push; APNs authenticates the JWT _before_ it validates the
token, so a dead-token verdict proves the credentials are good:

```bash
# 1. mint a throwaway tray, 2. attach as leader, 3. open the leader WS, then send:
#    {"type":"push.register","platform":"ios","token":"<64 hex>","environment":"sandbox"}
#    {"type":"push.send","category":"turn_end","label":"probe"}
# Push again on the SAME tray ~30s later.
```

Read the result from the second push, not from logs: if the token was evicted the second
`push.send` early-returns in ~10 ms (Apple answered `BadDeviceToken`/410 — credentials
good). If it takes ~8 s again the token survived, meaning a timeout or a 403 — credentials
or transport are broken. Do **not** infer from `wallTime` on the first push alone: an
8-second reading used to be the uncleared `AbortSignal.timeout`, not a hang.

This is deliberately not a CI gate — it would put Apple's availability in the deploy path.

### Settle the gateway before reading any rejection (two-tray probe)

A device token is valid on **one** gateway only, decided by the build's
`aps-environment` entitlement: a development-signed build gets a sandbox token, a
TestFlight/App Store build a production one. Send it to the wrong gateway and Apple answers
`BadDeviceToken` — indistinguishable, at a glance, from a wrong topic or a bad key. Never
interpret a rejection before establishing which gateway the token belongs to.

Do not infer the gateway from the build. `currentApnsEnvironment()` reports what the app
_claims_ — derived from `#if DEBUG`, not from the entitlement it actually holds — and a
dev-signed **Release** build claims `production` while carrying a sandbox token. Reading
Xcode settings or `builtByDeveloper` only tells you what _should_ be true.

Ask Apple instead. With one real device token, register it on **two throwaway trays** and
push once from each — the DO stores `environment` per token, so the same token can be
driven at both gateways:

```
tray A: {"type":"push.register", …, "environment":"sandbox"}    → push.send
tray B: {"type":"push.register", …, "environment":"production"} → push.send
```

Read the verdict from a **second** push on each tray (the eviction signal above):

| tray A (sandbox) | tray B (production) | meaning                                                |
| ---------------- | ------------------- | ------------------------------------------------------ |
| token evicted    | token evicted       | wrong on both — topic or key is wrong, not the gateway |
| token survives   | token evicted       | sandbox is correct; it is a development build          |
| token evicted    | token survives      | production is correct; TestFlight / App Store build    |

A token that **survives** was accepted (`200`) — that gateway is the right one. Once the
gateway is known, a rejection there is finally meaningful: `DeviceTokenNotForTopic` means
`APNS_TOPIC` does not match the app's bundle id, whereas `BadDeviceToken` on the _correct_
gateway means the token itself is stale. That distinction is the only way to verify
`APNS_TOPIC`, because Apple rejects a malformed token before it ever checks the topic — so
no fabricated-token probe can reach it.
