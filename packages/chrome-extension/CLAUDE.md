# CLAUDE.md

This file covers the Chrome Manifest V3 float in `packages/chrome-extension/`.

## Scope

`packages/chrome-extension/` contains the manifest, service-worker CDP bridge,
the on-demand cherry side-panel cockpit (`sidepanel.html` +
`sidepanel-entry.ts`), the secrets options page, the preview service worker,
and the device / media popup shells (capture-popup / picker-popup). The webapp
UI and the agent engine load from the hosted leader tab and are NOT bundled
into the extension.

### Permissions

The manifest declares `sidePanel` to enable the Chrome-native per-window
side-panel cockpit. There is no `content_scripts` array in the manifest.

## Thin Bridge Architecture

The extension is a CDP pass-through + bootstrapper. There is no bundled
side-panel UI and no offscreen agent engine — both moved to a pinned hosted
leader tab (`https://www.sliccy.ai/?slicc=leader`).

```text
Hosted leader tab (https://www.sliccy.ai/?slicc=leader)
  webapp UI, kernel worker, orchestrator, VFS, agent shell
        ↑ chrome.runtime.connect({ name: 'slicc.cdp-bridge' })
Service Worker bridge
  service-worker.ts, bridge-sw.ts, chrome.debugger pass-through,
  fetch-proxy backend, mount sign-and-forward backend, secrets storage
        ↑ chrome.runtime.connect({ name: 'cherry-panel' })
Side-panel cockpit (sidepanel.html + sidepanel-entry.ts)
  Iframes the hosted ui-only follower (?cherry=1&ui-only=1),
  connected to the leader over the tray; no CDP target
```

See `docs/architecture.md` "Extension Thin-Bridge Architecture" for the full
cross-origin model. See `docs/extension-thin-bridge.md` for bridge protocol,
toast dedup, QA scenarios, and dev-watch details.

### Responsibilities

- **Service worker** (`src/service-worker.ts`): pins the leader tab,
  opens/focuses the side panel on action-click (`chrome.sidePanel.open`,
  `setPanelBehavior`), accepts the leader's bridge Port via
  `externally_connectable`, pass-through proxies `chrome.debugger` through
  `bridge-sw.ts`, hosts the secret-aware fetch proxy and the S3/DA mount
  sign-and-forward backends, and surfaces SLICC handoff notifications observed
  via `webRequest` (payload-naming toast with origin attribution,
  control-character sanitization, and per-fingerprint session dedup; see
  `docs/extension-thin-bridge.md` "Handoff Toast" for details).
- **Side-panel cockpit** (`sidepanel.html` + `src/sidepanel-entry.ts`):
  on-demand `chrome.sidePanel` surface that iframes the hosted ui-only cherry
  follower (`?cherry=1&ui-only=1`) and runs the tri-state
  (booting → ready → disconnected) controller over a `cherry-panel` Port to
  the service worker.
- **Secrets options page** (`secrets.html` + `src/secrets-entry.ts`): user-
  facing CRUD over `chrome.storage.local` credentials consumed by the SW's
  fetch-proxy and sign-and-forward backends.

### Leader-tab lifecycle

The service worker keeps one pinned tab at the hosted leader URL but does
**not** create it on browser startup — Chrome restores the sticky pinned tab.
`reconcileLeaderTabOnBoot()` runs at top-level (SW-wake hygiene) to clear a
stale stored id. `ensureLeaderTab()` (adopt-or-create + dedup) runs **on
demand** when the icon is clicked or a cherry-panel Port connects. After
restart, the restored leader re-pins itself via **self-adopt**: when no leader
id is stored, a top-frame connection from an allowlisted origin carrying
`?slicc=leader` is accepted and persisted. See
`docs/extension-thin-bridge.md` "Leader-Tab Lifecycle" for the full rationale.

### Tray leader / multi-browser sync

The hosted leader tab is the tray leader — it runs the standard page-side
`LeaderSyncManager` (`packages/webapp/src/ui/page-leader-tray.ts`) exactly
like any other standalone leader. The extension is not in the tray data path
at all: extra browsers join as followers by connecting to the same worker URL
the hosted leader publishes.

## On-Demand Per-Window Cherry Side Panel

Clicking the toolbar icon opens a window-level Chrome side panel
(`sidepanel.html`) — no per-page injection. The panel iframes the hosted
`?cherry=1&ui-only=1` follower and connects to the leader over the tray.

**Framing**: the cloudflare worker sets a `Content-Security-Policy`
`frame-ancestors` header naming the extension origin (`chrome-extension://<id>`).
A bare `*` does not authorize `chrome-extension://` ancestors; there is no
`declarativeNetRequest` framing rule.

**Login hand-off**: provider login runs in the leader tab, not the panel. The
follower detects the side-panel via `location.ancestorOrigins` and shortcuts
onboarding to a "Set up SLICC in the main tab" card; see
`docs/extension-thin-bridge.md` "On-Demand Cherry Side Panel" for the full
six-step flow and tri-state UI details.

