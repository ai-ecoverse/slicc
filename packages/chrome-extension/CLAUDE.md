# CLAUDE.md

Chrome Manifest V3 float in `packages/chrome-extension/`.

## Scope

Contains the manifest, service-worker CDP bridge, on-demand cherry side-panel
cockpit (`sidepanel.html` + `sidepanel-entry.ts`), the secrets options page,
the preview service worker, and the device / media popup shells
(capture-popup / picker-popup). Webapp UI and agent engine load from the
hosted leader tab and are NOT bundled into the extension. Manifest declares
`sidePanel`; no `content_scripts`.

## Thin Bridge Architecture

CDP pass-through + bootstrapper. No bundled side-panel UI, no offscreen
engine - both moved to a pinned hosted leader tab
(`https://www.sliccy.ai/?slicc=leader`).

```text
Hosted leader tab (https://www.sliccy.ai/?slicc=leader)
  webapp UI, kernel worker, orchestrator, VFS, agent shell
        ^ chrome.runtime.connect({ name: 'slicc.cdp-bridge' })
Service Worker bridge (service-worker.ts, bridge-sw.ts)
  chrome.debugger pass-through, fetch-proxy backend,
  mount sign-and-forward backend, secrets storage
        ^ chrome.runtime.connect({ name: 'cherry-panel' })
Side-panel cockpit (sidepanel.html + sidepanel-entry.ts)
  Iframes hosted ui-only follower (?cherry=1&ui-only=1)
```

Leader-tab bridge Port (`name: 'slicc.cdp-bridge'`) carries CDP pass-through
(`cdp.request/response/event`), handoff licks (`extension.lick`),
open-settings (`extension.open-settings`), and `leader.join-url`. Hosted
leader tab is the tray leader (page-side `LeaderSyncManager` at
`packages/webapp/src/ui/page-leader-tray.ts`); extension bypasses the tray
data path.

Refs: `docs/architecture.md` (cross-origin);
`docs/extension-thin-bridge.md` (Bridge Port protocol, toast dedup,
dev-watch, QA, side-panel six-step flow, Secret-Aware Fetch Proxy handler,
Smoke Test knobs); `docs/chrome-extension-details.md` (per-surface
responsibilities, leader-tab lifecycle rationale, `bridge-sw.ts` CDP
ownership, picker payload shapes, secrets-page detail, MV3 RHC debug);
`docs/pitfalls.md`; `docs/transcript-export.md`;
`packages/webapp/CLAUDE.md`; `packages/shared-ts/CLAUDE.md`.

### Responsibilities

- **Service worker** (`src/service-worker.ts`): pins the leader tab, opens
  the side panel (`chrome.sidePanel.open`, `setPanelBehavior`), accepts the
  leader's Port via `externally_connectable`, proxies `chrome.debugger`
  through `bridge-sw.ts`, hosts the secret-aware fetch proxy and S3/DA
  mount sign-and-forward backends, surfaces SLICC handoff notifications
  via `webRequest`.
- **Side-panel cockpit** (`sidepanel.html` + `src/sidepanel-entry.ts`):
  on-demand `chrome.sidePanel` surface iframing the hosted ui-only cherry
  follower (`?cherry=1&ui-only=1`); runs the tri-state
  (booting -> ready -> disconnected) controller over a `cherry-panel` Port;
  relays `slicc.focus-leader-tab` as `focus-leader` with
  `openSettings: false`.
- **Secrets options page** (`secrets.html` + `src/secrets-entry.ts`): CRUD
  over `chrome.storage.local`.

### Leader-tab lifecycle

SW keeps one pinned leader tab but does **not** create it on browser
startup - Chrome restores the sticky pinned tab.
`reconcileLeaderTabOnBoot()` runs at top-level (SW-wake hygiene);
`ensureLeaderTab()` (adopt-or-create + dedup) runs **on demand**. After
restart the restored leader re-pins via **self-adopt**: a top-frame
connection from an allowlisted origin carrying `?slicc=leader` is accepted
when no leader id is stored; adoption reloads a discarded/unloaded leader
tab so it can deliver `leader.join-url`.

