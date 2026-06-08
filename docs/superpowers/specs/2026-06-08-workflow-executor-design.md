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
| SP2 | Background execution (non-blocking default, `--wait`), live progress events, async result via a `workflow` lick | SP1 runs blocking → SP2 makes it background + reports results |
| SP3 | Cone authoring skill (skill-driven trigger, no keyword), `workflow save` → single `.workflow.js` auto-discovered as a **bare command**, `args` (SLICC-native; no `.claude/` layout) | runtime API ↔ everything-else-is-SLICC-native |
| SP4 | Progress **subscription bridge** (`observeRun`→sprinkle/dip) + a minimal manager-injected progress **dip**; rich views = opt-in workflow/skill sprinkles | consumes SP2's `observeRun` |
| SP5 | **Resume** (best-effort: deterministic-replay + content-hash agent cache), pause/resume, restart-agent — within-session | uses SP1's determinism guard |
| Backlog (SP6+) | Approval card + `budget`-pool enforcement; reach features (nested `workflow()`, model routing, `agentType`, `/deep-research`); cross-session persistence; realm-native isolation hardening | — |

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
| `workflow` command | `shell/supplemental-commands/workflow-command.ts` (new) | Parse `meta` statically; build `prelude + transformed script`; run via `executeJsCode` (no proxy — panel terminal is already offscreen-backed); split the random-sentinel result line out of stdout; print the result + the run log. |
| workflow prelude | `shell/supplemental-commands/workflow-prelude.ts` (new) | A JS string: determinism guard (const-shadow `Date`/`Math`/`crypto`/`performance`/timers — **not** `globalThis`, which would TDZ-break the prelude and is the documented soft-isolation escape); capture `exec.spawn` + `cwd` from `__WF`, then null the **full** injected param set (`exec`/`fs`/`fetch`/`require`/`process`/`module`/`exports`/`skill`/`http`/`browser`/`usb`/`serial`/`hid`/`cli`/`c`/`time`/`fmt`/`pool`); define `agent`/`parallel`/`pipeline`/`phase`/`log`/`budget`/`args`/`workflow`; the concurrency semaphore + caps. |
| script transform | inside `workflow-command.ts` | Strip `export` off `const meta`; wrap the remaining body in `const __r = await (async () => { … })();`; append `console.log(<random sentinel> + JSON.stringify(__r ?? null))`. |
| `agent --schema` extension | `shell/supplemental-commands/agent-command.ts` + `scoops/agent-bridge.ts` + `scoops/types.ts` + `scoops/scoop-context.ts` | New `--schema-b64` flag (`--model` already exists) → `AgentSpawnOptions.structuredOutputSchema` → `ScoopConfig.structuredOutputSchema` → `ScoopContext` injects a `StructuredOutput` `ToolDefinition`, **instructs** the scoop (via `systemPromptAppend`) that calling it is how it returns (**not** a global `toolChoice` force — that would block its research; see §7), captures validated args via an `afterToolCall` hook, ≤2 nudges, and the bridge returns the captured JSON as `finalText`. **The main net-new agent-side work.** |
| ~~offscreen proxy~~ | — | **Removed.** The panel terminal is already offscreen-backed (`RemoteTerminalView`→`TerminalSessionHost`), so terminal and cone runs both execute in offscreen with no extra wiring. |

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
      '--read-only', '/workspace/',           // constrain READ scope (panel cwd is '/' — see note)
      __agentCwd, '*', String(prompt)];       // __agentCwd = WRITE scope (per-run scratch; created by the command)
    const r = await __execSpawn(argv);       // captured ref to exec.spawn
    if (r.exitCode !== 0) return null;       // failed/skipped → null (CC contract)
    return opts.schema ? JSON.parse(r.stdout) : r.stdout.replace(/\n+$/, '');
  } finally { sem.release(); }
}
```

**`agent()` cwd + read-scope (codex review):** the spawned scoop's writable prefix must NOT
default to the invoking realm cwd — in the extension panel that's `/`, and `AgentBridge` would
make `/` writable AND union the invoking cwd (`/`) into the read set, exposing the whole VFS.
Fixes: (1) **write scope** = a constrained per-run prefix `__agentCwd`
(`/shared/workflow-runs/<runId>/scratch/`, supplied via `__WF`); (2) **read scope** = pass
`--read-only /workspace/` explicitly (pure-replace, so the implicit `/` read add is dropped);
(3) the **command/​run-manager must `mkdir` `__agentCwd` before the run** — `agent` rejects a
missing cwd *before* spawning (`agent-command.ts`), so without it every `agent()` degrades to
`null`.

### Isolation & determinism (with the honest caveat)

- **Determinism guard:** the prelude `const`-shadows the nondeterministic globals for the user
  scope — `Date`, `Math.random`, `crypto`, `performance.now`, timers (see §6). `globalThis` is **not**
  shadowed (TDZ + it's the soft-isolation escape).
- **Suppression:** capture `exec.spawn` (and take `cwd` from `__WF.cwd`), then null the **full**
  injected param set — not just `exec/fs/fetch/require` but also `process/module/exports/skill/
  http/browser/usb/serial/hid/cli/c/time/fmt/pool`, several of which re-expose fs/shell/fetch.
- **Caveat (documented SP1 limitation):** this is **soft** isolation — a determined script can
  still reach `globalThis.*` (e.g. `globalThis.fetch`, `globalThis.Date`), dynamic `import()`,
  and pre-loaded `require()` modules. Acceptable for Claude-authored POC scripts; a hard sandbox
  is the deferred realm-native fork.

### Result channel (no protocol change)

`executeJsCode` returns the realm's full `stdout`. The transform makes the script `console.log`
a sentinel-prefixed JSON line carrying its return value; the command splits that line out as the
result and prints the remaining stdout (the `log`/`phase`/`console` output). To prevent a user
`console.log` from **spoofing** the result (codex review), the sentinel is a **random per-run
token** that the command **inlines as a string literal in the emit line only** — it is **not**
placed in `__WF` (which the user script can read/mutate), so user code can neither learn nor forge
it. The command parses **only the single wrapper-emitted line** bearing the token (the last such
line). A throw in the body rejects the IIFE → the realm's existing `catch` → exit 1 + stderr.

### Extension durability (offscreen hosting) — no bespoke forwarding needed

**Codex review (2026-06-08) corrected the earlier draft here.** The extension side-panel
terminal is **already** a `RemoteTerminalView` over the **offscreen** `TerminalSessionHost`,
which builds its own `WasmShellHeadless` (`packages/webapp/src/ui/main.ts:976`,
`packages/chrome-extension/src/offscreen.ts`, `kernel/terminal-session-host.ts`). So:

- **Both** cone-invoked (`bash` tool) **and** terminal-invoked `workflow run` already execute in
  the **offscreen** shell → the realm is parented to offscreen → **survives a side-panel close**.
- **No `workflow-run` chrome message / `publishAgentBridgeProxy`-style forwarding is needed** —
  it would duplicate/​bypass the existing terminal/session/process plumbing. The
  `WorkflowCommandOptions.runRemote` seam and the offscreen-proxy unit are **removed from SP1**.
- **Standalone:** the realm is a `DedicatedWorker` in the normal context; no side-panel concept.
- **Caveat:** SP1 is blocking — closing mid-run completes the work in offscreen but the result
  is not re-readable after reopening (reattach = SP2).

### Caps

The concurrency semaphore (**default 4**, raisable to `min(16, cores−2)`), the **1000**-total
counter, and the **≤4096**-per-call check live **in the prelude**.

**Threat model — be honest (codex review).** These caps, the determinism guard, the global
suppression, and the result sentinel are **cooperative-script guarantees, not a security
boundary.** SP1 runs the user's *own* Claude-authored (or user-pasted CC) workflows — a
*cooperative* threat model — so for well-behaved scripts the API is the only path. But because
the script is concatenated into the **same lexical scope** as the prelude, a script that
*deliberately* references prelude internals, reaches `globalThis.*`, uses `eval`/dynamic
`import()`, or monkey-patches `console` can bypass any of them. SP1 raises the bar with two
cheap, build-time hardenings (recommended, see the plan): (1) **hide the privileged internals**
in an inner IIFE that returns only the public API (`agent`/`parallel`/…/`Date`/`Math`), so a
fixed script can't name `__execSpawn`/the real `Date`/the counters; (2) **capture the emit
function** (`console.log.bind`) before user code and emit the result with a **random literal
sentinel**, so the result can't be intercepted or forged. Even so, the `globalThis`/`eval`
residual remains — **hard enforcement against adversarial scripts is explicitly a non-goal of
SP1** and is the job of the deferred **realm-native fork** (separate scope/realm).

### Execution model: SP1 blocking → SP2/SP4 non-blocking + live progress

**How Claude Code does it:** the `Workflow` tool launches a **background runtime** and the
session **stays responsive** — you keep talking to the agent, a `/workflows` view + a
task-panel line update live, and the **result arrives asynchronously as a new message** when
the run finishes. There is **no mid-run user input** (only agent permission prompts pause it).

**SP1 (this doc) is blocking, by deliberate scope:**

- Run from the **terminal** (`workflow run …`) — this blocks only the terminal tab, **not the
  cone**; the cone stays fully responsive. This is the intended SP1 usage.
- Run from the **cone** (its `bash` tool) — the cone's *turn* is occupied until the run
  returns. Acceptable for the POC; removed in SP2.
- `phase()`/`log()` emit `WFPHASE`/`WFLOG` markers to stdout, surfaced **at completion** (no
  mid-run streaming, since just-bash commands return output as a unit).

**The non-blocking future maps onto existing SLICC machinery (SP2 + SP4), no rework of the
SP1 prelude API:**

- **SP2 (non-blocking launch):** start the realm as a **background `ProcessManager` process**
  (it already is a tracked pid) and return a **run id** immediately so the cone turn ends and
  the cone stays responsive. Deliver the final result back to the cone via the existing
  **scoop-completion-notification / lick** path — i.e. as a fresh cone turn, exactly like CC's
  "results arrive as separate messages." No mid-run user input (matches CC). `workflow stop` =
  `kill -KILL <pid>` (already wired).
- **SP4 (live progress):** stream `phase`/`log`/per-agent events out of the run into a
  **workflow progress sprinkle** (`.shtml`, SLICC's `/workflows` analog) + a task-panel line,
  updated from the host via `SprinkleManager.sendToSprinkle` — **independent of the cone's
  turn**, so progress is live whether or not the cone is busy. (This needs a progress
  side-channel out of the realm — incremental console streaming or a tiny progress hook — a
  small additive change; the `WFPHASE`/`WFLOG` markers are the forward-compatible seam.)

So SP1 keeps the cone responsive **today** as long as workflows are launched from the terminal;
cone-launched, non-blocking, progress-reporting workflows are the SP2+SP4 step, and the SP1
design does not block that path.

## 6. The prelude (exact semantics)

The prelude is a JS string the `workflow` command prepends to the (transformed) user script,
so it runs **inside the existing `kind:'js'` realm**, in the same function scope as the user
code. All shims are plain JS; the only outward call is `exec.spawn` (captured, then `exec`
nulled).

- **Determinism guard** (installed first, broadened per the 2026-06-08 codex review): shadow the
  nondeterministic globals with `const` throwers for the user scope — `Date` (argless `new Date`
  + `Date.now`), `Math.random`, **`crypto`** (`getRandomValues`/`randomUUID`),
  **`performance.now`**, **timers** (`setTimeout`/`setInterval`/`queueMicrotask` used for timing).
  **Do NOT shadow `globalThis`** — a `const globalThis = undefined` is a TDZ error (the guard reads
  `globalThis.Date` earlier) *and* pointless. Note two residual holes that make SP1
  isolation/determinism **soft, not hard**: (a) a script can still reach
  `globalThis.Date`/`globalThis.fetch`/dynamic `import()`;
  (b) the realm **pre-loads `require()` specifiers before** the prelude nulls `require`
  (`js-realm-shared.ts` pre-scan). True hardness needs the deferred realm-native fork; SP5 resume
  is therefore **best-effort** (see SP5 spec).
- **Suppression** (broadened per review): the realm injects **many** params, several re-exposing
  fs/shell/fetch (`skill.config()` reads FS, `skill.token()` shells out, `http.client()` wraps
  fetch). Capture only what the prelude needs (`const __execSpawn = exec.spawn`; `cwd` comes from
  `__WF.cwd`, **not** `process`), then null the **full** injected set:
  `exec = fs = fetch = require = process = module = exports = skill = http = browser = usb =
  serial = hid = cli = c = time = fmt = pool = undefined;` (all are realm parameters, reassignable
  under `"use strict"`).
- `agent(prompt, opts)` → acquire the semaphore, `__execSpawn(['agent', …flags, __cwd, '*',
  prompt])`, release; `exitCode !== 0` → `null`; `opts.schema` → `JSON.parse(stdout)`, else
  trimmed text. (See §5 for the exact body.)
- `parallel(thunks)` → validate it's an array of functions, `length ≤ 4096` (else throw),
  run all, **catch per-thunk → `null`**, return the array (never rejects). **Exception (codex
  review):** *fatal* `WorkflowError` subclasses (`WorkflowAgentCapError`, budget-exhausted,
  `WorkflowDeterminismError`) **rethrow** rather than being caught-to-`null`, so a real failure
  aborts the run instead of silently becoming `null`.
- `pipeline(items, ...stages)` → validate `items.length ≤ 4096`; for **each item
  independently**, thread it through the stages (`stage(prev, originalItem, index)`); a stage
  throw drops that item to `null` (same fatal-error exception as `parallel`); resolve when every
  item has finished its chain. Per-item streaming, no inter-stage barrier.
- `phase(title)` → `console.log('WFPHASE' + title)`; set the module-level "current
  phase" used to tag agents that don't pass an explicit `opts.phase`. (Goes to realm stdout;
  the command renders it. SP4 gives it real UI.)
- `log(message)` → `console.log('WFLOG' + message)`.
- `budget` (SP1 stub) → object with the right shape; `total` from `--budget` (or `null`);
  `remaining()` = `max(0, total - spent())` or `Infinity`. **Honest SP1 limitation:** the
  `agent` command / `AgentBridge` surface no token usage, so `spent()` returns `0` in SP1 and
  the hard-ceiling never trips. Precise accounting + ceiling enforcement land in the **SP6
  budget-pool backlog** alongside a usage observer (see §14). The shape is present so CC scripts that *read*
  `budget` don't crash.
- `workflow(...)` → **throws** `WorkflowNestingUnsupportedError` in SP1 (real nesting is SP6 backlog).
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
   `agent --model`; `opts.agentType` is **deferred** (logged, default persona) — SP6 backlog.

## 8. Data flow

```
workflow run audit.js [--args JSON] [--budget N] [--concurrency K]        (shell command)
   │ parse meta (static) ; code = prelude + transform(strip export, wrap IIFE, append random sentinel)
   │ mkdir /shared/workflow-runs/<runId>/scratch/  (so the agent cwd exists)
   ▼
