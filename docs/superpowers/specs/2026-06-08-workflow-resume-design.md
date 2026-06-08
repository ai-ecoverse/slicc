# SP5 — Workflow resume, pause & restart-agent (CC parity, within-session) (design)

**Status:** Draft for review
**Date:** 2026-06-08
**Branch:** `worktree-workflow-executor`
**Author:** Karl + Claude (Opus 4.8)
**Depends on:** SP1 (the determinism guard) and SP2 (the run manager + exec-tap). Optional UI buttons via SP4.

## 1. Goal

Claude-Code-parity run control, **within the session**: **resume** a stopped/interrupted run by re-running its deterministic script and short-circuiting already-completed agents from a cache; **pause/resume** a live run; and **restart a single agent**. No cross-session persistence (a reload restarts fresh, exactly like quitting CC).

## 2. Scope

**In:** within-session resume (deterministic-replay + result cache); pause/resume; restart-agent. New `workflow` subcommands: `resume`, `pause`, `restart`.

**Out:** cross-session/IndexedDB persistence (deferred — a browser-reload-resilient variant is a separate, larger follow-up); approval card; budget token pool.

## 3. The key idea: deterministic replay + a call-indexed cache

SP1's determinism guard (`Date.now`/`Math.random`/argless `new Date()` throw) guarantees that **re-executing the same script initiates the same `agent()` calls, in the same order, with the same `(prompt, opts)`.** Even with `parallel`/`pipeline` concurrency, *initiation order* is deterministic (array/program order); only *completion* order varies. So we key the cache by **initiation index**, assigned synchronously at `agent()` entry.

- **Prelude (modify):** at the top of `agent()` (before any `await`), `const __idx = __nextIdx++`; pass it on the spawn argv as `--call-idx <N>`.
- **Run manager (modify):** maintain `cache: Map<number, result>` per run. On an `agent` spawn from the exec-tap: if `cache.has(idx)` → return the cached result immediately (no scoop). Else spawn live, then `cache.set(idx, result)`.
- **Resume:** `workflow resume <runId>` re-invokes `executeJsCode` with the **same code** and the **existing cache** attached. Completed agents (cached) return instantly; only the unfinished ones run live. Determinism makes the indices line up across the original run and the resume.
- **Safety check:** alongside `idx`, the spawn carries a short hash of `(prompt, opts)`; if a cached entry's hash mismatches on resume (script edited, non-determinism leaked), the manager treats it as a miss and re-runs that agent (logged), rather than returning a stale result.

## 4. Pause / resume

Pause is **cooperative and lives entirely in the run manager's exec-tap** (no prelude change): while a run is `paused`, the tap **holds new `agent` spawns** (awaits a resume signal before forwarding to the real `exec.spawn`); in-flight scoops finish. `pause`/`resume` flip the flag and (on resume) release the held spawns. This needs no realm cooperation because the tap already mediates every spawn.

- `workflow pause <runId>` → `status='paused'`; queued/holding spawns wait.
- `workflow resume <runId>` → release holds; if the run had fully stopped (process gone), re-run with the cache (§3).

## 5. Restart-agent

`workflow restart <runId> <callIdx>` invalidates `cache[callIdx]` and re-spawns that one agent live; the new result replaces the cache entry and (if the run is still live and awaiting it) resolves the pending `agent()`; if the run already settled, restarting re-runs from that point via the resume path. Targets a failed/`null`/stuck agent.

## 6. Components (files)

| Unit | File | Responsibility |
| --- | --- | --- |
| call-index | `shell/supplemental-commands/workflow-prelude.ts` (modify) | Assign `__nextIdx++` per `agent()` call; pass `--call-idx`/hash on the spawn argv. |
| cache + replay | `scoops/workflow-run-manager.ts` (modify) | Per-run `Map<idx,result>` + hash check; resume = re-run with the cache; tap returns cached results. |
| pause gate | `scoops/workflow-run-manager.ts` (modify) | Exec-tap holds `agent` spawns while paused; release on resume. |
| restart | `scoops/workflow-run-manager.ts` (modify) | Invalidate one cache entry + re-spawn. |
| commands | `shell/supplemental-commands/workflow-command.ts` (modify) | `resume` / `pause` / `restart` subcommands. |
| (optional) UI controls | SP4 sprinkle | Buttons that emit licks → these commands. |

## 7. Data flow (resume)

```
run interrupted (stop / agent crash) — cache holds completed agents' results (by call-idx)
  → workflow resume <runId>
       → executeJsCode(sameCode, …) again   (determinism guard ⇒ same call sequence)
       → agent() #k → exec.spawn(['agent','--call-idx',k,…])
            → tap: cache.has(k)? → return cached result (no scoop)   : spawn live → cache.set(k)
       → only unfinished agents run live → run completes → result delivered (SP2 path)
```

## 8. Error handling

- **Hash mismatch on resume** (edited script / leaked nondeterminism) → cache miss for that idx, re-run live, log a warning. No stale results.
- **Restart of an already-settled run** → routes through resume (re-run from the invalidated point).
- **Pause then teardown** → in-memory state lost (no cross-session persistence — by scope); completed result files persist on the VFS.

## 9. Testing

- **Replay cache:** a resumed run does **not** re-spawn cached agents (assert spawn count), returns identical results, and finishes the unfinished ones.
- **Determinism alignment:** two runs of the same script initiate `agent()` calls with identical `--call-idx` sequences; a hash mismatch forces a re-run.
- **Pause/resume:** pausing holds new spawns (no new scoops start) while in-flight finish; resume releases them.
- **Restart-agent:** invalidates exactly one cache entry and re-spawns only that agent.

## 10. Documentation

- `docs/shell-reference.md` — `workflow resume`/`pause`/`restart`.
- `docs/architecture.md` — the resume model (deterministic replay + call-indexed cache; why the SP1 guard exists).
- `packages/vfs-root/shared/CLAUDE.md` — note that runs are resumable within a session and the determinism rules that make it work.

## 11. Non-goals (SP5)

Cross-session / IndexedDB persistence (separate follow-up); approval card; budget token pool; the reach features (nested `workflow()`, model routing, `agentType`, bundled `/deep-research`).

## 12. Open questions (resolve during planning)

1. `(prompt, opts)` hash function + how strict the mismatch policy is.
2. Restart-agent semantics when the run is still live and concurrently awaiting that index (replace in place vs. resume-from-point).
3. Whether pause should also surface to a workflow's progress sprinkle (SP4) as a `paused` status (it should — it's already in `WorkflowRunState.status`).