## On-Demand Per-Window Cherry Side Panel

Toolbar-icon click opens window-level `sidepanel.html` - no per-page
injection. Panel iframes the hosted `?cherry=1&ui-only=1` follower and
connects to the leader over the tray.

**Framing**: cloudflare worker sets `Content-Security-Policy`
`frame-ancestors` naming the extension origin (`chrome-extension://<id>`);
bare `*` does not authorize `chrome-extension://` ancestors; no
`declarativeNetRequest` framing rule.

**Login hand-off**: provider login runs in the leader tab, not the panel;
the follower detects the side-panel via `location.ancestorOrigins` and
shortcuts onboarding to a "Set up SLICC in the main tab" card.

## Key Files

- `src/service-worker.ts` - MV3 background bridge + leader-tab lifecycle +
  secret-aware fetch proxy + handoff notifications.
- `src/bridge-sw.ts` - `externally_connectable` Port handler that
  pass-through-proxies CDP to `chrome.debugger`. Synthetic sessions keep
  `sessionId === targetId` and ref-count duplicate tab attachments;
  disconnect and target close force-release them.
- `src/sidepanel-entry.ts` - side-panel host controller (bundled to
  `dist/extension/sidepanel.js`).
- `src/cherry-panel-sw.ts` - SW-side `cherry-panel` Port hub: caches/persists
  tri-state (`chrome.storage.session`), recovers a dead-tray leader.
- `packages/webapp/src/kernel/messages.ts` - wire-protocol message types.
- `src/secrets-entry.ts` + `src/secrets-storage.ts` - options-page CRUD over
  `chrome.storage.local`.

## CSP Workarounds

Thin extension runs no dynamic code. Dynamic JS (JavaScript tool, `node -e`,
`.jsh`, `workflow`), sprinkle/dip rendering, and WASM (`convert` /
`python3` / `ffmpeg`) execute in the hosted leader tab under ordinary web
CSP. Extension-origin surfaces (SW, side-panel host, secrets page,
picker/capture popups) load bundled assets via `chrome.runtime.getURL(...)`;
no bundled WASM/JS under `dist/extension/`.

## Device / Directory Picker Popups

`mount` / `usb` / `serial` / `hid` shell commands call system choosers
(`showDirectoryPicker` / `navigator.{usb,serial,hid}.request*`) that the
hosted leader tab cannot host reliably under TCC. All four share
`picker-popup.html` + `picker-popup.js` - parameterized by
`?kind=directory|usb-device|serial-port|hid-device`. Both files are copied
into `dist/extension/` by the `closeBundle` hook in `vite.config.ts` (not
Rollup `input` entries); any change must keep both listed or all four
picker windows 404.

## Media Capture (popup grant path)

Camera / mic / screen capture (`ffmpeg -f avfoundation`, `screencapture`)
needs a visible surface: route through `capture-popup.html` /
`capture-popup.js`. `extension-media-capture.ts:captureViaPopup` asks the
SW to open the popup (`capture-open-window` -> `chrome.windows.create`);
popup posts bytes over `chrome.runtime` messaging.
`ffmpeg-command.ts` / `screencapture-command.ts` gate this behind
`isExtensionFloat()`.

## Import Boundary (#2276 slice E)

