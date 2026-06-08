# SP1 — Workflow Executor + `agent()` bridge (design)

**Status:** Draft for review
**Date:** 2026-06-08
**Branch:** `worktree-workflow-executor`
**Author:** Karl + Claude (Opus 4.8)

## 1. Goal

Make SLICC run **Claude Code dynamic workflows** natively. A dynamic workflow is a
plain-JavaScript file — written by the agent on the fly — that orchestrates many
subagents at scale, while intermediate results stay in **script variables** instead of
the model's context window. Only the final synthesized value returns to the conversation.

This document specifies **SP1**, the keystone of a larger effort (see §3). SP1's done-line:

> Paste a Claude-Code-authored workflow `.js`, run it with `workflow run`, and get the
> correct final value — backed by **real SLICC scoops** — in **both** the standalone CLI
> float and the Chrome extension float.

SP1 is deliberately a **clean, usable POC**: a **blocking** `workflow run` command that
executes a **non-nesting** workflow to completion. No background execution, no resume, no
UI beyond streamed progress lines. Those are later sub-projects.

**Acceptance (the POC must clear this bar — settled with the user 2026-06-08):**

- A self-contained, deterministic **fan-out/verify workflow over repo files** (the test
  fixture) runs to completion via real scoops and returns the correct value — in **both** the
  standalone **and** extension floats (strict dual-mode at SP1, not standalone-first).
- `agent(prompt, {schema})` returns a **validated object** — the `StructuredOutput` path is
  **in scope for SP1**.
- **Real concurrency:** independent `agent()` calls run in parallel up to the cap, which
  **defaults to 4** for the POC (raisable via `--concurrency` toward `min(16, cores−2)`).
- **Stretch goal (not required to land):** a `/deep-research`-style script
  (Scope→Search→Fetch→Verify→Synthesize) runs, contingent on the spawned scoops having
  web/search tools available.

## 2. Fidelity decision (settled)

We replicate the **workflow-file runtime API faithfully**, so a CC-authored workflow runs
**unchanged**. We do **not** mirror the Claude *layout* (`.claude/workflows/`,
`~/.claude/projects/<session>/`) or the plugin/marketplace system — authoring, storage,
triggering, and UI stay **SLICC-native**.

Rationale: the runtime API is a small, stable, portable surface, and because the runtime
forbids imports/fs/shell inside the script, a CC workflow `.js` is **portable by
construction** the moment we implement the injected globals faithfully. The Claude layout
and plugins are a large, fast-moving compatibility burden that fights SLICC's browser-first
+ `*.jsh`-discovery philosophy and buys nothing for *running* the script.

**Portability boundary:** "runs unchanged" holds as long as the script uses only the
documented globals + stdlib. Known edges we treat as explicit gaps (not silent failures):
`agent()` opts we defer (`model`, real `isolation`/`agentType` nuances), the JSON-Schema
dialect for `{schema}`, and any *undocumented* globals.

## 3. Authoritative API contract (ground truth)

This is **not** reconstructed from blog posts (which are wrong — e.g. they describe
`pipeline` as a reduce). It was extracted verbatim from the `Workflow` tool's own authoring
spec embedded in the Claude Code binary, verified on **v2.1.168**
(`~/.local/share/claude/versions/2.1.168`, a single ~220 MB SEA executable;
`rg -a` / byte-offset slicing dumps the embedded spec strings).

A workflow is **plain JavaScript (not TypeScript)**, runs in an **async, deterministic,
no-fs / no-Node** sandbox, and must open with a **pure-literal** `meta`:

```js
export const meta = {
  name: 'review-changes',                                   // required
  description: 'one-line, shown in the permission dialog',  // required
  whenToUse: 'shown in the workflow list',                  // optional
  phases: [{ title: 'Review', detail: '…', model: '…' }],   // optional; titles matched to phase()
}
// body uses the injected globals below
```

### Injected globals

