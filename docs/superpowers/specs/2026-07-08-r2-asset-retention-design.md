# R2 Asset Retention — Design

**Status:** design (brainstorming output; codex rounds 1–3 applied)
**Date:** 2026-07-08
**Issue:** follow-up to #1330 / PR #1364 (stale-asset recovery)
**Branch:** `feat/r2-asset-retention`

## Problem

A long-lived browser tab loads the SLICC webapp (`index.html` + content-hashed
chunks) from build **A** served by the cloudflare-worker. A later deploy
replaces the worker's static assets with build **B** (new content hashes). The
tab's already-loaded modules keep working, but any **not-yet-loaded lazy chunk**
from build A (e.g. `anthropic-messages-DP3-Xd3J.js`) is now absent on the
server. Because `wrangler.jsonc` sets `not_found_handling:
"single-page-application"`, a request for the gone chunk returns `index.html`
(HTTP 200, `text/html`) rather than a 404 — the browser then tries to execute
HTML as a module and the dynamic import fails ("Failed to fetch dynamically
imported module …"). This is the #1330 crash.

PR #1364 shipped a **reactive** recovery: detect the failure and reload the tab
(with a one-shot auto-resubmit of the dropped cone turn). That works but is
heavy-handed:

- A reload tears down the kernel worker, every scoop, in-flight tool calls, and
  a half-streamed turn. Re-sending the last user message does **not** restore a
  running _cycle_ — partial progress and already-applied side effects are lost.
- The deferred SPA-HTML `Cache-Control` hardening leaves a window where a cached
  build-A shell coexists with freshly-fetched build-B chunks (mixed release).

## Goal

Eliminate the crash at its **root** by keeping every content-hashed `/assets/*`
file **within a retention window** available on the server, so a long-lived tab
can keep fetching **its own build's** chunks after a new deploy — no crash, no
reload, no interruption, and the tab stays internally consistent (it moves to
the new build only on a natural, user-initiated reload). The shipped reload
becomes a rare last-resort fallback for chunks past the window.

## Key insight: content hash = identity (enforced)

Every `/assets/*` filename **is** a hash of its bytes. The same filename can
only ever mean the same content, so the archive is a **flat, idempotent
key→bytes store** — no version/release grouping. This invariant is **enforced**,
not assumed: the upload step (§2) **fails the deploy if any `dist/ui/assets/*`
filename lacks a content-hash** (pattern `-<8+ url-safe chars>` before the
extension — Vite's default). It holds today because Vite hashes everything under
`assets/` and the fixed-name entry files (`index.html`, SW scripts, `manifest`,
favicon) live at the **root**, not under `/assets/`, so they are never archived
and always served from the current deploy. The worker only ever serves an
archived object on a **miss** (asset absent from the current deploy), which by
construction is always an old hashed chunk — so the `immutable` cache header is
always safe.

## Architecture

All runtimes load the webapp from a single hosted origin
(`SLICC_HOSTED_ORIGIN = https://www.sliccy.ai`): the standalone node-server, the
chrome-extension leader tab (`?slicc=leader`), and the cloud cone (headless
browser in e2b). A fix at the worker covers **all three** with no per-runtime
work. Two moving parts: (1) the worker serves archived assets on a miss; (2)
every deploy uploads its assets to the archive **before** going live.

### 1. Serving — ASSETS-first, R2-on-miss (worker)

Insertion point: `packages/cloudflare-worker/src/index.ts` — a dedicated
`serveAssetWithArchiveFallback(request, env, ctx)` invoked from the top-level
dispatch **before** the `wantsJSON` SPA/JSON split (`~:412`), so even
`/assets/foo.js?json=true` is handled here, not routed to the API index.

**Asset-path gate (strict regex = anti-traversal + hash invariant).** Handle here
only if `request.method` is `GET`/`HEAD` and the raw `url.pathname` matches:

```
^/assets/[A-Za-z0-9][A-Za-z0-9._-]*\.(js|mjs|css|map|wasm|woff2|woff|ttf|svg|png|jpg|jpeg|gif|webp|avif|ico|json)$
```

The class excludes `/`, `%`, `\`, `..`, and null bytes, so a match is inherently
traversal-safe. The gate **must also require a content-hash segment** (the same
pattern the upload asserts in §2 — `-<8+ url-safe chars>` before the final
extension, allowing a compound `.js.map`), so the worker never treats an
un-hashed path as archive-eligible; this keeps the immutable-cache and flat-key
assumptions sound. Worker and upload share **one** hash-pattern definition, and
the exact regex (incl. `.map`) is pinned in the plan against real Vite output.
**R2 key = matched `url.pathname` minus the leading `/`** — no decode step, so it
always equals the upload key. Query is ignored for key/cache. Anything not
matching falls through to today's behavior untouched.

**Miss detection (probe-based; robust to Range/conditional).** ASSETS is
configured with `not_found_handling: single-page-application`, so a missing asset
returns the shell — but for a request carrying `Range`/conditional headers the
shell can come back `206`/`304`, which would defeat a naive status check.
Therefore classify with a **sanitized canonical GET** (Range and conditional
headers stripped):

1. If the original request is a plain `GET`/`HEAD` with no `Range`/conditional,
   its ASSETS response _is_ the sanitized probe — reuse it (no extra fetch).
   Otherwise issue one extra `env.ASSETS.fetch(sanitizedGET)` to classify.
2. **Present** (probe `status === 200` and `Content-Type` not `text/html`): serve
   the **original** request through `env.ASSETS.fetch(originalRequest)` so the
   platform honors any Range/conditional. Return unchanged.
3. **Miss** (probe `200 text/html` **or** `404` — covers both `not_found_handling`
   outcomes should the config ever change): serve from the archive (below). On
   archive miss or any R2 error, return the **original ASSETS response** (the
   shell or the 404) exactly as today so the shipped `setup-preload-error-reload`
   recovery still fires — **no regression**.

**Response builder (R2 Workers API).** Scope: full `GET`, `HEAD`, and conditional
GET. **Range is intentionally unsupported** — archived assets are small,
immutable, content-hashed chunks that browsers do not Range-request; we omit
`Accept-Ranges` and ignore any `Range` header, returning the full `200` (HTTP
permits a server to ignore Range). This removes 206/416/If-Range/multi-range
complexity with no practical loss.

- Build `onlyIf` from **only** the browser-realistic revalidation headers
  `If-None-Match`/`If-Modified-Since` (ignore `If-Match`/`If-Unmodified-Since` —
  never sent for immutable asset GETs; serving the full `200` for them is
  compliant and avoids mixed-precedence ambiguity). Then
  `obj = await env.ASSET_ARCHIVE.get(key, { onlyIf })` — pass **only** `onlyIf`
  (Headers); do **not** pass `range: request.headers` (R2's `range` is an
  `R2Range`, not headers).
- **Archive miss** (`obj == null`): return the original ASSETS response (fallback).
- **Not modified** (`obj` present, `obj.body == null`): `304` with
  `ETag`/`Last-Modified`, no `Content-Length`, no body.
- **HEAD**: `200`, headers incl. `Content-Length: obj.size`, empty body.
- **Full GET**: `200`, `Content-Length: obj.size`, body.
- **Common headers:** `obj.writeHttpMetadata(headers)` (stored `Content-Type`;
  else the MIME map below), `ETag: obj.httpEtag`, `Last-Modified`,
  `Cache-Control: public, max-age=31536000, immutable`. No `Accept-Ranges`. Do
  **not** copy SPA-shell CSP headers onto asset responses (assets deliberately
  bypass `serveSPA`'s per-request header mutation; covered by a test).
- **MIME map:** `.js`/`.mjs`→`text/javascript`, `.css`→`text/css`,
  `.json`/`.map`→`application/json`, `.wasm`→`application/wasm`,
  `.svg`→`image/svg+xml`, `.woff2`→`font/woff2`, `.woff`→`font/woff`,
  `.ttf`→`font/ttf`, `.png`→`image/png`, `.jpg`/`.jpeg`→`image/jpeg`,
  `.gif`→`image/gif`, `.webp`→`image/webp`, `.avif`→`image/avif`,
  `.ico`→`image/x-icon`. Correct JS/MJS MIME is critical (a wrong type
  re-creates the module-load failure).
- **Compression:** serve raw bytes; Cloudflare's edge auto-compresses to the
  client (which may drop `Content-Length` under transform — tests must not
  over-assert exact length on the deployed path).
- **Outer wrapper:** archive responses still pass through the top-level worker
  wrapper (`index.ts:~831`) that adds `Link`/`X-Robots-Tag`; tests account for
  those, and the plan decides whether asset responses should skip that wrapper.

**Edge cache (Cache API), poison-safe.** Consult/populate the Cache API **only
for a plain `GET` with no `Range` and no conditional headers**; `HEAD` and
conditional requests bypass the cache and go straight to R2. Cache **only** a
successful full `200`, under a **canonical GET key** (scheme+host+
`/assets/<file>`, query dropped), cloning before put; write via
`ctx.waitUntil(cache.put(...).catch(...))` so a cache-write failure never turns a
recovered asset into a `500`. Never cache a miss, the shell, `304`, or `HEAD`.

Rationale for ASSETS-first: the live site is served by the platform, so an R2
outage degrades only _old_ tabs (they fall back to reload), not the whole site.
Added latency is only on _old-build_ requests, rare and edge-cached after first
hit. Navigations, `index.html`, SW scripts, and the `?cherry=1` / electron /
`/cloud` SPA-shell variants are untouched.

### 2. Population — upload assets to R2 before every deploy

A reusable script — `packages/cloudflare-worker/scripts/upload-assets-to-r2.sh <bucket>` —
first **asserts the hash invariant** (fails if any `dist/ui/assets/*` name lacks
a content hash), then loops over `dist/ui/assets/*` with bounded-concurrency
parallelism and per-file retries:

```
wrangler r2 object put <bucket>/assets/<file> --file <path> --content-type <mime> --remote
```

deriving `--content-type` from the extension (§1 MIME map). It **re-puts the
current build's full asset set every deploy — no skip-if-exists** (a PUT
refreshes `last-modified`, which the age-based GC in §3 relies on; re-putting is
content-idempotent, so the only cost is CI time, bounded by the parallelism). The
exact `wrangler r2 object put` flags (whether `--remote` is required/valid for the
repo-pinned wrangler) are verified in the plan against `wrangler r2 object put
--help`.

**Gating principle (exact per-file edits belong in the plan).** In **every** path
that runs `wrangler deploy`, insert the upload as a **single hard-fail step
(`continue-on-error: false`) after the build and before the _first_ deploy
attempt**, sharing the deploy's `if` guard; **all** deploy attempts are gated on
upload success. A build must never go live unarchived (that orphans the _next_
deploy's tabs). The four paths:

- **Automated production** — `.releaserc.json` → `npm run publish:worker` →
  `packages/cloudflare-worker/scripts/publish-worker.sh` (its `wrangler deploy`
  is the real prod deploy): insert the upload call before that deploy, prod
  bucket, using the already-built `dist/ui/assets`.
- **Manual production** — `.github/workflows/worker.yml` (3 `wrangler-action`
  attempts): one upload step before attempt 1, prod bucket.
- **Staging (CI)** — `.github/workflows/ci.yml` `cloudflare-worker` job
  (deploy/secrets retry pairs): one upload step before the first attempt, staging
  bucket.
- **Staging (dedicated)** — `.github/workflows/worker-staging.yml`: same, staging
  bucket.

Do **not** claim a universal 25 MiB dry-run gate — only some paths run it today;
the upload step itself is the added gate. (The plan may optionally add the
dry-run to prod paths.)

**Auth (explicit).** The upload runs as a plain `run:` step / shell, so it needs
`CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` in its environment (mirroring
`.github/workflows/storybook-screenshots.yml`). **The API token must carry R2
"Object Read & Write" for both buckets** — an ops prerequisite documented with
the feature (the existing deploy token likely needs this scope added).

### 3. Buckets, bindings & GC

Two R2 buckets (separate per env): `slicc-asset-archive` (prod) and
`slicc-asset-archive-staging`. `wrangler.jsonc`: add an `r2_buckets` binding
`ASSET_ARCHIVE` at the top level (→ prod) and duplicated in `env.staging` (→
staging), mirroring the per-env duplication of `assets`/DO bindings (env configs
do not inherit top-level bindings). First R2 binding in the repo; add the
`ASSET_ARCHIVE: R2Bucket` field to `WorkerEnv`. The **preview worker** (no
ASSETS) does not need it.

**GC:** an R2 **object-lifecycle rule** on each bucket deletes objects with
`last-modified` older than **14 days**. The `wrangler.jsonc` binding does **not**
create the rule; it is applied out-of-band and **verified** via
`wrangler r2 bucket lifecycle list <bucket>` (a documented ops step, checked in
the deployed smoke or a runbook). Every deploy re-puts the current set, so only
chunks that have **stopped shipping** for >14 days age out.

**Accepted residual (no touch job).** If production does not deploy for >14 days
(a release drought), the live build's chunks age out while still current, and a
just-superseded chunk then falls back to the **shipped #1364 reload** — rare in
an active repo (semantic-release deploys prod on merges to main) and the same
graceful degradation the 14-day window already implies for long-idle tabs. A
scheduled touch was rejected: a rebuild injects `SLICC_RELEASED_AT`/version
defines and can produce different hashes, so it would not reliably touch the
deployed keys. (Revisit with a manifest-driven touch or a wider window if
droughts become common.)

### 4. Interplay with the shipped reload (#1364)

Unchanged. Retention removes ~all reloads; the reload remains the last-resort
fallback for (a) a >14-day release drought, (b) an R2 outage/miss, (c) a
breaking client↔backend protocol change where the tab _should_ migrate, and
(d) the **first-deploy residual** — tabs already open on the pre-feature build
are not retroactively protected (that build's assets were never archived), so
after the first feature deploy they fall back to the shipped reload. Accepted,
one-time, self-healing (every deploy thereafter is archived). No client code
changes in this project.

## Data flow

```
Deploy (each path): build → upload-assets-to-r2.sh <bucket> (assert-hash, re-put ALL, retries)
   → [only on success] wrangler deploy (current build → ASSETS + index.html)

Request GET/HEAD /assets/<hash>.<ext>  (strict regex gate, else fall through):
  classify via sanitized canonical-GET probe to ASSETS:
     ├─ PRESENT (200 non-HTML) → serve original request via ASSETS (honors Range/conditional)
     └─ MISS (200 text/html)   →
           plain GET (no Range/conditional)? Cache API match (canonical key)
              ├─ cached → return
              └─ miss   → R2 get{onlyIf} → cache full-200 (waitUntil) → return
           HEAD / conditional?  → R2 get{onlyIf} (bypass cache)
              ├─ 200 / HEAD / 304 / 412 (per-status headers; Range ignored → full 200) → return
              └─ archive miss / R2 error → return shell (reload fallback, as today)
```

## Error handling

- `env.ASSET_ARCHIVE.get()` failure/exception → treat as miss (return the shell);
  never `500` an asset request.
- `cache.put` failure → swallowed via `waitUntil(...).catch(...)`.
- Upload-script failure (incl. hash-invariant violation) → **fail the deploy
  before `wrangler deploy`** (after retries).
- Content-type absent on an archived object → MIME map; last resort
  `application/octet-stream`.

## Testing

- **Worker unit** (`tests/index.test.ts`): present asset (ASSETS 200 non-HTML /
  206 / 304 / 404) returned unchanged, never consulting R2; a Range/conditional
  request for a **present** asset is classified present via the sanitized probe;
  miss (probe 200 text/html) + archive hit → 200 with correct MIME / `ETag` /
  `Content-Length` / immutable `Cache-Control` and **no** `Accept-Ranges` and no
  SPA CSP headers; **HEAD** (headers, no body); **`If-None-Match`** (match) → 304
  no `Content-Length`; **`If-Modified-Since`** → 304; **`If-Match`** (fail) →
  412; **`If-Unmodified-Since`** (fail) → 412; **Range header ignored** → full
  200; miss + archive miss → shell (no regression); strict-regex gate rejects
  non-asset / traversal / encoded paths and `POST`; **Cache API** consulted/
  populated only for plain GET, HEAD/conditional bypass it (a cached full-200 is
  never returned for them); cache-put failure does not 500.
- **Deployed smoke** (`tests/deployed.test.ts`): upload a synthetic non-ASSETS
  `assets/r2-retention-smoke-<hash>.js` to the staging bucket, then via the
  worker assert: full `GET` 200 + JS `Content-Type` + `ETag`; `HEAD`;
  `If-None-Match` with the returned `ETag` → 304; a cache-hit-after-full-GET
  still serves correctly; unknown `assets/<hash>.js` → shell; unknown non-asset
  path → shell. Send `Accept-Encoding: br,gzip` and do **not** over-assert exact
  `Content-Length` (edge may transform). Verify (or document) the lifecycle rule
  via `wrangler r2 bucket lifecycle list`. (Route-mirror rule: index.ts routing
  changes update `index.test.ts` **and** `deployed.test.ts`.)
- **Upload script**: MIME derivation, hash-invariant assertion (fails on a
  non-hashed name), re-put-all (no skip), retry/bounded-concurrency.
- Coverage kept at/above the cloudflare-worker floor.

## Out of scope

- The chrome-extension's own bundled assets (#1406 part (c)).
- Changing the shipped `setup-preload-error-reload` recovery (kept as fallback).
- SPA-HTML `Cache-Control` hardening (separately-deferred #1330 item).
- Client-side service-worker precache (rejected alternative).
- The preview worker (no ASSETS; no binding).
- A scheduled touch job (rejected — §3 residual).
- `Range`/206 support for archived assets (intentionally unsupported — §1).

## Decisions (locked)

| Decision         | Choice                                                                                                                                                                     |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Primary strategy | Server-side R2 asset retention (root-cause fix)                                                                                                                            |
| Serving          | ASSETS-first; miss classified via sanitized canonical-GET probe (`200 text/html`)                                                                                          |
| HTTP semantics   | Full GET / HEAD / conditional (304 for If-None-Match·If-Modified-Since, 412 for If-Match·If-Unmodified-Since); **Range unsupported** (ignore → full 200, no Accept-Ranges) |
| R2 API           | `get(key, { onlyIf: request.headers })` only (no `range: headers`); `writeHttpMetadata` + `httpEtag` + `size`                                                              |
| Edge cache       | Cache API: plain-GET only; cache full-200 under canonical key; `waitUntil` put, swallow errors                                                                             |
| Hash invariant   | Enforced: upload fails on any non-hashed `dist/ui/assets/*` name                                                                                                           |
| GC               | 14-day age-based lifecycle (applied out-of-band, verified via `wrangler r2 bucket lifecycle list`); re-put ALL every deploy; **no touch job**                              |
| Upload           | `upload-assets-to-r2.sh`; assert-hash + re-put ALL + retries, single hard-fail step before first deploy attempt                                                            |
| Deploy paths     | publish-worker.sh (auto prod) + worker.yml (manual prod) + ci.yml + worker-staging.yml; all deploy attempts gated on upload                                                |
| Buckets          | Separate per env; `ASSET_ARCHIVE` binding + `WorkerEnv` type; preview worker excluded                                                                                      |
| Reload (#1364)   | Retained as rare last-resort fallback, unchanged                                                                                                                           |
