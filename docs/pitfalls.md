# Pitfalls & Gotchas

Common mistakes when working on SLICC. All subsystems must work in both **CLI mode** (Node.js/Express + Chrome) and **extension mode** (Chrome extension side panel). This document captures dual-mode incompatibilities and the patterns to fix them.

## Extension CSP & Dynamic Code Execution

**The Problem**

Chrome extension Manifest V3 blocks dynamic code construction on extension pages. This breaks:

- Constructor-based code execution
- Indirect code evaluation
- Dynamic code execution anywhere in extension pages

**The Solution: Sandbox Iframe**

All dynamic code execution (JavaScript tool, `node -e`) routes through a sandboxed iframe (`sandbox.html`) exempt from extension CSP. Sprinkles and dips use a separate sandbox (`sprinkle-sandbox.html`).

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

Chrome's side panel cannot host macOS TCC (Transparency, Consent, and Control) permission dialogs, and it also crashes (rather than throwing a normal error) when `showDirectoryPicker()` is called against a system folder Chrome refuses to share (Documents, Downloads, Desktop, the home directory). Solution: never call `showDirectoryPicker()` from the side panel — route directory selection through a popup window where TCC and the system-folder rejection render correctly. The pattern is implemented by `packages/chrome-extension/mount-popup.html` and the shared helpers in `packages/webapp/src/fs/mount-picker-popup.ts` (`openMountPickerPopup` + `loadAndClearPendingHandle` + `reactivateHandle`). All three extension-side mount entry points use it: the shell `mount` command, agent-driven approval dips, and the welcome sprinkle's `request-mount` lick.

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

## emscripten WASM Heap Views: Copy Inside the Callback

WASM modules built with emscripten — magick-wasm, Pyodide, sql.js — hand
JavaScript callbacks `Uint8Array` views **into the WASM linear memory**, not
owned buffers. After the callback returns, the runtime is free to reuse that
memory region for other allocations. Holding the raw view across any
subsequent `await` (or simply waiting for the next emscripten operation) lets
later allocations clobber the bytes you thought you captured.

The `convert` command had exactly this bug: `image.write(format, (data) => {
outputData = data; })` followed by `await ctx.fs.writeFile(path, outputData)`.
The output JPEG landed on disk as 1192 KB of UTF-8 text with CRLF terminators
— emscripten's housekeeping output that had reused the memory slot in the
meantime. Symptom only surfaced in extension/offscreen mode because of
allocator timing.

**The rule**: snapshot inside the callback with `new Uint8Array(data)` before
the closure returns.

| Site                                             | Status                                                                             |
| ------------------------------------------------ | ---------------------------------------------------------------------------------- |
| `shell/supplemental-commands/convert-command.ts` | Snapshots via `new Uint8Array(data)`; regression test in `convert-command.test.ts` |
| `core/image-processor.ts`                        | Snapshots via `new Uint8Array(data)`                                               |
| `cdp/browser-api.ts`                             | Consumes the view inside the callback to build base64 (no escape)                  |

## Python Realm: VFS Sync Is Diff-Aware and Size-Capped

**File**: `packages/webapp/src/kernel/realm/py-realm-shared.ts`

Pre- and post-execution sync between the VFS and Pyodide's emscripten FS uses
two bulk RPCs — `vfs.walkTree` (host → realm: paths + sizes + content) and
`vfs.writeBatch` (realm → host: mkdirs + file writes). The naive per-file
`readDir`/`stat`/`readFile` chatter took minutes on workspace-sized cwds; the
bulk path collapses that to two round-trips regardless of file count.

| Behavior                             | Why                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **10 MB file-size cap**              | Files above the cap are listed (Python sees the directory entry + the `size` field) but their content is not pre-loaded. `open()` raises ENOENT. Cap-exceeded files are **silently** skipped — a documented constraint, not an error worth surfacing on every invocation. Files that are within the cap but fail to read from the host DO warn so the user can debug the real failure. |
| **Size-only diff**                   | Post-sync compares Pyodide-FS size against the pre-execution snapshot; same-size content changes can slip through. The trade-off is intentional; if it ever flips to hash-based diffing, the test pinning this should be updated, not deleted.                                                                                                                                         |
| **Binary content via Uint8Array**    | `walkTree`/`writeBatch` carry content as `Uint8Array`, not `string`, so PNG / PDF / wheel / sqlite files in cwd round-trip byte-for-byte. The previous string-based path silently corrupted any non-UTF-8 byte via `TextDecoder()` on the way out.                                                                                                                                     |
| **Per-entry write failures surface** | `writeBatch` returns `{ failedFiles, failedMkdirs }`; the realm pushes each into stderr so a Python script's `open('x','w').write(...)` failure can't disappear into the void.                                                                                                                                                                                                         |

