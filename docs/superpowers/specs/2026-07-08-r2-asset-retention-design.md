# R2 Asset Retention — Design

**Status:** design (brainstorming output)
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
file that has ever been deployed available on the server, so a long-lived tab
can keep fetching **its own build's** chunks after a new deploy — no crash, no
reload, no interruption, and the tab stays internally consistent (it moves to
the new build only on a natural, user-initiated reload). The shipped reload
becomes a rare last-resort fallback.

## Key insight: content hash = identity

Every `/assets/*` filename **is** a hash of its bytes. The same filename can
only ever mean the same content. Therefore the archive is a **flat, idempotent
key→bytes store** — no version/release grouping is needed. Re-uploading an
unchanged chunk on a later deploy is a no-op (same key, same bytes). Only
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

Two moving parts: (1) the worker serves archived assets on a miss; (2) CI
uploads each deploy's assets into the archive.

### 1. Serving — ASSETS-first, R2-on-miss (worker)

Insertion point: `packages/cloudflare-worker/src/index.ts` — the `serveSPA`
helper (`:129-158`) and the SPA-fallback dispatch (`:412-417`).

For a request whose path is under **`/assets/`**:

1. `res = await env.ASSETS.fetch(request)` — the current build's asset, if
   present (unchanged hot path).
2. If `res` is a **real asset** (its `Content-Type` is **not** `text/html`),
   return it as today. This is the common case; the current build never depends
   on R2.
3. If `res` is the **SPA shell** (`Content-Type` includes `text/html` for an
   `/assets/*` path ⇒ the asset is gone on this deploy), treat it as a **miss**:
   - `obj = await env.ASSET_ARCHIVE.get(key)` where `key` is the path minus the
     leading `/` (e.g. `assets/anthropic-messages-DP3-Xd3J.js`).
   - **Hit:** return `new Response(obj.body, …)` with `Content-Type` from
     `obj.httpMetadata.contentType` (set at upload; fall back to an
     extension-derived MIME) and `Cache-Control: public, max-age=31536000,
immutable`. Cache the response at the edge via the Cache API (immutable, so
     safe to cache indefinitely) so subsequent hits skip R2.
   - **Miss:** return the SPA shell exactly as today (200 `text/html`) so the
     client's shipped `setup-preload-error-reload` recovery still fires. **No
     behavior regression** when the archive lacks the chunk.

Rationale for ASSETS-first (vs R2-first for all `/assets`): the live site keeps
being served by the platform, so an R2 outage degrades only _old_ tabs (they
fall back to reload) rather than taking the whole site down. The only added
latency is on _old-build_ chunk requests, which are rare and edge-cached after
the first hit.

Only `/assets/` is intercepted. Navigations, `index.html`, SW scripts, the
`?cherry=1` / electron / `/cloud` SPA-shell variants (which set their own
headers) are untouched.

### 2. Population — CI upload at deploy (`wrangler r2 object put` loop)

After the webapp is built (`dist/ui/assets/` populated), each worker deploy
uploads that build's assets into the env's archive bucket via a loop of
`wrangler r2 object put <bucket>/assets/<file> --file <path> --content-type
<mime> [--remote]`. The loop is **parallelized** (bounded concurrency) and
**skips objects that already exist** (idempotent; unchanged hashes are not
re-put) to keep CI time bounded. `--content-type` is derived from the file
extension in the upload script so the worker can read `httpMetadata.contentType`
on serve.

Wire the upload step into the three deploy paths (after the webapp build, before
/ alongside `wrangler deploy`):

- `.github/workflows/ci.yml` — `cloudflare-worker` job (staging) → staging
  bucket.
- `.github/workflows/worker-staging.yml` (staging) → staging bucket.
- `.github/workflows/worker.yml` (production, `workflow_dispatch`) → prod bucket.

Uses the existing Cloudflare API token (wrangler auth) — **no new credential
surface** (S3 access keys avoided by design).

### 3. Buckets & bindings

