# CLAUDE.md

This file covers the Chrome Manifest V3 float in `packages/chrome-extension/`.

## Scope

`packages/chrome-extension/` contains the manifest, service-worker
CDP bridge, content-script launcher bootstrapper, the secrets options
page, and the CSP workaround HTML shells (sandbox / sprinkle-sandbox /
tool-ui-sandbox / capture-popup / voice-popup / picker-popup). The
webapp UI and the agent engine load from the hosted leader tab and
are NOT bundled into the extension.

## Thin Bridge Architecture

The extension is a CDP pass-through + bootstrapper. There is no
bundled side-panel UI and no offscreen agent engine — both moved to a
pinned hosted leader tab (`https://www.sliccy.ai/?slicc=leader`).

```text
Hosted leader tab (https://www.sliccy.ai/?slicc=leader)
  webapp UI, kernel worker, orchestrator, VFS, agent shell
        ↑ chrome.runtime.connect({ name: 'bridge.cdp' })
Service Worker bridge
  service-worker.ts, bridge-sw.ts, chrome.debugger pass-through,
  fetch-proxy backend, mount sign-and-forward backend, secrets storage
        ↑ injected by content-script.ts (MAIN world)
Per-page `<slicc-launcher>` overlay
  iframes the hosted webapp inline so any page can drive the agent
```

### Responsibilities

- **Service worker** (`src/service-worker.ts`): pins the leader tab,
  focuses it on action-click, accepts the leader's bridge Port via
  `externally_connectable`, pass-through proxies `chrome.debugger`
  through `bridge-sw.ts`, hosts the secret-aware fetch proxy and the
  S3/DA mount sign-and-forward backends, and surfaces SLICC handoff
  notifications observed via `webRequest`.
- **Content script** (`src/content-script.ts`, MAIN world): registers
  and mounts the `<slicc-launcher>` overlay on every page.
- **Secrets options page** (`secrets.html` + `src/secrets-entry.ts`):
  user-facing CRUD over `chrome.storage.local` credentials consumed
  by the SW's fetch-proxy and sign-and-forward backends.

### Leader tab lifecycle

The service worker keeps one pinned tab at the hosted leader URL.
`reconcileLeaderTabOnBoot()` runs at top-level + `onStartup` +
`onInstalled`, persists the tab id in `chrome.storage.session`, and
re-creates the tab if it was closed. `chrome.action.onClicked` focuses
the leader tab (creating it if missing). `tabs.onRemoved` clears the
stored id when the user closes the leader tab; the next action click
re-creates it.

### Tray leader / multi-browser sync

The hosted leader tab is the tray leader — it runs the standard
page-side `LeaderSyncManager` (`packages/webapp/src/ui/page-leader-tray.ts`)
exactly like any other standalone leader. The extension is not in
the tray data path at all: extra browsers join as followers by
connecting to the same worker URL the hosted leader publishes.

## Launcher Content Script (MAIN World)

The `<slicc-launcher>` overlay is injected into every page by
`src/content-script.ts`, declared in `manifest.json` with
**`"world": "MAIN"`**. Custom-element registries are per-world, and
Chrome 146's content-script ISOLATED world exposes
`customElements` as `null` (not `undefined`), which would make
`@slicc/webcomponents`'s `define()` throw a `TypeError`. Registering and
mounting `<slicc-launcher>` in the page MAIN world is the only way to get
a working upgrade + render.

Trade-off: MAIN-world scripts cannot reach `chrome.runtime` / `chrome.tabs`
/ `chrome.debugger`. That is fine for the pure-UI launcher — it loads
`https://sliccy.ai` by URL in an iframe.

Seam for Wave 3b CDP relay: the relay needs `chrome.runtime` to reach the
service-worker debugger proxy, so it must stay in the default ISOLATED
world. When that ships it will land as a SEPARATE `content_scripts[]`
entry (a second file, e.g. `src/relay-isolated.ts`) — no `world` field,
default ISOLATED, paired with its own esbuild plugin in `vite.config.ts`.
Keeping the two scripts in separate files keeps the launcher's bundle
free of `chrome.runtime` dead code and the relay's bundle free of the
launcher web-component graph.

