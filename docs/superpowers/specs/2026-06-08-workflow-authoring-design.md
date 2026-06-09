# SP3 — Workflow authoring, save & trigger (design)

**Status:** Draft for review
**Date:** 2026-06-08
**Branch:** `worktree-workflow-authoring`
**Author:** Karl + Claude (Opus 4.8)
**Depends on:** SP1 (executor + `workflow` command) and SP2 (background runs; its run-state retains the original `source`).

## 1. Goal

Make workflows ergonomic and SLICC-native: teach the **cone** to write and run a workflow when a task warrants it, and let a good run be **saved as a reusable bare command**. No `.claude/` layout, no plugins/marketplaces (per the settled fidelity boundary).

## 2. Scope

**In:**

- A cone **skill** (`/workspace/skills/workflows/SKILL.md`) — the _only_ trigger mechanism (skill-driven, no keyword): teaches the workflow API (the SP1/CC globals), _when_ to reach for a workflow vs. plain scoops/`agent`, how to author one (`meta` + body), and how to run it (`workflow run`, non-blocking, result-as-turn from SP2).
- `workflow save <runId> <name>` — persists the run's original `source` to `/workspace/.workflows/<name>.workflow.js`.
- **Auto-discovery of `*.workflow.js` as bare commands** — discovered from `/workspace/.workflows/` (saved) **and from skill packages' `.workflows/` subdirs (`/workspace/skills/*/.workflows/`)**, registered as top-level shell commands that run the script through the workflow runner. Runnable by you (`weekly-audit …`) or the cone (via `bash`). Name collisions disambiguate (never shadow) — built-ins always win; a clashing saved workflow → `<name>-workflow`, a clashing skill-bundled one → `<skill>-<name>` (see §3).
- **`args` passing** — `<name> '<json>'` (or trailing args) is exposed to the saved script as the `args` global, JSON-parsed when possible.
- **Complete the `agent()` runtime options** — the SP1 prelude's `agent(prompt, opts)` already forwards `opts.model` and `opts.schema`; add `opts.thinking` → `--thinking <level>` (the underlying `agent` command + `AgentBridge` already accept it) so a workflow can set per-agent reasoning effort, e.g. `agent('design a careful plan first', { thinking: 'high' })`. Levels: `off | minimal | low | medium | high | xhigh`. The workflows skill documents the full option set. (Folded into SP3 because the authoring skill teaches the `agent()` surface, which should be complete + accurate.)

**Out:** keyword/`ultracode` triggers; the `.claude/workflows/` layout; plugins, marketplaces, sharing; per-workflow typed arg schemas.

## 3. Architecture

### The workflow skill (the trigger)

A **native skill** package bundled via `packages/vfs-root/workspace/skills/workflows/SKILL.md`, auto-loaded into the system prompt by the skills engine (progressive disclosure — read the full body on demand). **Note (codex review):** native `/workspace/skills` are loaded by _every_ scoop context (`scoop-context.ts`), not just the cone — so this is a "native workflow skill," not literally cone-only. That's fine (any agent that can run `workflow` benefits); if cone-only gating is ever wanted it's a separate skill-scoping feature. Content: the globals + semantics (from the spec §3 API table), the "when to use a workflow" guidance (codebase-wide sweeps, large migrations, cross-checked research, multi-angle planning), an authoring example, and the run/results model (non-blocking; result arrives as a new turn with a path + preview). **No code change makes this a trigger** — the cone simply uses the `workflow` command when the skill tells it to. This is the SLICC-idiomatic "skills over hardcoded features."

### Save

`workflow save <runId> <name>` (a new subcommand on the `workflow` command) reads `WorkflowRunManager.getRun(runId).source` (SP2 retains it) and writes `/workspace/.workflows/<name>.workflow.js`. Validates `<name>` (`[a-z0-9][a-z0-9-]*`). It does **not** reject names that collide with a built-in or existing command — instead it **warns** that the workflow will be registered under its disambiguated name (`<name>-workflow`; see §3), so the author can choose to rename. It refuses to overwrite an existing `/workspace/.workflows/<name>.workflow.js` unless `--force` is passed.

### Discovery → bare command

**Codex review correction:** `ScriptCatalog` (`shell/script-catalog.ts`) is only a _discovery/cache_ service — it does **not** register commands. Bare-command registration lives in **`WasmShellHeadless.doSyncJshCommands`** (`shell/wasm-shell-headless.ts`), which today scans `.jsh` and registers each name routing to `executeJsCode`. So SP3 owns changes there, not just a new discovery file:

