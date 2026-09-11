# CLAUDE.md

Chrome Manifest V3 float in `packages/chrome-extension/`.

## Scope

Manifest, service-worker CDP bridge, on-demand cherry side-panel cockpit
(`sidepanel.html` + `sidepanel-entry.ts`), secrets options page, preview
service worker, and device / media popup shells (capture-popup / picker-popup).
Webapp UI and agent engine load from the hosted leader tab, not bundled.
Manifest declares `sidePanel`; no `content_scripts`.

## Thin Bridge Architecture

CDP pass-through + bootstrapper. No bundled side-panel UI or offscreen engine

- both live in a pinned hosted leader tab.

```text
Hosted leader tab (?slicc=leader): webapp UI, kernel worker, orchestrator,
  VFS, agent shell
    ^ Port name: 'slicc.cdp-bridge'
Service Worker bridge (service-worker.ts, bridge-sw.ts): chrome.debugger
  pass-through, fetch-proxy + mount backends, secrets
    ^ Port name: 'cherry-panel'
Side-panel cockpit (sidepanel.html + sidepanel-entry.ts): iframes hosted
  ui-only follower (?cherry=1&ui-only=1)
```

Leader-tab bridge Port (`name: 'slicc.cdp-bridge'`) carries CDP pass-through
(`cdp.request/response/event`), handoff licks (`extension.lick`),
open-settings (`extension.open-settings`), and `leader.join-url`. Hosted
leader tab is the tray leader (page-side `LeaderSyncManager` in
`packages/webapp/src/ui/page-leader-tray.ts`); extension bypasses the tray data path.

Refs: `docs/architecture.md` (cross-origin); `docs/extension-thin-bridge.md`
(Bridge Port protocol, toast dedup, dev-watch, QA, side-panel flow,
fetch-proxy handler, smoke-test knobs); `docs/chrome-extension-details.md`
(per-surface responsibilities, leader-tab lifecycle, `bridge-sw.ts` CDP
ownership, picker payloads, MV3 RHC debug); `docs/pitfalls.md`;
`docs/transcript-export.md`; `packages/webapp/CLAUDE.md`;
`packages/shared-ts/CLAUDE.md`.

### Responsibilities

- **Service worker** (`src/service-worker.ts`): a thin MV3 entry that owns no
  backend logic — it builds `bridgeSwDeps`, calls each backend's `install*()`
  once, and routes Ports and messages. Every concern lives in a focused
  `*-sw.ts` peer module (see Key Files). Adding a backend means adding a module
  plus one wiring line here, never growing this file.
- **Side-panel cockpit** (`sidepanel.html` + `src/sidepanel-entry.ts`): runs
  the tri-state (booting -> ready -> disconnected) controller over a
  `cherry-panel` Port; relays `slicc.focus-leader-tab` as `focus-leader`
  (`openSettings: false`).
- **Secrets options page** (`secrets.html` + `src/secrets-entry.ts`): CRUD
  over `chrome.storage.local`.

### Leader-tab lifecycle

SW keeps one pinned leader tab but does **not** create it on browser startup
(Chrome restores the sticky pinned tab). `reconcileLeaderTabOnBoot()` runs at
top-level (SW-wake hygiene); `ensureLeaderTab()` (adopt-or-create + dedup)
runs **on demand**. After restart the restored leader re-pins via
**self-adopt**: a top-frame connection from an allowlisted origin carrying
`?slicc=leader` is accepted when no leader id is stored; adoption reloads a
discarded leader tab so it can deliver `leader.join-url`.

## On-Demand Per-Window Cherry Side Panel

Toolbar-icon click opens window-level `sidepanel.html` (no per-page
injection), iframing the hosted `?cherry=1&ui-only=1` follower and connecting
to the leader over the tray.

- **Framing**: cloudflare worker sets `Content-Security-Policy`
  `frame-ancestors` naming the extension origin (`chrome-extension://<id>`);
  bare `*` does not authorize it; no `declarativeNetRequest` rule.
- **Login hand-off**: provider login runs in the leader tab, not the panel;
  the follower detects the side-panel via `location.ancestorOrigins` and
  shortcuts onboarding to a "Set up SLICC in the main tab" card.

