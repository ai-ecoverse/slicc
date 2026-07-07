# Stale-asset recovery after deploy (issue #1330)

**Date:** 2026-07-07
**Issue:** [#1330](https://github.com/ai-ecoverse/slicc/issues/1330) — "Cloud cone crashes on stale assets after deploy"
**Scope:** `packages/webapp` only. Two trigger sites + one shared page-side guarded reload + tests + docs.

> **Revision note (post-review).** A Codex review of the first draft found a
> **blocker**: the exact failure in #1330 (`anthropic-*.js`) is a **worker-side**
> dynamic import, which never dispatches `vite:preloadError` on `window`, so a
> page-only handler would not fix the reported crash. Verified against the build.
> The design below adds a worker-side trigger. Two scope calls were made while
> the requester was away (both revisitable): (1) cover **both** page- and
> worker-owned lazy-import failures; (2) stay **webapp-only** and rely on
> `location.reload()`'s top-document revalidation for fresh HTML rather than
> adding a worker `Cache-Control` header (deferred — see Out of scope).

## Problem

When a new build is deployed while a long-lived sliccy.ai UI tab is open, a
subsequent lazy `import()` of a Vite chunk whose content-hash changed on the
deploy fails, and the session becomes unrecoverable:

```
Something went wrong
Scoop "Cone" failed after 3 attempts: Failed to fetch dynamically imported
module: https://www.sliccy.ai/assets/anthropic-BOEkIcb-.js
```

This is **not** cloud-cone-specific. It hits **any** long-lived tab that spans a
deploy:

- the **cloud cone** (its UI runs in a headless browser inside the e2b sandbox,
  loading the same webapp from sliccy.ai),
- the **extension's pinned leader tab** (long-lived by design),
- the **extension side-panel follower** (a side-panel-only user has no obvious
  "reload" and won't know to hard-refresh),
- any open **standalone** tab.

## Root cause (verified against `main`)

1. **The running tab/worker holds an old module graph.** After a deploy the CDN
   no longer serves the old content-hashed chunk names, so a lazy `import()` for
   a now-gone chunk fails. The browser's module map caches that failure, so
   retrying the same `import()` re-rejects — only a reload recovers.
2. **The worker's SPA fallback masks the 404.** The `assets` binding in
   `packages/cloudflare-worker/wrangler.jsonc` uses
   `not_found_handling: "single-page-application"`, so a request for a gone
   `/assets/*.js` returns **`index.html` as `200 text/html`**, not a 404. The
   `import()` therefore rejects with a MIME/parse error ("Expected a JavaScript
   module … MIME type of text/html"). A `/assets/*` request can never cleanly
   404 today. (Left as-is this PR — see Out of scope.)
3. **The failing import is usually worker-owned, and the worker has no
   `vite:preloadError`.** `kernel-worker.ts` calls `registerProviders()` →
   `providers/index.ts` uses lazy `import.meta.glob`, so provider chunks
   (`anthropic-*.js`, etc.) are dynamically imported **inside the kernel
   worker** during a cone/scoop turn. Verified: the built `kernel-worker-*.js`
   chunk contains **zero** `preloadError` occurrences — Vite only injects the
   `__vitePreload` helper (which dispatches the cancelable `vite:preloadError`
   event) into the **page** bundle, not worker builds. So a `window` listener
   cannot see the worker's import failures.
4. **Worker import failures are currently retried 3× then surfaced as fatal.**
   `scoop-context.ts:isRetryableError` matches `failed to fetch`
   (line ~146), so "Failed to fetch dynamically imported module" is classified
   retryable → 3 futile retries (the module map has cached the failure) → the
   fatal "Scoop … failed after 3 attempts" message in the issue.
5. **Nothing recovers an already-open tab.** There is **no `vite:preloadError`
   handler anywhere** in the webapp (grep-verified), and
   `scoops/upgrade-detection.ts` only compares the bundled version to the
   last-seen version **at boot**, so it never helps a tab already running when
   the deploy lands.

Vite's `__vitePreload` dispatches a cancelable `vite:preloadError` on `window`
when a **page-owned** dynamic import rejects (including the MIME/parse rejection
from the `200 text/html` fallback), and re-throws unless `preventDefault()` is
called. That covers page-owned lazy chunks (settings dialog, dips, mount
branches). Worker-owned failures need a separate detection path that reaches the
page (which owns `location.reload()`).

## Scope decisions

- **Two triggers, one recovery.** Both a page-owned `vite:preloadError` and a
  worker-owned dynamic-import failure funnel into the **same** guarded
  page-reload. The worker trigger is what actually fixes #1330; the page trigger
  covers page-owned lazy chunks.
- **`location.reload()` runs in the page realm.** `ui/main.ts` executes in the
  real browsing context of every float; the kernel worker cannot reload itself
  (no `location`) so it **broadcasts** a reload request to the page — the same
  worker→page pattern the existing `nuke-reload` already uses
  (`shell/supplemental-commands/nuke-channel.ts`).
- **Uniform across floats, including the cloud cone.** A page reload re-fetches a
  fresh `index.html` + module graph, re-boots the kernel worker, rejoins the
  tray, and resumes from OPFS. No `cloud-core` / auto-restart plumbing (issue
  solution #2 is unnecessary). Topology check: the extension side-panel follower
  has no kernel worker, so it recovers via the page trigger only; the leader tab
  / standalone / cloud each have a kernel worker and use both triggers.
- **Webapp-only; rely on reload revalidation for fresh HTML.** Recovery needs the
  reload to fetch a _new_ `index.html`. The default (non-cherry/non-electron) SPA
  response sets no explicit `Cache-Control`, but `location.reload()` forces
  top-document revalidation in all major browsers (conditional GET → 200 with the
  new build's HTML when the ETag changed), and the cherry side-panel response is
  already `no-store`. A worker `Cache-Control: no-cache` on the SPA HTML is a
  possible robustness follow-up (Out of scope), not required for correctness.

## Design

### Shared channel + detection — `packages/webapp/src/ui/boot/stale-asset-channel.ts`

Shell-free and realm-agnostic (no `window`/`document` at module scope; only
`BroadcastChannel`, which exists in both page and DedicatedWorker), so the kernel
worker can import the detection + broadcast without pulling DOM code — mirroring
how `nuke-channel.ts` is split out of `nuke-command.ts`.

- **`isDynamicImportError(msg: string): boolean`** — matches the cross-browser
  dynamic-import-failure family:
  - Chromium: `Failed to fetch dynamically imported module`
  - Firefox: `error loading dynamically imported module`
  - WebKit: `Importing a module script failed`
- **`STALE_ASSET_RELOAD_CHANNEL = 'slicc-stale-asset-reload'`** and the wire type
  `{ type: 'stale-asset-reload' }` (no payload — unlike nuke it clears no
  storage).
- **`broadcastStaleAssetReload(): void`** — posts the message on the channel
  (no-op if `BroadcastChannel` is unavailable). Called from the worker realm.
- **`installStaleAssetReloadListener(onReload: () => void): () => void`** —
  page-side channel listener; returns a disposer.

### Shared guarded reload + page trigger — `packages/webapp/src/ui/boot/setup-preload-error-reload.ts`

Sibling to `setup-nuke-reload-listener.ts`. Owns the one guarded-reload function
that **both** triggers call.

- **`decideStaleReload(lastReloadAt: number | null, now: number, windowMs: number): boolean`**
  — pure guard: reload iff `lastReloadAt === null || now - lastReloadAt >= windowMs`.
- **`setupPreloadErrorReload(deps?): void`** — deps injectable for tests, default
  to production:
  - `reload` → `() => window.location.reload()`
  - `storage: Pick<Storage,'getItem'|'setItem'>` → `window.sessionStorage`
  - `now` → `() => Date.now()`
  - `windowMs` → `RELOAD_WINDOW_MS` constant (**20_000**)
  - `storageKey` → `'slicc:stale-asset-reloaded-at'`

  It:
  1. Defines `guardedReload()`:
     - Read `lastReloadAt` from storage; **on any storage read/write throw,
       return without reloading (fail-closed)** — we must never reload when we
       cannot persist the guard, or a broken deploy could loop.
     - If `decideStaleReload(...)` is `false` (reloaded within the window),
       return — let the underlying error surface to the existing "Something went
       wrong" + retry UI. Returns whether it will reload.
     - Else `storage.setItem(key, String(now))` then `reload()`.
  2. Registers `window.addEventListener('vite:preloadError', e => { if (guardedReload()) e.preventDefault(); })`
     — `preventDefault()` only when we actually reload, so a suppressed
     (guard-blocked) error still propagates.
  3. Calls `installStaleAssetReloadListener(guardedReload)` so a worker broadcast
     runs the identical guarded reload.

### Guard rationale (timestamp, not version)

`__SLICC_VERSION__` only bumps on a semver **release**; PR-merge / manual /
staging deploys rebuild `dist/ui` with new chunk hashes at the **same** version,
so a version-keyed guard would wrongly suppress a legitimate second reload across
those deploys. A **timestamp window** ("reload at most once per 20 s per tab") is
causally correct: a reload that fixes the tab produces no further errors; a
reload that does **not** fix it (broken/mid-propagation deploy) re-errors within
the window → suppressed → error surfaces (no loop); a genuinely new deploy
minutes/hours later is past the window → reload allowed. `sessionStorage` is the
right lifetime (per-tab, survives the reload, clears on tab close).

### Worker trigger — `packages/webapp/src/scoops/scoop-context.ts`

In the turn-error classification (where `isRetryableError` / `isNonRetryableError`
are consulted), check `isDynamicImportError(msg)` **first**:

- treat it as **non-retryable** (retrying a cached-failed `import()` is futile
  and would burn the 3 attempts + backoff before recovery), and
- call `broadcastStaleAssetReload()` so the owning page performs the guarded
  reload.

This runs for the cone and every scoop (shared classifier). `BroadcastChannel`
in the kernel worker reaches the same-origin page (leader tab / standalone /
in-sandbox), exactly as `nuke-channel` already broadcasts worker→page.

### Registration — `packages/webapp/src/ui/main.ts`

Call `setupPreloadErrorReload()` as the **first statement inside `main()`**,
before the fixture check and any dynamic `import()`, so both the page listener
and the broadcast listener are installed before any lazy chunk can be requested.
It runs once per page-owning float via the shared entry (standalone, extension
leader + side-panel follower, cloud-in-sandbox); the `?ui-fixture` surface exits
before boot and is unaffected, matching `setupNukeReloadListener`'s placement.

## Testing

`packages/webapp/tests/ui/boot/stale-asset-channel.test.ts`:

- `isDynamicImportError` matrix: the three browser strings → `true`; unrelated
  errors (`401`, `rate limit`, `network error`) → `false`.
- `broadcastStaleAssetReload` posts the message; `installStaleAssetReloadListener`
  invokes `onReload` on receipt and the disposer detaches.

`packages/webapp/tests/ui/boot/setup-preload-error-reload.test.ts` (jsdom;
inject `reload`/`storage`/`now` — jsdom's `location.reload` throws "Not
implemented"):

- **Guard matrix** (`decideStaleReload`): no prior → `true`; within window →
  `false`; past window → `true`.
- **Page trigger**: first `vite:preloadError` → `reload` once + flag written +
  `preventDefault` called; a second dispatch within the window → no `reload`, no
  `preventDefault`; a dispatch past the window → `reload` again.
- **Worker trigger**: a `stale-asset-reload` broadcast → same guarded `reload`.
- **Fail-closed**: a `storage.getItem`/`setItem` that throws → handler does
  **not** reload and does **not** throw.

`packages/webapp/tests/scoops/scoop-context.test.ts` (extend existing):

- `isDynamicImportError` is consulted before `isRetryableError` for a "Failed to
  fetch dynamically imported module" message (classified non-retryable), and the
  broadcast fires. (Assert via the injected/spied broadcast seam.)

## Docs

- `packages/webapp/CLAUDE.md` — a "Stale-asset recovery" note (boot/UI section)
  describing the two triggers, the shared timestamp-guarded reload, and the
  worker→page broadcast.
- `docs/pitfalls.md` — short entry: long-lived tabs + content-hashed chunks + the
  worker's SPA-fallback-returns-HTML behavior + the worker-vs-page
  `vite:preloadError` gap, and how the two triggers recover.
- Close #1330 referencing the PR.

## Out of scope (possible follow-ups)

- **Worker `Cache-Control: no-cache` on the SPA HTML.** Would make "reload fetches
  fresh `index.html`" an explicit server guarantee instead of relying on browser
  reload-revalidation. Deferred to keep this PR webapp-only; revisit if testing
  shows a reload that doesn't pick up the new build.
- **Server-side clean 404 for `/assets/*`.** A real 404 (instead of the SPA
  `index.html`) for a missing hashed chunk would fail fast + clean. Defense in
  depth in a different package; not required for either trigger.
- **Cloud-cone auto-restart** (issue solution #2). Unnecessary given the uniform
  page reload recovers the in-sandbox browser too.

## Limitations (stated)

- Recovers a tab/worker that is **already running** when the deploy lands. A page
  whose **initial entry graph** can't evaluate (entry chunk itself gone before
  `main()` runs) can't install the handler — but the first load fetches entry
  chunks fresh with `index.html`, so that window is negligible.
- If `sessionStorage` is entirely unavailable (rare — private-mode/quota), the
  fail-closed guard means **no auto-recovery** (the error surfaces and the user
  reloads manually, i.e. today's behavior) — chosen over fail-open to guarantee
  no reload loop.
- bfcache restores and CDN-propagation windows can still momentarily re-error;
  the guard ensures that degrades to a surfaced error, never a loop.

## Verification gates

`lint:ci`, `deadcode`, `typecheck`, `test` (+ `test:coverage:webapp`), `build`,
and the extension build — the standard pre-PR pass. Only `packages/webapp` is
touched, so no worker route-mirror or cross-runtime parity concerns apply.
