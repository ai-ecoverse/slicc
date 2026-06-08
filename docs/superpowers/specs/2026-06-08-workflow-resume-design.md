# SP5 — Workflow resume, pause & restart-agent (CC parity, within-session) (design)

**Status:** Draft for review
**Date:** 2026-06-08
**Branch:** `worktree-workflow-executor`
**Author:** Karl + Claude (Opus 4.8)
**Depends on:** SP1 (the determinism guard) and SP2 (the run manager + exec-tap). Optional UI buttons via SP4.

## 1. Goal

Claude-Code-parity run control, **within the session**: **resume** a stopped/interrupted run by re-running its deterministic script and short-circuiting already-completed agents from a **best-effort, content-keyed cache** (codex review: see §3 — user-space determinism is soft, so resume re-runs on ambiguity rather than risking stale results); **pause/resume** a live run; and **restart a single agent**. No cross-session persistence (a reload restarts fresh, exactly like quitting CC).

## 2. Scope

**In:** within-session resume (deterministic-replay + result cache); pause/resume; restart-agent. New `workflow` subcommands: `resume`, `pause`, `restart`.

**Out:** cross-session/IndexedDB persistence (deferred — a browser-reload-resilient variant is a separate, larger follow-up); approval card; budget token pool.

## 3. The key idea: deterministic replay + a **best-effort content-keyed cache**

> **Codex review correction (2026-06-08):** a monotonic initiation index is **not** a stable
> cache key. SP1's `pipeline` is _streaming_ — a later stage's `agent()` is initiated in
> prior-stage **completion** order, not array order; and on replay, cache hits resolve instantly
> while misses resolve later, so the interleaving (and thus any counter) shifts between the
> original run and the resume. We therefore key by **content**, not by call order, and accept
> that resume is **best-effort** (the user-space determinism guard is soft — §1, SP1 §6).

- **Cache key = a hash of the agent call's full effective context**, not just the prompt:
  `hash(prompt, canonical(opts.schema), opts.model, opts.agentType, __agentCwd, allowedCommands)`.
- **Uniqueness rule (codex review — no ordinals).** An occurrence ordinal (`key#n`) is _not_
  safe: when two identical calls replay in swapped order, both `key#1` and `key#2` already exist,
  so neither is "unseen" and the tap could return the wrong cached result. So: **only cache a
  content hash that is UNIQUE within the run.** If the same hash occurs ≥2 times, mark it
  **non-cacheable** → every such call **re-runs live** on resume. This _guarantees_ never-stale;
  the cost is re-running legitimately-identical repeated calls (rare — the determinism guidance is
  to vary prompts/labels by index, which makes them distinct).
