# Synchronous FS in browser realms — design proposal

> **Status: DRAFT for review.** The core mechanism (the platform primitive)
> is **validated** — by a standalone micro-repro _and_ an in-SLICC
> confirmation on the real production substrate (§5). The **per-realm ACL
> path is designed but not yet validated** (the §5b run used the full-VFS
> cone; §11 is the load-bearing security requirement). It is **not yet
> implemented**; the implementation plan will be written separately. Every
> non-obvious claim carries a `file:line`, a grep, or a reproducible
> measurement — see §14.

**Goal:** make synchronous filesystem APIs (`readFileSync`,
`writeFileSync`, `existsSync`, …) in the kernel-worker JS realm **robust
and unbounded** — correct for many/large files and arbitrary
runtime-computed paths, including third-party/ported Node code we cannot
rewrite to async.

**Proposal in one line:** back sync fs with a **synchronous XHR that the
leader's controlling Service Worker intercepts and answers from the live
VFS** — the exact pattern SLICC's `preview-sw` + `preview-vfs` responder
already implement. This needs **no `SharedArrayBuffer`, no COOP/COEP**, no
change to any HTTP header on any route, and works in **every** float. Keep
the existing in-memory snapshot as a zero-cost fast path for the hot
working set.

---

## 1. Problem

Scripts in the kernel-worker JS realm (`node -e`, `.jsh`, `.mjs`,
`workflow`) may call **synchronous** fs APIs. The VFS is OPFS-backed
(async), and realm code runs inside an `AsyncFunction` wrapper, so a sync
call cannot `await`. SLICC emulates sync fs with a bounded, point-in-time
snapshot; that breaks for scripts (often third-party / ported Node code)
that read many/large files or paths not known ahead of time.

## 2. Current implementation (verified)

- **Snapshot-and-flush.** One `vfs.snapshot` RPC pre-loads files into an
  in-memory tree; sync APIs read/write that tree; mutations diff+flush
  back after. Code: `sync-fs-cache.ts` (whole file), `js-realm-shared.ts:94-108`
  (snapshot → `SyncFsCache`), `:316-327` (flush), `:441-489`
  (flush-before / re-snapshot-after each `exec`).
- **Caps.** `realm-host.ts:378-380` → **500 files, 1 MB/file, 10 MB
  total**. Over-cap files are kept as `truncated:true` so
  `existsSync`/`statSync` work, but `readFileSync` throws `ENOSYNC`
  (`sync-fs-cache.ts:76`).
- **`.mjs` already gets the sync shim.** ESM entries are transpiled to CJS
  and run through the same `require` graph (`js-realm-shared.ts:262`).
- **A real sync OPFS API exists but is Pyodide-only + buffered.**
  `opfs-sync-fs.ts` uses `FileSystemSyncAccessHandle`, wired into Pyodide,
  currently a buffered preload-then-flush provider; the true per-call SAH
  pool is deferred on cross-worker leasing (`opfs-sync-fs.ts:1-37`).

## 3. The primitive

`readFileSync` must return bytes **without yielding the event loop**. Three
primitives can produce bytes synchronously in a Worker:

1. **`FileSystemSyncAccessHandle.read()`** — sync I/O, but acquiring the
   handle is async + exclusive-locked; can't serve an arbitrary un-opened
   path mid-call without a blocking primitive to coordinate acquisition.
2. **`Atomics.wait()` on a `SharedArrayBuffer`** — blocks mid-call on an
   arbitrary path, but requires the document to be `crossOriginIsolated`
   (COOP + COEP), which has cross-float blast radius and cannot be applied
   to nested-iframe leaders.
3. **Synchronous `XMLHttpRequest` intercepted by a Service Worker** — sync
   XHR is permitted in Workers; if the controlling SW answers it via
   `respondWith(promise)`, the calling worker blocks until the SW (on its
   own thread) resolves the response. Arbitrary path, unbounded size, live
   view, and **no `SharedArrayBuffer` / COOP / COEP**.

**We choose #3.** It uniquely combines "unbounded + arbitrary + live" with
"no isolation," and SLICC already ships the substrate for it (§6).

## 4. Design — Approach D