| Global | Signature & semantics |
| --- | --- |
| `agent` | `agent(prompt: string, opts?: {label?, phase?, schema?, model?, isolation?, agentType?}): Promise<any>`. No `schema` → final text string. With `schema` (JSON Schema) → subagent is **forced to call a `StructuredOutput` tool**, returns the validated object. Resolves **`null`** if the agent is skipped mid-run or dies after retries (`.filter(Boolean)`). `label` overrides display label; `phase` assigns a progress group (use inside concurrent stages to avoid races on global `phase()` state); `model` overrides the model for this call (default: inherit session model); `isolation:'worktree'` runs in an isolated workspace; `agentType` picks a named subagent from the Agent registry, composes with `schema`. |
| `pipeline` | `pipeline(items, stage1, stage2, …): Promise<any[]>`. **Streaming, per-item, NO barrier** — item A can be in stage 3 while B is in stage 1. **The default for multi-stage work.** Each stage callback receives `(prevResult, originalItem, index)`. A throwing stage drops that item to `null` and skips its remaining stages. |
| `parallel` | `parallel(thunks: Array<() => Promise<any>>): Promise<any[]>`. **Barrier** — awaits all. **Never rejects**; a failing thunk → `null` in the result array (`.filter(Boolean)`). Use only when you genuinely need all results together. |
| `phase` | `phase(title: string): void` — start a progress group; subsequent `agent()` calls group under it. |
| `log` | `log(message: string): void` — narrator line above the progress tree. |
| `args` | `any` — the value passed at invocation, verbatim (`undefined` if absent). Real JSON, never a stringified list. |
| `budget` | `{ total: number\|null, spent(): number, remaining(): number }` — shared token pool. `total` is `null` if no target. **Hard ceiling**: once `spent() ≥ total`, further `agent()` calls **throw**. Drives `while (budget.total && budget.remaining() > 50_000)` loops. |
| `workflow` | `workflow(name | {scriptPath}, args?): Promise<any>` — run a nested workflow, **one level only** (nesting inside a child throws); shares parent caps/counter/abort/budget. |

### Hard runtime constraints

- **Determinism guard:** `Date.now()`, `Math.random()`, and argless `new Date()` **throw** —
  so the run is replayable and therefore resumable. (Pass time via `args`; vary randomness by index.)
- **No filesystem / Node API** from the script. Only agents touch files/shell.
- **Concurrency cap:** `min(16, cores − 2)` concurrent agents per workflow; excess queue.
- **Total cap:** **1000** agents per run (runaway-loop backstop).
- **Per-call cap:** a single `parallel`/`pipeline` call accepts **≤ 4096** items (explicit error, not silent truncation).
- **`schema` path:** the subagent is forced to call `StructuredOutput`; validation at the
  tool-call layer; on mismatch the model retries; "completed without calling StructuredOutput
  (after **2 in-conversation nudges**)" → `agent()` resolves `null`.
- **Invocation:** a `Workflow` tool takes an inline `script` (+ `name`, `args`); the runtime
  persists it to the session dir and returns a path; iterate via `{scriptPath}`.

### SLICC alignments (free wins)

- `isolation: 'worktree'` ≈ SLICC scoops' **default** sandboxed FS (`/scoops/{name}/` + `/shared/`).
- `agentType` ≈ SLICC named-scoop / Agent registry.
- `schema` / `StructuredOutput` ≈ a forced pi-ai tool-call bridged through `tool-adapter.ts`.

## 4. Decomposition (context for SP1's boundary)

| Sub-project | Owns | Hand-off line |
| --- | --- | --- |
| **SP1** (this doc) | Workflow realm capability (reuses `runInRealm`), prelude globals, `agent` RPC → `AgentBridge`, determinism guard, `StructuredOutput`, caps, `budget` **stub**, **blocking** `workflow run` | — |
| SP2 | Background execution, IDB persistence, **resume** (deterministic call-order cache), pause/stop, approval card, full `budget` pool | SP1 runs blocking → SP2 makes it background + durable |
| SP3 | Cone authoring skill, `workflow save` → `*.jsh`-style discovered `/<name>`, trigger keyword, `args` plumbing (SLICC-native; no `.claude/` layout) | runtime API ↔ everything-else-is-SLICC-native |
| SP4 | `/workflows`-style progress sprinkle, task-panel line, pause/stop wired | — |
| SP5 (optional) | Real nested `workflow()`, `agent()` `model` routing + per-phase model, `agentType` mapping, bundled `/deep-research` analog | — |

## 4.5 Existing substrate (reused, not rebuilt)

A codebase cross-check (2026-06-08) found that SLICC **already ships the load-bearing
primitives**. SP1 builds on these rather than reinventing them:

- **`kernel/realm/` runner** (`realm-runner.ts:runInRealm`, `realm-factory.ts`,
  `realm-host.ts`, `js-realm-shared.ts`). A generalized, **hard-killable, dual-mode
  sandboxed JS executor**: a `DedicatedWorker` in standalone, a **per-task sandbox iframe**
  in the extension (CSP-safe). It injects globals (`fs`/`exec`/`fetch`/`skill`/`require`/
  `http`) by building RPC shims off the realm's control port, proxied kernel-side by
  `attachRealmHost`. It registers a `ProcessManager` pid (so `ps`/`kill` see it) and
  `SIGKILL → realm.terminate()` (exit 137). **This is exactly the "sandbox executor" the
  earlier draft proposed building.** It already powers `node`/`.jsh`/`python`/`test`
  (the `test` command runs each file in its own realm via `executeJsCode`).
- **`AgentBridge`** (`scoops/agent-bridge.ts`, `globalThis.__slicc_agent`). `spawn(opts)`
  registers an ephemeral `notifyOnComplete:false` scoop, runs its loop to completion, and
  returns `{ finalText, exitCode }` (`finalText` = last `send_message` or accumulated
  response). **This is the no-`schema` `agent()` path, essentially for free.** It does
  **not** surface token usage and has **no** structured-output/tool injection.
