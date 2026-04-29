# Extension Telemetry — Side-Panel Helix RUM

**Status:** Design — pending review
**Date:** 2026-04-28
**Branch:** `extension-rum`

## Goal

Make the SLICC Chrome extension's side panel emit Helix RUM beacons in the same minimal beacon-only fashion as `@adobe/aem-sidekick`. Six checkpoint types fire from the panel realm. Two coupled changes:

1. **Add an inlined `rum.js`** (~50 lines, modeled on `aem-sidekick/src/extension/utils/rum.js`) and use it in **extension mode only**. CLI and Electron continue to use `@adobe/helix-rum-js` so they keep the enhancer's CWV/auto-click instrumentation. `telemetry.ts` becomes a small dispatcher that picks the implementation by `getModeLabel()` at init time.
2. **Finish wiring the three previously-declared-but-dead `track*` functions** (`trackImageView`, `trackSettingsOpen`, `trackError`) at panel-realm callsites in shared UI code. These wirings fire in **both** CLI/Electron and extension — they're the natural completion of the existing telemetry contract, gated only by the existing `telemetry-disabled` opt-out.

The public API in `packages/webapp/src/ui/telemetry.ts` (`trackChatSend`, `trackShellCommand`, etc.) is unchanged. Existing callsites keep working without edits except for one move (see "Why move trackChatSend").

## What changes for CLI

The user-visible CLI behavior is preserved with two small additions:

- **Same library** — CLI/Electron keep `@adobe/helix-rum-js` and its auto-loaded enhancer (CWV, auto-click). No regression.
- **Same sampling** — CLI keeps `window.SAMPLE_PAGEVIEWS_AT_RATE = 'high'` as today.
- **trackChatSend code location moves** from `orchestrator.ts:1065` into the existing private `sendMessage()` method on `chat-panel.ts`. Same beacon, same data, different source file — the new callsite is a single hook inside the method that every send path already funnels through (button, keyboard, programmatic), so there is no risk of duplicate beacons. Behaviorally a no-op in CLI; necessary for extension. (See "Why move trackChatSend".)
- **Two new beacons start firing in CLI**: `signup` (settings opened) and `viewmedia` (chat image rendered). These were previously declared in `telemetry.ts` but never wired. CLI gains them as a free upgrade.
- **No new automatic `error` beacons in CLI**. Helix-rum-js already registers its own `error` and `unhandledrejection` listeners for selected sessions and emits helix-shaped `error` beacons — that pre-existing behavior is unchanged. SLICC's new `trackError(...)` wrapper exists in CLI as well, but is only attached to automatic listeners in the extension branch (where helix is not in play). Manual `trackError(...)` calls from any code path still fire in both modes.

The extension-specific changes (inlined `rum.js`, mode dispatch, `RUM_GENERATION` per mode, localStorage debug flag) are isolated to the extension code path and do not affect CLI runtime.

## Out of scope

This iteration deliberately excludes:

- **Offscreen-realm telemetry.** The agent engine runs in `packages/chrome-extension/src/offscreen.ts`. It is intentionally not instrumented here. Existing `track*` calls that happen to run from offscreen (e.g. `trackShellCommand` in `wasm-shell.ts` when invoked by the agent's bash tool) become deliberate no-ops because telemetry initializes only in the panel.
- **Service-worker telemetry.** CDP attach/detach, OAuth flows, navigate-licks, and tray-socket lifecycle events fire from `packages/chrome-extension/src/service-worker.ts`. None of them get beacons.
- **Agent-loop spans.** Per-tool-call latency, per-turn duration, scoop-creation/delegation lifecycle. These would require offscreen instrumentation.
- **Core Web Vitals enhancer.** `@adobe/helix-rum-enhancer` auto-loads CWV/click tracking from `rum.hlx.page`, which is blocked by the extension CSP. We are not self-hosting it; we don't need it.

These can be follow-up specs if the basic pipeline proves out.

## Reference: aem-sidekick

Aem-sidekick's RUM implementation is the model. Two files are load-bearing:

- `src/extension/utils/rum.js` — self-contained sampleRUM, ~50 lines, no npm dep, fires `navigator.sendBeacon` to `https://rum.hlx.page/.rum/<weight>`.
- `src/extension/manifest.json` — exposes `utils/rum.js` in `web_accessible_resources` so it can be dynamically `import()`ed into target-page contexts via `chrome.scripting.executeScript` for context-menu actions.

Twenty distinct `target` values are emitted across the extension; almost all are `click`, plus one `top` per session. No agent-loop tracking. Beacon-only, fire-and-forget.

## Architecture

```
packages/webapp/src/ui/
  rum.js               (NEW)      Self-contained beacon, ~50 LOC, modeled on aem-sidekick.
                                  Dynamic-imported by telemetry.ts in EXTENSION MODE ONLY.
  telemetry.ts         (MODIFIED) initTelemetry() branches on getModeLabel():
                                    extension → import './rum.js' (default export)
                                    cli/electron → import '@adobe/helix-rum-js' (named sampleRUM)
                                  Sets window.RUM_GENERATION = 'slicc-' + mode for both branches.
                                  Sets SAMPLE_PAGEVIEWS_AT_RATE = 'high' only in CLI/Electron branch
                                  (unchanged from today).
  chat-panel.ts        (MODIFIED) trackChatSend moves here from orchestrator.ts —
                                  single hook inside the existing private sendMessage()
                                  method (all send paths — button, keyboard, programmatic —
                                  already funnel through it).
  provider-settings.ts (MODIFIED) trackSettingsOpen wired at dialog-open.
  message-renderer.ts  (MODIFIED) trackImageView wired when chat-message images render.
  main.ts              UNCHANGED  initTelemetry() call sites stay where they are (lines
                                  773 and 2408). The window error/unhandledrejection
                                  listeners live inside telemetry.ts (extension branch
                                  only) — see "telemetry.ts — automatic trackError" for rationale.

packages/webapp/src/scoops/
  orchestrator.ts      (MODIFIED) trackChatSend call at line 1065 removed
                                  (it was a no-op in extension anyway; the panel-side
                                  callsite covers both modes).

packages/webapp/package.json
                       UNCHANGED  @adobe/helix-rum-js stays as a dep.

packages/webapp/tests/ui/
  rum.test.ts          (NEW)      Unit tests for the inlined rum.js (extension path).
  telemetry.test.ts    (MODIFIED) Tests cover both branches: existing tests assert the
                                  CLI/Electron branch (mocking @adobe/helix-rum-js, no
                                  chrome global). New tests set chrome.runtime.id and
                                  mock ./rum.js to assert the extension branch.

packages/chrome-extension/CLAUDE.md
                       (MODIFIED) One-line pointer noting the panel emits RUM via the
                                  inlined rum.js (different from CLI which uses helix-rum-js).

docs/operational-telemetry.md
                       (MODIFIED) Updates extension section: extension uses inlined rum.js
                                  for the side panel only; CLI/Electron continue with
                                  helix-rum-js. Explicit "offscreen and SW are not
                                  instrumented in this iteration" note. Documents the
                                  fill-beacon asymmetry (see "Why trackShellCommand stays put").
```

`rum.js` is JavaScript (not TypeScript) on purpose — it is a verbatim port of aem-sidekick's pattern, stays under 50 lines, and is easier to audit against the upstream source.

## The six beacons

| Trigger                     | Checkpoint   | source                | target                                                   | Callsite (extension)                                                                                                                                                                                                                                 |
| --------------------------- | ------------ | --------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Side panel opens            | `navigate`   | `document.referrer`   | `cli` / `extension` / `electron` (from `getModeLabel()`) | `telemetry.ts:initTelemetry()` (already wired in `mainExtension()` via `main.ts:773`; standalone CLI/Electron uses `main.ts:2408`)                                                                                                                   |
| User submits chat message   | `formsubmit` | scoop name            | model id                                                 | **moves to** `ChatPanel.sendMessage()` in `chat-panel.ts`                                                                                                                                                                                            |
| Sprinkle panel displayed    | `viewblock`  | sprinkle name         | (omitted)                                                | `sprinkle-manager.ts:open()` (already wired)                                                                                                                                                                                                         |
| Settings dialog opened      | `signup`     | `button` / `shortcut` | (omitted)                                                | `provider-settings.ts:showProviderSettings()` (new wiring)                                                                                                                                                                                           |
| Image viewed in chat        | `viewmedia`  | `chat` / `preview`    | (omitted)                                                | `message-renderer.ts` image render path (new wiring)                                                                                                                                                                                                 |
| User-facing JS error caught | `error`      | `js`                  | sanitized error message                                  | `telemetry.ts:initTelemetry()` extension branch only — registers `window` `error` + `unhandledrejection` listeners after `sampleRUM` is assigned. CLI/Electron rely on helix-rum-js's built-in error listeners (different payload shape; see Risks). |

In CLI/Electron mode all six fire from the same browser tab via `@adobe/helix-rum-js`. In extension mode all six fire from the side panel realm via the inlined `rum.js`. Same checkpoint vocabulary across modes; same source/target shape for five of six. The exception is the **automatic** `error` capture path — its payload shape differs by mode (helix-shaped in CLI/Electron, `{source: 'js', target: sanitized}` in extension). Manual `trackError(...)` calls produce the SLICC shape in both modes. See row notes on `error` and the Risks section for details.

### Why move trackChatSend out of orchestrator.ts

The orchestrator runs in the offscreen document in extension mode. Telemetry under this design only initializes in the panel realm, so the existing `orchestrator.ts:1065` call already silently no-ops in extension mode today. Moving the call to `ChatPanel.sendMessage()` (the single private method every send path funnels through):

- makes the beacon fire correctly in extension mode (one source of truth for "user submitted a message"),
- still works in CLI/Electron mode (the chat panel is in the same realm as the orchestrator there),
- aligns with aem-sidekick's pattern of placing track calls in UI components, not in backend orchestration.

### Why trackShellCommand stays put

`wasm-shell.ts:679` runs in two contexts in extension mode: the panel terminal and the offscreen agent shell. Under panel-only init, panel-terminal commands beacon and offscreen agent-bash commands silently no-op. That exactly matches the side-panel-only scope. No code change needed.

**Consequence to document:** in extension mode, `fill` beacons represent only commands the user typed in the panel terminal — not commands the agent ran via its bash tool. In CLI/Electron mode, both paths run in the same realm and both produce beacons (no asymmetry). The `docs/operational-telemetry.md` update notes this explicitly so dashboard readers don't misinterpret the shell-command volume.

## The inlined rum.js (extension path only)

Loaded by `telemetry.ts` only when `getModeLabel() === 'extension'`. CLI and Electron continue to use `@adobe/helix-rum-js` and never import this file. Verbatim port of aem-sidekick's pattern with three substitutions:

1. **Pageview-context source.** Aem-sidekick reads `window.hlx.sidekick.location` (the target page being overlaid). Our panel reads `window.location` (the side panel URL itself, e.g. `chrome-extension://<id>/index.html` — this repo's manifest sets `side_panel.default_path` to `index.html`, not `sidepanel.html`).
2. **Debug override.** Aem-sidekick reads `?aem-sk-rum=on` from `sk.location.search`. The extension side panel has no user-controllable URL query, so we read `localStorage.getItem('slicc-rum-debug') === '1'`. Set this in DevTools (right-click side panel → Inspect → Console) to force `weight=1` (100% sampling) for the next session.
3. **Generation tag.** Read from `window.RUM_GENERATION`, which `telemetry.ts:initTelemetry()` sets to `slicc-extension` for the extension branch (and `slicc-cli` / `slicc-electron` for the helix-rum-js branch).

Default sampling weight: **10** (1-in-10 sessions selected). With debug flag: **1** (100%). Selected sessions fire all checkpoints for that pageview; unselected fire none. Beacons go to `https://rum.hlx.page/.rum/<weight>` via `navigator.sendBeacon`. No retry, no response handling, no synchronous fetch.

Sampling decision is per-pageview and per-realm. `window.hlx.rum` is created on first `sampleRUM` call and cached on `window`. The panel realm makes its own decision; the offscreen realm never calls `sampleRUM` under this design, so it makes no decision.

### Sketch

```js
// packages/webapp/src/ui/rum.js

export default function sampleRUM(checkpoint, data = {}) {
  try {
    window.hlx = window.hlx || {};
    if (!window.hlx.rum) {
      const debug = (() => {
        try {
          return localStorage.getItem('slicc-rum-debug') === '1';
        } catch {
          return false;
        }
      })();
      const weight = debug ? 1 : 10;
      const id = `${hashCode(window.location.href)}-${Date.now()}-${rand14()}`;
      const random = Math.random();
      const isSelected = random * weight < 1;
      window.hlx.rum = { weight, id, random, isSelected, sampleRUM };
    }
    const { weight, id, isSelected } = window.hlx.rum;
    if (!isSelected) return;
    const body = JSON.stringify({
      weight,
      id,
      referer: window.location.href,
      generation: window.RUM_GENERATION,
      checkpoint,
      ...data,
    });
    navigator.sendBeacon(`https://rum.hlx.page/.rum/${weight}`, body);
  } catch {
    /* never throw */
  }
}

