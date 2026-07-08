# R2 Asset Retention — Design

**Status:** design (brainstorming output; codex/cursor review rounds 1–7 applied)
**Date:** 2026-07-08
**Issue:** follow-up to #1330 / PR #1364 (stale-asset recovery)
**Branch:** `feat/r2-asset-retention`

## Problem

A long-lived browser tab loads the SLICC webapp (`index.html` + content-hashed
chunks) from build **A** served by the cloudflare-worker. A later deploy replaces
the worker's static assets with build **B** (new content hashes). The tab's
already-loaded modules keep working, but any **not-yet-loaded lazy chunk** from
build A (e.g. `anthropic-messages-DP3-Xd3J.js`) is now absent on the server.
Because `wrangler.jsonc` sets `not_found_handling: "single-page-application"`, a
request for the gone chunk returns `index.html` (HTTP 200, `text/html`) rather
than a 404 — the browser then executes HTML as a module and the dynamic import
fails ("Failed to fetch dynamically imported module …"). This is the #1330 crash.

PR #1364 shipped a **reactive** recovery: detect the failure and reload the tab
(with a one-shot auto-resubmit of the dropped cone turn). It works but is
heavy-handed: a reload tears down the kernel worker, every scoop, in-flight tool
calls, and a half-streamed turn — re-sending the last user message does not
restore a running _cycle_.

## Goal (honestly scoped)

Make the #1330 crash **rare** by keeping content-hashed `/assets/*` chunks
available on the server for a retention window after they were last shipped, so a
long-lived tab keeps fetching **its own build's** chunks after a new deploy — no
crash, no reload, no interruption for the common case. Where retention does not
cover a chunk (see §3), the outcome degrades to the **existing #1364 reload** —
never worse than today.

**Coverage under the chosen GC (option A, §3):** fully covers **stable/vendor
lazy chunks** — the observed #1330 pattern (`anthropic-messages`), which re-ship
on every deploy until they change, so they are retained ≥14 days after
supersession. **Build-unique lazy chunks** (present in only one build that then
stays live a while) may fall outside the window and hit the reload fallback.
Making retention robust for _all_ chunks needs a small manifest-touch at deploy
(**option B**, fully specified in §3). **A vs B is the one decision awaiting
Karl;** this spec proceeds on **A** (matches the "no versions" lean, simplest
first iteration) with B as a documented, additive upgrade.

## Key insight: content hash = identity (enforced)

Every `/assets/*` filename **is** a hash of its bytes, so the archive is a
**flat, idempotent key→bytes store** — no version/release grouping. This is
**enforced**: the upload step (§2) fails the deploy if any `dist/ui/assets/*`
name lacks a content hash. It holds today because Vite hashes everything under
`assets/`, while fixed-name entry files (`index.html`, SW scripts, `manifest`,
favicon) live at the **root** — never archived, always served from the current
deploy. The worker only serves an archived object on a **miss** (asset absent
from the current deploy), which is by construction an old hashed chunk, so the
`immutable` cache header is always safe.

## Architecture

All runtimes load the webapp from one hosted origin (`SLICC_HOSTED_ORIGIN =
https://www.sliccy.ai`): standalone node-server, the chrome-extension leader tab
(`?slicc=leader`), and the cloud cone (headless browser in e2b). A worker-side
fix covers **all three**. Two moving parts: (1) the worker serves archived assets
on a miss; (2) every deploy uploads its assets to the archive **before** going
live.

### 1. Serving — ASSETS-first, R2-on-miss (worker)

A dedicated `serveAssetWithArchiveFallback(request, env, ctx)` in
`packages/cloudflare-worker/src/index.ts`, invoked from the top-level dispatch
**before** the `wantsJSON` SPA/JSON split (`~:412`), so even
`/assets/foo.js?json=true` is handled here.

**Gate (strict, hashed, traversal-safe).** Handle here only for `GET`/`HEAD`
whose raw `url.pathname` matches the **shared hashed-asset predicate** (also
used by the §2 upload assert; validated against real Vite output in impl):

```
^/assets/[A-Za-z0-9][A-Za-z0-9._-]*-[A-Za-z0-9_-]{8,}(\.[a-z0-9]+)*\.(js|mjs|css|map|wasm|woff2|woff|ttf|svg|png|jpg|jpeg|gif|webp|avif|ico|json)$
```

