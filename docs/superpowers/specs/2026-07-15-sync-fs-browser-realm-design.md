# Synchronous FS in browser realms — design proposal

> **Status: DRAFT for review.** The core mechanism is **validated** — by a
> standalone micro-repro _and_ an in-SLICC confirmation on the real
> production substrate (§5). It is **not yet implemented**; the
> implementation plan will be written separately. Every non-obvious claim
> carries a `file:line`, a grep, or a reproducible measurement — see §14.

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
  `preview-sw-handler.ts`): a `/…vfs-sync…/*` route (read via GET, write
  via POST) answered from the responder. Reuse the imported-handler pattern.
- **Responder** (`preview-vfs-responder.ts`): add a `preview-vfs-write`
  (or a distinct sync-fs) op alongside the existing read; both hit the live
  `VirtualFS` / `RemoteVfsClient`.
- **Realm sync-fs layer** (`sync-fs-cache.ts` + `js-realm-shared.ts`): keep
  the snapshot as fast path; on miss/over-cap route through sync XHR
  (`responseType='arraybuffer'` for binary); if the SW is not yet
  controlling at boot, fall back to today's snapshot/`ENOSYNC`.

## 11. Security note

The realm's `XMLHttpRequest` is a raw global that bypasses
`createProxiedFetch` (the secret-masking proxy). This is acceptable _only_
because the sync-fs route is **same-origin and VFS-scoped** — a raw XHR
from the realm can reach same-origin SW routes but not arbitrary
cross-origin endpoints (CORS-blocked), and the VFS is already within the
realm's sandboxed FS access. The sync-fs route MUST stay a VFS
read/write surface (never a general fetch proxy), and writes must honor
the same path ACLs (`RestrictedFS`) the async path enforces.

## 12. Risks & open questions

1. **Write path + read-after-write coherence** — the responder is
   read-only today; add a write op and verify a sync write is visible to a
   subsequent sync read (and that ACLs apply).
2. **Binary via `responseType='arraybuffer'`** in a sync XHR in the realm
   worker — confirm in situ (the confirmation used `responseText`).
3. **SW-not-controlling-at-boot** — first load before `clients.claim()`
   takes effect; define the fallback (snapshot / async) until controlled.
4. **Storage/SW partitioning** for a leader nested cross-origin in a
   third-party app (Electron attach) — confirm interception still fires
   (expected yes; partitioning affects persistence location, not control).
5. **Sync XHR longevity** — supported in Workers today (ZenFS/BrowserFS
   rely on it); note as a dependency in case of future deprecation.

## 13. Testing (outline)

- Unit: route/handler read+write, responder write op, snapshot
  fast-path/fallback selection, boot-not-controlled fallback.
- Integration: realm script reading >10 MB and >500 files synchronously
  (bridge path); read-after-sync-write; ACL enforcement on sync write.
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
