# R2 Asset Retention — Design

**Status:** design (brainstorming output; codex round 1 applied)
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
becomes a rare last-resort fallback for chunks older than the window.

## Key insight: content hash = identity

Every `/assets/*` filename **is** a hash of its bytes. The same filename can
only ever mean the same content. Therefore the archive is a **flat, idempotent
key→bytes store** — no version/release grouping is needed. Re-uploading a chunk
on a later deploy is a no-op content-wise (same key, same bytes). Only
**fixed-name entry files** (`index.html`, service-worker scripts, `manifest`,
favicon) are mutable "which-release" pointers and must always be served from the
**current** deploy — never archived.

## Architecture

All runtimes load the webapp from a single hosted origin
(`SLICC_HOSTED_ORIGIN = https://www.sliccy.ai`): the standalone node-server
(loads UI from the hosted origin, dials back to a local `/cdp` bridge), the
chrome-extension leader tab (`?slicc=leader`), and the cloud cone (headless
browser in e2b). A fix at the worker therefore covers **all three** with no
per-runtime work.

Three moving parts: (1) the worker serves archived assets on a miss; (2) CI
uploads each deploy's assets into the archive **before** the deploy goes live;
(3) a scheduled job keeps the live build's assets fresh so they never age out
while still current.

### 1. Serving — ASSETS-first, R2-on-miss (worker)

Insertion point: `packages/cloudflare-worker/src/index.ts` — the `serveSPA`
helper (`~:129`) and the SPA-fallback dispatch (`~:412`). Add a dedicated
`serveAssetWithArchiveFallback(request, env, ctx)` invoked for `/assets/*` GET/
HEAD requests **before** the generic SPA fallback.

**Asset-path gate.** Only intervene for requests whose canonical `url.pathname`
starts with `/assets/` **and** ends in a known asset extension
(`.js .mjs .css .map .wasm .woff2 .woff .ttf .svg .png .jpg .jpeg .gif .webp
.avif .ico .json`). Any other path is untouched (falls through to today's
behavior). This avoids misclassifying a hypothetical `/assets/*.html`.

**Key derivation (hardened).** Key = canonical `url.pathname` with the leading
`/` removed (e.g. `assets/anthropic-messages-DP3-Xd3J.js`). Reject and skip the
archive path (fall through to normal handling) if the decoded pathname contains
`..`, a backslash, an encoded slash (`%2f`/`%5c`), a null byte, or is empty
after the prefix. **Query string is ignored** for the key and for the cache key.

**Flow:**

1. `res = await env.ASSETS.fetch(request)` — the current build's asset, if
   present (unchanged hot path).
2. If `res.status === 200` and its `Content-Type` is **not** `text/html`, return
   `res` unchanged (current build; the common case; never touches R2).
3. Otherwise ASSETS returned the SPA shell for a hashed asset ⇒ **miss**. Serve
   from the archive via a single **response builder** (below). On archive miss
   or any R2 error, return the original `res` (the SPA shell, HTTP 200
   `text/html`) exactly as today so the shipped `setup-preload-error-reload`
   recovery still fires — **no regression**.

**Response builder (full HTTP semantics, from R2 object metadata).** Use the R2
Workers API, not ad-hoc headers:

- **Conditional:** `obj = await env.ASSET_ARCHIVE.get(key, { onlyIf:
request.headers, range: request.headers })`. If `obj` exists but has no `body`
  (a conditional/precondition result), return `304 Not Modified` with `ETag` /
  `Last-Modified` and no body.
- **HEAD:** `head = await env.ASSET_ARCHIVE.head(key)` (or `get` then discard
  body) → `200` with headers, empty body.
- **Range:** if `obj.range` is set, return `206 Partial Content` with
  `Content-Range` and the partial body; an unsatisfiable range → `416` with
  `Content-Range: bytes */<size>`.
- **Full GET:** `200` with the body.
- **Headers on every response:** `obj.writeHttpMetadata(headers)` (carries the
  stored `Content-Type`; fall back to an extension-derived MIME if absent),
  `ETag: obj.httpEtag`, `Content-Length: obj.size`, `Accept-Ranges: bytes`,
  `Last-Modified`, and `Cache-Control: public, max-age=31536000, immutable`.
  Do **not** copy the SPA-shell CSP/headers onto asset responses.
- **Compression:** serve raw bytes; Cloudflare's edge auto-compresses eligible
  content-types to the client, so we do not store or negotiate encodings.

