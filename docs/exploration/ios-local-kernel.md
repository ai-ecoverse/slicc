# A local kernel on iOS (and Android)

Status: exploration. Nothing here is built. The iOS measurements come from the
iOS 27.0 Simulator (October 2026), so their memory, worker and speed numbers
are upper bounds, not phone figures: the Simulator runs Mac-native WebKit on an
Apple-silicon CPU, with no jetsam. The Android measurements come from a real
phone (see [Android on a real phone](#android-on-a-real-phone)).

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

Three things blocked it, all on our side (see [Blockers](#blockers)); two are
now fixed.

On Android, it already works in Chrome. On a 3.6 GB moto g67 with Chrome 152,
the leader boots, the hosted origin is cross-origin isolated as deployed, and
bash, git, Python, rustc and zig all ran. Android System WebView can't run the
wasm realm: it is never cross-origin isolated.

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
2. **File rename failed on WebKit** (fixed in #3785, issue #3783). `rename()`
   of a file failed with ENOENT, which broke `mv`, `>` over an existing file
   from wasm bash ("File exists") and `git init` (lock + rename of
   `.git/config`). The cause was in ZenFS's `Async` mixin: it decides from
   `error.stack` whether a call is nested in another, and matched V8's frame
   text only. The patch names the wrappers so every engine prints them
   (upstream: [zen-fs/core#325](https://github.com/zen-fs/core/issues/325)).
   Desktop Safari had the same bug. **Firefox still fails**: release builds
   capture no async frames, so a stack taken after `await` shows only the
   current function and nesting can't be read from it at all (measured on
   Firefox 157 for Android, below). A fix that works there can't use stack
   traces.
3. **A 4 GiB shared-memory maximum threw on WebKit** (fixed in #3782).
   `rustc.wasm` imports a shared memory with `maximum: 65536` pages, and
   WebKit refused it with `RangeError: Out of memory`; 32,768 pages (2 GiB)
   works. When the declared maximum throws, `createImportedMemory` in
   `wasi-runtime.ts` now retries with 2 GiB, which is legal for an imported
   memory. Chrome on Android reserves the full 4 GiB, so it never needs the
   fallback.

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

## Android on a real phone

A moto g67: MediaTek Dimensity 6100+ (MT6835), 3.6 GB RAM, Android 16,
Chrome 152.0.7977.82, Android System WebView 151.0.7922.199. Driven over USB:
Chrome DevTools on a forwarded port, and pages served from the Mac through
`adb reverse` (so `http://localhost` is a secure context on the phone).

### What Chrome gives the kernel

| Capability                          | Chrome 152 on the phone                                                                         |
| ----------------------------------- | ----------------------------------------------------------------------------------------------- |
| `crossOriginIsolated` / SAB         | yes with COOP + COEP `require-corp`, with COEP `credentialless`, **and** with DIP alone         |
| The hosted leader as deployed (DIP) | `crossOriginIsolated: true`, SAB present: no header change needed                               |
| Service workers on isolated pages   | register and activate (~355 ms)                                                                 |
| `Atomics.wait` in a worker          | blocks, wakes on `notify`                                                                       |
| Wasm threads                        | yes (4 workers × atomic adds, correct total)                                                    |
| Memory64, JSPI, exceptions, SIMD    | all yes                                                                                         |
| Shared `WebAssembly.Memory`         | a 4 GiB maximum is reserved and grows to 4,096 MB untouched                                     |
| OPFS sync access handles            | yes; 256 MB at ~300 MB/s write, ~700 MB/s read; quota 10 GB                                     |
| Compile (lazy) of `rustc.wasm`      | 416 ms (clang 226 ms, zig 309 ms)                                                               |
| Workers                             | the renderer is killed at ~160–190 idle workers (each spawned and pinged, nothing else running) |

Programs, through the real kernel on a local leader:

| Package / program        | Install   | Checked                                                                                               |
| ------------------------ | --------- | ----------------------------------------------------------------------------------------------------- |
| wasm-coreutils           | 4.2 s     | `sort`, pipelines                                                                                     |
| wasm-bash                | 4.1 s     | `$(…)`, subshells, `sleep 1 & wait`, pipelines, `trap … USR1; kill -USR1 $$`: 3.5 s for the whole lot |
| wasm-git (56 MB)         | 25.5 s    | `init`, `add`, `commit`, `log`, `mv` + `status`: 26.5 s cold; `add` + `commit` + `log` 10.5 s warm    |
| wasix-python (108 MB)    | 10 m 56 s | sqlite3 + hashlib: 3.7 s (first run, compile included); `sum(i*i for i in range(2_000_000))` 2.4 s    |
| wasi-rustc 1.98 (275 MB) | 39.9 s    | `rustc --version` 2.2 s; `hello.rs` (`-C opt-level=1`) 11.4 s, output runs; no 2 GiB fallback needed  |
| wasi-zig 0.16 (166 MB)   | 22 m 59 s | `zig build-exe -O ReleaseSmall hello.zig` 4 m 33 s, output runs                                       |

Installs of packages with thousands of small files (Python's stdlib, zig's
`lib/`) are slow: the time goes into writing each file to the VFS, not the
download. For comparison, Python installed in 83 s in the iOS Simulator.

### Memory

The phone has 3.6 GB of RAM and ~2.7 GB of zram swap, with ~1.4 GB available
at rest.

- **rustc hello**: renderer peak ~1,066 MB, 530 MB left on the phone.
- **zig hello**: renderer peak ~1,301 MB, 262 MB left.
- **OOM point**: a single wasm memory filled with random bytes got the renderer
  killed just past **2 GB** (renderer RSS ~1.9 GB, 115 MB left). Filled with a
  constant it got to 3.5 GB, because zram compresses it to almost nothing, so
  real programs land in between. On the way, Android's low-memory killer took
  background apps and even the keyboard.

So on a 3.6 GB phone, rustc and zig hello-worlds fit with room to spare, and a
real build has roughly 2 GB of live memory to work with.

### Background

A bash loop wrote a timestamp every second while Chrome went to the home
screen:

- **30 s in the background:** it kept running, slower (a tick every ~2.6 s
  instead of ~2.0 s). No freeze, no reload.
- **5 minutes in the background:** it ran for about a minute, then froze for
  the rest (a 242 s gap). It resumed the moment Chrome came back, with no
  reload and no lost state.

### Android System WebView, Custom Tabs, GeckoView

- **Android System WebView** (151, a scratch APK built with the SDK's
  command-line tools): never cross-origin isolated. COOP + COEP from a loopback
  server, from `shouldInterceptRequest` on `appassets.androidplatform.net`, and
  DIP all give `crossOriginIsolated: false` and no SAB, and posting a shared
  `WebAssembly.Memory` to a worker throws. SLICC still boots there as a leader
  and `ipk install` works, but the wasm realm refuses to start ("needs
  SharedArrayBuffer, which this page lacks"). This matches
  [crbug 40914606](https://issues.chromium.org/issues/40914606) (Won't Fix).
- **Chrome Custom Tab** (opened with the Custom Tabs session extra, so
  `CustomTabActivity`): same as Chrome: isolated, SAB, threads and service
  workers. A Trusted Web Activity is the same activity with the URL bar hidden
  once the origin's Digital Asset Links verify, so the in-app Android route is
  a TWA around the hosted leader.
- **GeckoView**, measured through Firefox 157 for Android, which is built on
  it: isolated with COOP + COEP (not with DIP), SAB, threads, service workers,
  OPFS, Memory64 and JSPI all present; the scalar wasm loop is ~1.7× slower than
  Chrome's (664 ms vs 384 ms). SLICC boots there, coreutils and bash with fork
  run, but **file rename still fails** (blocker 2, above).

## Routes

| Route                                     | Verdict                                                                                                                                                                                                                                 |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **iOS `WKWebView` in `packages/ios-app`** | Most realistic. Same kernel, JIT included. Serve the webapp from an in-app loopback server with COOP/COEP (proven), or a scheme handler plus the SAB polyfill (proven).                                                                 |
| iOS Safari                                | Works once the leader origin sends COOP + COEP `require-corp` for WebKit, plus blockers 2–3.                                                                                                                                            |
| Android Chrome / Trusted Web Activity     | **Works today**, measured: the hosted leader is isolated as deployed (DIP), and bash, git, Python, rustc and zig run. Memory is the limit: ~2 GB live on a 3.6 GB phone. The kernel freezes after ~1 min in the background and resumes. |
| Android System WebView                    | Blocked, measured: never cross-origin isolated, so no wasm realm ([crbug 40914606](https://issues.chromium.org/issues/40914606), Won't Fix). Use a Trusted Web Activity.                                                                |
| GeckoView (Firefox for Android)           | Isolated with COOP/COEP (not DIP); runs bash with fork. Needs a non-stack-trace fix for file rename first.                                                                                                                              |
| Native wasm runtimes                      | Not recommended (below).                                                                                                                                                                                                                |

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
4. **Android:** done (above). Chrome needs nothing new; a TWA is the in-app
   route.
5. **Firefox / GeckoView rename:** decide whether Firefox matters enough for a
   ZenFS fix that doesn't read stack traces.

Blockers 2 (rename) and 3 (memory maximum) were plain bugs and are fixed in
#3785 and #3782, independently of these decisions.