When extending the sync (attribute mirroring, hash-based diffing, etc.), keep
the two-RPC shape — adding round-trips inside the loop reintroduces the
minutes-long stall — and keep `content: Uint8Array` so binary outputs don't
regress to the TextDecoder corruption path.

## Runtime Detection: Workers Have No `window` Either

**The Problem**

`typeof window === 'undefined'` looks like a Node-vs-browser check but is actually a
"no DOM" check — and a DedicatedWorker has no `window` either. The CLI standalone
kernel runs in a DedicatedWorker (`packages/webapp/src/kernel/kernel-worker.ts`),
the realm runners run in DedicatedWorkers in both floats, and the offscreen
document does have a `window`. So `typeof window === 'undefined'` does NOT
distinguish "Node" from "browser worker."

The historical pattern in three resolvers — Pyodide indexURL, ImageMagick
`magick.wasm`, `sql.js` — used this check to switch between local `node_modules`
and the CDN. In CLI standalone, the agent shell runs in the kernel-worker (no
`window`), so the check resolved to `/node_modules/<pkg>/`, which Vite's dev
server doesn't serve — it returns the SPA fallback (`<!DOCTYPE …>`), and the
worker then tries to load the HTML as a WASM/JS module with the obvious error:

```
WebAssembly.instantiate(): expected magic word 00 61 73 6d, found 3c 21 44 4f
Failed to fetch dynamically imported module: …/pyodide.asm.js (MIME text/html)
```

**The Fix**

Use the helpers in `packages/webapp/src/shell/supplemental-commands/shared.ts`:

| Helper                 | True when…                                                                                    |
| ---------------------- | --------------------------------------------------------------------------------------------- |
| `isNodeRuntime()`      | `typeof process !== 'undefined' && process.versions?.node` — vitest, node-server tooling      |
| `isExtensionRuntime()` | `typeof chrome !== 'undefined' && chrome?.runtime?.id` — extension origin (incl. its workers) |

Branch order must be **extension → node → browser CDN**: extension wins because
extension workers also have `process`-less, `window`-less contexts where the CDN
branch would be wrong (extension CSP blocks CDN), and Node wins over the
browser-CDN fallback because vitest must not hit jsdelivr for unit tests.

See `resolvePyodideIndexURL()` in `kernel/realm/realm-factory.ts` and
`getMagick()` / `getSqlJs()` for the canonical pattern.

## Node Command: Three-Branch Path

**File**: `packages/webapp/src/shell/supplemental-commands/node-command.ts`

| Branch        | Condition                                                | Behavior                                                                                    |
| ------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| **Extension** | `typeof chrome !== 'undefined' && !!chrome?.runtime?.id` | Wraps code with process/console/module shims, posts to sandbox iframe, parses JSON response |
| **CLI**       | Default                                                  | Uses constructor directly, accesses VirtualFS via `ctx.fs` bridge                           |

The extension branch (lines 145–228) rebuilds the node shimmed environment inside the sandbox iframe because the sandbox has no access to the shell context.

## JS Realm require(): Native-Package Guard + Pre-Fetch Timeout

`require()` resolution in JS realms goes through two guard rails before
the actual CDN fetch — without them, a stray `require('sharp')` parked the
realm for minutes on a transitive `.node` loader fetch that never settled.

1. **`NODE_NATIVE_PACKAGES` hard-fail set** — packages that ship C++
   bindings via node-gyp/prebuild (sharp, canvas, sqlite3, better-sqlite3,
   bcrypt, fsevents, robotjs, puppeteer, sass-embedded, tree-sitter, …).
   The shim throws at pre-fetch time with a clear error and a hint
   pointing the caller at a WASM-backed shell command — `convert` for
   images, `sqlite3` for SQL, `crypto.subtle` for hashing.

2. **`LOAD_MODULE_TIMEOUT_MS` (15 s)** — caps every actual `loadModule(id)`
   so a CDN stub that stalls on a transitive import can't park
   `Promise.allSettled` indefinitely. The rejection includes the
   specifier and elapsed seconds so the agent knows what to drop.