function hashCode(s) {
  return s.split('').reduce((a, b) => ((a << 5) - a + b.charCodeAt(0)) | 0, 0);
}
function rand14() {
  return Math.random().toString(16).slice(2, 16);
}
```

This is illustrative, not literal — the implementer should match aem-sidekick's structure exactly (defer/drain harness omitted here for brevity since we don't use it).

## telemetry.ts changes

`initTelemetry()` becomes a small dispatcher. The body, in order:

1. Existing opt-out check — `localStorage.getItem('telemetry-disabled') === 'true'` returns early, leaving the module-level `sampleRUM` unassigned. All `track*` calls remain safe no-ops (`sampleRUM?.(...)` never invokes the beacon).
2. Set `window.RUM_GENERATION = 'slicc-' + getModeLabel()` (values: `slicc-cli`, `slicc-extension`, `slicc-electron`). Read by both backend implementations.
3. Branch on `getModeLabel()`:
   - **Extension:** `const mod = await import('./rum.js'); sampleRUM = mod.default;`
   - **CLI/Electron:** Set `window.SAMPLE_PAGEVIEWS_AT_RATE = 'high'` (unchanged from today), then `const mod = await import('@adobe/helix-rum-js'); sampleRUM = mod.sampleRUM;`
4. Emit the initial `navigate` checkpoint with `target: getModeLabel()` (unchanged from today).

The two underlying functions — `mod.default` from `rum.js` and `mod.sampleRUM` from helix-rum-js — share the same `(checkpoint, data?: { source?, target? })` signature, so the public `track*` wrappers don't need to know which branch is active. Public function signatures are unchanged.

Existing callsites in `wasm-shell.ts` and `sprinkle-manager.ts` keep working without edits. The only callsite that moves is `orchestrator.ts:1065 → ChatPanel.sendMessage()` in `chat-panel.ts` (single new callsite; see "Why move trackChatSend").

## New panel-realm wirings

### `chat-panel.ts` — `trackChatSend`

Wire inside the existing private `sendMessage()` method on `ChatPanel` — every send path (button click, keyboard shortcut, programmatic) already funnels through this single method, so one `trackChatSend(...)` call there is sufficient and cannot double-fire.

**Match orchestrator parity exactly** so the beacon shape is identical to today's CLI behavior:

- **Model id:** `localStorage.getItem('selected-model') ?? 'unknown'` (mirrors `orchestrator.ts:1065`).
- **Scoop name:** `scoop?.isCone ? 'cone' : (scoop?.name ?? 'unknown')` where `scoop` is the active scoop (the panel already has access to this via its existing context — do not introduce new state).

```ts
import { trackChatSend } from './telemetry.js';
// inside ChatPanel.sendMessage(), after the message is queued:
const scoopName = activeScoop?.isCone ? 'cone' : (activeScoop?.name ?? 'unknown');
const modelId = localStorage.getItem('selected-model') ?? 'unknown';
trackChatSend(scoopName, modelId);
```

Remove the call from `orchestrator.ts:1065` so there is exactly one `trackChatSend` callsite in the codebase. Verify with `grep -rn 'trackChatSend(' packages/`.

### `provider-settings.ts` — `trackSettingsOpen`

Wire inside `showProviderSettings()` (the function that opens the dialog). The `trigger` argument is `'button'` for the gear icon and `'shortcut'` for any keyboard shortcut path; pass it from the caller. Default to `'button'` if there is only one entry path today.

### `message-renderer.ts` — `trackImageView`

The chat message renderer creates `<img>` elements when an assistant response contains an image, when a user message embeds an image attachment, or when an image is rendered as a tool result inside a chat message body. Call `trackImageView('chat')` exactly once per such image, when it first attaches to the DOM.

**Out of scope:** UI chrome (avatars, branding, panel icons), inline-sprinkle imagery, image thumbnails inside the file browser. Only images that are part of chat message content count.

The `'preview'` source value is reserved for `open --view` image previews emitted by the shell — wire it later if/when that path moves into the panel realm. For this iteration, only `'chat'` is wired.

### `telemetry.ts` — automatic `trackError` (extension only)

**Important asymmetry.** `@adobe/helix-rum-js` already registers its own `window.addEventListener('error', ...)` and `window.addEventListener('unhandledrejection', ...)` handlers inside `sampleRUM`'s selection block (see `node_modules/@adobe/helix-rum-js/src/index.js` around the `isSelected` branch). Those handlers emit `sampleRUM('error', ...)` with helix's payload shape. Adding SLICC's own listeners in CLI/Electron would produce two `error` beacons per failure with different payloads.

The inlined `rum.js` does **not** register error listeners (it's a deliberate trim of aem-sidekick's pattern), so without explicit wiring the extension panel would have no error telemetry at all.

**Decision:** wire SLICC's listeners **only in the extension branch**. The dispatcher in `telemetry.ts:initTelemetry()` adds the listeners after assigning `sampleRUM` from `./rum.js`; the CLI/Electron branch does nothing extra and lets helix's built-in handlers run. This keeps `error` beacons single-fire in every mode at the cost of a payload-shape asymmetry between modes (helix-shaped in CLI/Electron, `{source: 'js', target: sanitized}` in extension). The asymmetry is documented in `docs/operational-telemetry.md` and on the dashboard via the `slicc-cli` vs `slicc-extension` generation tag.

Implementation lives inside `initTelemetry()` (not at the top of `mainExtension()`/`main()` as an earlier draft suggested):

```ts
// inside the extension branch of initTelemetry(), after sampleRUM is assigned
window.addEventListener('error', (e) => {
  trackError('js', sanitizeError(e.message));
});
window.addEventListener('unhandledrejection', (e) => {
  const msg = e.reason instanceof Error ? e.reason.message : String(e.reason);
  trackError('js', sanitizeError(msg));
});
```

`sanitizeError` is a small helper in `telemetry.ts`:

```ts
function sanitizeError(msg: string): string {
  // Truncate to 200 chars; collapse VFS paths to /<root>/.../ shape.
  const truncated = (msg ?? '').slice(0, 200);
  return truncated.replace(/(\/[a-z]+)(?:\/[^\s/]+)+/gi, '$1/.../');
}
```

This avoids leaking absolute filesystem paths or long stack-trace fragments in the `target` field while preserving root-directory information.

Implication: `trackError` itself remains a public function in `telemetry.ts` and remains usable from anywhere (e.g. catch blocks where panel code wants to record a known-bad path manually). Manual calls fire in both modes via the active `sampleRUM`. The mode-gated listeners only affect the _automatic_ `window.error` / `unhandledrejection` capture path.

## Manifest CSP

Today: `script-src 'self' 'wasm-unsafe-eval'; object-src 'self'`.

The inlined `rum.js` is bundled into the panel by Vite — there is no external script load — so CSP `script-src` is satisfied as-is. Cross-origin `navigator.sendBeacon` to `https://rum.hlx.page` is allowed for this extension because the manifest declares **`host_permissions`: `["<all_urls>"]`** (Chrome requires host access for cross-origin network requests from extension pages). The manifest CSP does not set `connect-src`; if you ever tighten CSP with an explicit `connect-src`, add `https://rum.hlx.page` there too. **No manifest change required for this spec as written.**

