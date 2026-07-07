# Stale-asset recovery after deploy (issue #1330)

**Date:** 2026-07-07
**Issue:** [#1330](https://github.com/ai-ecoverse/slicc/issues/1330) — "Cloud cone crashes on stale assets after deploy"
**Scope:** `packages/webapp` only. One new boot helper + one registration line + tests + docs.

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

1. **The running tab holds an old module graph.** After a deploy, the CDN no
   longer serves the old content-hashed chunk names. A lazy `import()` for a
   now-gone chunk fails.
2. **The worker's SPA fallback masks the 404.** The `assets` binding in
   `packages/cloudflare-worker/wrangler.jsonc` uses
   `not_found_handling: "single-page-application"`, so a request for a gone
   `/assets/*.js` returns **`index.html` as `200 text/html`**, not a 404. The
   `import()` therefore rejects with a MIME/parse error ("Expected a JavaScript
   module … MIME type of text/html"). A `/assets/*` request can never cleanly
   404 today. (Left as-is this PR — see Out of scope.)
3. **Nothing recovers an already-open tab.** There is **no `vite:preloadError`
   handler anywhere** in the webapp (grep-verified). `scoops/upgrade-detection.ts`
   only compares the bundled version to the last-seen version **at boot**, so it
   never helps a tab that is already running when the deploy lands.

Vite's `__vitePreload` dispatches a cancelable `vite:preloadError` event on
`window` when a dynamic import fails (and re-throws unless the event is
`preventDefault()`-ed). A guarded global handler that reloads on that event is
the cheap, universal recovery — the same webapp entry (`ui/main.ts`) boots every
real-browser float, so one handler covers all of them.

## Scope decisions

- **Client handler only.** The guarded reload fully fixes the crash on its own;
  the import rejection fires `vite:preloadError` regardless of the HTML-vs-404
  response, so no server change is required.
- **One uniform mechanism for every float**, including the cloud cone: the
  in-sandbox browser runs the same guarded `location.reload()`, which re-fetches
  a fresh `index.html` + module graph, re-boots the leader, rejoins the tray, and
  resumes from the sandbox's OPFS. No `cloud-core` / worker / auto-restart
  plumbing (issue solution #2 is unnecessary given the uniform reload).
- **`location.reload()` runs in the page realm.** `ui/main.ts` executes in the
  real browsing context of every float (not the kernel worker / offscreen), so
  `location.reload()` is a real navigation here — unlike the agent shell's
  `nuke-reload` path, which exists precisely because the worker realm can't
  reload itself.

## Design

### Component — `packages/webapp/src/ui/boot/setup-preload-error-reload.ts`

Sibling to the existing `boot/setup-*.ts` helpers (e.g.
`setup-nuke-reload-listener.ts`, which already performs a page-side reload).

- **`decidePreloadReload(currentVersion: string, storedFlag: string | null): boolean`**
  — pure guard logic, no DOM. Returns `true` iff `storedFlag !== currentVersion`.
- **`setupPreloadErrorReload(deps?): void`** — registers
  `window.addEventListener('vite:preloadError', handler)`. `deps` are injectable
  for testing and default to production values:
  - `reload: () => void` → `() => window.location.reload()`
  - `storage: Pick<Storage, 'getItem' | 'setItem'>` → `window.sessionStorage`
  - `version: string` → `readBundledVersion().version` (from
    `scoops/upgrade-detection.ts`, i.e. `__SLICC_VERSION__`)
  - `storageKey` constant: `'slicc:preload-reloaded'`

  Handler behavior on `vite:preloadError`:
  1. Read the stored flag; compute `decidePreloadReload(version, flag)`.
  2. If it returns `true`: `event.preventDefault()` (suppress Vite's re-throw so
     no error boundary flashes before navigation), write `storage.setItem(key,
version)`, then `reload()`.
  3. If it returns `false` (already reloaded once for this exact version): do
     **nothing** — do not `preventDefault`. Let the error propagate to the
     existing "Something went wrong" + retry UI, so a genuinely-broken build
     surfaces instead of hiding behind a silent reload loop.
  4. `storage` access is wrapped in try/catch — a `sessionStorage` failure
     (private-mode quota, etc.) must not throw inside the error handler; on a
     storage read/write failure the handler still reloads once (fail-open toward
     recovery) but cannot then guard, which is acceptable because a storage-less
     context also can't loop-persist across the reload.

### The guard (why version-keyed `sessionStorage`)

Invariant: **reload at most once per deployed version**, so we never loop yet
always recover a genuinely-stale tab.

- Running (stale) bundle is version `V`. On `vite:preloadError` the flag is
  unset (or holds an older version) → reload; set flag = `V` first.
- After reload the tab runs the fresh bundle `V′`. The flag holds `V ≠ V′`, so a
  _later_ deploy can still trigger a fresh recovery reload.
- A _repeat_ failure while still on `V` (flag already `V`) is suppressed → the
  error surfaces instead of looping. Worst case across back-to-back deploys is a
  small bounded number of reloads (one per version actually observed), never an
  infinite loop.

`sessionStorage` is the correct lifetime: per-tab, survives the `reload()`,
clears on tab close (so a new session isn't wrongly suppressed). `localStorage`
would over-suppress across sessions; a time/count guard isn't causally tied to
the version that changed (rejected as approaches B/C in brainstorming).

### Registration — `packages/webapp/src/ui/main.ts`

Call `setupPreloadErrorReload()` as the **first statement inside `main()`**,
before the fixture check and before any dynamic `import()`. All lazy imports
(provider modules, `wc-settings`, dip/sprinkle chunks, mount branches) happen
after boot, so the handler is always registered before a stale chunk can be
requested. The initial entry chunks are fetched fresh with `index.html` on first
load and always match, so entry-chunk staleness is not a concern here.

## Testing

`packages/webapp/tests/ui/boot/setup-preload-error-reload.test.ts`:

- **Guard matrix** (`decidePreloadReload`, pure):
  - no prior flag (`null`) → `true`
  - flag equals current version → `false`
  - flag is an older version (post-deploy) → `true`
- **Handler** (jsdom, injected `reload`/`storage` spies — jsdom's
  `location.reload` throws "Not implemented", so injection is required):
  - first `vite:preloadError` → `reload` called once, flag written = version,
    `event.preventDefault()` called
  - second dispatch (flag now == version) → `reload` **not** called,
    `preventDefault` **not** called
  - a post-deploy dispatch (flag holds an older version) → `reload` called again
  - a `storage.setItem` that throws → handler still calls `reload` (fail-open),
    does not itself throw

## Docs

- `packages/webapp/CLAUDE.md` — a "Stale-chunk recovery" note under the boot /
  UI section describing the `vite:preloadError` handler and the version-keyed
  guard.
- `docs/pitfalls.md` — short entry: long-lived tabs + content-hashed chunks +
  the worker's SPA-fallback-returns-HTML behavior, and how the handler recovers.
- Close #1330 referencing the PR.

## Out of scope (possible follow-ups)

- **Server-side clean 404 for `/assets/*`.** Making the worker return a real 404
  (instead of the SPA `index.html`) for a missing hashed chunk would fail fast +
  clean and stop serving full HTML bodies for dead chunks. Deferred — the client
  handler already recovers the crash; this is defense-in-depth in a different
  package.
- **Cloud-cone auto-restart** (issue solution #2). Unnecessary given the uniform
  client reload recovers the in-sandbox browser too.

## Verification gates

`lint:ci`, `deadcode`, `typecheck`, `test` (+ `test:coverage:webapp`), `build`,
and the extension build — the standard pre-PR pass. Only `packages/webapp` is
touched, so no worker route-mirror or cross-runtime parity concerns apply.
