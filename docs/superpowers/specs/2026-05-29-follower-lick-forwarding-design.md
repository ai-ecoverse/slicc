# Follower Lick Forwarding — Design

**Date:** 2026-05-29
**Branch:** `feat/follower-lick-forwarding`
**Status:** Design approved; revised after code-grounded review; spec under review before plan.

## Problem

When a SLICC instance runs as a tray **follower**, a lick that originates locally on
the follower has no path to the agent. The agent (cone) only runs on the **leader** —
a follower is a thin view (`FollowerSyncManager implements AgentHandle`,
`packages/webapp/src/scoops/tray-follower-sync.ts`) and routes the user's chat to the
leader. The lick fires where the event lands (the follower), but the only agent that
can act on it lives on the leader.

This is most visible for the **handoff feature** (the `navigate` lick), because a
follower's user keeps browsing while the panel follows the leader's session.

### Root asymmetry

Two lick paths exist, and only one reaches the leader:

- **Sprinkle licks already forward to the leader.** A follower's sprinkle/dip click
  goes `FollowerSyncManager.sendSprinkleLick` → `sprinkle.lick` over the WebRTC data
  channel → leader's inbound handler (`tray-leader-sync.ts:611`, `onSprinkleLick`).
  The lick reaches the leader's agent — but the leader **discards the origin**.
- **Navigate (handoff) licks do not forward.** They go through the local
  `lickManager.emitEvent`, which has zero follower-awareness.

### Exact failure path

**Extension follower:**

1. `packages/chrome-extension/src/service-worker.ts:434` observes the handoff `Link`
   header via `chrome.webRequest.onHeadersReceived` and sends a `navigate-lick`
   message to the offscreen document.
2. `packages/chrome-extension/src/offscreen.ts:239–261` receives it and calls
   `lickManager.emitEvent({ type: 'navigate', ... })` **unconditionally** — no
   follower check.
3. The offscreen builds a full kernel host at `offscreen.ts:115–124` _before_ it
   decides it is a follower (the `joinUrl` branch is at `offscreen.ts:286`). So the
   follower has a local `lickManager`, orchestrator, and (sometimes) a cone.

Two sub-cases, both observed:

- **No API key** (`allowProviderlessTrayJoin`, `offscreen.ts:108`): cone bootstrap is
  skipped. The navigate lick routes to a cone that does not exist → handler logs
  "target not found" and **silently drops it**.
- **API key present**: a _local_ cone exists, but the panel shows the _leader's_
  session through `FollowerSyncManager` (`offscreen.ts:426`). The lick fires a turn in
  the **invisible local cone** — phantom work, the follower's own tokens, leader never
  hears of it.

**Standalone (page) follower — confirmed by review:** `mainStandaloneWorker`
(`main.ts:1722`) always calls `spawnKernelWorker` (`main.ts:1943`) _before_ the
tray-role branch (`main.ts:2842`). So a standalone follower **always** runs a kernel
worker; that worker builds a kernel host (`kernel-worker.ts:213`) which, for any
non-extension runtime, starts a `NavigationWatcher` (`host.ts:455`) that fires
navigate licks via the worker's `lickManager.emitEvent`. **Crucial twist:** the
worker's `lickManager` and the page's `FollowerSyncManager` (`page-follower-tray.ts`)
live in different execution contexts (DedicatedWorker vs page), so forwarding requires
a worker→page bridge — there is no single place to install a forwarder.

Only the follower can ever observe the handoff header: it rides on a main-frame
navigation in the follower's own browser. The leader is a different instance driving a
different (or no) browser, so "just have the leader watch for it" is physically
impossible. **Forwarding is the only available fix.**

### Per-float reality

| Float                          | Navigate / handoff lick                                                                                | Sprinkle lick                          |
| ------------------------------ | ------------------------------------------------------------------------------------------------------ | -------------------------------------- |
| **Extension follower**         | Broken (drop or phantom cone). Most exposed.                                                           | Forwards, no origin                    |
| **Standalone (page) follower** | Fires in the kernel **worker**'s lickManager → phantom local cone; needs worker→page bridge to forward | Forwards (page-side), no origin        |
| **iOS follower**               | No handoff concept whatsoever                                                                          | Forwards via `sprinkleLick`, no origin |

(Pure browser-page-without-worker followers do not exist as a separate float — the
standalone page always spawns the worker.)

## Decisions

1. **Scope:** cover the **extension and standalone** followers in v1, including the
   worker→page navigate-lick bridge.