Two R2 buckets (separate per env so staging's high churn never mixes into prod):

- `slicc-asset-archive` (production)
- `slicc-asset-archive-staging` (staging)

`wrangler.jsonc`: add an `r2_buckets` binding `ASSET_ARCHIVE` at the top level
(→ `slicc-asset-archive`) and duplicated in `env.staging` (→
`slicc-asset-archive-staging`), mirroring how `assets` and the DO bindings are
already duplicated per env. This is the **first R2 binding** in the repo.

### 4. GC — ~14-day age-based lifecycle

An R2 lifecycle rule deletes objects whose last-modified is older than **14
days**. Because every deploy re-puts (touches) the still-current chunks, only
chunks that have **stopped shipping** age out. A tab left open longer than ~14
days past its build's last deploy will find its unique chunks GC'd and fall back
to the shipped reload — an acceptable rare case. Applied to both buckets
(staging can GC more aggressively if desired, but 14d is fine for both).

### 5. Interplay with the shipped reload (#1364)

Unchanged. Retention removes ~all reloads; the reload path remains the
last-resort fallback for (a) the ~14-day-plus gap, (b) an R2 outage, or (c) a
breaking client↔backend protocol change where the tab _should_ migrate to the
new build. No client code changes in this project.

## Data flow

```
Deploy:  build webapp → dist/ui/assets/*  →  (CI) wrangler r2 object put loop
             → ASSET_ARCHIVE bucket (flat, hash-keyed, idempotent)
             → wrangler deploy (current build → ASSETS + index.html)

Request /assets/<hash>.js:
  worker → env.ASSETS.fetch()
     ├─ real asset (non-HTML)  → return (current build, fast path)
     └─ SPA shell (text/html)  → env.ASSET_ARCHIVE.get(assets/<hash>.js)
             ├─ hit  → serve archived bytes, immutable cache, edge-cache
             └─ miss → return SPA shell (client reload fallback, as today)
```

## Error handling

- `env.ASSET_ARCHIVE.get()` failure/exception → treat as miss (return SPA
  shell); never 500 the asset request. Retention is best-effort; the reload
  fallback is the safety net.
- CI upload failure → fail the deploy step visibly (a deploy that didn't archive
  its assets would silently reintroduce the crash for the _next_ deploy's
  orphaned tabs). Uploads run with retries.
- Content-type absent on an archived object → derive from extension; default to
  `application/octet-stream` only as a last resort.

## Testing

- **Worker unit** (`packages/cloudflare-worker/tests/index.test.ts`): `/assets`
  hit passes through ASSETS untouched; `/assets` miss with archive hit serves
  archived bytes + immutable `Cache-Control` + correct `Content-Type`; `/assets`
  miss with archive miss returns the SPA shell (no regression); non-`/assets`
  paths never consult R2. Mock `env.ASSET_ARCHIVE` (R2 `.get`) and `env.ASSETS`.
- **Deployed smoke** (`packages/cloudflare-worker/tests/deployed.test.ts`): a
  known current-build asset resolves; the SPA fallback still serves HTML for a
  genuinely unknown non-asset path. (Route-table mirror rule: any change to the
  `index.ts` routing must update `index.test.ts` **and** `deployed.test.ts`.)
- **Upload script**: unit-test MIME derivation + the skip-if-exists / bounded
  concurrency logic.
- Coverage kept at/above the cloudflare-worker floor.

## Out of scope

- The chrome-extension's **own** bundled assets (extension-update path — that is
  #1406 part (c), a separate concern: `chrome.runtime.onUpdateAvailable` →
  reload leader tab + SW reload).
- Changing the shipped `setup-preload-error-reload` recovery (kept as fallback).
- SPA-HTML `Cache-Control` hardening (a separately-deferred #1330 item; can be
  folded in later but not required here).
- Client-side service-worker precache (the alternative "keep versions
  client-side" approach — not chosen).

## Decisions (locked)

| Decision         | Choice                                                                       |
| ---------------- | ---------------------------------------------------------------------------- |
| Primary strategy | Server-side R2 asset retention (root-cause fix)                              |
| Serving          | ASSETS-first, R2-on-miss (resilience: live site independent of R2)           |
| GC               | ~14-day age-based R2 lifecycle                                               |
| Buckets          | Separate per env (`slicc-asset-archive`, `…-staging`)                        |
| Upload           | `wrangler r2 object put` loop (parallel + skip-if-exists), existing CF token |
| Reload (#1364)   | Retained as rare last-resort fallback, unchanged                             |
