# Operational Telemetry

Reference for SLICC's Real User Monitoring (RUM) telemetry: how it works, what it sends, and how to verify it. Beacons go to Adobe's Helix RUM endpoint at `https://rum.hlx.page/.rum/<weight>` via `navigator.sendBeacon` — fire-and-forget, sampled, no PII.

## Overview

SLICC runs across three deployment modes (CLI, extension, Electron) and emits RUM beacons from each. The data answers questions like:

- Which deployment mode is most common?
- How many scoops does a typical session create?
- Which LLM providers and models are people using?
- What is the error rate for agent overflows and tool failures?
- Are voice input and skill installation gaining adoption?
- What are the Core Web Vitals for the UI? (CLI/Electron only — the extension doesn't get CWV.)

### Why this approach

- **Lightweight**: sampling-based, zero performance impact on unsampled pageviews.
- **Privacy-first**: no cookies, no PII, per-pageview random ID, opt-out via `localStorage`.
- **Fire-and-forget**: `navigator.sendBeacon` — no response handling, no retries, never blocks the UI.
- **Two implementations behind one API**: CLI/Electron use `@adobe/helix-rum-js` (npm dep) with its auto-loaded enhancer for CWV/auto-click. The Chrome extension uses an inlined `packages/webapp/src/ui/rum.js` (~50 lines, modeled on `@adobe/aem-sidekick`) because the extension manifest CSP blocks the auto-loaded enhancer. See "Integration Approach" for details.
- **Custom checkpoints**: `sampleRUM(checkpoint, {source, target})` is called via thin wrappers (`trackChatSend`, `trackShellCommand`, etc.) in `packages/webapp/src/ui/telemetry.ts`.

## Integration Approach

`packages/webapp/src/ui/telemetry.ts` is a small dispatcher chosen at init time by `getModeLabel()`:

- **CLI / Electron** load `@adobe/helix-rum-js` (npm dep). Helix's auto-loaded enhancer fetches CWV/auto-click instrumentation from `rum.hlx.page` — there is no extension manifest CSP in this mode (it's a regular page served by the dev server in CLI, an Electron BrowserWindow in Electron), so the cross-origin script load and beacon are unrestricted. `window.SAMPLE_PAGEVIEWS_AT_RATE = 'high'` is set before the import — helix interprets `'high'` as 1-in-10 sampling.
- **Extension** loads `packages/webapp/src/ui/rum.js` instead — a self-contained ~50-line beacon that fires `navigator.sendBeacon` to `https://rum.hlx.page/.rum/<weight>` (default weight 10). The inlined approach avoids the auto-loaded enhancer (CSP-blocked by `script-src 'self' 'wasm-unsafe-eval'`) and matches `@adobe/aem-sidekick`'s pattern of bundling a tiny RUM utility into the extension itself.

Both implementations share the `(checkpoint, data)` signature. `window.RUM_GENERATION` is set to `slicc-cli`, `slicc-extension`, or `slicc-electron` so dashboard queries can split by deployment mode.

### Extension debug override

Force 100% sampling in the side panel for verification:

```js
// In side-panel DevTools (right-click panel → Inspect → Console):
localStorage.setItem('slicc-rum-debug', '1');
// Reload the panel. The next pageview is sampled with weight=1.
localStorage.removeItem('slicc-rum-debug');
```

The flag is read by `rum.js` on first call and cached in `window.hlx.rum`. CLI/Electron have no equivalent override.

### Why two implementations

- The extension's manifest CSP and the no-target-page-URL nature of the side panel make the inlined approach simpler and avoid an external script load that would silently 404.
- CLI/Electron benefit from helix-rum-js's enhancer (CWV, auto-click) which is not reproduced manually.
- The cost is a per-mode sampling decision (independent RNG draws) and an `error`-beacon payload-shape asymmetry (see "Wiring status" below).

### Where init happens

- **CLI / Electron**: `packages/webapp/src/ui/main.ts:main()` calls `initTelemetry().catch(() => {})` near the end of bootstrap.
- **Extension**: `packages/webapp/src/ui/main.ts:mainExtension()` calls `initTelemetry().catch(() => {})` after the panel is connected to the offscreen agent engine. Only the side panel realm initializes; the offscreen document and the service worker never call `initTelemetry`.

`navigator.sendBeacon` is available in all three contexts where telemetry initializes. Side-panel close/reopen produces a fresh `initTelemetry` run with a new pageview id — fine because each call generates an independent sampling decision and an independent id.

## Checkpoints

SLICC uses helix-rum-js's supported checkpoint types with SLICC-specific semantics. Custom checkpoint names are not supported by the RUM backend, so we map SLICC events to existing checkpoint types.

### Checkpoint mapping