## Privacy & sanitization

- `trackError('js', sanitizeError(msg))` truncates to 200 characters and collapses VFS paths past their first segment to `<root>/.../`.
- No chat content, no API keys, no absolute paths in any field.
- No file contents or filenames in `viewmedia` source/target.
- No PII in scoop names (scoop names are user-typed but generally short, system-encouraged strings; if they grow into freeform user input later, add an additional sanitizer there).
- `localStorage.setItem('telemetry-disabled', 'true')` opt-out stays intact and is checked by `initTelemetry()` before anything is sent.

## Sampling

Two independent samplers, one per implementation. Equivalent semantics, different code paths.

**Extension (`rum.js`):**

- Default weight: **10** (1-in-10 session selection, matches aem-sidekick).
- Debug override: set `localStorage.setItem('slicc-rum-debug', '1')` in side-panel DevTools, reload the panel; weight becomes 1 (100%) for that session. Remove the key (or set to anything else) to revert.
- Per-pageview, per-realm decision; cached on `window.hlx.rum`. Survives within the panel session; the side panel closing or reloading produces a new pageview ID.
- Selected sessions fire every checkpoint they encounter; unselected fire none.

**CLI / Electron (`@adobe/helix-rum-js`):**

- `window.SAMPLE_PAGEVIEWS_AT_RATE = 'high'` is set in `initTelemetry()` (unchanged from today). Helix-rum-js interprets `'high'` as 1-in-10. Same effective rate as the extension default.
- No SLICC-side debug override today. Helix-rum-js supports its own URL-based override (`?optel=on`) that we do not document or rely on. If we ever add a debug override here, document it separately.
- Sampling is governed entirely by helix-rum-js internals — same fire-and-forget, beacon-only contract.