## Key Files

- `src/service-worker.ts` — MV3 background bridge + leader-tab lifecycle +
  secret-aware fetch proxy + handoff notifications
- `src/bridge-sw.ts` — `externally_connectable` Port handler that
  pass-through-proxies CDP to `chrome.debugger`. `cdpGetTargets` marks the
  `lastFocusedWindow` active tab so `playwright list-tabs` shows `(active)`
  and cherry prompts can resolve 'this page'.
- `src/sidepanel-entry.ts` — side-panel host controller (bundled to
  `dist/extension/sidepanel.js`): mounts the ui-only cherry follower iframe
  and drives the tri-state UI over a `cherry-panel` Port.
- `src/cherry-panel-sw.ts` — SW-side `cherry-panel` Port hub: tracks panel
  ports, caches/persists the tri-state (`chrome.storage.session`), and
  recovers a dead-tray leader.
- `packages/webapp/src/kernel/messages.ts` — wire-protocol message types
  (extension imports from here).
- `src/tab-group.ts` — persistent Chrome tab group handling.
- `src/secrets-entry.ts` + `src/secrets-storage.ts` — options-page CRUD over
  `chrome.storage.local`.

## Extension Bridge Port Control Messages

The leader tab communicates with the service worker over a long-lived
`chrome.runtime.connect` Port (`name: 'slicc.cdp-bridge'`). Post-handshake
the Port carries: CDP pass-through (`cdp.request/response/event`), handoff
licks (`extension.lick`), open-settings commands (`extension.open-settings`),
and the leader's tray joinUrl (`leader.join-url`). Full protocol details in
`docs/extension-thin-bridge.md` "Bridge Port Control Messages".

## CSP Workarounds

The thin extension runs no dynamic code of its own. Dynamic JS (the JavaScript
tool, `node -e`, `.jsh`, `workflow`), sprinkle/dip rendering, and WASM
(`convert` / `python3` / `ffmpeg`) all execute in the hosted leader tab — a
normal `https://www.sliccy.ai` origin under ordinary web CSP — and its kernel
worker, using the `dist/ui` build. The MV3 sandbox-iframe escapes the fat
extension relied on and all bundled WASM/JS under `dist/extension/` have been
removed.

The only extension-origin surfaces left are the service worker, the side-panel
host, the secrets options page, and the picker/capture popups. For those, load
bundled assets via `chrome.runtime.getURL(...)`.

## Device / Directory Picker Popups

The `mount` / `usb` / `serial` / `hid` shell commands call system choosers
(`showDirectoryPicker` / `navigator.{usb,serial,hid}.request*`), which the
hosted leader tab cannot host reliably under TCC. All four pickers share a
single popup entry point — `picker-popup.html` + `picker-popup.js` —
parameterized by `?kind=directory|usb-device|serial-port|hid-device`. The two
files are copied into `dist/extension/` by the `closeBundle` hook in
`vite.config.ts` (not Rollup `input` entries).

Directory results carry an opaque `{ handleInIdb, idbKey, dirName }` (the popup
stashes the non-postable `FileSystemDirectoryHandle` in the shared
`slicc-pending-mount` IDB store); device results carry identifiers
(`vendorId/productId/serialNumber`) the caller re-acquires via
`navigator.{usb,serial,hid}.getDevices()` in its own realm.

Any change to the `closeBundle` static-asset copy list must keep both
`picker-popup.html` and `picker-popup.js` listed or all four picker windows 404.

## Media Capture (popup grant path)

Camera / microphone / screen capture (`ffmpeg -f avfoundation`,
`screencapture`) work without any new manifest permission:

- **Media capture needs a visible surface**: route the capture through a real
  window — `capture-popup.html` / `capture-popup.js`. The shell command
  (`extension-media-capture.ts:captureViaPopup`) asks the service worker to
  open the popup (`capture-open-window` message → `chrome.windows.create`,
  no permission needed), the
  popup performs the capture and posts the bytes back over `chrome.runtime`
  messaging, and `ffmpeg-command.ts` / `screencapture-command.ts` gate this
  path behind `isExtensionFloat()`. CLI / standalone and the hosted leader tab
  keep their page-served auto-grant path unchanged.

## Runtime Conventions

- **Extension detection**: `typeof chrome !== 'undefined' && !!chrome?.runtime?.id`
- **`window.open()`**: in extension flows it often returns `null`; treat it as
  fire-and-forget, not a failure signal.
- **Persistence**: the hosted leader tab is the source of truth for chat/session
  state. The extension never holds it.
- **CDP access**: only the service worker can call `chrome.debugger`; the hosted
  leader tab reaches it via the `externally_connectable` Port in `bridge-sw.ts`.

## Mount Secrets Options Page