A sync fs call in the realm issues a synchronous same-origin XHR to a
VFS-serving route; the leader's **controlling Service Worker** intercepts
it and answers from the **live VFS** via the existing page-side responder.

- **Read:** `readFileSync(p)` → sync `GET /…vfs…/<p>` → SW → responder →
  live `VirtualFS` → bytes → returned synchronously.
- **Write:** `writeFileSync(p, data)` → sync XHR `POST` with the body → SW
  → responder → live `VirtualFS.writeFile`. (The responder is read-only
  today — see §12.)
- **Binary:** use `responseType='arraybuffer'` — supported for sync XHR
  **in Workers** (the main-thread restriction does not apply).
- **Fast path (kept):** serve from the in-memory snapshot on a hit — zero
  round-trip, identical to today. The SW bridge handles misses, over-cap
  files, and cases needing live coherence.

### Why there is no deadlock

The realm worker blocks on the sync XHR, but the **VFS owner is the kernel
worker** (or the page), a _different_ thread that stays free to service the
responder read. The blocked worker is never the responder. **Rule: sync fs
must run in the realm worker (nested), never in the VFS-owning kernel
worker** — which is exactly where `readFileSync` runs. (Empirically
confirmed: §5.)

### Coherence, ACLs, and error semantics (committed decisions)

These were "open questions" in the first draft; the design now commits to
them because they set the module boundaries the plan depends on.

- **Single source of truth = the calling realm's `ctx.fs`.** The bridge
  responder MUST answer from the realm's own filesystem handle — the same
  `ctx.fs` the async `vfs` RPC and the snapshot/flush already use
  (`realm-host.ts` `dispatchVfs`: every op is `ctx.fs.readFile` /
  `ctx.fs.writeFile` / …) — **NOT** the shared page-side preview reader
  (`preview-vfs-responder.ts`'s `getReader()`), which serves the _global_
  live VFS with no per-realm scoping. `ctx.fs` is the realm's `RestrictedFS`
  (wrapped by the sudo-fs `Proxy` for scoops), so routing through it is what
  preserves scoop path-ACLs **and** sudo approval gating. **The §5b
  validation ran in the cone (full VFS), so it never exercised a restricted
  scoop realm — the ACL boundary is invisible in that result and must be
  designed in, not assumed.** See §11.
- **Read-after-write is trivially coherent** because reads and writes hit the
  one `ctx.fs` source: `writeFileSync(p)` then `readFileSync(p)` in the same
  script returns the written bytes with no flush/re-snapshot round-trip.
- **The snapshot degrades to an optional read-through cache**, invalidated on
  any bridge write to a cached path. It stays a zero-cost fast path for the
  hot working set; the bridge is authoritative on miss / over-cap /
  after-write. With writes going write-through to `ctx.fs`, most of today's
  flush-before-exec / re-snapshot-after-exec machinery
  (`js-realm-shared.ts:441-489`) can retire — the plan keeps only whatever
  thin coherence is still needed at the exec↔sync-fs boundary (a subprocess
  the realm `exec`s writes through the same `ctx.fs`, so the cache must be
  invalidated across an `exec`, not the full diff/flush dance). **External
  writers** — another scoop, the agent's async file tools, or any async
  `vfs` op — can also stale a cached path. The plan must either wire the
  cache eviction to `FsWatcher` / `invalidatePaths` (bust affected paths on
  external mutation) or **explicitly document** that cross-writer coherence
  stays exec-boundary-only, which matches today's snapshot semantics (the
  snapshot is only refreshed at boot + after each `exec`); it must not
  silently regress to serving stale bytes with a live bridge available.
- **POSIX errno fidelity.** Node-ported code branches on `err.code`
  (`ENOENT`, `EACCES`, `EISDIR`, `ENOTDIR`, `ENOSYNC`). The bridge MUST carry
  the errno across the HTTP boundary (HTTP status **plus** an explicit
  `x-slicc-fs-errno` header or structured error body) and the realm shim MUST
  reconstruct an `Error` with the matching `.code`. A bare `404 → throw`
  loses the contract that ported code relies on. `sync-fs-cache.ts` already
  models `ENOENT` / `ENOSYNC`; the bridge extends that mapping rather than
  inventing a new one.

## 5. Validation (this is the load-bearing section)

