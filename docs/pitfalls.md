# Pitfalls & Gotchas

Common mistakes when working on SLICC. All subsystems must work in both **CLI mode** (Node.js/Express + Chrome) and **extension mode** (the thin Chrome extension: service worker bridge + MAIN-world content-script launcher + the hosted webapp on `https://www.sliccy.ai`). This document captures dual-mode incompatibilities and the patterns to fix them.

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

| Pattern                                    | How it works                                                                                                                                            | Used by                                        |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| **Fetch-and-inline (full-doc)**            | Webapp scans HTML for `<script src="https://...">`, fetches content, replaces with `<script>inline</script>` before sending to sandbox                  | `sprinkle-renderer.ts:inlineExternalScripts()` |
| **Parent relay (partial)**                 | Sandbox sends `sprinkle-fetch-script` to parent via postMessage, parent fetches, returns `sprinkle-fetch-script-response`                               | `sprinkle-sandbox.html:fetchScriptViaRelay()`  |
| **Static `<script src>` in `<head>` only** | Extension-relative scripts must load statically in the initial HTML, not via dynamic `createElement`                                                    | `sprinkle-sandbox.html` lines 8-10             |
| **Guard `document.body` with try-catch**   | Scripts loaded in `<head>` must guard `observer.observe(document.body)` — use try-catch, not DOMContentLoaded (which interferes with sandbox page load) | `lucide-icons.ts`                              |

**Key rules for extension sandbox development:**

1. **Never use `<script src="https://...">` in sandbox HTML** — it will be blocked by CSP. Use fetch-and-inline or the parent relay instead.
2. **Never dynamically create `<script>` elements with extension-relative `src`** — opaque origin blocks runtime loads. Load statically in `<head>`.
3. **Never call `import()` with external URLs in sandbox context** — CSP blocks it and generates noisy console errors even when caught. `node -e`'s `require()` resolves only against the ipk-installed VFS `node_modules` graph; a missing bare module throws `Cannot find module 'x' (run: ipk install x)` instead of round-tripping a CDN. There is no jsdelivr / esm.sh fallback in any float.
4. **Always guard `document.body` in scripts loaded from `<head>`** — use `try {} catch {}` around `observer.observe(document.body)` rather than deferring to DOMContentLoaded (DOMContentLoaded listeners interfere with sandbox page load timing).
5. **Use the parent relay for cross-origin fetches** — sandbox null origin means CORS is unreliable. The parent webapp realm has full network access.
6. **Call `LucideIcons.render()` explicitly after injecting content in partial-content sprinkles** — the MutationObserver can't start in `<head>` (body is null), so icons won't auto-render. An explicit `render()` call after script execution handles this.
7. **Use function replacements with `String.replace` when the replacement contains fetched code** — `String.replace(str, replacement)` interprets `$&`, `$1`, etc. as special patterns. Minified libraries (e.g. lodash) contain `$&` in regex escape functions. Use `str.replace(match, () => replacement)` to prevent corruption.

**macOS TCC and Picker Crashes**

Chrome's `chrome-extension://`-origin surfaces cannot host macOS TCC (Transparency, Consent, and Control) permission dialogs, and they also crash (rather than throwing a normal error) when `showDirectoryPicker()` is called against a system folder Chrome refuses to share (Documents, Downloads, Desktop, the home directory). Solution: never call `showDirectoryPicker()` directly from a `chrome-extension://` context — route directory selection through a popup window where TCC and the system-folder rejection render correctly. The popup pattern and its three extension-side entry points are documented in [`docs/approvals.md` — Local mount picker](./approvals.md#local-mount-picker).

## WASM & Bundled Assets in Extension Mode

**The Problem**

Extension CSP also blocks CDN fetches and dynamic asset loading. ImageMagick WASM and Pyodide must be bundled and loaded via `chrome.runtime.getURL()`.

| Asset                | Solution                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **ImageMagick WASM** | Bundled at `dist/extension/magick.wasm`. Fetch as bytes: `const bytes = await fetch(chrome.runtime.getURL('magick.wasm')).then(r => r.arrayBuffer())`. Pass as Uint8Array to initialization                                                                                                                                                                                                             |
| **Pyodide**          | Bundled at `dist/extension/pyodide/`. Load path: `chrome.runtime.getURL('pyodide/')` (trailing slash required)                                                                                                                                                                                                                                                                                          |
| **ffmpeg-core JS**   | Bundled at `dist/extension/vendor/ffmpeg-core.js` (~112 KB). Load via `chrome.runtime.getURL('vendor/ffmpeg-core.js')`. The `ffmpeg-core.wasm` binary is NOT bundled and NOT fetched from a CDN — the user installs `@ffmpeg/core` via `ipk add @ffmpeg/core` and the loader reads the wasm from VFS `node_modules` through the shared `ipk` resolver; uninstalled invocations surface a guidance error |
| **Sandbox HTML**     | Loaded via `chrome.runtime.getURL('sandbox.html')` as iframe src                                                                                                                                                                                                                                                                                                                                        |