`secrets.html` is the manifest's `options_ui` page. Users reach it via
right-click the toolbar icon → Options, `chrome://extensions` → SLICC →
Extension options, or the in-app `secret edit` terminal command (which opens
the page over `chrome-extension://<id>/secrets.html`). The page reads/writes
`chrome.storage.local` directly (full chrome.\* API access, not sandboxed) and
is the extension-mode equivalent of editing `~/.slicc/secrets.env` in CLI mode.

Pure logic lives in `src/secrets-storage.ts` (testable;
`tests/secrets-storage.test.ts` covers it). The DOM entrypoint
`src/secrets-entry.ts` is bundled to `dist/extension/secrets.js` via the
`build-secrets-page` esbuild plugin in `vite.config.ts`.

## Telemetry

The thin extension does not emit Helix RUM beacons. The service worker is not
instrumented; the hosted leader tab uses the standalone webapp's telemetry path
(`@adobe/helix-rum-js` via `telemetry.ts:initTelemetry()`).

## Build Notes

- `packages/chrome-extension/vite.config.ts` builds the service worker,
  side-panel host, secrets options page, preview service worker, and copied
  static assets (picker/capture popups, toolbar icons/fonts) into
  `dist/extension/`. Rollup's `input` is a single virtual no-op entry — all
  bundled outputs are produced by `closeBundle` esbuild plugins.
- The extension's side-panel host + secrets page consume shared webapp code
  from `packages/webapp/` rather than duplicating core runtime logic.
- `manifest.json` ships a stable `key` (so the production ID is fixed). For
  local debugging that key triggers `Content verify job failed for extension …`
  and the extension refuses to load. Build with
  `SLICC_EXT_DEV=1 npm run build -w @slicc/chrome-extension` to strip `key`
  so Chrome assigns a path-derived ID instead.

## MV3 Remote Hosted Code Guard

Chrome Web Store rejects MV3 submissions when its reviewer string-matches a
full third-party CDN URL in the built bundle (violation reference Blue Argon).
Even a literal that the runtime overrides is enough to fail review.

`packages/dev-tools/tools/check-extension-rhc.sh` scans `dist/extension/`
(recursively, across `.js`/`.html`/`.json`/`.css`, excluding `.map` files) and
exits non-zero if any of these patterns appear:

- `https://unpkg.com/<path>` (scoped or non-scoped)
- `https://esm.sh/<path>`
- `https://cdn.jsdelivr.net/npm/<path>`

Bare hostnames and the host-only form (no path) are allowed.

**Debugging a failure:** the script prints `file:line:URL` for every match.
Open the cited file, find the call site that constructed the URL, and migrate
it to `packages/webapp/src/shell/supplemental-commands/cdn-url-builder.ts` so
only the bare host appears as a string literal and the path is composed at
runtime via `new URL(path, ...)`.

The check runs via `npm run postbuild:check -w @slicc/chrome-extension` and in
the `chrome-extension` CI job.

## Local QA and Dev Watch

For the full manual recipe (Chrome for Testing, extension profile, QA
scenarios) and the dev-watch loop details, see
`docs/extension-thin-bridge.md`.

Quick start:

```bash
# Build and serve (automated — builds webapp if missing, starts wrangler)
npm run dev:extension:fresh

# Or manual build + launch for a fixed extension ID across runs:
SLICC_EXT_DEV=1 npm run build -w @slicc/chrome-extension
# Then follow the Chrome for Testing recipe in docs/extension-thin-bridge.md
```

## Secret-Aware Fetch Proxy

The service worker handles `fetch-proxy.fetch` Port connections for
secret-aware HTTP proxying. Key invariant: the `onMessage` listener attaches
**synchronously** in `onConnect` (the pipeline is awaited inside the listener).
The previous "await build → then add listener" pattern silently dropped
immediate `request` messages. Full handler reference and OAuth-domain extras
in `docs/extension-thin-bridge.md` "Secret-Aware Fetch Proxy".

## Automated CDP Smoke Test

`packages/dev-tools/tools/extension-smoke-test.ts` is the end-to-end
verification script. Run after a fresh extension build:

```bash
npm run build -w @slicc/chrome-extension
npm run test:extension-smoke -w @slicc/chrome-extension
```

The script was written against the legacy fat-extension architecture and runs
with `continue-on-error: true` in CI while the thin-bridge replacement lands.
See `docs/extension-thin-bridge.md` "Automated CDP Smoke Test" for full
details and local debugging knobs.

## Related Guides

- `packages/webapp/CLAUDE.md` — shared browser architecture
- `packages/shared-ts/CLAUDE.md` — secret masking primitives
- `docs/architecture.md` — extension message flow, persistence model, cross-
  origin model (authoritative overview)
- `docs/extension-thin-bridge.md` — bridge protocol, toast dedup, leader-tab
  lifecycle rationale, side-panel flow, dev-watch loop, QA recipe
- `docs/pitfalls.md` — extension-specific gotchas
