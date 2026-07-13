# Node.js Compatibility Shims — Implementation Plan

Expands the JS realm's Node.js built-in surface to support `.mjs` skill scripts
from the `adobe/skills` repository (37 files audited). Organized in 4 batches,
each on its own branch, one function per commit.

## Architecture Context

- **Realm execution**: `packages/webapp/src/kernel/realm/js-realm-shared.ts`
- **Built-in resolution**: `resolveServedBuiltin()` in `js-realm-shared.ts`
  dispatches `require('fs')` / `require('node:fs')` etc.
- **Available built-ins registry**: `packages/webapp/src/kernel/realm/node-builtins.ts`
  (`NODE_BUILTIN_AVAILABLE` set)
- **Helper implementations**: `packages/webapp/src/kernel/realm/js-realm-helpers.ts`
  (exports `nodePath`, `nodeCrypto`, `nodeUtil`, `nodeAssert`, `nodeZlib`)
- **FS bridge**: `createFsBridge(rpc)` in `js-realm-shared.ts` — async VFS
  operations over RPC (`readFile`, `writeFile`, `readDir`, `exists`, `stat`,
  `mkdir`, `rm`, `readFileBinary`, `writeFileBinary`, `fetchToFile`)
- **Exec bridge**: `createExecBridge(rpc)` in `js-realm-shared.ts` — exposes
  `exec(cmd)` and `spawn(argv)`, both returning `{stdout, stderr, exitCode}`
- **Extension parity**: `packages/chrome-extension/sandbox.html` mirrors all
  realm helpers inline; must be kept in sync.
- **Parity tests**: `tests/kernel/realm/js-realm-helpers.test.ts` pins both
  worker and iframe floats.

## Batch 1: Already-have-it + Trivial additions

**Branch**: `feat/node-compat-batch-1`

These are either already implemented (just need subpath/alias wiring) or are
one-liners.

### Commits (one per function/feature):

1. **`require('fs/promises')` alias** — resolve `fs/promises` and
   `node:fs/promises` to the existing `fsBridge` object in
   `resolveServedBuiltin()`. Add `'fs/promises'` to `NODE_BUILTIN_AVAILABLE`.

2. **`require('os')` shim** — create `nodeOs` in `js-realm-helpers.ts`:
   - `tmpdir()` → `'/tmp'`
   - `platform` → `'browser'` (or `'linux'`)
   - `arch` → `'wasm'` (or `'x64'`)
   - `homedir()` → `'/home/user'`
   - `EOL` → `'\n'`

   Wire in `resolveServedBuiltin`. Add `'os'` to `NODE_BUILTIN_AVAILABLE`.

3. **`require('url')` shim** — create `nodeUrl` in `js-realm-helpers.ts`:
   - `fileURLToPath(url)` — strip `file://` prefix, decode `%xx`
   - `pathToFileURL(path)` — prepend `file://`, encode special chars
   - `URL` — re-export `globalThis.URL`
   - `URLSearchParams` — re-export `globalThis.URLSearchParams`

   Wire in `resolveServedBuiltin`. Add `'url'` to `NODE_BUILTIN_AVAILABLE`.

4. **`require('events')` shim** — minimal `EventEmitter` class:
   - `on(event, fn)`, `off(event, fn)`, `once(event, fn)`,
     `emit(event, ...args)`, `removeAllListeners(event?)`
   - `static EventEmitter` (self-reference for `const {EventEmitter} = require('events')`)

   Wire in `resolveServedBuiltin`. Add `'events'` to `NODE_BUILTIN_AVAILABLE`.
   (Not directly used by the audited scripts, but commonly pulled transitively
   by npm packages like `playwright` internals.)

5. **`require('stream')` minimal shim** — export `{ Readable, Writable, Transform, PassThrough }`
   as no-op classes with `pipe()`, `on()`, `write()`, `end()`. Many npm deps
   transitively require it.

   Wire in `resolveServedBuiltin`. Add `'stream'` to `NODE_BUILTIN_AVAILABLE`.

## Batch 2: Async FS operations (`node:fs/promises` full surface)

**Branch**: `feat/node-compat-batch-2`

Extends the `fsBridge` to cover all async operations the audited scripts use.
The fsBridge already has the RPC verbs for most of these — this batch adds the
missing ones and reshapes the module export to match Node's `fs/promises` API.

### Commits:

1. **`fs.readFile(path, encoding?)` with encoding support** — already exists but
   currently returns `string` only. Add binary support: when encoding is omitted
   or `null`, return a `Buffer`. When `'utf8'`/`'utf-8'`, return string.

2. **`fs.writeFile(path, data, encoding?)` with Buffer support** — already
   exists for strings. Handle `Uint8Array`/`Buffer` input by routing to
   `writeFileBinary`.

3. **`fs.appendFile(path, data)`** — read existing content, concat, write back.
   New RPC verb `appendFile` on the host side (or implement client-side as
   read+write).

4. **`fs.cp(src, dest, {recursive?})`** — recursive copy. Walk source tree with
   `readDir` + `stat`, recreate directories, copy files. Implement in the realm
   as a helper using existing `readDir`/`stat`/`readFileBinary`/`writeFileBinary`/`mkdir`.

