# SP2 — Background workflow runs (non-blocking + progress + async result) (design)

**Status:** Draft for review
**Date:** 2026-06-08
**Branch:** `worktree-workflow-executor`
**Author:** Karl + Claude (Opus 4.8)
**Depends on:** SP1 (`2026-06-08-workflow-executor-design.md`) — the executor, prelude, `agent()` bridge, and `workflow` command. SP2 layers on top; **SP1 needs no changes to be SP2-compatible** (validated below).

## 1. Goal

Make a workflow run **without blocking the cone**: launch it in the background, report **live progress**, and deliver the **final result asynchronously** as a new cone turn — matching Claude Code's model ("a background runtime executes the script while your session stays responsive… results arrive as a message").

## 2. Scope (settled with the user 2026-06-08)

**In:** the non-blocking trio.

- **Non-blocking launch** — `workflow run` returns a `runId` immediately (cone/terminal stays free). `--wait` keeps SP1's blocking/foreground behavior.
- **Live progress** — the run emits agent-level + `phase`/`log` events while it runs, collected into a run-state model and exposed via `workflow status`/`workflow list` and an `observeRun` subscription.
- **Async result delivery** — on completion, the full result is written to a VFS file and a **path + preview** is delivered to the cone as a new turn.

**Out (deferred suites, not this spec):** resume; cross-session persistence of in-flight runs; pause/resume/restart-agent; the pre-launch approval card; the full `budget` token pool (still the SP1 stub). The **rich `/workflows` progress sprinkle + task-panel UI is SP4** — SP2 only emits the events/state it consumes.

## 3. Relationship to SP1 (no SP1 changes required)

SP2 reuses SP1 wholesale and confirms its forward-compat seams:

- **Result channel:** SP2's run manager reads the same `executeJsCode` stdout and extracts the value with SP1's `splitSentinel`. Unchanged.
- **Progress seam:** SP1's `phase`/`log` already emit `WFPHASE`/`WFLOG` markers. SP2 adds a *parallel* fire-and-forget `exec(['__wf_progress', …])` emit in the prelude so progress is tappable live (see §5). The `console.log` markers remain (for `--wait`/terminal stdout). This is a one-file prelude edit, additive.
- **Command:** SP1's `workflow run` owns the `executeJsCode` call; SP2 refactors it to **delegate to the run manager** (`start` returns a `runId`). `--wait` preserves the SP1 path. A natural SP2 change, not an SP1 prerequisite.

## 4. Existing substrate (reused, not rebuilt)

- **`ProcessManager`** — the realm is already a tracked background pid; `start` simply does not `await` it. `workflow stop` = `kill -KILL <pid>` (already wired).
- **`executeJsCode` / realm runner** — unchanged; runs the SP1 code in the dual-mode realm.
- **`AgentBridge` / the `agent` command** — `agent()` already routes through `exec.spawn`; SP2 taps that boundary for progress (no bridge change).
- **`LickManager`** (`scoops/lick-manager.ts`) — the established "external event → cone turn" mechanism (webhook/cron/navigate/cherry). **`workflow` is not a lick channel today** (codex review: absent from `LickEvent['type']`, `EXTERNAL_LICK_CHANNELS`, and the formatter — forcing it through falls back to the cron formatter). SP2 must **register it explicitly**: add `'workflow'` to `LickEvent['type']` and `EXTERNAL_LICK_CHANNELS` (`scoops/lick-formatting.ts`) and add a `formatLickEventForCone` case. Then delivery uses the same dispatch path as webhook/cron.
- **Scoop-completion pattern** (`/shared/scoop-notifications/`) — the precedent for "write the full output to a VFS path, hand the cone a path + preview." SP2 mirrors it at `/shared/workflow-runs/`.
- **Offscreen durability** — the run manager lives in the durable realm (offscreen/worker), exactly like the Orchestrator + `AgentBridge`; the side panel proxies to it.

## 5. Architecture

