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

RUM covers the applications that load the webapp, plus `slicc-cli`, which emits a
much narrower launch/error-only beacon via its own Go client (`packages/go-optel`)
rather than `telemetry.ts` — see "CLI Telemetry" below. The tray hub worker,
swift-server, and the iOS follower emit no beacons at all; see "Deploy-Impact
Signals by Application" at the end of this document.

### Why this approach

- **Lightweight**: sampling-based, zero performance impact on unsampled pageviews.
- **Privacy-first**: no cookies, no PII, per-pageview random ID, opt-out via `localStorage`.
- **Fire-and-forget**: `navigator.sendBeacon` — no response handling, no retries, never blocks the UI.
- **Two implementations behind one API**: CLI/Electron use `@adobe/helix-rum-js` (npm dep) with its auto-loaded enhancer for CWV/auto-click. The Chrome extension uses an inlined `packages/webapp/src/kernel/rum.js` (~50 lines, modeled on `@adobe/aem-sidekick`) because the extension manifest CSP blocks the auto-loaded enhancer. See "Integration Approach" for details.
- **Custom checkpoints**: `sampleRUM(checkpoint, {source, target})` is called via thin wrappers (`trackChatSend`, `trackShellCommand`, etc.) in `packages/webapp/src/kernel/telemetry.ts`.

## Integration Approach

`packages/webapp/src/kernel/telemetry.ts` is a small dispatcher chosen at init time by `getModeLabel()`:

- **CLI / Electron** load `@adobe/helix-rum-js` (npm dep). Helix's auto-loaded enhancer fetches CWV/auto-click instrumentation from `rum.hlx.page` — there is no extension manifest CSP in this mode (it's a regular page served by the dev server in CLI, an Electron BrowserWindow in Electron), so the cross-origin script load and beacon are unrestricted. `window.SAMPLE_PAGEVIEWS_AT_RATE = 'high'` is set before the import — helix interprets `'high'` as 1-in-10 sampling.
- **Extension** loads `packages/webapp/src/kernel/rum.js` instead — a self-contained ~50-line beacon that fires `navigator.sendBeacon` to `https://rum.hlx.page/.rum/<weight>` (default weight 10). The inlined approach avoids the auto-loaded enhancer (CSP-blocked by `script-src 'self' 'wasm-unsafe-eval'`) and matches `@adobe/aem-sidekick`'s pattern of bundling a tiny RUM utility into the extension itself.

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
| `enter`        | Scoop spawned      | scoop folder name                         | `'scoop-spawn'`                     | `scoop-telemetry-hook.ts:emitScoopLifecycle('spawn', ...)` → `telemetry.ts:trackScoopLifecycle()`, called from `scoop-lifecycle-manager.ts`                    |
| `convert`      | Cone fed a scoop   | scoop folder name                         | `'scoop-feed'`                      | `emitScoopLifecycle('feed', ...)`, called from `scoop-message-router.ts`                                                                                       |
| `leave`        | Scoop completed    | scoop folder name                         | `'scoop-complete'`                  | `emitScoopLifecycle('complete', ...)`, called from `scoop-completion-service.ts`                                                                               |

A scoop failure reuses the `error` checkpoint row above rather than getting its own row: `trackScoopLifecycle()` sets `source: 'scoop:<name>'` (not the bare scoop name used by `enter`/`convert`/`leave`) and runs the message through the same `sanitizeError` used for `trackError`, dropping known user-fixable error families (no-api-key, invalid-model, auth-expired) before emitting.

### Auto-instrumented (from enhancer, CLI/Electron only)

These work out of the box in CLI/Electron with no custom code. They do NOT fire in extension mode (the inlined `rum.js` deliberately omits the enhancer):

- **CWV** (LCP, CLS, INP) -- measures UI responsiveness
- **click** -- tracks user interactions with UI elements

### Wiring status (post-2026-04-29)

