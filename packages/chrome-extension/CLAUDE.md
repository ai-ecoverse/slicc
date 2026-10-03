# CLAUDE.md

Chrome Manifest V3 float in `packages/chrome-extension/`.

## Scope

Manifest, service-worker CDP bridge, on-demand cherry side-panel cockpit
(`sidepanel.html` + `sidepanel-entry.ts`), secrets options page, preview service
worker, and device / media popup shells (capture-popup / picker-popup). Webapp UI
and agent engine load from the leader tab, not bundled. Manifest declares
`sidePanel`; no `content_scripts`.

Refs: `docs/extension-thin-bridge.md` (Bridge Port protocol, dev-watch, QA,
side-panel flow, fetch-proxy, smoke-test); `docs/chrome-extension-details.md`
(per-surface responsibilities, leader-tab lifecycle, CDP ownership, picker payloads,
boundary, MV3 RHC); `docs/architecture.md`, `docs/pitfalls.md`,
`docs/transcript-export.md`.

## Thin Bridge Architecture

CDP pass-through + bootstrapper. No bundled side-panel UI or offscreen engine —
both live in the pinned hosted leader tab.

```text
Hosted leader tab (?slicc=leader): webapp UI, kernel worker, orchestrator, VFS,
  agent shell   — Port 'slicc.cdp-bridge'
SW bridge (service-worker.ts, bridge-sw.ts): chrome.debugger pass-through,
  fetch-proxy + mount backends, secrets   — Port 'cherry-panel'
Side-panel cockpit (sidepanel.html + sidepanel-entry.ts): iframes hosted
  ui-only follower (?cherry=1&ui-only=1)
```

The bridge Port carries CDP pass-through (`cdp.request/response/event`), handoff
licks (`extension.lick`), `extension.open-settings`, and `leader.join-url`. The
leader tab is the tray leader (page-side `LeaderSyncManager` in
`page-leader-tray.ts`); the extension bypasses the tray data path. A new backend is
a `*-sw.ts` module plus one wiring line — never grow the entry.

### Leader-tab lifecycle

SW keeps one pinned leader tab but does **not** create it on startup (Chrome
restores the sticky pinned tab). `reconcileLeaderTabOnBoot()` runs at top-level
(SW-wake hygiene); `ensureLeaderTab()` (adopt-or-create + dedup) runs **on
demand**. After restart the restored leader re-pins via **self-adopt** — an
allowlisted `?slicc=leader` top-frame connection accepted when no leader id is
stored, reloading a discarded tab so it delivers `leader.join-url`.
`docs/chrome-extension-details.md`.

## On-Demand Per-Window Cherry Side Panel

Toolbar-icon click opens window-level `sidepanel.html` (no per-page injection),
iframing the hosted `?cherry=1&ui-only=1` follower, connecting to the leader over
the tray.

- **Framing**: cloudflare worker sets CSP `frame-ancestors` naming the extension
  origin (`chrome-extension://<id>`); bare `*` does not authorize it, and there is no
  `declarativeNetRequest` rule.
- **Login hand-off**: provider login runs in the leader tab, not the panel; the
  follower detects the side-panel via `location.ancestorOrigins` and shortcuts
  onboarding to a "Set up SLICC in the main tab" card. Its avatar-menu "bring leader
  to front" arrives as `focus-leader` (`openSettings:false`).
- **Slow boot**: no join URL after 20s → `slow` overlay with a "Show SLICC tab"
  button, not "Disconnected" (background leader boots at lowest macOS priority, so
  usually just slow). Never auto-focus the leader. Disconnected's button is
  **Retry** (a Port reconnect the SW treats as a reopen).
- **Bundle**: side-panel esbuild resolves `@ai-ecoverse/cherry` to `embed-ui.ts`
  (no host CDP handlers) so `sidepanel.js` stays inside its 14 kB size-limit.
  Extension coverage excludes `packages/cherry/**`; cherry has its own gate.