| RUM Checkpoint | SLICC Meaning      | Source                                    | Target                              | Callsite                                                                    |
| -------------- | ------------------ | ----------------------------------------- | ----------------------------------- | --------------------------------------------------------------------------- |
| `navigate`     | Page load          | `document.referrer`                       | `cli` / `extension` / `electron`    | `telemetry.ts:initTelemetry()`                                              |
| `formsubmit`   | User chat message  | scoop name (`'cone'` for cone scoops)     | model id                            | `chat-panel.ts:ChatPanel.sendMessage()`                                     |
| `fill`         | Shell command      | command name                              | (omitted)                           | `wasm-shell.ts` (panel terminal in extension; both modes in CLI)            |
| `viewblock`    | Sprinkle displayed | sprinkle name                             | (omitted)                           | `sprinkle-manager.ts:open()`                                                |
| `viewmedia`    | Image rendered     | context (`'chat'`)                        | (omitted)                           | `chat-panel.ts` — `MutationObserver` on `messagesEl`                        |
| `error`        | JS error / failure | error type (`'js'` for the auto listener) | sanitized error message (extension) | `telemetry.ts:initTelemetry()` (extension) / helix listeners (CLI/Electron) |
| `signup`       | Settings opened    | trigger (`'button'`)                      | (omitted)                           | `provider-settings.ts:showProviderSettings()`                               |

### Auto-instrumented (from enhancer, CLI/Electron only)

These work out of the box in CLI/Electron with no custom code. They do NOT fire in extension mode (the inlined `rum.js` deliberately omits the enhancer):

- **CWV** (LCP, CLS, INP) -- measures UI responsiveness
- **click** -- tracks user interactions with UI elements

### Wiring status (post-2026-04-29)

- `navigate`, `formsubmit`, `fill`, `viewblock` — wired in both CLI/Electron and extension.
- `signup`, `viewmedia` — newly wired; fire in both modes.
- `error` — fires in both modes, but the **automatic capture path** differs:
  - CLI/Electron: helix-rum-js installs its own `window.error` and `unhandledrejection` listeners and emits its native payload shape.
  - Extension: `telemetry.ts` registers SLICC's listeners after assigning `sampleRUM` from `rum.js`, emitting `{source: 'js', target: sanitizedMessage}`. Sanitization collapses VFS paths to `/<root>/.../` and truncates to 200 characters.
  - Manual `trackError(...)` calls produce the SLICC shape in both modes.
  - Cross-mode error queries should split by `RUM_GENERATION` and treat each shape separately.

### Mode-specific shell-command coverage

`fill` beacons fire from `wasm-shell.ts:679`, which runs in two contexts in the extension: the panel terminal and the offscreen agent shell.

- **CLI / Electron:** both contexts are the same realm; every shell command produces a beacon.
- **Extension:** only the panel-terminal `WasmShell` initializes telemetry. The offscreen agent shell's `trackShellCommand` calls silently no-op. Extension `fill` beacons therefore represent commands the user typed in the panel terminal — not commands the agent ran via its bash tool.

Dashboard readers comparing extension and CLI shell volume should expect this gap.

### `viewmedia` wiring

`trackImageView('chat')` fires once per `<img>` that attaches to `ChatPanel.messagesEl`, captured by a single `MutationObserver` installed in the panel constructor. This catches markdown images (rendered by `message-renderer.ts`), screenshot insertions in chat, and tool-result images — uniformly. UI chrome (avatars, branding, file-browser thumbnails) is excluded because it lives outside `messagesEl`.

### Not instrumented in this iteration

- The offscreen document (`packages/chrome-extension/src/offscreen.ts`). Agent-loop events — turn end, tool-call durations, scoop create/delegate/drop — would require offscreen-side init.
- The extension service worker (`packages/chrome-extension/src/service-worker.ts`). CDP attach/detach, OAuth completion, navigate-licks, tray-socket lifecycle.
- Core Web Vitals in the extension. The helix enhancer that captures CWV cannot run under the extension's CSP, and we do not self-host it here.

These are tracked as future work in `docs/superpowers/specs/2026-04-28-extension-telemetry-design.md`.

## Sampling Strategy

Two independent samplers, one per implementation. Equivalent default rate (1-in-10).

**CLI / Electron (`@adobe/helix-rum-js`):**

`window.SAMPLE_PAGEVIEWS_AT_RATE = 'high'` is set in `initTelemetry()` before the dynamic import. Helix interprets `'high'` as 1-in-10 sampling. Selection is per-pageview and managed inside helix.

**Extension (inlined `rum.js`):**

Default weight 10 (1-in-10). The decision is made on first call and cached on `window.hlx.rum`. Force 100% sampling for the current pageview by setting `localStorage.setItem('slicc-rum-debug', '1')` in side-panel DevTools and reloading; remove the key to revert.

**Opt-out (both modes):**

`localStorage.setItem('telemetry-disabled', 'true')` makes `initTelemetry()` return early — no sampler is loaded, no beacons fire. Cleared with `setTelemetryEnabled(true)` (or by removing the key directly).

## Privacy Considerations

The implementations are privacy-safe by design (no cookies, no PII, ephemeral pageview IDs). SLICC adds the following constraints on top:

1. **No API keys**: never include provider API keys, tokens, or credentials in `source` or `target` fields.
2. **No file contents or filenames**: `viewmedia` and `error` beacons must not leak file paths beyond the root directory. The `error` listener uses `sanitizeError(msg)` (in `telemetry.ts`) which truncates messages to 200 chars and collapses VFS-style paths via the regex `/(\/[a-z]+)(?:\/[^\s/]+)+/gi` → `/<root>/.../`. So `/workspace/skills/foo/bar.ts` becomes `/workspace/.../`.
3. **No chat content**: `formsubmit` logs scoop name and model id, never the message text.
4. **No PII in scoop names**: scoop names are system-generated (e.g. `researcher`, `coder`) or short user-typed labels. They flow through unredacted; if user-typed scoop names ever grow into freeform input, add an explicit sanitizer.
5. **Model IDs only**: model id strings like `claude-sonnet-4` flow through; base URLs and OAuth account details do not.
6. **Opt-out**: `localStorage.setItem('telemetry-disabled', 'true')` disables init entirely. `isTelemetryEnabled()` and `setTelemetryEnabled(boolean)` are exported helpers from `telemetry.ts` for wiring this into a settings UI (the UI control itself is future work).

## Self-Hosting Option (future work)

For deployments that cannot reach `rum.hlx.page` (air-gapped, corporate proxies), SLICC could self-host the collection endpoint. This is **not currently implemented** — neither `rum.js` nor `telemetry.ts` reads `window.RUM_BASE`. Sketch of what it would take:

- **CLI / Electron**: add a `/.rum` proxy in `packages/node-server/src/index.ts` (proxying to `https://rum.hlx.page`) and have `telemetry.ts` set `window.RUM_BASE = window.location.origin + '/.rum'` in the CLI/Electron branch. Helix-rum-js reads `RUM_BASE`.
- **Extension**: `rum.js` currently hard-codes the `https://rum.hlx.page/.rum/<weight>` URL. To self-host, replace the hard-coded URL with a configurable base. A service-worker-side fetch interceptor could rewrite the destination instead, but that adds complexity for small benefit.

If/when this is implemented, update this section.

## Verification

### Manual smoke test (extension)

1. Build the extension: `npm run build -w @slicc/chrome-extension`.
2. Load the unpacked extension from `dist/extension/` in `chrome://extensions`.
3. Open the side panel. Right-click → Inspect to attach DevTools.
4. In the panel's DevTools console, force 100% sampling for the next session:
   ```js
   localStorage.setItem('slicc-rum-debug', '1');
   location.reload();
   ```
5. Open the Network tab and filter by `rum.hlx.page`.
6. Submit a chat message → expect a `formsubmit` beacon.
7. Open settings (gear icon) → expect a `signup` beacon.
8. Open a sprinkle → expect a `viewblock` beacon.
9. Send an assistant message that contains an image (or paste a screenshot) → expect a `viewmedia` beacon.
10. In the panel console, run `window.dispatchEvent(new ErrorEvent('error', { message: 'manual test' }))` → expect an `error` beacon with `target` containing `manual test`.

Then verify opt-out silences everything:

```js
localStorage.setItem('telemetry-disabled', 'true');
location.reload();
```

Repeat actions → expect zero `rum.hlx.page` beacons.

### Manual smoke test (CLI)

1. Run `npm run dev`.
2. Open the SLICC UI in the launched Chrome instance. DevTools → Network → filter `rum.hlx.page`.
3. Repeat: chat send → `formsubmit`; settings open → `signup`; sprinkle open → `viewblock`; chat-image render → `viewmedia`.
4. `error` may also fire from helix's own listeners — either shape (helix-native or SLICC-shape) is acceptable in CLI/Electron.

### Automated tests

Telemetry tests live in `packages/webapp/tests/ui/`:

| File                                  | Coverage                                                                                                                                                                                                                                      |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rum.test.ts`                         | Inlined `rum.js` sampler — selection, debug flag, beacon shape, per-pageview cache, no-throw contract.                                                                                                                                        |
| `telemetry.test.ts`                   | Public `track*` wrappers, `initTelemetry()` dispatcher (CLI branch with `@adobe/helix-rum-js` mock + extension branch with `./rum.js` mock and `chrome.runtime.id` stub), `RUM_GENERATION` per mode, opt-out, extension-only error listeners. |
| `chat-panel-telemetry.test.ts`        | `ChatPanel.sendMessage()` fires `trackChatSend` with the right scoop name and model id; the MutationObserver fires `trackImageView('chat')` per `<img>` attached to the chat tree.                                                            |
| `provider-settings-telemetry.test.ts` | `showProviderSettings()` fires `trackSettingsOpen('button')` on dialog open.                                                                                                                                                                  |

The dispatcher's two branches are tested via separate `describe` blocks — the CLI-branch tests run in default Vitest setup (no `chrome` global, helix mocked at file level), and the extension-branch tests stub `globalThis.chrome` and use `vi.doMock('./rum.js', ...)` after `vi.resetModules()` to override per test.

### Dashboard verification

Once checkpoints are flowing in production, verify in the RUM dashboard (`rum.hlx.page` or Helix RUM Explorer) that:

- Events are attributed to the correct generation (`slicc-cli` / `slicc-extension` / `slicc-electron`).
- Custom checkpoint names appear in the breakdown.
- Source/target fields contain only expected sanitized values.
- No unexpected PII appears in any field.
