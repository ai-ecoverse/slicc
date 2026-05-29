# Follower Lick Forwarding — Design

**Date:** 2026-05-29
**Branch:** `feat/follower-lick-forwarding`
**Status:** Design approved; spec under review before plan.

## Problem

When a SLICC instance runs as a tray **follower**, a lick that originates locally
on the follower has no path to the agent. The agent (cone) only runs on the
**leader** — a follower is a thin view (`FollowerSyncManager implements AgentHandle`,
`packages/webapp/src/scoops/tray-follower-sync.ts`) with no orchestrator and no
required model/provider. The lick fires where the event lands (the follower), but
the only agent that can act on it lives on the leader.

This is most visible for the **handoff feature** (the `navigate` lick), because a
follower's user keeps browsing freely while the panel follows the leader's session.

### Root asymmetry

Two lick paths exist, and only one is follower-aware:

- **Sprinkle licks already forward to the leader.** A follower's sprinkle/dip click
  goes `FollowerSyncManager.sendSprinkleLick` → `sprinkle.lick` over the WebRTC data
  channel → leader's inbound handler (`tray-leader-sync.ts`, ~lines 605–616) →
  leader's `defaultLickEventHandler`. The lick reaches the leader's agent.
- **Navigate (handoff) licks do not forward.** They go through the _local_
  `lickManager.emitEvent`, which has zero follower-awareness.

### Exact failure path (extension follower)

1. `packages/chrome-extension/src/service-worker.ts:434` observes the handoff `Link`
   header via `chrome.webRequest.onHeadersReceived` and sends a `navigate-lick`
   message to the offscreen document.
2. `packages/chrome-extension/src/offscreen.ts:239–261` receives it and calls
   `lickManager.emitEvent({ type: 'navigate', ... })` **unconditionally** — no check
   for follower mode.
3. The offscreen builds a full kernel host at `offscreen.ts:115–124` _before_ it
   decides it is a follower (the `joinUrl` branch is at `offscreen.ts:286`). So a
   follower has a local `lickManager`, orchestrator, and (sometimes) a cone.

Two sub-cases, both observed:

- **No API key** (`allowProviderlessTrayJoin`, `offscreen.ts:108`): cone bootstrap is
  skipped (`skipConeBootstrap: true`). The navigate lick routes to a cone that does
  not exist, so the handler logs "target not found" and **silently drops it**.
- **API key present**: a _local_ cone exists, but the panel displays the _leader's_
  session through `FollowerSyncManager` (`bridge.setFollowerSync(sync)`,
  `offscreen.ts:426`). The lick fires a turn in the **invisible local cone** —
  phantom work, burning the follower's own tokens, and the leader never hears of it.

Only the follower can ever observe the handoff header: it rides on a main-frame
navigation in the follower's own browser. The leader is a different instance driving
a different (or no) browser, so "just have the leader watch for it" is physically
impossible. **Forwarding is the only available fix.**

### Per-float reality

| Float                                | Navigate / handoff lick                                                                                 | Sprinkle lick                                                    |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| **Extension follower**               | Broken (drop or phantom cone). Most exposed.                                                            | Forwards, but no origin                                          |
| **Browser-page follower**            | No CDP → cannot generate it at all                                                                      | Forwards, but no origin                                          |
| **Standalone CLI/Electron follower** | Has CDP — _verify in impl_ whether a follower even runs the nav watcher; either same bug or never fires | Forwards, but no origin                                          |
| **iOS follower**                     | No handoff concept whatsoever                                                                           | Forwards via `sprinkleLick`, origin known only by WebRTC channel |

### Secondary gap: origin is discarded

Even where sprinkle licks already forward, the leader throws away the origin.
`onSprinkleLick(sprinkleName, body, targetScoop)` carries no follower identity (the
`bootstrapId` is in scope at the receive site but discarded), and any `sprinkle.update`
the agent pushes back **broadcasts to every follower**, not the one who clicked.

## Goals

1. Forward follower-observed user/world licks (`navigate` now, `sprinkle` migrated
   onto the same path) to the leader's agent.
2. Tag each forwarded lick with its origin: an opaque `followerId` (for future
   response-routing) and a human-readable `originLabel` the agent can see.
3. Unify the two forward paths through a **single chokepoint** so a future lick type
   cannot regress into the navigate bug.

## Non-goals (explicit deferrals)

- **Per-follower response routing.** Approval cards and `sprinkle.update`s continue to
  broadcast to all followers. Correct for the common single-follower case; multi-
  follower noise (everyone sees the card) is a follow-up.
- **iOS migration to the generic envelope.** The leader keeps accepting the legacy
  `sprinkle.lick` and stamps origin on it, so iOS needs no rebuild now. Migration to
  the generic `lick` envelope is a documented follow-up (iOS has no navigate concept,
  so nothing is urgent).
- **Queue-until-reconnect.** If forwarding fails (channel down), log and drop.
- **Suppressing the phantom local cone.** Out of scope; the chokepoint already stops
  feeding it. "Always skip cone bootstrap in follower mode" is a noted optional cleanup
  (it touches leave-tray transitions).

