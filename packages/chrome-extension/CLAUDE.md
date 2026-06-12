# CLAUDE.md

This file covers the Chrome Manifest V3 float in `packages/chrome-extension/`.

## Scope

`packages/chrome-extension/` contains the extension entry points, manifest, offscreen document, side panel shells, and CSP workarounds that wrap the shared webapp runtime.

## Three-Layer Architecture

The extension keeps the agent alive when the side panel closes by splitting responsibilities across three contexts:

```text
Side Panel (UI)
  offscreen-client.ts, side panel UI, terminal shell
        ↓ chrome.runtime messages
Service Worker Relay
  service-worker.ts, chrome.debugger proxy, tab grouping
        ↓ chrome.runtime messages
Offscreen Document
  offscreen.ts, offscreen-bridge.ts, orchestrator, VFS, agent shell
```

### Responsibilities by layer

- **Side panel**: user-visible UI, terminal tab, reconnect logic.
- **Service worker**: routes messages between panel and offscreen, proxies CDP to `chrome.debugger`.
- **Offscreen document**: runs the agent engine, orchestrator, VFS, and tool execution loop.

### Tray leader

When the user configures a worker base URL with no join URL, offscreen
becomes a tray leader via `extension-leader-tray.ts:startExtensionLeaderTray`.
Mirror of `page-leader-tray.ts` for the offscreen runtime.

- Constructs `LeaderSyncManager` with data-source callbacks against
  `OffscreenBridge` state (chat buffer, scoops, sprinkles snapshot cache).
- `LeaderTrayPeerManager.onPeerConnected → sync.addFollower(bootstrapId, channel, …)` —
  the headline gap fix for #682.