### 5a. Standalone micro-repro (isolates the platform primitive)

A minimal page + SW + top-level worker + **nested** worker; the workers do
sync XHR that the SW answers (both in-SW and via a `BroadcastChannel`
page-responder round-trip). Headless Chrome for Testing. Measured:

| Context                            | Intercepted | Content OK | small read (in-SW) | small read (relay) | 5 MB read |
| ---------------------------------- | ----------- | ---------- | ------------------ | ------------------ | --------- |
| Top-level worker                   | ✅          | ✅         | 0.24 ms            | 0.27 ms            | 17.9 ms   |
| **Nested worker** (realm analogue) | ✅          | ✅         | 0.20 ms            | 0.24 ms            | 15.3 ms   |

Proves: sync XHR → SW blocks-and-returns correct bytes; **interception
reaches a nested worker**; the responder round-trip is nearly free;
unbounded size works.

### 5b. In-SLICC confirmation (real production substrate, zero code change)

A standalone SLICC leader; wrote `/workspace/synctest.txt` =
`SYNC-FS-CONFIRM-42`; then, from a **live realm** (`node -e`, a nested
realm worker), ran a synchronous XHR to `/preview/workspace/synctest.txt`:

```
{"status":200,"servedBy":null,"len":19,"head":"SYNC-FS-CONFIRM-42\n","confirmed":true,"perCallMs":0.915,"iters":200}
```

Proves, end-to-end on the shipped stack:

- The realm has `XMLHttpRequest` + `atob` (both `function`).
- The realm's sync XHR **is intercepted by SLICC's actual controlling SW**
  (`llm-proxy-sw` @ `/`, which `importScripts`'d `preview-sw`) and answered
  from the **live worker-owned VFS** (the returned bytes are the exact file
  content; SPA-fallback/404 would not contain the marker).
- **No deadlock** — the realm worker blocked while the kernel worker
  serviced the read.
- **~0.92 ms/call** over 200 iterations on the _full_ real path (realm →
  SW → `BroadcastChannel` → page responder → `RemoteVfsClient` →
  kernel-worker VFS → back) — the extra page→kernel hop over the
  micro-repro's 0.25 ms.

**Caveat — scope of this proof.** The run used the **cone** (full VFS) and
the existing `/preview/` reader. It validates the _platform primitive_ (sync
XHR → controlling SW → live worker-owned VFS, no deadlock, correct bytes,
unbounded size) — but **not** the per-realm ACL path. A restricted scoop
realm must resolve to its own `ctx.fs` (`RestrictedFS` + sudo-fs), which is a
design requirement (§4, §11) the shipped route adds and §12/§13 must test;
it is not something this zero-code-change confirmation could exercise.

## 6. Architecture fit (why this is small)

- **One controlling SW.** `llm-proxy-sw.js` is registered at scope `/`
  (`setup-sw-registration.ts:90`) and is THE controller for the leader page
  and all its (nested) workers. `preview-sw.js` is registered at `/preview/`
  (`:85`), and `llm-proxy-sw` **`importScripts('/preview-sw.js')`** so the
  controller handles `/preview/*` directly (`llm-proxy-sw.ts:90-104`).
- **Live-VFS responder already exists.** `/preview/*` reads go through the
  page-side `preview-vfs` `BroadcastChannel` responder, which serves the
  **live** OPFS-backed `VirtualFS` (`preview-sw.ts:12-13,63-71`;
  `preview-vfs-responder.ts` — `preview-vfs-read`, and `RemoteVfsClient`
  for the worker-owned-VFS topology, `:13`).

So the implementation is: add a **dedicated sync-fs route + handler** into
the controlling SW (parallel to the imported preview handler), extend the
responder with a **write** op, and route the realm's sync fs calls through
sync XHR. No new SW registration, no header changes, no isolation.

## 7. Float coverage (universal)

SW control requires only that the leader origin can register a Service
Worker — **not** top-level context or isolation. So a cross-origin
nested-iframe leader (Electron overlay in a host app) is controlled by its
_own_ origin's SW just like a top-level tab. Therefore Approach D covers
**every** float where realms run, including the ones Approach A (SAB) could
not isolate:

| Float                                            | Runs realms? | Approach D works?                  |
| ------------------------------------------------ | ------------ | ---------------------------------- |
| Standalone browser                               | ✅ leader    | ✅                                 |
| Chrome extension (hosted leader tab)             | ✅ leader    | ✅                                 |
| Cloud (hosted-leader)                            | ✅ leader    | ✅                                 |
| Sliccstart (drives a `--lead` browser leader)    | ✅ leader    | ✅                                 |
| Electron float / attach (leader in spoon iframe) | ✅ leader    | ✅ (SW control needs no isolation) |
| Cherry / spoon / Electron **followers**          | ❌ no kernel | N/A (no realms)                    |

Followers never run realms, so they're out of scope by construction (boot
map: `main.ts:5-9` — `mountWcUiLive` = leader/kernel; `mountWcUiFollower`
= no kernel). Caveat to confirm: SW/storage **partitioning** for a leader
nested cross-origin in a third-party app (affects where OPFS persists, not
whether interception fires) — §12.

