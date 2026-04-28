# Pitfalls & Gotchas

Common mistakes when working on SLICC. All subsystems must work in both **CLI mode** (Node.js/Express + Chrome) and **extension mode** (Chrome extension side panel). This document captures dual-mode incompatibilities and the patterns to fix them.

## Extension CSP & Dynamic Code Execution

**The Problem**

Chrome extension Manifest V3 blocks dynamic code construction on extension pages. This breaks:

- Constructor-based code execution
- Indirect code evaluation
- Dynamic code execution anywhere in extension pages

**The Solution: Sandbox Iframe**

All dynamic code execution (JavaScript tool, `node -e`) routes through a sandboxed iframe (`sandbox.html`) exempt from extension CSP. Sprinkles and inline widgets use a separate sandbox (`sprinkle-sandbox.html`).

| Component           | CLI Behavior                                          | Extension Behavior                                          |
| ------------------- | ----------------------------------------------------- | ----------------------------------------------------------- |
| **JavaScript tool** | Inline iframe with IFRAME_HTML string and constructor | Routes through `sandbox.html` via postMessage               |
| **Node command**    | Direct constructor usage                              | Wraps user code, posts to sandbox iframe                    |
| **Fetch proxy**     | `/api/fetch-proxy` endpoint                           | Same sandbox iframe postMessage                             |
| **Panel sprinkles** | Fragments: direct DOM; Full docs: srcdoc iframe       | ALL: routes through `sprinkle-sandbox.html` via postMessage |
| **Dips**            | Direct srcdoc iframe                                  | Routes through `sprinkle-sandbox.html` via postMessage      |

**Code Pattern: Three-Branch Detection**

```typescript
// node-command.ts lines 147–149
const isExtensionMode = typeof chrome !== 'undefined' && !!chrome?.runtime?.id;
if (isExtensionMode) {
  // Route through sandbox iframe
} else {
  // Use constructor directly
}
```

**Implementation Details**

| Aspect            | Details                                                                                                               |
| ----------------- | --------------------------------------------------------------------------------------------------------------------- |
| **Sandbox file**  | `packages/chrome-extension/sandbox.html` (copied to `dist/extension/` by vite config)                                 |
| **Exec pattern**  | Parent page sends `{ type: 'exec', id, code }`, sandbox posts back `{ type: 'exec_result', id, result, logs, error }` |
| **VFS bridge**    | Sandbox iframe uses same postMessage pattern for VFS operations (readFile, writeFile, etc.)                           |
| **Shared iframe** | Node command uses the sandbox iframe (find via `document.querySelector('iframe[data-js-tool]')`)                      |
| **Wait for load** | In extension mode, must await sandbox iframe `load` event before posting messages                                     |

**Related Files**

- `packages/webapp/src/shell/supplemental-commands/node-command.ts` lines 145–221 (extension routing)
- `packages/chrome-extension/sandbox.html` (entry point, must load in extension via `chrome.runtime.getURL()`)

## Extension Sandbox: External Scripts & Opaque Origin

**The Problem**

Manifest sandbox pages (`sandbox.html`, `sprinkle-sandbox.html`, `tool-ui-sandbox.html`) get an **opaque origin** (`null`) and a fixed CSP: `script-src 'self' 'unsafe-inline' 'unsafe-eval'`. This blocks:

| What fails                                                 | Why                                                                                                                   |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `<script src="https://cdn.example.com/lib.js">`            | CSP `script-src` has no external origins                                                                              |
| `import('https://esm.sh/lodash')`                          | Same CSP restriction                                                                                                  |
| `import(blobUrl)`                                          | `blob:` not in `script-src`                                                                                           |
| `document.createElement('script').src = 'slicc-editor.js'` | Opaque origin can't load `chrome-extension://` URLs at runtime (static `<script src>` in `<head>` works at page init) |
| `fetch('https://...')` from sandbox                        | Only works if CDN sends permissive CORS headers (null origin)                                                         |
| `observer.observe(document.body)` in `<head>` scripts      | `document.body` is `null` before `<body>` is parsed                                                                   |