A new **`WorkflowRunManager`** in the durable realm (kernel worker standalone / offscreen extension), published on `globalThis.__slicc_workflows` (mirroring `AgentBridge`'s `__slicc_agent`), and constructed in `kernel/host.ts`.

### `WorkflowRunManager` API

```ts
interface WorkflowRunManager {
  start(opts: {
    code: string;            // SP1-built prelude+transform output
    name: string | null;     // from parseMetaBanner
    filename: string;
    origin: { kind: 'cone'; jid: string } | { kind: 'terminal' };
    ctx: CommandContext;     // base context; the manager wraps ctx.exec to tap progress
  }): Promise<{ runId: string }>;            // resolves as soon as the run is launched
  getRun(runId: string): WorkflowRunState | null;
  listRuns(): WorkflowRunState[];
  observeRun(runId: string, handler: (s: WorkflowRunState) => void): () => void;
}

interface WorkflowRunState {
  id: string;
  name: string | null;
  source: string;                 // the original user script (so SP3 `workflow save` can persist it)
  origin: 'cone' | 'terminal';
  status: 'running' | 'paused' | 'done' | 'error' | 'killed';  // 'paused' used by SP5
  currentPhase: string | null;
  agentsStarted: number;
  agentsDone: number;
  logs: string[];                 // phase/log lines, in order
  startedAt: string;
  finishedAt: string | null;
  resultPath: string | null;      // /shared/workflow-runs/<id>.json when done
  preview: string | null;         // short string preview of the result
  error: string | null;
  pid: number | null;             // for `kill -KILL <pid>`
}
```

### Non-blocking launch

`start` calls `executeJsCode(code, ['workflow', filename], wrappedCtx, …)` **without awaiting**, stashes the promise, and attaches `.then`/`.catch` for completion. The realm is a background `ProcessManager` pid. **Pid capture (codex review):** `executeJsCode` returns only `{stdout,stderr,exitCode}` and `runInRealm` creates the pid internally, so the manager captures it via a scoped **`ProcessManager.on('spawn')`** listener around the launch (or a small `executeJsCode` option that surfaces the pid) → `runState.pid`, used by `workflow stop` (`kill -KILL`). `start` resolves with the `runId` as soon as the run is registered — the command returns immediately.

**Stop semantics (codex review):** `kill -KILL <pid>` terminates the **realm**, but in-flight `agent()` calls are host-side awaits (`AgentBridge.spawn`→`orchestrator.sendPrompt`) that the realm teardown does **not** cancel. SP2 stop therefore means *no new agents start; already-spawned scoops run to completion (their results are discarded)*; true mid-flight cancellation is backlog. Held/pending tap promises are rejected on stop.

**Per-run exec isolation (codex review):** a backgrounded run keeps calling back into `ctx.exec` after `workflow run` returned, and `WasmShellHeadless` mutates shared `lastEnv`/`cwd` (no general reentrancy guard). The manager gives each run its **own exec context / shell instance** (or serializes access) so a background run can't corrupt the foreground shell's state.

`--wait` (foreground): `start({ wait: true })` awaits completion and the command prints the result, i.e. SP1's behavior, for scripts/tests.

### Progress tap (Approach A — exec boundary, no realm changes)

The manager wraps **`ctx.exec`** for the run's context (codex review: `realm-host` `dispatchExec('spawn')` lowers the realm-side `exec.spawn(argv)` to **`ctx.exec(cmd, {args})`** — wrapping `ctx.exec.spawn` would observe nothing). The realm's `agent()` and `phase`/`log` both reach the host through that `ctx.exec` call:

- `argv[0] === 'agent'` → `agentsStarted++`; parse `--phase`/label if present; call the real `exec.spawn`; on settle `agentsDone++`; pass the result through unchanged.
- `argv[0] === '__wf_progress'` → `argv[1]` is `'phase'|'log'`, `argv[2]` the text → update `currentPhase` / append to `logs`; return `{stdout:'',stderr:'',exitCode:0}` **without** invoking a real command.
- anything else → pass through to the real `exec.spawn`.

Each mutation fires the `observeRun` handlers. The prelude change (SP2): `phase`/`log` additionally `__wfProgress(kind, text)` (a captured fire-and-forget `exec.spawn(['__wf_progress', kind, text])`), keeping the existing `console.log` markers. A trivial no-op **`__wf_progress` command** is added so untapped contexts (SP1 `--wait`, plain terminal) don't error.

### Result delivery (path + preview)

On completion the manager:

1. `splitSentinel(result.stdout)` → `{ result, log }` (SP1 helper).
2. Writes `/shared/workflow-runs/<id>.json` = `{ name, status, result, logs, startedAt, finishedAt }`; sets `resultPath`, `preview` (first ~200 chars of the stringified result), `status`.
3. **Delivery by origin:**
   - **cone-origin** → fire a **`workflow` lick** carrying `{ runId, name, resultPath, preview }`. `LickManager` delivers it as a new cone turn; `formatLickEventForCone` renders `[Workflow: <name>] complete — <preview>. Full result: <resultPath>`. The cone reads the file only if it needs the whole thing (context-frugal).
   - **terminal-origin** → no cone turn; the result is available via `workflow status <id>` and the file.
4. Errors (non-zero exit / thrown body / SIGKILL) set `status='error'|'killed'`, write the error into the file, and (cone-origin) deliver an error notification the same way.

### Command surface (SP2)

```
workflow run <file.js> [--args <json>] [--budget N] [--concurrency K] [--wait]
workflow status <runId>      # one run's state + preview/result path
workflow list                # table of recent runs (id, name, status, agents, started)
```

`workflow run` defaults to non-blocking → prints `▶ workflow '<name>' started (run <id>). Watch: workflow status <id>`. With `--wait` it blocks and prints the result (SP1 behavior). **Origin (codex review):** `getParentJid()` returns the owning jid for *both* the cone and non-cone scoops, so "has a parent" ≠ "cone-origin". Classify `origin='cone'` only when the parent jid **is the cone's jid** (compare against the orchestrator's cone jid); otherwise `'terminal'` (no parent) or `'scoop'` (a non-cone scoop launched it — treat like terminal: no cone turn, surfaced via `workflow status`).