## 8. Latency & when SAB would ever be needed

~0.92 ms/call on the real multi-hop path. With the snapshot fast-path
serving the hot working set at ~0 cost and the SW bridge only for
misses/large/over-cap, this is comfortable for realistic workloads (1 000
cold reads ≈ 0.9 s). A pathological hot loop of tens of thousands of tiny
uncached reads is the only regime where the per-call cost matters;
mitigations, in order: (a) keep/enlarge the snapshot fast path; (b) a more
direct SW→kernel-worker channel (skip the page hop); (c) batching. Only if
those are insufficient would **Approach A (SAB)** be worth its isolation
cost — it is documented below as a _future perf lever_, not a requirement.

## 9. Alternatives considered

- **A — leader cross-origin isolation + `Atomics`/SAB bridge.** Lower
  per-call latency (shared memory), but requires `COOP: same-origin` +
  `COEP: credentialless` on the leader document, cannot serve
  nested-iframe (Electron) leaders, and carries cross-float blast-radius
  analysis. **Demoted to a future optimization** if §8's mitigations prove
  insufficient.
- **B — real `FileSystemSyncAccessHandle` pool + cross-worker leasing.**
  Still needs a blocking primitive to acquire a handle mid-call, plus
  leader-election so the page VFS and N realm workers don't deadlock on
  exclusive locks. More moving parts; better fit for the Pyodide side.
- **C — declared working set, no isolation.** Drop the blanket cap for
  targeted preloading; ships fast and stays useful as the fast-path
  preloader, but cannot serve a runtime-computed path in un-editable code.

## 10. Components (proposed)

- **Controlling SW** (`llm-proxy-sw.ts` + a new sibling of
  `preview-sw-handler.ts`): a **dedicated** `/__slicc/fs-sync/*` route (read
  via GET, write via POST). This is **not** the `/preview/*` handler and MUST
  NOT inherit its transforms — no directory→`index.html` resolution, no
  Mode-2 `projectRoot` rewriting, no content-type guessing, and none of
  `preview-security.ts`'s `isPathWithinServedRoot` traversal-rejection (a
  legitimate absolute VFS path the realm's ACL allows must not be refused by
  a preview-only rule). It returns **exact path → raw bytes**, maps errors to
  `x-slicc-fs-errno`, and reuses only the imported-handler _mechanism_ (the
  §5b validation reused `/preview/` merely as a stand-in to prove the
  primitive; the shipped route is separate). **`llm-proxy-sw` deliberately
  ignores same-origin fetches** (`llm-proxy-sw.ts:156`
  `if (url.origin === self.location.origin) return;` — it only `respondWith`s
  _cross-origin_ traffic), so sync-fs needs its **own** fetch listener that
  matches `/__slicc/fs-sync/*` and always `respondWith`s (the same way the
  `importScripts`'d preview handler is a separate listener). There is no
  conflict — first `respondWith` wins — but the interception must be added
  explicitly; it does not come "for free" from the `/`-scoped controller.
- **Realm-scoped responder** (new module, e.g. `sync-fs-responder.ts` — NOT
  an extension of the shared `preview-vfs-responder.ts`): answers reads and
  writes from the **calling realm's `ctx`**, resolved by a **per-realm
  capability token** the request carries. The token relays SW → page → the
  **kernel `realm-host` instance for that token**, and is answered by that
  instance's existing `dispatchVfs` on its own `ctx` — i.e. `ctx.fs.*` with
  `ctx.fs.resolvePath(ctx.cwd, …)`. It must therefore bind **`{ fs, cwd }`**,
  not just the fs handle: `dispatchVfs` resolves every path against
  `ctx.cwd` (`realm-host.ts`), so a relative `readFileSync('foo')` in a scoop
  whose `cwd` is `/scoops/x/` needs the cwd or it hits the wrong path /
  `ENOENT`. Route through the realm-host dispatch, **never** through
  `RemoteVfsClient` / `VfsRpcHost` / the shared preview reader — those have
  no per-realm scope and would recreate the §11 escalation or send
  concurrent realms to the wrong `ctx`. This is the mechanism that keeps
  `RestrictedFS` + sudo-fs enforcement on the sync path (§11). The token is
  minted when `attachRealmHost` wires the realm's `ctx`, revoked on realm
  `dispose()`, and unguessable so one realm cannot forge another's scope.
- **Realm sync-fs layer**: to satisfy **#1488** (the 2,128-line
  `js-realm-shared.ts` is already flagged for bloat), land the bridge as its
  **own module** (e.g. `sync-fs-bridge.ts`) rather than growing
  `js-realm-shared.ts`; `sync-fs-cache.ts` keeps the snapshot as the
  optional read-through cache. On miss / over-cap / after a write, route
  through sync XHR (`responseType='arraybuffer'` for binary); if the SW is
  not yet controlling at boot, fall back to today's snapshot / `ENOSYNC`.