- **Limitation (codex review — document, don't hide):** the hash covers the _call params_ but
  **cannot** cover agent-visible **workspace/VFS state**. A source-identical resume _after the
  workspace changed_ can return a result computed against the old state. This is an explicit
  best-effort limitation, not a correctness guarantee.
- **Prelude (modify):** at `agent()` entry compute the content hash and pass it on the spawn argv
  (`--call-key <hash>`).
- **Run manager (modify):** `cache: Map<string, result>` of **unique** keys per run (+ a set of
  keys seen ≥2× = non-cacheable). The exec-tap (which wraps **`ctx.exec`**, per SP2): cached &
  unique → return it (no scoop); else spawn live.
- **Resume:** `workflow resume <runId>` re-runs the **stored source** with the **stored
  invocation inputs** — `WorkflowRunState` must retain not just `source` but `args`, `budget`,
  `concurrency`, and the prelude/sentinel version, so the replay is faithful. Cache hits
  short-circuit, everything else runs live.
- **Best-effort, never stale:** unique-key hit → reuse; duplicate/unseen-key/edited-source → re-run
  (logged). Reliable exact resume is a goal of the deferred realm-native hardening.

## 4. Pause / resume

Pause is **cooperative and lives entirely in the run manager's exec-tap** (no prelude change): while a run is `paused`, the tap **holds new `agent` spawns** (awaits a resume signal before forwarding to the real `ctx.exec` call — per SP2, the tap wraps `ctx.exec`); in-flight scoops finish. `pause`/`resume` flip the flag and (on resume) release the held spawns. This needs no realm cooperation because the tap already mediates every spawn.

- **Honest limit (codex review):** this is a _spawn gate_, not a true paused run — CPU work, non-`agent` awaits, and `phase`/`log` keep executing until the next spawn. Good enough for "stop spending on new agents."
- `workflow pause <runId>` → `status='paused'`; queued/holding spawns wait.
- `workflow resume <runId>` → release holds; if the run had fully stopped (process gone), re-run with the cache (§3).
- **Held-spawn release on kill (codex review):** if a paused run is killed, the manager must **reject** every held/pending tap promise (SIGKILL tears down the realm but does not settle host-side promises already parked in the tap).

## 5. Restart-agent

`workflow restart <runId> <callKey>` invalidates `cache[callKey]` and re-spawns that one agent. `callKey` is the **content hash** (only _unique_, cacheable keys are restartable — non-unique/duplicate calls aren't individually addressable, consistent with the §3 uniqueness rule). **Codex review — two regimes:**

- **Settled run (the supported path):** restart invalidates the cache entry and re-runs via the **resume** path (§3) from that point. Clean and naturally promise-compatible.
- **Live, already-resolved or in-flight call:** "replacing" a pending/awaited `agent()` result in place is **not supported by today's `AgentBridge`** — `spawn()` awaits `sendPrompt` and exposes **no jid / cancel handle / pending resolver** (`scoops/agent-bridge.ts`). Doing this needs **new bridge + run-manager control plumbing** (a cancel handle + a way to replace a pending tap promise). SP5 therefore scopes restart to the **settled-run resume path**; live in-place restart is **backlog** pending that plumbing.

## 6. Components (files)

| Unit                   | File                                                       | Responsibility                                                                                                                                                           |
| ---------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| call-key               | `shell/supplemental-commands/workflow-prelude.ts` (modify) | Compute the content hash per `agent()` call (prompt + canonical opts + cwd/model/allowed/agentType); pass `--call-key <hash>` on the spawn argv.                         |
| cache + replay         | `scoops/workflow-run-manager.ts` (modify)                  | Per-run `Map<string,result>` keyed by content hash + occurrence ordinal; resume = re-run stored source with the cache; tap returns cached results, re-runs on ambiguity. |
| pause gate             | `scoops/workflow-run-manager.ts` (modify)                  | Exec-tap holds `agent` spawns while paused; release on resume.                                                                                                           |
| restart                | `scoops/workflow-run-manager.ts` (modify)                  | Invalidate one cache entry + re-spawn.                                                                                                                                   |
| commands               | `shell/supplemental-commands/workflow-command.ts` (modify) | `resume` / `pause` / `restart` subcommands.                                                                                                                              |
| (optional) UI controls | SP4 sprinkle                                               | Buttons that emit licks → these commands.                                                                                                                                |

## 7. Data flow (resume)

```
run interrupted (stop / agent crash) — cache holds completed agents' results (by content key)
  → workflow resume <runId>
       → executeJsCode(stored source, …) again   (soft-deterministic replay)
       → agent() → exec.spawn(['agent','--call-key',hash,…]) → realm-host lowers to ctx.exec(...)
            → tap (wraps ctx.exec): cache.has(key#n)? → return cached (no scoop)
                                    : miss/ambiguous → spawn live → cache.set(key#n)
       → only unfinished/ambiguous agents run live → run completes → result delivered (SP2 path)
```

## 8. Error handling

- **Unseen key / edited script / non-unique hash** → not a cache hit, re-run live, log a warning. No stale results.
- **Restart of an already-settled run** → routes through resume (re-run from the invalidated point).
- **Pause then teardown** → in-memory state lost (no cross-session persistence — by scope); completed result files persist on the VFS.

## 9. Testing

- **Replay cache:** a resumed run does **not** re-spawn cached agents (assert spawn count), returns identical results, and finishes the unfinished ones.
- **Content-key stability:** two runs of the same deterministic script produce the same set of `--call-key` hashes regardless of completion-order interleaving; an unseen key or ordinal collision forces a live re-run (never a stale result).
- **Pause/resume:** pausing holds new spawns (no new scoops start) while in-flight finish; resume releases them.
- **Restart-agent:** invalidates exactly one cache entry and re-spawns only that agent.

## 10. Documentation

- `docs/shell-reference.md` — `workflow resume`/`pause`/`restart`.
- `docs/architecture.md` — the resume model (deterministic replay + best-effort content-keyed cache; why the SP1 guard exists).
- `packages/vfs-root/shared/CLAUDE.md` — note that runs are resumable within a session and the determinism rules that make it work.

## 11. Non-goals (SP5)

Cross-session / IndexedDB persistence (separate follow-up); approval card; budget token pool; the reach features (nested `workflow()`, model routing, `agentType`, bundled `/deep-research`).

## 12. Open questions (resolve during planning)

1. Exact content-hash function + canonicalization (schema/opts ordering) — keep it stable across runs.
2. ~~Live restart semantics~~ — **resolved:** restart is scoped to the settled-run resume path; live in-place restart is backlog (needs new `AgentBridge` cancel/replace plumbing) — see §5.
3. `paused` surfaces to SP4's progress view via `WorkflowRunState.status` (already in the SP2 enum).
