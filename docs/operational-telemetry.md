# Operational Telemetry

Design spec for adding Real User Monitoring (RUM) / Operational Telemetry to SLICC using `@adobe/helix-rum-js`.

## Overview

SLICC is a browser-based AI coding agent used across three deployment modes (CLI, extension, Electron). We currently have no visibility into how the product is used in practice. Operational telemetry answers questions like:

- Which deployment mode is most common?
- How many scoops does a typical session create?
- Which LLM providers and models are people using?
- What is the error rate for agent overflows and tool failures?
- Are voice input and skill installation gaining adoption?
- What are the Core Web Vitals for the UI?

### Why helix-rum-js

- **Lightweight**: ~2 KB core, sampling-based (default 1-in-100), zero performance impact on unsampled pageviews.
- **Privacy-first**: No cookies, no PII, per-pageview random ID. Aligns with SLICC's browser-first philosophy.
- **Fire-and-forget**: Uses `navigator.sendBeacon()` -- no response handling, no retry logic, no impact on agent work.
- **Auto-instrumented CWV**: The enhancer module (auto-loaded) captures Core Web Vitals, click interactions, and viewblock visibility without any custom code.
- **Custom checkpoints**: `sampleRUM('name', {source, target})` for SLICC-specific events.

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

| RUM Checkpoint | SLICC Meaning      | Source                         | Target                       | Location                              |
| -------------- | ------------------ | ------------------------------ | ---------------------------- | ------------------------------------- |
| `navigate`     | Page load          | referrer                       | `cli`/`extension`/`electron` | `main.ts` — init                      |
| `formsubmit`   | User chat message  | Scoop name                     | Model ID                     | `orchestrator.ts` — `handleMessage()` |
| `fill`         | Shell command      | Command name                   | (omitted)                    | `wasm-shell.ts` — `runCommand()`      |
| `viewblock`    | Sprinkle displayed | Sprinkle name                  | (omitted)                    | `sprinkle-manager.ts` — `open()`      |
| `viewmedia`    | Image viewed       | Context (`chat`/`preview`)     | (omitted)                    | Image display code                    |
| `error`        | Error occurred     | Error type (`js`/`llm`/`tool`) | Details                      | Error handlers                        |
| `signup`       | Settings opened    | Trigger (`button`/`shortcut`)  | (omitted)                    | `provider-settings.ts`                |

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

| Phase                | Rate               | Config                                                              |
| -------------------- | ------------------ | ------------------------------------------------------------------- |
| Beta / dogfooding    | 1-in-1 (100%)      | `window.RUM_GENERATION = 'slicc-beta'; window.RUM_SAMPLE_RATE = 1;` |
| General availability | 1-in-100 (default) | Remove `RUM_SAMPLE_RATE` override                                   |
| Debugging            | 1-in-1 (100%)      | Append `?optel=on` to URL                                           |

The `?optel=on` query parameter forces 100% sampling for the current pageview. This is built into helix-rum-js and requires no custom code. Useful for verifying telemetry works during development.

In `packages/webapp/src/ui/telemetry.ts`:

```typescript
export async function initTelemetry(): Promise<void> {
  if (localStorage.getItem('telemetry-disabled') === 'true') return;

  // Beta: sample everything. Remove this line for GA.
  window.RUM_SAMPLE_RATE = 1;

  const mod = await import('@adobe/helix-rum-js');
  sampleRUM = mod.sampleRUM;

  // ...
}
```

## Privacy Considerations

helix-rum-js is privacy-safe by design (no cookies, no PII, ephemeral pageview ID). SLICC must maintain this by sanitizing checkpoint data:

1. **No API keys**: Never include provider API keys, tokens, or credentials in `source` or `target` fields.
2. **No file contents**: `file:operation` logs the operation type and a sanitized path pattern (depth only, e.g. `/workspace/.../*`), never filenames or contents.
3. **No chat content**: `chat:send` and `chat:response` log scoop name and model, never the message text.
4. **No PII in scoop names**: Scoop names are system-generated (e.g. `researcher`, `coder`), not user input. If user-defined scoop names are ever supported, sanitize them.
5. **Model IDs only**: `provider:switch` logs model IDs (e.g. `anthropic:claude-sonnet-4`), not base URLs or custom endpoint details.
6. **Opt-out**: Users can disable telemetry entirely via `localStorage.setItem('telemetry-disabled', 'true')`. The telemetry module checks this before initializing. Expose this as a toggle in the settings UI.

