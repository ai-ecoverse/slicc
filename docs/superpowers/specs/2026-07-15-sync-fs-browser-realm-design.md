# Synchronous FS in browser realms — design proposal

> **Status: DRAFT for review.** This is a design *proposal* plus the
> investigation that backs it. It has not been approved or implemented.
> The gating validation (a COEP spike, §9) is not yet done. Every
> non-obvious claim carries a `file:line` or a grep so reviewers can
> verify it independently — see §10.

**Goal:** make synchronous filesystem APIs (`readFileSync`,
`writeFileSync`, `existsSync`, …) in the kernel-worker JS realm **robust
and unbounded** — correct for many/large files and arbitrary
runtime-computed paths, including third-party/ported Node code we cannot
rewrite to async.

**One-line proposal:** cross-origin-isolate the *leader document only*
(`COOP: same-origin` + `COEP: credentialless`) so its kernel worker gets
`SharedArrayBuffer`, and back sync fs with an `Atomics.wait` bridge over
the existing async VFS; keep the current snapshot as a fast path and as
the graceful fallback where isolation is unavailable.

---

## 1. Problem

Scripts in the kernel-worker JS realm (`node -e`, `.jsh`, `.mjs`,
`workflow`) may call **synchronous** fs APIs. The VFS is backed by OPFS,
whose real API is async, and realm code runs inside an `AsyncFunction`
wrapper — a sync call cannot `await`. SLICC therefore *emulates* sync fs
with a bounded, point-in-time snapshot. That breaks down for scripts
(often third-party or ported Node code) that read many/large files or
paths not known ahead of time.

## 2. Current implementation (verified)

- **Snapshot-and-flush.** Before a script runs, one `vfs.snapshot` RPC
  loads files into an in-memory tree; sync APIs read/write that tree;
  mutations are diffed and flushed back after. Code: `sync-fs-cache.ts`
  (whole file), `js-realm-shared.ts:94-108` (snapshot → `SyncFsCache`),
  `:316-327` (flush), `:441-489` (flush-before / re-snapshot-after each
  `exec`, for coherence with subprocesses).
- **Caps.** `realm-host.ts:378-380` → **500 files, 1 MB/file, 10 MB
  total**. Over-cap files are retained as `truncated:true` so
  `existsSync`/`statSync` still work, but `readFileSync` throws a clear
  `ENOSYNC` rather than returning wrong/empty bytes (`realm-host.ts:414-445`,
  `sync-fs-cache.ts:76`).
- **`.mjs` already gets the sync shim.** ESM entries are transpiled to
  CJS and run through the same `require` graph, with async + sync fs
  methods merged onto one bridge (`js-realm-shared.ts:262`, `:939`).
- **A real sync OPFS API exists but is not usable for this yet.**
  `opfs-sync-fs.ts` uses `FileSystemSyncAccessHandle` (SAH), but (a) it is
  wired into **Pyodide only** and (b) it is a **buffered
  preload-then-flush** provider — the true per-call SAH pool is explicitly
  deferred "once cross-worker leasing is firmed up (leader-election +
  ZenFS SAH coordination)" (`opfs-sync-fs.ts:1-37`). So both realms today
  share the same shape: prewalk/snapshot → in-memory → deferred flush.

## 3. The fundamental constraint (first principles)

`readFileSync` must return bytes **without yielding the event loop**. In a
Worker, only two primitives produce bytes synchronously without having
pre-cached them:

1. **`FileSystemSyncAccessHandle.read()`** — synchronous I/O, but
   *acquiring* the handle is **async and exclusive-locked**. It cannot
   serve an arbitrary un-opened path mid-call without a blocking primitive
   to coordinate acquisition (→ #2), or it degrades to bounded prewalk.
2. **`Atomics.wait()` on a `SharedArrayBuffer`** — the only primitive that
   can block mid-call on an arbitrary path. Requires the document to be
   **`crossOriginIsolated`** (COOP + COEP).

Everything else is caching, which is inherently bounded and/or
point-in-time. **Therefore: unbounded + arbitrary + live sync ⇒
Atomics/SAB ⇒ the leader document must be cross-origin isolated.** There is
no third option in current browsers.

## 4. Proposed design — Approach A

Set `COOP: same-origin` + `COEP: credentialless` on the **leader document
only**, so the leader tab and its kernel worker become
`crossOriginIsolated` and gain `SharedArrayBuffer`. Then:

- **Fast path (unchanged):** sync APIs read/write the in-memory snapshot
  when the path is present and within budget — zero round-trip, identical
  to today for the common small working set.
- **Bridge path (new):** on a miss / over-cap / when live coherence is
  required, the sync API posts a request over a SAB control channel to an
  I/O worker (or the kernel host), which performs the ordinary **async**
  VFS read and streams bytes back through a fixed-size SAB data window in
  chunks while the realm worker sits in `Atomics.wait`. Unbounded (chunked),
  live, arbitrary path. Writes are symmetric.
- **Capability gating (critical):** the sync-fs layer feature-detects
  `globalThis.crossOriginIsolated && typeof SharedArrayBuffer !== 'undefined'`.
  Present → bridge available; absent → today's bounded snapshot with
  `ENOSYNC`. The feature is **purely additive** — nothing regresses where
  isolation is unavailable.

Backing sync fs with the existing async VFS (not raw SAH) avoids the
exclusive-lock / cross-worker-leasing problem entirely; the SAB gate is
what makes the async read appear synchronous to the caller.

### Alternatives considered
- **B — real SAH pool + cross-worker leasing** (the `opfs-sync-fs.ts`
  "future iteration"). Still needs SAB to acquire a handle mid-call, *plus*
  a leader-election/lease layer so the page VFS and N per-task realm
  workers don't deadlock on exclusive locks. Strictly more moving parts
  than A for a copy-avoidance win; better fit for the Pyodide/Emscripten
  side. Not recommended as the primary JS path.
- **C — declared working set, no isolation.** Drop the blanket cap in
  favor of targeted preloading (shebang/manifest/AST-extracted literal
  paths). Ships fast, zero isolation risk, and stays useful as the
  fast-path preloader — but it *cannot* serve a runtime-computed path in
  un-editable code, so it does not meet the stated goal on its own.

## 5. Cross-float coverage (the key feasibility result)

**Realms/sync-fs only ever run in the leader**, and in every *shipped*
topology the leader is a **top-level browser document**, which is
isolatable. Boot map: `main.ts:5-9` (`standalone` / `electron-overlay` /
`hosted-leader` → `mountWcUiLive` = kernel leader; `follower` / `cherry`
→ `mountWcUiFollower` = **no kernel**).

| Float | Where realms run | Isolatable → SAB? |
|---|---|---|
| Standalone browser | top-level hosted-leader tab | ✅ |
| Chrome extension | top-level pinned `?slicc=leader` tab | ✅ |
| Cloud (hosted-leader) | top-level sandbox tab | ✅ *(unverified — see §9)* |
| Sliccstart | drives a `--lead` browser leader tab | ✅ |
| Cherry / spoon / Electron followers | follower iframe, **no kernel** | N/A (no realms) |
| Packaged Electron float (`about:blank` + overlay iframe) | leader in a spoon iframe | ❌ → snapshot fallback |
| `dev:electron` attach harness | leader in a spoon iframe over 3rd-party doc | ❌ → snapshot fallback |

The two ❌ rows are **not shipped artifacts**: `release-package.ts` has
zero electron references, there is no `electron-builder`/forge config, and
Electron is invoked only via `dev:electron` / `start:electron`. Both
degrade cleanly via the §4 feature-detect (snapshot = today's behavior).
There is a documented escape hatch if the standalone Electron float ever
ships: have `createFloatWindow` load the hosted leader (`OVERLAY_APP_URL`,
which already carries `role=leader` + bridge params) as the **top-level**
document instead of `about:blank` + an overlay iframe, so the worker's
leader-scoped COEP applies (`electron-main.ts:46-51,121-146`;
`electron-runtime.ts:35`).

### Sliccstart → Slack is an attach-as-follower, not the standalone float
Sliccstart launches a **browser with `--lead`** (the leader that runs
realms), probes its tray join URL, then launches the Electron app with
`--electron <app> --join=<leaderJoinUrl>` as a **follower**; Electron rows
are gated on a live browser leader. Code:
`SliccProcess.swift:11-12,118-124,203-207,300-311,331`. So "SLICC in
Slack" runs sync-fs in the **isolatable browser leader**; Slack runs no
realms.

**Bottom line:** every shipped path that executes realms does so in a
top-level browser leader → SAB-unbounded-sync is available everywhere
sync-fs actually runs; all injected/follower surfaces are out of scope by
construction; the only non-isolatable leaders are dev-only and degrade to
today's snapshot.

## 6. Cross-origin isolation blast radius

**6a. Scoped to the leader document.** The worker sets COOP/COEP
**per-route**, only on the `?slicc=leader` response, leaving `?cherry=1`,
sprinkle/preview, `?connect=1`, `/cloud`, and spoon-embedded surfaces
untouched. The worker already branches per-query — it sets
`frame-ancestors` specifically for `?cherry=1` (`index.ts:67-75`) — so
this scoping is a proven pattern, not new machinery.

**6b. Auth / networking is not broken.** COEP governs how a document
*embeds cross-origin subresources*, not the ability to make `fetch()` /
CORS requests; `credentialless` only forces `credentials: omit` on
**no-cors** cross-origin requests — CORS-mode fetches are exempt.
- SLICC has **zero** `mode:'no-cors'` and **zero** `credentials:'include'`
  in `packages/webapp/src` (grep) — nothing for credentialless to strip.
- git/curl → `createProxiedFetch` → `/api/fetch-proxy` (a CORS fetch with
  an `X-Bridge-Token` header) or a `chrome.runtime.connect` Port (not
  HTTP); the real authed call happens **server-side in the proxy**
  (`proxied-fetch.ts`).
- LLM/IMS calls are CORS fetches with `Authorization: Bearer` *headers*
  (not cookies), exempt (`adobe.ts:144,213,1061`).
- WebSockets (CDP bridge, tray, `/licks-ws`) are outside COEP entirely.
- OAuth popups: strict COOP severs `window.opener`, but SLICC's OAuth
  already races postMessage with an opener-independent `/api/oauth-result`
  poll (`oauth-service.ts:218-221`).
- **Rule of thumb:** a cross-origin CORS fetch that works today keeps
  working; COEP only adds requirements to *no-cors subresource embeds*
  (public CDN WASM/fonts/images), which under credentialless simply load
  without cookies.

**6c. Sprinkles / dips / cherry / spoon.** Sprinkles/dips render as
same-origin `srcdoc`+`sandbox` iframes (`sprinkle-renderer.ts:585-589`);
under the leader's COEP they inherit and render normally. The only change
is that cross-origin subresources *inside* a sprinkle become credentialless
(public assets fine; cookie-authed stripped — narrow, expected ~never).
In the **extension/cherry** path, sprinkles/dips render in the `?cherry=1`
follower, which we do **not** COEP → completely unaffected. Cherry and
spoon are cross-origin iframes embedded in third-party pages; keeping them
un-COEP'd preserves embedding anywhere, and they run no realms so they
never needed SAB.

## 7. Components (proposed)

- **Worker header layer** (`packages/cloudflare-worker/src/`): emit
  `COOP: same-origin` + `COEP: credentialless` on the `?slicc=leader`
  document response (and the `/electron?...role=leader` response if the
  Electron escape hatch is later taken); leave all other routes untouched.
- **SAB sync bridge** (`packages/webapp/src/kernel/realm/`): a fixed-size
  control + data SAB, an I/O worker (or reuse of the kernel host) that
  services read/write/stat requests against the async VFS, and a chunked
  transfer protocol for files larger than the SAB window.
- **Sync-fs layer** (`sync-fs-cache.ts` + `js-realm-shared.ts`): keep the
  snapshot as the fast path; on miss/over-cap, route through the SAB
  bridge when `crossOriginIsolated`, else throw `ENOSYNC` (today's
  behavior).

## 8. Testing (outline)

- Unit: SAB chunk protocol (boundary sizes, larger-than-window files,
  zero-byte files, write-back), feature-detect gating, snapshot
  fast-path/fallback selection.
- Integration: a realm script reading a >10 MB file and >500 files
  synchronously under isolation (bridge path) and, with isolation
  disabled, asserting the `ENOSYNC` fallback still holds.
- Regression: existing sync-fs snapshot tests remain green with the bridge
  absent (non-isolated) and present (isolated).
- Cross-float smoke: confirm CDN WASM (`ffmpeg`/`python3`/`convert`),
  sprinkle/dip render, OAuth, git/curl still work with COEP on the leader.

## 9. Risks & open questions (spikes to run before committing)

1. **COEP spike (gating).** Enable `COOP: same-origin` + `COEP:
   credentialless` on `?slicc=leader` and confirm CDN WASM/module loads
   (esm.sh / jsdelivr / HF), sprinkle `srcdoc` iframes, and
   agent-rendered external images still work. This decides whether
   Approach A is viable.
2. Confirm the **cloud** leader is genuinely top-level in its sandbox
   browser.
3. SAB **chunk protocol** for large files, the **write** path, and
   timeout/error semantics (what happens when the I/O worker dies mid-read).
4. Frequency of sprinkles embedding *authed* cross-origin subresources
   (expected ~0; confirm).

## 10. How to verify (quick greps)

```
sed -n '378,445p' packages/webapp/src/kernel/realm/realm-host.ts        # caps + truncation
sed -n '1,37p'   packages/webapp/src/kernel/realm/opfs-sync-fs.ts        # SAH exists, buffered, pyodide-only
grep -rnE "mode: *'no-cors'|credentials: *'include'" packages/webapp/src # → 0 results
sed -n '5,9p;122,124p' packages/webapp/src/ui/main.ts                    # leader vs follower boot
sed -n '11,12p;118,124p;300,311p' packages/swift-launcher/Sliccstart/Models/SliccProcess.swift
grep -rn electron packages/node-server/src/release-package.js            # → 0 (not shipped)
sed -n '67,75p' packages/cloudflare-worker/src/index.ts                  # per-route headers already exist
```