Standalone browser mode loads the Pyodide JS loader from the ipk-installed `/workspace/node_modules/pyodide/` via the preview SW (`resolvePyodideIndexURL` in `kernel/realm/realm-factory.ts`), not from jsdelivr — a missing install surfaces the canonical `ipk add pyodide` guidance error rather than a network fetch. The `PYODIDE_RUNTIME_CDN` constant remains the single documented runtime-CDN exception for Pyodide's wheel ecosystem only (downloaded on demand by `micropip` / `loadPackage`); keep `pyodide` pinned to an exact version in `package.json` so the npm loader and the wheel host stay in lockstep.

**Build Integration**

File: `packages/chrome-extension/vite.config.ts` `closeBundle` hook must:

1. Copy Pyodide from node_modules (~13MB) to `dist/extension/pyodide/`
2. Bundle ImageMagick WASM to `dist/extension/magick.wasm`
3. Copy `@ffmpeg/core/dist/esm/ffmpeg-core.js` (~112 KB) to `dist/extension/vendor/ffmpeg-core.js` and sanitize the leftover `unpkg.com/@ffmpeg/core@…/ffmpeg-core.js` literal that `@ffmpeg/ffmpeg`'s `const.js` bundles into the output (Chrome Web Store MV3 reviewers string-match full CDN URLs)
4. Ensure manifest `web_accessible_resources` includes all assets (`vendor/*` for ffmpeg-core)

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

## Python Realm: Mounts Are Async-Only Via `slicc.fs`

**Files**: `packages/webapp/src/kernel/realm/py-realm-shared.ts`,
`packages/webapp/src/kernel/realm/mount-bomb-fs.ts`,
`packages/webapp/src/kernel/realm/slicc-fs-module.ts`

Synchronous access to a mounted path from Python (stdlib `open`,
`os.listdir`, `pathlib`, pandas, …) is **intentionally disabled**. The realm
overlays a throwing FS plugin (`MOUNT_BOMB_FS`) at every VFS mount path that
overlaps the Python sync dirs, so the first sync touch raises immediately
with an actionable `OSError` instead of stalling on per-file RPC traffic. To
read or write under a mount, use the async `slicc.fs` Python module (or copy
the file into the VFS first).

This replaces the previous "eager materialization" model, which walked the
mount over the `vfs` RPC channel before user code ran. On a workspace-sized
local mount (~11k files) that produced ~24k sequential RPCs and hung
`python3` startup for minutes; the bomb overlay is instant — no walk, no
preload, no RPC traffic.

### The bomb error

Any sync `node_ops` or `stream_ops` call under a mounted path raises an
`OSError` (errno `EIO`) carrying:

```text
slicc: synchronous access to mounted path '<mountPath>' is not supported.
Use the async slicc.fs module (e.g. `await slicc.fs.read_text('<mountPath>')`
or `await slicc.fs.listdir('<mountPath>')`), or copy the file into the VFS
first (`await slicc.fs.read_bytes('<mountPath>/<file>')` then write it under
/tmp).
```

All mount kinds (`local` / `s3` / `da`) bomb identically — `kind` is
informational on the mount descriptor only, with no per-kind cap or
materialization budget. The cwd and `/tmp` (the default Python sync dirs,
overridable via `pyodideMountDirs`) remain directly accessible as before;
only paths under a registered VFS mount bomb. Mount paths that exactly match
a sync dir are excluded from the OPFS overlay so the bomb plugin can stack
without an `EBUSY` collision.

### The `slicc.fs` async API

`slicc.fs` is registered into `sys.modules` at realm startup (always — cheap
and harmless even when no mounts overlap) and is backed by the same `vfs`
RPC channel the file tools use, so reads under a mount path route through
the kernel-side `MountBackend` (local FS Access, S3, DA) transparently.
Every method is `async` and must be `await`ed.

