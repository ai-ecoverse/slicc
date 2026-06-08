# SP4 — Workflow progress: subscription bridge + minimal dip (design)

**Status:** Draft for review
**Date:** 2026-06-08
**Branch:** `worktree-workflow-executor`
**Author:** Karl + Claude (Opus 4.8)
**Depends on:** SP2 (`WorkflowRunManager.observeRun` + run-state). Complements SP3.

## 1. Goal

Make a running workflow's progress **visible** — a minimal inline glance out of the box, and **arbitrarily rich via opt-in sprinkles** — without hardcoding a fixed `/workflows` panel. The real deliverable is a **progress subscription bridge**; UI is composable, per SLICC's "skills/sprinkles over hardcoded features."

## 2. Scope

**In:**

- **Progress subscription bridge** — any `.shtml` (sprinkle or dip) can subscribe to a `runId` and receive live progress snapshots (`{status, currentPhase, agentsStarted, agentsDone, logs, finishedAt, preview}`) pushed as SP2's `observeRun` fires. Dual-mode (standalone page + extension offscreen→panel via the existing sprinkle sync).
- **Minimal built-in glance** — a **lightweight inline dip**, **injected by the run manager** when a run starts (decided 2026-06-08; not skill-dependent), that subscribes to the run and renders a compact, in-place-updating view (current phase + agent counts + status). No dedicated task-panel element.
- **Extensibility** — a workflow or skill can ship its **own** progress sprinkle subscribing to the same stream (a richer `/workflows`-style panel, a custom dashboard, etc.).

**Out:** a fixed/bundled `/workflows` tab; a task-panel UI element; pause/stop/restart **controls** (SP5 owns those; SP4 only *displays* — though a workflow's own sprinkle may add control buttons once SP5 exposes the commands).

## 3. Architecture

### Subscription bridge

SP2 exposes `observeRun(runId, handler)`. SP4 adds a **bridge** that connects that stream to the **existing** sprinkle/dip push mechanisms — **codex review corrected the wire shapes** (the earlier "route like sprinkle licks / a new `wf-progress` shape" was wrong: sprinkle licks go to the *cone/agent* handler, not a UI subscription, and `wf-progress` isn't an existing push):

- **panel→host (subscribe):** route through the **sprinkle bridge op channel** (`ui/sprinkle-bridge.ts` / the offscreen `sprinkle-proxy`), **not** the lick path — a `subscribe-workflow`/`unsubscribe-workflow` op handled host-side by the bridge (so it reaches the run manager, not the cone).
- **host→panel (push):** reuse the **real** shapes — for sprinkles, `SprinkleManager.sendToSprinkle(name, data)` → `slicc.on('update')`; for dips, the existing `slicc-*` host-push / `broadcastToDips` channel (dips already support host→panel push — the earlier "lick-only/post-stream" claim was stale).
- **Subscription identity + cleanup (codex review):** a subscription is keyed by `{ runId, subscriberId }` (a sprinkle name or a dip instance id), **not** `runId` alone — multiple panels can watch one run. The consumer's dispose path **must** drop its `observeRun` listener (anonymous dips broadcast today, so SP4 adds explicit per-subscriber teardown to avoid leaked observers).
- **Coalescing (codex review):** `sendToSprinkle`/the bridge have no coalescing and the tray fan-out broadcasts every update — so the bridge **throttles/coalesces** snapshots (e.g. trailing-edge per animation frame / ~250 ms) and sends `logs` as deltas, not the full array each tick.
- **Dual-mode (corrected path):** standalone worker→page uses the **BroadcastChannel sprinkle bridge** (`scoops/sprinkle-bridge-channel.ts`); extension offscreen→panel uses the **`sprinkle-proxy`** + side-panel op handler. (The tray `sprinkle.update` path is *remote follower replication*, not this local path — do not use it.)

The bridge is the entire reusable surface — the minimal dip and any workflow-provided sprinkle are just consumers of it.

### Minimal built-in dip

When a non-blocking run starts, the **run manager injects** a small ` ```shtml ` progress dip into the chat (decided 2026-06-08 — reliable, not dependent on the model emitting it). The dip subscribes (via the sprinkle bridge op) and renders snapshots in place via the dip `slicc-*` push channel.

**Injection path (codex review):** a worker/offscreen→chat dip injection is needed; the precedent is the page-side `postDipReference` used by onboarding (`ui/onboarding-orchestrator.ts`). SP4 wires the run manager's launch to that path (worker/offscreen → page → chat). Dips already support host→panel push (`slicc-*`/`broadcastToDips`), so **no new inline-sprinkle primitive is invented** (the earlier "lightweight inline sprinkle" idea is dropped — `SprinkleManager.open()` makes a tab/panel, not an inline element; the inline `.shtml` primitive *is* the dip).

### Components (files)

| Unit | File | Responsibility |
| --- | --- | --- |
| progress bridge | `ui/workflow-progress-bridge.ts` (new) | Wire `observeRun` ↔ the **real** sprinkle/dip push channels (subscribe via the sprinkle-bridge op; push via `sendToSprinkle`/`slicc.on('update')` and dip `slicc-*`/`broadcastToDips`); coalesce; dual-mode via `sprinkle-proxy`/BroadcastChannel. |
| dip live push | `ui/dip.ts` (modify) | Render progress pushes for the minimal glance via the existing dip `slicc-*` channel. (No new inline-sprinkle primitive — dropped.) |
| minimal dip injection | run manager → `postDipReference`-style path | The run manager **injects** the compact progress dip into the chat on launch (not the cone/skill). |

## 4. Data flow

```
workflow run (non-blocking) → run starts (SP2)
  → run manager INJECTS a progress dip into the chat (postDipReference-style) that subscribes (runId)
  → bridge: observeRun(runId) → coalesced snapshots → dip slicc-* push → renders live (phase, n/m agents, status)
  → run settles → terminal push → dip shows final status (+ link to /shared/workflow-runs/<id>.json)

(optional) a workflow/skill ships its own sprinkle → subscribe(runId) via the bridge op → same stream → richer UI
```

## 5. Testing

- **Bridge:** `wf-subscribe` yields an initial snapshot then one push per `observeRun` tick; `wf-unsubscribe` stops pushes; `wf-done` on settle.
- **Dip/sprinkle render:** a subscribing panel updates in place as snapshots arrive (mock the bridge).
- **Dual-mode:** standalone page path and the extension offscreen→panel sprinkle-sync path both deliver `wf-progress`.

## 6. Documentation

- The sprinkles skill (`packages/vfs-root/workspace/skills/sprinkles/`) — document the workflow progress subscription API so authors can build their own progress sprinkles.
- `docs/architecture.md` — the progress bridge + its place in the sprinkle/dip stack.
- `packages/vfs-root/shared/CLAUDE.md` — how to subscribe to a run's progress from a sprinkle.

## 7. Non-goals (SP4)

A fixed `/workflows` tab; a task-panel element; pause/stop/restart controls (SP5); historical/run-list browsing UI beyond `workflow list` (SP2 text).

## 8. Open questions (resolve during planning)

1. ~~Dip vs. inline sprinkle~~ — **resolved:** use the existing dip `slicc-*` push; the inline-sprinkle idea is dropped.
2. ~~Who emits the dip~~ — **resolved:** the run manager **injects** it (not the cone/skill).
3. Exact coalescing cadence (e.g. trailing-edge ~250 ms) and `logs`-as-deltas wire format — tune during planning.