**One canonical source + two hand-mirrors must stay in lockstep.** Adding
a package to the native set means updating all three. Worker JS realm
(`js-realm-shared.ts`) imports the canonical module, so it doesn't need
hand-syncing.

| Site                                                 | Notes                                                                                                                                          |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/webapp/src/kernel/realm/require-guards.ts` | **Canonical** TS module; helpers + sets unit-tested in `require-guards.test.ts`. Worker JS realm imports from here, no drift surface.          |
| `packages/chrome-extension/sandbox.html`             | Hand-mirror — extension iframe realm bundled outside the TS module graph. Pinned in `node-command-loadmodule.test.ts` + the parity test below. |
| `packages/webapp/src/shell/bsh-watchdog.ts`          | Hand-mirror — `.bsh` runtime injected into target page via CDP `Runtime.evaluate`. Pinned in `bsh-watchdog.test.ts`.                           |

The mirror-parity test in `bsh-watchdog.test.ts` walks every entry from
the canonical `NODE_NATIVE_PACKAGES` and asserts both hand-mirrors carry
it. A package added to the canonical set without mirroring fails CI
rather than silently re-enabling the 5-minute realm hang.

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

| Mode          | Fetch Strategy                                       | CORS Handling                                                                                |
| ------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| **CLI**       | `createProxiedFetch()` → `/api/fetch-proxy`          | Cross-origin requests proxy through Express endpoint with secret unmask/scrub                |
| **Extension** | `createProxiedFetch()` → `fetch-proxy.fetch` SW Port | Routes through service worker Port handler with secret unmask/scrub; uses `host_permissions` |

**Git CORS**: Same rules apply to isomorphic-git HTTP requests (clone, push, pull). Both modes now route through `createProxiedFetch()`.

## Kernel-Worker Fetch Bypass: Same-Origin Only

`packages/webapp/src/kernel/kernel-worker.ts` wraps `globalThis.fetch` to
stamp `x-bypass-llm-proxy: 1` so the page-installed LLM-proxy SW doesn't
re-route worker-issued requests. The wrapper is **scoped to same-origin
requests only** — helper extracted to
`packages/webapp/src/kernel/kernel-worker-fetch-bypass.ts` and unit-tested
in `kernel-worker-fetch-bypass.test.ts`.

Why the same-origin gate? Custom headers on cross-origin requests force a
CORS preflight, and strict CDNs (jsdelivr, sql.js.org, …) reject the
preflight because their `Access-Control-Allow-Headers` list doesn't include
`x-bypass-llm-proxy`. Pyodide and ImageMagick used to noisily fall back to
non-streaming WASM instantiation every load until the wrapper was scoped.

Cross-origin worker fetches are intentionally left bare so the SW can route
them through `/api/fetch-proxy` (one server hop). For one-shot wasm/asset
payloads the round-trip cost is acceptable. `proxiedFetch` already targets
same-origin `/api/fetch-proxy` directly, so LLM API streaming is unaffected.

## SW respondWith: Wrap Proxy Responses to Preserve the Request URL

`llm-proxy-sw.ts`'s `forwardThroughProxy()` cannot return the
`fetch('/api/fetch-proxy')` Response directly. When the consumer of the
intercepted request is an ESM module loader, the browser uses
`response.url` as the base URL for resolving relative sub-imports. If the
SW responds with the proxy fetch verbatim, `response.url` is
`http://localhost:5710/api/fetch-proxy`, and a response body that contains
`import './x.mjs'` lands at `http://localhost:5710/x.mjs` — Vite's SPA
fallback then returns `text/html` and the import fails with "Failed to
load module script".