## 11. Security note

The realm's `XMLHttpRequest` is a raw global that bypasses
`createProxiedFetch` (the secret-masking proxy). This is acceptable _only_
because the sync-fs route is **same-origin and VFS-scoped** — a raw XHR
from the realm can reach same-origin SW routes but not arbitrary
cross-origin endpoints (CORS-blocked), and the VFS is already within the
realm's sandboxed FS access. The sync-fs route MUST stay a VFS
read/write surface (never a general fetch proxy).

**The ACL boundary is the highest-risk part of the design, and the §5b
validation did not exercise it** (it ran in the cone, which has the full
VFS). A scoop realm's async fs goes through `ctx.fs` — a `RestrictedFS`
wrapped in the sudo-fs `Proxy` — so it is path-ACL'd and sudo-gated
(`realm-host.ts` `dispatchVfs` → `ctx.fs.*`). The shared preview responder
serves the **global** live VFS via `getReader()` with **no** per-realm
scope; backing sync-fs with it would let a restricted scoop realm read and
write **outside its sandbox and skip sudo approval entirely** — a real
privilege escalation. Therefore:

- Sync-fs reads/writes MUST resolve to the **calling realm's `ctx.fs`**, via
  the per-realm capability token in §10 — never the global reader.
- Writes go through the same `ctx.fs.writeFile` the async path uses, so
  `RestrictedFS` path checks and sudo-fs approval prompts fire identically.
- The capability token MUST be unguessable and bound to one realm's lifetime
  (minted at `attachRealmHost`, revoked on realm dispose) so one realm can't
  forge another's scope.

**Sudo under a _synchronous_ write.** A sudo-gated `writeFileSync` blocks the
**realm worker** on the sync XHR while the kernel's `ctx.fs` awaits the async
sudo broker (`createPanelRpcSudoBroker` / `createConeApprovalBroker` →
page modal). There is no dependency cycle — the broker resolves against the
_human at the page_, not the blocked realm worker — and the page's sync-fs
responder handler is an ordinary pending promise, so it does not block the
page event loop from showing the modal. But this is a reentrant path (page
servicing a sync-fs request _and_ a sudo prompt on the same panel-RPC
channel), so it MUST be integration-tested, and the responder MUST
**fail closed** — return `EACCES` to the blocked realm — if the broker is
unavailable or times out, rather than leaving the realm worker hung forever
on the sync XHR.

## 12. Risks & open questions

**Decided at the design level (were open in the first draft):** the
coherence model (single `ctx.fs` source of truth, snapshot as optional
read-through cache, trivial read-after-write) and the ACL model (per-realm
capability token → the realm's `RestrictedFS` + sudo-fs; never the global
preview reader) are committed in §4 and §11. The items below are what still
has to be **validated during implementation**, not redesigned.

