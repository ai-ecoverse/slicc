# Node.js Compatibility Shims — Reference

The SLICC JS realm (DedicatedWorker) provides shims for a subset of Node.js
built-in modules. Scripts using `require('fs')` or `import('path')` resolve
to pure-JS or RPC-backed implementations, not real Node.js.

## Architecture

- **Realm execution**: `packages/webapp/src/kernel/realm/js-realm-shared.ts`
- **Built-in resolution**: `resolveServedBuiltin()` dispatches bare module names
- **Available built-ins registry**: `node-builtins.ts` → `NODE_BUILTIN_AVAILABLE`
- **Helper implementations**: `js-realm-helpers.ts` (pure-JS shims)
- **FS bridge**: `createFsBridge(rpc)` — async VFS operations over RPC
- **Sync FS cache**: `sync-fs-cache.ts` — in-memory snapshot for sync APIs
- **Every float**: the worker realm (`js-realm-shared.ts`) is the single shim
  host — `node -e`, `.jsh`, and `workflow` all run there, including in the thin
  extension (its kernel worker lives in the hosted leader tab). There is no
  separate extension sandbox mirror (see Extension Parity below)

---

## Available Built-in Modules

### `fs` / `fs/promises`

Async methods (RPC-backed, available everywhere):

| Method                           | Notes                                           |
| -------------------------------- | ----------------------------------------------- |
| `readFile(path, opts?)`          | Supports encoding option; `null` returns Buffer |
| `writeFile(path, data)`          | String or Uint8Array                            |
| `appendFile(path, data)`         |                                                 |
| `cp(src, dest, {recursive?})`    | Recursive copy                                  |
| `rm(path, {recursive?, force?})` |                                                 |
| `mkdir(path, {recursive?})`      |                                                 |
| `mkdtemp(prefix)`                | Random suffix via crypto                        |
| `rename(oldPath, newPath)`       |                                                 |
| `access(path)`                   | Throws ENOENT if missing                        |
| `stat(path)`                     | Returns `{isDirectory, isFile, size}`           |
| `readdir(path)`                  |                                                 |
| `unlink(path)`                   | Alias to rm                                     |
| `copyFile(src, dest)`            |                                                 |
| `exists(path)`                   |                                                 |
| `fetchToFile(url, path)`         | SLICC-specific: fetch URL → VFS                 |

`require('fs/promises')` returns the same object. `require('fs').promises`
also resolves to it.

Sync methods (backed by `SyncFsCache` — in-memory snapshot, standalone only):

| Method                               | Notes                                     |
| ------------------------------------ | ----------------------------------------- |
| `readFileSync(path, opts?)`          |                                           |
| `writeFileSync(path, data)`          |                                           |
| `existsSync(path)`                   |                                           |
| `mkdirSync(path, {recursive?})`      |                                           |
| `statSync(path)`                     | Returns `{isFile(), isDirectory(), size}` |
| `readdirSync(path)`                  |                                           |
| `rmSync(path, {recursive?, force?})` |                                           |
| `copyFileSync(src, dest)`            |                                           |
| `mkdtempSync(prefix)`                |                                           |
| `unlinkSync(path)`                   |                                           |
| `renameSync(oldPath, newPath)`       |                                           |

The sync cache is populated from a VFS snapshot before user code runs and
flushed back on completion. Files exceeding 1 MB are marked `truncated` and
throw `ENOSYNC` on sync read (use the async API for large files).

**Not available:** `watch`, `watchFile`, `createReadStream`, `createWriteStream`,
`chmod`, `chown`, `lstat`, `symlink`, `readlink`, `realpath`, `Dirent`-returning
readdir.

### `path`

Full POSIX path module: `join`, `resolve`, `dirname`, `basename`, `extname`,
`relative`, `isAbsolute`, `normalize`, `parse`, `format`, `sep`, `delimiter`,
`posix`.

### `crypto`

| API                      | Notes                                 |
| ------------------------ | ------------------------------------- |
| `randomBytes(size)`      | Returns Uint8Array                    |
| `randomFillSync(buffer)` |                                       |
| `randomUUID()`           |                                       |
| `getRandomValues(array)` |                                       |
| `createHash(alg)`        | md5, sha1, sha256, sha512 (pure JS)   |
| `webcrypto`              | Re-exports `globalThis.crypto`        |
| `subtle`                 | Re-exports `globalThis.crypto.subtle` |

**Not available:** `createCipheriv`, `createDecipheriv`, `createSign`,
`createVerify`, `createHmac`, `createDiffieHellman`, `pbkdf2`, `scrypt`,
`generateKeyPair`.

### `child_process`

Async forms (backed by shell exec RPC):

| Method                              | Notes                                           |
| ----------------------------------- | ----------------------------------------------- |
| `exec(cmd, opts?, cb?)`             | Returns ChildProcess; supports `util.promisify` |
| `execFile(file, args?, opts?, cb?)` | Returns ChildProcess                            |
| `spawn(cmd, args?, opts?)`          | Returns ChildProcess with stdout/stderr/stdin   |

`ChildProcess` extends EventEmitter with `.stdout` (Readable), `.stderr`
(Readable), `.stdin` (writable), `.pid`, `.exitCode`, `.kill(signal?)`,
and `exit`/`close`/`error` events.

**Not available (throws):** `execSync`, `spawnSync`, `execFileSync`, `fork`.

### `process`

`env`, `cwd()`, `exit(code?)`, `stdout`, `stderr`, `stdin`, `argv`,
`platform` (`'browser'`), `arch` (`'wasm'`), `version`, `pid`.

### `buffer`

Re-exports the global `Buffer` polyfill. Available as both
`require('buffer').Buffer` and the global `Buffer`.

### `assert` / `assert/strict`

