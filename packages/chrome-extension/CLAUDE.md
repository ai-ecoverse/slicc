# CLAUDE.md

Chrome Manifest V3 float in `packages/chrome-extension/`.

## Scope

Manifest, service-worker CDP bridge, on-demand cherry side-panel cockpit
(`sidepanel.html` + `sidepanel-entry.ts`), secrets options page, preview service
worker, and device / media popup shells (capture-popup / picker-popup). Webapp UI
and agent engine load from the leader tab, not bundled. Manifest declares
`sidePanel`, no `content_scripts`.

## Thin Bridge Architecture

CDP pass-through + bootstrapper. No bundled side-panel UI or offscreen engine —
both live in the pinned hosted leader tab.

```text
Hosted leader tab (?slicc=leader): webapp UI, kernel worker, orchestrator, VFS,
  agent shell   — Port 'slicc.cdp-bridge'
Service Worker bridge (service-worker.ts, bridge-sw.ts): chrome.debugger
  pass-through, fetch-proxy + mount backends, secrets   — Port 'cherry-panel'
Side-panel cockpit (sidepanel.html + sidepanel-entry.ts): iframes hosted
  ui-only follower (?cherry=1&ui-only=1)
```

The bridge Port carries CDP pass-through (`cdp.request/response/event`), handoff
licks (`extension.lick`), open-settings (`extension.open-settings`), and
`leader.join-url`. The leader tab is the tray leader (page-side `LeaderSyncManager`
in `page-leader-tray.ts`); the extension bypasses the tray data path.

Adding a backend is a new `*-sw.ts` module plus one wiring line — never grow the
entry. Refs: `docs/extension-thin-bridge.md` (Bridge Port protocol, toast dedup,
dev-watch, QA, side-panel flow, fetch-proxy, smoke-test);
`docs/chrome-extension-details.md` (per-surface responsibilities, leader-tab
lifecycle, `bridge-sw.ts` CDP ownership, picker payloads, import boundary, MV3
RHC); also `docs/architecture.md`, `docs/pitfalls.md`, `docs/transcript-export.md`.

### Leader-tab lifecycle

SW keeps one pinned leader tab but does **not** create it on browser startup
(Chrome restores the sticky pinned tab). `reconcileLeaderTabOnBoot()` runs at
top-level (SW-wake hygiene); `ensureLeaderTab()` (adopt-or-create + dedup) runs
**on demand**. After restart the restored leader re-pins via **self-adopt** — an
allowlisted `?slicc=leader` top-frame connection accepted when no leader id is
stored, reloading a discarded tab so it can deliver `leader.join-url`. Full
sequence + edge cases: `docs/chrome-extension-details.md`.

## On-Demand Per-Window Cherry Side Panel

Toolbar-icon click opens window-level `sidepanel.html` (no per-page injection),
iframing the hosted `?cherry=1&ui-only=1` follower and connecting to the leader
over the tray.

- **Framing**: cloudflare worker sets `Content-Security-Policy` `frame-ancestors`
  naming the extension origin (`chrome-extension://<id>`); bare `*` does not
  authorize it, and there is no `declarativeNetRequest` rule.
- **Login hand-off**: provider login runs in the leader tab, not the panel; the
  follower detects the side-panel via `location.ancestorOrigins` and shortcuts
  onboarding to a "Set up SLICC in the main tab" card. Its avatar-menu "bring leader
  to front" arrives as `focus-leader` (`openSettings: false`).

## Key Files

- `src/service-worker.ts` - thin MV3 entry: listener registration + wiring.
- `src/leader-tab-sw.ts` - leader-tab lifecycle (adopt/create/reload/reconcile/
  focus, discard-freeze exemption, update-reload guard) + URL resolvers.
- `src/cdp-proxy-sw.ts` - `chrome.debugger` translation for the legacy offscreen
  path, per-tab attachment ownership (`'bridge'` vs `'legacy'`),
  `maybeUnmaskCdpFrame`, event/detach forwarding.
- `src/secrets-sw.ts` - SW-owned `SecretsPipeline`, `secrets.*` handlers, `secrets.crud` Port.
- `src/mount-backends-sw.ts` - S3 / DA sign-and-forward.
- `src/handoff-notifications-sw.ts` - handoff `Link` observer, OS toasts,
  once-per-session dedup. Installed BEFORE `discovery-sw.ts` (stays first on
  `onHeadersReceived`).
- `src/discovery-sw.ts` - discovery observer wiring + autodiscover setting.
- `src/relay-sw.ts` - panel/offscreen relay (OAuth, CDP commands, tray socket); its
  backends are `oauth-sw.ts`, `tray-socket-sw.ts`, `tab-group-sw.ts`, `capture-popup-sw.ts`.
- `src/sw-message-router.ts` - the SW's ONE `chrome.runtime.onMessage` listener.
  Backends return `'not-handled' | 'handled' | 'handled-async'`; the router owns the
  `return true` reply-channel contract. Never add a second listener.
- `src/sw-pinned-port.ts` - shared three-factor pin for every non-bridge
  externally-connectable Port; started on connect, awaited INSIDE `onMessage` (so
  the listener attaches synchronously).
- `src/bridge-sw.ts` - `externally_connectable` Port handler proxying CDP to
  `chrome.debugger`. Synthetic sessions keep `sessionId === targetId` and
  ref-count duplicate tab attachments.