## Key Files

- `src/service-worker.ts` - thin MV3 entry: listener registration + wiring.
- `src/leader-tab-sw.ts` - leader-tab lifecycle (adopt/create/reload/reconcile/
  focus, discard-freeze exemption, update-reload guard) + URL resolvers.
- `src/cdp-proxy-sw.ts` - `chrome.debugger` translation for the legacy offscreen
  path, per-tab attachment ownership (`'bridge'` vs `'legacy'`),
  `maybeUnmaskCdpFrame`, event/detach forward.
- `src/secrets-sw.ts` - SW-owned `SecretsPipeline`, `secrets.*`, `secrets.crud` Port.
- `src/mount-backends-sw.ts` - S3 / DA sign+forward.
- `src/fetch-proxy-raw.ts` + `src/raw-fetch-capture.ts` - raw fetch mode on the
  `fetch-proxy.fetch` Port (#3571): credit-based `raw-*` messages, manual
  redirects, heads from `webRequest` (`extraHeaders`) keyed by a
  `#slicc-raw-<uuid>` fragment, streamed uploads. `npm run test:raw-fetch`
  (after a `SLICC_EXT_DEV=1` build). `docs/extension-thin-bridge.md`.
- `src/handoff-notifications-sw.ts` - handoff `Link` observer, OS toasts,
  once-per-session dedup. Installed BEFORE `discovery-sw.ts` (first on
  `onHeadersReceived`).
- `src/discovery-sw.ts` - discovery observer + autodiscover.
- `src/relay-sw.ts` - panel/offscreen relay (OAuth, CDP, tray socket); backends:
  `oauth-sw.ts`, `tray-socket-sw.ts`, `tab-group-sw.ts`, `capture-popup-sw.ts`.
- `src/sw-message-router.ts` - the SW's ONE `chrome.runtime.onMessage` listener.
  Backends return `'not-handled' | 'handled' | 'handled-async'`; router owns the
  `return true` reply-channel contract. Never add a second.
- `src/sw-pinned-port.ts` - shared three-factor pin for every non-bridge
  externally-connectable Port; awaited INSIDE `onMessage` (attaches listener sync).
- `src/bridge-sw.ts` - `externally_connectable` Port handler proxying CDP to
  `chrome.debugger`. Synthetic sessions keep `sessionId === targetId`; ref-counts
  dup tab attachments.
- `src/sidepanel-entry.ts` - side-panel host controller.
- `src/cherry-panel-sw.ts` - SW-side `cherry-panel` Port hub: caches/persists
  tri-state (`chrome.storage.session`); recovers a dead-tray leader.
- `src/secrets-entry.ts` + `src/secrets-storage.ts` - options CRUD.
- `packages/webapp/src/kernel/messages.ts` - wire-protocol message types.

## CSP Workarounds

Thin extension runs no dynamic code. Dynamic JS (JavaScript tool, `node -e`,
`.jsh`, `workflow`), sprinkle/dip rendering, and WASM (`convert` / `python3` /
`ffmpeg`) execute in the leader tab under ordinary web CSP. Extension-origin
surfaces load bundled assets via `chrome.runtime.getURL(...)`. `docs/pitfalls.md`.

## Picker / Capture Popups

Surfaces the leader tab cannot host reliably under TCC route through
extension-origin popups:

- **Device / directory pickers**: `mount` / `usb` / `serial` / `hid` call system
  choosers (`showDirectoryPicker` / `navigator.{usb,serial,hid}.request*`); all four
  share `picker-popup.html` + `picker-popup.js`, keyed by `?kind=...`.
- **Media capture**: camera / mic / screen (`ffmpeg -f avfoundation`,
  `screencapture`) route through `capture-popup.html` / `capture-popup.js` via
  `extension-media-capture.ts:captureViaPopup` (SW opens the popup, which posts bytes
  over `chrome.runtime`); `ffmpeg-command.ts` / `screencapture-command.ts` gate on
  `isExtensionFloat()`.

Both `.html`/`.js` pairs are copied into `dist/extension/` by `vite.config.ts`'s
`closeBundle` (not Rollup `input`); list both files of a pair or windows 404.
Payloads: `docs/chrome-extension-details.md`.

## Import Boundary

`src/` and `tests/` must not depend on `packages/webapp/src` at runtime — enforced
zero-tolerance by `check-layer-back-edges.mjs`'s `findChromeExtensionWebappEscapes`
(`npm run lint:layer-back-edges`), covering static, dynamic, and TS triple-slash
imports. Pure protocol modules live in `@slicc/shared-ts` (includes `DOM`); webapp
keeps re-export shims at each original path. Sole exception: a top-level
`import type` of `../../webapp/src/kernel/messages.js` (a union that compiles away).
Modules + allowlist: `docs/chrome-extension-details.md`.

Inside `src/`, import direction is `shared/page → sw → entry` (`service-worker.ts`
is the composition root). Page entries and shared helpers must not import
`*-sw.ts` / `bridge-sw.ts`. Same gate; baseline
`layer-back-edge-baseline-chrome-extension.json`.

## Runtime Conventions

- **Extension detection**: `typeof chrome !== 'undefined' && !!chrome?.runtime?.id`
- **`window.open()`**: often returns `null`; fire-and-forget.
- **Persistence**: leader tab is source of truth; extension holds no session state.
- **CDP access**: only the SW calls `chrome.debugger`; leader tab reaches it via the
  `externally_connectable` Port (`bridge-sw.ts`).

## Secrets Options Page + Build Notes

`secrets.html` is the manifest's `options_ui` page — extension-mode equivalent
of `~/.slicc/secrets.env`. `src/secrets-entry.ts` bundles to
`dist/extension/secrets.js` via the `build-secrets-page` esbuild plugin. Reach/CRUD:
`docs/chrome-extension-details.md`.

- `vite.config.ts` builds SW, side-panel host, secrets page, preview SW, and copied
  static assets into `dist/extension/`; Rollup `input` is one virtual no-op entry,
  outputs from `closeBundle` plugins.
- `manifest.json` ships a stable `key` (production ID fixed); local debugging hits
  `Content verify job failed ...`, so build with `SLICC_EXT_DEV=1` to strip `key`.
  No Helix RUM; leader tab handles telemetry.

## Secret-Aware Fetch Proxy

SW handles `fetch-proxy.fetch` Port connections. Invariant: `onMessage` attaches
**synchronously** in `onConnect` (pipeline awaited inside) — "await then add
listener" drops immediate `request` messages.

## MV3 Remote Hosted Code Guard

Chrome Web Store rejects MV3 submissions whose reviewer string-matches a full
third-party CDN URL (even one the runtime overrides).
`packages/dev-tools/tools/check-extension-rhc.sh` scans `dist/extension/` and fails
on a full `unpkg.com`/`esm.sh`/`cdn.jsdelivr.net/npm` path (bare hostnames allowed),
via `npm run postbuild:check -w @slicc/chrome-extension` + the CI job. Debug +
`cdn-url-builder.ts` fix: `docs/chrome-extension-details.md`.

## Local QA, Dev Watch, Smoke Test

Recipe (Chrome for Testing, extension profile, QA scenarios, dev-watch loop,
smoke-test knobs): `docs/extension-thin-bridge.md`. E2E smoke
`packages/dev-tools/tools/extension-smoke-test.ts` is `continue-on-error` in CI.

```bash
npm run dev:extension:fresh                              # build + wrangler
SLICC_EXT_DEV=1 npm run build -w @slicc/chrome-extension # fixed extension ID
npm run test:extension-smoke -w @slicc/chrome-extension  # smoke (post-build)
```
