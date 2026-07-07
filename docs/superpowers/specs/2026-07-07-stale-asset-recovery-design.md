# Stale-asset recovery after deploy (issue #1330)

**Date:** 2026-07-07
**Issue:** [#1330](https://github.com/ai-ecoverse/slicc/issues/1330) — "Cloud cone crashes on stale assets after deploy"
**Scope:** `packages/webapp` only. Page trigger + two worker triggers → one shared, instanceId-scoped, timestamp-guarded page reload + tests + docs.

> **Revision history.**
>
> - **Draft 1** (page-only `vite:preloadError` handler). Codex review found a
>   **blocker**: the #1330 failure (`anthropic-*.js`) is a **worker-side** import
>   that never dispatches `vite:preloadError` on `window`. Also: version-keyed
>   guard is too coarse; fail-open storage could loop; fresh-HTML unstated.
> - **Draft 2** added a worker trigger via an origin-wide `BroadcastChannel`,
>   timestamp guard, fail-closed. Second Codex review found two more **blockers**:
>   (a) an origin-wide broadcast reloads **every** same-origin SLICC tab, not just
>   the failing one, violating the codebase's established instanceId-scoping; (b)
>   `registerProviders()` eagerly imports every provider at **worker boot**, so a
>   stale chunk fails **before** any `ScoopContext` classifier exists — the
>   turn-time hook misses it. Plus: broaden the matcher to the MIME/module-script
>   family; the 20 s guard window is shorter than the 30 s boot timeout (loop
>   risk); fix a `?ui-fixture` self-contradiction.
> - **Draft 3 (this doc)** resolves all of the above; verified against `main`.
>
> Two scope calls remain (both revisitable): cover **both** page- and
> worker-owned failures, and stay **webapp-only** relying on `location.reload()`
> revalidation for fresh HTML (worker `no-cache` header deferred — Out of scope).

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
deploy: the **cloud cone** (its UI runs in a headless browser inside the e2b
sandbox), the **extension's pinned leader tab**, the **extension side-panel
follower** (a side-panel-only user has no obvious "reload"), and any open
**standalone** tab.

## Root cause (verified against `main`)

1. **Old module graph.** After a deploy the CDN no longer serves the old
   content-hashed chunk names; a lazy `import()` for a gone chunk fails, and the
   browser's module map caches that failure so retrying the same `import()`
   re-rejects — only a reload recovers.
2. **SPA fallback masks the 404.** The `assets` binding
   (`packages/cloudflare-worker/wrangler.jsonc`) uses
   `not_found_handling: "single-page-application"`, so a gone `/assets/*.js`
   returns **`index.html` as `200 text/html`** — the `import()` rejects with a
   MIME/module-script error, not a network 404. (Left as-is — Out of scope.)
3. **The failing import is usually worker-owned; the worker has no
   `vite:preloadError`.** `kernel-worker.ts` `boot()` calls
   `registerProviders()`, which **eagerly `await`s the import of every** built-in
   - external provider config chunk (`providers/index.ts` loop), and the cone/
     scoop turn later imports pi-ai streaming chunks — all **inside the kernel
     worker**. Verified: the built `kernel-worker-*.js` chunk has **zero**
     `preloadError` occurrences (Vite injects the `__vitePreload` helper only into
     the **page** bundle, not worker builds). A `window` listener cannot see worker
     import failures.
4. **Two distinct worker failure timings:**
   - **Boot-time** — a stale chunk needed by `registerProviders()` (or another
     boot `await import()`) rejects in `boot()`. The init guard
     (`kernel-worker-init-guard.ts`) catches it (`onError`), so it is a _handled_
     rejection (no global `unhandledrejection`), and no `ScoopContext` exists yet;
     the page just hits a worker-ready timeout.
   - **Turn-time** — a stale chunk imported during a turn rejects and reaches
     `scoop-context.ts`'s classifier. Note `isRetryableError` matches
     `failed to fetch` (~line 146), so it is currently retried 3× (futile — the
     module map cached the failure) → the fatal "Scoop … failed after 3 attempts".
5. **Nothing recovers an already-open tab.** No `vite:preloadError` handler
   exists (grep-verified); `scoops/upgrade-detection.ts` only compares versions
   **at boot**.

Vite's `__vitePreload` dispatches a cancelable `vite:preloadError` on `window`
for **page-owned** dynamic imports (covering the MIME rejection from the
`200 text/html` fallback), re-throwing unless `preventDefault()` is called. That
covers page-owned lazy chunks; worker-owned failures need a separate path to the
page (which owns `location.reload()`).

## Design

One shared, guarded page reload is fed by **three** triggers (one page, two
worker). The worker triggers are what actually fix #1330.

### Shared channel + detection — `packages/webapp/src/ui/boot/stale-asset-channel.ts`

Shell-free, realm-agnostic (no `window`/`document` at module scope; only
`BroadcastChannel`, available in page and DedicatedWorker) — so the kernel worker
imports the detection + broadcast without DOM code, mirroring how
`nuke-channel.ts` splits out of `nuke-command.ts`.

- **`isDynamicImportError(msg: string): boolean`** — matches the cross-browser
  dynamic-import / module-script failure family (case-insensitive):
  - `Failed to fetch dynamically imported module` (Chromium)
  - `error loading dynamically imported module` (Firefox)
  - `Importing a module script failed` (WebKit)
  - `expected a javascript( |-)?module` / `MIME type` module-script rejection
    (the `200 text/html` fallback case)
- **`STALE_ASSET_RELOAD_CHANNEL = 'slicc-stale-asset-reload'`**, wire type
  `{ type: 'stale-asset-reload'; instanceId: string }`.
- **`setStaleAssetInstanceId(id: string): void`** — the kernel worker records its
  `init.instanceId` here at the very start of `boot()` so the broadcasters can
  stamp it (both worker failure sites are reached without threading the id).
- **`broadcastStaleAssetReload(): void`** — posts `{type, instanceId}` on the
  channel (no-op if no instanceId set or `BroadcastChannel` is unavailable).
- **`installStaleAssetReloadListener(instanceId: string, onReload: () => void): () => void`**
  — page-side listener that invokes `onReload` only when the message's
  `instanceId` matches (own worker), ignoring other tabs' broadcasts. Returns a
  disposer.

**Why instanceId-scoped, not origin-wide:** `BroadcastChannel` reaches every
same-origin context, so an unscoped reload would reload _all_ SLICC tabs
(leader + side-panel follower + any other sliccy.ai tab), disrupting a tab the
user is actively using. The codebase already scopes worker↔page channels by
`instanceId` for exactly this reason (`kernel-worker.ts` sprinkle-bridge +
panel-rpc, threaded via `kernel-worker-init`). Scoping reloads only the page that
owns the failing worker; each tab still recovers its own page-owned chunks via
the page trigger.

### Shared guarded reload + page trigger — `packages/webapp/src/ui/boot/setup-preload-error-reload.ts`

Sibling to `setup-nuke-reload-listener.ts`. Owns the one guarded-reload the
triggers share (module-level guard state).

- **`decideStaleReload(lastReloadAt: number | null, now: number, windowMs: number): boolean`**
  — pure: reload iff `lastReloadAt === null || now - lastReloadAt >= windowMs`.
- **`guardedReload(deps): boolean`** — reads `lastReloadAt` from `sessionStorage`;
  **fail-closed** (any storage read/write throw → return `false`, no reload — we
  must never reload when we can't persist the guard). If `decideStaleReload` is
  `false` (within window) → return `false` (let the error surface to the existing
  "Something went wrong" + retry UI). Else write `now` and `reload()`, return
  `true`. Deps injectable (`reload`→`location.reload`, `storage`→`sessionStorage`,
  `now`→`Date.now`, `windowMs`→`RELOAD_WINDOW_MS`, `storageKey`).
- **`RELOAD_WINDOW_MS = 60_000`.** Must exceed the worst-case reload→boot time so
  a reload that did **not** fix the tab (cached stale HTML, or broken fresh build)
  re-errors _within_ the window → suppressed → no loop. The kernel host-ready
  timeout is 30 s, so a stale re-error surfaces well inside 60 s; a genuinely new
  deploy minutes/hours later is past the window → reload allowed. (20 s was < the
  30 s boot timeout — the review's loop concern.)
- **`setupPreloadErrorReload(deps?): void`** — registers
  `window.addEventListener('vite:preloadError', e => { if (guardedReload()) e.preventDefault(); })`
  (`preventDefault` only when actually reloading, so a guard-suppressed error
  still propagates).
- **`installWorkerStaleAssetReloadListener(instanceId: string): void`** — wires
  `installStaleAssetReloadListener(instanceId, () => { guardedReload(); })` so a
  worker broadcast runs the identical guarded reload.

### Guard rationale (timestamp, not version)

`__SLICC_VERSION__` only bumps on a semver **release**; PR-merge / manual /
staging deploys rebuild `dist/ui` with new chunk hashes at the **same** version,
so a version-keyed guard would wrongly suppress a legitimate reload across those
deploys. A timestamp window (per-tab `sessionStorage`, survives the reload,
clears on tab close) is causally correct and, at 60 s > the 30 s boot timeout,
loop-proof for the realistic re-error-at-boot case.

### Worker trigger A — boot-time — `packages/webapp/src/kernel/kernel-worker.ts`

At the very start of `boot(init)`, call `setStaleAssetInstanceId(init.instanceId)`.
Wrap `boot()`'s body in `try { … } catch (err) { if
(isDynamicImportError(String((err as Error)?.message ?? err))) broadcastStaleAssetReload(); throw err; }`
— broadcast on a stale-import boot failure, then **rethrow** so the existing init
guard `onError` / worker-ready-timeout fallback is unchanged. Covers
`registerProviders()` and every boot `await import(...)`.

### Worker trigger B — turn-time — `packages/webapp/src/scoops/scoop-context.ts`

In the turn-error classification, check `isDynamicImportError(msg)` **before**
`isRetryableError` (which matches `failed to fetch`): treat it as **non-retryable**
(don't burn the 3 futile retries + backoff) and call `broadcastStaleAssetReload()`.
Runs for the cone and every scoop.

### Registration — `packages/webapp/src/ui/main.ts` (+ worker-spawn site)

- `setupPreloadErrorReload()` — first statement in `main()`, before the fixture
  check and any dynamic `import()`. It installs only the page `vite:preloadError`
  handler (page-local, no instanceId needed) and is harmless on the `?ui-fixture`
  surface (which spawns no worker and does no provider imports).
- `installWorkerStaleAssetReloadListener(instanceId)` — called on the
  worker-owning floats at the point the page spawns the kernel worker (standalone
  / hosted-leader / cloud, and the extension leader tab), where the page-generated
  `instanceId` (the one threaded into `kernel-worker-init`) is known — which is
  before the worker runs `registerProviders()`, so no failure can precede the
  listener. The extension side-panel follower spawns no worker and installs only
  the page handler.

## Testing

`tests/ui/boot/stale-asset-channel.test.ts`:

- `isDynamicImportError` matrix: the three browser strings + the MIME/module-
  script string → `true`; `401` / `rate limit` / plain `network error` → `false`.
- `broadcastStaleAssetReload` no-ops before `setStaleAssetInstanceId`; after it,
  posts `{type, instanceId}`.
- `installStaleAssetReloadListener(id, onReload)` invokes `onReload` on a matching
  instanceId, **ignores** a non-matching one, and the disposer detaches.

`tests/ui/boot/setup-preload-error-reload.test.ts` (jsdom; inject
`reload`/`storage`/`now` — jsdom's `location.reload` throws):

- `decideStaleReload`: null→true; within window→false; past window→true.
- Page trigger: first `vite:preloadError` → `reload` once + flag written +
  `preventDefault`; a dispatch within window → no reload, no `preventDefault`; a
  dispatch past window → reload again.
- Worker listener: a matching-instanceId broadcast → guarded `reload`; a
  non-matching one → no reload.
- Fail-closed: `storage.getItem`/`setItem` throws → no reload, no throw.

`tests/scoops/scoop-context.test.ts` (extend): a "Failed to fetch dynamically
imported module" message is classified non-retryable (checked before
`isRetryableError`) and triggers the broadcast (spy the broadcast seam).

`tests/kernel/kernel-worker*.test.ts` (or a focused unit around the boot
try/catch): a `boot()` whose provider import rejects with a dynamic-import error
broadcasts once and still rethrows (guard `onError` still runs).

## Docs

- `packages/webapp/CLAUDE.md` — "Stale-asset recovery" note: the three triggers,
  the shared instanceId-scoped timestamp-guarded reload, the worker→page
  broadcast, and the boot-vs-turn split.
- `docs/pitfalls.md` — short entry: long-lived tabs + content-hashed chunks + the
  SPA-fallback-returns-HTML behavior + the worker-vs-page `vite:preloadError` gap.
- Close #1330 referencing the PR.

## Out of scope (possible follow-ups)

- **Worker `Cache-Control: no-cache` on the SPA HTML** — makes "reload fetches a
  fresh `index.html`" a server guarantee instead of relying on browser
  reload-revalidation. Deferred to keep this webapp-only; revisit if a hosted
  test shows a reload not picking up the new build.
- **Server-side clean 404 for `/assets/*`** — fail fast/clean instead of the SPA
  `index.html`. Defense in depth in another package; not required for any trigger.
- **Cloud-cone auto-restart** (issue solution #2) — unnecessary; the page reload
  recovers the in-sandbox browser too.

## Limitations (stated)

- Recovers a tab/worker **already running** when the deploy lands. A page whose
  **initial entry graph** can't evaluate can't install the handler — but the
  first load fetches entry chunks fresh with `index.html`, so that window is
  negligible.
- If `sessionStorage` is entirely unavailable (rare — private-mode/quota), the
  fail-closed guard means **no auto-recovery** (error surfaces, user reloads
  manually — today's behavior) — chosen over fail-open to guarantee no loop.
- Fresh HTML on reload relies on `location.reload()`'s top-document revalidation
  (cherry/electron responses are already `no-store`; the default SPA response is
  not). If ever insufficient, the deferred worker `no-cache` header closes it.
- bfcache restores / CDN-propagation windows can momentarily re-error; the guard
  degrades that to a surfaced error, never a loop.

## Verification gates

`lint:ci`, `deadcode`, `typecheck`, `test` (+ `test:coverage:webapp`), `build`,
and the extension build — the standard pre-PR pass. Only `packages/webapp` is
touched, so no worker route-mirror or cross-runtime parity concerns apply.