executeJsCode(code, ['workflow', file], ctx)                       (existing; kind:'js'; offscreen in ext)
   │ runInRealm → Worker[standalone] / sandbox-iframe[ext, parented to offscreen]
   ▼
[ realm: prelude + wrapped user script ]
   │ determinism guard ; const __execSpawn = exec.spawn ; null the FULL injected param set
   │ agent("audit X",{schema}) → sem.acquire(≤4) ; ++total≤1000
   │    __execSpawn(['agent','--schema-b64',b64,'--read-only','/workspace/', __agentCwd,'*',prompt])
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

- **Unit — prelude:** `parallel` maps failing thunks to `null` (never rejects) **but rethrows
  fatal `WorkflowError`s** (cap/budget/determinism) instead of swallowing them; `pipeline`
  streams per-item (assert item A reaches stage 2 before item B finishes stage 1 via a
  controllable mock), drops a throwing item to `null` (same fatal exception), passes
  `(prev, item, index)`; `parallel`/`pipeline` reject at `> 4096` items; determinism guard throws
  on `Date.now`/`Math.random`/`new Date()` **and** `crypto.randomUUID`/`performance.now`/`setTimeout`.
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
- **Dual-mode (both floats required at SP1):** verify **standalone** (`DedicatedWorker` realm)
  **and** **extension** (sandbox-iframe realm; the panel terminal is already offscreen-backed via
  `RemoteTerminalView`→`TerminalSessionHost`, so no proxy to test). The realm factory abstracts
  the transport, but the extension path is a hard acceptance gate — add a smoke test (prelude
  globals injected, the full suppressed set incl. `fs`/`exec`/`fetch`/`skill`/`http` absent) plus
  an extension-float end-to-end `workflow run` check (test harness where possible, documented
  manual check otherwise).

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
per-phase/`meta.phases[].model` routing (the simple `opts.model` → `agent --model` passthrough
**is** in scope — `agent --model` already exists); real `isolation`/`agentType` behavior beyond
scoop defaults; **real nested `workflow()`**; mirroring the `.claude/` layout or plugins.
**Also deferred:** the
realm-native isolation fork (`kind:'workflow'` + `sandbox.html` duplication) that would give a
hard sandbox and a clean structured-result channel — SP1 accepts the user-space prelude's
softer isolation (§5).