**Edge cache (Cache API), poison-safe.** Only **successful full-body `GET` 200**
archive responses are cached, and only under a **canonical GET cache key**
(scheme+host+`/assets/<file>`, query dropped, method GET). **Never** cache: an
archive miss, the SPA shell, a `206`, a `304`, or a `HEAD` response. Clone the
response before `cache.put`. On a subsequent hit, `cache.match` short-circuits
before R2. Because responses are `immutable`, indefinite edge caching is safe.

Rationale for ASSETS-first (vs R2-first for all `/assets`): the live site keeps
being served by the platform, so an R2 outage degrades only _old_ tabs (they
fall back to reload) rather than taking the whole site down. Added latency is
only on _old-build_ chunk requests, which are rare and edge-cached after first
hit.

Navigations, `index.html`, SW scripts, and the `?cherry=1` / electron /
`/cloud` SPA-shell variants (which set their own headers) are untouched.

### 2. Population — CI upload at deploy (`wrangler r2 object put` loop)

Ordering is **strict** in every deploy workflow: **build webapp → 25 MiB
static-assets dry-run gate → upload all `dist/ui/assets/*` to the env bucket
(with retries) → only then run the real `wrangler deploy`.** If the upload step
fails, the job **hard-stops before deploy** — a build must never go live
unarchived (that would orphan the _next_ deploy's tabs).

Upload = a bounded-concurrency parallel loop of
`wrangler r2 object put <bucket>/assets/<file> --file <path> --content-type
<mime> --remote`, deriving `--content-type` from the file extension so the
worker reads `httpMetadata.contentType` on serve. The loop **re-puts the current
build's full asset set every deploy — it does NOT skip existing keys** (a PUT
refreshes `last-modified`, which the age-based GC in §4 relies on to keep
still-shipping chunks alive; re-putting is content-idempotent, so the only cost
is CI time, bounded by the parallelism).

**Auth (explicit).** The upload runs as a plain `run:` step (not
`wrangler-action`), so it must pass `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID` in its `env:` (mirroring
`.github/workflows/storybook-screenshots.yml`). **The API token must carry R2
"Object Read & Write" permission for both buckets** — an ops prerequisite
documented alongside the feature (the existing deploy token may need this scope
added).

Wire the step into the three deploy paths:

- `.github/workflows/ci.yml` — `cloudflare-worker` job (staging) → staging
  bucket.
- `.github/workflows/worker-staging.yml` (staging) → staging bucket.
- `.github/workflows/worker.yml` (production, `workflow_dispatch`) → prod bucket.

### 3. Freshness — scheduled touch of the live build

Age-based GC (§4) evicts by `last-modified`, refreshed only on deploy. If a
build stays live longer than the GC window without a redeploy (production
deploys are manual `workflow_dispatch`, so a >14-day gap is realistic), its
chunks would age out of R2 **while still current**, and the _next_ deploy would
orphan every tab on that (fresh) build.

Fix: a **scheduled workflow** (`.github/workflows/worker-asset-touch.yml`,
weekly cron, well inside the 14-day window) that checks out `main`, builds the
webapp, and re-runs the **same upload script** against the **prod** bucket —
touching the current build's assets so they never age out while live. Reuses the
§2 script; no new logic. (Staging churns on every PR, so it needs no touch job.)

### 4. Buckets, bindings & GC

