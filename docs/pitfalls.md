# Pitfalls & Gotchas

Common mistakes when working on SLICC. All subsystems must work in both **CLI mode** (Node.js/Express + Chrome) and **extension mode** (Chrome extension side panel). This document captures dual-mode incompatibilities and the patterns to fix them.

## Extension CSP & Dynamic Code Execution

**The Problem**

Chrome extension Manifest V3 blocks dynamic code construction on extension pages. This breaks:
- Constructor-based code execution
- Indirect code evaluation
- Dynamic code execution anywhere in extension pages

**The Solution: Sandbox Iframe**

All dynamic code execution (JavaScript tool, `node -e`) routes through a sandboxed iframe (`sandbox.html`) exempt from extension CSP.

| Component | CLI Behavior | Extension Behavior |
|-----------|--------------|-------------------|
| **JavaScript tool** | Inline iframe with IFRAME_HTML string and constructor | Routes through `sandbox.html` via postMessage |
| **Node command** | Direct constructor usage | Wraps user code, posts to sandbox iframe |
| **Fetch proxy** | `/api/fetch-proxy` endpoint | Same sandbox iframe postMessage |

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

| Aspect | Details |
|--------|---------|
| **Sandbox file** | `sandbox.html` (project root, copied to `dist/extension/` by vite config) |
| **Exec pattern** | Parent page sends `{ type: 'exec', id, code }`, sandbox posts back `{ type: 'exec_result', id, result, logs, error }` |
| **VFS bridge** | Sandbox iframe uses same postMessage pattern for VFS operations (readFile, writeFile, etc.) |
| **Shared iframe** | JavaScript tool and node command share the same sandbox iframe (find via `document.querySelector('iframe[data-js-tool]')`) |
| **Wait for load** | In extension mode, must await sandbox iframe `load` event before posting messages |

**Related Files**
- `src/tools/javascript-tool.ts` lines 248–270 (dual-mode iframe setup)
- `src/shell/supplemental-commands/node-command.ts` lines 145–221 (extension routing)
- `sandbox.html` (entry point, must load in extension via `chrome.runtime.getURL()`)

## WASM & Bundled Assets in Extension Mode

**The Problem**

Extension CSP also blocks CDN fetches and dynamic asset loading. ImageMagick WASM and Pyodide must be bundled and loaded via `chrome.runtime.getURL()`.

| Asset | Solution |
|-------|----------|
| **ImageMagick WASM** | Bundled at `dist/extension/magick.wasm`. Fetch as bytes: `const bytes = await fetch(chrome.runtime.getURL('magick.wasm')).then(r => r.arrayBuffer())`. Pass as Uint8Array to initialization |
| **Pyodide** | Bundled at `dist/extension/pyodide/`. Load path: `chrome.runtime.getURL('pyodide/')` (trailing slash required) |
| **Sandbox HTML** | Loaded via `chrome.runtime.getURL('sandbox.html')` as iframe src |

**Build Integration**

File: `vite.config.extension.ts` `closeBundle` hook must:
1. Copy Pyodide from node_modules (~13MB) to `dist/extension/pyodide/`
2. Bundle ImageMagick WASM to `dist/extension/magick.wasm`
3. Ensure manifest `web_accessible_resources` includes all assets

## JavaScript Tool: Dual-Mode Pattern

**CLI Mode** (`src/tools/javascript-tool.ts` lines 262–270)

```typescript
iframe.sandbox.add('allow-scripts');
iframe.sandbox.add('allow-same-origin');
document.body.appendChild(iframe);
const doc = iframe.contentDocument!;
doc.open();
doc.write(IFRAME_HTML);
doc.close();
iframeReady = Promise.resolve(iframe);  // Synchronous
```

**Extension Mode** (`src/tools/javascript-tool.ts` lines 250–260)

```typescript
iframeReady = new Promise<HTMLIFrameElement>((resolve) => {
  iframe!.addEventListener('load', () => {
    resolve(iframe!);
  }, { once: true });
  iframe!.src = chrome.runtime.getURL('sandbox.html');
  document.body.appendChild(iframe!);
});
```

Key difference: extension mode must **wait for load event** before posting messages. CLI mode is synchronous.

## Node Command: Three-Branch Path

**File**: `src/shell/supplemental-commands/node-command.ts`

| Branch | Condition | Behavior |
|--------|-----------|----------|
| **Extension** | `typeof chrome !== 'undefined' && !!chrome?.runtime?.id` | Wraps code with process/console/module shims, posts to sandbox iframe, parses JSON response |
| **CLI** | Default | Uses constructor directly, accesses VirtualFS via `ctx.fs` bridge |

The extension branch (lines 145–228) rebuilds the node shimmed environment inside the sandbox iframe because the sandbox has no access to the shell context.

## RestrictedFS Path Behavior

**File**: `src/fs/restricted-fs.ts`

