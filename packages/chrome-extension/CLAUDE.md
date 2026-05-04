# CLAUDE.md

This file covers the Chrome Manifest V3 float in `packages/chrome-extension/`.

## Scope

`packages/chrome-extension/` contains the extension entry points, manifest, offscreen document, side panel shells, and CSP workarounds that wrap the shared webapp runtime.

## Three-Layer Architecture

The extension keeps the agent alive when the side panel closes by splitting responsibilities across three contexts:

```text
Side Panel (UI)
  offscreen-client.ts, tabbed UI, terminal shell
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
- **npm packages in `node -e`** use esm.sh `?bundle` + indirect Function constructor. Never use `import()` with external URLs in sandbox context.
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

## Related Guides

- `packages/webapp/CLAUDE.md` for shared browser architecture
- `docs/architecture.md` for the detailed extension message flow and persistence model
- `docs/pitfalls.md` for extension-specific gotchas