- **`ProcessManager`** (`kernel/process-manager.ts`). Pid tracking + signals for every
  long-running unit. The realm integration means a workflow run is a tracked pid — `kill
  -KILL <pid>` already terminates it. (This is the substrate SP2's pause/stop builds on.)
- **`tool-adapter.ts`** (`core/`) bridges legacy tool defs into the pi-compatible tool
  layer — the seam for wiring the `StructuredOutput` tool.

The cross-check also confirmed there is **no existing `workflow` feature** to collide with.

## 5. Architecture (reuse the realm runner)

The workflow script runs inside the **existing realm runner** (`runInRealm`) — the same
dual-mode (worker / sandbox-iframe), hard-killable, RPC-proxied sandbox that already runs
`node`/`.jsh`/`python`. We add a **workflow capability**: the realm bootstrap injects the
workflow globals and **suppresses** `fs`/`exec`/`fetch`/`require`/`skill`/`http` (the CC
contract forbids fs/shell from the script), and `realm-host` gains an **`agent` RPC
namespace** that bridges to `AgentBridge`. This is dual-mode by construction (the realm
factory already picks worker-vs-iframe per float) and inherits `ps`/`kill`/SIGKILL for free.

### Units

| Unit | Where | Single responsibility |
| --- | --- | --- |
| **workflow realm capability** | `kernel/realm/` (extend `js-realm-shared` bootstrap + `realm-types`) | A `kind:'workflow'` (or a caps flag on `realm-init`) that injects the workflow prelude globals and suppresses `fs`/`exec`/`fetch`/`require`/`skill`/`http`. |
| `workflow-prelude` (runs in the realm) | bundled `?raw`, concatenated before the user script | Installs the determinism guard; defines `agent`/`parallel`/`pipeline`/`phase`/`log`/`budget`/`workflow` + `args` as shims over the realm `agent` RPC. |
| **`agent` RPC namespace** | `kernel/realm/realm-host.ts` | `rpc.call('agent','spawn',[{prompt,opts}])` → `AgentBridge.spawn` (+ schema path). **Enforces the host-side caps**: `min(16,cores−2)` semaphore, 1000-total counter, budget ceiling. Also `('agent','progress',…)` for `phase`/`log`. |
| `AgentBridge` schema extension | `scoops/agent-bridge.ts` + `scoop-context.ts` | When `opts.schema` is set: register a `StructuredOutput` tool on the ephemeral scoop, capture its validated args as the return value (instead of `finalText`), retry on mismatch, 2 nudges → `null`. **Net-new agent-side work.** |
| return-value capture | `kernel/realm/` (`realm-done` payload) | Extend the realm done-protocol so the workflow's returned value (structured-clonable) comes back, not just stdout/stderr/exit. |
| `workflow` command (`run`) | `shell/supplemental-commands/workflow-command.ts` | Entry point; parse `meta` statically; call `runInRealm({kind:'workflow', code: prelude+script, …})`; print the final value; stream `phase`/`log`. |

### Why no new transport

The realm runner already owns the dual-mode boundary: `realm-factory` builds a
`DedicatedWorker` (standalone) or a sandbox iframe (extension), and `attachRealmHost` wires
RPC against the caller's `CommandContext` — in the kernel worker (standalone) or the
offscreen document (extension), wherever the Orchestrator + `AgentBridge` already live. The
earlier draft's bespoke `WorkflowSandbox` + `wf:*` postMessage envelopes + panel-RPC relay
are **subsumed** by `realm-init`/`realm-done` + the realm RPC channel. We only add the
`agent` RPC namespace and extend the done payload.

### Protocol (extends the existing realm protocol)

| Mechanism | Direction | Payload |
| --- | --- | --- |
| `realm-init` (existing, + workflow kind) | host → realm | `{ kind:'workflow', code: prelude+script, argv, env, cwd, … }`; `args` passed via `argv`/env |
| `agent` RPC `spawn` (new namespace) | realm → host | `[{ prompt, opts }]` → resolves `string \| object \| null` (a failed/skipped agent resolves `null`, per CC) |
| `agent` RPC `progress` (new) | realm → host | `phase(title)` / `log(message)` → streamed to stdout in SP1 (SP4 routes to the UI) |
| `realm-done` (existing, + `result`) | realm → host | adds the workflow's returned value (structured-clonable) alongside `stdout`/`stderr`/`exitCode` |
| `realm-error` (existing) | realm → host | script threw, or a `budget`/cap/determinism error escaped → exit 1 + message |
| SIGKILL (existing) | host → realm | `realm.terminate()`, exit 137 — already wired; becomes `workflow stop` in SP2 |

## 6. The prelude (exact semantics)

The prelude is concatenated before the user script and runs **inside the workflow realm**
(a `DedicatedWorker` in standalone, a sandbox iframe in the extension). Its shims call the
realm `agent` RPC namespace over the existing realm control port.

- **Determinism guard** (installed first): replace `Date.now`, `Math.random`, and the argless
  `Date` constructor — *in the user script's scope* — with functions that throw a clear
  `WorkflowDeterminismError`. (A CC script never calls these; one that does should fail the
  same way it does in CC. Realm-infra code captures its own references before the override.)
- `agent(prompt, opts)` → `rpc.call('agent','spawn',[{prompt,opts}])`; returns the Promise.
  Rejects only on a thrown host error (cap/budget); a *failed/skipped* agent resolves `null`.
- `parallel(thunks)` → validate it's an array of functions, `length ≤ 4096` (else throw),
  run all, **catch per-thunk → `null`**, return the array (never rejects).
- `pipeline(items, ...stages)` → validate `items.length ≤ 4096`; for **each item
  independently**, thread it through the stages (`stage(prev, originalItem, index)`); a stage
  throw drops that item to `null`; resolve when every item has finished its chain. Per-item
  streaming, no inter-stage barrier.
- `phase(title)` → `rpc.call('agent','progress',…)`; set the module-level "current phase" used
  to tag agents that don't pass an explicit `opts.phase`.
- `log(message)` → `rpc.call('agent','progress',…)`.
- `budget` (SP1 stub) → object with the right shape; `total` from `--budget` (or `null`);
  `remaining()` = `max(0, total - spent())` or `Infinity`. **Honest SP1 limitation:**
  `AgentBridge.spawn` surfaces no token usage, so `spent()` returns `0` in SP1 and the
  hard-ceiling never trips. Precise token accounting + ceiling enforcement land in **SP2**
  alongside a usage observer (see §14). The shape is present so CC scripts that *read*
  `budget` don't crash.
- `workflow(...)` → **throws** `WorkflowNestingUnsupportedError` in SP1 (real nesting is SP5).
- `args` → injected via `realm-init` (`argv`/`env`).

The user script's `export const meta = {...}` is parsed **statically** (pure literal) before
execution to obtain `name`/`description`/`phases` for the command banner and progress labels.

## 7. `agent()` → scoop bridge

The `agent` RPC namespace handler (added to `attachRealmHost`) runs in the Orchestrator realm
and owns the bridge logic:

1. Receive `('agent','spawn',[{prompt, opts}])` from the realm.
2. **Caps (host-side, authoritative):** acquire a semaphore slot — the POC default is **4**
   (bounds token cost while still proving real parallel fan-out), raisable via `--concurrency`
   up to `min(16, navigator.hardwareConcurrency − 2)`; reject if the run's total agent count
   would exceed **1000** (`WorkflowAgentCapError`). (Budget ceiling is a no-op in SP1 per §6;
   it activates in SP2.)
3. Call `AgentBridge.spawn({ cwd, allowedCommands, prompt, … })` — an ephemeral
   `notifyOnComplete:false` scoop with its own sandboxed `RestrictedFS` (no cone turn triggered).
   - **No `schema`:** resolve `spawn().finalText`.
   - **With `schema`:** the **extended bridge** registers a `StructuredOutput` tool (input schema
     = `opts.schema`) on the scoop via `tool-adapter.ts` and instructs it that calling the tool
     *is* how it returns. Args are validated; on mismatch the model retries; if the scoop ends
     without calling it, nudge up to **2×**, then resolve `null`. **This is the main net-new
     agent-side work** — today's `AgentBridge` has no tool-injection or structured return.
4. On settle: release the semaphore; resolve the RPC with `string | object | null` (a
   failed/skipped agent resolves `null`, per CC).
5. **Isolation:** SP1 relies on SLICC's existing per-scoop sandboxed FS — which already matches
   `isolation:'worktree'`'s intent (each `AgentBridge` scoop gets its own `/scoops/<name>/`
   scratch + `RestrictedFS`). `opts.model` / `opts.agentType` map onto `AgentSpawnOptions.modelId`
   and the scoop registry respectively but are **deferred in SP1** (logged, not honored beyond
   the session model / default persona) — wiring them is SP5.