**Solutions**

| Pattern                                    | How it works                                                                                                                                             | Used by                                        |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| **Fetch-and-inline (full-doc)**            | Side panel scans HTML for `<script src="https://...">`, fetches content, replaces with `<script>inline</script>` before sending to sandbox               | `sprinkle-renderer.ts:inlineExternalScripts()` |
| **Parent relay (partial)**                 | Sandbox sends `sprinkle-fetch-script` to parent via postMessage, parent fetches, returns `sprinkle-fetch-script-response`                                | `sprinkle-sandbox.html:fetchScriptViaRelay()`  |
| **jsdelivr + Function constructor**        | Fetch from `https://cdn.jsdelivr.net/npm/PACKAGE` (serves UMD/CJS main file), evaluate with `(0, Function)('module', 'exports', text)(mod, mod.exports)` | `node-command.ts:__loadModule()`               |
| **Static `<script src>` in `<head>` only** | Extension-relative scripts must load statically in the initial HTML, not via dynamic `createElement`                                                     | `sprinkle-sandbox.html` lines 8-10             |
| **Guard `document.body` with try-catch**   | Scripts loaded in `<head>` must guard `observer.observe(document.body)` — use try-catch, not DOMContentLoaded (which interferes with sandbox page load)  | `lucide-icons.ts`                              |

**Key rules for extension sandbox development:**

1. **Never use `<script src="https://...">` in sandbox HTML** — it will be blocked by CSP. Use fetch-and-inline or the parent relay instead.
2. **Never dynamically create `<script>` elements with extension-relative `src`** — opaque origin blocks runtime loads. Load statically in `<head>`.
3. **Never call `import()` with external URLs in sandbox context** — CSP blocks it and generates noisy console errors even when caught. Use jsdelivr CDN + indirect Function constructor (`(0, Function)('module', 'exports', text)`) for npm packages in `node -e`.
4. **Always guard `document.body` in scripts loaded from `<head>`** — use `try {} catch {}` around `observer.observe(document.body)` rather than deferring to DOMContentLoaded (DOMContentLoaded listeners interfere with sandbox page load timing).
5. **Use the parent relay for cross-origin fetches** — sandbox null origin means CORS is unreliable. The side panel has full network access.
6. **Call `LucideIcons.render()` explicitly after injecting content in partial-content sprinkles** — the MutationObserver can't start in `<head>` (body is null), so icons won't auto-render. An explicit `render()` call after script execution handles this.
7. **Use function replacements with `String.replace` when the replacement contains fetched code** — `String.replace(str, replacement)` interprets `$&`, `$1`, etc. as special patterns. Minified libraries (e.g. lodash) contain `$&` in regex escape functions. Use `str.replace(match, () => replacement)` to prevent corruption.
8. **esm.sh `?bundle` returns ESM stubs, not evaluable bundles** — the top-level URL returns a small file with `export ... from "/.../pkg.bundle.mjs"`. Use jsdelivr (`https://cdn.jsdelivr.net/npm/PACKAGE`) instead, which serves the npm package's main file (typically UMD/CJS).

**macOS TCC and Side Panel Crashes**

Chrome's side panel cannot host macOS TCC (Transparency, Consent, and Control) permission dialogs. If code in the side panel triggers a TCC dialog (e.g., iterating a `FileSystemDirectoryHandle` for `~/Downloads`), Chrome's renderer crashes instead of showing the dialog. Solution: route operations that might trigger TCC through a popup window (`chrome.windows.create({ type: 'popup' })`) — see `mount-popup.html` for the pattern.

## WASM & Bundled Assets in Extension Mode

**The Problem**

Extension CSP also blocks CDN fetches and dynamic asset loading. ImageMagick WASM and Pyodide must be bundled and loaded via `chrome.runtime.getURL()`.