## 14. Open questions

Resolved by the 2026-06-08 cross-check (three investigation passes; file:line confirmed):

- **Executor host / dual-mode** — *resolved.* Reuse `executeJsCode` →
  `runInRealm({kind:'js'})` **unchanged**; it already picks worker (standalone) vs sandbox
  iframe (extension). No new kind, no `sandbox.html` change.
- **Global injection & suppression** — *resolved.* The realm compiles user code as an
  `AsyncFunction` with the globals as **named params**; const-shadow `Date`/`Math`/`crypto`/
  `performance`/timers (**not** `globalThis` — TDZ), and capture-then-null the **full** injected param set
  (`exec`/`fs`/`fetch`/`require`/`process`/`module`/`exports`/`skill`/`http`/`browser`/`usb`/
  `serial`/`hid`/`cli`/`c`/`time`/`fmt`/`pool`).
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
  `spent()` returns `0`; usage observer + enforcement = SP6 budget-pool backlog.

Still open (small, resolve during planning):

1. **Static `meta` parse:** a safe pure-literal extraction (no eval) for the banner/labels.
2. **Concurrency safety:** confirm the orchestrator runs N concurrent ephemeral `AgentBridge`
   scoops cleanly (default cap 4 bounds it); add a test.
3. ~~Offscreen proxy wiring~~ — **resolved (removed).** The panel terminal is already
   offscreen-backed (`RemoteTerminalView`→`TerminalSessionHost`), so terminal and cone runs both
   execute in offscreen; no `workflow-run` chrome message is needed.
4. **`exec.spawn` contract** — *confirmed by review:* `realm-host` lowers realm `exec.spawn(argv)`
   → `ctx.exec(cmd,{args})` and returns `{stdout,stderr,exitCode}`; long prompts + base64 schema
   pass as argv entries (no shell quoting). (SP2/SP5 progress/cache taps therefore wrap
   **`ctx.exec`**, not `ctx.exec.spawn`.)
5. **`afterToolCall` re-verify:** confirmed in the main checkout's `pi-agent-core`; re-confirm in
   this worktree after `npm install` (the worktree had no `node_modules` at review time).