`define()` in `@slicc/webcomponents/internal/define.ts` additionally
guards `customElements == null` so importing component modules in
registry-less worlds (e.g. a future ISOLATED-world relay that pulls in a
shared util that transitively imports a component) is a no-op rather
than a crash.

## Key Files

- `src/service-worker.ts` — MV3 background bridge + leader-tab lifecycle + secret-aware fetch proxy + handoff notifications
- `src/bridge-sw.ts` — `externally_connectable` Port handler that pass-through-proxies CDP to `chrome.debugger`
- `src/content-script.ts` — MAIN-world `<slicc-launcher>` injector (see section above)
- `src/messages.ts` — typed envelopes for the bridge + CDP traffic
- `src/tab-group.ts` — persistent Chrome tab group handling
- `src/secrets-entry.ts` + `src/secrets-storage.ts` — options-page CRUD over `chrome.storage.local`

The webapp-consumed cross-package helpers `src/offscreen-bridge.ts`,
`src/sprinkle-proxy.ts`, and `src/lick-manager-proxy.ts` remain in
this package because the standalone webapp's kernel-worker and
crontask / webhook commands still import them; they are no longer
loaded into the extension itself.

## CSP Workarounds

- Use `sandbox.html` for dynamic code paths that cannot run directly under extension CSP.
- Use `sprinkle-sandbox.html` for sprinkle panels and dip rendering.
- `tool-ui-sandbox.html` and related HTML shells exist for specialized extension UI surfaces.
- When loading bundled assets, prefer `chrome.runtime.getURL(...)`.
- **External CDN scripts in sprinkles** are fetch-and-inlined by `sprinkle-renderer.ts` (full-doc) or via `sprinkle-fetch-script` parent relay (partial-content). Never use `<script src="https://...">` directly in sandbox HTML.
- **npm packages in `node -e`** are pre-fetched by the per-task realm iframe via `cdn.jsdelivr.net/npm/<id>` + indirect `Function` constructor (the sandbox CSP allows `Function` but not cross-origin `import()`). The realm runtime owns this path now (see `kernel/realm/`), not the legacy inline node-command code. Chrome Web Store MV3 review string-matches full CDN URLs in built JS, so both the inline `sandbox.html` builder and the bundled code construct hosts via the token-array pattern in `packages/webapp/src/shell/supplemental-commands/cdn-url-builder.ts`.
- **Bundled vendor JS (ffmpeg-core)** lives under `dist/extension/vendor/` alongside `pyodide/` and `magick.wasm`. The 112 KB `ffmpeg-core.js` Emscripten glue is copied by the `closeBundle` hook in `vite.config.ts` and loaded via `chrome.runtime.getURL('vendor/ffmpeg-core.js')`; the manifest's `web_accessible_resources` exposes `vendor/*`. The same hook strips the leftover `unpkg.com/@ffmpeg/core@…/ffmpeg-core.js` literal that `@ffmpeg/ffmpeg/dist/esm/const.js` bundles into the output, so the reviewer's substring scan stays clean. The heavy `ffmpeg-core.wasm` binary is NOT bundled and is NOT fetched from a CDN — it must be installed by the user via `ipk add @ffmpeg/core` and is read from VFS `node_modules` through the shared `ipk` resolver (`tryLoadFfmpegCoreFromNodeModules` in `packages/webapp/src/shell/supplemental-commands/ffmpeg-wasm.ts`); uninstalled invocations surface a guidance error. The vendored JS glue stays on `chrome-extension://` so the wrapper worker's `import(coreURL)` resolves same-scheme.
- **Extension-relative scripts** must load statically in `<head>`, not via dynamic `createElement('script').src` (opaque origin blocks runtime loads).
- See `docs/pitfalls.md` "Extension Sandbox: External Scripts & Opaque Origin" for the full reference.

## Device / Directory Picker Popups