Wrap in a synthetic `new Response(body, { status, statusText, headers })`.
The SW contract resolves `response.url` to the **original request URL**
for synthetic responses, so relative imports point back at the cross-origin
host (where they're re-intercepted and proxied again). Body stays a
streamed `ReadableStream` so SSE token-by-token UX for LLM completions is
unchanged.

## Response Status Code Constraints

**The Problem**

`new Response('', { status: 0 })` throws `RangeError: Failed to construct 'Response': Invalid status code (0)`. The Fetch API requires status codes in range 200-599.

**The Solution**

Use `413 Payload Too Large` for oversized requests instead of `status: 0`. The SW `fetch-proxy.fetch` handler uses a 32MB request-body cap and returns 413 when exceeded.

```typescript
// WRONG
return new Response('', { status: 0 });

// RIGHT
return new Response('Request body exceeds 32MB limit', { status: 413 });
```

## Chrome Port: onMessage Listener Must Attach Synchronously

**The Problem**

When an MV3 service worker handles a `chrome.runtime.onConnect` event, page-side callers will routinely call `port.postMessage(...)` immediately after `chrome.runtime.connect({name})` resolves. Chrome **drops port messages that arrive before any `port.onMessage` listener is attached**. If the SW's `onConnect` callback awaits anything (e.g. an async pipeline build) before attaching the listener, the page's first message is silently lost — the caller's promise hangs forever waiting for a response that never comes.

This is exactly what bit the secret-aware fetch proxy: the SW's original handler did `buildSecretsPipeline()` (involving `chrome.storage.local` reads) inside `.then(...)` and attached the listener afterward. `curl` from the extension panel terminal hung with no error and no disconnect.

**The Solution**

Attach `port.onMessage.addListener(...)` **synchronously** inside the `onConnect` callback, and `await` any async setup INSIDE that listener:

```typescript
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'my-channel') return;
  const pipelinePromise = buildPipeline(); // kick off async work
  port.onMessage.addListener(async (msg) => {
    // <-- ATTACHED SYNC
    const pipeline = await pipelinePromise; // <-- AWAIT INSIDE
    // ... handle msg using pipeline
  });
});
```

See `packages/chrome-extension/src/fetch-proxy-shared.ts:handleFetchProxyConnectionAsync` for the production pattern. Regression test: `packages/chrome-extension/tests/fetch-proxy-shared.test.ts` — "handleFetchProxyConnectionAsync — synchronous listener attach".

## Offscreen Documents: Smaller chrome.\* Surface than the SW

**The Problem**

MV3 offscreen documents inherit only a subset of the manifest's `permissions`. Notably, **`chrome.storage` is NOT exposed in offscreen documents** — even when the manifest grants `"storage"` and the SW has it. Code paths that work in the SW (where `chrome.storage.local.get(null)` returns instantly) throw `Cannot read properties of undefined (reading 'local')` when they end up running in offscreen.

This was hit by the `secret list` shell command: the panel-terminal `WasmShellHeadless` is hosted in the offscreen document (via `createPanelTerminalHost`), and `chrome.storage.local.get(...)` from inside the supplemental command callback throws.

**The Solution**

For management operations that must touch `chrome.storage.local`, **route through the SW via `chrome.runtime.sendMessage`**. The SW has full storage access. Add a handler in `service-worker.ts:onMessage` that performs the storage call and replies via `sendResponse`. See the `secrets.list` / `secrets.set` / `secrets.delete` handlers there for the canonical pattern. Always `return true` from the listener for async work, and always include `chrome.runtime.lastError` handling on the caller side.

## SecretsPipeline Mutation Pitfall

**The Problem**

`SecretsPipeline.unmaskHeaders(headers, hostname)` mutates its input parameter in place. This matches the legacy `SecretProxyManager` semantics but is easy to miss.

**The Solution**

Expect the mutation. If you need the original headers preserved, clone them first:

```typescript
const originalHeaders = { ...headers };
pipeline.unmaskHeaders(headers, hostname); // headers is now mutated
```

This design choice preserves compatibility with existing node-server callers that rely on in-place mutation.

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
- [ ] Both modes proxy via `createProxiedFetch` (CLI to `/api/fetch-proxy`, extension to `fetch-proxy.fetch` Port)
- [ ] WASM loading uses `chrome.runtime.getURL()` in extension mode
- [ ] No dynamic code construction on extension pages

**Manual Testing**

- [ ] Test in standalone CLI mode (`npm run dev`)
- [ ] Test in extension mode (`npm run build -w @slicc/chrome-extension` → load in chrome://extensions)
- [ ] If added WASM, verify bundled path in extension build
- [ ] If added command, test in both terminal modes

## Adobe Proxy `X-Session-Id` on LLM Call Paths

**The Problem**

Every request from SLICC to the Adobe LLM proxy must carry an
`X-Session-Id` HTTP header. The proxy uses it to group requests into
one logical session for usage telemetry. When the header is absent,
the proxy falls back to a content-derived `sha256(userId +
firstHumanText[:200])` — a 64-char hex hash that fragments multi-turn
conversations across many session ids and leaves them unclassified in
the dashboard. Every individual event is still captured correctly;
only session-level grouping breaks.

The header rides on `pi-ai`'s `StreamOptions.headers`, which every
provider's `streamSimple` honors. Any code path that calls the LLM
without going through the agent loop or the compaction transformer
will silently bypass it — and the resulting events can't be re-grouped
after the fact.

**The Two Enforcement Points**

| Code path                                     | Wiring                                           | Where                                                               |
| --------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------- |
| Agent loop (cone, scoops, tool turns)         | `streamFn` wrapper passed to `Agent` constructor | `packages/webapp/src/scoops/scoop-context.ts` `streamWithSessionId` |
| Compaction summaries (Pi packed-conversation) | `headers` config on `createCompactContext`       | `packages/webapp/src/scoops/scoop-context.ts` `compactionHeaders`   |

Both paths attach the same identifier from `getAdobeSessionId(scoop,
coneJid)` in `packages/webapp/src/scoops/llm-session-id.ts` (a
daily-rotating UUID for the cone, `<uuid>/<hash(folder, uuid)>` for
scoops), gated on `model.provider === 'adobe'`. Other providers
receive no header.

**Adding a New LLM Call Site**

If you add code that calls `pi-ai`'s `streamSimple` / `completeSimple`
directly — or any helper from `@earendil-works/pi-coding-agent` that
routes there (compaction, branch summarization, etc.) — you MUST
attach `X-Session-Id` for the Adobe provider. The cleanest pattern is
to take a `headers: Record<string, string>` parameter and let the
caller inject it the same way `createCompactContext` does. Don't
replicate the Adobe-provider check at every site — push it up to
whoever owns the call.

**The pi-coding-agent Stub Tripwire**

`pi-coding-agent`'s `generateSummary` is positional, and our local
ambient stub at
`packages/webapp/src/types/pi-coding-agent-compaction.d.ts` shadows
resolution to upstream's `.d.ts` under `moduleResolution: bundler`.
Upstream 0.63.0 inserted `headers?` at slot 4 and shifted `signal?`
to slot 5. Our stub kept the pre-0.63 shape, so our positional caller
silently routed the AbortSignal into the new `headers` slot — and we
lost the header on every compaction summary for ~6 weeks before proxy
telemetry surfaced it.

The compile-time contract at
`packages/webapp/src/types/pi-coding-agent-compaction.contract.ts`
pins slot 4 (`headers`) and slot 5 (`signal`). If a future stub edit
shifts those positions, `tsc` fails. It does **not** catch
upstream-only drift (a renovate bump that ships without any stub
edit) — that requires either an upstream PR exposing `./compaction` in
pi-coding-agent's exports map (so we can drop the stub) or a tsconfig
`paths` mapping bypassing the exports map. The upstream PR is in
flight; tracked separately.

**Verifying a Fix**

After deploying anything that touches LLM call paths or the session-id
wiring, query the LLM-monitoring D1:

```sql
SELECT date(created_at) AS day, COUNT(*) AS hex_events
FROM usage_events
WHERE created_at >= '<deploy-day>T00:00:00Z'
  AND length(session_id) = 64
  AND session_id GLOB '[0-9a-f]*'
  AND session_id NOT LIKE '%-%'
GROUP BY day ORDER BY day DESC;
```

`hex_events` should be ~0 on new days. If it spikes after a change
that touched LLM call paths, a new code path is bypassing the wiring.

**Related**

- Bug fix: PR #600 attached `X-Session-Id` to compaction; PR #378
  attached it to the agent loop.
- Tripwire: PR #600 added the positional contract.
- Coverage: `tests/scoops/scoop-context.session-id.test.ts` asserts
  both wiring points use the same identifier; gates against future
  reverts.

## Detached popout: boot is the lock event

The detached popout flow accepts three entry paths: the side-panel
"Pop out" button, direct URL navigation (paste/bookmark), and
Chrome's tab restore. ALL three converge on the detached tab's boot
emitting a `detached-claim` envelope to the SW — the button is a
convenience, not a trust signal. Spec:
`docs/superpowers/specs/2026-05-13-extension-detached-popout-design.md`.

## Detached popout: claim URL validation

The SW's claim handler parses `sender.url` as a URL and validates
`origin`, pathname (`/index.html` or `/`), and
`searchParams.get('detached') === '1'`. Substring matches on
`sender.url` MUST NOT be used — they are brittle to query reordering.

## Detached popout: top-frame requirement for claim emission

`detached-claim` MUST be sent from the detached tab's top frame
because validation uses the sender document URL; a nested
sprinkle iframe will not carry `?detached=1` and the claim will
be rejected. Future code that moves the claim-emit point must
preserve this.