- `src/sidepanel-entry.ts` - side-panel host controller.
- `src/cherry-panel-sw.ts` - SW-side `cherry-panel` Port hub: caches/persists
  tri-state (`chrome.storage.session`), recovers a dead-tray leader.
- `src/secrets-entry.ts` + `src/secrets-storage.ts` - options-page CRUD.
- `packages/webapp/src/kernel/messages.ts` - wire-protocol message types.

## CSP Workarounds

Thin extension runs no dynamic code. Dynamic JS (JavaScript tool, `node -e`,
`.jsh`, `workflow`), sprinkle/dip rendering, and WASM (`convert` / `python3` /
`ffmpeg`) execute in the leader tab under ordinary web CSP. Extension-origin
surfaces (SW, side-panel host, secrets page, popups) load bundled assets via
`chrome.runtime.getURL(...)`, no bundled WASM/JS. See `docs/pitfalls.md`.

## Picker / Capture Popups

Surfaces the leader tab cannot host reliably under TCC route through
extension-origin popups:

- **Device / directory pickers**: `mount` / `usb` / `serial` / `hid` call system
  choosers (`showDirectoryPicker` / `navigator.{usb,serial,hid}.request*`); all four
  share `picker-popup.html` + `picker-popup.js`, keyed by
  `?kind=directory|usb-device|serial-port|hid-device`.
- **Media capture**: camera / mic / screen (`ffmpeg -f avfoundation`,
  `screencapture`) route through `capture-popup.html` / `capture-popup.js` via
  `extension-media-capture.ts:captureViaPopup` (SW opens the popup, which posts
  bytes over `chrome.runtime`); `ffmpeg-command.ts` / `screencapture-command.ts`
  gate on `isExtensionFloat()`.

Both `.html`/`.js` pairs are copied into `dist/extension/` by the `closeBundle`
hook in `vite.config.ts` (not Rollup `input`); keep both files of a pair listed or
the windows 404. Payload shapes: `docs/chrome-extension-details.md`.

## Import Boundary

`src/` and `tests/` must not depend on `packages/webapp/src` at runtime — enforced
zero-tolerance by `check-layer-back-edges.mjs`'s `findChromeExtensionWebappEscapes`
(`npm run lint:layer-back-edges`), covering static, dynamic, and TS triple-slash
imports. The pure protocol modules the extension needs live in `@slicc/shared-ts`
(which includes `DOM`); webapp keeps re-export shims at each original path. Sole
exception: a top-level `import type` of `../../webapp/src/kernel/messages.js` (a union
that compiles away). Module list + exact-path allowlist rules:
`docs/chrome-extension-details.md`.

## Runtime Conventions

- **Extension detection**: `typeof chrome !== 'undefined' && !!chrome?.runtime?.id`
- **`window.open()`**: often returns `null`; fire-and-forget.
- **Persistence**: leader tab is source of truth; extension holds no session state.
- **CDP access**: only the SW calls `chrome.debugger`; leader tab reaches it via the
  `externally_connectable` Port (`bridge-sw.ts`).

## Secrets Options Page + Build Notes

`secrets.html` is the manifest's `options_ui` page — extension-mode equivalent
of `~/.slicc/secrets.env`. Pure logic in `src/secrets-storage.ts`; DOM entry
`src/secrets-entry.ts` bundles to `dist/extension/secrets.js` via the
`build-secrets-page` esbuild plugin. Reach/CRUD: `docs/chrome-extension-details.md`.

- `vite.config.ts` builds SW, side-panel host, secrets page, preview SW, and copied
  static assets into `dist/extension/`; Rollup `input` is one virtual no-op entry,
  outputs come from `closeBundle` plugins.
- `manifest.json` ships a stable `key` (production ID fixed); local debugging hits
  `Content verify job failed ...`, so build with `SLICC_EXT_DEV=1` (below) to strip
  `key`. No Helix RUM; leader tab uses webapp telemetry.

## MV3 Remote Hosted Code Guard

Chrome Web Store rejects MV3 submissions whose reviewer string-matches a full
third-party CDN URL (even one the runtime overrides).
`packages/dev-tools/tools/check-extension-rhc.sh` scans `dist/extension/` and fails
on a full `unpkg.com`/`esm.sh`/`cdn.jsdelivr.net/npm` path (bare hostnames allowed),
via `npm run postbuild:check -w @slicc/chrome-extension` + the `chrome-extension` CI
job. Debug + `cdn-url-builder.ts` fix in `docs/chrome-extension-details.md`.

## Secret-Aware Fetch Proxy

SW handles `fetch-proxy.fetch` Port connections. Invariant: the `onMessage` listener
attaches **synchronously** in `onConnect` (pipeline awaited inside) — "await build then
add listener" drops immediate `request` messages.

## Local QA, Dev Watch, Smoke Test

Recipe (Chrome for Testing, extension profile, QA scenarios, dev-watch loop,
smoke-test knobs): `docs/extension-thin-bridge.md`. E2E smoke
`packages/dev-tools/tools/extension-smoke-test.ts` runs `continue-on-error` in CI.

```bash
npm run dev:extension:fresh                              # build + wrangler
SLICC_EXT_DEV=1 npm run build -w @slicc/chrome-extension # fixed extension ID
npm run test:extension-smoke -w @slicc/chrome-extension  # smoke (post-build)
```
