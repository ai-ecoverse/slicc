# SP3 — Workflow authoring, save & trigger (design)

**Status:** Draft for review
**Date:** 2026-06-08
**Branch:** `worktree-workflow-executor`
**Author:** Karl + Claude (Opus 4.8)
**Depends on:** SP1 (executor + `workflow` command) and SP2 (background runs; its run-state retains the original `source`).

## 1. Goal

Make workflows ergonomic and SLICC-native: teach the **cone** to write and run a workflow when a task warrants it, and let a good run be **saved as a reusable bare command**. No `.claude/` layout, no plugins/marketplaces (per the settled fidelity boundary).

## 2. Scope

**In:**

- A cone **skill** (`/workspace/skills/workflows/SKILL.md`) — the *only* trigger mechanism (skill-driven, no keyword): teaches the workflow API (the SP1/CC globals), *when* to reach for a workflow vs. plain scoops/`agent`, how to author one (`meta` + body), and how to run it (`workflow run`, non-blocking, result-as-turn from SP2).
- `workflow save <runId> <name>` — persists the run's original `source` to `/workspace/.workflows/<name>.workflow.js`.
- **Auto-discovery of `*.workflow.js` as bare commands** — the script catalog discovers them (like `*.jsh`) and registers `<name>` as a top-level shell command that runs the saved script through the workflow runner. Runnable by you (`weekly-audit …`) or the cone (via `bash`).
- **`args` passing** — `<name> '<json>'` (or trailing args) is exposed to the saved script as the `args` global, JSON-parsed when possible.

**Out:** keyword/`ultracode` triggers; the `.claude/workflows/` layout; plugins, marketplaces, sharing; per-workflow typed arg schemas.

## 3. Architecture

### The workflow skill (the trigger)

A **native skill** package bundled via `packages/vfs-root/workspace/skills/workflows/SKILL.md`, auto-loaded into the system prompt by the skills engine (progressive disclosure — read the full body on demand). **Note (codex review):** native `/workspace/skills` are loaded by *every* scoop context (`scoop-context.ts`), not just the cone — so this is a "native workflow skill," not literally cone-only. That's fine (any agent that can run `workflow` benefits); if cone-only gating is ever wanted it's a separate skill-scoping feature. Content: the globals + semantics (from the spec §3 API table), the "when to use a workflow" guidance (codebase-wide sweeps, large migrations, cross-checked research, multi-angle planning), an authoring example, and the run/results model (non-blocking; result arrives as a new turn with a path + preview). **No code change makes this a trigger** — the cone simply uses the `workflow` command when the skill tells it to. This is the SLICC-idiomatic "skills over hardcoded features."

### Save

`workflow save <runId> <name>` (a new subcommand on the `workflow` command) reads `WorkflowRunManager.getRun(runId).source` (SP2 retains it) and writes `/workspace/.workflows/<name>.workflow.js`. Validates `<name>` (`[a-z0-9][a-z0-9-]*`) and that it doesn't collide with an existing built-in command.

### Discovery → bare command

**Codex review correction:** `ScriptCatalog` (`shell/script-catalog.ts`) is only a *discovery/cache* service — it does **not** register commands. Bare-command registration lives in **`WasmShellHeadless.doSyncJshCommands`** (`shell/wasm-shell-headless.ts`), which today scans `.jsh` and registers each name routing to `executeJsCode`. So SP3 owns changes there, not just a new discovery file:

- **Registration owner + routing:** add `*.workflow.js` discovery (`shell/workflow-discovery.ts`) feeding `ScriptCatalog`, **and** extend `WasmShellHeadless` to register each discovered name with a handler that routes to the **workflow runner** (parse `meta` → build prelude+transform → `WorkflowRunManager.start`) — **never** `executeJsCode` on the raw file (that would run it as a trusted jsh script with full fs/exec). Concretely: an in-memory command wrapper that calls the `workflow run` path (keeps the single-file goal; no on-disk `.jsh` shim).
- **Save → re-sync:** today `syncJshCommands()` runs once at startup and the watcher only reacts to `.jsh` paths. `workflow save` must trigger a workflow re-sync (or extend the watcher to `*.workflow.js`) so the new bare command appears without a reload.
- **`which`/`commands` visibility:** these are `.jsh`-specific (`SupplementalCommandsConfig.getJshCommands`, `which-command.ts`, `help-command.ts`). Add a parallel `getWorkflowCommands` so saved workflows show in `which`/`commands` with a "workflow" label.
- **`args` coercion (align with SP1):** match `workflow run`'s `--args <json>` — a single trailing argument is parsed as JSON when valid, else passed as a string; multiple positional args → a string array; no arg → `undefined`. (Resolves the SP1↔SP3 conflict: `args` is real JSON, not a stringified list.) `--wait` honored.
- **Cross-type precedence:** built-in supplemental commands win over both `.jsh` and `.workflow.js`. Between a `foo.jsh` and a `foo.workflow.js`, define a deterministic order (e.g. `.jsh` wins, since it predates workflows) rather than sync-order; log the shadow. Among `*.workflow.js`, first-found wins (catalog rule).
- Discovery roots: `/workspace/.workflows/` (saved) plus the existing catalog roots.

### Components (files)

| Unit | File | Responsibility |
| --- | --- | --- |
| workflow skill | `packages/vfs-root/workspace/skills/workflows/SKILL.md` (new) | Teach the API + when/how to author & run a workflow (native skill; loaded by all scoops). |
| `workflow save` | `shell/supplemental-commands/workflow-command.ts` (modify) | Persist a run's `source` to `/workspace/.workflows/<name>.workflow.js`; trigger a workflow re-sync. |
| discovery | `shell/workflow-discovery.ts` (new) + `shell/script-catalog.ts` (modify) | Discover `*.workflow.js`; feed the catalog (discovery/cache only). |
| **registration + routing** | `shell/wasm-shell-headless.ts` (modify) | Register each discovered name as a bare command whose handler routes to the **workflow runner** (not `executeJsCode`); watcher/`save` re-sync; cross-type precedence. |
| `which`/`commands` visibility | `shell/supplemental-commands/{index,which-command,help-command}.ts` (modify) | Add `getWorkflowCommands` so saved workflows appear with a "workflow" label. |

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
- **Save:** `workflow save <id> name` writes the expected file with the run's `source`; rejects bad names / collisions.
- **Discovery:** a `*.workflow.js` under `/workspace/.workflows/` registers a bare command (appears in `which`/catalog); built-ins shadow it.
- **Run saved:** invoking the discovered command runs the script through the run manager; a trailing JSON arg arrives as `args`; non-JSON arg arrives as a string.

## 6. Documentation

- `docs/shell-reference.md` — `workflow save`, and that `*.workflow.js` files become bare commands.
- `packages/vfs-root/shared/CLAUDE.md` — point the cone at the workflows skill.
- `docs/architecture.md` — note `*.workflow.js` discovery alongside `.jsh`/`.bsh`.

## 7. Non-goals (SP3)

Keyword/`ultracode` triggers; `.claude/workflows/` layout; plugins/marketplaces/sharing; typed arg schemas; cross-repo workflow distribution.

## 8. Open questions (resolve during planning)

Resolved by the codex review (now in §3): registration owner is `WasmShellHeadless` (not
`ScriptCatalog`, which is discovery-only) routing to the workflow runner; `args` coercion matches
`workflow run --args` (JSON-or-string, multi→array, none→undefined); non-blocking default with
`--wait`; `save`→re-sync; `which`/`commands` plumbing; deterministic `.jsh`-vs-`.workflow.js`
precedence; "native workflow skill" (loaded by all scoops, not literally cone-only).

Still open: 1. exact cross-type precedence rule (`.jsh` wins, or by mtime?) — pick one in planning.
2. whether to also discover skill-bundled `*.workflow.js` under `/workspace/skills/*/`.
