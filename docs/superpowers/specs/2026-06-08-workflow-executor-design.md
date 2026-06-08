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
| **SP1** (this doc) | User-space prelude over the existing `kind:'js'` realm (no fork), `agent()` via the existing `agent` command, `--schema`/`StructuredOutput`, determinism guard, in-prelude caps, `budget` **stub**, offscreen-hosted **blocking** `workflow run` | — |
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

## 5. Architecture (user-space prelude over the existing `kind:'js'` realm)

The decisive finding of the 2026-06-08 cross-check: we need **no realm fork, no new realm
kind, no `sandbox.html` change, and no new RPC namespace**. The `workflow` command runs the
script through the **existing** `executeJsCode` → `runInRealm({kind:'js'})` path, with the
orchestration API supplied entirely in **user-space JS** (a prelude prepended to the script),
and `agent()` implemented as the **existing `agent` shell command** via the realm's existing
`exec.spawn`. This rides SLICC's already-dual-mode JS realm, so both floats work by
construction, and keeps SP1's net-new surface tiny.

(The realm-native alternative — a `kind:'workflow'` that forks `runJsRealm` *and* duplicates
the bootstrap in `sandbox.html` — gives true isolation and a clean structured-result channel,
but the `sandbox.html` duplication is the main dual-mode risk. It is deferred as hardening;
see §13.)

### Units (files)

| Unit | File | Responsibility |
| --- | --- | --- |
| `workflow` command | `shell/supplemental-commands/workflow-command.ts` (new) | Parse `meta` statically; build `prelude + transformed script`; run it (offscreen-proxied in ext, see below); split the sentinel result line out of stdout; print the result + the run log. |
| workflow prelude | `shell/supplemental-commands/workflow-prelude.ts` (new) | A JS string: determinism guard (const-shadow `Date`/`Math`); capture `exec.spawn` then null `fs`/`exec`/`fetch`/`require`; define `agent`/`parallel`/`pipeline`/`phase`/`log`/`budget`/`args`/`workflow`; the concurrency semaphore + caps. |
| script transform | inside `workflow-command.ts` | Strip `export` off `const meta`; wrap the remaining body in `const __r = await (async () => { … })();`; append `console.log(SENTINEL + JSON.stringify(__r ?? null))`. |
| `agent --schema` extension | `shell/supplemental-commands/agent-command.ts` + `scoops/agent-bridge.ts` + `scoops/types.ts` + `scoops/scoop-context.ts` | New `--schema-b64` (and `--model` already exists) flag → `AgentSpawnOptions.structuredOutputSchema` → `ScoopConfig.structuredOutputSchema` → `ScoopContext` injects a `StructuredOutput` `ToolDefinition`, forces `toolChoice` via the `streamWithSessionId` wrapper, captures validated args via an `afterToolCall` hook, and the bridge returns the captured JSON as `finalText`. **The main net-new agent-side work.** |
| offscreen proxy | extension wiring (a `workflow-run` message type in `chrome-extension/src/` + an offscreen handler) | When `workflow run` is invoked in the **side-panel** shell, forward the whole run to the **offscreen** document so the realm lives in the durable context (mirrors `publishAgentBridgeProxy`). Cone-invoked runs already execute in offscreen — no proxy needed. |

### How `agent()` works (no new RPC)