A `-<8+ url-safe chars>` hash segment before the (optionally compound, e.g.
`.js.map`) extension; the class excludes `/ % \ ..` and null bytes (traversal
safe). **R2 key = matched `url.pathname` minus the leading `/`** (no decode; always
equals the upload key). Query ignored for key/cache. Non-matching paths fall
through untouched. Both false directions degrade safely (a slipped-through
non-hashed name misses R2 → fallback; a real asset failing the gate is served by
ASSETS or falls back), and the §2 upload assert is the authoritative enforcement.

**Miss detection (probe-based; robust to Range/conditional).** With SPA
`not_found_handling`, a missing asset returns the shell — but a `Range`/
conditional request could make the shell come back `206`/`304`, defeating a naive
status check. Classify with a **sanitized canonical GET** (Range + conditional
headers stripped):

1. Plain `GET`/`HEAD` with no Range/conditional → its ASSETS response _is_ the
   sanitized probe (no extra fetch); otherwise issue one
   `env.ASSETS.fetch(sanitizedGET)` to classify.
2. **Present** (probe `200` and `Content-Type` not `text/html`): serve the
   **original** request via `env.ASSETS.fetch(originalRequest)` so the platform
   honors Range/conditional. Return unchanged.
3. **Miss** (probe `200 text/html` **or** `404`): serve from the archive (below).
   On archive miss/R2 error, return the classification-probe response — **but if
   the original method is `HEAD`, strip the body** (`new Response(null, {status,
headers})`) so a HEAD never carries a body — preserving today's reload
   fallback with **no regression**.

