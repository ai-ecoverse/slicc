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
- `src/lick-manager-proxy.ts` — panel access to lick operations hosted in offscreen
- `src/sprinkle-proxy.ts` — sprinkle relay between offscreen and panel
- `src/tab-group.ts` — persistent Chrome tab group handling
- `src/tray-socket-proxy.ts` — worker/tray WebSocket proxying

## CSP Workarounds

- Use `sandbox.html` for dynamic code paths that cannot run directly under extension CSP.
- Use `sprinkle-sandbox.html` for sprinkle panels and dip rendering.
- `tool-ui-sandbox.html` and related HTML shells exist for specialized extension UI surfaces.
- When loading bundled assets, prefer `chrome.runtime.getURL(...)`.
- **External CDN scripts in sprinkles** are fetch-and-inlined by `sprinkle-renderer.ts` (full-doc) or via `sprinkle-fetch-script` parent relay (partial-content). Never use `<script src="https://...">` directly in sandbox HTML.
- **npm packages in `node -e`** are pre-fetched by the per-task realm iframe via `cdn.jsdelivr.net/npm/<id>` + indirect `Function` constructor (the sandbox CSP allows `Function` but not cross-origin `import()`). The realm runtime owns this path now (see `kernel/realm/`), not the legacy inline node-command code.
- **Extension-relative scripts** must load statically in `<head>`, not via dynamic `createElement('script').src` (opaque origin blocks runtime loads).
- See `docs/pitfalls.md` "Extension Sandbox: External Scripts & Opaque Origin" for the full reference.

## Dual-Context Shell Model

The extension has **two WasmShell instances**:

- the side panel shell powers the Terminal tab
- the offscreen shell executes agent `bash` tool calls

They share IndexedDB-backed VFS state, but they do **not** share window globals or DOM.

If a shell command needs to affect the panel UI, use the dual-context pattern:

1. try a direct `window.__slicc_*` hook when running in the panel
2. fall back to `chrome.runtime.sendMessage(...)` when running from offscreen

`debug on` is the canonical example of this pattern.

## Runtime Conventions

- **Extension detection**: `typeof chrome !== 'undefined' && !!chrome?.runtime?.id`
- **`window.open()`**: in extension flows it often returns `null`; treat it as fire-and-forget, not a failure signal.
- **Persistence**: offscreen code is the source of truth for chat/session state that must survive panel close/reopen.
- **CDP access**: offscreen documents cannot call `chrome.debugger` directly; always proxy via the service worker.

## Mount Secrets Options Page

`secrets.html` is the manifest's `options_ui` page. Users reach it via right-click the toolbar icon → Options, `chrome://extensions` → SLICC → Extension options, or the side-panel terminal command `secret edit`. The page reads/writes `chrome.storage.local` directly (full chrome.\* API access, not sandboxed) and is the extension-mode equivalent of editing `~/.slicc/secrets.env` in CLI mode.

Pure logic lives in `src/secrets-storage.ts` (testable; `tests/secrets-storage.test.ts` covers it). The DOM entrypoint `src/secrets-entry.ts` is bundled to `dist/extension/secrets.js` via the `build-secrets-page` esbuild plugin in `vite.config.ts` — same pattern as `slicc-editor` and `lucide-icons`.

## Telemetry

The side panel emits Helix RUM beacons via the inlined `packages/webapp/src/ui/rum.js` (extension-only). CLI/Electron use `@adobe/helix-rum-js` instead; the choice is made by `telemetry.ts:initTelemetry()` based on `getModeLabel()`. Offscreen and the service worker are not instrumented. Force 100% sampling for debugging by setting `localStorage.setItem('slicc-rum-debug', '1')` in the side panel's DevTools and reloading. See `docs/operational-telemetry.md`.

## Build Notes

- `packages/chrome-extension/vite.config.ts` builds the side panel UI, service worker, offscreen document, and copied static assets into `dist/extension/`.
- The extension consumes shared browser code from `packages/webapp/` rather than duplicating core runtime logic.
- `manifest.json` ships a stable `key` (so the production ID is fixed). For local debugging that key triggers `Content verify job failed for extension … at path: index.html` and the extension refuses to load. Build with `SLICC_EXT_DEV=1 npm run build -w @slicc/chrome-extension` to strip `key` so Chrome assigns a path-derived ID instead.

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

## Secret-Aware Fetch Proxy

The service worker handles `fetch-proxy.fetch` Port connections for secret-aware HTTP proxying. The Port `onMessage` listener attaches **synchronously** in `onConnect` (via `handleFetchProxyConnectionAsync` — the pipeline is awaited INSIDE the listener); the previous "await build → then add listener" pattern silently dropped the page's immediate `request` message, which made `curl` hang. See `docs/pitfalls.md` "Chrome Port: onMessage Listener Must Attach Synchronously".

The SW also exposes message handlers:

- `secrets.list-masked-entries` — used by the page's `fetchSecretEnvVars()` to populate the agent shell env with masked values
- `secrets.mask-oauth-token` — round-trip mask for an OAuth provider after `saveOAuthAccount`
- `secrets.list` / `secrets.set` / `secrets.delete` — management ops for the panel-terminal `secret` shell command. Offscreen documents don't expose `chrome.storage` (MV3 quirk), so these proxy the storage call through the SW. See `docs/pitfalls.md` "Offscreen Documents: Smaller chrome.\* Surface than the SW".

The webapp's `createProxiedFetch()` extension branch uses the Port handler instead of direct fetch, providing full secret injection equivalent to CLI mode.

### OAuth-token extra allowed domains

Each provider's hardcoded `oauthTokenDomains` is the immutable default safelist. Users can layer additional allowed domains per-provider via:

- the panel-terminal `oauth-domain` shell command
- the **OAuth domains** tab on the options page (`secrets.html`)
- direct `localStorage` edit of `slicc_oauth_extra_domains` at the extension origin

The extras are read by `saveOAuthAccount` in `provider-settings.ts` and merged with provider defaults (deduped case-insensitively) before being pushed to `chrome.storage.local`'s `oauth.<id>.token_DOMAINS`. Page-side `oauth-bootstrap` re-pushes the merged list on every page load, so newly-added extras apply on next side-panel reload.

## Related Guides

- `packages/webapp/CLAUDE.md` for shared browser architecture
- `packages/shared-ts/CLAUDE.md` for secret masking primitives
- `docs/architecture.md` for the detailed extension message flow and persistence model
- `docs/pitfalls.md` for extension-specific gotchas