`exec.spawn(argv)` already exists on the realm's injected `exec` global (→ `rpc.call('exec',
'spawn', [argv])` → `realm-host` `dispatchExec` → host `WasmShell` runs `agent` →
`globalThis.__slicc_agent` real bridge → orchestrator scoop). So the prelude's `agent`:

```
async function agent(prompt, opts = {}) {
  await sem.acquire();                       // semaphore (default 4); ++total ≤ 1000
  try {
    const argv = ['agent',
      ...(opts.model ? ['--model', opts.model] : []),
      ...(opts.schema ? ['--schema-b64', b64utf8(JSON.stringify(opts.schema))] : []),
      __cwd, '*', String(prompt)];
    const r = await __execSpawn(argv);       // captured ref to exec.spawn
    if (r.exitCode !== 0) return null;       // failed/skipped → null (CC contract)
    return opts.schema ? JSON.parse(r.stdout) : r.stdout.replace(/\n+$/, '');
  } finally { sem.release(); }
}
```

### Isolation & determinism (with the honest caveat)

- **Determinism guard:** `Date`/`Math` are real globals (not realm params), so the prelude
  `const Date = <throws>` and a `Math` proxy whose `random()` throws cleanly shadow them for
  the user script's scope without touching realm infra.
- **fs/exec/fetch/require** are realm *parameters*; the prelude captures the one it needs
  (`const __execSpawn = exec.spawn`) then reassigns the rest to `undefined` so the user script
  can't see them.
- **Caveat (documented SP1 limitation):** a determined script could still reach
  `globalThis.fetch` / `globalThis` to escape — this is "globals not injected + determinism
  shadow," **not** a hard sandbox. Acceptable for Claude-authored POC scripts; true isolation
  is the deferred realm-native fork.

### Result channel (no protocol change)

`executeJsCode` returns the realm's full `stdout`. The transform makes the script
`console.log` a sentinel-prefixed JSON line carrying its return value; the command splits that
line out as the result and prints the remaining stdout (the `log`/`phase`/`console` output). A
throw in the body rejects the IIFE → the realm's existing `catch` → exit 1 + stderr, which the
command surfaces.

### Extension durability (offscreen hosting)

- **Cone-invoked** `workflow run` runs in the **offscreen** WasmShell already → its realm is
  parented to the offscreen document → **survives a side-panel close**. No extra work.
- **Terminal-invoked** (side-panel shell) `workflow run` → the command **forwards the run to
  offscreen** via a `chrome.runtime` message (mirroring `AGENT_SPAWN_REQUEST_TYPE` /
  `publishAgentBridgeProxy`); offscreen runs `executeJsCode` and returns `stdout`/`exitCode`.
  Closing the panel does not kill the offscreen run.
- **Standalone:** the realm is a `DedicatedWorker` in the normal context; no side-panel concept.
- **Caveat:** SP1 is blocking — closing mid-run completes the work in offscreen but the result
  is not re-readable after reopening (reattach = SP2).

### Caps

The concurrency semaphore (**default 4**, raisable to `min(16, cores−2)`), the **1000**-total
counter, and the **≤4096**-per-call check live **in the prelude**. This is sufficient because
`agent()`/`parallel()`/`pipeline()` are the *only* injected spawn primitives and `exec` is
nulled, so the user script has no other path to spawn scoops. (Host-side cap enforcement would
require the RPC namespace we're intentionally avoiding; it is part of the deferred realm-native
hardening.)

## 6. The prelude (exact semantics)

The prelude is a JS string the `workflow` command prepends to the (transformed) user script,
so it runs **inside the existing `kind:'js'` realm**, in the same function scope as the user
code. All shims are plain JS; the only outward call is `exec.spawn` (captured, then `exec`
nulled).

- **Determinism guard** (installed first): `const Date = <throws WorkflowDeterminismError>` and
  a `Math` whose `random()` throws — `Date`/`Math` are real globals, so a prelude `const`
  cleanly shadows them for the user script's scope without touching realm infra. (A CC script
  never calls these; one that does fails the same way it does in CC.)
- **Suppression:** `const __execSpawn = exec.spawn; exec = undefined; fs = undefined;
  fetch = undefined; require = undefined;` — capture the one ref we need, then blank the rest
  (they are realm parameters, reassignable under `"use strict"`).
- `agent(prompt, opts)` → acquire the semaphore, `__execSpawn(['agent', …flags, __cwd, '*',
  prompt])`, release; `exitCode !== 0` → `null`; `opts.schema` → `JSON.parse(stdout)`, else
  trimmed text. (See §5 for the exact body.)
- `parallel(thunks)` → validate it's an array of functions, `length ≤ 4096` (else throw),
  run all, **catch per-thunk → `null`**, return the array (never rejects).
- `pipeline(items, ...stages)` → validate `items.length ≤ 4096`; for **each item
  independently**, thread it through the stages (`stage(prev, originalItem, index)`); a stage
  throw drops that item to `null`; resolve when every item has finished its chain. Per-item
  streaming, no inter-stage barrier.
- `phase(title)` → `console.log(' WFPHASE ' + title)`; set the module-level "current
  phase" used to tag agents that don't pass an explicit `opts.phase`. (Goes to realm stdout;
  the command renders it. SP4 gives it real UI.)
- `log(message)` → `console.log(' WFLOG ' + message)`.
- `budget` (SP1 stub) → object with the right shape; `total` from `--budget` (or `null`);
  `remaining()` = `max(0, total - spent())` or `Infinity`. **Honest SP1 limitation:** the
  `agent` command / `AgentBridge` surface no token usage, so `spent()` returns `0` in SP1 and
  the hard-ceiling never trips. Precise accounting + ceiling enforcement land in **SP2**
  alongside a usage observer (see §14). The shape is present so CC scripts that *read*
  `budget` don't crash.
- `workflow(...)` → **throws** `WorkflowNestingUnsupportedError` in SP1 (real nesting is SP5).
- `args` → the command passes `--args` JSON through the realm `env`/`argv`; the prelude parses
  it and exposes the global `args` (or `undefined`).

The user script's `export const meta = {...}` is parsed **statically** (pure literal) before
execution to obtain `name`/`description`/`phases` for the command banner and progress labels.

## 7. `agent()` → scoop bridge

`agent()` reuses the **existing `agent` shell command** via `exec.spawn` (§5) — no new RPC.
The realm `exec` channel → host `WasmShell` runs `agent` → `globalThis.__slicc_agent`
(`AgentBridge`, real in offscreen/worker) → an ephemeral `notifyOnComplete:false` scoop with
its own sandboxed `RestrictedFS`. **No-`schema` returns the scoop's `finalText`.** Caps live in
the prelude (§5 "Caps").

**The `--schema` path (net-new; the exact seams confirmed by the cross-check):**

1. `agent-command.ts` — add `--schema-b64 <base64-utf8 JSON>` to `parseArgs`; forward to
   `AgentSpawnOptions.structuredOutputSchema` (the option type at `agent-bridge.ts:49-107`).
2. `agent-bridge.ts` — copy it into `scoopConfig` (near `:309`).
3. `scoops/types.ts` — add `structuredOutputSchema?: ToolInputSchema` to `ScoopConfig`
   (`:104-151`). Ephemeral scoops need no `CURRENT_SCOOP_CONFIG_VERSION` migration.
4. `scoop-context.ts`:
   - At tool assembly (`:406`), when `this.scoop.config?.structuredOutputSchema` is set, append a
     `StructuredOutput` `ToolDefinition` whose `inputSchema` is that schema. pi-agent-core
     **auto-validates** tool args against plain JSON Schema via `typebox`
     (`validateToolArguments`), so malformed args come back to the model as a corrective error
     and it retries — **no ajv/zod needed**.
   - Append a system-prompt instruction (via the existing `systemPromptAppend` path) that the
     scoop's final action MUST be to call `StructuredOutput`, whose arguments are its return
     value. (We do **not** globally force `toolChoice`, which would stop the scoop from doing its
     research/read work first; forcing is available — Anthropic/Google/Bedrock/bedrock-camp all
     honor `toolChoice` — and can be used as a late nudge.)
   - Capture the validated args with an `afterToolCall` hook on `new Agent({...})` (`:576`);
     the bridge returns them JSON-stringified as `finalText`. (SLICC sets no `afterToolCall`
     today.)
   - If the scoop ends without calling `StructuredOutput`, the bridge issues up to **2**
     corrective nudges (matching CC), then returns exit≠0 → the prelude maps that to `null`.
5. **Isolation:** each `AgentBridge` scoop already gets its own `/scoops/<name>/` scratch +
   `RestrictedFS` — matching `isolation:'worktree'`'s intent. `opts.model` →
   `agent --model`; `opts.agentType` is **deferred** (logged, default persona) — SP5.

## 8. Data flow

```
workflow run audit.js [--args JSON] [--budget N] [--concurrency K]        (shell command)
   │ parse meta (static) ; code = prelude + transform(strip export, wrap IIFE, append sentinel)
   │ EXT & side-panel shell? → forward run to offscreen (chrome.runtime)  ;  else run in-place
   ▼