| Method                              | Returns                                     | Notes                                                                                                |
| ----------------------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `listdir(path)`                     | `list[str]`                                 | Entry names (not full paths).                                                                        |
| `read_bytes(path)`                  | `bytes`                                     | Binary-safe; no encoding step.                                                                       |
| `read_text(path, encoding="utf-8")` | `str`                                       | Convenience wrapper over `read_bytes` + `decode`.                                                    |
| `write_bytes(path, data)`           | `None`                                      | `data` must be `bytes` / `bytearray` / `memoryview`. Passing `str` raises `TypeError`.               |
| `write_text(path, text, …)`         | `None`                                      | Convenience wrapper over `write_bytes` + `encode`.                                                   |
| `stat(path)`                        | `dict` with `isDirectory`, `isFile`, `size` | Minimal cross-backend shape; not a full `os.stat_result`.                                            |
| `exists(path)`                      | `bool`                                      |                                                                                                      |
| `mkdir(path, parents=False)`        | `None`                                      | Recursive on the host; `parents=False` raises `FileExistsError` when the target already exists.      |
| `remove(path)`                      | `None`                                      | Routes through `vfs.rm`.                                                                             |
| `walk(path)`                        | `list[tuple[str, list[str], list[str]]]`    | `os.walk`-shaped, but eager — entire subtree is materialized into the returned list before yielding. |

Example:

```python
import slicc

# Read from a mounted path — always await.
text = await slicc.fs.read_text("/mnt/aws/site/index.html")
print(text[:200])

# Write back through the same channel.
await slicc.fs.write_text("/mnt/aws/site/new.html", "<h1>hi</h1>\n")

# "Copy first" pattern for stdlib code that needs a real sync handle.
data = await slicc.fs.read_bytes("/mnt/da/docs/report.pdf")
with open("/tmp/report.pdf", "wb") as f:
    f.write(data)
import pdfplumber  # noqa: now reads from /tmp synchronously
```

The "copy first" pattern is the documented escape hatch for libraries that
take a path and read synchronously (`pdfplumber`, `pandas.read_csv`,
`sqlite3.connect`, …): `await slicc.fs.read_bytes(<mount path>)` then write
the bytes under `/tmp` (or another sync dir) and hand the library the local
path. The cwd and `/tmp` are OPFS-backed in the realm, so subsequent stdlib
access against them is synchronous.

### When extending this surface

- Keep the bomb instant: `mount(mount)` returns a single root `FsNode` with
  no preload, no walk, no RPC. Anything that adds RPC traffic at mount time
  reintroduces the hang the bomb overlay was added to fix.
- Keep `slicc.fs` the only documented escape hatch. Adding a second async
  Python surface (`slicc.io`, a `slicc.path` module, …) fragments the
  recovery story baked into the bomb's error message.
- Write-back is no longer a thing for mount paths — `slicc.fs.write_*`
  routes through `vfs` directly, so backend writes are applied as they
  happen rather than flushed at `realm-done`. Re-introducing a deferred
  write-back would silently swallow per-write errors that currently surface
  inline.

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

Leader tray bootstrap waits for a `leader.connected` control frame.

**The Solution**

In the thin extension the hosted leader tab (`https://www.sliccy.ai/?slicc=leader`) is a regular `https` page and owns the leader tray `WebSocket` directly via the standard page-side `LeaderSyncManager` (`packages/webapp/src/ui/page-leader-tray.ts`) — same shape as the standalone CLI. The service worker is not in the tray data path; it only pass-through-proxies CDP through the `bridge.cdp` Port in `packages/chrome-extension/src/bridge-sw.ts`.

| Mode          | Leader tray socket owner                                                       |
| ------------- | ------------------------------------------------------------------------------ |
| **CLI**       | Direct `WebSocket` in the app runtime                                          |
| **Extension** | Direct `WebSocket` in the hosted leader tab — identical to the standalone path |

Historical note: prior to the thin-bridge release, the extension hosted the leader tray socket in `service-worker.ts` and proxied frames into the offscreen document via `ServiceWorkerLeaderTraySocket`/`tray-socket-proxy.ts`. Both modules are gone.

## Silent OAuth renewal must stay windowless (IMS JS redirect)

`launchWebAuthFlow({ interactive: false })` alone flashes / fails for Adobe IMS
because its `prompt=none` page JS-redirects after load. Keep the
`abortOnLoadForNonInteractive: false` + `timeoutMsForNonInteractive` options in
`packages/chrome-extension/src/oauth-flow-options.ts`. See
`docs/oauth-intercept.md` "Silent token renewal".

## Fetch Proxy: CORS & CSP