## 8. Data flow

```
workflow run audit.js [--args <json>] [--budget N] [--concurrency K]   (shell)
   │ parse meta (static); code = prelude + script
   ▼
runInRealm({ kind:'workflow', code, … })           (existing realm runner)
   │ pm.spawn(pid)  ·  realmFactory → Worker[standalone] / sandbox-iframe[ext]
   │ attachRealmHost(controlPort, ctx) + agent RPC namespace
   ├──────────── realm-init(code, argv=args) ───────────▶ [ realm: prelude + user script ]
   │                                                          │ agent("audit X", {schema})
   │ ◀──────── rpc: ('agent','spawn',[{prompt,opts}]) ────────┤  (awaiting Promise)
   │   sem(≤min(16,cores-2)); ++total≤1000                    │
   │   AgentBridge.spawn → ephemeral scoop                    │
   │   (schema → StructuredOutput tool, validate/retry/null)  │
   │ ─────────── resolve: string | object | null ────────────▶│ resolves agent()
   │ ◀──────── rpc: ('agent','progress', phase/log) ──────────┤ parallel([...]) / pipeline([...])
   │   (streamed to stdout)                                   │ return finalReport
   │ ◀──────────── realm-done({ result, exitCode }) ──────────┘
   ▼
print the returned value to the caller   ·   SIGKILL → realm.terminate() (137)  [→ SP2 stop]
```

## 9. Error handling (nothing swallowed)

- **Script throw** → `wf:error` → `workflow run` exits non-zero, prints message + stack.
- **Agent failure / skip** → that `agent()` resolves `null` (CC contract); the script may
  `.filter(Boolean)`. This is *not* surfaced as a run error.
- **Schema mismatch** → retry at the tool layer; terminal failure → `null` (per §7).
- **Cap exceeded** (`1000` total, `4096` per call) → thrown `WorkflowAgentCapError` /
  validation error the script can catch.
- **Budget exhausted** → thrown error from `agent()` (hard ceiling).
- **Determinism violation** (`Date.now` etc.) → thrown `WorkflowDeterminismError`.
- **Sandbox crash / unresponsive** → controller aborts the run and reports; no partial-success
  masquerading as success.

No silent fallbacks (per the repo's silent-failure guidance and Karl's standing orders).

## 10. `workflow` command UX (SP1)

```
workflow run <path.js> [--args <json>] [--budget <tokens>] [--concurrency <n>]
workflow run --script '<inline js>' [...]          # inline script, no temp file needed
```

- Prints the parsed `meta.name`/`description` banner, streams `log()`/`phase()` lines, and on
  completion prints the returned value (JSON-stringified if non-string).
- `--concurrency` defaults to **4** (POC), clamped to `min(16, cores−2)`. `--budget` sets
  `budget.total` (non-enforcing in SP1 per §6). `--args` is parsed as JSON and exposed as `args`.
- **Out of scope for SP1:** `workflow save`, `workflow list`, `workflow resume`,
  `workflow stop`, trigger keywords. (SP2/SP3.)

## 11. Testing strategy