| Asset                | Solution                                                                                                                                                                                    |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **ImageMagick WASM** | Bundled at `dist/extension/magick.wasm`. Fetch as bytes: `const bytes = await fetch(chrome.runtime.getURL('magick.wasm')).then(r => r.arrayBuffer())`. Pass as Uint8Array to initialization |
| **Pyodide**          | Bundled at `dist/extension/pyodide/`. Load path: `chrome.runtime.getURL('pyodide/')` (trailing slash required)                                                                              |
| **Sandbox HTML**     | Loaded via `chrome.runtime.getURL('sandbox.html')` as iframe src                                                                                                                            |

Standalone browser mode loads Pyodide assets from jsdelivr. Keep `pyodide` pinned to an exact version in `package.json`; `packages/webapp/src/shell/supplemental-commands/shared.ts` derives the CDN URL from the installed `pyodide/package.json` version so Renovate updates the npm loader and browser assets together.

**Build Integration**

File: `packages/chrome-extension/vite.config.ts` `closeBundle` hook must:

1. Copy Pyodide from node_modules (~13MB) to `dist/extension/pyodide/`
2. Bundle ImageMagick WASM to `dist/extension/magick.wasm`
3. Ensure manifest `web_accessible_resources` includes all assets

## Node Command: Three-Branch Path

**File**: `packages/webapp/src/shell/supplemental-commands/node-command.ts`

| Branch        | Condition                                                | Behavior                                                                                    |
| ------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| **Extension** | `typeof chrome !== 'undefined' && !!chrome?.runtime?.id` | Wraps code with process/console/module shims, posts to sandbox iframe, parses JSON response |
| **CLI**       | Default                                                  | Uses constructor directly, accesses VirtualFS via `ctx.fs` bridge                           |

The extension branch (lines 145–228) rebuilds the node shimmed environment inside the sandbox iframe because the sandbox has no access to the shell context.

## RestrictedFS Path Behavior

**File**: `packages/webapp/src/fs/restricted-fs.ts`

| Operation     | Outside Allowed Path    | Inside Allowed Path              |
| ------------- | ----------------------- | -------------------------------- |
| **readFile**  | ENOENT                  | Read succeeds                    |
| **readDir**   | Empty array             | Filtered to allowed entries only |
| **stat**      | ENOENT                  | Stat succeeds                    |
| **exists**    | false                   | true/false as appropriate        |
| **writeFile** | **EACCES** (hard error) | Write succeeds                   |
| **mkdir**     | **EACCES** (hard error) | Creates directory                |
| **rm**        | **EACCES** (hard error) | Removes recursively              |

**Parent Directory Access**: Read operations allow traversal to parent directories of allowed paths (needed for `cd` to work). Write operations are strict — only allowed paths work.

**Code Pattern**

```typescript
// Line 74–75: read → ENOENT for outside paths
if (!this.isAllowedStrict(path)) {
  throw new FsError('ENOENT', 'no such file or directory', normalizePath(path));
}

// Line 56–58: write → EACCES for outside paths
private checkWrite(path: string): void {
  if (!this.isAllowedStrict(path)) {
    throw new FsError('EACCES', 'permission denied', normalizePath(path));
  }
}
```

**Related Tool**: `which-command.ts` uses RestrictedFS to resolve commands — outside paths return "command not found", not permission errors.

## VirtualFS Path Rules

All paths in VirtualFS must follow these rules:

| Rule                   | Example             | Violation                                                                   |
| ---------------------- | ------------------- | --------------------------------------------------------------------------- |
| **Absolute**           | `/foo/bar`, `/`     | `foo/bar` (relative), `./foo`                                               |
| **Forward-slash only** | `/path/to/file`     | `\path\to\file` (backslash)                                                 |
| **Normalized**         | `/a/b/c`            | `/a//b/c` (double slash), `/a/b/./c` (dot-slash)                            |
| **Symlinks supported** | `/link` → `/target` | Use `symlink()`, `readlink()`, `lstat()`, `realpath()`; max 40 hops (ELOOP) |

**Normalization**: Use `normalizePath(path)` from `packages/webapp/src/fs/path-utils.ts` before any VFS operation.

## Voice Input: Extension Workaround

**File**: `packages/webapp/src/ui/voice-input.ts`

**The Problem**

Chrome extension side panels cannot trigger mic permission prompts. `navigator.mediaDevices.getUserMedia()` silently fails.