- `navigate`, `formsubmit`, `fill`, `viewblock` — wired in both CLI/Electron and extension.
- `signup`, `viewmedia` — newly wired; fire in both modes.
- `enter` (scoop spawn) / `convert` (scoop feed) / `leave` (scoop complete) — wired since 2026-06-14 (issue #795 Gap 3 follow-up) via `scoop-telemetry-hook.ts`. Fires in both modes: the hook lives in the worker-safe scoops layer and only needs a sink registered, which `initTelemetry()` does identically for CLI/Electron and extension. Turn-end and per-tool-call-duration checkpoints remain unwired — see "Not instrumented in this iteration" below.
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
- Turn-end and per-tool-call-duration events from the kernel worker. Scoop lifecycle itself (spawn/feed/complete/error) **is** wired — see `enter`/`convert`/`leave` in the checkpoint mapping above, shipped 2026-06-14 via `scoop-telemetry-hook.ts` — but there is no checkpoint yet for a turn finishing or for how long an individual tool call took. The worker's `AlmostBashShellHeadless` emits `fill` beacons for every bash call, so `feed_scoop` tool calls also show up indirectly through that channel.
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

## CLI Telemetry (`slicc-cli`)

`slicc-cli` is a headless Go binary — no `window`, no `localStorage`, no `@adobe/helix-rum-js` — so it does not use `telemetry.ts` at all. It has its own dependency-free Go client, `packages/go-optel` (`github.com/ai-ecoverse/go-optel`), pulled in by `packages/slicc-cli/go.mod` via a local `replace` directive (this monorepo has no `go.work`, so cross-module deps within `packages/` are wired that way). `packages/go-optel` implements the same helix-rum-js wire format as `telemetry.ts` and `packages/swift-optel`, so beacons land in the same collector and JSON shape, just from a third independent client.

### Why this is much narrower than the webapp or swift-optel

A CLI has no UI to click on or navigate, so there is no `click`/`navigate`/CWV equivalent. The intended surface is deliberately two checkpoints only:

- `enter` — process launch. Fires once per invocation from `packages/slicc-cli/telemetry.go:initTelemetry()`, wired into every real subcommand dispatch in `main.go` (`prompt`, `exec`, `watch`, `follow`, `update`). `source` is the subcommand name, allowlisted by `classifySubcommand()` — anything outside the fixed vocabulary (e.g. a typo) is folded into `"unknown"` rather than echoed verbatim.
- `error` — an operational failure (leader dial failure, self-update failure), always via `reportRuntimeError(source, err)` → `optel.Client.ReportError`, never a raw `Sample(Error, ...)` call. `source` is one of a small fixed set (`dial`, `watch`, `follow`, `update`) — never user-typed input.

`referer` is `https://slicc-cli/` (go-optel's `BuildReferer`, mirroring swift-optel's use of a fixed app id in place of a real hostname) — filter dashboards on that host the way webapp dashboards filter on `RUM_GENERATION`.

### Privacy / security: why sanitization is mandatory here

A browser's `error.message` is mostly harmless; a CLI's is not. Go's `net/http`/`net/url` errors embed the full request URL in `Error()` — and `slicc-cli` dials a leader's `https://…/join/<token>` URL, so a raw dial-error string is a bearer-token leak, not just a privacy nit. OS file errors likewise embed the user's home directory (usually containing their login name). `packages/go-optel/sanitize.go`'s `Sanitize()` is the only path from an `error.Error()` string to a beacon field, and `ReportError` is the only sanctioned caller: it collapses any absolute URL to `scheme://host/...` and any absolute path to its first segment/drive letter, **before** truncating to 200 characters, so a leaked fragment can't survive truncation ordering. Application code in `slicc-cli` must always call `reportRuntimeError(...)`, never wire `err.Error()` into a beacon field directly.

### Opt-out, gating, sampling

- **Opt-out**: `SLICC_NO_TELEMETRY=1` disables telemetry outright — no client is configured, no beacon fires.
- **Release-build gating**: telemetry only configures on stamped release builds (`update.IsReleaseVersion(version)`, the same gate the update notifier uses). A `dev` / git-describe local build never phones home, so local development is silent without needing the opt-out env var at all.
- **Sampling**: one coin flip per process (weight 100, i.e. selected by default), decided once inside `optel.Configure()` and reused for every checkpoint in that launch — matching how the webapp/swift-optel decide once per pageview/session rather than per event. `OPTEL_RATE`/`OPTEL_DEBUG` env vars are honored with the same names and semantics as swift-optel.
- **Flush**: `initTelemetry()` returns a bounded flush closure (`defer initTelemetry(sub)()` in `main.go`) that waits up to 2 seconds for in-flight beacon goroutines before the process exits — Go has no `navigator.sendBeacon` guarantee that a fire-and-forget goroutine survives past `main()` returning.

See `packages/go-optel/README.md` and `packages/go-optel/CLAUDE.md` for the library itself, and `packages/slicc-cli/telemetry.go` for the wiring.

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

`slicc-cli`'s beacons are not covered by the table above — they go through `packages/go-optel` (its own Go module, tested by `go test ./...` there: sanitization, sampling, session/env/transport behavior) and `packages/slicc-cli/telemetry_test.go` (subcommand classification, opt-out/release-gating logic, nil-safety, hermetic client configuration — no real network call in any case).

The dispatcher's two branches are tested via separate `describe` blocks — the CLI-branch tests run in default Vitest setup (no `chrome` global, helix mocked at file level), and the extension-branch tests stub `globalThis.chrome` and use `vi.doMock('./rum.js', ...)` after `vi.resetModules()` to override per test.

### Dashboard verification

Once checkpoints are flowing in production, verify in the RUM dashboard (`rum.hlx.page` or Helix RUM Explorer) that:

- Events are attributed to the correct generation (`slicc-cli` / `slicc-extension` / `slicc-electron`).
- Custom checkpoint names appear in the breakdown.
- Source/target fields contain only expected sanitized values.
- No unexpected PII appears in any field.

## Deploy-Impact Signals by Application

Everything above covers the three floats that load `packages/webapp/src/kernel/telemetry.ts`.
The repo ships eight applications; five of them never load it, so "check the RUM
dashboard" is the wrong answer for those. This section is the post-ship lookup table for
the question that actually gets asked: **I just shipped — where do I look to see if it
broke?**

| Application         | Primary deploy-impact signal                                                                            | Ours or Apple/Cloudflare-hosted | Latency to signal                      |
| ------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------- | -------------------------------------- |
| `webapp`            | RUM (`RUM_GENERATION=slicc-cli` / `slicc-electron`), see "Dashboard verification"                       | ours (Helix RUM)                | minutes (sampled)                      |
| `node-server`       | RUM (CLI generation) + `GET /api/status` on the local port                                              | ours                            | immediate / minutes                    |
| `chrome-extension`  | RUM (`RUM_GENERATION=slicc-extension`), no enhancer checkpoints                                         | ours (Helix RUM)                | minutes (sampled)                      |
| `swift-launcher`    | RUM via `@slicc/swift-optel` (`packages/swift-optel/`)                                                  | ours (Helix RUM)                | minutes (sampled)                      |
| `cloudflare-worker` | `GET /status`, Cloudflare Workers metrics, `cloudflare-spend` issue tripwire                            | Cloudflare + ours               | immediate / 1 day                      |
| `swift-server`      | `GET /api/status` + `~/.slicc/logs/slicc-<day>.log`                                                     | local only, never leaves host   | immediate                              |
| `ios-app`           | App Store Connect TestFlight processing state, then TestFlight Crashes & Feedback                       | Apple-hosted                    | minutes / days                         |
| `slicc-cli`         | RUM via `@ai-ecoverse/go-optel` (`packages/go-optel/`) — launch + error only, see "CLI Telemetry" above | ours (Helix RUM)                | minutes (sampled), release builds only |

The four rows below the fold are the ones with no dashboard pointer anywhere else in the
docs. Each gets its own subsection. Where an application genuinely has no signal, that is
stated rather than papered over.

### `cloudflare-worker` (tray hub)

**Liveness, first thing to curl.** `GET https://www.sliccy.ai/status` is a public,
unauthenticated health document — `{ status, service, timestamp, version }`, served by
`handleStaticRoutes` in `packages/cloudflare-worker/src/index.ts` with
`Cache-Control: no-store`. It is advertised by the RFC 8631 `status` rel that
`packages/cloudflare-worker/src/links.ts` puts on every response, and anchored in
`/.well-known/api-catalog` (`packages/cloudflare-worker/src/api-catalog.ts`), so a
consumer walking the rel set can probe liveness without hard-coding the path. Semantics
deliberately mirror node-server's `GET /api/status`
(`packages/node-server/src/index.ts`, advertised via
`packages/node-server/src/links-middleware.ts`) and swift-server's
`GET /api/status` (`packages/swift-server/Sources/Server/APIRoutes.swift`) — same
`{ status, service, timestamp }` core, different `service` identifier per runtime.

`version` is the Cloudflare Worker **version ID** from the `version_metadata` binding
declared in `packages/cloudflare-worker/wrangler.jsonc`. It is the only field that answers
"is the thing I just deployed the thing serving traffic?" — a green deploy log plus a
stale `version` means the deploy did not actually roll. Two non-production caveats:
`wrangler dev` does bind `version_metadata`, but hands out a **locally generated** UUID
that changes every dev session, so a local `version` value carries no information; and in
unit tests the binding is unbound, in which case the field reads `unknown`. Never treat
`unknown` as a failure signal. Nothing else is exposed: no env vars, no binding names, no
account identifiers. Keep it that way — this endpoint is reachable by anyone.

**Request/error/CPU metrics.** Cloudflare dashboard → Workers & Pages → `slicc-tray-hub`
→ Metrics. Requests, error rate, CPU time, and Durable Object duration all live there, and
the same numbers are queryable from the Cloudflare GraphQL Analytics API. This is the only
place a worker 500 becomes visible — the worker emits no RUM.

**The regression alarm is the spend tripwire.**
`.github/workflows/cloudflare-spend-monitor.yml` runs daily at 06:30 UTC (after the UTC
day closes), queries the GraphQL Analytics API for Durable Object duration/requests and
Workers requests, converts them to an estimated USD/day, and opens or comments on a
`cloudflare-spend`-labelled GitHub issue once the estimate passes the `$3/day` default
(override via `vars.CLOUDFLARE_SPEND_THRESHOLD_USD`); it auto-closes the issue when spend
falls back under. The estimator is unit-tested in
`packages/dev-tools/cloudflare-spend-monitor/lib.test.mjs`.

This is worth understanding as an availability signal and not just a cost one: the
worker's expensive failure modes are runaway loops — a leader that reconnects forever, a
follower that polls without backoff, a preview bridge that never closes. Those show up as
a DO-duration spike long before anyone notices a functional regression. The tripwire is,
in practice, the worker's only automated post-deploy alarm.

**Staging goes first — when the job runs.** The `cloudflare-worker` job in
`.github/workflows/ci.yml` deploys `slicc-tray-hub-staging`, and when it does a bad change
is observable on the staging origin before production. Both halves of "when" matter. The
job is behind a `dorny/paths-filter` gate — one of `cloud-core`, `cloudflare-worker`,
`webapp`, `vfs-root`, `assets`, or `root-config` must have changed — so a PR touching
anything else never deploys staging at all. And the deploy steps themselves are guarded by
`(pull_request && head.repo.fork == false) || push`: there is no push-to-main trigger
(`on.push` lists a single automation branch, and main lands via `merge_group`, which that
guard excludes), so in practice staging deploys come from non-fork PRs only. The deploy
steps are `continue-on-error` with retries, so a staging deploy that failed outright still
leaves the job green — read the log, not the check mark.
`packages/cloudflare-worker/tests/deployed.test.ts` is the live-endpoint suite to point at
it (`WORKER_BASE_URL=https://… npm test -- tests/deployed.test.ts` from
`packages/cloudflare-worker/`). Production deploys run through
`.github/workflows/worker.yml`; `.github/workflows/worker-staging.yml` is the manual
staging path. Full runbook — retry logic, routes-only failure classification, R2 archive
mechanics, ghost-leader analysis — is in
[`.agents/skills/deploying-tray-worker/SKILL.md`](../.agents/skills/deploying-tray-worker/SKILL.md)
(`docs/tray-worker-operations.md` is a stub that redirects there).

**Known gap: no retained logs.** `packages/cloudflare-worker/wrangler.jsonc` declares no
`observability` block and no tail worker or Logpush job, so there is no committed log
retention for either environment. Live debugging means `npx wrangler tail` — real time
only, nothing kept, and useless for a failure that already happened. Closing this is a
one-line config change (`"observability": { "enabled": true }` per environment, plus the
retention/sampling settings) and it is the highest-value observability improvement
available to the worker today.

### `swift-server`

**Liveness.** `GET /api/status` on the server's local port returns
`{ status: "ok", service: "slicc-server", timestamp }` with `Cache-Control: no-store`
(`packages/swift-server/Sources/Server/APIRoutes.swift`). The `service` string doubles as
the float fingerprint: the UI floatbar renders "sliccstart" when `slicc-server` answers
and "npx" when node-server's `slicc-node-server` answers. So a wrong floatbar label after
a launcher change is a routing bug, and this endpoint is how you tell which binary is
actually on the port.

**Logs, local only.** `FileLogger`
(`packages/swift-server/Sources/Utilities/FileLogger.swift`, wired up in
`packages/swift-server/Sources/CLI/ServerCommand.swift`) writes one file per day to
`~/.slicc/logs/slicc-<day>.log`, created mode `0600`, with files older than seven days
pruned by `cleanupOldLogs` on rotation. HTTP request lines come from
`packages/swift-server/Sources/Server/RequestLogger.swift`; repeated identical lines are
collapsed by `packages/swift-server/Sources/Utilities/LogDedup.swift`.

**Known gap: nothing is aggregated.** The log never leaves the user's machine, there is no
crash reporter, and swift-server emits no RUM of its own (the RUM signal for the native
stack comes from the launcher via `@slicc/swift-optel`, not from the server process). After
shipping a swift-server change, the realistic loop is: reproduce locally and read
`~/.slicc/logs/`, or wait for a user to paste a log. Treat "did my swift-server change
break someone" as unanswerable from telemetry.

### `ios-app`

`SliccFollower` is distributed through TestFlight, not the App Store, and the post-ship
signals are all Apple-hosted.

**First gate — did Apple accept the build.**
`packages/ios-app/scripts/package-and-upload-testflight.sh` builds and uploads (secrets
provisioned by `packages/ios-app/scripts/setup-testflight-secrets.sh`), and
`packages/ios-app/scripts/check-testflight-status.sh` polls App Store Connect with the
local API key and prints the build's `processingState`: `PROCESSING` (Apple still scanning
and extracting symbols), `VALID` (ready for testers), `INVALID` (bundle rejected — details
arrive by email only), `FAILED`. Run it after every upload; an `INVALID` build never
reaches a tester, and nothing else in the repo will tell you.