2. **Unify leader-side only.** Do not migrate the follower-side sprinkle path through
   `emitEvent`. Sprinkle licks keep their existing dedicated forward path; the leader
   unifies navigate and sprinkle into one origin-stamping + formatting path on receipt.
3. **Origin tag:** opaque `originFollowerId` (reserved for future response-routing) +
   human-readable `originLabel` surfaced to the agent.
4. **iOS:** keep accepting the legacy `sprinkle.lick`; stamp origin leader-side. No iOS
   rebuild now. Generic-envelope migration is a documented follow-up.
5. **Forward failure:** log and drop (never fall back to local handling).

## Non-goals (explicit deferrals)

- **Per-follower response routing.** Approval cards and `sprinkle.update`s keep
  broadcasting to all followers. Correct for single-follower; multi-follower noise is a
  follow-up using `originFollowerId`.
- **Follower-side sprinkle→emitEvent migration** (see decision 2).
- **iOS migration to the generic `lick` envelope.**
- **Queue-until-reconnect** for forwarded licks.
- **Suppressing the phantom local cone** (the chokepoint already stops feeding it).

## Design

### 1. `LickManager`: a true single dispatch chokepoint

The premise "every lick funnels through `emitEvent`" is currently false — webhook
(`lick-manager.ts:197`) and cron (`:324`) call `this.eventHandler` directly, bypassing
`emitEvent` (`:105`). Fix this cheaply by funneling all internal emit sites through one
private method:

```ts
setForwarder(fn: ((e: LickEvent) => void) | null): void; // null = handle locally (leader/standalone)

private dispatch(event: LickEvent): void {
  if (this.forwarder && FORWARDABLE_TO_LEADER.has(event.type)) {
    this.forwarder(event); // ship to leader; never touches the local handler
    return;
  }
  this.eventHandler?.(event);
}
// emitEvent(), the webhook handler, and the cron scheduler all call dispatch(event).
```

```ts
const FORWARDABLE_TO_LEADER: ReadonlySet<LickEvent['type']> = new Set(['navigate']);
```

`navigate` is the only emitEvent-emitted type that belongs to the leader's agent.
Sprinkle is _also_ a leader's-agent lick, but it travels on its own dedicated path
(`sprinkle.lick`), not through `emitEvent`, so it is not in this set. webhook/cron run
local (and never originate on a follower); `fswatch`/`session-reload`/`upgrade` are
local-runtime lifecycle.

**No-regression test:** assert every `LickEvent['type']` is classified as either
`FORWARDABLE_TO_LEADER`, forwarded via a dedicated path (`sprinkle`), or local — so a
future type forces a deliberate decision and cannot silently regress.

### 2. Follower-side: install the forwarder

**Extension follower** — `lickManager` and `FollowerSyncManager` both live in the
offscreen document. Install directly in the `joinUrl` connect lifecycle (mirrors the
existing `detachSync` at `offscreen.ts:291–305`):

- connect: `lickManager.setForwarder((e) => sync.forwardLick(e))`
- detach/disconnect: `lickManager.setForwarder(null)`

**Standalone (page) follower** — `lickManager` is in the kernel worker;
`FollowerSyncManager` is page-side. Bridge over the existing kernel transport
(`OffscreenClient`), mirroring the existing navigate-lick / sprinkle-lick relays:

- **page → worker** control message `set-follower-forwarding: boolean`. On `true`, the
  worker installs `lickManager.setForwarder((e) => postToPage({ type: 'forward-lick', event: e }))`;
  on `false`, it clears it.
- **worker → page** message `forward-lick { event }`. The page handler calls
  `pageFollowerTray`'s `FollowerSyncManager.forwardLick(event)`.
- `startPageFollowerTray` sends `set-follower-forwarding: true` on start; the leave/stop
  path sends `false` so the worker stops forwarding to a dead page handler.

`FollowerSyncManager.forwardLick(event)` sends `{ type: 'lick', event }` and **inspects
the `send()` boolean** (`tray-sync-protocol.ts:479` returns `false` on a closed/failed
channel): on `false`, log and drop (F7). Today's `sendSprinkleLick` (`:416`) ignores
this return; the same drop-on-`false` discipline is applied there.

### 3. Wire protocol: generic `lick` message; leader stamps origin

New follower→leader message in `tray-sync-protocol.ts`:

```ts
{ type: 'lick', event: LickEvent } // raw serialized event; follower sends NO identity
```

Legacy `sprinkle.lick` is retained (existing extension path + iOS). Both inbound paths
are stamped with origin leader-side.

