# Wave 13c · R6 — `say`/`hear` native VFS load (read-only research)

## TL;DR

- **Root cause is BOTH a test-methodology gap AND the same architectural HTTP-origin coupling R5 calls out for pyodide.** The actual failure in `wave-13-standalone-errors-2.md` lines 474-494 is the `assertLocalModelPresent` probe surfacing a clean 404 for `/preview/workspace/models/onnx-community/whisper-tiny/config.json` — i.e. the QA session never ran `hf download onnx-community/whisper-tiny` (and `hf download onnx-community/Kokoro-82M-v1.0-ONNX`). The preview SW is alive and responding correctly with the "missing weights" guidance line; the load fails at the install-presence check **before** transformers.js touches a single byte. So in the failure transcript, the speech path never reaches the architectural cliff that bit pyodide in R5. **But** the architectural coupling IS real, and is _strictly worse_ than pyodide's once weights ARE staged — every `/workspace/models/<repo>/*` and every `/workspace/node_modules/onnxruntime-web/dist/*` read goes through the same preview SW + BroadcastChannel + 30 s OPFS round-trip, multiplied by the much larger file set (model config + tokenizer + preprocessor_config + generation_config + generator_config + onnx encoder + onnx decoder + onnx merged-decoder + tied-weights `.onnx_data` + per-voice `voices/*.bin` for kokoro).
- **Yes, `say` / `hear` share the pyodide/preview-SW coupling and can adopt the same VFS-bytes/blob-URL approach** — with two complications relative to R5: (a) the **model file set is dynamic** (transformers.js decides which files to fetch from the model's own config.json + dtype + the pipeline task), so we can't pre-resolve a fixed list as ffmpeg/pyodide do; and (b) there are **two independent fetch surfaces** — transformers.js's own `env.fetch` (which we already wrap) and onnxruntime-web's `wasmPaths` loader (which has its own internal fetch path).
- **Preferred fix: extend the existing `transformers-env.ts` wrap.** The wrapped `env.fetch` already exists for HF catalog proxying; layer a VFS-bytes branch onto it that recognizes `localModelPath`-prefixed URLs and answers with `new Response(bytes)` synthesized from a direct VFS read. For ort-web, switch `wasmPaths` from a base-URL string to the **object form** (`{filename: blobUrl}`) with the small handful of ort dist files pre-read from VFS as blob URLs. Same alignment as the R5 pyodide fix — VFS-direct, no preview SW, no HTTP origin requirement — and it lands in **one file** (`transformers-env.ts`) instead of the four files R5 touches.
- **Fallback if the env.fetch extension is rejected**: only ratchet `assertLocalModelPresent` to a direct VFS read (so the install-missing case stops being routed through the SW). Strictly worse than the preferred path — leaves every successful load coupled to the SW boot order.
- **Cross-runtime impact**: standalone CLI / Wrangler-served / cloud hosted-leader all benefit. Extension is **not affected** — `configureTransformersEnv` already early-returns on `isExtensionFloat()` (line 132, no `env.fetch` wrap), and the extension's `wasmPaths` works via `host_permissions <all_urls>` against the existing same-origin path. Node / vitest doesn't run the wasm path at all (`hear-command.ts` early-exits in worker realms; `say-command.ts` falls back to Web Speech).

## A. Precise root cause

### A.1 What the transcript actually shows

`wave-13-standalone-errors-2.md` lines 474-494:

```
:8787/preview/workspace/models/onnx-community/whisper-tiny/config.json:1
  Failed to load resource: the server responded with a status of 404 ()
[speech:whisper] whisper load failed Error: weights for onnx-community/whisper-tiny are missing —
  run `hf download onnx-community/whisper-tiny` to fetch them into /workspace/models/.
  at h (transformers-env-DJ-ZHdgz.js:1:1954)
  at async h (whisper-session-CSFM00rG.js:2:861)
```

That error string is verbatim `transformers-env.ts:163` (`assertLocalModelPresent` → `guidance`):

```ts
const guidance = `weights for ${modelId} are missing — run \`hf download ${modelId}\` to fetch them into /workspace/models/.`;
```

So:

1. The preview SW IS up (it answered with HTTP 404, not a connection refused / no-SW-installed pattern).
2. The OPFS read returned ENOENT (the user simply didn't run `hf download` before testing `hear`).
3. `assertLocalModelPresent` did its job — surfaced the actionable guidance line BEFORE transformers.js could die deeper down with a cryptic "Could not load model" from its file-fallback loop.

**This part is a test-methodology gap, not a code bug.** The fix is to run `hf download onnx-community/whisper-tiny` and `hf download onnx-community/Kokoro-82M-v1.0-ONNX` in Env1 before exercising `hear` / `say`. The same shape applies to pyodide in R5 (no `ipk add pyodide` was run) and would apply equally to any other VFS-staged dep.

### A.2 The architectural HTTP-origin coupling — what bites once weights ARE staged

`packages/webapp/src/speech/transformers-env.ts:124-148` (`configureTransformersEnv`) configures transformers.js with two coupling points to the preview SW:

```ts
// L127 — ort-web wasm loader points at the SW-served preview path
onnxWasm.wasmPaths = toPreviewUrl(ORT_DIST_VFS_PATH);
// = `http://localhost:8787/preview/workspace/node_modules/onnxruntime-web/dist/`
…
// L131 — transformers.js model loader points at the SW-served preview path
env.localModelPath = toPreviewUrl(LOCAL_MODELS_VFS_PATH);
// = `http://localhost:8787/preview/workspace/models/`
```

Then the wrapped `env.fetch` (L138-147) explicitly **passes same-origin URLs through to the native realm `fetch`** so the preview SW can intercept them (L140-142 comment "Skipping same-origin lets the wrapped `env.fetch` fall through to the native page-realm `fetch`, which the SW intercepts and answers from OPFS").

That's identical in spirit to pyodide's `toPreviewUrl('/workspace/node_modules/pyodide/')` indexURL, with the same chain:

1. transformers.js / ort-web emit `GET /preview/workspace/models/<repo>/<file>`
2. `/preview-sw.js` (scope `/preview/`) intercepts
3. Page-side `installPreviewVfsResponder` BroadcastChannel responder reads OPFS
4. 30 s `DEFAULT_TIMEOUT_MS` (`preview-sw-handler.ts:77`) per file
5. Response streams back

And the speech path is **strictly worse than pyodide's 4-file payload**:

| Engine                                         | File set per cold start                                                                                                                                                                                                                              | Round-trips |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| Pyodide (R5)                                   | `pyodide.asm.js`, `pyodide.asm.wasm`, `python_stdlib.zip`, `pyodide-lock.json`                                                                                                                                                                       | 4           |
| Whisper (`onnx-community/whisper-tiny`)        | `config.json`, `tokenizer.json`, `tokenizer_config.json`, `preprocessor_config.json`, `generation_config.json`, `onnx/encoder_model_{quantized\|fp32}.onnx`, `onnx/decoder_model_merged_{quantized\|fp32}.onnx`, plus possible `.onnx_data` sidecars | 7-9         |
| Kokoro (`onnx-community/Kokoro-82M-v1.0-ONNX`) | `config.json`, `tokenizer.json`, `tokenizer_config.json`, `onnx/model_{q8\|fp32}.onnx`, `onnx/model.onnx_data` (~330 MB at fp32 — split data file), `voices/*.bin` (54 voices × ~500 KB)                                                             | ~60         |
| ort-web dist (shared)                          | `ort-wasm-simd-threaded.jsep.mjs`, `ort-wasm-simd-threaded.jsep.wasm` (JSEP build for WebGPU)                                                                                                                                                        | 2           |

A kokoro cold start is ~60 SW round-trips, each subject to the responder-readiness race and the 30 s timeout. Pyodide bit at 4 files; kokoro is an order of magnitude more vulnerable to the same boot race that R5 calls out (`wc-live.ts` doesn't await `installPreviewVfsResponder` ready before the kernel-worker starts).

### A.3 The two fetch surfaces

Reading `node_modules/@huggingface/transformers/dist/transformers.web.min.js` (the bundle this app loads):

- The library exposes a single fetch seam — `env.fetch` (default `globalThis.fetch.bind(globalThis)`, line `Kk=typeof globalThis.fetch=="function"?globalThis.fetch.bind(globalThis):void 0` in the min bundle). The internal `zt()` helper (file-fetch) is `J.useFS && !http/https/blob ? new FileResponse(...) : J.fetch(t, headers)` — `useFS` is Node-only, so in the browser EVERY transformers.js file fetch routes through `env.fetch`. That includes both the "fetch model file" path (`Lr()` → `iA()` → `zt()`) and the "head request for size" path (`rA()` → `J.fetch(t, …)`). The cache-write helper `oA()` accepts both `Response` and raw `Uint8Array` so a synthetic Response built from VFS bytes is a clean drop-in.
- **`onnxruntime-web` is a separate fetch surface.** The ort-web bundle loads its `*.wasm` and `*.mjs` files via its OWN internal fetch (it doesn't go through transformers.js). The `wasmPaths` config accepts EITHER a string (treated as a base URL prefix — the current standalone usage) OR an object mapping `{filename: url}`. That's the seam that lets the speech engines hand ort-web blob URLs.

### A.4 What `getVirtualFs()` is reachable from

`hear.ts:14-15`: "Page/offscreen realm only; the kernel worker bridges here over the `hear-*` panel-RPC ops".

So `configureTransformersEnv` is always invoked from a realm that has direct VFS access — the page realm (`window`) for standalone / cherry / hosted-leader, the offscreen document for the extension. The kernel worker NEVER configures transformers.js; the speech engines are reached over panel-RPC. That means a VFS-bytes branch inside the wrapped `env.fetch` can use the page-realm VFS surface directly without panel-RPC plumbing — same as `dip.ts` and `sprinkle-renderer.ts` already do.

The VFS reader to use is `getVirtualFs()` from `packages/webapp/src/fs/virtual-fs.ts` (consistent with the rest of `packages/webapp/src/ui/*` and `packages/webapp/src/speech/audio.ts` — both run in the page realm). It exposes `readFileBytes(path)` returning `Uint8Array`. No `IpkResolutionContext` needed — the model files live under `/workspace/models/`, not under `node_modules/`, and the path-to-VFS-path mapping is a trivial `localModelPath` prefix-strip.

### A.5 Test-methodology vs real-code bug, separated

| Aspect                                                              | Type                   | Evidence                                                                                                                                                               |
| ------------------------------------------------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 404 on `config.json` in Env1                                        | Test methodology gap   | `hf download` not run; same as R5 pyodide ENOENT shape                                                                                                                 |
| `assertLocalModelPresent` surfacing the guidance line               | Working as intended    | `transformers-env.ts:161-175` does exactly what its docstring promises                                                                                                 |
| Preview-SW coupling for every file load once weights are staged     | Real architectural bug | `transformers-env.ts:127, 131`; ~60 SW round-trips for kokoro; subject to the responder boot-race; race-mitigation is the same single-file fix R5 lays out for pyodide |
| `say --list` listing kokoro voices even when the engine isn't ready | Working as intended    | `kokoroVoicesIfReady() → []` until load completes; `say` falls back to Web Speech                                                                                      |
| `voice-reply.ts` triggering kokoro on every dictated turn           | Working as intended    | One-shot flag from input card; warmup is chained off whisper, not at boot                                                                                              |

## B. Ranked fix plan

### B.1 (Preferred) — VFS-bytes branch in `configureTransformersEnv` + object-form `wasmPaths`

Trace-out by file:

1. `packages/webapp/src/speech/transformers-env.ts:124-148` (`configureTransformersEnv`)

   - **Replace L127** (`onnxWasm.wasmPaths = toPreviewUrl(ORT_DIST_VFS_PATH)`) with an object-form mapping built from VFS bytes:

     ```ts
     // SAME WAVE-7 DEAL: the bytes are at /workspace/node_modules/onnxruntime-web/dist/
     // — but we read them via the page-realm VFS surface (no preview SW round-trip)
     // and hand ort-web a blob: URL per file via its documented object-form wasmPaths.
     const ortWasmPaths = await buildOrtWasmPathsFromVfs(getVirtualFsForRealm());
     // returns { 'ort-wasm-simd-threaded.jsep.mjs': 'blob:…', 'ort-wasm-simd-threaded.jsep.wasm': 'blob:…' }
     // (plus the JSPI / Asyncify variants the runtime might fall back to; resolve them lazily)
     if (onnxWasm) onnxWasm.wasmPaths = ortWasmPaths;
     ```

     `getVirtualFsForRealm()` is a tiny helper that picks `getVirtualFs()` in page realms (where this code runs) — same as `dip.ts` / `sprinkle-renderer.ts` already do. Reads should be eager+parallel for the small handful of ort files (each ≤2 MB) so first-load isn't gated on an awaited fetch.

   - **Extend L138-147** (the wrapped fetch) — add a branch BEFORE the same-origin pass-through that recognizes `localModelPath`-prefixed URLs and answers from VFS bytes:

     ```ts
     const wrapped = async (input, init) => {
       const url = urlString(input);
       const previewPath = extractVfsPathFromPreviewUrl(url, env.localModelPath);
       if (previewPath !== null) {
         return readVfsAsResponse(getVirtualFsForRealm(), previewPath); // new helper
       }
       if (!isRemoteHttpUrl(input) || isSameOriginUrl(input)) {
         if (originalFetch) return originalFetch(input, init);
         return fetch(input as RequestInfo, init);
       }
       return proxiedTransformersFetch(input, init);
     };
     ```

     `readVfsAsResponse` builds a `new Response(bytes, { status: 200, headers: { 'Content-Type': detectMimeType(path), 'Content-Length': String(bytes.byteLength) } })`. ENOENT → `new Response(`Not found: ${path}`, { status: 404 })` so transformers.js' file-fallback chain still routes correctly (same status as the SW path).

   - **Also intercept the HEAD probes** that `rA()` (the cache-aware metadata helper) issues — those are full `J.fetch(...)` calls with `Range: bytes=0-0` and `method: 'GET'`. Returning a real Response with the correct Content-Length keeps the size-only fast-path working without ever reading the heavy bytes; teach `readVfsAsResponse` to short-circuit on `range: 'bytes=0-0'` + `method: 'GET'` by returning a 206 with an empty body and the correct content-length header. (See risk D.3.)

   - **Switch `assertLocalModelPresent`** (`transformers-env.ts:161-175`) from `fetch(toPreviewUrl(...))` to a direct VFS `exists(...)` / `readFileBytes(...)` probe. Removes the only place outside the wrapped fetch that still depends on the preview SW; surfaces the same canonical guidance error.

2. `packages/webapp/src/shell/supplemental-commands/shared.ts:86-102` (`toPreviewUrl`)
   - **No changes.** Other consumers (preview iframes, sprinkles, `serve`, `open`, the chat avatar) still need the SW path. The speech engines just stop being one of those consumers.

3. `packages/webapp/src/speech/{whisper-engine,kokoro-engine}.ts`
   - **No changes.** Both engines call `configureTransformersEnv` after their dynamic import; the new wrap behavior is invisible to them. Progress callback signatures, error messages, and the `assertLocalModelPresent` invocation stay identical.

4. `packages/webapp/src/ui/wc/wc-live.ts:1276-1277` (the responder boot order R5 calls out)
   - **No changes.** With both speech engines off the preview SW, the responder race no longer affects speech. (It still affects pyodide and any other unfixed SW consumer; R5 owns that.)

### B.2 (Fallback) — Probe-only fix

Only if (B.1) is rejected:

1. `packages/webapp/src/speech/transformers-env.ts:161-175` — switch `assertLocalModelPresent` to a direct VFS read. Removes the only place where the install-missing guidance line is dependent on a working preview SW; everything else stays on the SW.

Cuts the install-missing failure mode from a network round-trip to a sub-ms VFS read, but leaves the architectural coupling for every successful load. Tier-2 only.

### B.3 What I am NOT touching

- `preview-sw.ts` / `preview-sw-handler.ts` — per task constraints, and (B.1) removes the dependency entirely.
- The extension early-return at L132 (`if (isExtensionFloat()) return;`) — extension already loads via `chrome.runtime.getURL`-served `host_permissions`-covered paths; no race, no fix needed there.
- The HF-Hub probe path / `/api/fetch-proxy` — still needed for any genuine remote fetch (transformers.js still emits HEAD/GET against `huggingface.co` for catalog probes when traversing fallbacks; `allowRemoteModels=false` keeps those bounded, but the wrap stays).
- `voice-reply.ts`, `composer-speech.ts`, `hear-command.ts`, `say-command.ts` — all unchanged; they don't touch fetch.
- `hf-command.ts` — already reads from VFS directly via the shared resolver, not a fetch consumer.

## C. Dual-mode + test implications

### C.1 Runtime parity matrix

| Float                                          | Before                                                                                                                                        | After (B.1)                                                                                                                    | Notes                                                                                          |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| **Standalone CLI (`node-server` dev)**         | `toPreviewUrl(...)` → preview SW → BroadcastChannel → OPFS (~60 RPCs for kokoro cold start; 30 s budget each; subject to responder boot-race) | Wrapped `env.fetch` reads VFS bytes directly → `new Response(bytes)`; ort-web `wasmPaths` resolved to blob URLs once per realm | Removes 1 SW dep + 1 BC hop + 1 timeout per file; cold-start drops by O(files × responder-RTT) |
| **Wrangler-served webapp (Env1)**              | Same as above; this is the path the task is fixing                                                                                            | Same as standalone — no `node-server` involvement                                                                              | Wrangler-only fix is satisfied; no worker changes                                              |
| **Cloud / hosted-leader**                      | Same standalone code path inside the e2b sandbox                                                                                              | Same standalone code path                                                                                                      | One fix, two floats unblocked                                                                  |
| **Chrome extension**                           | `isExtensionFloat() → early return` (no `env.fetch` wrap); `toPreviewUrl` rewrites to `chrome.runtime.getURL('/preview/...')`                 | Unchanged                                                                                                                      | Extension lives outside the wrap on purpose; host_permissions covers same-origin VFS streaming |
| **Cherry follower**                            | Cherry is a target provider; the cone runs on the leader (the host page). Speech engines are leader-side only                                 | Unchanged                                                                                                                      | N/A for this fix                                                                               |
| **Node / vitest**                              | `isNodeRuntime() → resolveNodePackageBaseUrl()` for ort-web; speech engines bail in worker realms                                             | Unchanged — B.1's new helper short-circuits on `isNodeRuntime()` and falls back to the file:// URL path                        | Keep the existing branch                                                                       |
| **Cone in a worker (PTT-from-worker, future)** | Speech engines are page-realm-only today (`hear.ts:14-15`); no worker-side `configureTransformersEnv`                                         | Same — B.1 doesn't enable worker-side speech                                                                                   | N/A for this fix                                                                               |

### C.2 Tests to add (`packages/webapp/tests/speech/`)

- **`transformers-env.vfs-load.test.ts`** — exercise the new B.1 path against an in-memory VFS seeded with a synthetic `config.json` + a fake `.onnx` byte payload + the ort dist files:
  - happy path: `env.fetch('http://localhost:8787/preview/workspace/models/foo/bar/config.json')` resolves with `Response.ok === true`, `Content-Length` matches, body parses as JSON.
  - HEAD probe path: `env.fetch(url, { headers: { Range: 'bytes=0-0' } })` returns 206 with the correct Content-Length and an empty body.
  - ENOENT: missing file returns a Response with `status === 404` and the canonical body the SW currently emits.
  - non-preview URL: same-origin static asset still falls through to native `fetch` (i.e. doesn't get hijacked).
  - HF remote probe: `https://huggingface.co/...` still goes through `proxiedTransformersFetch` (the existing branch).
- **`transformers-env.assert-local-model-present.test.ts`** — `assertLocalModelPresent` with the VFS-direct probe: missing config → guidance error; present config → resolves without error.
- **`transformers-env.wasm-paths.test.ts`** — `buildOrtWasmPathsFromVfs` returns an object with the right keys; missing ort install → canonical `ipk add onnxruntime-web` guidance error mirroring `FFMPEG_CORE_NOT_INSTALLED`.
- **`whisper-engine.smoke.test.ts` / `kokoro-engine.smoke.test.ts`** (light revisions of existing tests, if any) — assert the engines build correctly under the new env wrap without hitting any `fetch` outside of the VFS shim. Mock pi-ai pipeline construction.

No new test file for floats that aren't changing (extension `isExtensionFloat()` early-return path, Node runtime branch).

### C.3 Coverage / lint posture

- `packages/webapp` v8 coverage floor (`coverage-thresholds.json`) — the new helpers (`buildOrtWasmPathsFromVfs`, `readVfsAsResponse`, `extractVfsPathFromPreviewUrl`) are pure functions; structure them so they're individually testable without booting transformers.js. Same shape as `tryLoadFfmpegCoreFromNodeModules` in `ffmpeg-wasm.ts`.
- `npm run lint` → `npm run typecheck` → `npm run test` per the root `CLAUDE.md` verification gate.
- `wc-live.ts` is not modified, so the WC shell path is unaffected.
- No documentation change needed in `docs/architecture.md`; an updated comment block at the top of `transformers-env.ts` (the file-level docstring already describes the SW wiring — needs a one-paragraph update to "Wave 13 swap: VFS-direct, no preview SW" mirroring the file's current Wave 7 callout).

## D. Risks

1. **`Response`-from-bytes ergonomics**: transformers.js' `iA()` consumer reads `response.headers.get('content-length')` AND `response.body.getReader()`. A `new Response(uint8Array, ...)` exposes both correctly, but the Content-Type matters for the cache key (the cache write in `oA()` clones the Headers). Mitigation: `readVfsAsResponse` MUST set Content-Type via `detectMimeType(path)` (already exported from `shared.ts:82-84`). Add a test that asserts the cached response round-trips with identical body bytes + Content-Type.
2. **Progress reporting flattens to a single chunk**: today, transformers.js' progress callback fires per-stream-chunk as the SW streams. With a buffered Response, the loader sees `{progress:100, loaded:N, total:N}` on the first read — same UX as a fully cached file. The composer's "downloading … ready in ~ETA" line and `hear --status` shows the load completing in one snapshot per file. Acceptable but worth noting in PR description: the "downloading" status disappears in a blink because there's nothing to download.
3. **HEAD probe Range semantics**: the metadata helper issues `GET` with `Range: bytes=0-0` and expects either 206 with a `Content-Range: bytes 0-0/<total>` header or a 200 with `Content-Length`. The current SW responder returns 200 with the body cancelled by transformers.js; the VFS-direct path is free to do the same OR return a proper 206. Pick the 206 route — it's strictly more efficient (no need to read the file body just to discard it) and matches what the cache miss path expects (`zt()` calls `b.body?.cancel()` for the 200 case, which is a no-op on a buffered Response anyway).
4. **Cross-runtime parity (CI gate)**: per `docs/review-patterns.md` parity matrix, a change to `webapp` typically requires peer floats updated or an explicit N/A note. Extension: N/A (early-return at L132). `node-server` / `swift-server` / `ios-app`: N/A (speech engines are page-realm only). Cherry: N/A (target, not host). All N/A — surface that explicitly in the PR body.
5. **Concurrent first-load (`say` ⇄ `hear` race)**: kokoro warmup chains automatically off whisper readiness (`whisper-engine.ts:92-96`). If `say` is invoked before whisper completes, both engines call `configureTransformersEnv(env)` concurrently. The wrap's `FETCH_WRAPPED_MARKER` idempotency check (L51, L136) already covers this. The `buildOrtWasmPathsFromVfs` call should be similarly idempotent — cache the resolved object on a module-level promise (same shape as `whisperPromise` / `kokoroPromise`). Add a test that double-invokes `configureTransformersEnv` and asserts the wasmPaths object is referentially stable.
6. **`localModelPath` mutation midway through a model load**: transformers.js reads `J.localModelPath` (the env field) at file-resolve time, not at config time, so a mutation after `configureTransformersEnv` could break the prefix match in `extractVfsPathFromPreviewUrl`. Defense: snapshot `env.localModelPath` once inside the wrap closure (capturing the value at first call) so subsequent loads use the same prefix. Same idea the existing `FETCH_WRAPPED_MARKER` uses.
7. **Memory pressure**: kokoro's ~330 MB `model.onnx_data` is read into memory as a single Uint8Array. That's the SAME memory profile as the current SW path (which also reads the full file into memory page-side before streaming). No regression. The voices/\*.bin files are tiny (~500 KB each).
8. **Blob URL revocation for ort dist**: blob URLs returned from `buildOrtWasmPathsFromVfs` must persist for the lifetime of the ort runtime (which may instantiate at any later `pipeline(...)` call). Do NOT revoke on `configureTransformersEnv` return. Same lifetime contract as the existing `wasmPaths` string — no revocation today, no revocation tomorrow.
9. **Extension regression check**: the extension early-return at L132 is load-bearing — host_permissions covers `chrome-extension://` origin reads, but `chrome-extension://` URLs are NOT same-origin from a service-worker preview perspective. Don't accidentally move the early-return below the new wasmPaths setter — that would route extension ort-web through the new VFS shim, which would then need to bridge to OPFS via the extension's storage layer. Easy footgun. Keep `isExtensionFloat()` early-return at the very top, before any new logic.
10. **OAuth noise on Env1**: the transcript's first ~470 lines are `:5710/api/oauth-result` `net::ERR_FAILED` from the cone trying to reach a `node-server` that isn't running in Wrangler-only mode. Unrelated to speech, out of scope here; flagging only so the coordinator doesn't conflate them when reading the same artifact (same caveat R5 raised).

## E. Recommendation

Land B.1 as a one-file change (`transformers-env.ts`) plus mirrored tests. It's symmetric with the R5 pyodide fix philosophy — VFS-direct reads via blob URLs / synthetic Responses, no preview SW dependency for heavy lazy-fetched assets — and is even smaller in diff because transformers.js already exposes the `env.fetch` seam we need. The fallback B.2 is on the table only if a reviewer rejects intercepting `env.fetch` for `localModelPath`-prefixed URLs in principle.

A reasonable sequencing with R5: land R5's pyodide fix first (it owns the `wc-live.ts` responder-boot-order test bed), then R6's speech fix without touching `wc-live.ts` at all — both fixes converge on the same VFS-direct outcome, but stay independent at the file level.

— end report —