### Dual-mode / durability

The run manager lives in the **offscreen** document (extension) / kernel worker (standalone), published via `kernel/host.ts` on `globalThis.__slicc_workflows`. **No panel→offscreen proxy is needed (codex review):** the panel terminal is already offscreen-backed (`RemoteTerminalView`→`TerminalSessionHost`), so `workflow run`/`status`/`list` typed there already execute in offscreen and reach `__slicc_workflows` directly — as do cone-invoked calls. Because the run + manager live in offscreen, a **backgrounded run survives a side-panel close**, and its result is **re-readable** after reopening via `workflow status` (the run manager + result file persist for the session).

## 6. Components (files)

| Unit | File | Responsibility |
| --- | --- | --- |
| `WorkflowRunManager` | `packages/webapp/src/scoops/workflow-run-manager.ts` (new) | Lifecycle: `start` (non-blocking), run-state registry, exec-tap wrapper, completion → file + lick, `getRun`/`listRuns`/`observeRun`. |
| run-manager publish | `packages/webapp/src/scoops/workflow-run-manager.ts` + `kernel/host.ts` | `publishWorkflowRunManager` on `__slicc_workflows` (no panel proxy — the panel terminal is already offscreen-backed). |
| `__wf_progress` command | `packages/webapp/src/shell/supplemental-commands/wf-progress-command.ts` (new) | No-op (exit 0) so the prelude's progress emit is safe in untapped contexts. |
| prelude progress emit | `packages/webapp/src/shell/supplemental-commands/workflow-prelude.ts` (modify) | `phase`/`log` also fire `exec.spawn(['__wf_progress', kind, text])` (fire-and-forget). |
| command | `packages/webapp/src/shell/supplemental-commands/workflow-command.ts` (modify) | Non-blocking default via the run manager; `--wait`; `status`/`list` subcommands; origin via `getParentJid`. |
| `workflow` lick | `packages/webapp/src/scoops/lick-manager.ts` + `scoops/lick-formatting.ts` (modify) | New lick type + cone-facing formatting for completion delivery. |

## 7. Data flow