## Testing

### Modify: `packages/webapp/tests/ui/telemetry.test.ts`

The existing suite has **10** `it` blocks (7 telemetry behaviors + 3 for `isTelemetryEnabled` / `setTelemetryEnabled`). They mock `@adobe/helix-rum-js`'s **`sampleRUM` named export** today (`vi.mock('@adobe/helix-rum-js', () => ({ sampleRUM: mockSampleRUM }))`). The dispatcher means tests now cover two branches:

- **CLI/Electron branch (existing tests, lightly updated).** Default Vitest environment has no `chrome` global, so `getModeLabel()` returns `cli`. Existing tests keep mocking `@adobe/helix-rum-js` and exercise the helix-rum-js branch. Add one assertion: `window.RUM_GENERATION` equals `'slicc-cli'` after `initTelemetry()`.
- **Extension branch (new tests).** Place these in their own `describe('extension branch')` block. In `beforeEach`, set `globalThis.chrome = { runtime: { id: 'test' } }` and call `vi.resetModules()` so a fresh `telemetry.ts` is imported with the chrome stub visible at evaluation time. In `afterEach`, `delete (globalThis as any).chrome` and reset `vi.unstubAllGlobals()` to prevent leakage into the CLI-branch tests. Mock `./rum.js` (default export) and assert the same six `track*` forwards. Add a `RUM_GENERATION === 'slicc-extension'` assertion. Verify `SAMPLE_PAGEVIEWS_AT_RATE` is **not** set in this branch.
- **Window listeners (extension branch only).** Assert that after `initTelemetry()` returns in the extension branch, dispatching a synthetic `ErrorEvent` on `window` results in a `trackError('js', ...)` call, and a synthetic `unhandledrejection` does the same. To prove the CLI branch did **not** register listeners, prefer the negative behavioral assertion: in a CLI-branch test, dispatch the same synthetic events and verify SLICC's `trackError` mock was **not** called by these events (helix's mocked `sampleRUM` may still be invoked by helix's own listeners — that's expected). Counting `window.addEventListener` calls is fragile in the JSDOM environment because unrelated code (and helix's mock) can register listeners; behavioral assertion is more robust.

The opt-out test (`telemetry-disabled` localStorage key suppresses everything) runs against both branches.

Across both branches, every `track*` wrapper is asserted to forward to `sampleRUM` with the documented checkpoint name and `{source, target}` data. Note that today's `telemetry.test.ts` does **not** cover `trackImageView`, `trackSettingsOpen`, or `trackError` — these wrappers are dead code today. Add coverage for all three as part of this change.

### New: `packages/webapp/tests/ui/rum.test.ts`

Unit tests for the inlined `rum.js`:

- Selection logic: with `weight=10` and `Math.random()` mocked, `isSelected` is true when `random * weight < 1`.
- Debug flag: with `localStorage['slicc-rum-debug'] = '1'`, weight is 1 and selection is always true.
- Beacon shape: `navigator.sendBeacon` is called with `https://rum.hlx.page/.rum/<weight>` and a JSON body containing `{ weight, id, referer, generation, checkpoint, ...data }`.
- No-throw contract: any internal exception is swallowed; the function never throws.
- Per-pageview cache: two consecutive calls share the same `id` and `random`.

### New: panel-callsite tests

Light tests at the wiring sites — assert that the panel-realm function call results in a `trackXxx` call with the right arguments. Mock `telemetry.js` and verify the spy. One test each for:

- `chat-panel.ts` `sendMessage()` → `trackChatSend(scoop, model)` with the orchestrator-parity values (cone → `'cone'`, otherwise scoop name; model from `localStorage['selected-model']`).
- `provider-settings.ts` open dialog → `trackSettingsOpen('button' | 'shortcut')`.
- `message-renderer.ts` image render → `trackImageView('chat')`, exactly once per chat-message image.
- `telemetry.ts` extension-branch `addEventListener('error')` and `addEventListener('unhandledrejection')` registrations → both invoke `trackError('js', sanitized)` when the listener fires; not registered in the CLI/Electron branch (covered above in the dispatcher tests).

### Not tested

- Real beacons reaching `rum.hlx.page`. Fire-and-forget; that's the library's responsibility.
- Sampling distribution under load. Library responsibility.

## Manual verification

1. Build the extension: `npm run build -w @slicc/chrome-extension`.
2. Load the unpacked extension from `dist/extension/`.
3. Open the side panel. Right-click → Inspect to attach DevTools.
4. In the panel's DevTools console: `localStorage.setItem('slicc-rum-debug', '1')`, then reload the panel.
5. Open the Network tab and filter by `rum.hlx.page`.
6. Submit a chat message → expect a `formsubmit` beacon.
7. Open settings → expect a `signup` beacon.
8. Open a sprinkle → expect a `viewblock` beacon.
9. Trigger a JS error in panel code (e.g. `window.dispatchEvent(new ErrorEvent('error', { message: 'test' }))`) → expect an `error` beacon.
10. Set `localStorage.setItem('telemetry-disabled', 'true')`, reload → expect zero beacons.

## Documentation updates

These ship as part of this change, not as a follow-up:

- **`docs/operational-telemetry.md`** — restructure the "Integration Approach" section to show the dispatcher: CLI/Electron use `@adobe/helix-rum-js` (existing); extension uses the inlined `rum.js`. Document the localStorage debug override (`slicc-rum-debug`). Document the `fill`-beacon asymmetry (in extension mode it covers panel-terminal commands only, not agent-driven bash). Add an explicit note that offscreen and the service worker are not instrumented in this iteration. List the newly-wired checkpoints: `signup` and `viewmedia` fire in both CLI/Electron and extension; `error` fires in both modes too, but its **automatic capture path** differs by mode (helix-rum-js's built-in handlers in CLI/Electron vs SLICC's listeners on the inlined `rum.js` path in extension — payload shape differs between the two; see Risks).
- **`packages/chrome-extension/CLAUDE.md`** — add a one-line "Telemetry" section pointing to `packages/webapp/src/ui/telemetry.ts` and noting that beacons in the panel fire via the inlined `rum.js`, distinct from the helix-rum-js path used by CLI/Electron.
- Root **`CLAUDE.md`** — no change needed; telemetry is not in the cross-cutting principles list.
- **`README.md`** — if a "What we collect" section exists, mention the new beacons. If no such section exists, do not add one in this change (out of scope).

## Build gates (Karl's standing orders)

Every change must satisfy tests, docs, and verification:

- `npx prettier --write` on every file touched
- `npm run typecheck`
- `npm run test`
- `npm run build`
- `npm run build -w @slicc/chrome-extension`

All five must pass before the change is ready to land.

## Risks

- **Beacons fire from `chrome-extension://` origin.** RUM dashboards may not recognize this origin pattern. Verify the dashboard accepts `slicc-extension`-tagged events; if not, the `referer` field can be rewritten to a synthetic web URL inside `rum.js`. Decide after first manual run.
- **Two implementations behind one API.** CLI/Electron use `@adobe/helix-rum-js`; extension uses inlined `rum.js`. The two libraries make sampling decisions independently. We expect equivalent semantics (1-in-10 default), but a pageview sampled in the extension and a pageview sampled in CLI come from different RNG draws — cross-mode comparisons should account for this. Generation tag (`slicc-extension` vs `slicc-cli`) makes the two streams distinguishable on the dashboard.
- **`error` beacon payload shape differs between modes.** CLI/Electron `error` beacons come from helix-rum-js's built-in handlers and use helix's native payload shape. Extension `error` beacons come from SLICC's manual listeners and use `{source: 'js', target: sanitizedMessage}`. Dashboard queries that aggregate errors across modes must split by `generation` tag and treat each shape separately. (See "telemetry.ts — automatic trackError" for the rationale behind this asymmetry.)
- **CLI loses telemetry data quality if helix-rum-js's enhancer URL is ever blocked.** The enhancer auto-loads from `rum.hlx.page` in CLI/Electron. Corporate proxies or air-gapped setups would silently lose CWV/auto-click data. This is pre-existing — not introduced by this change — but worth noting since the extension's inlined approach avoids the dependency entirely.
- **`window.RUM_GENERATION` is global.** If two different telemetry consumers ever share a page, they'd collide. Not a real risk under current architecture; flagged in case future code adds a second consumer.

## Future work (explicitly not this spec)

- Offscreen-realm telemetry — agent turns, tool calls, scoop lifecycle.
- Service-worker telemetry — CDP attach/detach, OAuth completion, tray-socket events.
- Self-hosting `rum.hlx.page` for air-gapped deployments.
- Settings UI toggle for opt-out and debug flag (today both are localStorage-only).
- A `rum-debug on|off` shell command for non-DevTools discovery.