**After distribution.** App Store Connect → TestFlight → Crashes and Feedback carries
tester-submitted screenshots and crash logs; Xcode → Window → Organizer → Crashes carries
symbolicated reports for the same builds. Both are read manually in Apple's UIs — no
script in this repo queries either.

**Known gap: no in-app telemetry.** The iOS follower emits no RUM, no analytics, and
integrates no crash-reporting SDK. Apple's crash aggregation only sees crashes, and only
from testers who opted into sharing. A follower that connects but silently fails to render
produces no signal at all; the only channel back to this repo is a human filing an issue.
Adding a crash SDK or wiring the follower into the RUM beacon would be the fix — neither
is committed to.

### `slicc-cli`

**Launch + error telemetry only, opt-out, release builds only.** Since the `go-optel`
client landed (see "CLI Telemetry" above), `slicc-cli` emits an `enter` beacon per launch
and an `error` beacon on a dial/watch/follow/update failure. That is deliberately much
narrower than the webapp: no chat content, no command text, no scoop names — a CLI
touching a leader's bearer-token join URL and the local filesystem has a much sharper
privacy/security overlap than a browser tab, so the checkpoint set stays minimal by
design (see `packages/go-optel/CLAUDE.md`). Dev/git-describe builds never phone home, and
`SLICC_NO_TELEMETRY=1` opts out of a release build too.