## Design

### 1. Chokepoint: `lickManager.emitEvent()` decides forward-vs-local

Add an optional forwarder to `LickManager` (`packages/webapp/src/scoops/lick-manager.ts`):

```ts
setForwarder(fn: ((e: LickEvent) => void) | null): void; // null = handle locally (leader/standalone)

// inside emitEvent():
if (this.forwarder && FORWARDABLE_TO_LEADER.has(event.type)) {
  this.forwarder(event); // serialize + ship to leader
  return;                // never touches the local handler
}
// ...existing local handler path (setEventHandler → defaultLickEventHandler)
```

Because every lick already funnels through `emitEvent`, this one change fixes the
whole class. The extension navigate-lick listener at `offscreen.ts:239` needs **no
change** — it already calls `emitEvent`, so it forwards automatically once a forwarder
is installed.

The forwarder is installed/cleared in the follower connection lifecycle (mirrors the
existing `detachSync` at `offscreen.ts:291–305` and the standalone equivalent in
`page-follower-tray.ts`):

- On follower connect: `lickManager.setForwarder((e) => followerSync.forwardLick(e))`.
- On detach/disconnect: `lickManager.setForwarder(null)`.

A leader never installs a forwarder, so `emitEvent` is always local for it. When a
follower leaves the tray and becomes standalone, the forwarder clears and licks are
handled locally again.

**Scope of the chokepoint.** This mechanism lives wherever a follower float has a
local `lickManager`. That is confirmed for the **extension offscreen** follower (it
builds a full kernel host at `offscreen.ts:115`). Whether the **standalone page
follower** has a local `lickManager` is a _verify-during-implementation_ item (see
below). The universally-applicable part of this design is the wire protocol and
leader-side origin stamping in §3 — that applies to every follower float (including
iOS) regardless of whether the follower runs a `lickManager`.

### 2. Forward allowlist (explicit, not `EXTERNAL_LICK_CHANNELS`)

`EXTERNAL_LICK_CHANNELS` (`lick-formatting.ts:29`) contains all seven types, including
local-lifecycle ones — it is **not** the right gate. Add a narrower, purpose-built set:

```ts
const FORWARDABLE_TO_LEADER: ReadonlySet<LickEvent['type']> = new Set(['navigate', 'sprinkle']);
```

Classification rationale (does this describe the external world / a user action →
leader's agent, or this runtime's own lifecycle → stays local?):

| Type             | Decision | Why                                                    |
| ---------------- | -------- | ------------------------------------------------------ |
| `navigate`       | forward  | external/user action (handoff)                         |
| `sprinkle`       | forward  | user action in a rendered sprinkle/dip                 |
| `session-reload` | local    | this runtime's lifecycle (mount-recovery, bridge-down) |
| `upgrade`        | local    | this runtime detected a bundle upgrade                 |
| `fswatch`        | local    | this runtime's local VFS                               |
| `webhook`        | n/a      | originates from the leader's node-server only          |
| `cron`           | n/a      | leader-owned scheduling; never created on a follower   |

A test asserts **every** `LickEvent['type']` is classified as forwardable or
explicitly local, so adding an eighth type forces a deliberate decision and cannot
silently regress.

### 3. Wire protocol: one generic `lick` message; leader stamps origin

New follower→leader message in `packages/webapp/src/scoops/tray-sync-protocol.ts`:

```ts
{ type: 'lick', event: LickEvent } // raw serialized event; no identity in the payload
```

- `FollowerSyncManager.forwardLick(event)` is the single wire mechanism for forwarding
  any lick. Where a follower has a local `lickManager` (extension offscreen), the
  sprinkle bridge routes through `emitEvent({ type: 'sprinkle', ... })` → forwarder →
  `forwardLick`, so sprinkles and navigate share one path. On a float without a local
  `lickManager`, the existing sprinkle source may call `forwardLick` (or its legacy
  equivalent) directly — the wire format and leader handling are identical either way.
- The **leader** never trusts the payload for identity. At the inbound receive site it
  already holds the `ConnectedFollower` (`tray-leader-sync.ts` ~lines 79–94), which
  carries `bootstrapId` and `floatType`. It reconstructs the event and stamps:

  ```ts
  localLickManager.emitEvent({
    ...event,
    originFollowerId: follower.bootstrapId,
    originLabel: labelFor(follower.floatType), // e.g. "extension follower", "iOS follower"
  });
  ```

- Two new **optional** `LickEvent` fields, set only by the leader:
  `originFollowerId?: string`, `originLabel?: string`.
- **Legacy `sprinkle.lick` stays accepted** on the leader and gets the same origin
  stamp from the channel identity — so iOS sprinkle licks gain origin **with no iOS
  change**. iOS migration to the generic `lick` envelope is a follow-up via the
  package's 5-step protocol checklist.

### 4. Agent sees the origin: `formatLickEventForCone`