### 4. Leader-side: receive, validate, stamp, unify

`LeaderSyncManager` exposes only `onSprinkleLick` today (`tray-leader-sync.ts:50`).
Add a generic-lick option:

```ts
onForwardedLick?: (event: LickEvent, originBootstrapId: string) => void;
```

Inbound `lick` handler:

1. **Validate (F6):** if `event.type ∉ FORWARDABLE_TO_LEADER`, log and drop — rejects a
   malformed or version-skewed peer sending `webhook` / `cron` / `session-reload` / etc.
2. **Scrub (F6):** strip any follower-sent `originFollowerId` / `originLabel`.
3. **Stamp:** `originFollowerId = bootstrapId`, `originLabel = labelFor(follower.floatType, follower.runtime)`
   — the leader already holds the `ConnectedFollower` (`:79`) with `bootstrapId` and
   `floatType`.
4. Call `onForwardedLick(stampedEvent, bootstrapId)`.

Both leader adapters wire `onForwardedLick` to the leader's `lickManager.emitEvent`:

- **Extension leader** (`extension-leader-tray.ts`): offscreen `lickManager.emitEvent(stampedEvent)`.
- **Standalone leader** (`main.ts:2574` region): relay to the worker's
  `lickManager.emitEvent` over the existing `client` path.

**Sprinkle unification (resolves F5).** Today the leader's inbound `sprinkle.lick`
routes through a bespoke `routeSprinkleLick` (`offscreen-bridge.ts:673`) that builds its
own content string and never calls `formatLickEventForCone`. Change the leader's
`onSprinkleLick` to stamp origin and route through `lickManager.emitEvent({ type: 'sprinkle', sprinkleName, body, targetScoop, originFollowerId, originLabel })`
→ the shared formatter. This unifies navigate and sprinkle on the leader, gives sprinkle
origin display, and gives iOS sprinkle licks origin for free (stamped from the channel).

### 5. Float labels (resolves F8)

`FloatType` (`tray-leader-sync.ts:68`) is `standalone | extension | electron | unknown`
— no `ios`, so `deriveFloatType('slicc-ios')` returns `unknown`. Add `'ios'` to the
union and a `runtime.includes('ios')` case to `deriveFloatType`. Add
`labelFor(floatType, runtime)` returning readable labels (`"extension follower"`,
`"standalone follower"`, `"iOS follower"`, …) with a raw-runtime-string fallback for
`unknown`.

### 6. Agent sees the origin (`formatLickEventForCone`)

Add optional `originFollowerId?` / `originLabel?` to `LickEvent`, set **only** by the
leader. When `originLabel` is present, `formatLickEventForCone`
(`lick-formatting.ts:50`) surfaces it (e.g. a `Source: extension follower` line). The
opaque `originFollowerId` is not shown to the agent — reserved for response-routing.

### 7. End-to-end handoff trace

```
follower user navigates
  → header observed (extension: webRequest; standalone: worker NavigationWatcher)
  → lickManager.emitEvent({ navigate })
  → dispatch → forwarder
       (extension: sync.forwardLick directly;
        standalone: worker → page `forward-lick` → FollowerSyncManager.forwardLick)
  → `lick` message over data channel
  → leader validates type, scrubs + stamps origin
  → onForwardedLick → leader lickManager.emitEvent → defaultLickEventHandler → cone
  → handoff skill renders approval card (with "from <originLabel>")
  → leader broadcasts the cone message to all followers
  → originating follower sees the card; user clicks Accept
  → sprinkle lick (existing path) → leader stamps origin → lickManager.emitEvent({ sprinkle })
  → cone runs `upskill` / `curl` on the leader's workspace
```

Correct for a single follower. Multi-follower card noise is the deferred
response-routing item.

## Affected files