1. **Write path + read-after-write coherence** — implement the write op on
   the realm-scoped responder (§10) and add a regression test proving a sync
   write is visible to a subsequent sync read **and** that a restricted
   scoop realm's sync write to a path outside its ACL is denied exactly as
   the async path denies it (the escalation guard from §11).
2. **Binary via `responseType='arraybuffer'`** in a sync XHR in the realm
   worker — confirm in situ (the confirmation used `responseText`).
3. **SW-not-controlling-at-boot** — first load before `clients.claim()`
   takes effect; define the fallback (snapshot / async) until controlled.
4. **Storage/SW partitioning** for a leader nested cross-origin in a
   third-party app (Electron attach) — confirm interception still fires
   (expected yes; partitioning affects persistence location, not control).
5. **Sync XHR longevity** — supported in Workers today (ZenFS/BrowserFS
   rely on it); note as a dependency in case of future deprecation.
6. **Sudo under a synchronous write** — the reentrant page-services-sync-fs +
   sudo-prompt path (§11): integration-test allow/deny, and verify the
   fail-closed `EACCES` (never a hung realm worker) when the broker times
   out / is unavailable.
7. **External-writer cache coherence** — decide `FsWatcher`/`invalidatePaths`
   eviction vs. documented exec-boundary-only coherence (§4); either way,
   never serve stale bytes when the live bridge could answer.

## 13. Testing (outline)

**Phase-1 acceptance gates (must pass before the feature ships, not §13
"nice-to-haves").** Because the ACL/sudo boundary is the highest-risk part
and was unvalidated by §5b, these are gating:

1. A `RestrictedFS`-scoped scoop realm sync-read **and** sync-write to a path
   outside its sandbox is denied exactly as the async path denies it (no
   global-VFS escape).
2. A sudo-gated sync write triggers the same approval prompt; deny → the
   documented errno; broker-unavailable → fail-closed `EACCES`, never a hang.
3. Two concurrent realms with different tokens each resolve to their own
   `ctx` — one realm's token cannot read/write through another's scope; an
   unknown/expired/forged token is rejected.

- Unit: route/handler read+write, realm-scoped responder read+write op,
  errno mapping (`ENOENT`/`EACCES`/`EISDIR` → `x-slicc-fs-errno` → `.code`
  on the thrown `Error`), snapshot fast-path/fallback selection,
  boot-not-controlled fallback, capability-token→`ctx.fs` resolution
  (and rejection of an unknown/expired token).
- Integration: realm script reading >10 MB and >500 files synchronously
  (bridge path); read-after-sync-write. **Escalation guard:** a
  `RestrictedFS`-scoped scoop realm sync-reading/-writing a path outside its
  sandbox is denied exactly as the async path denies it, and a sudo-gated
  write triggers the same approval prompt.
- Regression: existing snapshot tests green with the bridge absent and
  present.
- Cross-float smoke: confirm a realm sync read works in extension
  (hosted leader tab) and, if feasible, an Electron-attach leader.

## 14. How to verify

**Static (greps):**

```
sed -n '85,104p' packages/webapp/src/ui/boot/setup-sw-registration.ts    # SW scopes
sed -n '90,104p' packages/webapp/src/ui/llm-proxy-sw.ts                   # controller importScripts preview-sw
sed -n '1,20p;60,71p' packages/webapp/src/ui/preview-sw.ts               # live-VFS responder path
sed -n '378,381p' packages/webapp/src/kernel/realm/realm-host.ts         # caps
```

**Micro-repro (platform primitive + latency):** a page + `sw.js`
(intercept `/vfs-*`, answer in-SW and via a `BroadcastChannel` page
responder) + `worker.js` + `nested-worker.js` doing sync XHR in a loop;
serve over `localhost`, load in Chrome, read the measurements. (Table §5a.)

**In-SLICC (real substrate, zero code change):** run a standalone leader;
`echo SYNC-FS-CONFIRM-42 > /workspace/synctest.txt`; from a realm run a
synchronous XHR to `/preview/workspace/synctest.txt` and assert the
response body equals the file content. (Result §5b.)