executeJsCode(code, ['workflow', file], ctx)                       (existing; kind:'js')
   │ runInRealm → Worker[standalone] / sandbox-iframe[ext, parented to offscreen]
   ▼
[ realm: prelude + wrapped user script ]
   │ determinism guard ; const __execSpawn = exec.spawn ; exec/fs/fetch/require = undefined
   │ agent("audit X",{schema}) → sem.acquire(≤4) ; ++total≤1000
   │    __execSpawn(['agent','--schema-b64',b64, cwd,'*',prompt])
   │       → host WasmShell `agent` → __slicc_agent → ephemeral scoop
   │       → (schema: StructuredOutput tool + afterToolCall capture) → JSON/text on stdout
   │    ← parse ; exit≠0 → null  ⇒ resolves agent()
   │ parallel([...]) / pipeline([...]) ; phase()/log() → console.log(markers)
   │ const __r = await (async () => { <body> })()
   │ console.log(SENTINEL + JSON.stringify(__r ?? null))
   ▼ realm-done(stdout, exitCode)
command: split SENTINEL line → print result ; render WFPHASE/WFLOG lines ; propagate exit
   ·  kill -KILL <pid> terminates the realm (already wired → SP2 `workflow stop`)
```

## 9. Error handling (nothing swallowed)

- **Script throw** → the wrapping IIFE rejects → the realm's existing `catch` → exit 1 +
  stderr → `workflow run` exits non-zero and prints message + stack.
- **Agent failure / skip** → that `agent()` resolves `null` (CC contract); the script may
  `.filter(Boolean)`. This is *not* surfaced as a run error.
- **Schema mismatch** → `typebox` validation error fed back to the model → retry; terminal
  failure (no valid call after the nudges) → `null` (per §7).
- **Cap exceeded** (`1000` total, `4096` per call) → thrown `WorkflowAgentCapError` /
  validation error the script can catch (thrown from the prelude).
- **Budget exhausted** → thrown error from `agent()` (hard ceiling; no-op in SP1 per §6).
- **Determinism violation** (`Date.now` etc.) → thrown `WorkflowDeterminismError`.
- **Realm crash / SIGKILL** → `executeJsCode` returns exit 1 / 137; the command reports it;
  no partial-success masquerading as success.

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
- **Unit — prelude caps:** the semaphore never exceeds the configured cap (default 4); the
  1000-total counter throws at 1001; `> 4096` items throws; `budget` is a no-op stub (`spent()===0`).
- **Unit — script transform:** `export const meta` is stripped, the body wraps in an async IIFE,
  the sentinel result line round-trips a returned object, and a thrown body yields exit 1.
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
nested `workflow()`**; mirroring the `.claude/` layout or plugins. **Also deferred:** the
realm-native isolation fork (`kind:'workflow'` + `sandbox.html` duplication) that would give a
hard sandbox and a clean structured-result channel — SP1 accepts the user-space prelude's
softer isolation (§5).

## 14. Open questions

Resolved by the 2026-06-08 cross-check (three investigation passes; file:line confirmed):

- **Executor host / dual-mode** — *resolved.* Reuse `executeJsCode` →
  `runInRealm({kind:'js'})` **unchanged**; it already picks worker (standalone) vs sandbox
  iframe (extension). No new kind, no `sandbox.html` change.
- **Global injection & suppression** — *resolved.* The realm compiles user code as an
  `AsyncFunction` with the globals as **named params**; const-shadow `Date`/`Math`, and
  capture-then-null the `exec`/`fs`/`fetch`/`require` params.
- **Return-value capture** — *resolved.* The realm discards the body's return value, so we use
  the **IIFE + stdout sentinel** (no `realm-done` change).
- **`StructuredOutput` injection point** — *resolved.* Tool assembly at `scoop-context.ts:406`;
  force/instruct via `systemPromptAppend`; capture via an `afterToolCall` hook on
  `new Agent({...})` (`scoop-context.ts:576`); config field on `ScoopConfig`
  (`scoops/types.ts:104-151`), threaded from `agent-bridge.ts:~309`.
- **JSON-Schema validator** — *resolved.* pi-agent-core auto-validates tool args against plain
  JSON Schema via `typebox` (`validateToolArguments`); **no ajv/zod** to add.
- **`agent()` no-`schema` return** — *resolved.* `AgentBridge.spawn → {finalText, exitCode}`.
- **`budget.spent()` source** — *resolved (negatively).* No token usage is surfaced → SP1
  `spent()` returns `0`; usage observer + enforcement = SP2.

Still open (small, resolve during planning):

1. **Static `meta` parse:** a safe pure-literal extraction (no eval) for the banner/labels.
2. **Concurrency safety:** confirm the orchestrator runs N concurrent ephemeral `AgentBridge`
   scoops cleanly (default cap 4 bounds it); add a test.
3. **Offscreen proxy wiring:** the terminal-invoked `workflow run` forward — confirm the
   `chrome.runtime` message + offscreen handler analog to `AGENT_SPAWN_REQUEST_TYPE`.
4. **`exec.spawn` contract:** confirm it returns `{stdout, stderr, exitCode}` and that long
   prompts + the base64 schema pass cleanly as **argv entries** (no shell quoting needed).