The `mount` / `usb` / `serial` / `hid` shell commands call system choosers (`showDirectoryPicker` / `navigator.{usb,serial,hid}.request*`), which the hosted leader tab cannot host reliably under TCC. All four pickers share a single popup entry point — `picker-popup.html` + `picker-popup.js` — parameterized by `?kind=directory|usb-device|serial-port|hid-device`. The two files are copied into `dist/extension/` by the `closeBundle` hook in `vite.config.ts` (not Vite `rollupOptions.input` entries).

The popup runs the chooser on its own button-click gesture (satisfying Chrome's user-gesture rule), then posts `{ source: 'picker-popup', kind, requestId, … }` back via `chrome.runtime` messaging. The page-side launcher is `openPickerPopup(kind, filters, requestId)` in `packages/webapp/src/shell/supplemental-commands/picker-popup.ts`; thin typed adapters (`openMountPickerPopup`, `openUsbPickerPopup`, `openSerialPickerPopup`, `openHidPickerPopup`) wrap it for the existing call sites. Directory results carry an opaque `{ handleInIdb, idbKey, dirName }` (the popup stashes the non-postable `FileSystemDirectoryHandle` in the shared `slicc-pending-mount` IDB store); device results carry identifiers (`vendorId/productId/serialNumber`) the caller re-acquires via `navigator.{usb,serial,hid}.getDevices()` in its own realm.

The cone (agent) path for `usb request` / `serial request` / `hid request` mirrors `mount`'s approval flow: the command surfaces a `showToolUI` approval card in the hosted leader tab's chat (built by `picker-approval.ts`); the user click drives the chooser via dip (`handleDipPickerAction` in `dip.ts`) in standalone or via the unified popup transparent-swap in `tool-ui-renderer.ts` in extension. Any change to the `closeBundle` static-asset copy list must keep both `picker-popup.html` and `picker-popup.js` listed or all four picker windows 404.

## Media Capture (popup grant path)

Camera / microphone / screen capture (`ffmpeg -f avfoundation`, `screencapture`) work without any new manifest permission:

- **Media capture needs a visible surface**: `getUserMedia` / `getDisplayMedia` are gated by a runtime prompt that an invisible context cannot show. Route the capture through a real window — `capture-popup.html` / `capture-popup.js`, modeled on the `voice-popup` pair. The shell command (`extension-media-capture.ts:captureViaPopup`) asks the service worker to open the popup (`capture-open-window` message → `chrome.windows.create`, no permission needed), the popup performs the capture and posts the bytes back over `chrome.runtime` messaging, and `ffmpeg-command.ts` / `screencapture-command.ts` gate this path behind `isExtensionFloat()`. CLI / standalone and the hosted leader tab keep their page-served auto-grant path unchanged.

## Runtime Conventions

- **Extension detection**: `typeof chrome !== 'undefined' && !!chrome?.runtime?.id`
- **`window.open()`**: in extension flows it often returns `null`; treat it as fire-and-forget, not a failure signal.
- **Persistence**: the hosted leader tab is the source of truth for chat/session state. The extension never holds it.
- **CDP access**: only the service worker can call `chrome.debugger`; the hosted leader tab reaches it via the `externally_connectable` Port in `bridge-sw.ts`.

## Mount Secrets Options Page

`secrets.html` is the manifest's `options_ui` page. Users reach it via right-click the toolbar icon → Options, `chrome://extensions` → SLICC → Extension options, or the in-app `secret edit` terminal command (which opens the page over `chrome-extension://<id>/secrets.html`). The page reads/writes `chrome.storage.local` directly (full chrome.\* API access, not sandboxed) and is the extension-mode equivalent of editing `~/.slicc/secrets.env` in CLI mode.

Pure logic lives in `src/secrets-storage.ts` (testable; `tests/secrets-storage.test.ts` covers it). The DOM entrypoint `src/secrets-entry.ts` is bundled to `dist/extension/secrets.js` via the `build-secrets-page` esbuild plugin in `vite.config.ts` — same pattern as `slicc-editor` and `lucide-icons`.

## Telemetry

The thin extension does not emit Helix RUM beacons. The service worker is not instrumented; the hosted leader tab uses the standalone webapp's telemetry path (`@adobe/helix-rum-js` via `telemetry.ts:initTelemetry()`).

## Build Notes

- `packages/chrome-extension/vite.config.ts` builds the service worker, content script, secrets options page, sandbox helpers, and copied static assets into `dist/extension/`. Rollup's `input` is a single virtual no-op entry — all bundled outputs are produced by `closeBundle` esbuild plugins.
- The extension's content-script + secrets page consume shared webapp code from `packages/webapp/` rather than duplicating core runtime logic.
- `manifest.json` ships a stable `key` (so the production ID is fixed). For local debugging that key triggers `Content verify job failed for extension …` and the extension refuses to load. Build with `SLICC_EXT_DEV=1 npm run build -w @slicc/chrome-extension` to strip `key` so Chrome assigns a path-derived ID instead.

## MV3 Remote Hosted Code Guard

Chrome Web Store rejects MV3 submissions when its reviewer string-matches a full third-party CDN URL in the built bundle (violation reference Blue Argon). Even a literal that the runtime overrides — e.g. the `https://unpkg.com/@ffmpeg/core@.../ffmpeg-core.js` baked into `@ffmpeg/ffmpeg`'s worker source — is enough to fail review.

`packages/dev-tools/tools/check-extension-rhc.sh` scans `dist/extension/` (recursively, across `.js`/`.html`/`.json`/`.css`, excluding `.map` files) and exits non-zero if any of these patterns appear:

- `https://unpkg.com/<path>` (scoped or non-scoped — anything followed by a `/<package-path>`)
- `https://esm.sh/<path>`
- `https://cdn.jsdelivr.net/npm/<path>`

Bare hostnames (`unpkg.com`, `esm.sh`, `cdn.jsdelivr.net`) and the host-only form `https://unpkg.com` (no path) are allowed — that's the form the runtime URL builder leaves behind.

The check is wired in two places:

- `npm run postbuild:check -w @slicc/chrome-extension` invokes it from the package
- the `chrome-extension` CI job runs it after `Build extension` in `.github/workflows/ci.yml`

**Debugging a failure:** the script prints `file:line:URL` for every match. Open the cited file, find the call site that constructed the URL, and migrate it to `packages/webapp/src/shell/supplemental-commands/cdn-url-builder.ts` so only the bare host appears as a string literal and the path is composed at runtime via `new URL(path, ...)`.

## Local QA: dedicated profile preinstalled with the extension

Use this when you want a clean Chrome instance running only the unpacked
extension — for example to drive the extension UI alongside a separate
standalone leader. The shared `chrome-launch.ts` helper exposes the
`extension` profile (`npm run dev -- --profile extension`), but that
also boots a node-server. The recipe below runs Chrome standalone.

For a one-command automated alternative, `npm run dev:extension:fresh`
(`packages/dev-tools/tools/dev-extension-fresh.sh`) builds the extension,
**self-builds the leader UI** (`npm run build -w @slicc/webapp`) when
`dist/ui/index.html` is missing, and reuses-or-starts wrangler on `:8787`
to serve it — so the pinned `http://localhost:8787/?slicc=leader` tab no
longer 404s when `dist/ui` was never built. No manual prerequisite build
of the webapp is required.

1. **Build with `SLICC_EXT_DEV=1`** so the manifest key is stripped:

   ```bash
   SLICC_EXT_DEV=1 npm run build -w @slicc/chrome-extension
   ```

2. **Use Chrome for Testing**, not your day-driver Chrome. Chrome
   release builds (>=137) silently drop `--load-extension` unless
   developer mode is already toggled on in the profile, which is awkward
   to seed from CLI. Chrome for Testing accepts the flag without that
   ceremony. The repo's `findChromeExecutable` helper already prefers
   `~/.cache/puppeteer/chrome/mac_arm-*/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`.

3. **Copy `dist/extension/` to a stable scratch path** so multiple runs
   reuse the same path-derived extension ID:

   ```bash
   rm -rf /tmp/slicc-ext-build && cp -r dist/extension /tmp/slicc-ext-build
   ```

4. **Launch Chrome for Testing** with an isolated profile and the
   extension preloaded. `--remote-debugging-port=0` lets Chrome pick a
   free CDP port and write it to `<userDataDir>/DevToolsActivePort`:

   ```bash
   CFT="$HOME/.cache/puppeteer/chrome/mac_arm-146.0.7680.153/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
   EXT="/tmp/slicc-ext-build"
   PROFILE="/tmp/slicc-ext-profile"
   rm -rf "$PROFILE" && mkdir -p "$PROFILE"
   GOOGLE_CRASHPAD_DISABLE=1 "$CFT" \
     --user-data-dir="$PROFILE" \
     --remote-debugging-port=0 \
     --no-first-run \
     --no-default-browser-check \
     --disable-crash-reporter \
     --disable-extensions-except="$EXT" \
     --load-extension="$EXT" \
     "chrome://extensions" &
   ```

5. **Find the extension ID** from CDP — it's path-derived from the
   `--load-extension` argument, so a fixed `EXT` path produces a fixed
   ID across runs:

   ```bash
   CDP=$(cat "$PROFILE/DevToolsActivePort" | head -1)
   curl -sS "http://localhost:$CDP/json/list" \
     | python3 -c 'import json,sys; [print(t["url"]) for t in json.load(sys.stdin) if "service-worker.js" in (t.get("url") or "")]'
   # → chrome-extension://<id>/service-worker.js
   ```

6. **Open the hosted leader tab** — the thin extension's UI lives at
   `https://www.sliccy.ai/?slicc=leader` (or `http://localhost:5710/?slicc=leader`
   when `SLICC_EXT_DEV=1`). The service worker pins it on install, but
   you can drive it directly via CDP:

   ```bash
   curl -sS -X PUT "http://localhost:$CDP/json/new?https://www.sliccy.ai/?slicc=leader"
   ```

   The action-icon path that focuses (or re-creates) that tab requires
   a user gesture, which CDP cannot synthesize headlessly.

### Tear down

```bash
pkill -f "Google Chrome.*slicc-ext-profile"
```

The same `EXT` and `PROFILE` paths can be reused on the next run, but
re-running step 1 + step 3 is the safest way to pick up code changes.

### Thin-extension QA scenarios

Build with `SLICC_EXT_DEV=1` (as above) and launch Chrome for Testing
with the recipe. Then verify each scenario:

1. **Leader tab boots on install.**
   - After Chrome launches with the extension loaded, a pinned tab at
     `https://www.sliccy.ai/?slicc=leader` (or the localhost variant
     in dev) opens automatically.
   - The webapp UI inside that tab is the agent surface.

2. **Toolbar icon focuses the leader.**
   - Click the toolbar icon from any tab → the pinned leader tab
     becomes active in its window.
   - If the leader window is in the background, it foregrounds too.

3. **Closing the leader recreates it.**
   - Close the leader tab.
   - Click the toolbar icon → a fresh pinned leader tab is created
     at the leader URL.

4. **Bridge keeps CDP working after panel close.**
   - With the leader running, drive a `playwright-cli screenshot ...`
     against any tab.
   - Verify `chrome.debugger` attach/detach traffic flows through the
     SW's `bridge-sw.ts` Port (DevTools → Network on the SW shows the
     Port traffic; CDP commands resolve on the leader side).