| Mode          | Fetch Strategy                                       | CORS Handling                                                                                |
| ------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| **CLI**       | `createProxiedFetch()` → `/api/fetch-proxy`          | Cross-origin requests proxy through Express endpoint with secret unmask/scrub                |
| **Extension** | `createProxiedFetch()` → `fetch-proxy.fetch` SW Port | Routes through service worker Port handler with secret unmask/scrub; uses `host_permissions` |

**Git CORS**: Same rules apply to isomorphic-git HTTP requests (clone, push, pull). Both modes now route through `createProxiedFetch()`.

## Origin Contract: Forbidden Headers & Default-Origin Fallback

**The Problem**

Browsers silently strip a small set of "forbidden" request headers — `Origin`, `Referer`, `Cookie`, `Proxy-*` — from any `fetch()` call made in page or Service Worker contexts. A skill author writing `fetch(url, { headers: { Origin: 'https://foo.com' } })` will see that header vanish before it reaches the network. Upstream CORS-protected APIs that key on `Origin` then either reject the request or fall back to a content-derived bucket.

The extension float makes this worse: Chrome MV3 strips `Cookie`/`Referer`/`Proxy-*` from extension-SW `fetch()` regardless of the `init.headers` dict or `host_permissions`, **and** rewrites `Origin` to `chrome-extension://<id>` on the wire. So the obvious "decode `X-Proxy-*` back into the headers dict and call `fetch(url, { headers })`" approach is **not** sufficient in the SW — the headers are visible to JS but never reach the network.

**The Contract**

`createProxiedFetch()` and every `SecureFetch`-backed shell call (curl, `node -e "fetch(...)"`, `upskill`, `mcp invoke`, git, etc.) preserve forbidden headers in both floats via the same `X-Proxy-*` wire transport, but the two proxies use different mechanisms to actually land them on the upstream request, and both synthesize a default `Origin` when none survives.

| Step                                                                   | CLI                                                       | Extension                                                                                                                                                                       |
| ---------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Client encodes `Origin`/`Referer`/`Cookie`/`Proxy-*` as `X-Proxy-*`    | `createProxiedFetch` → `encodeForbiddenRequestHeaders`    | `extensionPortFetch` → `encodeForbiddenRequestHeaders` over `chrome.runtime`                                                                                                    |
| Proxy decodes `X-Proxy-*` back to real header names before upstream    | `/api/fetch-proxy` handler in `node-server/src/index.ts`  | SW `handleFetchProxyConnectionAsync` in `fetch-proxy-shared.ts`                                                                                                                 |
| Forbidden headers actually reach upstream                              | Yes — Node `fetch()` honors the init dict for every name  | **DNR rule required** — `installForbiddenHeaderRule` installs a per-request `chrome.declarativeNetRequest.updateSessionRules` `modifyHeaders` rule that rewrites them on egress |
| If no caller `Origin` survived, synthesize `<scheme>://<host>` of URL  | Yes — `new URL(targetUrl).origin`                         | Yes — `new URL(cleanedUrl).origin`                                                                                                                                              |
| Caller-supplied `Origin` always wins                                   | Decode runs before fallback                               | Decode runs before fallback; DNR `set` operation overrides the Chrome-injected extension Origin                                                                                 |
| Browser-injected `localhost` `Origin`/`Referer` stripped before refill | `isLocalhostOrigin` deletes it, fallback then synthesizes | (n/a — extension `Origin` is the extension ID, replaced by DNR or fallback)                                                                                                     |

**The DNR mechanism (extension SW only)**

`installForbiddenHeaderRule` in `packages/chrome-extension/src/fetch-proxy-shared.ts`:

1. Scans the decoded `headers` dict for forbidden names (`cookie`, `origin`, `referer`, anything `proxy-*`).
2. Mints a unique URL fragment token (`#slicc-req-<uuid>`) and appends it to the cleaned upstream URL, stripping any caller-supplied fragment so the DNR `urlFilter` matches exactly one in-flight request. The fragment never reaches the upstream server but DNR `urlFilter` sees it (empirically verified against Chrome for Testing 146).
3. Installs a `chrome.declarativeNetRequest.updateSessionRules` `modifyHeaders` rule keyed to that fragment URL, with one `{ operation: 'set' }` entry per forbidden header.
4. The SW then calls `fetch(fetchUrl, { method, headers, body, signal })`. Chrome strips/rewrites the forbidden headers in the init dict as usual, then the DNR rule rewrites them back on the way out.
5. A `finally` block calls `cleanup()`, which removes the session rule via `removeRuleIds`. Each rule has a unique monotonic id so concurrent in-flight requests don't collide even if cleanup is delayed; any leaked rule expires when the SW unloads.