- `webhook.event` control messages route directly to
  `orchestrator.handleWebhookEvent` (no `lick-webhook-event` hop —
  extension's lickManager is in-process).
- Panel-side `PanelLeaderSyncProxy` in `leader-sync-bridge.ts` pushes
  sprinkle snapshots, sprinkle updates, user-message echoes, and
  active-scoop selection. Lifecycle via `leader-mode-changed`;
  `host reset` via `leader-tray-reset` RPC.
- `onFollowerMessage` uses synchronous panel echo (via
  `bridge.notifyPanelIncomingMessage`) because `'web'` is not in
  `EXTERNAL_LICK_CHANNELS` (`lick-formatting.ts:29-37`). Orchestrator
  dispatch runs in a fire-and-forget IIFE so the wire signature stays
  `void`.
- **Lick forwarding**: The follower installs `lickManager.setForwarder((e) => sync.forwardLick(e))` on the offscreen lick manager while connected (cleared on detach). The leader passes the offscreen `lickManager` into `startExtensionLeaderTray` and wires `onForwardedLick → lickManager.emitEvent`. (Standalone bridge messages — `set-follower-forwarding`, `forward-lick`, `inject-forwarded-lick` — are shared via `messages.ts`.)

### Leaving a tray

The offscreen publishes a `globalThis.__slicc_setTrayRuntime(joinUrl,
workerBaseUrl)` hook that the in-offscreen agent shell uses to drive
`syncTrayRuntime` directly — `chrome.runtime.sendMessage` does not
deliver to the sender's own listeners, so the side-panel relay path is
not reachable from the offscreen itself. The `refresh-tray-runtime`
listener and the hook share `applyTrayRuntimeUpdate`. **Leave-entirely
short-circuit**: when `applyTrayRuntimeUpdate(null, null)` runs (both
storage keys cleared) it calls `stopTrayRuntime` directly instead of
awaiting `syncTrayRuntime`, which would otherwise hit the
`defaultWorkerBaseUrl` fallback in `resolveTrayRuntimeConfig` and
silently rebuild a leader on the production worker. See
`packages/webapp/src/scoops/tray-leave.ts` for the float-detecting
helper used by both UI and shell.

## Detached Popout

The extension supports popping the side panel out into a full-page tab
via a "Pop out" button in the side panel header, or by opening
`chrome-extension://<id>/index.html?detached=1` directly.

**Mutual exclusion** is global across all Chrome windows: at most one
detached tab exists at a time, and while it does the side panel is
disabled. The service worker is the sole coordinator and persists
the locked tab ID in `chrome.storage.session`.

**Boot reconciliation:** `reconcileDetachedLockOnBoot()` runs at
top-level + `onStartup` + `onInstalled`, so MV3 SW eviction and
browser cold-start cannot leave the lock half-applied.

**Three-layer mutual exclusion** on the panel side. In code,
`enterDetachedActiveState` executes them in this order:

1. `window.close()` — happy path.
2. `OffscreenClient.setLocked(true)` — short-circuits the private
   `send()` chokepoint so no user-action message reaches offscreen
   even if `window.close()` doesn't take effect. Done BEFORE the
   overlay paints so a still-visible send button can't leak traffic
   in the interim.
3. `Layout.showDetachedActiveOverlay()` — non-dismissible visual
   feedback with a "Close this window" button.

Separately, the SW makes a best-effort `chrome.sidePanel.close({ windowId })`
call per window after broadcasting `detached-active` (Chrome 141+).
This is independent of `enterDetachedActiveState`.

**Non-detached `index.html` tabs** (e.g., the local QA recipe surface)
are treated as side-panel-equivalent: they DO listen for `detached-active`
and self-close, but DO NOT count as the canonical detached tab.

**Spec:** `docs/superpowers/specs/2026-05-13-extension-detached-popout-design.md`.

## Key Files

- `src/service-worker.ts` — MV3 background relay and CDP proxy
- `src/offscreen.ts` — offscreen runtime bootstrap
- `src/offscreen-bridge.ts` — panel/offscreen message bridge
- `src/messages.ts` — typed envelopes for panel, offscreen, and CDP traffic
- `src/lick-manager-proxy.ts` — panel access to lick operations hosted in offscreen. Surfaces cron task + webhook CRUD plus a `getTrayWebhookUrl` resolver so the side-panel `webhook` command can build per-webhook URLs from the active leader tray session.
- `src/sprinkle-proxy.ts` — sprinkle relay between offscreen and panel
- `src/tab-group.ts` — persistent Chrome tab group handling
- `src/tray-socket-proxy.ts` — worker/tray WebSocket proxying

## CSP Workarounds

- Use `sandbox.html` for dynamic code paths that cannot run directly under extension CSP.
- Use `sprinkle-sandbox.html` for sprinkle panels and dip rendering.
- `tool-ui-sandbox.html` and related HTML shells exist for specialized extension UI surfaces.
- When loading bundled assets, prefer `chrome.runtime.getURL(...)`.
- **External CDN scripts in sprinkles** are fetch-and-inlined by `sprinkle-renderer.ts` (full-doc) or via `sprinkle-fetch-script` parent relay (partial-content). Never use `<script src="https://...">` directly in sandbox HTML.
- **npm packages in `node -e`** are pre-fetched by the per-task realm iframe via `cdn.jsdelivr.net/npm/<id>` + indirect `Function` constructor (the sandbox CSP allows `Function` but not cross-origin `import()`). The realm runtime owns this path now (see `kernel/realm/`), not the legacy inline node-command code. Chrome Web Store MV3 review string-matches full CDN URLs in built JS, so both the inline `sandbox.html` builder and the bundled code construct hosts via the token-array pattern in `packages/webapp/src/shell/supplemental-commands/cdn-url-builder.ts`.
- **Bundled vendor JS (ffmpeg-core)** lives under `dist/extension/vendor/` alongside `pyodide/` and `magick.wasm`. The 112 KB `ffmpeg-core.js` Emscripten glue is copied by the `closeBundle` hook in `vite.config.ts` and loaded via `chrome.runtime.getURL('vendor/ffmpeg-core.js')`; the manifest's `web_accessible_resources` exposes `vendor/*`. The same hook strips the leftover `unpkg.com/@ffmpeg/core@…/ffmpeg-core.js` literal that `@ffmpeg/ffmpeg/dist/esm/const.js` bundles into the output, so the reviewer's substring scan stays clean.
- **Extension-relative scripts** must load statically in `<head>`, not via dynamic `createElement('script').src` (opaque origin blocks runtime loads).
- See `docs/pitfalls.md` "Extension Sandbox: External Scripts & Opaque Origin" for the full reference.

## Device / Directory Picker Popups

The `mount` / `usb` / `serial` / `hid` shell commands call system choosers (`showDirectoryPicker` / `navigator.{usb,serial,hid}.request*`), which the side panel cannot host reliably. All four pickers share a single popup entry point — `picker-popup.html` + `picker-popup.js` — parameterized by `?kind=directory|usb-device|serial-port|hid-device`. The two files are copied into `dist/extension/` by the `closeBundle` hook in `vite.config.ts` (not Vite `rollupOptions.input` entries).

The popup runs the chooser on its own button-click gesture (satisfying Chrome's user-gesture rule), then posts `{ source: 'picker-popup', kind, requestId, … }` back via `chrome.runtime` messaging. The page-side launcher is `openPickerPopup(kind, filters, requestId)` in `packages/webapp/src/shell/supplemental-commands/picker-popup.ts`; thin typed adapters (`openMountPickerPopup`, `openUsbPickerPopup`, `openSerialPickerPopup`, `openHidPickerPopup`) wrap it for the existing call sites. Directory results carry an opaque `{ handleInIdb, idbKey, dirName }` (the popup stashes the non-postable `FileSystemDirectoryHandle` in the shared `slicc-pending-mount` IDB store); device results carry identifiers (`vendorId/productId/serialNumber`) the caller re-acquires via `navigator.{usb,serial,hid}.getDevices()` in its own realm.

The cone (agent) path for `usb request` / `serial request` / `hid request` mirrors `mount`'s approval flow: the command surfaces a `showToolUI` approval card in chat (built by `picker-approval.ts`); the user click drives the chooser via dip (`handleDipPickerAction` in `dip.ts`) in standalone or via the unified popup transparent-swap in `tool-ui-renderer.ts` in extension. Any change to the `closeBundle` static-asset copy list must keep both `picker-popup.html` and `picker-popup.js` listed or all four picker windows 404.

## Dual-Context Shell Model

The extension has **two AlmostBashShell instances**:

- the side panel shell powers the Terminal tab
- the offscreen shell executes agent `bash` tool calls

They share IndexedDB-backed VFS state, but they do **not** share window globals or DOM.

If a shell command needs to affect the panel UI, use the dual-context pattern:

1. try a direct `window.__slicc_*` hook when running in the panel
2. fall back to `chrome.runtime.sendMessage(...)` when running from offscreen

No supplemental command currently uses this exact hook+relay shape — the previous example (`debug-command.ts`) was removed when Terminal/Memory became unconditional in the rail. The sprinkle subsystem solves a related problem with a proxy-interface approach (`globalThis.__slicc_sprinkleManager` published in both realms with different implementations, dispatching `sprinkle-op` request/response RPCs); see `docs/pitfalls.md` "Extension Dual-Shell Context" for the full reference.

## Media Capture (offscreen reasons + popup grant path)

Camera / microphone / screen capture (`ffmpeg -f avfoundation`, `screencapture`) work without any new manifest permission:

- **Offscreen reasons, not permissions**: the offscreen document is created with `reasons: ['WORKERS', 'USER_MEDIA', 'DISPLAY_MEDIA']` (`service-worker.ts`). These are arguments to `chrome.offscreen.createDocument` — **not** manifest `permissions` — so the Web Store permission-justification dashboard does not apply to them. They let the offscreen document touch `navigator.mediaDevices` (e.g. `enumerateDevices`).
- **Media capture needs a visible surface**: `getUserMedia` / `getDisplayMedia` are gated by a runtime prompt that an invisible offscreen document (and the side panel) cannot show. Route the capture through a real window — `capture-popup.html` / `capture-popup.js`, modeled on the `voice-popup` pair. The shell command (`extension-media-capture.ts:captureViaPopup`) asks the service worker to open the popup (`capture-open-window` message → `chrome.windows.create`, no permission needed), the popup performs the capture and posts the bytes back over `chrome.runtime` messaging, and `ffmpeg-command.ts` / `screencapture-command.ts` gate this path behind `isExtensionFloat()`. CLI / standalone keep their page-served auto-grant path unchanged.

## Runtime Conventions

- **Extension detection**: `typeof chrome !== 'undefined' && !!chrome?.runtime?.id`
- **`window.open()`**: in extension flows it often returns `null`; treat it as fire-and-forget, not a failure signal.
- **Persistence**: offscreen code is the source of truth for chat/session state that must survive panel close/reopen.
- **Per-scoop buffer eviction**: `OffscreenBridge.messageBuffers` holds full chat transcripts (tool results included) per scoop jid. Eviction rides the orchestrator's `onScoopUnregistered` callback, so programmatic scoop teardown (ephemeral `agent` spawns, the cone's `drop_scoop`, workflow subagents) frees the buffer and deletes the dead `session-<folder>` UI session — not only the panel's `scoop-drop` message path. Skipping this eviction is a memory leak that scales 1:1 with tool output.
- **Transcript size caps**: `onToolStart`/`onToolEnd` route tool inputs/results through `packages/webapp/src/scoops/transcript-limits.ts` (64 KB per text field) so the cone's session-lifetime buffer — which compaction never trims — cannot grow ~1:1 with tool traffic. Buffered results strip inline `<img:data:…>` screenshot markers (the panel never persists them either); emitted events keep markers WHOLE so live screenshot extraction still works. The canonical agent history is never capped.
- **CDP access**: offscreen documents cannot call `chrome.debugger` directly; always proxy via the service worker.

## Mount Secrets Options Page

`secrets.html` is the manifest's `options_ui` page. Users reach it via right-click the toolbar icon → Options, `chrome://extensions` → SLICC → Extension options, or the side-panel terminal command `secret edit`. The page reads/writes `chrome.storage.local` directly (full chrome.\* API access, not sandboxed) and is the extension-mode equivalent of editing `~/.slicc/secrets.env` in CLI mode.

Pure logic lives in `src/secrets-storage.ts` (testable; `tests/secrets-storage.test.ts` covers it). The DOM entrypoint `src/secrets-entry.ts` is bundled to `dist/extension/secrets.js` via the `build-secrets-page` esbuild plugin in `vite.config.ts` — same pattern as `slicc-editor` and `lucide-icons`.

## Telemetry

Both the side panel AND the offscreen document emit Helix RUM beacons via the inlined `packages/webapp/src/ui/rum.js` (extension-only). CLI/Electron use `@adobe/helix-rum-js` instead; the choice is made by `telemetry.ts:initTelemetry()` based on `getModeLabel()`. The two extension realms are independent — the panel captures user-typed shell commands and chat sends; the offscreen realm captures the agent's bash tool calls (including `agent` scoop delegations from the cone, which is why this realm needs telemetry to track delegation activity). The service worker is not instrumented. Force 100% sampling for debugging by setting `localStorage.setItem('slicc-rum-debug', '1')` in DevTools for the realm you want to debug (side panel inspect, or right-click → Inspect on `chrome-extension://<id>/offscreen.html`) and reloading. See `docs/operational-telemetry.md`.

## Build Notes

- `packages/chrome-extension/vite.config.ts` builds the side panel UI, service worker, offscreen document, and copied static assets into `dist/extension/`.
- The extension consumes shared browser code from `packages/webapp/` rather than duplicating core runtime logic.
- `manifest.json` ships a stable `key` (so the production ID is fixed). For local debugging that key triggers `Content verify job failed for extension … at path: index.html` and the extension refuses to load. Build with `SLICC_EXT_DEV=1 npm run build -w @slicc/chrome-extension` to strip `key` so Chrome assigns a path-derived ID instead.

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

6. **Open the side panel UI** by navigating directly to
   `chrome-extension://<id>/index.html` in a tab — the side panel runs
   the same `index.html`, so you can drive it via CDP exactly like a
   normal page:

   ```bash
   curl -sS -X PUT "http://localhost:$CDP/json/new?chrome-extension://<id>/index.html"
   ```

   The real Chrome side panel only opens via a user gesture on the
   extension icon, which CDP cannot synthesize headlessly.

### Tear down

```bash
pkill -f "Google Chrome.*slicc-ext-profile"
```

The same `EXT` and `PROFILE` paths can be reused on the next run, but
re-running step 1 + step 3 is the safest way to pick up code changes.

### Detached popout QA scenarios

Build with `SLICC_EXT_DEV=1` (as above) and launch Chrome for Testing
with the recipe. Then verify each scenario:

1. **Click popout button from side panel.**
   - Side panel header shows "Pop out" button.
   - Click → new tab opens at
     `chrome-extension://<id>/index.html?detached=1`.
   - Side panel closes itself.
   - Chat history is intact in the detached tab.

2. **Toolbar icon while detached open.**
   - Click toolbar icon → existing detached tab focuses, side panel
     does NOT open.
   - If detached tab is in another window, the window also focuses.

3. **Close detached → return to side panel.**
   - Close the detached tab.
   - Click toolbar icon → side panel opens normally.

4. **Direct URL access.**
   - Paste `chrome-extension://<id>/index.html?detached=1` into a new
     tab.
   - It boots into detached mode and locks the side panel.

5. **Reload detached tab.**
   - Ctrl-R the detached tab.
   - It rehydrates into detached mode (idempotent claim, no extra tabs).

6. **Browser restart with "Continue where you left off."**
   - Close all Chrome for Testing windows with the detached tab open.
   - Relaunch.
   - When the restored detached tab activates, the lock re-applies.
   - Verify the discarded-state caveat: if Chrome restores the tab as
     discarded, side panel may briefly be available; once the user
     focuses the detached tab, lock applies.

7. **Drag detached tab to a new window.**
   - Drag tab out of its window.
   - In the new window, click the toolbar icon → existing detached
     tab focuses (in the other window).

8. **Extension-page capability differences.**
   - In the detached tab, run a mount command that uses
     `showDirectoryPicker()` (e.g., `mount /workspace/scratch`).
     Verify it works under a normal tab gesture context, since the
     detached tab is a normal tab not a side panel.
   - Verify mic/voice input behaves the same as in the side panel
     (or note differences for follow-up).

9. **Tray runtime config survives popout.**
   - In the side panel, configure tray runtime (paste join URL).
   - Click popout.
   - In the detached tab, verify the tray runtime is still connected
     and `refresh-tray-runtime` relays work.

## Secret-Aware Fetch Proxy

The service worker handles `fetch-proxy.fetch` Port connections for secret-aware HTTP proxying. The Port `onMessage` listener attaches **synchronously** in `onConnect` (via `handleFetchProxyConnectionAsync` — the pipeline is awaited INSIDE the listener); the previous "await build → then add listener" pattern silently dropped the page's immediate `request` message, which made `curl` hang. See `docs/pitfalls.md` "Chrome Port: onMessage Listener Must Attach Synchronously".

The SW also exposes message handlers:

- `secrets.list-masked-entries` — used by the page's `fetchSecretEnvVars()` to populate the agent shell env with masked values
- `secrets.mask-oauth-token` — round-trip mask for an OAuth provider after `saveOAuthAccount`
- `secrets.list` / `secrets.set` / `secrets.delete` — management ops for the panel-terminal `secret` shell command. Offscreen documents don't expose `chrome.storage` (MV3 quirk), so these proxy the storage call through the SW. See `docs/pitfalls.md` "Offscreen Documents: Smaller chrome.\* Surface than the SW".
- `secrets.session.set` / `secrets.session.list` — in-memory **session-only** secrets held in a module-level `SessionSecretStore` (never written to `chrome.storage`; vanish when the SW is evicted). Layered into every `buildSecretsPipeline()` so the fetch proxy unmasks them like persisted ones. The agent sets these with `secret set <name> <value>` (no sudo prompt).
- `secrets.peek` — returns a redacted preview (first/last chars, middle elided) of a session or persisted value; the full value never leaves the SW.
- `secrets.set-domains` — scope edit (the sudo-gated `secret scope` op); updates a session secret's domains or rewrites a persisted secret's `_DOMAINS` while preserving its value.

The webapp's `createProxiedFetch()` extension branch uses the Port handler instead of direct fetch, providing full secret injection equivalent to CLI mode.

### OAuth-token extra allowed domains

Each provider's hardcoded `oauthTokenDomains` is the immutable default safelist. Users can layer additional allowed domains per-provider via:

- the panel-terminal `oauth-domain` shell command
- the **OAuth domains** tab on the options page (`secrets.html`)
- direct `localStorage` edit of `slicc_oauth_extra_domains` at the extension origin

The extras are read by `saveOAuthAccount` in `provider-settings.ts` and merged with provider defaults (deduped case-insensitively), then sent in the `secrets.mask-oauth-token` SW message — the service worker (which owns `chrome.storage`; `oauth-token` runs in the offscreen document, which has none — #847) writes `oauth.<id>.token` + `oauth.<id>.token_DOMAINS`. Page-side `oauth-bootstrap` re-pushes the merged list on every page load, so newly-added extras apply on next side-panel reload.

## Automated CDP Smoke Test

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
   tab so the side-panel UI bootstraps in a CDP-reachable target.
5. Installs a tiny in-page bridge via `Runtime.evaluate` that
   synthesizes `TerminalControlMsg` envelopes through
   `chrome.runtime.sendMessage` (same wire format as the panel's own
   `TerminalSessionClient`). The bridge opens one terminal session and
   exposes `window.__sliccSmokeExec(command)`.
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

CI runs the smoke test on Linux under `xvfb-run` (MV3 side panels need
headed Chrome; `--headless=new` is incompatible with extension loading
in production Chrome). The CI step is `continue-on-error: true` while
the `ffmpeg-core.js` bundling work lands — the artifact stays visible
so regressions are obvious without blocking merges during the rollout.

## Related Guides

- `packages/webapp/CLAUDE.md` for shared browser architecture
- `packages/shared-ts/CLAUDE.md` for secret masking primitives
- `docs/architecture.md` for the detailed extension message flow and persistence model
- `docs/pitfalls.md` for extension-specific gotchas