**The Solution**

Fallback to a popup window (`voice-popup.html`) for the one-time mic permission grant.

| Scenario                       | Flow                                                                                                                     |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| **CLI mode**                   | `getUserMedia()` → permission prompt → speech recognition starts                                                         |
| **Extension, first use**       | `getUserMedia()` fails → open popup window → user grants permission → popup closes → direct mic access cached per origin |
| **Extension, subsequent uses** | Permission cached → `getUserMedia()` succeeds → speech recognition starts directly in side panel                         |

**Code**: Lines 109–130 (try getUserMedia, catch failure in extension mode → fallback to popup).

**Popup Window Details**

- URL: `chrome.runtime.getURL('voice-popup.html?lang=...')`
- Messaging: side panel ↔ popup via `chrome.runtime.onMessage`
- Cleanup: popup sends `'speech-end'` message, side panel closes window and clears listeners

## CDP Transport: Extension Mode

**File**: `packages/webapp/src/cdp/debugger-client.ts`

**The Problem**

Extension CSP blocks WebSocket. CDP proxy at `/cdp` endpoint unavailable in extension mode.

**The Solution**

Use `chrome.debugger` API to control tabs directly.

| Operation                   | CLI Mode               | Extension Mode                                     |
| --------------------------- | ---------------------- | -------------------------------------------------- |
| **Target.getTargets**       | WebSocket to `/cdp`    | `chrome.tabs.query()`                              |
| **Target.attachToTarget**   | WebSocket message      | `chrome.debugger.attach({ tabId }, version)`       |
| **Target.detachFromTarget** | WebSocket message      | `chrome.debugger.detach({ tabId })`                |
| **Target.createTarget**     | WebSocket message      | `chrome.windows.create()` + `chrome.tabs.create()` |
| **Other CDP commands**      | Pass through WebSocket | `chrome.debugger.sendCommand()`                    |

**Session Management**: DebuggerClient maps synthetic `sessionId` → Chrome `tabId` (line 20). All CDP event listeners receive `sessionId` in params for filtering.

**Active Tab Detection**: BrowserAPI includes `active` field (boolean) only in extension mode, identifying the user's currently focused tab for intelligent tool auto-dispatch.

## Leader Tray WebSocket: Extension Mode

**The Problem**

Leader tray bootstrap waits for a `leader.connected` control frame. In extension mode, that WebSocket must not live in the offscreen document.

**The Solution**

Host the real leader tray `WebSocket` in `packages/chrome-extension/src/service-worker.ts` and relay frames through `chrome.runtime.sendMessage`. The offscreen document should use `ServiceWorkerLeaderTraySocket` from `packages/chrome-extension/src/tray-socket-proxy.ts` as the `LeaderTrayManager` `webSocketFactory`.

| Mode          | Leader tray socket owner                         |
| ------------- | ------------------------------------------------ |
| **CLI**       | Direct `WebSocket` in the app runtime            |
| **Extension** | Service worker proxy, not the offscreen document |

## Fetch Proxy: CORS & CSP

| Mode          | Fetch Strategy | CORS Handling                                                   |
| ------------- | -------------- | --------------------------------------------------------------- |
| **CLI**       | Direct fetch   | Cross-origin requests proxy through `/api/fetch-proxy` endpoint |
| **Extension** | Direct fetch   | Uses `host_permissions` in manifest; no server proxy needed     |

**Git CORS**: Same rules apply to isomorphic-git HTTP requests (clone, push, pull).

## Two TypeScript Targets

**The Problem**

The codebase has two independent TypeScript builds:

- **Browser bundle** (`tsconfig.json`): Everything under `packages/webapp/src/` and `packages/chrome-extension/src/`
- **CLI server** (`tsconfig.cli.json`): Only `packages/node-server/src/`

Cross-importing breaks the build.

| Violation                                                                    | Problem                                                        |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Browser code imports `packages/node-server/src/`                             | CLI-only modules not bundled; runtime import error             |
| CLI code imports `packages/webapp/src/ui/`, `packages/chrome-extension/src/` | Browser-only code (DOM, chrome.debugger) not available in Node |