Full assertion module: `ok`, `fail`, `equal`, `notEqual`, `strictEqual`,
`notStrictEqual`, `deepEqual`, `deepStrictEqual`, `throws`, `doesNotThrow`,
`rejects`, `doesNotReject`, `match`, `doesNotMatch`, `ifError`.

### `util`

`promisify`, `inspect`, `inherits`, `types` (isDate, isRegExp, isPromise,
etc.), `format`, `deprecate`, `TextEncoder`, `TextDecoder`.

### `events`

`EventEmitter` class: `on`, `off`, `once`, `emit`, `removeAllListeners`,
`listenerCount`, `listeners`. Available as both the default export and
`require('events').EventEmitter`.

### `os`

Static/hardcoded values: `tmpdir()` → `/tmp`, `homedir()` → `/home/user`,
`platform` → `linux`, `arch` → `x64`, `cpus()`, `hostname()`, `type()`,
`release()`, `EOL` → `\n`.

### `stream`

Minimal stubs: `Readable`, `Writable`, `Transform`, `PassThrough`, `Stream`.
Basic event emission and `pipe()` work. These are NOT full Node streams —
no backpressure, no flowing/paused modes, no proper pipe chaining.

### `url`

`URL`, `URLSearchParams` (re-exported globals), `fileURLToPath(url)`,
`pathToFileURL(path)`.

### `zlib`

Backed by `pako` (pure JS):

- Sync: `gzipSync`, `gunzipSync`, `deflateSync`, `inflateSync`,
  `deflateRawSync`, `inflateRawSync`
- Async (callback): `gzip`, `gunzip`, `deflate`, `inflate`, `deflateRaw`,
  `inflateRaw`
- Constants: `Z_NO_FLUSH`, `Z_BEST_SPEED`, `Z_BEST_COMPRESSION`,
  `Z_DEFAULT_COMPRESSION`

**Not available:** Streaming classes (`createGzip`, `createGunzip`, etc.).

---

## Shimmed Third-Party Packages

These npm packages cannot run natively (they require C++ bindings or a real
Node.js process) but are intercepted by the realm resolver and replaced with
a compatibility shim backed by SLICC's existing infrastructure.

Resolution order: `sliccy:` → served builtins → native-package rejection →
unavailable-builtin rejection → **shimmed packages** → CJS module graph.

### `playwright`

`require('playwright')` / `import('playwright')` returns a Playwright-shaped
API backed by SLICC's CDP connection to the running Chrome instance.

**Supported surface:**

- `chromium.launch()` — returns a Browser (no-op; Chrome is already running)
- `chromium.connectOverCDP(endpoint)`, `<launcher>.connect(wsEndpoint)` — also
  no-ops that return a Browser; the endpoint argument is accepted but ignored
  (the realm is always already attached to SLICC's one real Chrome)
- `browser.newPage({ viewport? })` — opens a real new tab, sets viewport
- `browser.newContext(options?)` — returns a `BrowserContext` that groups its
  own pages for `close()`/`pages()` bookkeeping. **No cookie/storage isolation**
  — every context and the top-level browser share the one real Chrome profile.
- `browser.contexts()`, `context.newPage()`, `context.pages()`, `context.close()`
- `browser.close()` — closes all tabs opened by the instance, including every
  context's tabs
- `page.goto(url)`, `page.waitForLoadState(state?)`, `page.waitForTimeout(ms)`
- `page.evaluate(fn, ...args)` — runs JS in page context
- `page.screenshot({ path?, fullPage? })` — returns Uint8Array (PNG)
- `page.$(selector)`, `page.$$(selector)` — query selectors → ElementHandle
- `page.$$eval(selector, fn, ...args)` — runs `fn` over every matched element
- `page.content()` — returns page HTML
- `page.setViewportSize({ width, height })`
- `page.close()`
- `elementHandle.textContent()`, `.getAttribute(name)`, `.isVisible()`, `.boundingBox()`

**Not supported:** request interception, locators, tracing, video, distinct
firefox/webkit engines (all three launchers use the same Chrome), real
per-context cookie/storage isolation for `BrowserContext`.

Scripts should use this shim (via normal `import('playwright')`) rather than
`npx playwright` or the Playwright MCP server when running inside the realm.

---

## Blocked Packages (Hard Fail)

These npm packages ship C++ native bindings and throw immediately on
`require()` with an actionable hint:

`bcrypt`, `better-sqlite3`, `canvas`, `cpu-features`, `fsevents`,
`leveldown`, `libxmljs`, `libxmljs2`, `node-gyp-build`, `node-sass`,
`puppeteer`, `robotjs`, `sass-embedded`, `sharp`, `snappy`, `sqlite3`,
`tree-sitter`, `usb`.

Source: `require-guards.ts` → `NODE_NATIVE_PACKAGES`.

---

## Out of Scope

These Node built-ins are not shimmed and throw "not available in the browser
environment" on `require()`:

- `http` / `https` — use `fetch()` instead
- `net` / `tls` / `dgram` — OS-only socket APIs
- `worker_threads` — incompatible with realm model
- `cluster` — OS-only
- `dns` — OS-only
- `v8` / `vm` / `inspector` — engine internals

---

## Extension Parity (No Gaps)

Historically the Chrome extension sandbox (`sandbox.html`) mirrored only a
smaller subset of these shims inline, so `child_process`, `events`, `os`,
`stream`, `url`, and the `fs/promises` alias worked in standalone but **not**
in extension mode. That mirror was removed with the thin-bridge strip: the
extension now runs JS realms in the same worker realm (`js-realm-shared.ts`)
as every other float — its kernel worker lives in the hosted leader tab — so
the full shim set above is available in extension mode too. There are no
float-specific gaps.
