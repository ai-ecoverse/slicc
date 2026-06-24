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

Force 100% sampling in the hosted leader tab for verification:

```js
// In the hosted leader tab's DevTools console:
localStorage.setItem('slicc-rum-debug', '1');
// Reload the tab. The next pageview is sampled with weight=1.
localStorage.removeItem('slicc-rum-debug');
```

The flag is read by `rum.js` on first call and cached in `window.hlx.rum`. CLI/Electron have no equivalent override.

### Why two implementations

- The extension's manifest CSP and the hosted-origin (`https://www.sliccy.ai`) leader tab make the inlined approach simpler and avoid an external script load that would silently 404.
- CLI/Electron benefit from helix-rum-js's enhancer (CWV, auto-click) which is not reproduced manually.
- The cost is a per-mode sampling decision (independent RNG draws), an `error`-beacon payload-shape asymmetry (see "Wiring status" below), and the extension has no enhancer-derived checkpoints at all (see "Extension Enhancer Parity Decision" below).

## Extension Enhancer Parity Decision

**Decision (2026-06-14, issue #795 Gap 3): accept the gap.** The extension intentionally emits no enhancer-derived checkpoints (`cwv`, `click`, `loadresource`, `missingresource`, `a11y`, `language`, `enter`, `top`, `redirect`). We do **not** bundle a CSP-safe enhancer, and we do **not** add a manual `web-vitals` integration for the extension panel.

### Why not bundle the helix-rum-enhancer

The extension manifest CSP is `script-src 'self' 'wasm-unsafe-eval'` (`packages/chrome-extension/manifest.json`). `@adobe/helix-rum-enhancer` is fundamentally incompatible with this:

1. Helix-rum-js auto-loads the enhancer by injecting a `<script src="https://rum.hlx.page/.rum/@adobe/helix-rum-enhancer@^2/src/index.js">` tag — blocked by CSP.
2. The enhancer's plugin loader uses `document.currentScript.src` to discover sibling plugins (`/tmp/helix-rum-enhancer/modules/index.js`), which only resolves when the enhancer itself was loaded as an external script. A bundled module has no `currentScript`.
3. The enhancer's `cwv` plugin loads `web-vitals` via a **second** external `<script src="https://rum.hlx.page/.rum/web-vitals/dist/web-vitals.iife.js">` injection — also blocked by CSP.
4. Most enhancer plugins (`form`, `video`, `martech`, `consent`, `redirect`, `onetrust`, `trustarc`, `usercentrics`, `webcomponent`) target content websites and have no meaningful signal for a chat-app shell.

Vendoring the entire enhancer + `web-vitals` + retrofitting plugin discovery against a bundler would be substantial maintenance debt for low-value signal.

### Why not bundle `web-vitals` directly

`web-vitals` (5.3.0, ~13 KB) bundles cleanly and exposes `onLCP` / `onINP` / `onCLS` / `onTTFB` / `onFCP` as ES modules — no external script load required, so the CSP constraint is not the blocker. The blockers are signal quality and architectural fit:

- **LCP / FCP**: the hosted leader tab is a chat-app shell, not a content page. These would mostly measure initial empty-tab render and would not generalize to user-perceived performance.
- **CLS**: dominated by streaming-token reflow and chat-history scroll, swamping any real layout-shift signal.
- **INP**: the only metric with a plausible use case — chat-input latency — but `formsubmit` and `fill` checkpoints already cover those interaction surfaces explicitly, and they carry richer context (scoop name, model id, command name) than a generic INP value.
- **TTFB**: low value for the hosted leader tab — the static webapp shell is served by Cloudflare/CDN, not by an app server we own.
- The **kernel worker is headless** — no DOM, no render — so CWV would only ever apply to the hosted leader tab's page realm, not the agent runtime where most extension activity happens.
- The highest-value piece of the original Gap 3 was the `error` checkpoint, which is **already wired in the extension** via `telemetry.ts`'s window `error`/`unhandledrejection` listeners (extension branch).

### Cross-mode dashboard guidance

- All checkpoints carry `RUM_GENERATION` (`slicc-cli`, `slicc-extension`, `slicc-electron`). Dashboards that query `cwv` MUST filter to `slicc-cli` / `slicc-electron`; querying `cwv` across all generations will show zero events for `slicc-extension` and risk being misread as a regression.
- The same applies to `click`, `loadresource`, and the other enhancer-derived checkpoints listed above.

### Future option (not committed)

If a concrete extension-perf question emerges in production (e.g., the hosted leader tab feeling laggy on chat sends), the smallest sensible addition is a bundled `web-vitals.onINP(…)` call wired through `sampleRUM('cwv', { source: 'inp', target: value })` in the extension branch of `initTelemetry()`. This adds ~3 KB to the bundle and would emit one INP value per leader-tab pageview. Defer until the use case is concrete.

### Where init happens

- **CLI / Electron**: `packages/webapp/src/ui/main.ts:main()` calls `initTelemetry().catch(() => {})` near the end of bootstrap.
- **Extension hosted leader tab**: `packages/webapp/src/ui/main.ts:main()` boots in the pinned hosted leader tab (`https://www.sliccy.ai/?slicc=leader`) and calls `initTelemetry().catch(() => {})` at the end of bootstrap, alongside the standalone CLI / Electron path. The agent's kernel worker spawned by that tab inherits no separate telemetry init — `fill` beacons for agent-initiated bash calls fire from the worker's `AlmostBashShellHeadless` once telemetry is initialized in the page realm. The service worker is not instrumented.

The hosted leader tab is a single realm — it makes one sampling decision and emits one `navigate` beacon per page load. The beacon carries `target: 'extension'` and `referer: 'https://www.sliccy.ai/?slicc=leader'` (or the localhost dev variant). Closing and re-pinning the leader tab produces a fresh init.

`navigator.sendBeacon` is available in all four contexts where telemetry initializes.

## Checkpoints

SLICC uses helix-rum-js's supported checkpoint types with SLICC-specific semantics. Custom checkpoint names are not supported by the RUM backend, so we map SLICC events to existing checkpoint types.

### Checkpoint mapping

| RUM Checkpoint | SLICC Meaning      | Source                                    | Target                              | Callsite                                                                                                                                                       |
| -------------- | ------------------ | ----------------------------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `navigate`     | Page load          | `document.referrer`                       | `cli` / `extension` / `electron`    | `telemetry.ts:initTelemetry()`                                                                                                                                 |
| `formsubmit`   | User chat message  | scoop name (`'cone'` for cone scoops)     | model id                            | `chat-panel.ts:ChatPanel.sendMessage()` — fires only on effective sends (after the empty-and-no-attachments guard, and never while `attachmentReadInProgress`) |
| `fill`         | Shell command      | command name                              | (omitted)                           | `almost-bash-shell.ts` (panel terminal in extension; both modes in CLI)                                                                                        |
| `viewblock`    | Sprinkle displayed | sprinkle name                             | (omitted)                           | `sprinkle-manager.ts:open()`                                                                                                                                   |
| `viewmedia`    | Image rendered     | context (`'chat'`)                        | (omitted)                           | `chat-panel.ts` — `MutationObserver` on `messagesEl`                                                                                                           |
| `error`        | JS error / failure | error type (`'js'` for the auto listener) | sanitized error message (extension) | `telemetry.ts:initTelemetry()` (extension) / helix listeners (CLI/Electron)                                                                                    |
| `signup`       | Settings opened    | trigger (`'button'`)                      | (omitted)                           | `provider-settings.ts:showProviderSettings()`                                                                                                                  |

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

`fill` beacons fire from `almost-bash-shell.ts:679`.

- **CLI / Electron:** every shell command produces a beacon from the single page realm.
- **Extension:** the hosted leader tab is the single page realm; both user-typed terminal commands and agent-initiated bash calls (from the kernel-worker `AlmostBashShellHeadless`, including `agent` scoop delegations from the cone) emit `fill` beacons that share `referer: 'https://www.sliccy.ai/?slicc=leader'` (or the localhost dev variant).

Historical note: prior to the thin-bridge release the extension had two independent realms (chrome-extension://-origin side panel + offscreen document) and `fill` beacons split by `referer` between `index.html` and `offscreen.html`. Dashboards that bucket on that older period will see beacons stamped with the legacy `chrome-extension://` referer values; current data is single-realm under the hosted origin.

### `viewmedia` wiring

`trackImageView('chat')` fires once per `<img>` that attaches to `ChatPanel.messagesEl`, captured by a single `MutationObserver` installed in the panel constructor. This catches markdown images (rendered by `message-renderer.ts`), screenshot insertions in chat, and tool-result images — uniformly. UI chrome (avatars, branding, file-browser thumbnails) is excluded because it lives outside `messagesEl`.

### Not instrumented in this iteration

- The extension service worker (`packages/chrome-extension/src/service-worker.ts`). CDP attach/detach, OAuth completion, navigate-licks, tray-socket lifecycle.
- Custom agent-loop events from the kernel worker — turn end, tool-call durations, explicit scoop create/delegate/drop. The worker's `AlmostBashShellHeadless` now emits `fill` beacons for every bash call (so the cone-side `agent ...` invocations and `feed_scoop` tool calls show up indirectly), but there are no dedicated `agent-spawn` or `scoop-delegate` checkpoints yet.
- Core Web Vitals and other enhancer-derived checkpoints in the extension. See "Extension Enhancer Parity Decision" above for the full rationale; the short version is that CSP makes the auto-loaded enhancer impossible, manual `web-vitals` integration is low-signal for a chat-app shell, and the highest-value piece (`error`) is already wired separately.

## Sampling Strategy

Two independent samplers, one per implementation. Equivalent default rate (1-in-10).

**CLI / Electron (`@adobe/helix-rum-js`):**

`window.SAMPLE_PAGEVIEWS_AT_RATE = 'high'` is set in `initTelemetry()` before the dynamic import. Helix interprets `'high'` as 1-in-10 sampling. Selection is per-pageview and managed inside helix.

**Extension (inlined `rum.js`):**

Default weight 10 (1-in-10). The decision is made on first call and cached on `window.hlx.rum`. Force 100% sampling for the current pageview by setting `localStorage.setItem('slicc-rum-debug', '1')` in the hosted leader tab's DevTools and reloading; remove the key to revert.

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
3. Click the toolbar icon to focus the pinned hosted leader tab. Right-click anywhere in the tab → Inspect to attach DevTools.
4. In the tab's DevTools console, force 100% sampling for the next session:
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
