# Follower Fast-Path — Design

**Date:** 2026-06-23
**Status:** Approved (brainstorming) — pending implementation plan
**Issue:** [#1107](https://github.com/ai-ecoverse/slicc/issues/1107)

## Problem

Opening a tray **join URL** (`https://www.sliccy.ai/join/<trayId>.<token>`) in a
standalone browser gives a poor first-run experience:

1. **~30s with no UI at all** (blank/hang).
2. Then the page renders in **standalone mode** (a local, empty cone) for
   **another ~30s**.
3. Only then does it switch to the **connected follower** view of the leader.

### Root cause (verified)

There is no follower runtime mode / fast-path. A join URL boots the full
standalone runtime, and the follower connection is layered on afterward:

- `resolveUiRuntimeMode()` (`packages/webapp/src/ui/runtime-mode.ts`) recognizes
  only `connect` / `runtime=hosted-leader` / `cherry` / `electron-overlay`; a
  `/join/<token>` URL matches none, so it falls through to **`'standalone'`**.
- `main.ts` routes `standalone` → `mountWcUiLive`
  (`packages/webapp/src/ui/wc/wc-live.ts`), which spawns the **kernel worker**
  unconditionally (`spawnKernelWorker()` at `wc-live.ts:~1343`) — orchestrator +
  cone bootstrap + skills + sudo + `host.ready`.
- The tray-follower WebRTC connection (`page-follower-tray.ts` via
  `wc-tray.ts`) only starts **after** that heavy boot.
- **Plus shared main-level blockers run before *any* dispatch**: `main()`
  awaits `setupSwRegistration()` (`main.ts:87`) and then awaits
  `bootstrapOAuthReplicas()` under a **10s** race (`main.ts:100-106`), before
  the runtime-mode branch at `main.ts:117+`. A follower has no local tokens to
  pre-warm, so this OAuth wait is pure dead time for it.

The two observed phases map to: (1) the WC shell waiting on the kernel-worker
boot (plus the pre-dispatch OAuth bootstrap); (2) the local kernel running and
rendering its own empty cone while the WebRTC connection negotiates and pulls
the first snapshot.

### Cherry pays the same cost

`?cherry=1` (the embedded follower) also routes through `mountWcUiLive` and
**also spawns the kernel worker** (`setup-standalone-prelude.ts` builds the
cherry `BrowserAPI`, then `wc-live.ts` spawns the worker regardless), even
though cherry is already a follower (`wc-tray.ts` `runtimeMode === 'cherry'`
branch calls `startPageFollowerTray`). Cherry never needs a local cone, so it
benefits from the same fast-path.

## What a follower actually needs (verified)

A standalone browser follower's capabilities are **almost entirely page-side**.
The one exception (navigate-lick forwarding) is called out below and is a
deliberate part of this work — everything else needs no kernel worker /
orchestrator / cone:

- **Chat** — `FollowerSyncManager` (`scoops/tray-follower-sync.ts`) implements
  `AgentHandle`; user input forwards to the leader over the WebRTC data channel.
- **Sprinkles** — `SprinkleFollowerController` + `FollowerSyncManager` fetch
  `.shtml` content **from the leader** over the channel and render it page-side
  via `SprinkleRenderer`. It explicitly rejects local-VFS access
  (`sprinkle-follower-controller.ts` stubs `readFile`/`writeFile`/…). State is
  in `localStorage`. **Zero kernel dependency.**
- **Leader-driven CDP / Playwright-in-follower** — rides on the page-side
  `BrowserAPI` + CDP transport, which are constructed in
  `setup-standalone-prelude.ts` **before** the worker is spawned, and only
  _handed_ to the worker afterward. So CDP is independent of the kernel.
  - A node-server-backed `--join` follower (local Chrome + `/cdp` bridge via
    `?bridge=`) has working CDP — preserved, since the prelude runs in the
    fast-path.
  - A plain `www.sliccy.ai` browser-tab follower has **no `/cdp` endpoint**
    (`getDefaultCdpUrl()` → `wss://www.sliccy.ai/cdp`, which does not exist), so
    `listPages()` already fails today and the leader cannot drive it. The
    fast-path loses nothing it currently has.
- **Navigate-lick forwarding (THE EXCEPTION — needs replacement).** A standalone
  follower forwards `navigate` licks (how SLICC handoffs arrive) to the leader.
  Today this depends on the **kernel worker**: `wc-tray.ts:102` toggles
  forwarding via `client.sendSetFollowerForwarding(enabled)`, and the worker
  owns the `LickManager` (`setForwarder` + `FORWARDABLE_TO_LEADER`,
  `lick-manager.ts:106,202`) and the `NavigationWatcher` / `/licks-ws` bridge.
  A no-worker follower has none of that, so navigate-lick forwarding would
  silently stop. **This is in scope:** the follower mount installs a small
  **page-side navigation watcher** that calls
  `FollowerSyncManager.forwardLick(event)` directly (the page already has the
  sync; `wc-tray.ts:357` shows the same `sync.forwardLick(event)` call). No
  worker round-trip needed once the watcher runs on the page.

**Conclusion:** a follower mount that runs the page prelude (BrowserAPI + CDP
connect) + `startPageFollowerTray` + the sprinkle controller + a **page-side
navigate-lick watcher**, but **skips the kernel worker/orchestrator/cone**,
preserves every capability that works today.

## Scope

In scope — two **follower-only** standalone boot modes that currently overpay:

1. **Standalone join** — `/join/<token>` URL, or a stored join URL
   (`localStorage['slicc.trayJoinUrl']`, `TRAY_JOIN_STORAGE_KEY`), in a
   non-extension, non-leader context.
2. **Cherry** (`?cherry=1`) — folded into the same lightweight mount.

Out of scope (confirmed unaffected):

- **Extension follower** — `isExtension` short-circuits `resolveUiRuntimeMode`
  before any follower/cherry check; `main.ts` routes extension →
  `mountWcUiExtension` (no worker spawn on the page); the follower runtime is
  the offscreen document's `startFollowerRuntime`
  (`chrome-extension/src/offscreen.ts`), which reuses a pre-created
  `KernelHost`. Changes to the non-extension follower branch cannot reach it.
- **iOS native follower** — separate Swift implementation
  (`packages/ios-app/SliccFollower/`), unaffected.
- **Leader / hosted-leader / connect / standalone non-follower** boots — keep
  `mountWcUiLive` unchanged (still spawn the worker).

## Approach (A — new follower runtime mode + dedicated lightweight mount)

Chosen over (B) threading a `followerOnly` flag through the ~1,300-line
`mountWcUiLive`, because a separate, well-bounded follower mount isolates the
"no worker" assumptions into one path that is easy to reason about and test, and
avoids scattering `if (!worker)` conditionals through the leader-capable boot.

### Detection — `resolveUiRuntimeMode`

Add a `'follower'` member to `UiRuntimeMode`. In the non-extension branch, check
order becomes:

1. `connect` (`?connect=1`)
2. `hosted-leader` (`?runtime=hosted-leader`)
3. `cherry` (`?cherry=1`) — **must keep winning**
4. **`follower`** — NEW: a **validated** join URL is present — either the current
   URL parses as one (`parseTrayJoinUrlValue(window.location.href)` non-null) or
   `hasStoredTrayJoinUrl(localStorage)` is true (both from
   `scoops/tray-runtime-config.ts:80,98`). Use these helpers, **not** a `/join/`
   substring or raw key presence — they reject malformed/stale values.
5. `electron-overlay` / `standalone` fallback (unchanged).

The follower check is added **after** cherry (so `?cherry=1` still resolves to
`'cherry'`) and **before** the electron/standalone fallback. Detection must not
misfire on a leader: a stored leader config (`slicc.trayWorkerBaseUrl` without a
valid join URL) is **not** follower intent — `hasStoredTrayJoinUrl` already
gates on a parseable join URL, so a worker-only key won't trip it.

`resolveUiRuntimeMode` is currently pure over `(locationHref, isExtension)`.
Reading `localStorage` makes it impure; to keep it testable, pass storage in
(e.g. a third arg defaulting to `window.localStorage`, or a small
`hasStoredTrayJoinUrl` injection) rather than reaching for the global directly.

### Dispatch — `main.ts` (must dispatch EARLY)

Routing the follower away from `mountWcUiLive` is necessary but **not
sufficient**: `main()` today awaits two shared blockers *before* the runtime
dispatch at `main.ts:117` — `setupSwRegistration()` (`main.ts:87`) and the
**10s-bounded `bootstrapOAuthReplicas()`** (`main.ts:100-106`). A follower would
still eat them.

The follower/cherry branch must run **right after `setupSwRegistration()`**
(the SW is still wanted — it serves the app shell and `/preview/*`) and
**before `bootstrapOAuthReplicas()`**, which it skips entirely (a follower uses
the leader's credentials over the tray channel; it has no local tokens to
pre-warm). Sketch:

```
… startFreezeWatchdog / nuke listener / telemetry …
const swResult = await setupSwRegistration(bridge?…);    // keep
if (swResult === 'reload-pending') return;

if (!isExtension && (mode === 'follower' || mode === 'cherry')) {
  const { mountWcUiFollower } = await import('./wc/wc-follower.js');
  return mountWcUiFollower(app, log, mode);               // NEW — before OAuth wait
}

await registerProviders(); applyProviderDefaults();       // unchanged below
await Promise.race([ bootstrapOAuthReplicas(), 10s ]);
if (mode === 'connect') …; if (isExtension) …; return mountWcUiLive(…);
```

Cherry moves from `mountWcUiLive` to `mountWcUiFollower`; its existing
cherry-specific wiring (CherryHostTransport, `onCherrySliccEvent`,
`onHostEvent`) is preserved in the new mount. (Note: `?cherry=1` still resolves
in `resolveUiRuntimeMode` before the follower check, so cherry is unaffected by
join-URL detection.)

### `mountWcUiFollower` (new, lightweight)

1. **Prelude** — run the cherry-aware prelude (the part of
   `setup-standalone-prelude.ts` that builds `browser` + `realCdpTransport`,
   branching to `CherryHostTransport` for cherry). For standalone-join, this is
   the page `BrowserAPI` + `CDPClient`.
2. **Shell** — mount the WC shell in **follower configuration**: chat thread +
   composer + sprinkle surfaces, with an immediate **"Connecting to leader…"**
   state. Omit worker-only surfaces (terminal, files, memory, freezer, model
   picker, panel-RPC, sudo).
3. **Follower tray** — `startPageFollowerTray(buildFollowerOptions(...))`
   (cherry passes `runtime: CHERRY_RUNTIME_TAG` + cherry event wiring).
   `FollowerSyncManager` becomes the chat `AgentHandle`; the sprinkle controller
   renders the leader's sprinkles; `browserAPI` advertises local targets.
4. **Page-side navigate-lick watcher** — install a small page-context watcher
   that detects main-frame navigations (and the SLICC-handoff `Link`-header
   path) and calls `currentSync.forwardLick(event)` directly. This replaces the
   worker's `LickManager.setForwarder` + `NavigationWatcher`, which the no-worker
   follower lacks; without it, handoffs to the leader stop. Skip for cherry
   (the host page owns navigation; cherry uses its own host-event channel).
5. **No kernel worker** — never call `spawnKernelWorker()`, and never call
   `client.sendSetFollowerForwarding()` (there is no worker client).

The core engineering work — and the largest risk — is **decoupling the shell
mount from the `OffscreenClient`**. `attachWcClient` (`wc-live.ts:~1150`) today
wires far more than chat+sprinkles off the client: freezer rail, workbench,
preview-VFS responder, local sprinkle discovery, nav/model-settings, panel-RPC,
and tray. The follower mount needs a deliberately **reduced** wiring — chat
controller (swappable agent = follower sync), follower sprinkle layout
callbacks, and the page `browserAPI` — and must cleanly omit every client-backed
surface. Expect to extract a shared shell-frame builder from `prepareWcShell`
and a thin follower-only attach, rather than reuse `attachWcClient` as-is. This
is the bulk of the implementation and the first thing to prototype.

**Preview / `open()` caveat (P2):** follower sprinkles already reject local VFS,
but `SprinkleFollowerController`'s `open(path)` (`sprinkle-follower-controller.ts:424`)
still maps a relative path to `/preview/*`. The full boot installs a page VFS
responder (`preview-vfs-responder.ts`) that the no-worker follower will not. The
follower mount must either install a minimal preview responder or have `open()`
degrade gracefully (e.g. ignore/relativize) — decide in the plan; do not leave a
dangling `/preview/*` that 404s.

### Switching matrix

| From                            | Action                             | Behavior                                                                                                                                                                                                                                |
| ------------------------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cold-boot follower (no kernel)  | "Stop following"                   | **Storage-only leave, then reload.** Stop the follower, `removeItem(TRAY_JOIN_STORAGE_KEY)` AND `removeItem(TRAY_WORKER_STORAGE_KEY)`, then `location.reload()` → boots as plain standalone (`mountWcUiLive`, kernel).                   |
| Cold-boot follower (no kernel)  | "Become leader"                    | **Storage-only switch, then reload.** Stop the follower, `removeItem(TRAY_JOIN_STORAGE_KEY)`, KEEP/SET `TRAY_WORKER_STORAGE_KEY`, then `location.reload()` → `mountWcUiLive` reads the worker key with no join URL and boots as leader.  |
| Running standalone (has kernel) | Join a tray                        | **Unchanged** in-place switch via `slicc:tray-join` → `startPageFollowerTray`, reusing the live worker. The fast-path is a cold-boot optimization only; it does not change the already-running leader's behavior.                       |
| Cherry                          | —                                  | Host-SDK-owned lifecycle; follower-only; no in-app leader switch.                                                                                                                                                                       |

**Why not reuse `performTrayLeave` for switch-out:** its leader-restart branch
(`tray-leave-runtime.ts:154`) calls `deps.startLeader(workerBaseUrl)` **in
place**, which requires the kernel worker the no-kernel follower doesn't have.
So the follower needs a **storage-only leave path** (stop follower → write the
two keys → reload), distinct from `performTrayLeave`. Note `performTrayLeave`
**always clears** `TRAY_JOIN_STORAGE_KEY` (`tray-leave-runtime.ts:128`), so the
two states are driven purely by whether `TRAY_WORKER_STORAGE_KEY` survives.

Persisted state that drives boot mode (unchanged keys):
`slicc.trayJoinUrl` (`TRAY_JOIN_STORAGE_KEY`) → follower (when it parses as a
valid join URL); `slicc.trayWorkerBaseUrl` (`TRAY_WORKER_STORAGE_KEY`) without a
join URL → leader.

### Connecting UX + error handling

- Paint the shell + "Connecting to leader…" immediately (before the WebRTC
  connection resolves).
- Reuse `startFollowerWithAutoReconnect` — surface "reconnecting (attempt N)".
- "Gave up" → an error state with a retry affordance.
- Bare-tab CDP unavailability stays graceful (existing `cdpThrottle` in
  `page-follower-tray.ts` swallows `listPages()` failures).

## Components

| Unit                                              | Responsibility                                                                                    | Depends on                                             |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `resolveUiRuntimeMode` (edit)                     | Add `'follower'` detection via `parseTrayJoinUrlValue` / `hasStoredTrayJoinUrl`, ordered after cherry; take storage as a param (stays testable) | URL, injected storage, `tray-runtime-config.ts` helpers |
| `main.ts` (edit)                                  | Dispatch `follower`/`cherry` → `mountWcUiFollower` **after `setupSwRegistration`, before `bootstrapOAuthReplicas`** (skip the OAuth wait) | runtime mode                                           |
| `mountWcUiFollower` (new, `ui/wc/wc-follower.ts`) | Lightweight follower boot: prelude → follower shell (connecting state) → follower tray → navigate-lick watcher; no worker | prelude, follower shell mount, `startPageFollowerTray` |
| Follower shell mount (new/extracted)              | Mount the WC shell without an `OffscreenClient` — chat controller + follower sprinkles + browserAPI; omit freezer/workbench/preview/nav/panel-RPC | shared shell-frame extracted from `prepareWcShell` |
| Page-side navigate-lick watcher (new)             | Detect main-frame navigation / handoff `Link` header → `currentSync.forwardLick(event)` (replaces worker `LickManager` forwarder) | `FollowerSyncManager.forwardLick`                      |
| `startPageFollowerTray` (reuse)                   | WebRTC connect, `FollowerSyncManager` as `AgentHandle`, sprinkle controller, target advertisement | page `browserAPI`, WebRTC                              |
| Follower switch-out helper (new)                  | Storage-only "Stop following"/"Become leader": stop follower → write `TRAY_*` keys → reload (does NOT call `startLeader`) | `TRAY_JOIN/WORKER_STORAGE_KEY`                         |
| Preview `open()` handling (decide)                | Minimal preview responder OR graceful `open()` degrade so follower sprinkle `/preview/*` doesn't 404 | `sprinkle-follower-controller.ts:424`                  |

## Testing

- **`resolveUiRuntimeMode`**: valid `/join/<token>` → `follower`; stored valid
  join URL → `follower`; **malformed** join URL / stale value → NOT `follower`
  (uses `parseTrayJoinUrlValue` / `hasStoredTrayJoinUrl`); `?cherry=1` → `cherry`
  (precedence kept); `isExtension` → `extension` (early return, never
  `follower`); leader config (`trayWorkerBaseUrl` only, no join URL) → not
  `follower`; `?connect=1` and `?runtime=hosted-leader` keep winning.
- **`main.ts` dispatch ordering**: follower/cherry mount is invoked **after**
  `setupSwRegistration` and **without** awaiting `bootstrapOAuthReplicas` (assert
  the OAuth bootstrap is not called on the follower path).
- **`mountWcUiFollower`**: wires follower-sync as the chat agent, mounts the
  sprinkle controller, passes the page `browserAPI`, and **does NOT** spawn the
  kernel worker (assert `spawnKernelWorker` not called) nor call
  `sendSetFollowerForwarding`; paints the connecting state before connect
  resolves.
- **Navigate-lick watcher**: a main-frame navigation calls
  `currentSync.forwardLick` with a `navigate` lick; dropped cleanly when no sync
  is connected; not installed for cherry.
- **Switch-out**: from a no-kernel follower, "stop following" removes BOTH
  `TRAY_JOIN_STORAGE_KEY` and `TRAY_WORKER_STORAGE_KEY` then reloads; "become
  leader" removes the join key, keeps/sets the worker key, then reloads; neither
  path calls `startLeader`.
- **Cherry**: `?cherry=1` routes to `mountWcUiFollower`, keeps
  CherryHostTransport + `onCherrySliccEvent`/`onHostEvent` wiring, runs as a
  follower, no worker spawned, no navigate watcher installed.

## Implementation decomposition (suggested plan ordering)

Per the spec-review recommendation, sequence the work so each stage is
independently verifiable:

1. **Detection + early dispatch** — `resolveUiRuntimeMode` `'follower'` member
   (storage-injected) + `main.ts` early follower/cherry branch (skip OAuth).
   Land behind the new mount being a thin placeholder.
2. **No-worker follower shell/tray mount** — extract the shared shell frame,
   build `mountWcUiFollower` (prelude → follower shell → `startPageFollowerTray`
   → sprinkles), resolve the preview `open()` decision.
3. **Page-side navigate-lick watcher** — replace the worker forwarder.
4. **Cherry fold-in** — move cherry onto `mountWcUiFollower` once the standalone
   follower mount is stable; verify CDP/host-event wiring intact.
5. **Switch-out** — storage-only "stop following" / "become leader" + reload.

## Cross-runtime parity

- **node-server `--join` follower**: still works — CDP is page-side and the
  prelude runs in the fast-path; the `?bridge=` `/cdp` proxy is unaffected.
- **Extension**: unaffected (separate boot path; offscreen kernel).
- **iOS follower**: separate native implementation; unaffected.
- **Leader / hosted-leader / connect**: unchanged (`mountWcUiLive`).

## Non-goals (YAGNI)

- No lazy in-place kernel boot for a follower → leader promotion; a reload is
  acceptable and far simpler.
- No new persisted state; reuse existing `TRAY_JOIN_STORAGE_KEY` /
  `TRAY_WORKER_STORAGE_KEY`.
- No change to the WebRTC/tray sync protocol or `FollowerSyncManager`.