Vitest, mirroring `packages/webapp/tests/` by subsystem; `fake-indexeddb/auto` where VFS is touched.

- **Unit — prelude:** `parallel` returns nulls for failing thunks and never rejects;
  `pipeline` streams per-item (assert item A reaches stage 2 before item B finishes stage 1
  via a controllable mock), drops a throwing item to `null`, passes `(prev, item, index)`;
  `parallel`/`pipeline` reject at `> 4096` items; determinism guard throws on
  `Date.now`/`Math.random`/`new Date()`.
- **Unit — controller:** semaphore never exceeds `min(16, cores−2)`; total-cap throws at 1001;
  budget hard-ceiling throws; envelope (de)serialization round-trips.
- **Unit — schema:** valid args resolve the object; mismatch retries; "no call after 2 nudges"
  → `null`.
- **Integration (acceptance fixture):** the **self-contained repo fan-out/verify workflow**
  (`pipeline`/`parallel`/`agent({schema})` over repo files) with `agent()` backed by a
  deterministic **mock scoop**; assert the final value, that the `{schema}` path returns a
  validated object (and retries/nudges/null on bad output), and that concurrency stayed ≤ cap
  while genuinely overlapping. A `/deep-research`-style script is a **separate stretch test**
  (mock-scoped, or live behind an opt-in env flag).
- **Dual-mode (both floats required at SP1):** verify **standalone** (worker realm) **and**
  **extension** (sandbox-iframe realm + the offscreen `AgentBridge` proxy path). The realm
  factory already abstracts the transport, but the extension path is a hard acceptance gate —
  add a workflow-kind smoke test (prelude globals injected, `fs`/`exec`/`fetch` absent) plus an
  extension-float verification of an end-to-end `workflow run` (test harness where possible,
  documented manual check otherwise).

## 12. Documentation to update (part of the change, not after)

- `docs/shell-reference.md` — add the `workflow` command.
- `docs/architecture.md` — new "Workflow Executor" subsystem + layer note.
- root `CLAUDE.md` & `packages/webapp/CLAUDE.md` — Key Subsystems entry.
- `packages/vfs-root/shared/CLAUDE.md` (`/shared/CLAUDE.md`) — agent-facing: the workflow API
  and when to reach for `workflow run` (a fuller authoring skill is SP3).
- `README.md` — only if user-facing behavior is exposed at SP1 (likely a one-line mention).

## 13. Non-goals (SP1)

Background execution; persistence; **resume**; pause/stop/restart-agent; approval card;
save-as-command + discovery; trigger keywords; authoring skill; rich `/workflows` progress UI;
`agent()` `model` routing; real `isolation`/`agentType` behavior beyond scoop defaults; **real
nested `workflow()`**; mirroring the `.claude/` layout or plugins.

Resolved by the 2026-06-08 cross-check:

- **Sandbox host / dual-mode transport** — *resolved.* The realm runner (`realm-factory` +
  `attachRealmHost`) already owns the worker/iframe boundary; no bespoke `WorkflowSandbox`,
  `wf:*` envelopes, or panel-RPC relay are needed (§4.5, §5).
- **`agent()` no-`schema` return** — *resolved.* `AgentBridge.spawn` returns `{finalText,
  exitCode}` (`finalText` = last `send_message` or accumulated response).
- **`budget.spent()` source** — *resolved (negatively).* `AgentBridge`/`observeScoop` surface
  **no token usage**, so SP1's `budget.spent()` returns `0` (non-enforcing); a usage observer +
  ceiling enforcement move to **SP2**.

Still open (resolve during planning):

1. **Workflow realm capability:** confirm `js-realm-shared`'s bootstrap can be gated by a
   `kind:'workflow'` / caps flag to inject the workflow globals and **suppress**
   `fs`/`exec`/`fetch`/`require`/`skill`/`http`, rather than forking the bootstrap.
2. **Return-value capture:** confirm how the realm wraps user code (async fn for top-level
   `await`/`return`?) and extend `realm-done` to carry a structured-clonable `result`.
3. **`StructuredOutput` injection point:** confirm where in `scoop-context.ts` /
   `orchestrator` to register a per-scoop ephemeral tool and capture its validated call args.
4. **JSON-Schema validator:** what `tool-adapter.ts` / pi-ai already use for tool-arg
   validation (reuse it) vs. a minimal subset validator.
5. **Static `meta` parse:** a safe pure-literal extraction (no eval) for the banner/labels.
