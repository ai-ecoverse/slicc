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
| **SP1** (this doc) | Sandbox executor, prelude globals, `agent()`→scoop bridge, determinism guard, `StructuredOutput`, caps, `budget` **stub**, **blocking** `workflow run` | — |
| SP2 | Background execution, IDB persistence, **resume** (deterministic call-order cache), pause/stop, approval card, full `budget` pool | SP1 runs blocking → SP2 makes it background + durable |
| SP3 | Cone authoring skill, `workflow save` → `*.jsh`-style discovered `/<name>`, trigger keyword, `args` plumbing (SLICC-native; no `.claude/` layout) | runtime API ↔ everything-else-is-SLICC-native |
| SP4 | `/workflows`-style progress sprinkle, task-panel line, pause/stop wired | — |
| SP5 (optional) | Real nested `workflow()`, `agent()` `model` routing + per-phase model, `agentType` mapping, bundled `/deep-research` analog | — |

## 5. Architecture (Approach B — uniform sandbox iframe)

The script runs in a **CSP-exempt sandbox iframe** ("headless sprinkle"), genuinely
isolated from fs/shell/network. The injected globals are postMessage shims; the host owns
orchestration. This is dual-mode by construction and reuses SLICC's most battle-tested
primitive (the sprinkle/dip sandbox + panel-RPC), the same way `mount`/`usb`/`serial`
forward to the page realm.

### Units

| Unit | Realm | Single responsibility |
| --- | --- | --- |
| `WorkflowSandbox` | DOM (page in CLI / offscreen in ext) | Owns the sandbox-iframe lifecycle; relays postMessage. **Pure transport — no logic.** |
| `workflow-prelude` (runs in the iframe) | iframe | Installs the determinism guard; defines `agent`/`pipeline`/`parallel`/`phase`/`log`/`budget`/`workflow` + `args`; concatenated before the user script. |
| `WorkflowRunController` | Orchestrator realm (worker / offscreen) | The brain: semaphore + total/per-call caps, dispatch `agent()` → scoop, schema-validate, collect phase/log, resolve the final value. **Realm-agnostic logic + pluggable transport.** |
| `ScoopAgentAdapter` | Orchestrator realm | Map one `agent()` call → a one-shot `AgentBridge` scoop (`notifyOnComplete:false`); when `schema` present, wire a `StructuredOutput` tool and treat its call as the return value; capture final text otherwise. |
| `schema-tool` | Orchestrator realm | Build a schema-typed `StructuredOutput` tool def (via `tool-adapter.ts`); validate args; surface mismatch so the model retries; 2 nudges → `null`. |
| `workflow` command (`run`) | shell (supplemental command) | Entry point; wires controller ↔ sandbox via the float transport; prints the final value; streams `phase`/`log`. |

### Realms & transport (identical envelopes, different wiring)

- **Extension:** iframe (offscreen child) ⇄ offscreen (controller + Orchestrator in-realm). **1 hop.**
- **CLI:** iframe (page) ⇄ page (dumb relay) ⇄ worker (controller + Orchestrator) via panel-RPC. **2 hops.**

The kernel worker has no DOM, so in CLI the iframe element lives in the page and the
worker-side controller drives it over panel-RPC. In the extension the offscreen document
hosts the iframe and the Orchestrator in the same realm, so no panel-RPC hop is needed.

### Message envelopes

| Type | Direction | Payload |
| --- | --- | --- |
| `wf:init` | host → iframe | `{ script, args, caps }` |
| `wf:agent` | iframe → host | `{ callId, prompt, opts }` |
| `wf:agent-result` | host → iframe | `{ callId, ok, value? , error? }` (a failed agent is `ok:true, value:null`, not an error) |
| `wf:phase` | iframe → host | `{ title }` |
| `wf:log` | iframe → host | `{ message }` |
| `wf:done` | iframe → host | `{ value }` |
| `wf:error` | iframe → host | `{ message, stack }` (script threw, or a thrown `budget`/cap error escaped) |

## 6. The prelude (exact semantics)

The prelude is concatenated before the user script and runs inside the iframe.

- **Determinism guard** (installed first): replace `Date.now`, `Math.random`, and the argless
  `Date` constructor with functions that throw a clear `WorkflowDeterminismError`. (A CC
  script never calls these; one that does should fail the same way it does in CC.)
- `agent(prompt, opts)` → assigns a `callId`, posts `wf:agent`, returns a Promise resolved by
  the matching `wf:agent-result`. Rejects only on a thrown host error (cap/budget); a *failed*
  agent resolves `null`.
- `parallel(thunks)` → validate it's an array of functions, `length ≤ 4096` (else throw),
  run all, **catch per-thunk → `null`**, return the array (never rejects).