## Key Files

- `src/service-worker.ts` - thin MV3 entry: listener registration + wiring only.
- `src/leader-tab-sw.ts` - leader-tab lifecycle (adopt/create/reload/reconcile/
  focus, discard-freeze exemption, update-reload guard) + its pure URL resolvers.
- `src/cdp-proxy-sw.ts` - `chrome.debugger` translation for the legacy offscreen
  path, shared per-tab attachment ownership (`'bridge'` vs `'legacy'`), outgoing
  `maybeUnmaskCdpFrame`, and event/detach forwarding. Debugger events reach the
  offscreen channel only for tabs with a legacy `sessionToTab` mapping — the
  bridge forwards its own events per-Port.
- `src/secrets-sw.ts` - SW-owned `SecretsPipeline` + every `secrets.*` handler
  and the `secrets.crud` Port.
- `src/mount-backends-sw.ts` - S3 / DA sign-and-forward (message + Port).
- `src/handoff-notifications-sw.ts` - handoff `Link` observer, OS toasts,
  once-per-session dedup. Installed BEFORE `discovery-sw.ts` so it stays the
  first `onHeadersReceived` listener.
- `src/discovery-sw.ts` - discovery observer wiring + autodiscover setting mirror.
- `src/relay-sw.ts` - panel/offscreen relay (OAuth, CDP commands, tray socket);
  `src/oauth-sw.ts`, `src/tray-socket-sw.ts`, `src/tab-group-sw.ts`,
  `src/capture-popup-sw.ts` are its single-purpose backends.
- `src/sw-message-router.ts` - the SW's ONE `chrome.runtime.onMessage` listener.
  Backends return `'not-handled' | 'handled' | 'handled-async'`; the router owns
  the `return true` reply-channel contract. Do not add a second listener.
- `src/sw-pinned-port.ts` - shared three-factor pin for every non-bridge
  externally-connectable Port. The pin is started on connect and awaited INSIDE
  `onMessage`, so the listener still attaches synchronously.
- `src/bridge-sw.ts` - `externally_connectable` Port handler pass-through-
  proxying CDP to `chrome.debugger`. Synthetic sessions keep
  `sessionId === targetId` and ref-count duplicate tab attachments; disconnect
  and target close force-release them.
- `src/sidepanel-entry.ts` - side-panel host controller (-> `sidepanel.js`).
- `src/cherry-panel-sw.ts` - SW-side `cherry-panel` Port hub: caches/persists
  tri-state (`chrome.storage.session`), recovers a dead-tray leader.
- `packages/webapp/src/kernel/messages.ts` - wire-protocol message types.
- `src/secrets-entry.ts` + `src/secrets-storage.ts` - options-page CRUD.

## CSP Workarounds

Thin extension runs no dynamic code. Dynamic JS (JavaScript tool, `node -e`,
`.jsh`, `workflow`), sprinkle/dip rendering, and WASM (`convert` / `python3` /
`ffmpeg`) execute in the hosted leader tab under ordinary web CSP.
Extension-origin surfaces (SW, side-panel host, secrets page, popups) load
bundled assets via `chrome.runtime.getURL(...)`; no bundled WASM/JS.

## Picker / Capture Popups

Surfaces the hosted leader tab cannot host reliably under TCC route through
extension-origin popups:

- **Device / directory pickers**: `mount` / `usb` / `serial` / `hid` call
  system choosers (`showDirectoryPicker` /
  `navigator.{usb,serial,hid}.request*`). All four share `picker-popup.html` +
  `picker-popup.js`, keyed by `?kind=directory|usb-device|serial-port|hid-device`.
- **Media capture**: camera / mic / screen (`ffmpeg -f avfoundation`,
  `screencapture`) route through `capture-popup.html` / `capture-popup.js`.
  `extension-media-capture.ts:captureViaPopup` asks the SW to open the popup
  (`capture-open-window` -> `chrome.windows.create`); popup posts bytes over
  `chrome.runtime`. `ffmpeg-command.ts` / `screencapture-command.ts` gate it
  behind `isExtensionFloat()`.