**How to Check**: `npm run typecheck` runs both configs. Fix: move shared code to `packages/webapp/src/shared/` or duplicate type definitions.

## Node Version: >= 22 Required

**The Problem**

LightningFS (IndexedDB backend) references `navigator` in `DefaultBackend.init`. The `navigator` global was added to Node in v21. On Node 20 or earlier, tests that use VirtualFS fail with `ReferenceError: navigator is not defined`.

**The Fix**

Use Node 22 (current LTS) or later. This applies to both local development and CI. The GitHub Actions workflow (`.github/workflows/ci.yml`) pins `node-version: 22` for this reason.

## Node Shims & Vite Aliases

**The Problem**

Just-bash references Node builtins (`node:zlib`, `node:module`) that don't exist in browsers.

**The Solution**

Add aliases in `packages/webapp/vite.config.ts`:

```typescript
// packages/webapp/vite.config.ts
resolve: {
  alias: {
    'node:zlib': resolve(__dirname, 'src/shims/empty.ts'),
    'node:module': resolve(__dirname, 'src/shims/empty.ts'),
  },
}
```

**When Adding New Deps**

If a new npm dependency imports Node builtins:

1. Create a stub file in `packages/webapp/src/shims/` exporting required symbols
2. Add alias in `packages/webapp/vite.config.ts`
3. Test in both CLI and extension modes

**Example**: `@smithy/node-http-handler` imports `stream`, `http`, `https`, `http2` (stubbed at `packages/webapp/src/shims/{stream,http,https,http2}.ts`).

## IndexedDB Database Names

Five databases exist:

| DB Name                  | Purpose                | Used By                                 |
| ------------------------ | ---------------------- | --------------------------------------- |
| **slicc-fs**             | Virtual filesystem     | VirtualFS (primary)                     |
| **slicc-fs-global**      | Global state (backups) | Rarely; legacy                          |
| **browser-coding-agent** | UI session state       | session-store.ts (Chat history, layout) |
| **agent-sessions**       | Agent-level sessions   | core/session.ts (Agent message logs)    |
| **slicc-groups**         | Orchestrator data      | db.ts (scoops, messages, tasks, state)  |

**When Testing**: Use unique `dbName` in tests or reset IndexedDB between runs (avoid cross-test pollution).

```typescript
// Example: use a unique name per test
const vfs = new VirtualFS(`slicc-fs-test-${Date.now()}`);
```

## Browser Tab Hygiene

| Practice                    | Reason                                                                             |
| --------------------------- | ---------------------------------------------------------------------------------- |
| **Close tabs after use**    | Browser test cleanup; prevents memory leaks                                        |
| **Exclude /preview/ URLs**  | Preview tabs (served by preview-sw.ts) must not be identified as the SLICC app tab |
| **Auto-resolve active tab** | BrowserAPI auto-selects the user's focused tab when `targetId` is omitted          |

**Code**: BrowserAPI excludes `/preview/` URLs when searching for the app tab (prevents false positives).

## Scoop Lifecycle

**File**: `packages/webapp/src/scoops/orchestrator.ts`

| Operation               | Effect                                                                                                      |
| ----------------------- | ----------------------------------------------------------------------------------------------------------- |
| **drop_scoop**          | Removes scoop context + clears message buffer. **Does NOT delete** filesystem files under `/scoops/{name}/` |
| **feed_scoop**          | Queues message to scoop. If scoop is busy, message **waits in queue** (not dropped)                         |
| **Webhook/cron guards** | Lick manager blocks `drop_scoop` if webhooks or cron tasks are **active** for that scoop                    |

**Pattern**: Dropping a scoop is reversible (files remain). Re-creating the scoop later re-uses the same filesystem.

## Message Queueing

Scoops have a **sequential message queue**:

- User sends multiple prompts → queued
- Each prompt waits for prior one to complete
- No dropped messages
- Applies to cone and all scoops

**Related**: Context compaction replaces old messages with an LLM-generated summary when context approaches the token limit (see `packages/webapp/src/core/context-compaction.ts`). Falls back to naive message dropping if the summarization call fails.