**Graceful no-op fallback**

When `chrome.declarativeNetRequest` is unavailable (vitest, non-extension runtimes, older Chrome), `installForbiddenHeaderRule` returns the original URL and a no-op `cleanup`. The forbidden headers are still passed to `fetch()` under their real names — useful for unit tests that mock `fetch` and assert on the headers dict — but in a real Chrome SW they would not survive. The synthesized default-`Origin` still lands in `init.headers` and is observable to mocks, but caller-supplied forbidden headers from a real extension SW require DNR to reach the network.

**Overriding the Origin**

To force a specific `Origin` upstream, pass one explicitly — it survives end-to-end because the encode step runs in your runtime before the browser can strip it, and in the extension SW the DNR rule rewrites it on the wire:

```bash
# curl in the agent shell
curl -H "Origin: https://example.com" https://api.example.com/data

# node -e using SecureFetch (wired into the shell `fetch` binding)
node -e 'fetch("https://api.example.com/data", { headers: { Origin: "https://example.com" } })'

# upskill / mcp invoke / any other SecureFetch caller — same shape
upskill some-org/some-skill   # propagates Origin if the skill sets one
```

Leave `Origin` unset to get the default — the proxy will use the target URL's origin (e.g., a request to `https://api.example.com/v1/foo` gets `Origin: https://api.example.com`). This is intentionally permissive: most upstream APIs accept their own origin, and skill authors don't need to think about CORS unless they want a specific value.

**Why decode alone isn't enough in the extension**

The extension SW runs `fetch()` in a Service Worker context, so the same browser-strip behavior applies — extension `host_permissions` bypass CORS at the network layer but do **not** restore stripped request headers, and Chrome rewrites `Origin` to `chrome-extension://<id>` independently of what the init dict contains. An earlier iteration of the extension branch decoded `X-Proxy-*` back into the headers dict and stopped there; that made the headers visible to the SW but they never reached the upstream. The DNR session-rule shim closes that gap. The default-origin fallback in the SW handles the orthogonal case where no caller `Origin` is set at all.

**Related Files**

- `packages/webapp/src/shell/proxy-headers.ts` — `encodeForbiddenRequestHeaders` / `decodeForbiddenRequestHeaders` (shared by both floats)
- `packages/webapp/src/shell/proxied-fetch.ts` — `createProxiedFetch` factory; CLI and extension branches both encode
- `packages/node-server/src/index.ts` — `/api/fetch-proxy` handler; decode + localhost-strip + default-origin synth
- `packages/chrome-extension/src/fetch-proxy-shared.ts` — SW `handleFetchProxyConnectionAsync`; decode + default-origin synth + `installForbiddenHeaderRule` (DNR session-rule shim, fragment-keyed, cleanup in `finally`)

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

## Hosted Leader Tab Cannot Reach `chrome.storage`

**The Problem**

In the thin extension the webapp loads from `https://www.sliccy.ai` (or `http://localhost:8787` in dev) rather than from `chrome-extension://<id>`. `chrome.storage` is only exposed to extension-origin contexts (service worker, popups, sandbox iframes). Page-realm code on the hosted origin has no `chrome.storage` reference and cannot read or write the secrets store directly.

This was hit by the `secret list` shell command and the secrets management UI: the panel-terminal `AlmostBashShellHeadless` runs in the kernel worker spawned by the hosted leader tab, and any `chrome.storage.local.get(...)` from inside a supplemental command callback throws.

**The Solution**

For management operations that must touch `chrome.storage.local`, **route through the SW via `chrome.runtime.sendMessage`** (the `externally_connectable` matches in `packages/chrome-extension/manifest.json` allow the hosted origin to talk to the SW directly). The SW has full storage access. Add a handler in `service-worker.ts:onMessage` that performs the storage call and replies via `sendResponse`. See the `secrets.list` / `secrets.set` / `secrets.delete` handlers there for the canonical pattern. Always `return true` from the listener for async work, and always include `chrome.runtime.lastError` handling on the caller side.

Historical note: prior to the thin-bridge release the same pattern existed because MV3 offscreen documents inherit only a subset of the manifest's `permissions` (notably, `chrome.storage` is not exposed in offscreen documents). The fix shape is identical; only the realm that lacks `chrome.storage` changed (offscreen → hosted leader tab).

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

**The Requirement**