- **Registration owner + routing:** add `*.workflow.js` discovery (`shell/workflow-discovery.ts`) feeding `ScriptCatalog`, **and** extend `WasmShellHeadless` to register each discovered name with a handler that routes to the **workflow runner** (parse `meta` → build prelude+transform → `WorkflowRunManager.start`) — **never** `executeJsCode` on the raw file (that would run it as a trusted jsh script with full fs/exec). Concretely: an in-memory command wrapper that calls the `workflow run` path (keeps the single-file goal; no on-disk `.jsh` shim).
- **Save → re-sync:** today `syncJshCommands()` runs once at startup and the watcher only reacts to `.jsh` paths. `workflow save` must trigger a workflow re-sync (or extend the watcher to `*.workflow.js`) so the new bare command appears without a reload.
- **`which`/`commands` visibility:** these are `.jsh`-specific (`SupplementalCommandsConfig.getJshCommands`, `which-command.ts`, `help-command.ts`). Add a parallel `getWorkflowCommands` so saved workflows show in `which`/`commands` with a "workflow" label.
- **`args` coercion (align with SP1):** match `workflow run`'s `--args <json>` — a single trailing argument is parsed as JSON when valid, else passed as a string; multiple positional args → a string array; no arg → `undefined`. (Resolves the SP1↔SP3 conflict: `args` is real JSON, not a stringified list.) `--wait` honored.
- **Name collisions → disambiguate, never shadow (resolved):** built-in supplemental commands always win — a workflow never overrides a built-in (`ls`, `git`, …). When a workflow's filename `<name>` is otherwise already taken (a built-in, a `.jsh`, or another command), the workflow registers under a **synthetic disambiguated name** rather than being dropped or silently shadowing the existing command, so both stay runnable:
  - a **saved** workflow (`/workspace/.workflows/`) → `<name>-workflow`;
  - a **skill-bundled** workflow → `<skill>-<name>` (skill-namespaced).
  - If the disambiguated name _itself_ collides (rare), append `-2`, `-3`, …. All disambiguations are logged and reflected in `which`/`commands` (with the "workflow" label). `workflow save <name>` **warns at save time** if `<name>` will be suffixed, so the author can pick a cleaner name. Among `*.workflow.js` with the same base name, first-found wins (catalog rule), the rest get the numeric suffix.
- **Discovery roots:** `/workspace/.workflows/` (saved) **and each skill package's `.workflows/` subdir — `/workspace/skills/*/.workflows/*.workflow.js`** (skills can ship turnkey workflow commands, mirroring how skills already bring `.jsh`/compatibility scripts; skill-bundled names are skill-namespaced on clash per above). Plus the existing catalog roots.

### `agent()` option completeness (one-line SP1-prelude rider)

`agent(prompt, opts)` in `shell/supplemental-commands/workflow-prelude.ts` currently forwards only `--model` (from `opts.model`) and `--schema-b64` (from `opts.schema`); `opts.thinking` is silently dropped, even though the `agent` command (`agent-command.ts`, `--thinking <level>`) and `AgentBridge` (`thinkingLevel`) already accept it. SP3 adds the pass-through (mirroring `--model`):

```js
if (opts.thinking) flags.push('--thinking', String(opts.thinking));
```

so the workflow API matches what the skill teaches — `agent(prompt, { model?, thinking?, schema?, phase?, label? })`. An invalid level is the `agent` command's own error (surfaced as a failed sub-agent → `null`), so no new validation is added in the prelude.

### Components (files)

| Unit                          | File                                                                         | Responsibility                                                                                                                                                                                                                |
| ----------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| workflow skill                | `packages/vfs-root/workspace/skills/workflows/SKILL.md` (new)                | Teach the API + when/how to author & run a workflow (native skill; loaded by all scoops).                                                                                                                                     |
| `workflow save`               | `shell/supplemental-commands/workflow-command.ts` (modify)                   | Persist a run's `source` to `/workspace/.workflows/<name>.workflow.js`; trigger a workflow re-sync.                                                                                                                           |
| discovery                     | `shell/workflow-discovery.ts` (new) + `shell/script-catalog.ts` (modify)     | Discover `*.workflow.js` under `/workspace/.workflows/` **and `/workspace/skills/*/.workflows/`**; feed the catalog (discovery/cache only).                                                                                   |
| **registration + routing**    | `shell/wasm-shell-headless.ts` (modify)                                      | Register each discovered name as a bare command whose handler routes to the **workflow runner** (not `executeJsCode`); watcher/`save` re-sync; collision disambiguation (`<name>-workflow` / `<skill>-<name>`, never shadow). |
| `which`/`commands` visibility | `shell/supplemental-commands/{index,which-command,help-command}.ts` (modify) | Add `getWorkflowCommands` so saved workflows appear with a "workflow" label.                                                                                                                                                  |
| `agent()` thinking opt        | `shell/supplemental-commands/workflow-prelude.ts` (modify)                   | Forward `opts.thinking` → `--thinking <level>` (mirrors `opts.model`); completes the documented `agent()` option set.                                                                                                         |