Both `.html`/`.js` pairs are copied into `dist/extension/` by the
`closeBundle` hook in `vite.config.ts` (not Rollup `input`); a change must keep
both files of a pair listed or the windows 404.

## Import Boundary

`src/` and `tests/` must not depend on `packages/webapp/src` at runtime — enforced
zero-tolerance by `check-layer-back-edges.mjs`'s `findChromeExtensionWebappEscapes` (`npm run
lint:layer-back-edges`), covering quoted, template-literal, and `+`-concatenated
`import()`/`require()` specifiers plus TS triple-slash references. Scan roots are `src` and
`tests` (#3047; same shape as the webcomponents pass). The pure protocol modules the
extension needs (CDP bridge envelope, `LEADER_EXT_ID_QUERY_NAME`, proxy-headers, link
extraction, `cdp/types` `TargetInfo` subset, `iframe-repaint.ts` DOM helper,
`isExtensionMessage`) live in `@slicc/shared-ts` (whose `tsconfig.json` includes `DOM`);
webapp keeps re-export shims at each original path.

Sole exception: a top-level `import type { ... } from '../../webapp/src/kernel/messages.js'`
— a webapp-internal message-envelope union that compiles away (no runtime coupling). The
guard allowlists only that path as a top-level `import type { ... }` clause in `src` and
`tests`; a value import, a mixed `{ type X, Y }` clause, or a type-only import of any OTHER
webapp module all still fail.

## Runtime Conventions

- **Extension detection**: `typeof chrome !== 'undefined' && !!chrome?.runtime?.id`
- **`window.open()`**: often returns `null`; fire-and-forget.
- **Persistence**: leader tab is source of truth; extension holds no
  chat/session state.
- **CDP access**: only the SW calls `chrome.debugger`; leader tab reaches it
  via the `externally_connectable` Port (`bridge-sw.ts`).

## Secrets Options Page + Build Notes

`secrets.html` is the manifest's `options_ui` page - extension-mode
equivalent of `~/.slicc/secrets.env`. Pure logic in `src/secrets-storage.ts`;
DOM entry `src/secrets-entry.ts` bundles to `dist/extension/secrets.js` via the
`build-secrets-page` esbuild plugin.

- `vite.config.ts` builds SW, side-panel host, secrets page, preview SW, and
  copied static assets into `dist/extension/`. Rollup `input` is a single
  virtual no-op entry; outputs come from `closeBundle` plugins.
- `manifest.json` ships a stable `key` (production ID fixed). Local debugging
  triggers `Content verify job failed for extension ...`; build with
  `SLICC_EXT_DEV=1` (see commands below) to strip `key`.
- No Helix RUM beacons; hosted leader tab uses webapp telemetry
  (`telemetry.ts:initTelemetry()`).

## MV3 Remote Hosted Code Guard

Chrome Web Store rejects MV3 submissions when its reviewer string-matches a
full third-party CDN URL (even one the runtime overrides).
`packages/dev-tools/tools/check-extension-rhc.sh` scans `dist/extension/` and
exits non-zero if a full `unpkg.com`/`esm.sh`/`cdn.jsdelivr.net/npm` path
appears (bare hostnames allowed). Runs via
`npm run postbuild:check -w @slicc/chrome-extension` and the `chrome-extension`
CI job. Debug: `docs/chrome-extension-details.md`.

## Secret-Aware Fetch Proxy

SW handles `fetch-proxy.fetch` Port connections. Invariant: the `onMessage`
listener attaches **synchronously** in `onConnect` (pipeline awaited inside);
an "await build then add listener" pattern drops immediate `request` messages.

## Local QA, Dev Watch, Smoke Test

Recipe (Chrome for Testing, extension profile, QA scenarios, dev-watch loop,
smoke-test knobs): `docs/extension-thin-bridge.md`. End-to-end smoke
`packages/dev-tools/tools/extension-smoke-test.ts` runs `continue-on-error` in
CI while the thin-bridge replacement lands.

```bash
npm run dev:extension:fresh                              # build + wrangler
SLICC_EXT_DEV=1 npm run build -w @slicc/chrome-extension # fixed extension ID
npm run build -w @slicc/chrome-extension && \
  npm run test:extension-smoke -w @slicc/chrome-extension # smoke after build
```