`src/` must not depend on `packages/webapp/src` at runtime — enforced zero-tolerance by
`check-layer-back-edges.mjs`'s `findChromeExtensionWebappEscapes` (`npm run
lint:layer-back-edges`), which covers quoted, template-literal, and `+`-concatenated
`import()`/`require()` specifiers plus TS triple-slash reference paths. The pure protocol
modules the extension needs (CDP bridge envelope, `LEADER_EXT_ID_QUERY_NAME`, proxy-headers,
discovery/handoff/well-known-probe link extraction, the `cdp/types` `TargetInfo` subset, the
`iframe-repaint.ts` DOM helper) all live in `@slicc/shared-ts` — `@slicc/shared-ts`'s
`tsconfig.json` already includes the `DOM` lib, so a DOM-touching helper is not a barrier to
moving it there too. Webapp keeps thin re-export shims at every original path so no
webapp-internal caller moved.

The one exception: `service-worker.ts`'s `import type { ... } from
'../../webapp/src/kernel/messages.js'` block (12 names). That message-envelope union is core
webapp-internal kernel infrastructure (11+ webapp files use it), not extension-specific —
moving it would invert the dependency for no benefit, because `import type` compiles away
entirely and carries no runtime/bundle coupling. The guard allowlists exactly that one path,
and only as a top-level `import type { ... }` clause — a value import, a mixed `{ type X, Y
}` clause, or a type-only import of any OTHER webapp module all still fail the gate.

## Runtime Conventions

- **Extension detection**: `typeof chrome !== 'undefined' && !!chrome?.runtime?.id`
- **`window.open()`**: often returns `null`; treat fire-and-forget.
- **Persistence**: hosted leader tab is source of truth; extension never
  holds chat/session state.
- **CDP access**: only the SW can call `chrome.debugger`; leader tab reaches
  it via the `externally_connectable` Port in `bridge-sw.ts`.

## Secrets Options Page + Build Notes

`secrets.html` is the manifest's `options_ui` page - extension-mode
equivalent of `~/.slicc/secrets.env`. Pure logic in `src/secrets-storage.ts`
(tested by `tests/secrets-storage.test.ts`); DOM entry `src/secrets-entry.ts`
bundles to `dist/extension/secrets.js` via `build-secrets-page` esbuild
plugin in `vite.config.ts`.

- `packages/chrome-extension/vite.config.ts` builds SW, side-panel host,
  secrets page, preview SW, and copied static assets into `dist/extension/`.
  Rollup `input` is a single virtual no-op entry; outputs come from
  `closeBundle` esbuild plugins.
- `manifest.json` ships a stable `key` (production ID fixed). Local
  debugging triggers `Content verify job failed for extension ...`; build
  with `SLICC_EXT_DEV=1 npm run build -w @slicc/chrome-extension` to strip
  `key`.
- No Helix RUM beacons; hosted leader tab uses standalone webapp telemetry
  (`@adobe/helix-rum-js` via `telemetry.ts:initTelemetry()`).

## MV3 Remote Hosted Code Guard

Chrome Web Store rejects MV3 submissions when its reviewer string-matches
a full third-party CDN URL (violation ref Blue Argon); even a literal the
runtime overrides fails review.
`packages/dev-tools/tools/check-extension-rhc.sh` scans `dist/extension/`
and exits non-zero if `https://unpkg.com/<path>`, `https://esm.sh/<path>`,
or `https://cdn.jsdelivr.net/npm/<path>` appears; bare hostnames allowed.
Runs via `npm run postbuild:check -w @slicc/chrome-extension` and the
`chrome-extension` CI job. Debug + `cdn-url-builder.ts` migration:
`docs/chrome-extension-details.md`.

## Secret-Aware Fetch Proxy

SW handles `fetch-proxy.fetch` Port connections. Key invariant: the
`onMessage` listener attaches **synchronously** in `onConnect` (pipeline
awaited inside); the previous "await build -> add listener" pattern
dropped immediate `request` messages. Handler:
`docs/extension-thin-bridge.md`.

## Local QA, Dev Watch, Smoke Test

Recipe (Chrome for Testing, extension profile, QA scenarios, dev-watch
loop, smoke-test knobs): `docs/extension-thin-bridge.md`. End-to-end smoke
`packages/dev-tools/tools/extension-smoke-test.ts` runs with
`continue-on-error: true` in CI while the thin-bridge replacement lands.

```bash
# Build and serve (automated - builds webapp if missing, starts wrangler)
npm run dev:extension:fresh

# Manual build + launch for a fixed extension ID across runs:
SLICC_EXT_DEV=1 npm run build -w @slicc/chrome-extension

# Smoke test after a fresh extension build
npm run build -w @slicc/chrome-extension
npm run test:extension-smoke -w @slicc/chrome-extension
```