## 4. Data flow

```
cone reads /workspace/skills/workflows/SKILL.md (system prompt) → decides a task warrants a workflow
  → writes a script (inline) → `workflow run --script '…'`  → likes the result
  → `workflow save <runId> weekly-audit`
       → /workspace/.workflows/weekly-audit.workflow.js
       → ScriptCatalog discovers it → `weekly-audit` is now a bare command
  → later: `weekly-audit '{"paths":["src/"]}'`  → runs the saved script with args={paths:[…]}
```

## 5. Testing

- **Skill:** `discoverSkills` finds `/workspace/skills/workflows`; the body parses (frontmatter name/description present).
- **Save:** `workflow save <id> name` writes the expected file with the run's `source`; rejects bad names; warns (does not reject) when the name collides with a built-in/command; refuses to overwrite an existing saved workflow without `--force`.
- **Discovery (saved):** a `*.workflow.js` under `/workspace/.workflows/` registers a bare command (appears in `which`/catalog).
- **Discovery (skill-bundled):** a `*.workflow.js` under `/workspace/skills/<skill>/.workflows/` registers a bare command too.
- **Collision → disambiguate, never shadow:** a workflow named after a built-in is reachable under its disambiguated name (the built-in still resolves to the built-in); a saved workflow whose name clashes with an existing `.jsh`/command registers as `<name>-workflow` (both runnable); a skill-bundled workflow that clashes registers as `<skill>-<name>`; a second `<name>-workflow`/`<skill>-<name>` collision appends `-2`. `which`/catalog reflect the registered names.
- **Run saved:** invoking the discovered command runs the script through the run manager; a trailing JSON arg arrives as `args`; non-JSON arg arrives as a string.
- **`agent()` thinking:** extend the prelude test — `agent('x', { thinking: 'high' })` spawns with `--thinking high` in argv (alongside the existing `--model`/`--schema-b64` assertions); `agent('x', {})` includes no `--thinking`.

## 6. Documentation

- `docs/shell-reference.md` — `workflow save`, and that `*.workflow.js` files become bare commands (from `/workspace/.workflows/` and skill `.workflows/` dirs), including the collision-disambiguation rule.
- `packages/vfs-root/shared/CLAUDE.md` — point the cone at the workflows skill.
- `docs/architecture.md` — note `*.workflow.js` discovery alongside `.jsh`/`.bsh`.
- The `workflows` `SKILL.md` documents the full `agent()` option set: `agent(prompt, { model?, thinking?, schema?, phase?, label? })` — including the newly-wired `thinking` level.

## 7. Non-goals (SP3)

Keyword/`ultracode` triggers; `.claude/workflows/` layout; plugins/marketplaces/sharing; typed arg schemas; cross-repo workflow distribution.

## 8. Open questions (resolve during planning)

Resolved by the codex review (now in §3): registration owner is `WasmShellHeadless` (not
`ScriptCatalog`, which is discovery-only) routing to the workflow runner; `args` coercion matches
`workflow run --args` (JSON-or-string, multi→array, none→undefined); non-blocking default with
`--wait`; `save`→re-sync; `which`/`commands` plumbing; "native workflow skill" (loaded by all
scoops, not literally cone-only).

Resolved by Karl (now in §2/§3/§5):

1. **Name collisions → disambiguate, never shadow.** Built-ins always win; clashing saved
   workflows register as `<name>-workflow`, clashing skill-bundled workflows as `<skill>-<name>`
   (numeric `-2` suffix if the disambiguated name itself collides). No silent `.jsh`-vs-`.workflow.js`
   precedence — both stay runnable, and `workflow save` warns when the chosen name will be suffixed.
2. **Also discover skill-bundled workflows.** Scan `/workspace/skills/*/.workflows/*.workflow.js`
   in addition to `/workspace/.workflows/` — skills can ship turnkey workflow commands, mirroring how
   skills already bring `.jsh`. Clashes use the skill-namespaced disambiguation above.

No open questions remain; ready to plan.
