# Wave 13c · R5 — Pyodide native VFS load (read-only research)

## TL;DR

- **Root cause is BOTH a path/install mismatch AND an architectural HTTP-origin requirement.** In Env1 (wrangler-served webapp on `:8787`) the preview SW _is_ registered and responding (you can see its "Not found" payload bleeding into the JSON parser at `wave-13-standalone-errors-2.md:495-502`); the responder simply returns 404 `Not found` because **pyodide assets are not at `/workspace/node_modules/pyodide/` in the cone's VFS for this QA session** — same shape as the whisper-weights misses on lines 474-494. But even after a clean install, the loader's `indexURL` HTTP-origin model means every Python startup is a hard dependency on (a) the preview SW being registered + activated, (b) the page-side `installPreviewVfsResponder` BroadcastChannel responder being up before the worker fetches, (c) the responder's 30 s RPC window completing a ~14 MB three-file round-trip (`pyodide.asm.{js,wasm}` + `python_stdlib.zip` + `pyodide-lock.json`). That contract is unique to pyodide today — `ffmpeg-wasm.ts` / `magick-wasm.ts` / `getTypeScript()` / `esbuild-wasm.ts` / whisper's transformers loader all bypass the SW entirely by reading bytes via the shared `IpkResolutionContext` and handing pyodide blob URLs.
- **Preferred fix: convert `runPyRealm` to the same VFS-bytes + blob-URL pattern ffmpeg uses.** Pyodide 0.29.4's `loadPyodide` supports enough escape hatches (`lockFileContents`, `stdLibURL`, the `_createPyodideModule != "function"` skip on pre-loaded asm.js, and the `WebAssembly.instantiateStreaming(response, ...)` path that works against any fetchable URL including `blob:`) that we can eliminate the indexURL HTTP dependency in standalone _without_ touching the preview SW. A one-call `globalThis.fetch` shim covers the only remaining indexURL-relative reference (`pyodide.asm.wasm`).
- **Fallback if shim path is rejected**: keep `toPreviewUrl(...)` but harden the boot order (responder-ready barrier in `wc-live.ts`) and ship a non-confusing 404 → JSON error story. This still leaves the HTTP-origin coupling and is recommended only as a tier-2 patch.
- Extension and cloud/hosted-leader floats are **not affected** — extension resolves via `chrome.runtime.getURL('pyodide/')` (bundled, web-accessible), and the hosted-leader cloud sandbox runs the same standalone code path (so the same fix lands once).

## A. Precise root cause

### A.1 Observed failure in Env1 (`wave-13-standalone-errors-2.md`)

```
:8787/assets/pyodide-M7UA50Oh.js:3
  Error: Failed to load 'http://localhost:8787/preview/workspace/node_modules/pyodide/python_stdlib.zip':
  request failed.
:8787/assets/py-realm-worker-BzumK3bD.js:1
  SyntaxError: Unexpected token 'N', "Not found" is not valid JSON
```

The `"Not found"` string is verbatim `preview-sw-handler.ts:170`:

```
return new Response(`Not found (${reason}): ${vfsPath}`, { status: 404, … });
```

So the preview SW _is_ alive and serving — it's responding with HTTP 404 + the literal text `Not found (ENOENT): /workspace/node_modules/pyodide/...`, and pyodide's `loadLockFile` (`packages/webapp/node_modules/pyodide/pyodide.mjs:3 → V`) shoves that body straight into `JSON.parse`, producing the misleading "Unexpected token 'N'" SyntaxError ahead of the actual 404 fetch error for `python_stdlib.zip`. Whisper's identical 404 shape on lines 474-494 (config.json from `/workspace/models/onnx-community/whisper-tiny/`) confirms that this QA session simply has the install missing in OPFS — pyodide isn't there yet on the cone's VFS.

### A.2 Why the dependency on the preview SW is the architectural problem

`packages/webapp/src/kernel/realm/realm-factory.ts:136-152` (`resolvePyodideIndexURL`):

