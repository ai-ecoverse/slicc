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
- **Auto-discovery of `*.workflow.js` as commands** — discovered from `/workspace/.workflows/` (saved) **and from skill packages' `.workflows/` subdirs (`/workspace/skills/*/.workflows/`)**, registered as shell commands that run the script through the workflow runner. Runnable by you (`weekly-audit …`) or the cone (via `bash`). Naming follows Claude Code's model — **namespace-by-source, no rename-on-clash** (see §3): skill-bundled workflows are **always** `<skill>-<name>` (collision-free by construction, like CC's `plugin:skill`); saved workflows get the **bare** `<name>`. When a bare name is contested, a **fixed precedence** decides deterministically (`built-in > .jsh > saved-workflow`), recomputed from the current file set so the binding never depends on arrival order.
- **`args` passing** — `<name> '<json>'` (or trailing args) is exposed to the saved script as the `args` global, JSON-parsed when possible.
- **Complete the `agent()` runtime options** — the SP1 prelude's `agent(prompt, opts)` already forwards `opts.model` and `opts.schema`; add `opts.thinking` → `--thinking <level>` (the underlying `agent` command + `AgentBridge` already accept it) so a workflow can set per-agent reasoning effort, e.g. `agent('design a careful plan first', { thinking: 'high' })`. Levels: `off | minimal | low | medium | high | xhigh`. The workflows skill documents the full option set. (Folded into SP3 because the authoring skill teaches the `agent()` surface, which should be complete + accurate.)

**Out:** keyword/`ultracode` triggers; the `.claude/workflows/` layout; plugins, marketplaces, sharing; per-workflow typed arg schemas.

## 3. Architecture

### The workflow skill (the trigger)

A **native skill** package bundled via `packages/vfs-root/workspace/skills/workflows/SKILL.md`, auto-loaded into the system prompt by the skills engine (progressive disclosure — read the full body on demand). **Note (codex review):** native `/workspace/skills` are loaded by _every_ scoop context (`scoop-context.ts`), not just the cone — so this is a "native workflow skill," not literally cone-only. That's fine (any agent that can run `workflow` benefits); if cone-only gating is ever wanted it's a separate skill-scoping feature. Content: the globals + semantics (from the spec §3 API table), the "when to use a workflow" guidance (codebase-wide sweeps, large migrations, cross-checked research, multi-angle planning), an authoring example, and the run/results model (non-blocking; result arrives as a new turn with a path + preview). **No code change makes this a trigger** — the cone simply uses the `workflow` command when the skill tells it to. This is the SLICC-idiomatic "skills over hardcoded features."

### Save

`workflow save <runId> <name>` (a new subcommand on the `workflow` command) reads `WorkflowRunManager.getRun(runId).source` (SP2 retains it) and writes `/workspace/.workflows/<name>.workflow.js`. Validates `<name>` (`[a-z0-9][a-z0-9-]*`). **Reject-at-save** (CC-faithful "prevent collisions upfront"): if `<name>` is already taken by a built-in or an existing command at save time, the command errors and asks for a different name — saving is interactive, so the author loses nothing by picking another. It also refuses to overwrite an existing `/workspace/.workflows/<name>.workflow.js` unless `--force` is passed. (Reject-at-save catches the obvious case immediately; the deterministic precedence rebuild in §3 is the backstop for a `.jsh` that appears _after_ the save — see "Late arrivals.")

### Discovery → bare command

**Codex review correction:** `ScriptCatalog` (`shell/script-catalog.ts`) is only a _discovery/cache_ service — it does **not** register commands. Bare-command registration lives in **`WasmShellHeadless.doSyncJshCommands`** (`shell/wasm-shell-headless.ts`), which today scans `.jsh` and registers each name routing to `executeJsCode`. So SP3 owns changes there, not just a new discovery file:

- **Registration owner + routing:** add `*.workflow.js` discovery (`shell/workflow-discovery.ts`) feeding `ScriptCatalog`, **and** extend `WasmShellHeadless` to register each discovered name with a handler that routes to the **workflow runner** (parse `meta` → build prelude+transform → `WorkflowRunManager.start`) — **never** `executeJsCode` on the raw file (that would run it as a trusted jsh script with full fs/exec). Concretely: an in-memory command wrapper that calls the `workflow run` path (keeps the single-file goal; no on-disk `.jsh` shim).
- **Single deterministic rebuild (not two racing syncs):** today `syncJshCommands()` runs once at startup and the watcher only reacts to `.jsh` paths; adding a separate workflow sync would make the bare-name binding depend on which pass ran last. Instead, the command-name table is **recomputed as a pure function of the current file set** in fixed precedence order (below) whenever _any_ source changes — a `.jsh` _or_ a `*.workflow.js` is added/removed/changed (extend the watcher to `*.workflow.js` and the skill `.workflows/` dirs; `workflow save` triggers the same rebuild). This is the mechanism that makes "Late arrivals" order-independent.
- **`which`/`commands` visibility:** these are `.jsh`-specific (`SupplementalCommandsConfig.getJshCommands`, `which-command.ts`, `help-command.ts`). Add a parallel `getWorkflowCommands` so saved workflows show in `which`/`commands` with a "workflow" label.
- **`args` coercion (align with SP1):** match `workflow run`'s `--args <json>` — a single trailing argument is parsed as JSON when valid, else passed as a string; multiple positional args → a string array; no arg → `undefined`. (Resolves the SP1↔SP3 conflict: `args` is real JSON, not a stringified list.) `--wait` honored.
- **Naming — namespace-by-source, no rename-on-clash (resolved, CC-faithful):** Claude Code prevents collisions _upfront_ by always namespacing the shareable surface (a plugin's components are only reachable as `plugin:thing`) and resolving the un-namespaced scopes by _fixed precedence_ (`enterprise > personal > project`), with **no** synthetic-suffix/rename-on-clash anywhere. SP3 mirrors this:
  - **Skill-bundled workflows are always namespaced** `<skill>-<name>` — unconditionally, not only on clash (the CC `plugin:skill` model). The skill author gets a stable, documentable name that can never collide with built-ins, `.jsh`, or another skill's workflow. (Hyphen, not colon, since a bare `:` in a shell command token is a just-bash tokenizing risk; verify during the plan.)
  - **Saved workflows take the bare `<name>`** (the "personal scope"). Collisions are prevented at save time (reject-at-save, §Save).
  - **Built-ins are protected** — a workflow can never override `ls`, `git`, etc.
- **Bare-name precedence (the only contest left):** built-in `>` `.jsh` `>` saved-workflow, applied by the single deterministic rebuild above. The loser is shadowed _for the bare shortcut only_ — never silently: `which <name>`/`commands` show the active binding **and** the shadowed workflow (with a "workflow (shadowed)" label). A shadowed saved workflow stays fully runnable via its canonical form **`workflow run /workspace/.workflows/<name>.workflow.js`** (the analogue of CC keeping plugin things reachable-namespaced even when a bare name is taken). The chosen `.jsh > saved-workflow` order preserves existing `.jsh` behavior (no regression) and leans on the workflow's clean path-based fallback.
- **Late arrivals (`.jsh` appears after the save):** handled identically to "the `.jsh` was already there." Because the table is recomputed from the current file set in fixed precedence on every change, dropping a `foo.jsh` next to an already-bare `foo` workflow deterministically rebinds bare `foo` to the `.jsh` and demotes the workflow to its `workflow run <path>` form (surfaced in `which`/`commands`). No arrival-order dependence, no post-hoc rename.
- **Discovery roots:** `/workspace/.workflows/` (saved) **and each skill package's `.workflows/` subdir — `/workspace/skills/*/.workflows/*.workflow.js`** (skills can ship turnkey workflow commands, mirroring how skills already bring `.jsh`/compatibility scripts; skill-bundled names are always `<skill>-<name>` per above). Plus the existing catalog roots.

### `agent()` option completeness (one-line SP1-prelude rider)

`agent(prompt, opts)` in `shell/supplemental-commands/workflow-prelude.ts` currently forwards only `--model` (from `opts.model`) and `--schema-b64` (from `opts.schema`); `opts.thinking` is silently dropped, even though the `agent` command (`agent-command.ts`, `--thinking <level>`) and `AgentBridge` (`thinkingLevel`) already accept it. SP3 adds the pass-through (mirroring `--model`):

```js
if (opts.thinking) flags.push('--thinking', String(opts.thinking));
```

so the workflow API matches what the skill teaches — `agent(prompt, { model?, thinking?, schema?, phase?, label? })`. An invalid level is the `agent` command's own error (surfaced as a failed sub-agent → `null`), so no new validation is added in the prelude.

### Components (files)

| Unit                          | File                                                                         | Responsibility                                                                                                                                                                                                                                                                                           |
| ----------------------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| workflow skill                | `packages/vfs-root/workspace/skills/workflows/SKILL.md` (new)                | Teach the API + when/how to author & run a workflow (native skill; loaded by all scoops).                                                                                                                                                                                                                |
| `workflow save`               | `shell/supplemental-commands/workflow-command.ts` (modify)                   | Persist a run's `source` to `/workspace/.workflows/<name>.workflow.js` (reject-at-save on name collision; `--force` to overwrite); trigger the command-name rebuild.                                                                                                                                     |
| discovery                     | `shell/workflow-discovery.ts` (new) + `shell/script-catalog.ts` (modify)     | Discover `*.workflow.js` under `/workspace/.workflows/` **and `/workspace/skills/*/.workflows/`**; feed the catalog (discovery/cache only).                                                                                                                                                              |
| **registration + routing**    | `shell/wasm-shell-headless.ts` (modify)                                      | Register each discovered name (skill workflows as `<skill>-<name>`, saved as bare `<name>`) with a handler that routes to the **workflow runner** (not `executeJsCode`); rebuild the command-name table deterministically by fixed precedence (`built-in > .jsh > saved-workflow`) on any source change. |
| `which`/`commands` visibility | `shell/supplemental-commands/{index,which-command,help-command}.ts` (modify) | Add `getWorkflowCommands` so saved workflows appear with a "workflow" label.                                                                                                                                                                                                                             |
| `agent()` thinking opt        | `shell/supplemental-commands/workflow-prelude.ts` (modify)                   | Forward `opts.thinking` → `--thinking <level>` (mirrors `opts.model`); completes the documented `agent()` option set.                                                                                                                                                                                    |

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
- **Save:** `workflow save <id> name` writes the expected file with the run's `source`; rejects bad names; **rejects** a name already taken by a built-in/existing command (reject-at-save); refuses to overwrite an existing saved workflow without `--force`.
- **Discovery (saved):** a `*.workflow.js` under `/workspace/.workflows/` registers as the bare command `<name>` (appears in `which`/catalog).
- **Discovery (skill-bundled, always namespaced):** a `*.workflow.js` under `/workspace/skills/<skill>/.workflows/` registers as `<skill>-<name>` — even when no collision exists (verify a no-collision skill workflow is reachable as `<skill>-<name>`, not bare `<name>`).
- **Precedence + protection:** a saved workflow named after a built-in never overrides it (the built-in still resolves); given both a `foo.jsh` and a saved `foo` workflow, bare `foo` resolves to the `.jsh` (precedence `built-in > .jsh > saved`), the workflow is still runnable via `workflow run /workspace/.workflows/foo.workflow.js`, and `which foo`/`commands` show both bindings.
- **Late arrival is order-independent:** register a saved `foo` workflow (bare `foo`), then add a `foo.jsh` and trigger a rebuild → bare `foo` rebinds to the `.jsh` (same result as if the `.jsh` had been present first); the workflow is demoted to its `workflow run <path>` form, not renamed.
- **Run saved:** invoking the discovered command runs the script through the run manager; a trailing JSON arg arrives as `args`; non-JSON arg arrives as a string.
- **`agent()` thinking:** extend the prelude test — `agent('x', { thinking: 'high' })` spawns with `--thinking high` in argv (alongside the existing `--model`/`--schema-b64` assertions); `agent('x', {})` includes no `--thinking`.

## 6. Documentation

- `docs/shell-reference.md` — `workflow save`, and that `*.workflow.js` files become commands (saved → bare `<name>` from `/workspace/.workflows/`; skill-bundled → `<skill>-<name>` from skill `.workflows/` dirs), including the bare-name precedence (`built-in > .jsh > saved-workflow`) and the `workflow run <path>` fallback for a shadowed workflow.
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

Resolved by Karl, settled on the Claude Code model (verified against CC's `/en/plugins` + `/en/skills` docs — CC namespaces the shareable surface upfront and resolves the rest by fixed precedence, with **no** rename-on-clash). Now in §2/§3/§5:

1. **Naming — namespace-by-source, no rename-on-clash.** Skill-bundled workflows are **always**
   `<skill>-<name>` (CC's `plugin:skill` model — collision-free by construction). Saved workflows
   take the bare `<name>`, with collisions prevented at save time (reject-at-save). Built-ins are
   protected. The earlier synthetic-suffix idea (`<name>-workflow` / `-2`) was dropped — CC has no
   such mechanism, and it created an arrival-order hazard.
2. **Bare-name precedence + late arrivals.** The one remaining contest (bare `<name>` wanted by a
   built-in, a `.jsh`, and/or a saved workflow) is decided by fixed precedence
   `built-in > .jsh > saved-workflow`, applied by recomputing the command-name table from the current
   file set on every source change. This makes "a `.jsh` appears after the save" behave identically to
   "the `.jsh` was already there" — no order dependence. A shadowed saved workflow loses only its bare
   shortcut and stays runnable via `workflow run <path>`; `which`/`commands` surface the shadow (never
   silent).
3. **Also discover skill-bundled workflows.** Scan `/workspace/skills/*/.workflows/*.workflow.js`
   in addition to `/workspace/.workflows/` — skills can ship turnkey workflow commands, mirroring how
   skills already bring `.jsh`.

No open questions remain; ready to plan.
