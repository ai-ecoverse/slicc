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

### The cone skill (the trigger)

A native skill package bundled via `packages/vfs-root/workspace/skills/workflows/SKILL.md`, auto-loaded into the system prompt by the skills engine (progressive disclosure — the cone reads the full body on demand). Content: the globals + semantics (from the spec §3 API table), the "when to use a workflow" guidance (codebase-wide sweeps, large migrations, cross-checked research, multi-angle planning), an authoring example, and the run/results model (non-blocking; result arrives as a new turn with a path + preview). **No code change makes this a trigger** — the cone simply uses the `workflow` command when the skill tells it to. This is the SLICC-idiomatic "skills over hardcoded features."

### Save

`workflow save <runId> <name>` (a new subcommand on the `workflow` command) reads `WorkflowRunManager.getRun(runId).source` (SP2 retains it) and writes `/workspace/.workflows/<name>.workflow.js`. Validates `<name>` (`[a-z0-9][a-z0-9-]*`) and that it doesn't collide with an existing built-in command.

### Discovery → bare command

A new `workflow-discovery.ts` (mirroring `jsh-discovery.ts`) scans the standard roots for `*.workflow.js` and feeds the shared `ScriptCatalog` (`shell/script-catalog.ts`), which already powers `which`/command resolution for `.jsh`. Each discovered file registers a command named by its basename (minus `.workflow.js`). Invoking that command runs the file's script through the **same path as `workflow run <file>`** (build code + hand to the run manager), forwarding any trailing argument as `args`.

- Discovery roots (SP3): `/workspace/.workflows/` (saved) plus the existing catalog roots, so a workflow dropped anywhere reachable is runnable. (Skill-bundled workflows under `/workspace/skills/*/` can be added later if useful.)
- Collision/precedence: built-in supplemental commands win over discovered `*.workflow.js`; among discovered files, first-found wins (catalog's existing rule), logged on shadow.

### Components (files)

| Unit | File | Responsibility |
| --- | --- | --- |
| cone skill | `packages/vfs-root/workspace/skills/workflows/SKILL.md` (new) | Teach the API + when/how to author & run a workflow. |
| `workflow save` | `shell/supplemental-commands/workflow-command.ts` (modify) | Persist a run's `source` to `/workspace/.workflows/<name>.workflow.js`. |
| discovery | `shell/workflow-discovery.ts` (new) + `shell/script-catalog.ts` (modify) | Discover `*.workflow.js`; register each as a bare command. |
| saved-command runner | `shell/supplemental-commands/workflow-command.ts` (modify) | The discovered command path: read file → build code → run via the run manager → pass `args`. |

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

1. Confirm `ScriptCatalog` can host a third discovered type cleanly (vs. forking a parallel catalog).
2. `args` coercion rule for the saved-command path (single JSON arg vs. multiple positional args → array).
3. Whether a discovered command should run **non-blocking by default** (consistent with SP2's `workflow run`) — yes, with `--wait` honored.
