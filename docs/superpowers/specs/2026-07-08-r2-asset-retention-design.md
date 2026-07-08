# R2 Asset Retention — Design

**Status:** design (brainstorming output; codex rounds 1–2 applied)
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

Two moving parts: (1) the worker serves archived assets on a miss; (2) every
deploy uploads its assets to the archive **before** going live.

### 1. Serving — ASSETS-first, R2-on-miss (worker)

Insertion point: `packages/cloudflare-worker/src/index.ts` — a dedicated
`serveAssetWithArchiveFallback(request, env, ctx)` invoked from the top-level
dispatch **before** the `wantsJSON` SPA/JSON split (`~:412`), so that even
`/assets/foo.js?json=true` is handled here rather than routed to the API index.

**Asset-path gate (strict regex — also the anti-traversal guard).** Handle the
request here only if `request.method` is `GET`/`HEAD` and the raw
`url.pathname` matches a strict Vite-asset pattern:

```
^/assets/[A-Za-z0-9][A-Za-z0-9._-]*\.(js|mjs|css|map|wasm|woff2|woff|ttf|svg|png|jpg|jpeg|gif|webp|avif|ico|json)$
```

Because the class excludes `/`, `%`, `\`, `..` segments and null bytes, a
matching path is inherently traversal-safe; anything else falls through to
today's behavior untouched. **The R2 key is the matched `url.pathname` minus the
leading `/`** (e.g. `assets/anthropic-messages-DP3-Xd3J.js`) — no decoding step,
so it always equals the upload key. Query string is ignored for key and cache.

**Miss detection (narrow).** `res = await env.ASSETS.fetch(request)`. Treat as a
miss **only** when `res.status === 200` **and** its `Content-Type` contains
`text/html` (the SPA shell standing in for a gone hashed asset). **Every other
ASSETS response — 200 non-HTML, 206, 304, 404, etc. — is returned unchanged**
(ASSETS may legitimately answer 206/304 for a present asset under Range/
conditional requests). On a miss, serve from the archive; on archive miss or any
R2 error, return the original `res` (the SPA shell) exactly as today so the
shipped `setup-preload-error-reload` recovery still fires — **no regression**.

**Response builder (per-status, from R2 metadata).** Use the R2 Workers API:

- `obj = await env.ASSET_ARCHIVE.get(key, { onlyIf: request.headers, range:
request.headers })`.
- **Conditional not-modified:** `obj` present but `obj.body == null` ⇒ `304`
  with `ETag`/`Last-Modified`, **no `Content-Length`**, no body.
- **HEAD:** headers only (full `Content-Length: obj.size`), empty body.
- **Range hit:** `obj.range` set ⇒ `206` with `Content-Range: bytes
<start>-<end>/<size>` and `Content-Length` = **selected range length**.
- **Unsatisfiable range:** `416` with `Content-Range: bytes */<size>`, no body.
- **Full GET:** `200`, `Content-Length: obj.size`, body.
- **Common headers:** `obj.writeHttpMetadata(headers)` (stored `Content-Type`;
  fall back to the extension→MIME map below), `ETag: obj.httpEtag`,
  `Accept-Ranges: bytes`, `Last-Modified`, `Cache-Control: public,