| Operation | Outside Allowed Path | Inside Allowed Path |
|-----------|---------------------|-------------------|
| **readFile** | ENOENT | Read succeeds |
| **readDir** | Empty array | Filtered to allowed entries only |
| **stat** | ENOENT | Stat succeeds |
| **exists** | false | true/false as appropriate |
| **writeFile** | **EACCES** (hard error) | Write succeeds |
| **mkdir** | **EACCES** (hard error) | Creates directory |
| **rm** | **EACCES** (hard error) | Removes recursively |

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

| Rule | Example | Violation |
|------|---------|-----------|
| **Absolute** | `/foo/bar`, `/` | `foo/bar` (relative), `./foo` |
| **Forward-slash only** | `/path/to/file` | `\path\to\file` (backslash) |
| **Normalized** | `/a/b/c` | `/a//b/c` (double slash), `/a/b/./c` (dot-slash) |
| **No symlinks** | All paths real | Symlinks not supported; read underlying target |

**Normalization**: Use `normalizePath(path)` from `src/fs/path-utils.ts` before any VFS operation.

## Voice Input: Extension Workaround

**File**: `src/ui/voice-input.ts`

**The Problem**

Chrome extension side panels cannot trigger mic permission prompts. `navigator.mediaDevices.getUserMedia()` silently fails.

**The Solution**

Fallback to a popup window (`voice-popup.html`) for the one-time mic permission grant.

| Scenario | Flow |
|----------|-------|
| **CLI mode** | `getUserMedia()` → permission prompt → speech recognition starts |
| **Extension, first use** | `getUserMedia()` fails → open popup window → user grants permission → popup closes → direct mic access cached per origin |
| **Extension, subsequent uses** | Permission cached → `getUserMedia()` succeeds → speech recognition starts directly in side panel |

**Code**: Lines 109–130 (try getUserMedia, catch failure in extension mode → fallback to popup).

**Popup Window Details**
- URL: `chrome.runtime.getURL('voice-popup.html?lang=...')`
- Messaging: side panel ↔ popup via `chrome.runtime.onMessage`
- Cleanup: popup sends `'speech-end'` message, side panel closes window and clears listeners

## CDP Transport: Extension Mode

**File**: `src/cdp/debugger-client.ts`

**The Problem**

Extension CSP blocks WebSocket. CDP proxy at `/cdp` endpoint unavailable in extension mode.

**The Solution**

Use `chrome.debugger` API to control tabs directly.

| Operation | CLI Mode | Extension Mode |
|-----------|----------|-----------------|
| **Target.getTargets** | WebSocket to `/cdp` | `chrome.tabs.query()` |
| **Target.attachToTarget** | WebSocket message | `chrome.debugger.attach({ tabId }, version)` |
| **Target.detachFromTarget** | WebSocket message | `chrome.debugger.detach({ tabId })` |
| **Target.createTarget** | WebSocket message | `chrome.windows.create()` + `chrome.tabs.create()` |
| **Other CDP commands** | Pass through WebSocket | `chrome.debugger.sendCommand()` |

**Session Management**: DebuggerClient maps synthetic `sessionId` → Chrome `tabId` (line 20). All CDP event listeners receive `sessionId` in params for filtering.

**Active Tab Detection**: BrowserAPI includes `active` field (boolean) only in extension mode, identifying the user's currently focused tab for intelligent tool auto-dispatch.

## Leader Tray WebSocket: Extension Mode

**The Problem**

Leader tray bootstrap waits for a `leader.connected` control frame. In extension mode, that WebSocket must not live in the offscreen document.

**The Solution**

Host the real leader tray `WebSocket` in `src/extension/service-worker.ts` and relay frames through `chrome.runtime.sendMessage`. The offscreen document should use `ServiceWorkerLeaderTraySocket` from `src/extension/tray-socket-proxy.ts` as the `LeaderTrayManager` `webSocketFactory`.

| Mode | Leader tray socket owner |
|------|--------------------------|
| **CLI** | Direct `WebSocket` in the app runtime |
| **Extension** | Service worker proxy, not the offscreen document |

## Fetch Proxy: CORS & CSP

| Mode | Fetch Strategy | CORS Handling |
|------|---|---|
| **CLI** | Direct fetch | Cross-origin requests proxy through `/api/fetch-proxy` endpoint |
| **Extension** | Direct fetch | Uses `host_permissions` in manifest; no server proxy needed |

**Git CORS**: Same rules apply to isomorphic-git HTTP requests (clone, push, pull).

## Two TypeScript Targets

**The Problem**

The codebase has two independent TypeScript builds:
- **Browser bundle** (`tsconfig.json`): Everything except `src/cli/`
- **CLI server** (`tsconfig.cli.json`): Only `src/cli/`

Cross-importing breaks the build.

| Violation | Problem |
|-----------|---------|
| Browser code imports `src/cli/` | CLI-only modules not bundled; runtime import error |
| CLI code imports `src/ui/`, `src/extension/` | Browser-only code (DOM, chrome.debugger) not available in Node |

**How to Check**: `npm run typecheck` runs both configs. Fix: move shared code to `src/shared/` or duplicate type definitions.

## Node Version: >= 22 Required

**The Problem**

