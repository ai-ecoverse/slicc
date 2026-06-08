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
- **Minimal built-in glance** — a **lightweight inline dip** the cone emits when it launches a workflow: a small ` ```shtml ` block that subscribes to the run and renders a compact, in-place-updating view (current phase + agent counts + status). No dedicated task-panel element.
- **Extensibility** — a workflow or skill can ship its **own** progress sprinkle subscribing to the same stream (a richer `/workflows`-style panel, a custom dashboard, etc.).

**Out:** a fixed/bundled `/workflows` tab; a task-panel UI element; pause/stop/restart **controls** (SP5 owns those; SP4 only *displays* — though a workflow's own sprinkle may add control buttons once SP5 exposes the commands).

## 3. Architecture

### Subscription bridge

SP2 exposes `observeRun(runId, handler)`. SP4 adds a **bridge** that connects that stream to the sprinkle/dip postMessage channel:

- panel→host: `wf-subscribe { runId }` / `wf-unsubscribe { runId }` (routed like existing sprinkle licks).
- host→panel: `wf-progress { runId, state }` — an initial snapshot on subscribe, then one per `observeRun` tick (status/phase/agent counts/logs/preview), and a terminal `wf-done` when the run settles.
- Dual-mode: standalone wires it page-side; extension routes via the existing offscreen→panel sprinkle sync (`SprinkleManager.sendToSprinkle` / the follower-sync sprinkle.update path), so progress reaches a panel sprinkle the same way sprinkle content already does.

The bridge is the entire reusable surface — sprinkles and the minimal dip are just two consumers of it.

### Minimal built-in dip

When a non-blocking, cone-origin run starts, the cone's turn (guided by the SP3 skill, or auto-injected by the run manager) includes a small ` ```shtml ` progress block that calls `wf-subscribe(runId)` and renders the snapshots in place.

**Honest nuance (resolve in planning):** dips today have a *minimal, lick-only, post-stream* bridge (`ui/dip.ts`) — host→dip *push* of live progress is a small extension. Two clean options: (a) extend the dip bridge with the `wf-progress` push channel; or (b) make the minimal glance a **lightweight inline sprinkle** (sprinkles already have host→panel push via `sendToSprinkle`) rendered compactly. Planning picks the lighter path; the user-facing intent is identical — a minimal, inline, live progress view, no task-panel.

### Components (files)

| Unit | File | Responsibility |
| --- | --- | --- |
| progress bridge | `ui/workflow-progress-bridge.ts` (new) | Wire `observeRun` ↔ the sprinkle/dip channel (`wf-subscribe`/`wf-progress`/`wf-unsubscribe`); dual-mode. |
| dip live channel | `ui/dip.ts` (modify) **or** a lightweight inline sprinkle | Receive `wf-progress` pushes for the minimal glance (per the nuance above). |
| minimal dip template | bundled helper / the SP3 skill | The compact ` ```shtml ` the cone emits on launch. |

## 4. Data flow

```
workflow run (cone-origin, non-blocking) → run starts (SP2)
  → cone turn includes a progress dip:  ```shtml … wf-subscribe(runId) … ```
  → bridge: observeRun(runId) → wf-progress snapshots → dip renders live (phase, n/m agents, status)
  → run settles → wf-done → dip shows final status (+ link to /shared/workflow-runs/<id>.json)

(optional) a workflow/skill ships its own sprinkle → wf-subscribe(runId) → same stream → richer UI
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

1. Dip live-push vs. lightweight inline sprinkle for the minimal glance (the §3 nuance).
2. Snapshot cadence / coalescing (avoid flooding on large fan-outs — throttle `wf-progress`).
3. Who emits the minimal dip — the SP3 skill instructs the cone, or the run manager auto-injects it on cone-origin launches.