### Path sanitization utility

```typescript
/**
 * Reduce a VFS path to its depth and root directory.
 * /workspace/skills/my-skill/SKILL.md -> /workspace/skills/*/*
 * /scoops/researcher/notes.txt -> /scoops/*/*
 */
function sanitizePath(path: string): string {
  const parts = path.split('/').filter(Boolean);
  if (parts.length <= 2) return '/' + parts.join('/');
  return '/' + parts.slice(0, 2).join('/') + '/' + Array(parts.length - 2).fill('*').join('/');
}
```

## Implementation Plan

### Step 1: Add dependency

```bash
npm install @adobe/helix-rum-js
```

### Step 2: Create telemetry module

Create `packages/webapp/src/ui/telemetry.ts` with:

- `initTelemetry()` -- async init, loads the module, emits initial `navigate` checkpoint
- `checkpoint(name, data?)` -- safe wrapper, no-op before init or when disabled
- `sanitizePath(path)` -- path sanitization utility
- `getModeLabel()` -- returns `cli` | `extension` | `electron`

### Step 3: Initialize in main.ts

Add `initTelemetry()` call at the end of both `main()` (CLI/Electron path) and `mainExtension()` (extension path). Fire-and-forget -- never `await` in the critical path.

```typescript
// In main()
initTelemetry().catch(() => {});

// In mainExtension()
initTelemetry().catch(() => {});
```

### Step 4: Add checkpoint calls

Instrument the following files (minimal diff per file -- one import + one function call):

| File                                          | Checkpoint                      | Where                            |
| --------------------------------------------- | ------------------------------- | -------------------------------- |
| `packages/webapp/src/scoops/orchestrator.ts`  | `chat:send`                     | `handleMessage()`, after routing |
| `packages/webapp/src/scoops/scoop-context.ts` | `chat:response`                 | `agent_end` event callback       |
| `packages/webapp/src/core/tool-registry.ts`   | `tool:execute`                  | `executeTool()`, before dispatch |
| `packages/webapp/src/scoops/orchestrator.ts`  | `scoop:create`                  | `createScoop()`                  |
| `packages/webapp/src/scoops/orchestrator.ts`  | `scoop:delegate`                | `delegateToScoop()`              |
| `packages/webapp/src/shell/wasm-shell.ts`     | `shell:command`                 | Command dispatch                 |
| `packages/webapp/src/ui/voice-input.ts`       | `voice:input`                   | Recognition result handler       |
| `packages/webapp/src/ui/provider-settings.ts` | `provider:switch`               | Settings save                    |
| `packages/webapp/src/tools/file-tools.ts`     | `file:operation`                | Tool execute functions           |
| `packages/webapp/src/skills/apply.ts`         | `skill:install`                 | After successful install         |
| `packages/webapp/src/scoops/scoop-context.ts` | `error:agent`, `error:overflow` | Error/overflow handlers          |

### Step 5: Extension CSP and bundling

In `packages/chrome-extension/vite.config.ts`, add to the `closeBundle` hook:

```typescript
// Copy helix-rum-enhancer to dist/extension/ for self-hosted loading
const enhancerSrc = require.resolve('@adobe/helix-rum-enhancer');
fs.copyFileSync(enhancerSrc, path.join(extensionDir, 'rum-enhancer.js'));
```

No `manifest.json` CSP change needed if self-hosting. The `host_permissions: ["<all_urls>"]` allows extension code to make requests to `rum.hlx.page`. Note: `host_permissions` controls fetch/XHR access from extension pages, not the `connect-src` CSP directive. The current manifest only sets `script-src` and `object-src` (no `connect-src`), so outbound requests are permitted. If a `connect-src` directive is added in the future, it must explicitly allow `https://rum.hlx.page`.