LightningFS (IndexedDB backend) references `navigator` in `DefaultBackend.init`. The `navigator` global was added to Node in v21. On Node 20 or earlier, tests that use VirtualFS fail with `ReferenceError: navigator is not defined`.

**The Fix**

Use Node 22 (current LTS) or later. This applies to both local development and CI. The GitHub Actions workflow (`.github/workflows/ci.yml`) pins `node-version: 22` for this reason.

## Node Shims & Vite Aliases

**The Problem**

Just-bash references Node builtins (`node:zlib`, `node:module`) that don't exist in browsers.

**The Solution**

Add aliases in `vite.config.ts`:

```typescript
// vite.config.ts lines 78–86
resolve: {
  alias: {
    'node:zlib': resolve(__dirname, 'src/shims/empty.ts'),
    'node:module': resolve(__dirname, 'src/shims/empty.ts'),
  },
}
```

**When Adding New Deps**

If a new npm dependency imports Node builtins:
1. Create a stub file in `src/shims/` exporting required symbols
2. Add alias in `vite.config.ts`
3. Test in both CLI and extension modes

**Example**: `@smithy/node-http-handler` imports `stream`, `http`, `https`, `http2` (stubbed at `src/shims/{stream,http,https,http2}.ts`).

## IndexedDB Database Names

Five databases exist:

| DB Name | Purpose | Used By |
|---------|---------|----------|
| **slicc-fs** | Virtual filesystem | VirtualFS (primary) |
| **slicc-fs-global** | Global state (backups) | Rarely; legacy |
| **browser-coding-agent** | UI session state | session-store.ts (Chat history, layout) |
| **agent-sessions** | Agent-level sessions | core/session.ts (Agent message logs) |
| **slicc-groups** | Orchestrator data | db.ts (scoops, messages, tasks, state) |

**When Testing**: Use unique `dbName` in tests or reset IndexedDB between runs (avoid cross-test pollution).

```typescript
// Example: use a unique name per test
const vfs = new VirtualFS(`slicc-fs-test-${Date.now()}`);
```

## Browser Tab Hygiene

| Practice | Reason |
|----------|--------|
| **Close tabs after use** | Browser test cleanup; prevents memory leaks |
| **Exclude /preview/ URLs** | Preview tabs (served by preview-sw.ts) must not be identified as the SLICC app tab |
| **Auto-resolve active tab** | BrowserAPI auto-selects the user's focused tab when `targetId` is omitted |

**Code**: BrowserAPI excludes `/preview/` URLs when searching for the app tab (prevents false positives).

## Scoop Lifecycle

**File**: `src/scoops/orchestrator.ts`

| Operation | Effect |
|-----------|--------|
| **drop_scoop** | Removes scoop context + clears message buffer. **Does NOT delete** filesystem files under `/scoops/{name}/` |
| **feed_scoop** | Queues message to scoop. If scoop is busy, message **waits in queue** (not dropped) |
| **Webhook/cron guards** | Lick manager blocks `drop_scoop` if webhooks or cron tasks are **active** for that scoop |

**Pattern**: Dropping a scoop is reversible (files remain). Re-creating the scoop later re-uses the same filesystem.

## Message Queueing

Scoops have a **sequential message queue**:
- User sends multiple prompts → queued
- Each prompt waits for prior one to complete
- No dropped messages
- Applies to cone and all scoops

**Related**: Context compaction may truncate very old messages if total context exceeds token limit (see `src/core/context-compaction.ts`).

## Preview Service Worker: Build Strategy

**File**: `src/ui/preview-sw.ts`

**The Problem**

Rollup code-splits shared dependencies (LightningFS) into a common chunk. Service Workers can't import shared chunks.

**The Solution**

Build preview-sw.ts as a self-contained IIFE via esbuild (not Rollup).

| Mode | Build | Output |
|------|-------|--------|
| **Dev** | Vite plugin `preview-sw-builder` (esbuild on-demand) | Served at `/preview-sw.js` |
| **Prod** | `vite.config.ts` `closeBundle` hook (esbuild bundle) | Written to `dist/ui/preview-sw.js` |

Both use `format: 'iife'` to avoid code-splitting.

**When Modifying preview-sw.ts**
1. Test in dev mode (`npm run dev:full`)
2. Verify prod build includes bundle (`npm run build`, check `dist/ui/preview-sw.js` for LightningFS code)
3. Update **both** hooks if adding imports

## Logging: createLogger Not console.*

**The Problem**

`console.log()` appears only during active browsing (hard to debug async code). Also not level-filtered.

**The Solution**

Use `createLogger()` from `src/core/logger.ts`:

```typescript
import { createLogger } from '../core/logger.js';
const log = createLogger('feature:name');

log.debug('Detail message', { data });  // Only in dev mode
log.info('Info message');               // Always shown
log.error('Error message', { error });  // Always shown
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
- [ ] Test in standalone CLI mode (`npm run dev:full`)
- [ ] Test in extension mode (`npm run build:extension` → load in chrome://extensions)
- [ ] If added WASM, verify bundled path in extension build
- [ ] If added command, test in both terminal modes