```
workflow run wf.js            (non-blocking default)
   │ build code (SP1) ; origin = getParentJid() ? cone : terminal
   ▼
__slicc_workflows.start({ code, name, origin, ctx })     [run manager, durable realm]
   │ register runState(id, status:'running') ; capture pid via pm.on('spawn') ; wrap ctx.exec
   │ executeJsCode(code, …, wrappedCtx)   ← NOT awaited (background pid)
   └─▶ returns { runId }  ──▶ command prints "▶ started run <id>"   (cone turn ends)
        ⋮ (run continues in background)
   realm: agent(...) → exec.spawn(['agent',…]) → wrapper: agentsStarted++ → real spawn → scoop → agentsDone++
   realm: phase/log    → exec.spawn(['__wf_progress',…]) → wrapper: currentPhase/logs += → observeRun()
        ⋮
   executeJsCode resolves (realm-done)
   │ splitSentinel(stdout) → {result, log}
   │ write /shared/workflow-runs/<id>.json ; status='done' ; preview
   ├─ origin cone → LickManager.fire('workflow', {runId,name,resultPath,preview}) → NEW CONE TURN
   └─ origin terminal → (no turn) ; workflow status <id> shows it
```

## 8. Error handling

- **Body throw / non-zero exit** → `status='error'`; error captured in the file + `runState.error`; cone-origin delivers an error notification.
- **SIGKILL (`kill -KILL <pid>`)** → `status='killed'`; partial state retained; cone-origin notified.
- **Worker/offscreen teardown mid-run** → in-flight run state is lost (in-memory; resume/persistence is out of scope, matching CC's "exiting restarts fresh"). Completed runs' **result files persist** on the VFS.
- `__wf_progress` failures never affect the run (fire-and-forget; wrapper/​no-op swallow).
- No silent success: a run that produced no sentinel result is `status='error'` with a clear message.

## 9. Testing

Vitest, mirroring `packages/webapp/tests/`.

- **Unit — run manager:** `start` returns a `runId` without awaiting completion; status transitions `running → done`; `observeRun` fires on progress; the exec-tap increments `agentsStarted/Done` for `agent` argv and records `currentPhase`/`logs` for `__wf_progress` argv; on completion the result file is written and `preview` set; **cone-origin fires a `workflow` lick, terminal-origin does not**.
- **Unit — prelude:** `phase`/`log` emit both the `console.log` marker **and** `exec.spawn(['__wf_progress',…])` (extend the SP1 prelude test).
- **Unit — command:** non-blocking default returns the `runId` line immediately; `--wait` blocks and prints the result; `status`/`list` render run state; origin derived from `getParentJid`.
- **Integration:** background a fan-out workflow (mock `agent`), poll `getRun` until `done`, assert the result file contents, that `agentsDone` advanced past 1 concurrently, and (cone-origin) that a `workflow` lick was delivered with the path + preview.
- **Dual-mode:** in the extension, panel-terminal `workflow run`/`status`/`list` already execute in offscreen (no proxy) and reach `__slicc_workflows`; the manager logic is float-agnostic. Test the manager in a worker context + assert the offscreen path reaches it.

## 10. Documentation

- `docs/shell-reference.md` — update `workflow` (non-blocking default, `--wait`, `status`, `list`).
- `docs/architecture.md` — add `WorkflowRunManager` + the `workflow` lick to the subsystem/lick inventories.
- root + `packages/webapp` `CLAUDE.md` — note the run manager + `__slicc_workflows`.
- `packages/vfs-root/shared/CLAUDE.md` — agent-facing: workflows now run in the background and report completion as a new turn (path + preview); how to read `/shared/workflow-runs/<id>.json`.

## 11. Non-goals (SP2)

Resume; cross-session persistence of in-flight runs; pause/resume/restart-agent; the pre-launch approval card; the full `budget` token pool; the rich `/workflows` progress sprinkle + task-panel (SP4); `agent()` `model` routing / `agentType` / real nested `workflow()` (SP5).

## 12. Open questions (resolve during planning)

1. **Lick delivery:** confirm `LickManager` can deliver a synthetic `workflow` lick that triggers a cone turn the same way `webhook`/`cron` do (it should — same dispatch path).
2. ~~Exec-tap point~~ — **resolved (codex review):** `dispatchExec('spawn')` lowers to `ctx.exec(cmd,{args})`, so the tap wraps **`ctx.exec`** (not `ctx.exec.spawn`).
3. **runId format + `workflow list` columns** (cosmetic).
4. ~~Panel proxy generalization~~ — **resolved (removed):** the panel terminal is already offscreen-backed, so no `__slicc_workflows` proxy is needed.