The repo pins `engines.node` to `>=22.13.0` (root `package.json`) and CI pins `node-version: 22` in `.github/workflows/ci.yml`. Use Node 22 (current LTS) or later for both local development and CI.

The historical LightningFS `navigator`-in-`DefaultBackend.init` tripwire that originally motivated this floor is gone — VirtualFS migrated to ZenFS / OPFS and falls back to `InMemory` under Node/Vitest, so it no longer references `navigator` at all. The floor stays because other dependencies and language features assume a modern Node runtime.

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

| Practice                    | Reason                                                                                                                                                             |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Close tabs after use**    | Browser test cleanup; prevents memory leaks                                                                                                                        |
| **Exclude preview URLs**    | Preview tabs (served by the worker on `*.sliccy.now` / `*.sliccy.dev`, or by the local SW at `/preview/*` pre-Phase-3) must not be identified as the SLICC app tab |
| **Auto-resolve active tab** | BrowserAPI auto-selects the user's focused tab when `targetId` is omitted                                                                                          |

**Code**: `isPreviewUrl(url)` in `packages/webapp/src/shell/supplemental-commands/shared.ts` matches both forms (legacy `/preview/` and the unified `<token>.sliccy.now` / `<token>.sliccy.dev` host). The app-tab detector in `playwright-command.ts:resolveAppTabId` excludes URLs that match.

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

The extension service worker (`packages/chrome-extension/src/service-worker.ts`) is built as an entry point. If it imports from modules that are shared with other entry points (content scripts, sandbox pages, the secrets options page), Rollup code-splits them into shared chunks with ES `import` statements. Chrome extension service workers are **not** ES modules — `import` statements cause `Uncaught SyntaxError: Cannot use import statement outside a module` at runtime.

**The Rule**

The service worker must only import **types** (erased at compile time) from other modules. All runtime code must be inlined. If you need to share logic between the service worker and other extension contexts (content script, secrets options page, sandbox iframes), maintain an inline copy in the service worker and the canonical version in a shared module.

| Import type   | Example                                            | Allowed in SW?                    |
| ------------- | -------------------------------------------------- | --------------------------------- |
| Type-only     | `import type { Foo } from './messages.js'`         | Yes (erased)                      |
| Runtime value | `import { bar } from './tab-group.js'`             | **No** (causes code split)        |
| Core modules  | `import { createLogger } from '../core/logger.js'` | **No** (pulls in dependency tree) |

**Current example**: `addToSliccGroup` has an inline copy in `service-worker.ts` and a canonical version in `tab-group.ts` (the canonical module is kept for any ES-module consumer; the SW must never `import` it directly).

## Page / Worker Realm Split

**The Problem**

Every float that hosts the cone runs the agent engine in a `DedicatedWorker` (the "kernel worker") and the UI in the page realm. They share IndexedDB (VFS, sessions) but **NOT** window globals, DOM, or Layout instances. The kernel worker has no `document`, no `window.open`, no DOM APIs.

| Context           | Location                                      | Purpose                                | Window globals                  |
| ----------------- | --------------------------------------------- | -------------------------------------- | ------------------------------- |
| **Page realm**    | `packages/webapp/src/ui/main.ts` (`main()`)   | xterm.js terminal UI, Layout, DOM      | Has Layout + DOM                |
| **Kernel worker** | `packages/webapp/src/kernel/kernel-worker.ts` | Agent loop + `AlmostBashShellHeadless` | Has Orchestrator, no DOM/Layout |

The two communicate via a `KernelTransport` over `MessagePort` — `OffscreenBridge` on the worker side, `OffscreenClient` on the page side.

**The Pattern: UI-Affecting Shell Commands**

When a shell command run by the agent (worker realm) needs to drive the page-realm UI, use the cross-realm dispatch pattern:

1. **Direct hook** (page realm): check `window.__slicc_*` — if present, call directly
2. **Worker → page relay** (worker realm): post a panel-RPC envelope through the `OffscreenBridge` → `OffscreenClient.setupMessageListener()` dispatches to the registered handler.

```typescript
// Pattern: try direct hook, fall back to cross-realm dispatch
const toggle = (globalThis as any).__slicc_someUiOp;
if (toggle) {
  toggle(arg); // Running in page realm
} else {
  // Worker realm: dispatch via the kernel transport
}
```

The sprinkle subsystem is the canonical reference for full bidirectional dispatch: a `globalThis.__slicc_sprinkleManager` proxy is published in both realms and dispatches `sprinkle-op` request/response RPCs over the kernel transport.

**Related Files**

