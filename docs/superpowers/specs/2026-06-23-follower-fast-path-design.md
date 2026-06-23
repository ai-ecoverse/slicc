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
  cone bootstrap + skills + sudo + the awaited `oauth-bootstrap` soft-timeout.
- The tray-follower WebRTC connection (`page-follower-tray.ts` via
  `wc-tray.ts`) only starts **after** that heavy boot.

The two observed phases map to: (1) the WC shell waiting on the kernel-worker
boot; (2) the local kernel running and rendering its own empty cone while the
WebRTC connection negotiates and pulls the first snapshot.

### Cherry pays the same cost

`?cherry=1` (the embedded follower) also routes through `mountWcUiLive` and
**also spawns the kernel worker** (`setup-standalone-prelude.ts` builds the
cherry `BrowserAPI`, then `wc-live.ts` spawns the worker regardless), even
though cherry is already a follower (`wc-tray.ts` `runtimeMode === 'cherry'`
branch calls `startPageFollowerTray`). Cherry never needs a local cone, so it
benefits from the same fast-path.

## What a follower actually needs (verified)

A standalone browser follower's capabilities are **entirely page-side** and do
**not** require the kernel worker / orchestrator / cone:

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

**Conclusion:** a follower mount that runs the page prelude (BrowserAPI + CDP
connect) + `startPageFollowerTray` + the sprinkle controller, but **skips the
kernel worker/orchestrator/cone**, preserves every capability that works today.

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
4. **`follower`** — NEW: the URL path contains `/join/` **or** a stored
   `slicc.trayJoinUrl` is present, AND none of the above matched.
5. `electron-overlay` / `standalone` fallback (unchanged).

The follower check is added **after** cherry (so `?cherry=1` still resolves to
`'cherry'`) and **before** the electron/standalone fallback. Detection must not
misfire on a leader: a stored leader config (`slicc.trayWorkerBaseUrl` without a
join URL) is **not** follower intent.

### Dispatch — `main.ts`

```
if (isExtension) → mountWcUiExtension      (unchanged)
else if (mode === 'connect') → connect surface   (unchanged)
else if (mode === 'follower' || mode === 'cherry') → mountWcUiFollower   (NEW)
else → mountWcUiLive                       (unchanged; still spawns the worker)
```

Cherry moves from `mountWcUiLive` to `mountWcUiFollower`; its existing
cherry-specific wiring (CherryHostTransport, `onCherrySliccEvent`,
`onHostEvent`) is preserved in the new mount.

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
4. **No kernel worker** — never call `spawnKernelWorker()`.

The core engineering work is **decoupling the shell mount from the
`OffscreenClient`**: `prepareWcShell` / `attachWcClient` currently assume a
client backed by the worker. Extract a follower-capable mount that needs only:
the chat controller (with a swappable agent = follower sync), sprinkle layout
callbacks, and the page `browserAPI`.

### Switching matrix

| From                            | Action                             | Behavior                                                                                                                                                                                                                                                            |
| ------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cold-boot follower (no kernel)  | "Stop following" / "Become leader" | **Full page reload.** Clear (`stop`) or keep (`become leader`) `slicc.trayJoinUrl`, then reload → `mountWcUiLive` (boots the kernel and runs leader/standalone). In-place switch is impossible without a worker, and a reload is the clean, predictable transition. |
| Running standalone (has kernel) | Join a tray                        | **Unchanged** in-place switch via `slicc:tray-join` → `startPageFollowerTray`, reusing the live worker. The fast-path is a cold-boot optimization only; it does not change the already-running leader's behavior.                                                   |
| Cherry                          | —                                  | Host-SDK-owned lifecycle; follower-only; no in-app leader switch.                                                                                                                                                                                                   |

Persisted state that drives boot mode (unchanged keys):
`slicc.trayJoinUrl` (`TRAY_JOIN_STORAGE_KEY`) present → follower;
`slicc.trayWorkerBaseUrl` (`TRAY_WORKER_STORAGE_KEY`). The reload-on-switch-out
path clears/keeps these via the existing `performTrayLeave` semantics before
reloading.

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
| `resolveUiRuntimeMode` (edit)                     | Add `'follower'` detection (path `/join/` or stored join URL), ordered after cherry               | URL, `localStorage`, `TRAY_JOIN_STORAGE_KEY`           |
| `main.ts` (edit)                                  | Route `follower`/`cherry` → `mountWcUiFollower`                                                   | runtime mode                                           |
| `mountWcUiFollower` (new, `ui/wc/wc-follower.ts`) | Lightweight follower boot: prelude → shell (connecting state) → follower tray; no worker          | prelude, follower shell mount, `startPageFollowerTray` |
| Follower shell mount (new/extracted)              | Mount the WC shell without an `OffscreenClient` (chat controller + sprinkles + browserAPI)        | `prepareWcShell` refactor                              |
| `startPageFollowerTray` (reuse)                   | WebRTC connect, `FollowerSyncManager` as `AgentHandle`, sprinkle controller, target advertisement | page `browserAPI`, WebRTC                              |
| Switch-out helper (edit)                          | "Stop following"/"Become leader" from a no-kernel follower → clear/keep join URL + reload         | `performTrayLeave` storage semantics                   |

## Testing

- **`resolveUiRuntimeMode`**: `/join/<token>` → `follower`; stored
  `slicc.trayJoinUrl` → `follower`; `?cherry=1` → `cherry` (precedence kept);
  `isExtension` → `extension` (early return, never `follower`); leader config
  (`trayWorkerBaseUrl` only, no join URL) → not `follower`; `?connect=1` and
  `?runtime=hosted-leader` keep winning.
- **`mountWcUiFollower`**: wires follower-sync as the chat agent, mounts the
  sprinkle controller, passes the page `browserAPI`, and **does NOT** spawn the
  kernel worker (assert `spawnKernelWorker` not called); paints the connecting
  state before connect resolves.
- **Switch-out**: from a no-kernel follower, "stop following" clears
  `slicc.trayJoinUrl` and triggers reload; "become leader" keeps it / sets
  leader config and reloads.
- **Cherry**: `?cherry=1` routes to `mountWcUiFollower`, keeps
  CherryHostTransport + `onCherrySliccEvent`/`onHostEvent` wiring, runs as a
  follower, no worker spawned.

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