**Response builder (R2 Workers API).** Scope: full `GET`, `HEAD`, conditional
GET. **Range intentionally unsupported** (archived assets are small immutable
content-hashed chunks browsers don't Range-request): omit `Accept-Ranges`, ignore
any `Range` header, return full `200` (HTTP permits ignoring Range) — removes
206/416/If-Range/multi-range complexity.

- `obj = await env.ASSET_ARCHIVE.get(key, { onlyIf: request.headers })` — pass
  **only** `onlyIf` (a `Headers`); do **not** pass `range: request.headers`
  (R2's `range` is an `R2Range`, not headers). R2 evaluates all RFC-7232
  conditionals.
- **Archive miss** (`obj == null`): fall back (probe response; HEAD → bodyless).
- **Failed precondition** (`obj` present, `obj.body == null`): classify by RFC
  precedence — request carried `If-Match` or `If-Unmodified-Since` → **`412`**
  (their failure takes precedence); else (`If-None-Match`/`If-Modified-Since`) →
  **`304`** with `ETag`/`Last-Modified`, no `Content-Length`, no body.
- **HEAD** (body present): `200`, headers incl. `Content-Length: obj.size`, empty
  body.
- **Full GET**: `200`, `Content-Length: obj.size`, body.
- **Common headers:** `obj.writeHttpMetadata(headers)` (stored `Content-Type`;
  else MIME map), `ETag: obj.httpEtag`, `Last-Modified`, `Cache-Control: public,
max-age=31536000, immutable`. No `Accept-Ranges`.
- **MIME map:** `.js`/`.mjs`→`text/javascript`, `.css`→`text/css`,
  `.json`/`.map`→`application/json`, `.wasm`→`application/wasm`,
  `.svg`→`image/svg+xml`, `.woff2`→`font/woff2`, `.woff`→`font/woff`,
  `.ttf`→`font/ttf`, `.png`→`image/png`, `.jpg`/`.jpeg`→`image/jpeg`,
  `.gif`→`image/gif`, `.webp`→`image/webp`, `.avif`→`image/avif`,
  `.ico`→`image/x-icon`. Correct JS/MJS MIME is critical.
- **Compression:** serve raw bytes; Cloudflare's edge auto-compresses to the
  client (may drop `Content-Length` under transform — deployed tests must not
  over-assert exact length).
- **Header wrapper (decided):** asset responses (present + archived) deliberately
  do **not** get `serveSPA`'s `Content-Security-Policy: frame-ancestors` (a
  no-op for subresources; a deliberate, documented change from today where
  present assets pass through `serveSPA`). They **do** pass through the top-level
  wrapper (`index.ts:~831`, `applySliccLinks` + `X-Robots-Tag`), harmless on
  assets. Both asserted in tests.

**Edge cache (Cache API), poison-safe.** Consult/populate the cache **only for a
plain `GET` with no Range and no conditional headers**; `HEAD` and conditional
requests bypass the cache → R2. Cache **only** a full `200`, under a canonical
GET key (scheme+host+`/assets/<file>`, query dropped), cloning before put; write
via `ctx.waitUntil(cache.put(...).catch(...))` (cache-write failure never 500s).
Never cache a miss, the shell, `304`, `412`, or `HEAD`. Responses are
`immutable`, so indefinite edge caching is safe.

Rationale for ASSETS-first: the live site is served by the platform, so an R2
outage degrades only old tabs (reload), not the whole site.

### 2. Population — upload assets to R2 before every deploy

A reusable script `packages/cloudflare-worker/scripts/upload-assets-to-r2.sh
<bucket>` (1) **asserts the hash invariant** (fails if any `dist/ui/assets/*`
name lacks a hash, via the shared predicate) then (2) loops over
`dist/ui/assets/*` with bounded-concurrency parallelism + per-file retries:

```
wrangler r2 object put <bucket>/assets/<file> --file <path> --content-type <mime> --remote
```

`--content-type` from the extension (§1 MIME map). It **re-puts the full current
set every deploy — no skip-if-exists** (a PUT refreshes `last-modified`, which the
§3 GC relies on; content-idempotent, so the only cost is CI time, bounded by the
parallelism). The exact `wrangler r2 object put` flags (whether `--remote` is
required for the pinned wrangler) are verified in the plan against `wrangler r2
object put --help`.

**Gating principle (exact per-file edits in the plan).** In **every** path that
runs `wrangler deploy`, insert the upload as a **single hard-fail step
(`continue-on-error: false`) after build and before the _first_ deploy attempt**,
sharing the deploy's `if` guard; **all** deploy attempts are gated on upload
success (a build must never go live unarchived). The four paths:

- **Automated prod** — `.releaserc.json` → `npm run publish:worker` →
  `packages/cloudflare-worker/scripts/publish-worker.sh` (real prod deploy):
  upload before its `wrangler deploy`, prod bucket, using built `dist/ui/assets`.
- **Manual prod** — `.github/workflows/worker.yml` (3 `wrangler-action`
  attempts): upload before attempt 1, prod bucket.
- **Staging (CI)** — `.github/workflows/ci.yml` `cloudflare-worker` job (deploy/
  secrets retry pairs): upload before the first attempt, staging bucket.
- **Staging (dedicated)** — `.github/workflows/worker-staging.yml`: same, staging
  bucket.

**Auth (explicit).** The upload runs as a plain `run:` step / shell, so it needs
`CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` in its environment (mirroring
`.github/workflows/storybook-screenshots.yml`). **The API token must carry R2
"Object Read & Write" for both buckets** — an ops prerequisite documented with
the feature (the existing deploy token likely needs this scope added).

### 3. Buckets, bindings & GC

Two R2 buckets (separate per env): `slicc-asset-archive` (prod) and
`slicc-asset-archive-staging`. `wrangler.jsonc`: add an `r2_buckets` binding
`ASSET_ARCHIVE` at top level (→ prod) and duplicated in `env.staging` (→
staging), mirroring the per-env duplication of `assets`/DO bindings; add
`ASSET_ARCHIVE: R2Bucket` to `WorkerEnv`. First R2 binding in the repo; the
preview worker (no ASSETS) does not need it.

**GC — pure 14-day age-based (option A, chosen).** An R2 object-lifecycle rule on
each bucket deletes objects with `last-modified` older than **14 days**. The
`wrangler.jsonc` binding does **not** create the rule; it is applied out-of-band
and **verified** via `wrangler r2 bucket lifecycle list <bucket>` (a documented
ops step / runbook). Because every deploy re-puts its full current set, a chunk's
clock is refreshed on every deploy that includes it, so it survives **≥14 days
after the last deploy that shipped it**.

**Coverage & limitation.** Stable/vendor chunks re-ship until they change, so
they get ≥14 days after supersession (fully covers the #1330 pattern).
Build-unique chunks get `14 − (days the build stayed live)` after supersession;
a tab importing such a chunk past the window falls back to the shipped reload
(graceful, identical to today). A rebuild-based touch is rejected (a rebuild
injects `SLICC_RELEASED_AT`/version defines → different hashes → wouldn't touch
the deployed keys).

**Option B (robust upgrade, additive, pending Karl's A-vs-B call).** Give every
chunk ≥14 days after **supersession** with a small manifest-touch, no scheduled
job, no rebuild: at each deploy, the upload script (a) reads the bucket's stored
`manifests/current.json` (the **previous** build's key list) **before**
overwriting it, (b) uploads the new build's assets, (c) **copy-in-place touches**
the keys in `previous ∖ current` (the just-superseded build's unique chunks —
`wrangler r2 object get` then `put`, refreshing their `last-modified`), and (d)
overwrites `manifests/current.json` with the new key list. Each build is thus
touched exactly once, at the deploy that supersedes it → ≥14 days from
supersession for **all** chunks. Cost: one small manifest object + a touch loop
over the (small) per-deploy diff.

### 4. Interplay with the shipped reload (#1364)

Unchanged. Retention makes reloads rare; the reload remains the last-resort
fallback for (a) a build-unique chunk past the window (option A) or a >14-day
release drought, (b) an R2 outage/miss, (c) a breaking client↔backend protocol
change where the tab _should_ migrate, and (d) the **first-deploy residual** —
tabs already open on the pre-feature build are not retroactively protected
(never archived); after the first feature deploy they fall back to the reload.
Accepted, one-time, self-healing. No client code changes in this project.

## Data flow

```
Deploy (each path): build → upload-assets-to-r2.sh <bucket> (assert-hash, re-put ALL, retries)
   [option B also: read prev manifest → touch (prev∖current) → write manifest]
   → [only on upload success] wrangler deploy (current build → ASSETS + index.html)

Request GET/HEAD /assets/<hash>.<ext>  (shared hashed-asset gate, else fall through):
  classify via sanitized canonical-GET probe to ASSETS:
     ├─ PRESENT (200 non-HTML) → serve original request via ASSETS (honors Range/conditional)
     └─ MISS (200 text/html | 404) →
           plain GET (no Range/conditional)? Cache API match (canonical key)
              ├─ cached → return
              └─ miss   → R2 get{onlyIf} → cache full-200 (waitUntil) → return
           HEAD / conditional?  → R2 get{onlyIf} (bypass cache)
              ├─ 200 / HEAD(bodyless) / 304 / 412 (Range + full 200) → return
              └─ archive miss / R2 error → probe shell/404 (HEAD → bodyless) → reload fallback
```

## Error handling

- `env.ASSET_ARCHIVE.get()` failure/exception → treat as miss (fallback); never
  `500` an asset request.
- `cache.put` failure → swallowed via `waitUntil(...).catch(...)`.
- Upload-script failure (incl. hash-invariant violation, or option-B touch
  failure) → **fail the deploy before `wrangler deploy`** (after retries).
- Content-type absent on an archived object → MIME map; last resort
  `application/octet-stream`.

## Testing

- **Worker unit** (`tests/index.test.ts`, mock `env.ASSETS` + `env.ASSET_ARCHIVE`):
  present asset (ASSETS `200` non-HTML / `206` / `304` / `404`) returned
  unchanged, never consulting R2; a Range/conditional request for a **present**
  asset classified present via the sanitized probe; miss (probe `200 text/html`)
  - archive hit → `200`, correct MIME / `ETag` / `Content-Length` / immutable
    `Cache-Control`, **no** `Accept-Ranges`, no SPA CSP; **HEAD** hit (headers, no
    body); **`If-None-Match`**/**`If-Modified-Since`** → `304` (no `Content-Length`);
    **`If-Match`**/**`If-Unmodified-Since`** fail → `412`; **Range ignored** → full
    `200`; **miss + archive miss** → probe shell/404, and a **HEAD** miss fallback
    is **bodyless**; gate rejects non-asset / traversal / encoded / **un-hashed**
    paths and `POST`; **Cache API** consulted/populated only for plain GET, with
    HEAD/conditional bypassing it (a cached full-200 never returned for them);
    `cache.put` failure does not `500`.
- **Deployed smoke** (`tests/deployed.test.ts`): the **archive-recovery** case
  requires an R2 write, so it is **staging-only** — gate it on the staging env/
  bucket creds and **skip when running against production** (the same test runs
  against prod via `worker.yml` / `publish-worker.sh`, which must not perform prod
  R2 writes). Staging: upload a synthetic non-ASSETS
  `assets/r2-retention-smoke-<hash>.js`, then via the worker assert full `GET`
  `200` + JS `Content-Type` + `ETag`; `HEAD`; `If-None-Match` → `304`; a
  cache-hit-after-full-GET still serves; unknown `assets/<hash>.js` → shell.
  **Both envs (incl. prod):** a **present-asset** check — parse a real `/assets/*`
  URL from the deployed `index.html`, assert it serves (`200`, JS/CSS type, via
  ASSETS) including with `?json=true`; send `Accept-Encoding: br,gzip`, **record**
  `Content-Encoding` (informational), do **not** over-assert `Content-Length`;
  verify/document the lifecycle rule via `wrangler r2 bucket lifecycle list`.
  (Route-mirror rule: index.ts routing changes update `index.test.ts` **and**
  `deployed.test.ts`.)
- **Upload script**: MIME derivation; hash-invariant assertion (fails on a
  non-hashed name); re-put-all (no skip); retry/bounded-concurrency; (option B)
  manifest read/write + touch-the-diff.
- Coverage kept at/above the cloudflare-worker floor.

## Out of scope

- The chrome-extension's own bundled assets (#1406 part (c)).
- Changing the shipped `setup-preload-error-reload` recovery (kept as fallback).
- SPA-HTML `Cache-Control` hardening (separately-deferred #1330 item).
- Client-side service-worker precache (rejected alternative).
- The preview worker (no ASSETS; no binding).
- `Range`/206 support for archived assets (intentionally unsupported — §1).

## Decisions (locked, except the flagged A-vs-B)

| Decision         | Choice                                                                                                                                                                                                                                                     |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Primary strategy | Server-side R2 asset retention (root-cause fix)                                                                                                                                                                                                            |
| Serving          | ASSETS-first; miss classified via sanitized canonical-GET probe (`200 text/html`/`404`)                                                                                                                                                                    |
| HTTP semantics   | Full GET / HEAD (bodyless, incl. miss-fallback) / conditional (`304` for If-None-Match·If-Modified-Since, `412` for If-Match·If-Unmodified-Since); **Range unsupported** (ignore → full 200, no Accept-Ranges)                                             |
| R2 API           | `get(key, { onlyIf: request.headers })` (no `range: headers`); `writeHttpMetadata` + `httpEtag` + `size`                                                                                                                                                   |
| Edge cache       | Cache API: plain-GET only; cache full-200 under canonical key; `waitUntil` put, swallow errors; never cache miss/shell/304/412/HEAD                                                                                                                        |
| Hash invariant   | Enforced: upload fails on any non-hashed `dist/ui/assets/*` name; worker gate shares the pinned predicate                                                                                                                                                  |
| GC               | **Option A** (chosen): 14-day age-based lifecycle (out-of-band, verified via `wrangler r2 bucket lifecycle list`); re-put ALL every deploy. **Option B** (manifest-touch, pending Karl) documented as additive upgrade for full post-supersession coverage |
| Upload           | `upload-assets-to-r2.sh`: assert-hash + re-put ALL + retries; single hard-fail step before first deploy attempt                                                                                                                                            |
| Deploy paths     | publish-worker.sh (auto prod) + worker.yml (manual prod) + ci.yml + worker-staging.yml; all deploy attempts gated on upload                                                                                                                                |
| Deployed smoke   | Archive-recovery R2-write smoke **staging-only** (skipped vs prod); present-asset check both envs                                                                                                                                                          |
| Buckets          | Separate per env; `ASSET_ARCHIVE` binding + `WorkerEnv` type; preview worker excluded                                                                                                                                                                      |
| Reload (#1364)   | Retained as rare last-resort fallback, unchanged                                                                                                                                                                                                           |