What that still leaves uncovered, in descending order of usefulness:

1. **The once-a-day background update notice** (`startUpdateNotice()`, cached at
   `<user-cache-dir>/slicc/update-check.json`, suppressed by `SLICC_NO_UPDATE_CHECK=1`) is
   a best-effort banner check and swallows its own errors silently — it is not wired to
   `reportRuntimeError`. Only the explicit `slicc update` subcommand's fetch/apply
   failures are reported.
2. **GitHub Release asset download counts** for `slicc-<os>-<arch>[.exe]` remain the only
   adoption number independent of telemetry sampling. CLI releases are **sparse** —
   binaries attach only to releases where `packages/slicc-cli` actually changed — so
   compare against the release that carries assets, not `releases/latest`.
3. **Worker traffic on the install and download routes.** `GET /install-cli`,
   `GET /install-cli.ps1`, and `GET /download/slicc-cli/:target`
   (`packages/cloudflare-worker/src/install-cli.ts`) all run through the tray hub, so their
   request and status-code breakdown is visible in the worker's Cloudflare analytics —
   still the fastest signal for a broken release asset, independent of whether any given
   launch happened to sample.
4. **Issue reports.** The actual feedback channel for anything telemetry doesn't capture
   (UX complaints, feature requests, silent hangs with no error).

### Summary of honest gaps

| Application         | Gap                                                                                                                              |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `cloudflare-worker` | No retained logs (`observability` unset in `wrangler.jsonc`); no per-route error alarm                                           |
| `swift-server`      | Logs are local-only; no crash reporter; no remote signal of any kind                                                             |
| `ios-app`           | No in-app telemetry or crash SDK; only Apple-hosted crash reports from opted-in testers                                          |
| `slicc-cli`         | Only `enter`/`error` beacons (sampled, release builds only); the background update-notice check swallows its own errors silently |

Do not add a dashboard link to this table that does not exist. An accurate "no signal
today, nearest proxy is X" is more useful than a plausible-looking URL that nobody can
open.