## Preview Service Worker: Build Strategy

**File**: `packages/webapp/src/ui/preview-sw.ts`

**The Problem**

Rollup code-splits shared dependencies (LightningFS) into a common chunk. Service Workers can't import shared chunks.

**The Solution**

Build preview-sw.ts as a self-contained IIFE via esbuild (not Rollup).

| Mode     | Build                                                                | Output                             |
| -------- | -------------------------------------------------------------------- | ---------------------------------- |
| **Prod** | `packages/webapp/vite.config.ts` `closeBundle` hook (esbuild bundle) | Written to `dist/ui/preview-sw.js` |

Use `format: 'iife'` to avoid code-splitting.

**When Modifying preview-sw.ts**

1. Test in dev mode (`npm run dev`)
2. Verify prod build includes bundle (`npm run build`, check `dist/ui/preview-sw.js` for LightningFS code)
3. Update the production bundle hook if adding imports

## Logging: createLogger Not console.\*

**The Problem**

`console.log()` appears only during active browsing (hard to debug async code). Also not level-filtered.

**The Solution**

Use `createLogger()` from `packages/webapp/src/core/logger.ts`:

```typescript
import { createLogger } from '../core/logger.js';
const log = createLogger('feature:name');

log.debug('Detail message', { data }); // Only in dev mode
log.info('Info message'); // Always shown
log.error('Error message', { error }); // Always shown
```

Levels: `DEBUG` (dev only, via `__DEV__`), `INFO`, `ERROR`.

## Extension Detection Pattern

```typescript
const isExtension = typeof chrome !== 'undefined' && !!chrome?.runtime?.id;

if (isExtension) {
  // Extension-specific code (chrome.debugger, sandbox.html, chrome.runtime.getURL)
} else {
  // CLI mode code (WebSocket, direct constructor usage, /api/fetch-proxy)
}
```

Used throughout codebase to select code paths.

## ToolCall ↔ ToolResult Pairing Must Be Preserved

**The Problem**

The Anthropic API requires every `tool_result` content block to reference a `tool_use` block (via `tool_use_id`) in the **immediately preceding** assistant message. If any code path mutates the message array and breaks this pairing, the API returns: `unexpected tool_use_id found in tool_result blocks`.

**The Rule**

Any code that modifies `AgentMessage[]` must preserve ToolCall blocks in assistant messages. Three code paths mutate messages:

| Path                     | File                                         | How it handles pairing                                                                                              |
| ------------------------ | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| **Context compaction**   | `context-compaction.ts`                      | While loop walks cut point backward past `toolResult` messages to include their assistant                           |
| **Overflow recovery**    | `scoop-context.ts` `recoverFromOverflow()`   | When replacing oversized assistant content, preserves `type: 'toolCall'` blocks (only replaces text/image/thinking) |
| **Image error recovery** | `scoop-context.ts` `recoverFromImageError()` | Filters `type !== 'image'` which naturally preserves ToolCall blocks                                                |

**When adding new message mutation code:**

- Never replace an assistant message's entire `content` array — filter out large blocks but keep `toolCall` blocks
- Never remove an assistant message without also removing its subsequent `toolResult` messages
- Never insert messages between an assistant (with ToolCalls) and its `toolResult` responses

**Key files:**

- `scoop-context.ts` lines 462-487 (overflow recovery with ToolCall preservation)
- `context-compaction.ts` lines 85-89 (compaction pair protection)
- `scoop-context.test.ts` "overflow recovery" tests (7 tests covering ToolCall preservation)

## Service Worker Must Be Self-Contained

**The Problem**

The extension service worker (`packages/chrome-extension/src/service-worker.ts`) is built by Rollup as an entry point. If it imports from modules that are shared with other entry points (index.html, offscreen.html), Rollup code-splits them into shared chunks with ES `import` statements. Chrome extension service workers are **not** ES modules — `import` statements cause `Uncaught SyntaxError: Cannot use import statement outside a module` at runtime.

**The Rule**