5. **Per-page launcher injection.**
   - Visit any non-extension page.
   - Confirm the `<slicc-launcher>` overlay is present (DOM inspector
     in the page MAIN world; the launcher iframes the leader UI).

## Dev Watch + Auto-Reload (`npm run dev:extension`)

For the iteration loop, run `npm run dev:extension -w @slicc/chrome-extension` ALONGSIDE the Local QA Chrome (above). The script runs `vite build --watch` with `SLICC_EXT_DEV=1 SLICC_EXT_DEV_WATCH=1` so:

1. **Rebuild on edit** — Rollup re-runs every `closeBundle` hook (the esbuild-managed entries for `content-script`, `service-worker`, `secrets-entry`, `slicc-editor-entry`, `slicc-diff-entry`, `preview-sw`, plus the ffmpeg-core literal strip) on any change under `packages/chrome-extension/src/`. The `dev-reload` plugin registers those paths via `this.addWatchFile` from `buildStart` because Rollup's `build.watch.include` is filter-only and never picks up esbuild inputs that live outside the Rollup module graph.
2. **Sync to the Chrome path** — `closeBundle` overlay-copies `dist/extension/` into `$SLICC_EXT_PATH` (default `/tmp/slicc-ext-build`). Overlay (not `rmSync` then `cpSync`) is deliberate: wiping the destination would briefly remove the manifest under a loaded extension and trigger Chrome to evict the service-worker target the CDP reload that immediately follows would race.
3. **CDP-reload the extension** — connects to Chrome on `$SLICC_CDP_PORT` (default `9333`), finds the unique `*/service-worker.js` target (falls back to any chrome-extension origin page if the SW is idle / evicted — MV3 SWs die after 30s without events and `/json/list` does NOT wake them), and runs a single `chrome.runtime.reload()`. We deliberately do **not** also iterate `chrome.tabs` + `chrome.tabs.reload` from the SW: a tab-reload landing concurrently with the extension restart can leave Chrome with the extension disabled. Refresh open tabs by hand to pick up new content-script code.