| File                                                                             | Change                                                                                                                                                                                                                       |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/webapp/src/scoops/lick-manager.ts`                                     | private `dispatch`; `setForwarder`; `FORWARDABLE_TO_LEADER`; route `emitEvent`/webhook/cron through `dispatch`; optional `originFollowerId`/`originLabel` on `LickEvent`                                                     |
| `packages/webapp/src/scoops/lick-formatting.ts`                                  | surface `originLabel` in `formatLickEventForCone`                                                                                                                                                                            |
| `packages/webapp/src/scoops/tray-sync-protocol.ts`                               | generic `lick` follower→leader message                                                                                                                                                                                       |
| `packages/webapp/src/scoops/tray-follower-sync.ts`                               | `forwardLick` (inspects `send()` return); apply drop-on-`false` to `sendSprinkleLick`                                                                                                                                        |
| `packages/webapp/src/scoops/tray-leader-sync.ts`                                 | `onForwardedLick` option; inbound `lick` handler (validate + scrub + stamp); `FloatType` `'ios'` + `deriveFloatType` + `labelFor`; stamp origin on the `sprinkle.lick` path                                                  |
| `packages/chrome-extension/src/offscreen.ts`                                     | install/clear forwarder on the offscreen `lickManager` in the follower lifecycle                                                                                                                                             |
| `packages/chrome-extension/src/offscreen-bridge.ts` / `extension-leader-tray.ts` | wire `onForwardedLick` → `lickManager.emitEvent`; route inbound `sprinkle.lick` through `emitEvent` (replace bespoke `routeSprinkleLick` content-builder) with origin                                                        |
| `packages/webapp/src/kernel/kernel-worker.ts` + `kernel/host.ts`                 | worker side of the bridge: `set-follower-forwarding` handler installs/clears a forwarder that posts `forward-lick` to the page                                                                                               |
| `packages/webapp/src/ui/page-follower-tray.ts` + `main.ts`                       | page side of the bridge: send `set-follower-forwarding` on start/stop; handle `forward-lick` → `FollowerSyncManager.forwardLick`; wire standalone leader `onForwardedLick`/`onSprinkleLick` through the worker `lickManager` |

The extension `service-worker.ts` and the `offscreen.ts:239` navigate-lick listener
need **no logic change** — they already route through `emitEvent`/`dispatch`.

## Tests

- `lick-manager`: `dispatch` is the single chokepoint (emitEvent + webhook + cron all
  funnel through it); forwarder gates only `FORWARDABLE_TO_LEADER`; runs local when no
  forwarder; exhaustive type classification.
- `tray-follower-sync`: `forwardLick` emits the correct wire message and drops on
  `send() === false`.
- `tray-leader-sync`: inbound generic `lick` stamps `originFollowerId`/`originLabel`;
  rejects a non-forwardable type; strips follower-sent origin fields; `sprinkle.lick`
  gains origin; `labelFor` covers `ios` + the raw-runtime fallback.
- `tray-sync-protocol`: generic `lick` round-trips.
- `lick-formatting`: renders `originLabel` when present; unchanged when absent.
- **Standalone bridge**: `set-follower-forwarding` installs/clears the worker forwarder;
  a worker navigate lick produces a page `forward-lick` that reaches
  `FollowerSyncManager.forwardLick`.
- **Extension split**: panel sprinkle click still forwards; leader-side gains origin.

Per-package coverage floors must hold (`webapp` global default; see root `CLAUDE.md`).

## Docs

- Root `CLAUDE.md` (Licks / Tray addendum), `packages/webapp/CLAUDE.md` (Tray Sync),
  `packages/chrome-extension/CLAUDE.md` (offscreen follower + leader wiring).
- `docs/architecture.md` tray protocol matrix — add the generic `lick` message and the
  follower-origin stamping note.
- `packages/ios-app/CLAUDE.md` — record the deferred iOS migration to the generic
  envelope (and that iOS sprinkle licks now show origin via leader-side stamping).
- Handoff `SKILL.md` (`packages/vfs-root/workspace/skills/handoff/`) if the
  approval-card copy changes to mention the origin.
- Agent-facing `/shared/CLAUDE.md` (`packages/vfs-root/shared/CLAUDE.md`) if follower
  handoff behavior is documented for the agent.

## Verification gates

```
npx prettier --write <changed-files>
npm run typecheck
npm run test
npm run test:coverage
npm run build
npm run build -w @slicc/chrome-extension
```

## Follow-ups (out of scope)

1. Per-follower response routing (approval card / `sprinkle.update` to the originating
   follower only) using `originFollowerId`.
2. iOS migration from `sprinkle.lick` to the generic `lick` envelope.
3. Queue-until-reconnect for forwarded licks.
4. Optionally always skip cone bootstrap in follower mode (removes the dormant phantom
   cone entirely).

## Review history

Revised after a code-grounded review. All eight findings verified against the codebase
and incorporated: standalone worker/page coverage + bridge (F1), `onForwardedLick`
leader integration point (F2), single `dispatch` chokepoint (F3), descope of the
follower-side sprinkle→emitEvent migration (F4), leader-side sprinkle routing through
the shared formatter (F5), inbound type validation + origin scrubbing (F6),
`send()`-return checking on `forwardLick` (F7), and `FloatType`/`labelFor` iOS support
(F8).