Two R2 buckets (separate per env so staging's high churn never mixes into prod):
`slicc-asset-archive` (prod) and `slicc-asset-archive-staging`.

`wrangler.jsonc`: add an `r2_buckets` binding `ASSET_ARCHIVE` at the top level
(→ `slicc-asset-archive`) and duplicated in `env.staging` (→
`slicc-asset-archive-staging`), mirroring how `assets` and the DO bindings are
already duplicated per env (env configs do **not** inherit top-level bindings).
This is the **first R2 binding** in the repo. The **preview worker**
(`wrangler-preview.jsonc`, no ASSETS) does **not** need the binding.

**GC:** an R2 **object-lifecycle rule** on each bucket deletes objects whose
`last-modified` is older than **14 days**. Combined with §2 (deploy re-puts) and
§3 (weekly touch of the live prod build), only chunks that have **stopped
shipping** for >14 days age out. Residual: a tab whose build has been fully
superseded for >14 days and only then lazily imports a now-evicted chunk falls
back to the shipped reload — an accepted rare case inherent to a 14-day window.

### 5. Interplay with the shipped reload (#1364)

Unchanged. Retention removes ~all reloads; the reload path remains the
last-resort fallback for (a) the >14-day-superseded gap, (b) an R2 outage/miss,
or (c) a breaking client↔backend protocol change where the tab _should_ migrate.
No client code changes in this project.

## Data flow

```
Deploy:  build webapp → dist/ui/assets/*
   → 25 MiB dry-run gate → R2 upload loop (re-put ALL, retries) → env bucket
   → [only on upload success] wrangler deploy (current build → ASSETS + index.html)

Weekly (prod): checkout main → build → R2 upload loop → prod bucket (touch live build)

Request GET/HEAD /assets/<hash>.<ext>:
  worker → env.ASSETS.fetch()
     ├─ 200 non-HTML  → return (current build, fast path)
     └─ SPA shell     → Cache API match (canonical GET key)
             ├─ cached → return
             └─ miss   → env.ASSET_ARCHIVE.get(key, {onlyIf, range})
                     ├─ 200 full   → build response (ETag/Length/Accept-Ranges/immutable), cache.put, return
                     ├─ 206/304/HEAD → build response, DO NOT cache
                     └─ archive miss/error → return SPA shell (client reload fallback, as today)
```

## Error handling

- `env.ASSET_ARCHIVE.get()`/`head()` failure/exception → treat as miss (return
  the SPA shell); never 500 an asset request. Retention is best-effort; the
  reload fallback is the safety net.
- CI upload failure → **fail the deploy job before `wrangler deploy`** (retries
  first). An unarchived live build silently reintroduces the crash for the next
  deploy's tabs.
- Content-type absent on an archived object → derive from extension; last resort
  `application/octet-stream`.

## Testing

- **Worker unit** (`packages/cloudflare-worker/tests/index.test.ts`): mock
  `env.ASSETS` (real-asset vs SPA-shell) and `env.ASSET_ARCHIVE` (R2 `.get`/
  `.head` with `writeHttpMetadata`, `httpEtag`, `size`, `range`, `onlyIf`).
  Cases: `/assets` hit passes through untouched; `/assets` miss + archive hit →
  200 with correct `Content-Type`/`ETag`/`Content-Length`/`Accept-Ranges`/
  immutable `Cache-Control`; **HEAD** (no body); **Range** → 206 + `Content-Range`
  (and 416 for unsatisfiable); **conditional** (`If-None-Match`/
  `If-Modified-Since`) → 304; `/assets` miss + archive miss → SPA shell (no
  regression); non-`/assets` and non-asset-extension paths never consult R2; key
  derivation rejects `..`/backslash/encoded-slash/empty; **Cache API** puts only
  full 200 GETs under the canonical key and never caches miss/shell/206/304/HEAD.
- **Deployed smoke** (`packages/cloudflare-worker/tests/deployed.test.ts`):
  upload a synthetic **non-ASSETS** object `assets/r2-retention-smoke-<hash>.js`
  to the staging bucket, then fetch it **through the worker** and assert 200 +
  JS `Content-Type` + `ETag` + a working `HEAD`; and that a genuinely unknown
  non-asset path still returns the SPA HTML. (Route-mirror rule: index.ts
  routing changes update `index.test.ts` **and** `deployed.test.ts`.)
- **Upload script**: unit-test MIME derivation, the re-put-all (no skip)
  behavior, and retry/bounded-concurrency logic.
- Coverage kept at/above the cloudflare-worker floor.

## Out of scope

- The chrome-extension's **own** bundled assets (extension-update path — #1406
  part (c): `chrome.runtime.onUpdateAvailable` → reload leader tab + SW reload).
- Changing the shipped `setup-preload-error-reload` recovery (kept as fallback).
- SPA-HTML `Cache-Control` hardening (a separately-deferred #1330 item).
- Client-side service-worker precache (rejected alternative).
- The preview worker (no ASSETS; no binding).

## Decisions (locked)

| Decision         | Choice                                                                                                               |
| ---------------- | -------------------------------------------------------------------------------------------------------------------- |
| Primary strategy | Server-side R2 asset retention (root-cause fix)                                                                      |
| Serving          | ASSETS-first, R2-on-miss (live site independent of R2)                                                               |
| HTTP semantics   | Full builder: HEAD/Range(206/416)/conditional(304)/ETag/Length/Accept-Ranges via R2 metadata                         |
| Edge cache       | Cache API: full-200-GET only, canonical GET key, never miss/shell/206/304/HEAD                                       |
| GC               | ~14-day age-based R2 lifecycle + weekly scheduled touch of the live prod build                                       |
| Upload           | `wrangler r2 object put` loop, re-put ALL (no skip), parallel + retries, before deploy; CF token needs R2 Object R/W |
| Deploy ordering  | build → dry-run gate → R2 upload → (on success) deploy; hard-stop on upload failure                                  |
| Buckets          | Separate per env (`slicc-asset-archive`, `…-staging`); preview worker excluded                                       |
| Reload (#1364)   | Retained as rare last-resort fallback, unchanged                                                                     |