The wire stack uses `localhost` (not `127.0.0.1`) for CDP HTTP — Chrome for Testing on macOS binds the listener to IPv6 (`::1`), and forcing IPv4 misses it. Let Node's DNS resolve `localhost` per-platform order.

Failure modes log warnings but never fail the build: if Chrome isn't running, the watcher keeps the build green and the next rebuild attaches automatically once Chrome is up.

Source: `packages/chrome-extension/vite-plugins/dev-reload.ts` (pure helpers tested in `tests/dev-reload.test.ts`). Env overrides: `SLICC_EXT_PATH` (sync destination), `SLICC_CDP_PORT` (Chrome's `--remote-debugging-port`).

## Secret-Aware Fetch Proxy

The service worker handles `fetch-proxy.fetch` Port connections for secret-aware HTTP proxying. The Port `onMessage` listener attaches **synchronously** in `onConnect` (via `handleFetchProxyConnectionAsync` — the pipeline is awaited INSIDE the listener); the previous "await build → then add listener" pattern silently dropped the page's immediate `request` message, which made `curl` hang. See `docs/pitfalls.md` "Chrome Port: onMessage Listener Must Attach Synchronously".

The SW also exposes message handlers:

- `secrets.list-masked-entries` — used by the page's `fetchSecretEnvVars()` to populate the agent shell env with masked values
- `secrets.mask-oauth-token` — round-trip mask for an OAuth provider after `saveOAuthAccount`
- `secrets.list` / `secrets.set` / `secrets.delete` — management ops for the `secret` shell command. Pages other than the extension's own origin can't reach `chrome.storage`, so the hosted leader proxies the storage call through the SW.
- `secrets.session.set` / `secrets.session.list` — in-memory **session-only** secrets held in a module-level `SessionSecretStore` (never written to `chrome.storage`; vanish when the SW is evicted). Layered into every `buildSecretsPipeline()` so the fetch proxy unmasks them like persisted ones. The agent sets these with `secret set <name> <value>` (no sudo prompt).
- `secrets.peek` — returns a redacted preview (first/last chars, middle elided) of a session or persisted value; the full value never leaves the SW.
- `secrets.set-domains` — scope edit (the sudo-gated `secret scope` op); updates a session secret's domains or rewrites a persisted secret's `_DOMAINS` while preserving its value.

The webapp's `createProxiedFetch()` extension branch uses the Port handler instead of direct fetch, providing full secret injection equivalent to CLI mode.

### OAuth-token extra allowed domains

Each provider's hardcoded `oauthTokenDomains` is the immutable default safelist. Users can layer additional allowed domains per-provider via:

- the panel-terminal `oauth-domain` shell command
- the **OAuth domains** tab on the options page (`secrets.html`)
- direct `localStorage` edit of `slicc_oauth_extra_domains` at the extension origin

The extras are read by `saveOAuthAccount` in `provider-settings.ts` and merged with provider defaults (deduped case-insensitively), then sent in the `secrets.mask-oauth-token` SW message — the service worker writes `oauth.<id>.token` + `oauth.<id>.token_DOMAINS` to `chrome.storage.local`. Page-side `oauth-bootstrap` re-pushes the merged list on every leader-tab load, so newly-added extras apply on next leader reload.

## Automated CDP Smoke Test

> **Status.** The script described below was written against the legacy
> fat-extension (offscreen + side-panel) architecture and was retired with
> the thin-bridge strip. CI runs it with `continue-on-error: true` while
> the thin-extension replacement — drive the pinned hosted leader tab via
> the SW's CDP bridge and assert that `ffmpeg -version` / `node -e` still
> route through the bundled vendor JS — is in flight. Treat the recipe
> below as historical context until the replacement lands.

`packages/dev-tools/tools/extension-smoke-test.ts` is the end-to-end
verification that the rebuilt extension actually works in a real Chrome
without remote-code-hosting violations. The npm script
`test:extension-smoke` runs it after a fresh extension build:

```bash
npm run build -w @slicc/chrome-extension
npm run test:extension-smoke -w @slicc/chrome-extension
```

What it does:

1. Verifies `dist/extension/` exists.
2. Launches Chrome for Testing (via `findChromeExecutable`) with a
   disposable user-data-dir and `--load-extension=dist/extension`.
   `--remote-debugging-port=0` lets Chrome pick a free port, discovered
   via `<userDataDir>/DevToolsActivePort`.
3. Resolves the extension ID dynamically from `/json/list`
   (matches the `chrome-extension://<id>/service-worker.js` target).
4. Opens `chrome-extension://<id>/index.html?detached=1` as a regular
   tab so the legacy fat-UI bootstraps in a CDP-reachable target. (This
   step is the part that no longer applies in thin-bridge mode — the
   replacement will instead drive the pinned hosted leader tab.)
5. Installs a tiny in-page bridge via `Runtime.evaluate` that
   synthesizes `TerminalControlMsg` envelopes through
   `chrome.runtime.sendMessage` (the legacy wire format the old
   `TerminalSessionClient` used). The bridge opens one terminal session
   and exposes `window.__sliccSmokeExec(command)`.
6. Runs two scenarios with `Network.requestWillBeSent` capture:
   - **`ffmpeg -version`** — asserts exit 0, output contains
     `ffmpeg version`, no remote `.js` fetches from forbidden hosts
     (`unpkg.com`, `esm.sh`, `cdn.jsdelivr.net`), and
     `ffmpeg-core.js` was loaded from `chrome-extension://<id>/`.
   - **`node -e "..."`** with a `require('lodash')` — asserts exit 0
     and non-empty stdout (validates the `esm.sh` JS-loader path).
7. Tears down Chrome and the tmp profile.

On failure the script prints a per-assertion diagnostic and writes a
full transcript to a temporary file (`smoke artifacts: <path>` is the
last line on stderr). Chrome stderr is captured next to it.

Local debugging knobs:

- `CHROME_PATH=<bin>` override the resolved Chrome executable.
- `SLICC_SMOKE_KEEP_PROFILE=1` skip teardown of the tmp profile.
- `SLICC_SMOKE_TIMEOUT_MS=180000` extend the per-scenario budget.

CI runs the smoke test on Linux under `xvfb-run` (MV3 extensions and the
hosted leader tab both need headed Chrome; `--headless=new` is
incompatible with extension loading in production Chrome). The CI step
is `continue-on-error: true` while the thin-bridge replacement lands —
the artifact stays visible so regressions are obvious without blocking
merges during the rollout.

## Related Guides

- `packages/webapp/CLAUDE.md` for shared browser architecture
- `packages/shared-ts/CLAUDE.md` for secret masking primitives
- `docs/architecture.md` for the detailed extension message flow and persistence model
- `docs/pitfalls.md` for extension-specific gotchas
