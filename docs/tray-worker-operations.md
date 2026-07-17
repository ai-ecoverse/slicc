# Tray Worker Operations Runbook

Operational detail for `packages/cloudflare-worker/` — R2 asset archive, deploy
gating, ghost-leader reconnect, CI retry logic, and the staging test guide.

For the protocol and module map see
[`packages/cloudflare-worker/CLAUDE.md`](../packages/cloudflare-worker/CLAUDE.md).
For the tray signaling architecture and the leader/follower message matrix see
[`docs/architecture.md`](architecture.md#multi-browser-sync-tray-architecture).

---

## R2 Asset Archive

**Goal:** Keep content-hashed `/assets/*` chunks available across deploys so
long-lived browser tabs don't crash when lazy-loaded chunks from an older build
disappear. The worker serves archived chunks from R2 on an `ASSETS` miss, degrading
gracefully to the shipped stale-asset reload if retention doesn't cover a chunk.

### Binding and buckets

`wrangler.jsonc` defines an `ASSET_ARCHIVE` R2 binding per environment:
`slicc-asset-archive` (production) and `slicc-asset-archive-staging` (staging).
The worker's `WorkerEnv` type includes `ASSET_ARCHIVE: R2Bucket`.

### Serving path (`serveAssetWithArchiveFallback`)

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

### Hash invariant (enforced)

Every `/assets/*` filename must carry a content hash (e.g., `-DP3-Xd3J`). The upload
script (`packages/cloudflare-worker/scripts/upload-assets-to-r2.mjs`) fails the deploy
if any `dist/ui/assets/*` name lacks a hash, and the worker's routing predicate enforces
the same rule (defined in the shared `asset-archive.mjs` module).

### Upload gate (before every deploy)

Every deploy path (prod automated via `publish-worker.sh`, prod manual via `worker.yml`,
staging via `ci.yml` and `worker-staging.yml`) runs the upload step **before the first
`wrangler deploy` attempt**. The production release script also runs it when its
worker/UI change gate skips deployment. The upload re-puts the **entire current asset
set** to the archive (no skip-if-exists; refreshes `last-modified` which the GC relies
on) with retries and bounded concurrency, failing the release hard if any file fails to
upload or the hash invariant is violated. Auth: `CLOUDFLARE_API_TOKEN` (must have R2
Object Read & Write on both buckets) and `CLOUDFLARE_ACCOUNT_ID`.

### Garbage collection (age-based)

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

### MIME map

Shared in `src/asset-archive.mjs` (used by both worker and upload script):
`.js`/`.mjs`→`text/javascript`, `.css`→`text/css`, `.json`/`.map`→`application/json`,
`.wasm`→`application/wasm`, `.woff2`→`font/woff2`, `.svg`→`image/svg+xml`;
fallback `application/octet-stream`.

### Testing

Unit tests in `tests/index.test.ts` verify present-asset, miss (archive hit/miss),
HEAD, Range/conditional requests (full `200`, not 206/304), cache behavior, and error
handling. Deployed smoke tests in `tests/deployed.test.ts` verify (staging-only) R2
archive recovery and (both envs) present-asset fetch via the live worker.

---

## Ops Runbook: R2 Prerequisites

These manual Cloudflare operations **must exist before CI deploys**, else the upload
step will fail.

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
- **Zone → Workers Routes → Edit** _and_ **Zone → Zone → Read** for the `sliccy.ai`
  zone — reconcile the `www.sliccy.ai/*` + `*.sliccy.now/*` routes on deploy.

> ⚠️ **Incident (2026-07-13):** granting R2 to this token dropped its
> **Zone/Workers-Routes** scope. The worker script still deployed, but `wrangler deploy`
> failed reconciling routes (`"does not have 'All Zones' permissions"`), which aborted
> the release **before** the GitHub-release/Chrome/npm publish steps. `publish-worker.sh`
> now treats a routes-only deploy failure as non-fatal (version already live), but the
> token should still carry the routes scope so route _changes_ apply. When editing the
> token, add scopes; never replace the whole set with only R2.

---

## Ghost-Leader Reconnect

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

## Preview Bridge Protocol

The preview bridge (`serve --bridge`) lets the leader drive a visited page as a
synthetic CDP target over a WebSocket hosted by the Durable Object.

### Wire format

The bridge tab connects over `WS <token>.sliccy.now|dev/__slicc/bridge`
(Sec-WebSocket-Protocol: `slicc.preview-bridge.v1.<connId>`). Messages from the
browser tab to the DO are plain JSON objects; the key field is `t`:

| `t` value | Direction | Meaning                                                       |
| --------- | --------- | ------------------------------------------------------------- |
| `cdp.res` | tab → DO  | CDP response: `{ t:'cdp.res', id, result                      | error }`relayed to the leader as`bridge.cdp.response` |
| `emit`    | tab → DO  | Attributed event: `{ t:'emit', name, detail }` (see below)    |
| `cdp.req` | DO → tab  | CDP request: `{ t:'cdp.req', id, method, params, sessionId }` |

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

## CI and Deployment

### Two workers ship together

The hub (`wrangler.jsonc`) and the preview worker (`wrangler-preview.jsonc`) share the
same Durable Object (bound in the preview config via `script_name`) and the same preview
URL token format (`buildPreviewUrl` in `@slicc/shared-ts` ↔ `previewTokenFromHost` in
`src/preview-host.ts`). They **must** be deployed as a pair — a hub-only deploy that
changes the URL format leaves the stale preview worker unable to parse the new URLs,
causing every `serve` preview to 404 "Preview not found". The automated release
(`scripts/publish-worker.sh`) and the manual `worker.yml` dispatch both deploy both
workers.

### Deploy gating

The automated semantic-release path gates production deployment with
`release-native.mjs --gate=worker`, comparing the previous release tag to `HEAD` (or
`HEAD^` when `HEAD` is the generated `chore(release):` version-bump commit so that
commit alone doesn't open the gate). Changes under the worker, served webapp/UI
packages, shared worker dependencies, root package metadata, or hosted e2b template
inputs deploy both workers and run the live smoke tests. First releases always deploy;
releases with only unrelated changes refresh the R2 archive and exit before the template
push, secret writes, both `wrangler deploy` calls, and deployed smoke tests.

### Retry logic

Production hub and preview deploys each retry up to six times with a 15-second delay.
Each attempt enables Wrangler debug logging; exhausting all attempts prints that worker's
debug log to CI stderr before failing.

### Routes-only failures are non-fatal

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

### Required repo configuration

- Secret: `CLOUDFLARE_API_TOKEN`
- Variable: `CLOUDFLARE_ACCOUNT_ID`

---

## Staging Deployment & Testing

### Cloudflare account

Production and staging workers live on the **AEM Demo** account
(`155ec15a52a18a14801e04b019da5e5a`). Verify with `npx wrangler whoami` — if it shows
a different account, re-authenticate:

```bash
npx wrangler login   # interactive — pick "AEM Demo" in the browser
```

### Two workers must be deployed together

| Worker   | Config                   | Staging name             | Routes                     |
| -------- | ------------------------ | ------------------------ | -------------------------- |
| Main hub | `wrangler.jsonc`         | `slicc-tray-hub-staging` | `*.workers.dev` (API + UI) |
| Preview  | `wrangler-preview.jsonc` | `slicc-preview-staging`  | `*.sliccy.dev/*`           |

```bash
cd packages/cloudflare-worker
npx wrangler deploy --config wrangler.jsonc --env staging
npx wrangler deploy --config wrangler-preview.jsonc --env staging
```

### UI assets are required

The hub worker serves the webapp via Cloudflare Workers Static Assets from `dist/ui/`.
A bare worktree only has `electron-overlay-entry.js` — the staging deploy will succeed
but every page load returns 404.

**Fix:** symlink the main repo's built UI into the worktree before deploying:

```bash
trash dist/ui
ln -s /path/to/main-repo/dist/ui dist/ui
```

If the main repo doesn't have a build either, run `npm run build -w @slicc/webapp` there
first.

### Testing `serve` against staging

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

### Test checklist

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

### Local `serve --bridge` testing — no deploy

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