max-age=31536000, immutable`. Do **not** copy SPA-shell CSP headers onto asset
  responses.
- **MIME map (fallback when metadata absent):** `.js`/`.mjs`→`text/javascript`,
  `.css`→`text/css`, `.json`/`.map`→`application/json`, `.wasm`→
  `application/wasm`, `.svg`→`image/svg+xml`, `.woff2`→`font/woff2`,
  `.woff`→`font/woff`, `.ttf`→`font/ttf`, `.png`→`image/png`,
  `.jpg`/`.jpeg`→`image/jpeg`, `.gif`→`image/gif`, `.webp`→`image/webp`,
  `.avif`→`image/avif`, `.ico`→`image/x-icon`. Correct JS/MJS MIME is critical
  (a wrong type re-creates the module-load failure).
- **Compression:** serve raw bytes; Cloudflare's edge auto-compresses eligible
  types to the client — we do not store/negotiate encodings.

**Edge cache (Cache API), poison-safe.** Consult and populate the Cache API
**only for a plain `GET` with no `Range` and no conditional headers**
(`If-None-Match`/`If-Modified-Since`); `HEAD`, `Range`, and conditional requests
**bypass the cache entirely** and go straight to R2 (so a cached full-200 can
never be returned for them). Cache **only** a successful **full-body 200**, under
a **canonical GET cache key** (scheme+host+`/assets/<file>`, query dropped),
cloning before `cache.put`. Never cache a miss, the SPA shell, `206`, `304`, or
`HEAD`. Responses are `immutable`, so indefinite edge caching is safe.

Rationale for ASSETS-first: the live site is served by the platform, so an R2
outage degrades only _old_ tabs (they fall back to reload) rather than the whole
site. Added latency is only on _old-build_ requests, rare and edge-cached after
first hit. Navigations, `index.html`, SW scripts, and the `?cherry=1` / electron
/ `/cloud` SPA-shell variants are untouched.

### 2. Population — upload assets to R2 at every deploy

A single reusable script — `packages/cloudflare-worker/scripts/upload-assets-to-r2.sh <bucket>` —
loops over `dist/ui/assets/*` and runs, with bounded-concurrency parallelism and
per-file retries:

```
wrangler r2 object put <bucket>/assets/<file> --file <path> --content-type <mime> --remote
```

deriving `--content-type` from the extension (same MIME map as §1). It **re-puts
the current build's full asset set every deploy — it does NOT skip existing
keys** (a PUT refreshes `last-modified`, which the age-based GC in §3 relies on
to keep still-shipping chunks alive; re-putting is content-idempotent, so the
only cost is CI time, bounded by the parallelism).

**Ordering is strict everywhere: build webapp → 25 MiB dry-run gate → run the
upload script (retries) → only on success run the real `wrangler deploy`.** A
build must never go live unarchived (that would orphan the _next_ deploy's tabs),
so the upload step **hard-stops the deploy on failure**.

Wire the script into **all four** deploy paths that run `wrangler deploy`:

- **Automated production** — `.releaserc.json` → `npm run publish:worker` →
  `packages/cloudflare-worker/scripts/publish-worker.sh` (its `wrangler deploy`
  is the real prod deploy). Insert the upload before that deploy, targeting the
  **prod** bucket, using the already-built `dist/ui/assets`.
- **Manual production** — `.github/workflows/worker.yml` (`workflow_dispatch`) →
  prod bucket.
- **Staging (CI)** — `.github/workflows/ci.yml` `cloudflare-worker` job → staging
  bucket.
- **Staging (dedicated)** — `.github/workflows/worker-staging.yml` → staging
  bucket.

**Auth (explicit).** The upload runs as a plain `run:` step / shell script, so
it must have `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in its
environment (mirroring `.github/workflows/storybook-screenshots.yml`). **The API
token must carry R2 "Object Read & Write" for both buckets** — an ops
prerequisite documented with the feature (the existing deploy token likely needs
this scope added).

### 3. Buckets, bindings & GC

Two R2 buckets (separate per env so staging's high churn never mixes into prod):
`slicc-asset-archive` (prod) and `slicc-asset-archive-staging`.

`wrangler.jsonc`: add an `r2_buckets` binding `ASSET_ARCHIVE` at the top level
(→ `slicc-asset-archive`) and duplicated in `env.staging` (→
`slicc-asset-archive-staging`), mirroring how `assets`/DO bindings are already
duplicated per env (env configs do **not** inherit top-level bindings). This is
the **first R2 binding** in the repo. The **preview worker**
(`wrangler-preview.jsonc`, no ASSETS) does **not** need it.

**GC:** an R2 **object-lifecycle rule** on each bucket deletes objects whose
`last-modified` is older than **14 days**. Because every deploy re-puts the
current set (§2), a chunk's clock resets on each deploy it ships in; only chunks
that have **stopped shipping** age out ~14 days later.

**Accepted residual (no touch job).** The only gap is a **release drought**: if
production does not deploy for >14 days, the live build's chunks age out of R2
while still current, and the next deploy would then serve the SPA shell for a
just-superseded chunk → the tab falls back to the **shipped #1364 reload**. This
is rare in an active repo (semantic-release deploys prod on merges to main) and
is the same graceful degradation the 14-day window already implies for
long-idle tabs. A scheduled "touch" job was considered and rejected: a rebuild
injects `SLICC_RELEASED_AT`/version defines and can produce different hashes, so
it would not reliably touch the deployed keys — adding fragility for a rare case
the reload already covers. (If droughts become common, revisit with a
manifest-driven touch that re-puts exact deployed keys, or widen the window.)

### 4. Interplay with the shipped reload (#1364)

Unchanged. Retention removes ~all reloads; the reload path remains the
last-resort fallback for (a) a >14-day release drought, (b) an R2 outage/miss, or
(c) a breaking client↔backend protocol change where the tab _should_ migrate. No
client code changes in this project.

## Data flow

```
Deploy (each path): build webapp → dist/ui/assets/*
   → 25 MiB dry-run gate → upload-assets-to-r2.sh <bucket> (re-put ALL, retries)
   → [only on upload success] wrangler deploy (current build → ASSETS + index.html)

Request GET/HEAD /assets/<hash>.<ext>  (strict regex gate, else fall through):
  worker → env.ASSETS.fetch()
     ├─ NOT (200 text/html)  → return unchanged (present asset: 200 non-HTML / 206 / 304 / 404)
     └─ 200 text/html (miss) →
          plain GET (no Range/conditional)? → Cache API match (canonical key)
             ├─ cached → return
             └─ miss   → R2 get → cache full-200 → return
          HEAD / Range / conditional?        → R2 get (bypass cache)
             ├─ 200 full / 206 / 304 / 416 (per-status headers) → return (do NOT cache)
             └─ archive miss / R2 error       → return SPA shell (reload fallback, as today)
```

## Error handling

- `env.ASSET_ARCHIVE.get()` failure/exception → treat as miss (return the SPA
  shell); never 500 an asset request.
- Upload-script failure → **fail the deploy before `wrangler deploy`** (after
  retries).
- Content-type absent on an archived object → derive from the MIME map; last
  resort `application/octet-stream`.

## Testing

- **Worker unit** (`packages/cloudflare-worker/tests/index.test.ts`): mock
  `env.ASSETS` and `env.ASSET_ARCHIVE`. Cases: present asset (ASSETS 200
  non-HTML / 206 / 304 / 404) returned unchanged, never consulting R2; miss
  (200 text/html) + archive hit → 200 with correct MIME/`ETag`/`Content-Length`/
  `Accept-Ranges`/immutable `Cache-Control`; **HEAD** (headers, no body);
  **Range** → 206 + `Content-Range` + range-length `Content-Length`;
  unsatisfiable → 416; **conditional** → 304 with validators and no
  `Content-Length`; miss + archive miss → SPA shell (no regression); strict
  regex gate rejects non-asset/traversal/encoded paths and `POST`; **Cache API**
  populated/consulted only for plain GET, and Range/HEAD/conditional bypass it
  (a prior cached full-200 is never returned for them).
- **Deployed smoke** (`packages/cloudflare-worker/tests/deployed.test.ts`):
  upload a synthetic **non-ASSETS** `assets/r2-retention-smoke-<hash>.js` to the
  staging bucket, then through the worker assert: full `GET` 200 + JS
  `Content-Type` + `ETag`; `HEAD`; a `Range` request → 206; `If-None-Match` with
  the returned `ETag` → 304; a cache-hit-after-full-GET followed by a `Range`/
  conditional still behaves correctly; an unknown `assets/<hash>.js` archive miss
  → SPA HTML; and a genuinely unknown non-asset path → SPA HTML. (Route-mirror
  rule: index.ts routing changes update `index.test.ts` **and**
  `deployed.test.ts`.)
- **Upload script**: unit-test MIME derivation, re-put-all (no skip), and
  retry/bounded-concurrency logic.
- Coverage kept at/above the cloudflare-worker floor.

## Out of scope

- The chrome-extension's **own** bundled assets (#1406 part (c):
  `chrome.runtime.onUpdateAvailable` → reload leader tab + SW reload).
- Changing the shipped `setup-preload-error-reload` recovery (kept as fallback).
- SPA-HTML `Cache-Control` hardening (separately-deferred #1330 item).
- Client-side service-worker precache (rejected alternative).
- The preview worker (no ASSETS; no binding).
- A scheduled touch job (rejected — see §3 residual).

## Decisions (locked)

| Decision         | Choice                                                                                                                          |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Primary strategy | Server-side R2 asset retention (root-cause fix)                                                                                 |
| Serving          | ASSETS-first, R2-on-miss (miss = only `200 text/html` on a strict-regex `/assets/*` path)                                       |
| HTTP semantics   | Per-status builder: HEAD / Range(206/416) / conditional(304) / ETag / per-status Content-Length / Accept-Ranges via R2 metadata |
| Edge cache       | Cache API: plain-GET only (Range/HEAD/conditional bypass); cache full-200 under canonical GET key                               |
| GC               | 14-day age-based R2 lifecycle; re-put ALL on every deploy; **no touch job** (drought → reload fallback)                         |
| Upload           | Reusable `upload-assets-to-r2.sh`; re-put ALL (no skip), parallel + retries, before deploy; CF token needs R2 Object R/W        |
| Deploy paths     | publish-worker.sh (auto prod) + worker.yml (manual prod) + ci.yml + worker-staging.yml; hard-stop on upload failure             |
| Buckets          | Separate per env (`slicc-asset-archive`, `…-staging`); preview worker excluded                                                  |
| Reload (#1364)   | Retained as rare last-resort fallback, unchanged                                                                                |