- `pipeline(items, ...stages)` → validate `items.length ≤ 4096`; for **each item
  independently**, thread it through the stages (`stage(prev, originalItem, index)`); a stage
  throw drops that item to `null`; resolve when every item has finished its chain. Per-item
  streaming, no inter-stage barrier.
- `phase(title)` → post `wf:phase`; set the module-level "current phase" used to tag agents
  that don't pass an explicit `opts.phase`.
- `log(message)` → post `wf:log`.
- `budget` (SP1 stub) → `total` from `--budget` (or `null`); `spent()` returns the running
  sum of agent token usage reported back on each `wf:agent-result`; `remaining()` =
  `max(0, total - spent())` or `Infinity`. The hard-ceiling check lives **host-side**: the
  controller rejects an `agent()` whose start would exceed `total`, surfaced as a thrown error.
- `workflow(...)` → **throws** `WorkflowNestingUnsupportedError` in SP1 (real nesting is SP5).
- `args` → injected via `wf:init`.

The user script's `export const meta = {...}` is parsed **statically** (pure literal) before
execution to obtain `name`/`description`/`phases` for the command banner and progress labels.

## 7. `agent()` → scoop bridge

1. `WorkflowRunController` receives `wf:agent{callId, prompt, opts}`.
2. **Caps:** acquire a semaphore slot (`min(16, navigator.hardwareConcurrency − 2)`, lowerable
   via `--concurrency`); reject the call if the run's total agent count would exceed **1000**
   (`WorkflowAgentCapError`); reject if `budget.total` would be exceeded.
3. `ScoopAgentAdapter` spawns a **one-shot scoop** via `AgentBridge`
   (`globalThis.__slicc_agent`, `notifyOnComplete:false` so the spawn never triggers a cone turn).
   - **No `schema`:** the scoop runs; its final assistant text is the result.
   - **With `schema`:** register a `StructuredOutput` tool (input schema = `opts.schema`) on the
     scoop and instruct it that calling the tool *is* how it returns. `tool-adapter.ts` validates
     the args; on mismatch the model retries; if the scoop ends without calling it, nudge up to
     **2×**, then resolve `null`.
4. On settle: release the semaphore, add token usage to the budget tally, post
   `wf:agent-result{callId, ok:true, value}` (a failed/skipped agent is `value:null`).
5. **Isolation:** SP1 relies on SLICC's existing per-scoop sandboxed FS (which already matches
   `isolation:'worktree'`'s intent). `opts.model` / `opts.agentType` are accepted and **logged
   as deferred** in SP1 (the scoop uses the session model and the default workflow persona).

## 8. Data flow

```
workflow run audit.js [--args <json>] [--budget N] [--concurrency K]
   (shell · Orchestrator realm: worker[CLI] / offscreen[ext])
   │ parse meta (static), concat prelude + script
   ▼
WorkflowRunController ──wf:init(script,args,caps)──▶ WorkflowSandbox (DOM realm)
                                                        │ load CSP-exempt iframe
                                                        ▼
                                                [ iframe: prelude + user script ]
                                                        │ agent("audit X", {schema})
                              ◀──── wf:agent{callId} ───┤
   acquire sem; ++total≤1000; budget check             │ (awaiting Promise)
   ScoopAgentAdapter → AgentBridge one-shot scoop       │
   (schema → StructuredOutput tool, validate/retry)     │
                              ──── wf:agent-result ─────▶│ resolves agent() (or null)
                              ◀──── wf:phase / wf:log ───┤ parallel([...]) / pipeline([...])
                                                        │ (streamed to stdout)
                              ◀──────── wf:done{value} ──┘
   print final value to the caller
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
- **Integration (float-agnostic):** run a faithful **deep-research-style fixture**
  (Scope → Search → Fetch → Verify → Synthesize, using `pipeline`/`parallel`/`agent({schema})`)
  with `agent()` backed by a deterministic **mock scoop**; assert the final value and that
  concurrency stayed ≤ cap.
- **Dual-mode:** a transport-contract test per side (CLI panel-RPC relay; extension in-realm),
  asserting identical envelope behavior; the controller logic test is shared.

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

## 14. Open questions (resolve during planning)

1. **JSON-Schema validator:** reuse an existing bundle dependency if present, else a minimal
   subset validator. (Confirm what `tool-adapter.ts` / pi-ai already use for tool-arg validation.)
2. **AgentBridge one-shot return:** confirm the exact surface by which a `notifyOnComplete:false`
   scoop's final assistant text + token usage are obtained synchronously by the adapter.
3. **`budget.spent()` source:** confirm scoop/pi-ai token-usage reporting is available per
   one-shot scoop for the stub tally.
4. **Sandbox host in CLI:** confirm the page realm can host the iframe and be driven from the
   worker over the existing panel-RPC channel (parallel to `mount`'s gesture/`--__resolved` path).
5. **Static `meta` parse:** confirm a safe pure-literal extraction (no eval) for the banner/labels.