The service worker must only import **types** (erased at compile time) from other modules. All runtime code must be inlined. If you need to share logic between the service worker and other extension contexts (offscreen, side panel), maintain an inline copy in the service worker and the canonical version in a shared module.

| Import type   | Example                                            | Allowed in SW?                    |
| ------------- | -------------------------------------------------- | --------------------------------- |
| Type-only     | `import type { Foo } from './messages.js'`         | Yes (erased)                      |
| Runtime value | `import { bar } from './tab-group.js'`             | **No** (causes code split)        |
| Core modules  | `import { createLogger } from '../core/logger.js'` | **No** (pulls in dependency tree) |

**Current example**: `addToSliccGroup` has an inline copy in `service-worker.ts` and a canonical version in `tab-group.ts` (imported by `debugger-client.ts` in the offscreen document, which IS an ES module).

## Extension Dual-Shell Context

**The Problem**

In extension mode, there are **two separate WasmShell instances** running in different execution contexts:

| Context                | Location                                         | Shell purpose                    | Window globals                        |
| ---------------------- | ------------------------------------------------ | -------------------------------- | ------------------------------------- |
| **Side panel**         | `packages/webapp/src/ui/main.ts` (mainExtension) | Terminal tab — user-facing shell | Has Layout, `__slicc_debug_tabs`, DOM |
| **Offscreen document** | `packages/chrome-extension/src/offscreen.ts`     | Agent's bash tool — LLM-driven   | Has Orchestrator, no DOM/Layout       |

These contexts share IndexedDB (VFS, sessions) but **NOT** window globals, DOM, or Layout instances. They communicate via `chrome.runtime` messages routed through the service worker.

**The Pattern: UI-Affecting Shell Commands**

Shell commands that need to affect the side panel UI (e.g., `debug on` toggling tabs) must handle both contexts:

1. **Direct hook** (panel context): check `window.__slicc_*` — if present, call directly
2. **Message relay** (offscreen context): send `chrome.runtime.sendMessage({ source: 'offscreen', payload: { type: '...', ... } })` → service worker routes to panel → `OffscreenClient` handles in `setupMessageListener()`

```typescript
// Pattern: try direct hook, fall back to message relay
const toggle = (window as any).__slicc_debug_tabs;
if (toggle) {
  toggle(show); // Running in panel context
} else {
  chrome.runtime.sendMessage({ source: 'offscreen', payload: { type: 'debug-tabs', show } });
}
```

**Current example**: `debug-command.ts` uses this pattern. Panel registers hook in `main.ts`; `offscreen-client.ts` handles the relay message.

**Related Files**

- `packages/webapp/src/shell/supplemental-commands/debug-command.ts` (dual-context command, tries hook then relay)
- `packages/webapp/src/ui/main.ts` line 187 (registers `__slicc_debug_tabs` hook)
- `packages/webapp/src/ui/offscreen-client.ts` line 235 (relays `debug-tabs` message to hook)
- `packages/webapp/src/ui/layout.ts` `setDebugTabs()` (UI state — adds/removes tabs dynamically)
- `packages/webapp/src/ui/tabbed-ui.ts` `setHiddenTabs()` (persistence — saves to localStorage)

## Dual-Mode Testing Checklist

When adding a feature that touches:

- Browser APIs (fetch, storage)
- Dynamic code execution (JavaScript tool, node command)
- WASM libraries (ImageMagick, Pyodide)
- Network access (git, curl)

**Tests**

- [ ] New pure-logic code has unit tests (run in Node)
- [ ] Code has three-branch detection if behavior differs (Node/Extension/Browser)
- [ ] Fetch uses `/api/fetch-proxy` in CLI, direct fetch in extension
- [ ] WASM loading uses `chrome.runtime.getURL()` in extension mode
- [ ] No dynamic code construction on extension pages

**Manual Testing**

- [ ] Test in standalone CLI mode (`npm run dev`)
- [ ] Test in extension mode (`npm run build -w @slicc/chrome-extension` → load in chrome://extensions)
- [ ] If added WASM, verify bundled path in extension build
- [ ] If added command, test in both terminal modes