```ts
// browser/standalone branch (NOT extension, NOT node):
return toPreviewUrl('/workspace/node_modules/pyodide/');
```

`toPreviewUrl` (`shared.ts:86-102`) builds `${self.location.origin}/preview${vfsPath}`. Inside the kernel DedicatedWorker on Env1 that's `http://localhost:8787/preview/workspace/node_modules/pyodide/`. Pyodide then concatenates four file names onto that and fires four HTTP requests, all of which:

1. Are intercepted by `/preview-sw.js` (scope `/preview/`), which
2. BroadcastChannel-asks the page-side `installPreviewVfsResponder` to read OPFS, which
3. Has to complete within `DEFAULT_TIMEOUT_MS = 30000` (`preview-sw-handler.ts:77`), and
4. Returns 404 with the body `Not found (ENOENT|responder timeout): <vfsPath>` if anything along the chain misses.

Compare `ffmpeg-wasm.ts:118-189`:

```ts
const resolved = await ipkResolve('@ffmpeg/core/package.json', ipk.fromDir, ipk.reader);
const corePath = `${pkgDir}/dist/esm/ffmpeg-core.js`;
const wasmPath = `${pkgDir}/dist/esm/ffmpeg-core.wasm`;
const coreSource = await ipk.reader.readFile(corePath);
const wasmBytes = await ipk.readBytes(wasmPath);
// → both materialized as blob: URLs → handed to ffmpeg.load({coreURL, wasmURL})
```

Same package-discovery primitives (`ipkResolve` from `shell/ipk/resolver.ts` + the `IpkResolutionContext.reader.readFile` / `readBytes`) — but **zero preview-SW dependency**, **zero HTTP origin requirement**, **zero JSON-parse-of-404-body footgun**, and a single OPFS-direct read per asset.

`getTypeScript()` (`shared.ts:203-225`), `esbuild-wasm.ts`, `biome-command.ts`, and whisper-engine's `@huggingface/transformers` path (which sets `transformers-env.localModelPath = toPreviewUrl('/workspace/models/')` and so _does_ rely on the SW today — separate issue, same pattern) all live on the same `IpkResolutionContext` substrate. Pyodide is the lone holdout.

### A.3 Loader-internal escape hatches in pyodide 0.29.4

Reading `packages/webapp/node_modules/pyodide/pyodide.mjs:3` (the minified ESM bundle), the relevant choke points are:

| Asset               | Loader code                                                              | Bypass mechanism                                                            |
| ------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| `pyodide-lock.json` | `Se()` calls `V(s)` = `await fetch(s).json()` unless `lockFileContents`  | **Pass `lockFileContents` (object or string)** — fetch is fully skipped     |
| `pyodide.asm.js`    | `we()` does `if (typeof _createPyodideModule != "function") import(idx)` | **Pre-define `globalThis._createPyodideModule`** by `import(blobUrl)` first |
| `python_stdlib.zip` | `Pe()` reads `e.stdLibURL ?? e.indexURL + "python_stdlib.zip"`           | **Pass `stdLibURL: <blob URL>`** — indexURL concat is skipped               |
| `pyodide.asm.wasm`  | `Ne(indexURL)` always builds `R(indexURL + "pyodide.asm.wasm")`          | **No direct override** — see A.4                                            |

### A.4 The one indexURL+wasm holdout

`createSettings` in the loader unconditionally sets `instantiateWasm: Ne(e.indexURL)`, and there's no first-class hook to replace it. But `Ne` calls `R(e + "pyodide.asm.wasm")` where `R = browser_getBinaryResponse` ≈ `fetch(new URL(e, location))` (web-worker variant). The wasm URL is therefore fetched via the worker's `globalThis.fetch`, which is **shimmable** — exactly the seam `kernel-worker-fetch-bypass.ts:65-79` already uses for a different purpose.

Two acceptable executions of A.4:

- **(A4-shim)** Install a one-shot worker `fetch` wrapper for the duration of `loadPyodide` that recognizes the `indexURL` prefix and answers with `new Response(wasmBytes, {headers:{'Content-Type':'application/wasm'}})`. Use a synthetic sentinel `indexURL` so prefix matching is robust (e.g. `slicc-pyodide://local/<runId>/`). Restore the original `fetch` once `loadPyodide` resolves (success or fail) so other worker fetches stay unaffected.
- **(A4-blob-base)** Encode the wasm bytes inline so `indexURL + "pyodide.asm.wasm"` is itself a self-contained URL with the bytes — not actually possible with `blob:` URLs (opaque, no path semantics), so **A4-shim is the only practical option**.

## B. Ranked fix plan

### B.1 (Preferred) — VFS-bytes + blob-URL load, with a scoped fetch shim

Trace-out by file:

1. `packages/webapp/src/kernel/realm/py-realm-shared.ts:101-130` (`runPyRealm`)

   - Add an `IpkResolutionContext` parameter (mirroring `ffmpeg-wasm.ts:53-57`'s shape — already shipped) and consume it before `loadPyodide`. Plumb it from `python-command.ts` via `RealmInitMsg`. (See B.3 for the transport choice.)
   - Resolve `pyodide/package.json` through `ipkResolve` to find `pkgDir`.
   - Read four files (parallel `Promise.all`):
     - `await ipk.reader.readFile(`${pkgDir}/pyodide.asm.js`)` → string
     - `await ipk.readBytes(`${pkgDir}/pyodide.asm.wasm`)` → Uint8Array
     - `await ipk.readBytes(`${pkgDir}/python_stdlib.zip`)` → Uint8Array
     - `await ipk.reader.readFile(`${pkgDir}/pyodide-lock.json`)` → string
   - Build:
     - `coreJsBlobUrl = URL.createObjectURL(new Blob([asmJsSource], {type:'text/javascript'}))`
     - `stdlibBlobUrl = URL.createObjectURL(new Blob([stdlibBytes], {type:'application/zip'}))`
     - Optionally `wasmBlobUrl` (only if A4-shim returns 302-style redirect; the direct Response-from-bytes path doesn't need it)
   - Pre-populate `_createPyodideModule`: `await import(coreJsBlobUrl)` (DedicatedWorker; modern Chromium supports dynamic-import of blob URLs with `type:'text/javascript'`). Confirm pyodide.asm.js is structured to write `globalThis._createPyodideModule` at top level (it is — `pyodide.mjs:3` exports rely on that contract via the `typeof _createPyodideModule != "function"` check).
   - Install A4-shim:
     ```ts
     const INDEX = `slicc-pyodide://local/${crypto.randomUUID()}/`;
     const origFetch = globalThis.fetch;
     globalThis.fetch = (input, init) => {
       const url =
         typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
       if (url === INDEX + 'pyodide.asm.wasm') {
         return Promise.resolve(
           new Response(wasmBytes, { headers: { 'Content-Type': 'application/wasm' } })
         );
       }
       return origFetch(input, init);
     };
     try {
       pyodide = await mod.loadPyodide({
         indexURL: INDEX,
         lockFileContents: lockJsonString, // skips lock fetch
         stdLibURL: stdlibBlobUrl, // skips stdlib indexURL fetch
         fullStdLib: false,
       });
     } finally {
       globalThis.fetch = origFetch;
       URL.revokeObjectURL(coreJsBlobUrl);
       URL.revokeObjectURL(stdlibBlobUrl);
     }
     ```
   - Pyodide passes `new URL(e, location)` over `e` first: a `slicc-pyodide://…` URL is a valid absolute URL, so `new URL(e+suffix, location)` returns it unchanged and the shim sees the full string. No `location` patching needed.

2. `packages/webapp/src/kernel/realm/realm-factory.ts:115-152` (`resolvePyodideIndexURL`)

   - Drop the browser-standalone branch entirely once the shim is in place — the synthetic indexURL is now generated inside `runPyRealm`. Keep extension (`chrome.runtime.getURL('pyodide/')`) and node (`resolveNodePackageBaseUrl`) branches unchanged.
   - Optionally repurpose `pyodideIndexURL` on `RealmInitMsg` as a node-only hint and rename for clarity (e.g. `pyodideNodeIndexURL`). Out of scope for the minimum fix.

3. `packages/webapp/src/shell/supplemental-commands/python-command.ts:280-281`

   - Replace `const pyodideIndexURL = options.pyodideIndexURL ?? resolvePyodideIndexURL();` for the standalone branch with: build an `IpkResolutionContext` from `ctx.fs` (same shape `ffmpeg-command.ts` already constructs — confirm by reading that file; pattern is `{ reader: makeModuleReader(ctx.fs), readBytes: (p) => ctx.fs.readFileBytes(p), fromDir: ctx.cwd }`) and pass it through `RealmInitMsg` so the worker receives it serialized as a directory hint (path-only — the worker re-builds the reader against its own VFS RPC).
   - Keep the `ipk add pyodide` guidance error: surface it _here_ (where we know the cwd and `ctx.stderr` is writable for a helpful guidance line) rather than after the worker's lock-fetch fails. Mirror `FFMPEG_CORE_NOT_INSTALLED`'s `tryLoadFfmpegCoreFromNodeModules → null → throw` flow.

4. `packages/webapp/src/kernel/realm/realm-types.ts` (`RealmInitMsg`)

   - Add `pyodideAssetRoot?: string` — VFS absolute path of the resolved pyodide package directory (e.g. `/workspace/node_modules/pyodide`). The worker uses its existing `vfs` RPC channel (`RealmRpcClient`, already used for `slicc.fs` and OPFS mount sync) to read the four files. **No raw bytes cross the postMessage boundary** — reads happen worker-side against the shared OPFS via the RPC `vfs.read` op, same channel the mount sync already uses.

5. `packages/webapp/src/kernel/realm/py-realm-shared.ts:120-128` (the error-formatting branch)
   - Replace `isPyodidePreviewUrl(...)` guidance with a check on whether the read of `pyodide.asm.js` returned `null` (i.e. mirror `tryLoadFfmpegCoreFromNodeModules`'s null-means-not-installed contract). Same canonical error text: `pyodide is not installed in node_modules: run \`ipk add pyodide\` (no network fallback)`.

### B.2 (Fallback) — Stay on preview SW, harden boot order + error shape

Only if (B.1) is judged too risky. File:line targets:

1. `packages/webapp/src/ui/wc/wc-live.ts:1276-1277` — gate kernel-worker boot on the responder's `installPreviewVfsResponder` resolving, with a measurable readiness ack on the BroadcastChannel. Today the responder install is fired but not awaited; if `python3` runs before it's listening, `readViaMainPage` times out into 404 `responder timeout` (`preview-sw-handler.ts:97-99,168`).
2. `packages/webapp/src/ui/preview-sw-handler.ts:130-174` (`handlePreviewRequest`) — when `outcome.error` is non-null and the request is for `pyodide-lock.json`, return `application/json` with body `{}` plus `X-Slicc-Preview-Status: enoent` so the loader's `JSON.parse` doesn't crash on `"Not found"`. (Cleaner: short-circuit the loader by intercepting `*.json` 404s separately.) Risky — masks real misconfig.
3. `packages/webapp/src/kernel/realm/py-realm-shared.ts:120-128` — when `loadPyodide` rejects with a fetch error and the indexURL is a preview URL, return a more actionable error pointing at the responder vs the install (the current `ipk add pyodide` guidance hits even when the install is correct but the responder isn't up).

Tier-2 only. Leaves the architectural HTTP-origin coupling in place and is strictly worse than B.1 for cold-start latency (SW + BroadcastChannel + OPFS round-trip × 4) and for the QA narrative ("just install pyodide"-vs-"the responder is racing the worker").

### B.3 What I am NOT touching

- `preview-sw-handler.ts` / `preview-sw.ts` — per task constraints, and B.1 removes the dependency entirely so no SW change is needed.
- The extension's `chrome.runtime.getURL('pyodide/')` path — already bypasses the SW; B.1's standalone-only switch leaves the extension untouched.
- The node/vitest branch — already direct file-system load.

## C. Dual-mode + test implications

### C.1 Runtime parity matrix

| Float                                  | Before                                                                                    | After (B.1)                                                                          | Notes                                                                                          |
| -------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| **Standalone CLI (`node-server` dev)** | `toPreviewUrl(...)` → preview SW → BroadcastChannel → OPFS (4 RPCs, 30 s budget)          | Direct VFS read via existing `vfs` RPC channel + blob URLs + scoped fetch shim       | Removes 1 SW dep + 1 BroadcastChannel hop per asset; cold-start should drop sub-second         |
| **Wrangler-served webapp (Env1)**      | Same as above; failing in the QA transcript                                               | Same as standalone — works because no `node-server` is required                      | This IS the path the task is fixing                                                            |
| **Cloud / hosted-leader cone**         | Same standalone code path; runs inside the e2b sandbox `node-server --hosted`             | Same standalone code path                                                            | One fix, two floats unblocked                                                                  |
| **Chrome extension**                   | `chrome.runtime.getURL('pyodide/')` → bundled web-accessible resources                    | Unchanged                                                                            | The asset bundle in `dist/extension/pyodide/` already ships everything; no preview SW involved |
| **Cherry follower**                    | Cherry is a _target_ provider, not a host of the cone; cone-side Python runs on the host  | Unchanged                                                                            | N/A for this fix                                                                               |
| **node-server vitest**                 | `isNodeRuntime() → resolveNodePackageBaseUrl(...)` (file:// URL to local `node_modules/`) | Unchanged (B.1 only affects `!isNodeRuntime() && !isExtensionRuntime()` standalone)  | Keep the existing branch                                                                       |
| **In-process realm (no Worker)**       | `createInProcessPyRealmFactory()` for headless-node tests                                 | Unchanged — `runPyRealm` is shared, but its ipk branch short-circuits in `node` mode | Tests still hit the Node `import('pyodide')` path                                              |

### C.2 Tests to add (in `packages/webapp/tests/kernel/realm/`)

- `py-realm-shared.vfs-load.test.ts` — exercise the new B.1 path against an in-memory VFS seeded with the four pyodide assets. Two assertions:
  - happy path: `runPyRealm` reaches `pyodide.runPythonAsync` and the fetch shim was invoked exactly once with the synthetic indexURL + `pyodide.asm.wasm`.
  - install-missing: with the package absent, `runPyRealm` posts `realm-error` whose message includes `ipk add pyodide`.
- `py-realm-shared.fetch-shim.test.ts` — unit-only: invoke the shim factory in isolation, assert the original `fetch` is restored even on `loadPyodide` rejection (try/finally must hold).
- `kernel/realm/py-realm-shared.test.ts` — existing tests that pin `pyodideIndexURL` behavior: update fixtures to remove the preview-URL string assertions; assert against the synthetic `slicc-pyodide://local/...` shape instead.
- `python-command.test.ts` — happy + ENOENT cases for the new `IpkResolutionContext` plumbing. Mirror `ffmpeg-command.test.ts`'s structure.

No test file _creation_ for floats that aren't changing (extension `chrome.runtime.getURL` path, node-runtime branch).

### C.3 Coverage / lint posture

- `packages/webapp` v8 coverage floor (`coverage-thresholds.json`) — the new logic should land with mirrored tests so the package floor doesn't regress. The fetch-shim + ipk-load helpers are pure functions; structure them so they're individually testable without booting the worker (same shape as `tryLoadFfmpegCoreFromNodeModules`).
- `npm run lint` then `npm run typecheck` then `npm run test` per the root `CLAUDE.md` verification gate.
- `wc-live.ts` is **not** modified in B.1, so the WC shell path is unaffected.

## D. Risks

1. **`import(blobUrl)` of an ESM-ish `pyodide.asm.js` in the kernel DedicatedWorker.** Modern Chromium supports dynamic-import of `text/javascript` blob URLs in workers, but the asm.js distribution is a hybrid that writes `_createPyodideModule` onto `globalThis` at top-level evaluation. If the script is shipped as a strict ES module that `export`s rather than mutating the global, the `typeof _createPyodideModule != "function"` skip in `loadWasmScript` won't fire. Mitigation: explicitly check `typeof globalThis._createPyodideModule === 'function'` after the await, and fall back to letting the loader call `importScripts(coreJsBlobUrl)` (its existing web-worker code path; `importScripts` accepts blob URLs in workers). The existing `w` function in the loader already does this exact try-importScripts-then-import sequence.
2. **`globalThis.fetch` shim race.** Any other code in the worker that fetches during `loadPyodide` will hit the wrapped fetch. The wrapper passes through everything except the sentinel URL, so this is benign — but the try/finally restoration must be airtight. Cover with the test in C.2.
3. **Synthetic indexURL stickiness.** Pyodide stores `indexURL` on the resolved interface for later wheel loads. Wheel loads go through `packageBaseUrl` / `cdnUrl`, which `Se()` defaults to the jsdelivr URL when not explicitly set (`pyodide.mjs:3 → e.cdnUrl=k(e.packageBaseUrl??PYODIDE_RUNTIME_CDN)`). `PYODIDE_RUNTIME_CDN` from `py-realm-shared.ts:47` is already the documented runtime-CDN exception — preserve that path. Confirm by adding an integration test that does `pyodide.loadPackage('numpy')` against a stub fetch and asserts it goes to jsdelivr, not to `slicc-pyodide://`.
4. **Memory pressure.** Reading 14 MB (asm.js + wasm + stdlib zip + lock) into worker memory all at once on every Python invocation. Already true today via the SW path, plus there it goes through the BroadcastChannel buffer twice. Net change is a wash to slightly better.
5. **Blob URL revocation timing.** Pyodide reads `stdLibURL` via `fetch` during the run-dependency phase (Emscripten's `addRunDependency('install-stdlib')` in `Pe`). Revoking before `loadPyodide` resolves would tear the blob out from under that fetch. The try/finally only revokes after `loadPyodide` returns, so this is safe — but the test in C.2 should assert `URL.revokeObjectURL` is called exactly once per blob, after `loadPyodide` resolves (not in the catch path before a partial init crashes).
6. **Cross-runtime CI parity.** Per the repo's automated-PR-review checklist (root `CLAUDE.md` §"Automated PR Review Checklist" pt. 3), a change to webapp must enumerate peer floats. Extension is N/A (separate asset bundle path), node-server/swift-server/ios-app don't host the cone's Pyodide. Explicit "N/A" note belongs in the PR body.
7. **Wrangler-only OAuth noise on Env1.** The transcript's first ~470 lines are `:5710/api/oauth-result` failed-to-fetch from the cone trying to reach a node-server that isn't running. Unrelated to pyodide and out of scope here — flagging only so the coordinator doesn't conflate them when reading the same artifact.

## E. Recommendation

Land B.1. The asymmetry between pyodide and every other heavy WASM dep is the right thing to fix, the loader's escape hatches are sufficient, and the diff is small and well-scoped (`py-realm-shared.ts`, `realm-factory.ts`, `python-command.ts`, `realm-types.ts`, plus tests). The fallback B.2 is on the table only if a reviewer rejects the `globalThis.fetch` shim on principle — in which case I'd want to surface that in the PR description before writing any code.

— end report —