- `packages/chrome-extension/src/sprinkle-proxy.ts` (worker-side proxy that publishes `globalThis.__slicc_sprinkleManager` and relays via `sprinkle-op`)
- `packages/webapp/src/ui/main.ts` (`client.setSprinkleOpHandler(...)` — where the page-side handler is registered)
- `packages/webapp/src/ui/offscreen-client.ts` `setupMessageListener()` (routes `sprinkle-op` payloads to the registered handler)

Historical note: prior to the thin-bridge release the equivalent split was the chrome-extension side panel (page) vs the offscreen document (agent), bridged through `chrome.runtime.sendMessage` routed by the service worker. The realms changed but the page/worker idea is the same.

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

**The Enforcement Points**

| Code path                                     | Wiring                                           | Where                                                               |
| --------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------- |
| Agent loop (cone, scoops, tool turns)         | `streamFn` wrapper passed to `Agent` constructor | `packages/webapp/src/scoops/scoop-context.ts` `streamWithSessionId` |
| Compaction summaries (Pi packed-conversation) | `headers` config on `createCompactContext`       | `packages/webapp/src/scoops/scoop-context.ts` `compactionHeaders`   |
| Ad-hoc UI quick-LLM calls                     | Inline `getQuickLlmAdobeSessionId()` header set  | `packages/webapp/src/providers/quick-llm.ts`                        |
| Session freezer (new-session flow)            | Inline `getDailyAdobeUuid(...)` header set       | `packages/webapp/src/ui/new-session.ts`                             |
| Provider-level fallback (defense-in-depth)    | `ensureSessionIdHeader` in Adobe stream funcs    | `packages/webapp/providers/adobe.ts`                                |

The first four paths attach a meaningful identifier from
`getAdobeSessionId(scoop, coneJid)` in
`packages/webapp/src/scoops/llm-session-id.ts` (a daily-rotating UUID
for the cone, `<uuid>/<hash(folder, uuid)>` for scoops) or a
purpose-anchored variant. Other providers receive no header.

The last row is the defense-in-depth net: `streamAdobe` and
`streamSimpleAdobe` both run `ensureSessionIdHeader` before forwarding
to pi-ai, so any future call site that forgets to attach a header
still gets a daily-rotated fallback UUID anchored on the sentinel
`'adobe-provider-fallback'`. The fallback collides across all unwrapped
paths within a browser-day — that is intentional. It tells the proxy
"the dev forgot the wrapper" rather than legitimizing the call.
`ensureSessionIdHeader` also emits a deduped `console.warn` per call
site identifier so the missing wrapper surfaces in development.

**Adding a New LLM Call Site**

If you add code that calls `pi-ai`'s `streamSimple` / `completeSimple`
directly — or any helper from `@earendil-works/pi-coding-agent` that
routes there (compaction, branch summarization, etc.) — you MUST
attach `X-Session-Id` for the Adobe provider. The cleanest pattern is
to take a `headers: Record<string, string>` parameter and let the
caller inject it the same way `createCompactContext` does. Don't
replicate the Adobe-provider check at every site — push it up to
whoever owns the call. If you skip the wiring, the provider-level
fallback prevents the proxy from falling back to content hashing, but
your call site will land in a generic "unwrapped" bucket rather than
the cone's session.

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
  attached it to the agent loop. Provider-level fallback added after
  the 2026-05-19 cron/standalone-Pi-chat residual report.
- Tripwire: PR #600 added the positional contract.
- Coverage: `tests/scoops/scoop-context.session-id.test.ts` asserts
  both wiring points use the same identifier; gates against future
  reverts. `tests/providers/adobe-provider.test.ts` covers the
  provider-level `ensureSessionIdHeader` fallback behavior.

## Adobe / Bedrock Claude opus-4-8: `temperature` + adaptive-thinking quirks

opus-4-8 is **newer than the pinned pi-ai (0.75.3)**, so pi-ai's
model-capability detection doesn't know it and emits two request shapes
Bedrock rejects. Both surface identically: Bedrock returns a `400`, the
Adobe proxy wraps it as a `502 upstream_error`, and the node-server
fetch-proxy relays the upstream status verbatim (`res.status(upstream.status)`),
so the agent sees a bare **502 on `/api/fetch-proxy`** with no hint of the
cause. **Fix both at the provider layer (a model capability), never at the
call site** — and a pi-ai bump that learns opus-4-8 makes the shims no-ops.

Both shims now share a single version-threshold parser
(`src/providers/claude-model-version.ts`) so future releases (Opus 4.9,
Sonnet 4.7, 5.x) are picked up automatically without per-release edits.