5. **`fs.rm(path, {recursive?, force?})`** — already have `rm(path)`. Add
   recursive directory removal (walk + delete children first). Add `force` flag
   (ignore ENOENT).

6. **`fs.mkdtemp(prefix)`** — generate a random suffix, `mkdir(prefix + suffix)`,
   return the path. Use `crypto.randomUUID().slice(0,6)` for the suffix.

7. **`fs.rename(oldPath, newPath)`** — new RPC verb needed on the host
   (`realm-host.ts` dispatches to `ctx.fs.rename` or read+write+delete).

8. **`fs.access(path)`** — check existence, resolve or throw `ENOENT`. Maps to
   existing `exists` RPC.

## Batch 3: Synchronous FS (`node:fs` sync surface)

**Branch**: `feat/node-compat-batch-3`

The hardest batch. The realm runs in a DedicatedWorker, so
`FileSystemSyncAccessHandle` is available — but the VFS is on the kernel-host
side behind async RPC. Two approaches:

**Approach A (recommended)**: Use synchronous `XMLHttpRequest` to the RPC port
(not available in workers). **REJECTED** — no XHR in workers.

**Approach B (recommended)**: Use `Atomics.wait` + `SharedArrayBuffer` for
synchronous RPC. The realm worker posts a request, writes to a SAB, and blocks
on `Atomics.wait` until the host responds. The host signals via
`Atomics.notify`. This gives true synchronous semantics.

**Approach C (simpler, less correct)**: Pre-load the entire VFS subtree into
memory before execution, serve sync reads from that cache, buffer sync writes,
flush on exit. Limitations: writes from one `writeFileSync` aren't visible to a
subsequent `readFileSync` unless the cache is wired properly. Actually this
works fine if the in-memory cache IS the source of truth during execution.

**Recommended**: Approach C (in-memory FS snapshot) for the initial
implementation. Scripts operate on a consistent in-memory tree; changes flush
back to VFS on completion. Approach B is the future upgrade path for full
correctness with concurrent access.

### Implementation: In-memory sync FS cache

- Before `runJsRealm`, the host walks the relevant VFS subtree and serializes it
  into the `RealmInitMsg` (or a follow-up pre-exec RPC).
- The realm builds an in-memory tree (`Map<path, {content, stat}>`) from the
  snapshot.
- Sync FS operations read/write this map directly (zero async, zero RPC).
- On successful exit, the realm posts back a diff (created/modified/deleted
  files) that the host applies to the real VFS.

### Commits:

1. **Sync FS cache infrastructure** — `SyncFsCache` class: in-memory tree with
   `get(path)`, `set(path, content)`, `delete(path)`, `list(dir)`, `stat(path)`.
   Serializable init from a flat `{path, content, isDir}[]` snapshot.

2. **Host-side VFS snapshot builder** — in `realm-host.ts`, add a `snapshotDir`
   RPC verb that walks a directory and returns the flat file list. Configurable
   depth/size limits.

3. **`readFileSync(path, encoding?)`** — read from `SyncFsCache`. Return
   `Buffer` or `string` per encoding.

4. **`writeFileSync(path, data, encoding?)`** — write to `SyncFsCache`.

5. **`existsSync(path)`** — check `SyncFsCache`.

6. **`mkdirSync(path, {recursive?})`** — create directory entries in cache.

7. **`statSync(path)`** — return `{isFile(), isDirectory(), size}` from cache.

8. **`readdirSync(path)`** — list from cache.

9. **`rmSync(path, {recursive?, force?})`** — remove from cache.

10. **`copyFileSync(src, dest)`** — read + write in cache.

11. **`mkdtempSync(prefix)`** — random suffix, mkdir in cache, return path.

12. **`unlinkSync(path)`** — remove file from cache.

13. **Flush-back on exit** — after `runUserCode` completes, diff the cache
    against the initial snapshot and apply mutations to VFS via existing async
    RPC.

14. **Wire `require('fs')` to unified module** — the `fs` module export should
    expose BOTH sync and async APIs (like real Node.js). Restructure so
    `require('fs')` returns `{readFileSync, writeFileSync, ..., promises: {...}}`.

## Batch 4: `child_process` shim

**Branch**: `feat/node-compat-batch-4`

Wire the existing `createExecBridge(rpc)` (which already exposes
`exec(cmd) → {stdout, stderr, exitCode}` and `spawn(argv) → {stdout, stderr, exitCode}`)
into a Node-shaped `child_process` API.

The exec bridge routes commands to the shell (`AlmostBashShell`) on the host.
This means `execSync('git status')` will run the shell command and return
stdout — which is exactly what the audited scripts do.

### Commits:

1. **`execSync(cmd, opts?)`** — synchronous execution. **Problem**: same sync
   constraint as Batch 3. Two options:
   - (A) Use `Atomics.wait` + SAB for truly synchronous exec (complex).
   - (B) Mark `child_process` sync APIs as **not supported** and provide only
     async versions, requiring script adaptation.
   - (C) If Batch 3 uses the in-memory FS approach, we can pre-execute
     `execSync` commands via a similar buffered approach — but exec has
     side-effects, so this doesn't generalize.

   **Recommended for now**: Provide `execSync` as an async-under-the-hood
   implementation using `Atomics.wait` on a SAB. The realm worker blocks until
   the host finishes execution. This is the only approach that gives true sync
   semantics for process spawning.

   **Alternative**: If SAB is not viable, document that `execSync`/`spawnSync`
   require rewriting to async. Provide `execFile` (async callback) and
   `spawn` (async) only.

2. **`execFileSync(file, args, opts?)`** — same sync mechanism as `execSync`,
   but constructs the command from `file` + `args` array (shell-escape args).

3. **`spawnSync(cmd, args, opts?)`** — same sync mechanism. Returns
   `{stdout, stderr, status, signal}`.

4. **`execFile(file, args, opts?, cb)`** — async (callback-style). Route to
   `exec.spawn([file, ...args])`, call `cb(err, stdout, stderr)` on completion.

5. **`spawn(cmd, args, opts?)`** — returns a `ChildProcess`-like object with
   `stdout`/`stderr` streams and an `on('close', cb)` event. Internally
   runs `exec.spawn([cmd, ...args])` and feeds chunks to the streams.

6. **`exec(cmd, opts?, cb)`** — async callback-style. Route to
   `exec.exec(cmd)`, call `cb(err, stdout, stderr)`.

7. **Wire `require('child_process')` / `require('node:child_process')`** — add
   to `resolveServedBuiltin` and `NODE_BUILTIN_AVAILABLE`.

---

## Sync RPC Mechanism (shared by Batch 3 & 4)

If we go with `Atomics.wait` for true sync semantics (needed for `execSync`,
and optionally for sync FS if we don't want the snapshot approach):

1. Host creates a `SharedArrayBuffer` and passes it to the realm in `RealmInitMsg`.
2. Realm writes a request into the SAB (op + args serialized).
3. Realm calls `Atomics.wait(sab, 0, 0)` — blocks the worker thread.
4. Host reads the request, performs the operation, writes the result into SAB.
5. Host calls `Atomics.notify(sab, 0)` — wakes the realm.
6. Realm reads the result from the SAB.

Requirements:

- `SharedArrayBuffer` requires `Cross-Origin-Embedder-Policy: require-corp` on
  the page, OR the worker must be created with `{type: 'module'}` in certain
  contexts. **Check**: does the current realm worker have access to SAB?
- If SAB is not available, fall back to the snapshot approach (Batch 3) and
  async-only for Batch 4.

---

## Extension Parity Checklist

Every new built-in added to `resolveServedBuiltin` must also be mirrored in:

- [ ] `packages/chrome-extension/sandbox.html` (inline JS)
- [ ] `tests/kernel/realm/js-realm-helpers.test.ts` (parity assertion)
- [ ] `node-builtins.ts` → `NODE_BUILTIN_AVAILABLE` set

---

## Test Strategy

Each commit should include a test in `packages/webapp/tests/kernel/realm/` that:

1. Exercises the new API through `executeJsCode` (in-process realm factory).
2. Verifies Node-compatible behavior (encoding handling, error codes, etc.).
3. For sync APIs (Batch 3): verifies that sync reads see prior sync writes
   within the same execution.

---

## Shimmed Third-Party Packages

These npm packages cannot run natively (they require C++ bindings or a real
Node.js process) but are intercepted by the realm resolver and replaced with
a compatibility shim backed by SLICC's existing infrastructure.

### `playwright`

`require('playwright')` / `import('playwright')` returns a Playwright-shaped
API backed by SLICC's CDP connection to the running Chrome instance.

**Supported surface:**

- `chromium.launch()` — returns a Browser (no-op; Chrome is already running)
- `browser.newPage({ viewport? })` — opens a real new tab, sets viewport
- `browser.close()` — closes all tabs opened by the instance
- `page.goto(url)`, `page.waitForLoadState(state?)`
- `page.evaluate(fn, ...args)` — runs JS in page context
- `page.screenshot({ path?, fullPage? })` — returns Uint8Array (PNG)
- `page.$(selector)`, `page.$$(selector)` — query selectors → ElementHandle
- `page.content()` — returns page HTML
- `page.setViewportSize({ width, height })`
- `page.close()`
- `elementHandle.textContent()`, `.getAttribute(name)`, `.isVisible()`, `.boundingBox()`

**Not supported:** BrowserContext, request interception, locators, tracing,
video, firefox/webkit engines (all three launchers use the same Chrome).

Scripts should use this shim (via normal `import('playwright')`) rather than
`npx playwright` or the Playwright MCP server when running inside the realm.

## Out of Scope

- `node:http` / `node:https` (server creation, raw TCP) — OS-only
- `node:net` / `node:tls` / `node:dgram` — OS-only
- `node:worker_threads` — incompatible with realm model
- Streaming classes (`fs.createReadStream`, `stream.Duplex`) — no Node stream
  layer in the realm