### Step 6: Settings UI toggle

Add a "Telemetry" toggle to `packages/webapp/src/ui/provider-settings.ts` (or a new general settings section). The toggle writes `telemetry-disabled` to `localStorage`. Changes take effect on next page load (not retroactive for the current session).

### Step 7: Update documentation

- `CLAUDE.md` (project root): Add telemetry module to the architecture overview.
- `packages/vfs-root/shared/CLAUDE.md`: No change needed (agent does not interact with telemetry).
- `README.md`: Add a "Telemetry" section explaining what is collected and how to opt out.

## Self-Hosting Option

For deployments that cannot reach `rum.hlx.page` (air-gapped, corporate proxies), SLICC can self-host the collection endpoint.

### CLI mode

Add a proxy route in `packages/node-server/src/index.ts`:

```typescript
import { createProxyMiddleware } from 'http-proxy-middleware';

app.use(
  '/.rum',
  createProxyMiddleware({
    target: 'https://rum.hlx.page',
    changeOrigin: true,
    pathRewrite: { '^/\\.rum': '' },
  })
);
```

Then in `telemetry.ts`:

```typescript
window.RUM_BASE = window.location.origin + '/.rum';
```

### Extension mode

Self-hosting is less relevant for extensions (beacons go directly to `rum.hlx.page` via `host_permissions`). If needed, a background service worker fetch handler could intercept and relay, but this adds complexity for minimal benefit.

### Electron mode

Same as CLI -- the Express server is running, add the proxy route.

## Testing

### Manual verification

1. **Enable full sampling**: Append `?optel=on` to the URL, or set `window.RUM_SAMPLE_RATE = 1` in `telemetry.ts`.
2. **Open DevTools Network tab**: Filter by `rum.hlx.page`. Each checkpoint should produce a beacon request.
3. **Check payload**: The beacon URL encodes checkpoint name, source, target, and pageview ID as query parameters. Verify no PII leaks.
4. **Test opt-out**: Set `localStorage.setItem('telemetry-disabled', 'true')`, reload. Confirm zero beacon requests.
5. **Test extension mode**: Load the unpacked extension, open the side panel, interact with the agent. Verify beacons in the side panel's DevTools Network tab.

### Automated tests

Telemetry is fire-and-forget with no return values, making it awkward to unit test. Instead:

- **Module-level test** (`telemetry.test.ts`): Mock `@adobe/helix-rum-js`, call `initTelemetry()`, verify `sampleRUM` is called with `navigate`. Call `checkpoint()`, verify forwarding. Verify no-op when `telemetry-disabled` is set.
- **Sanitization test**: Unit test `sanitizePath()` with various VFS paths.
- **No integration tests**: Do not test that real beacons reach `rum.hlx.page`. That is the library's responsibility.

```typescript
// packages/webapp/tests/ui/telemetry.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@adobe/helix-rum-js', () => ({
  sampleRUM: vi.fn(),
}));

describe('telemetry', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  it('initializes and emits navigate checkpoint', async () => {
    const { initTelemetry } = await import('./telemetry.js');
    await initTelemetry();
    const { sampleRUM } = await import('@adobe/helix-rum-js');
    expect(sampleRUM).toHaveBeenCalledWith(
      'navigate',
      expect.objectContaining({
        target: expect.stringMatching(/^(cli|extension|electron)$/),
      })
    );
  });

  it('respects telemetry-disabled flag', async () => {
    localStorage.setItem('telemetry-disabled', 'true');
    const { initTelemetry, checkpoint } = await import('./telemetry.js');
    await initTelemetry();
    checkpoint('test:event');
    const { sampleRUM } = await import('@adobe/helix-rum-js');
    expect(sampleRUM).not.toHaveBeenCalled();
  });
});
```

### Dashboard verification

Once checkpoints are flowing, verify in the RUM dashboard (rum.hlx.page or Helix RUM Explorer) that:

- Events are attributed to the correct domain/origin
- Custom checkpoint names appear in the checkpoint breakdown
- Source/target fields contain expected sanitized values
- No unexpected PII appears in any field