### 1. `temperature` is deprecated (Opus ≥ 4.7)

Bedrock returns `400 "temperature is deprecated for this model."`. This
bites the **thinking-disabled** helper calls: `providers/quick-llm.ts` sends
`temperature: 0.3` for the scope-label and session-title helpers. pi-ai's
`anthropic-messages` builder already drops `temperature` when extended
thinking is enabled, so the **main cone stream is unaffected** — only the
background helpers 502 (commonly a pile of 502s as a long conversation
keeps refreshing its working-scope label). Message count is irrelevant:
even a 24-token request fails.

Fix: `src/providers/temperature-support.ts` exposes
`modelSupportsTemperature` / `withSupportedTemperature`, both delegating to
`claudeRejectsTemperature` (Opus ≥ 4.7) in `claude-model-version.ts`. Both
Bedrock-backed providers consult it — `providers/built-in/bedrock-camp.ts`
omits it in the Converse payload and `providers/adobe.ts` strips it before
`streamAnthropic` / `streamSimpleAnthropic`. Future Opus releases are
covered by the version threshold; no per-release edit is needed.

### 2. Adaptive thinking required (Opus ≥ 4.8 in pi-ai 0.75.3)

With thinking **enabled**, Bedrock returns `400 "thinking.type.enabled is
not supported for this model. Use thinking.type.adaptive and
output_config.effort..."`. pi-ai's `supportsAdaptiveThinking()` recognizes
opus-4-6/4-7 + sonnet-4-6 (emitting `thinking:{type:"adaptive"}` +
`output_config.effort`) but **not opus-4-8** — and would similarly miss
opus-4-9 / sonnet-4-7 — so it falls back to the legacy
`thinking:{type:"enabled",budget_tokens}` shape that Bedrock rejects.
Unlike temperature, this hits the **main cone stream** (thinking on).

Fix: `src/providers/adaptive-thinking.ts` — `providers/adobe.ts` passes an
`onPayload` hook (pi-ai's `streamAnthropic` payload-rewrite seam, the same
one `bedrock-camp` uses) that rewrites the emitted body
`enabled → adaptive` + `output_config.effort` for any Claude Opus/Sonnet
≥ 4.6 (via `claudeSupportsAdaptiveThinking`). The rewrite only fires when
the enabled shape is actually present, so it's a no-op when thinking is
off or for models pi-ai already emits the adaptive shape for. **Immediate
workaround:** set the thinking level to off (the model still reasons
adaptively on its own).

**Related**

- Coverage: `tests/providers/claude-model-version.test.ts`,
  `tests/providers/temperature-support.test.ts`,
  `tests/providers/adaptive-thinking.test.ts`, and the "omits temperature
  for Opus 4.8" + parametrized adaptive cases in
  `tests/providers/built-in/bedrock-camp.test.ts`.
- History: the temperature guard was Opus-4.7-only and inline in
  `bedrock-camp.ts`; it was generalized into the shared helper, extended to
  4.8, and applied to the (previously unguarded) Adobe path. The
  adaptive-thinking shim was added alongside it. Both were then consolidated
  onto a shared version-threshold parser so opus-4-9 / sonnet-4-7 are
  handled automatically.

## Detached popout (historical, removed)

Historical note: the legacy fat-extension shipped a "detached popout"
flow with a `?detached=1` claim envelope emitted by the popped-out tab
to the service worker. The flow accepted three entry paths (side-panel
"Pop out" button, direct URL navigation, Chrome tab restore) and validated
the claim by parsing `sender.url` for origin + pathname + `?detached=1`.
The entire flow is gone in the thin-extension release — the webapp now
always runs in the pinned hosted leader tab at `https://www.sliccy.ai/?slicc=leader`
and `?detached=1` is no longer a recognized boot mode. Future code MUST
NOT reintroduce the detached-claim pattern without redesigning around
the hosted-origin model.

## Stale content-hashed chunks after a deploy (#1330)

A long-lived tab/worker holds an old module graph; after a deploy the old
`/assets/<hash>.js` is gone and the worker's SPA fallback returns `index.html` as
`200 text/html`, so the lazy `import()` rejects with a MIME/module-script error.
The failing import is usually WORKER-owned (providers load in the kernel worker),
and Vite injects `vite:preloadError` only into the PAGE bundle — so a `window`
listener alone can't catch it. Recovery is the four-trigger guarded reload in
`core/stale-asset-channel.ts` + `ui/boot/setup-preload-error-reload.ts`.