When `originLabel` is present, `formatLickEventForCone`
(`lick-formatting.ts:50–124`) surfaces it (e.g. a `Source: extension follower` line in
the content, or a label suffix). The handoff approval card can then read "Handoff
requested from your extension follower." The opaque `originFollowerId` is **not** shown
to the agent — reserved for response-routing later.

### 5. End-to-end handoff trace (works today with broadcast)

```
follower user navigates
  → service-worker webRequest observes Link header
  → offscreen emitEvent({ navigate })
  → forwarder → `lick` over data channel
  → leader stamps originFollowerId + originLabel
  → leader localLickManager.emitEvent → defaultLickEventHandler → leader's cone
  → handoff skill renders approval card
  → leader broadcasts the cone message to all followers (snapshot / agent_event)
  → originating follower sees the card
  → user clicks Accept → sprinkle lick → forwarder → leader
  → leader's cone runs `upskill` / `curl` on the leader's workspace  (correct — leader owns the agent)
```

End-to-end correct for a single follower. Multi-follower noise (the card appears on the
leader and all followers) is the deferred response-routing item.

### 6. Failure handling

If `forwardLick` throws or the channel is closed at emit time: **log a warning and
drop** the lick. Never fall back to local handling — that re-creates the phantom-cone
bug. The user can re-trigger (re-navigate, re-click). Queue-until-reconnect is a noted
robustness follow-up.

## Affected files

| File                                               | Change                                                                                                                                                                                                |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/webapp/src/scoops/lick-manager.ts`       | `setForwarder`, forward branch in `emitEvent`, `FORWARDABLE_TO_LEADER`, optional `originFollowerId`/`originLabel` on `LickEvent`                                                                      |
| `packages/webapp/src/scoops/lick-formatting.ts`    | surface `originLabel` in `formatLickEventForCone`                                                                                                                                                     |
| `packages/webapp/src/scoops/tray-sync-protocol.ts` | new generic `lick` follower→leader message                                                                                                                                                            |
| `packages/webapp/src/scoops/tray-follower-sync.ts` | `forwardLick(event)`; route sprinkle bridge through `emitEvent`                                                                                                                                       |
| `packages/webapp/src/scoops/tray-leader-sync.ts`   | inbound `lick` handler; origin stamping; same stamp on legacy `sprinkle.lick`; `labelFor(floatType)`                                                                                                  |
| `packages/chrome-extension/src/offscreen.ts`       | install/clear forwarder in the follower connect/detach lifecycle                                                                                                                                      |
| `packages/webapp/src/ui/page-follower-tray.ts`     | install/clear forwarder **iff** this float has a local `lickManager` (verify). Otherwise no change: its existing sprinkle path already forwards, and navigate cannot originate without a nav watcher. |

The extension `service-worker.ts` and the `offscreen.ts` navigate-lick listener
need **no logic change** — they already route through `emitEvent`.

## Tests

- `lick-manager`: `emitEvent` forwards forwardable types when a forwarder is installed;
  runs the local handler for non-forwardable types; runs local when no forwarder
  (leader); exhaustive assertion that every `LickEvent['type']` is classified.
- `lick-formatting`: `formatLickEventForCone` renders `originLabel` when present and is
  unchanged when absent.
- `tray-leader-sync`: inbound `lick` reconstructs the event and stamps
  `originFollowerId` + `originLabel` from the connection; legacy `sprinkle.lick` gets
  the same stamp.
- `tray-follower-sync`: `forwardLick` emits the correct wire message; sprinkle bridge
  routes through `emitEvent` (no direct `sendSprinkleLick`).
- `tray-sync-protocol`: the generic `lick` message round-trips.

Per-package coverage floors must hold (`webapp` global default; see root `CLAUDE.md`).

## Docs

- Root `CLAUDE.md` (Licks / Tray addendum), `packages/webapp/CLAUDE.md` (Tray Sync),
  `packages/chrome-extension/CLAUDE.md` (offscreen follower wiring).
- `docs/architecture.md` tray protocol matrix — add the generic `lick` message and the
  follower-origin stamping note.
- `packages/ios-app/CLAUDE.md` — record the deferred iOS migration to the generic
  envelope.
- Handoff `SKILL.md` (`packages/vfs-root/workspace/skills/handoff/`) only if the
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

## Verify during implementation

- Whether the **standalone page/CLI follower** runs a navigation watcher and a
  `lickManager` at all. If it does, the chokepoint fixes it identically; if it has no
  `lickManager`, the navigate lick cannot originate there anyway.
- Confirm `ConnectedFollower.floatType` is populated for every follower runtime string
  (`slicc-extension-offscreen`, `slicc-ios`, standalone page) so `labelFor` has a
  sensible mapping with a safe default.

## Follow-ups (out of scope)

1. Per-follower response routing (approval card / `sprinkle.update` to the originating
   follower only) using `originFollowerId`.
2. iOS migration from `sprinkle.lick` to the generic `lick` envelope.
3. Queue-until-reconnect for forwarded licks.
4. Optionally always skip cone bootstrap in follower mode (removes the dormant phantom
   cone entirely).
