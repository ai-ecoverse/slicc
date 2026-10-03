# A local kernel on iOS (and Android)

Status: exploration. Nothing here is built. The measurements come from the
iOS 27.0 Simulator (October 2026), so the memory, worker and speed numbers are
upper bounds, not phone figures: the Simulator runs Mac-native WebKit on an
Apple-silicon CPU, with no jetsam.

The question: can SLICC's kernel and its native programs (GNU bash, coreutils,
git, Python, rustc, clang) run on a phone, and which wasm runtime would carry
them?

## The short answer

On iOS, yes. The same TypeScript kernel runs real programs in WebKit today, in
Safari and inside a `WKWebView`, with no port. In the Simulator:

- the leader booted;
- `ipk install` worked;
- GNU bash ran with fork and job control;
- coreutils pipelines ran;
- WASIX CPython 3.14 ran, with sqlite3 and hashlib;
- rustc 1.98 compiled and ran `hello.rs` in about 1 s.

Three things block it, all on our side (see [Blockers](#blockers)).

The runtime question mostly goes away. The kernel implements WASI preview1 and
WASIX itself (`kernel/wasm-realm/`), over a SharedArrayBuffer + `Atomics.wait`
bridge, so what a platform has to provide is a **JS engine** with WebAssembly
threads, SharedArrayBuffer, `Atomics.wait` in workers, many dedicated workers,
OPFS and enough memory. WebKit provides all of it, JIT included: wasm runs in
the WebContent process, which is Apple's and may JIT.

## What WebKit gives the kernel

| Capability                                  | iOS 27 Simulator                                                              |
| ------------------------------------------- | ----------------------------------------------------------------------------- |
| `crossOriginIsolated` / SAB                 | only with COOP `same-origin` + COEP `require-corp` (see blocker 1)            |
| `Atomics.wait` in a worker                  | blocks, wakes on `notify`                                                     |
| Wasm threads (shared memory across workers) | yes (4 workers × atomic adds, correct total)                                  |
| Workers                                     | nested workers work; 512 spawned; 48 × 64 MB allocated                        |
| JSPI, exceptions, tail calls, SIMD          | yes                                                                           |
| Memory64                                    | **no**                                                                        |
| Largest single `WebAssembly.Memory`         | 2,624 MB, then "Out of memory"                                                |
| OPFS sync access handles                    | yes; 256 MB written at 1.1–1.9 GB/s; quota 39 GB (Safari), 9.8 GB (WKWebView) |
| Wasm speed                                  | JIT: a scalar loop at V8 parity (464 ms vs 442 ms)                            |
| Compile of `rustc.wasm` (173 MB)            | 105–158 ms (lazy tiering; V8: 118 ms)                                         |

Programs, installed with `ipk install -g` into the real install path:

| Package               | Install | Checked                                                                                                                |
| --------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------- |
| wasm-coreutils        | 3.4 s   | `printf … \| sort`, `ls \| head`                                                                                       |
| wasm-bash             | 3.6 s   | `$(…)`, subshells, `sleep 1 & wait`, pipelines, `trap … USR1; kill -USR1 $$`; then it takes over as the terminal shell |
| wasm-git (56 MB)      | 16 s    | blocked by the rename bug (blocker 2)                                                                                  |
| wasix-python (108 MB) | 83 s    | sqlite3, hashlib; 0.38 s start once compiled                                                                           |
| wasi-rustc (275 MB)   | 73 s    | `rustc h.rs` in ~1.0 s, output runs; needs blocker 3 fixed. Peak WebContent footprint ~509 MB                          |

## Blockers

1. **Isolation headers.** iOS WebKit grants SharedArrayBuffer only to
   pages served with COOP `same-origin` + COEP `require-corp`. It ignores
   `Document-Isolation-Policy`, which is all the hosted leader sends, and
   `COEP: credentialless`. From the live site today, `crossOriginIsolated` is
   false, and a native program exits 126. Fixing it means serving
   `require-corp` to WebKit, which blocks cross-origin no-cors subresources
   that don't send `Cross-Origin-Resource-Policy`. Options:
   - a separate mobile origin with COOP/COEP;
   - COOP/COEP alongside DIP for WebKit user agents only;
   - the in-app route below, where the app's own server sets the headers.
2. **File rename fails on WebKit's OPFS.** `rename()` of a file fails with
   ENOENT, from ZenFS `IndexFS.pathsForRename`: the path is missing from its
   index. Directory rename works, and so do `stat`, `cat` and `cp`. It breaks
   `mv`, `>` over an existing file from wasm bash ("File exists"), and
   `git init` (lock + rename of `.git/config`). The same build renames fine in
   Chromium. This likely affects desktop Safari too. Root cause still open.
3. **A 4 GiB shared-memory maximum throws.** `rustc.wasm` imports a shared
   memory with `maximum: 65536` pages, and WebKit refuses it with
   `RangeError: Out of memory`; 32,768 pages (2 GiB) works. The fix: when the
   declared maximum throws, `importedMemory` in `wasi-runtime.ts` retries with
   2 GiB. A smaller maximum is legal for an imported memory.

## Other iOS findings

- **Service workers.** On a COOP/COEP-isolated page in the iOS 27 Simulator,
  `navigator.serviceWorker.register()` never settles. Without isolation it
  activates in ~320 ms. macOS Safari 27 is fine, and a real device is
  unverified. SLICC's boot waits on that registration. The probe booted with
  service workers hidden, which is also what a `WKWebView` looks like:
  `WKWebView` has no service workers unless the app declares App-Bound
  Domains.
- **`WKURLSchemeHandler` origin.** A `slicc://` page with COOP/COEP reports
  `crossOriginIsolated: true` but has no `SharedArrayBuffer` global. Shared
  `WebAssembly.Memory` buffers still work, post to workers and wait/notify, so
  a one-line polyfill (`globalThis.SharedArrayBuffer ??=
new WebAssembly.Memory({initial: 1, maximum: 1, shared: true}).buffer.constructor`)
  covers it. A loopback `http://localhost` origin served by the app behaves
  exactly like Safari.
- **Background.** A tab or web view that isn't in the foreground stops
  running. The kernel freezes with it, and the page may restart on return.
- **Memory on a phone.** There is no fixed per-tab budget. Reports put an
  iPhone's WebContent process at roughly 1.5–3 GB, depending on device and
  uptime, and no web API or app entitlement raises it for WebContent. rustc
  and clang are borderline, and an LLVM link step is at risk.
- **Asyncify and JSC's optimizing tier.** Functions over ~40 KB in Asyncify
  builds make JSC's OMG tier spike to ~4 GB while compiling. On an iPhone 16
  Pro that got the tab killed 4 times out of 4 (WebKit bug 304810). GNU bash's
  fork uses Asyncify, so this needs a real-device test.

## Routes

| Route                                     | Verdict                                                                                                                                                                                                        |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **iOS `WKWebView` in `packages/ios-app`** | Most realistic. Same kernel, JIT included. Serve the webapp from an in-app loopback server with COOP/COEP (proven), or a scheme handler plus the SAB polyfill (proven).                                        |
| iOS Safari                                | Works once the leader origin sends COOP + COEP `require-corp` for WebKit, plus blockers 2–3.                                                                                                                   |
| Android Chrome / Trusted Web Activity     | Should work today (untested): it's the same Blink as desktop, with COOP/COEP since Chrome 88 and DIP since 146. Wasm memory up to 4 GB; Memory64 since Chrome 133.                                             |
| Android System WebView                    | Blocked: no cross-origin isolation, ever (one renderer per app; [crbug 40914606](https://issues.chromium.org/issues/40914606), Won't Fix). Use a Trusted Web Activity, or GeckoView, which supports COOP/COEP. |
| Native wasm runtimes                      | Not recommended (below).                                                                                                                                                                                       |

### The in-app route in more detail

A `WKWebView` in the follower app would run a local leader. What changes from
the desktop float:

- **Origin and headers:** an in-app HTTP server on loopback serves the webapp
  with COOP/COEP.
- **No service worker:** the jobs it does on desktop (LLM CORS proxying, the
  sync-fs SW transport, `/preview/*`) have to come from the native side. The
  scheme handler or a `URLSession` proxy would answer them, much as
  node-server's `--serve-only` does. The wasm realm itself doesn't need the SW:
  its sync bridge is SharedArrayBuffer + Atomics.
- **Native glue:** keychain-held provider keys, and pausing or resuming around
  backgrounding.

A first milestone: **bash + coreutils + git + python** in the app, as a local
leader alongside the existing follower UI. Rough estimate: 1–2 weeks once the
three blockers are fixed.

Lost compared with desktop:

- memory is bounded by jetsam;
- no Memory64;
- the kernel pauses in the background;
- the Asyncify/OMG risk above.

Threads, fork, pipes, ptys and the VFS all carry over.

### Why not a native runtime

A native runtime (Wasmtime, Wasmer, WAMR, wasm3, wasmi, WasmKit) would mean
re-hosting the kernel: VFS, pipes, signals, fork through Asyncify, ptys and
sockets. That's months of work.

On iOS such a runtime must interpret, since third-party JIT is not allowed:

| Runtime                | fib(40) on iOS |
| ---------------------- | -------------- |
| JSC JIT in `WKWebView` | 4.3 s          |
| wasm3                  | 22.6 s         |
| WAMR                   | 78.3 s         |

These are a-Shell's measurements ([a-shell#843](https://github.com/holzschu/a-shell/discussions/843)). Wasmtime's Pulley interpreter is documented at about 10× slower than Cranelift. AOT translation (wasm2c, w2c2) reaches native speed, but only for programs compiled into the app, so `ipk install` is out.

On Android, Wasmtime and Wasmer can JIT. Wasmer's WASIX also differs from our
kernel's, so programs that run in SLICC would not run there unchanged.

EU alternative browser engines (BrowserEngineKit, iOS 17.4+) allow Blink or
Gecko with JIT, but only in browser apps, and no major vendor ships one as of 2026.

## Open decisions

1. **Headers for WebKit.** Serve COOP + COEP `require-corp` to Safari: a
   separate mobile origin, or UA-scoped headers next to DIP. That would make
   mobile Safari a first-class float.
2. **The in-app milestone.** A local leader in `packages/ios-app`.
3. **A real-device run** of the same probes: jetsam limits, the service-worker
   hang, the Asyncify/OMG memory spike. The Simulator can't answer these.
4. **Android:** a real-phone run of the hosted leader in Chrome. There was no
   Android SDK or emulator for this exploration.

Blockers 2 (rename) and 3 (memory maximum) are plain bugs and are being fixed
independently of these decisions.
