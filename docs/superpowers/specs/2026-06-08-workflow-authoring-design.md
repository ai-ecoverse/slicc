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
- **Auto-discovery of `*.workflow.js` as commands** — discovered from `/workspace/.workflows/` (saved) **and from skill packages' `.workflows/` subdirs (`/workspace/skills/*/.workflows/`)**, registered as shell commands that run the script through the workflow runner. Runnable by you (`weekly-audit …`) or the cone (via `bash`). Naming follows Claude Code's model — **namespace-by-source, no rename-on-clash** (see §3): skill-bundled workflows are **always** `<skill>:<name>` (collision-free by construction — `:` can't appear in a skill/workflow name — exactly CC's `plugin:skill`); saved workflows get the **bare** `<name>`. When a bare name is contested, a **fixed precedence** (`built-in > .jsh > saved-workflow`) is resolved **at dispatch time** against the current files, so the binding never depends on arrival order.
- **`args` passing** — `<name> '<json>'` (or trailing args) is exposed to the saved script as the `args` global, JSON-parsed when possible.
- **Complete the `agent()` runtime options** — the SP1 prelude's `agent(prompt, opts)` already forwards `opts.model` and `opts.schema`; add `opts.thinking` → `--thinking <level>` (the underlying `agent` command + `AgentBridge` already accept it) so a workflow can set per-agent reasoning effort, e.g. `agent('design a careful plan first', { thinking: 'high' })`. Levels: `off | minimal | low | medium | high | xhigh`. The workflows skill documents the full option set. (Folded into SP3 because the authoring skill teaches the `agent()` surface, which should be complete + accurate.)

**Out:** keyword/`ultracode` triggers; the `.claude/workflows/` layout; plugins, marketplaces, sharing; per-workflow typed arg schemas.

## 3. Architecture

### The workflow skill (the trigger)

A **native skill** package bundled via `packages/vfs-root/workspace/skills/workflows/SKILL.md`, auto-loaded into the system prompt by the skills engine (progressive disclosure — read the full body on demand). **Note (codex review):** native `/workspace/skills` are loaded by _every_ scoop context (`scoop-context.ts`), not just the cone — so this is a "native workflow skill," not literally cone-only. That's fine (any agent that can run `workflow` benefits); if cone-only gating is ever wanted it's a separate skill-scoping feature. Content: the globals + semantics (from the spec §3 API table), the "when to use a workflow" guidance (codebase-wide sweeps, large migrations, cross-checked research, multi-angle planning), an authoring example, and the run/results model (non-blocking; result arrives as a new turn with a path + preview). **No code change makes this a trigger** — the cone simply uses the `workflow` command when the skill tells it to. This is the SLICC-idiomatic "skills over hardcoded features."

### Save

`workflow save <runId> <name>` (a new subcommand on the `workflow` command) reads `WorkflowRunManager.getRun(runId).source` (SP2 retains it; `source` is set at `start` and exposed via `getRun`, verified `workflow-run-manager.ts:~11/138/260`) and writes `/workspace/.workflows/<name>.workflow.js`. Validates `<name>` (`[a-z0-9][a-z0-9-]*`). **Reject-at-save** (CC-faithful "prevent collisions upfront"): if `<name>` is already taken by a built-in or an existing command at save time, the command errors and asks for a different name — saving is interactive, so the author loses nothing by picking another. It also refuses to overwrite an existing `/workspace/.workflows/<name>.workflow.js` unless `--force` is passed. (Reject-at-save catches the obvious case immediately; the **dispatch-time precedence** in §3 is the backstop for a `.jsh` that appears _after_ the save — see "Late arrivals.")

**Limitation (verified):** only **backgrounded** runs are saveable — they have a manager-tracked `runId`. A `workflow run --wait …` run executes inline and **bypasses the manager** (`runWait` never calls `mgr.start`, `workflow-command.ts:~175`), so it has no `runId` and `save` reports "no such run." `save` therefore requires a (non-`--wait`) run id; the skill should steer the cone to run non-blocking, then `save`.

### Discovery → bare command

**Codex review correction:** `ScriptCatalog` (`shell/script-catalog.ts`) is only a _discovery/cache_ service — it does **not** register commands. Bare-command registration lives in **`WasmShellHeadless.doSyncJshCommands`** (`shell/wasm-shell-headless.ts`), which today scans `.jsh` and registers each name. So SP3 owns changes there, not just a new discovery file.

**Grounding (verified read-only against the code during the design review — the mechanism below is built on these facts, not assumptions):**

- just-bash exposes only `registerCommand` (`node_modules/just-bash/dist/Bash.d.ts:247`) — there is **no** `unregisterCommand`. A name, once registered, cannot be cleanly removed (the lone `commands.delete` cast at `wasm-shell-headless.ts:~370` is a construction-time network-command hack and also leaves `/bin`+`/usr/bin` stub files). **So SP3 must not "rebuild the command table from scratch"** — it follows the existing idiom instead.
- The existing `.jsh` handler is already **late-binding**: its `execute` re-reads `catalog.getJshCommands()` on _every_ invocation and returns exit 127 if the file is gone (`wasm-shell-headless.ts:~745`). Registration is once-per-name; the behavior is resolved **at dispatch**.
- Built-in protection is **pre-existing**: the sync skips any name already in `builtinCommandNames` that isn't a registered `.jsh` (`wasm-shell-headless.ts:722`). "built-in > .jsh" already holds; SP3 only adds the lowest `saved-workflow` tier.
- just-bash dispatches a `:`-containing command name as a single word (**empirically verified**: `myskill:deploy` runs, `type` resolves it to `/usr/bin/myskill:deploy`, and it works inside compound commands). `:` is **not** in the skill/workflow name charset (`[A-Za-z0-9._-]`), so `<skill>:<name>` is genuinely collision-free.

- **Registration owner + routing:** add `*.workflow.js` discovery (`shell/workflow-discovery.ts`) feeding `ScriptCatalog`, **and** generalize the shell's `.jsh` sync into one "script-command sync" that also registers workflow names. The handler routes to the **workflow runner** — reusing `buildWorkflowCode` + `parseMetaBanner` + `makeSentinel` (in `workflow-command.ts` / `workflow-script.ts`) and the `WorkflowRunManager` published on `globalThis.__slicc_workflows`, **not** re-implementing them — and **never** `executeJsCode` on the raw file (that would run it as a trusted jsh script with full fs/exec). No on-disk `.jsh` shim.
- **Dispatch-time precedence (reuse the late-binding idiom, do NOT rebuild the table):** since there is no unregister, a bare name is registered **once** if _either_ a `.jsh` or a saved workflow claims it; the single `execute` handler resolves precedence **at dispatch** against current VFS state — a `.jsh` file present for this name → run it (existing path); else a saved workflow present → run it through the workflow runner; else exit 127. Built-ins are never reached (the `:722` guard prevents shadowing them). Because resolution reads live state, the binding is order- and deletion-independent **without ever removing a registration**.
- **Bare-name precedence:** `built-in > .jsh > saved-workflow`. built-in>.jsh is the pre-existing `:722` invariant; SP3's net-new logic is only the `.jsh`-then-saved-workflow tie-break _inside_ the dispatch handler. A shadowed saved workflow is never silent — `which <name>`/`commands` show the active binding **and** the shadowed workflow ("workflow (shadowed)") — and stays runnable via its canonical **`workflow run /workspace/.workflows/<name>.workflow.js`**. The `.jsh > saved-workflow` order preserves existing `.jsh` behavior and leans on that path-based fallback.
- **Late arrivals & deletions are order-independent (a consequence of dispatch-time resolution):** drop a `foo.jsh` next to an already-registered `foo` workflow → the next `foo` dispatch sees the `.jsh` and runs it (no re-register). Delete that `.jsh` → the next `foo` dispatch finds none and falls back to the workflow. Identical outcomes regardless of arrival order; no synthetic rename, no stale registration to clean up.
- **Re-sync trigger (name the watcher):** the load-bearing watcher is `WasmShellHeadless`'s registration watcher (`wasm-shell-headless.ts:281`), whose predicate is currently `path.endsWith('.jsh')`. Extend it to also fire on `*.workflow.js` under `/workspace/.workflows/` and `/workspace/skills/*/.workflows/`, and have `workflow save` trigger the same sync. (`ScriptCatalog`'s own cache-invalidation watcher at `script-catalog.ts:82` already watches _all_ paths, so only the shell's re-sync predicate needs widening; the sync only ever **registers** names — it never needs to unregister, per the dispatch-time model.)
- **Skill-bundled workflows are always `<skill>:<name>`** — unconditionally (CC's `plugin:skill` model). `<skill>` is the skill directory basename (`skills/discover.ts:~25`); `<name>` is the workflow filename stem. Because `:` cannot appear in either, `<skill>:<name>` is collision-free with built-ins, `.jsh`, saved workflows, and other skills' workflows (modulo unique skill names — a skill-system invariant), so skill workflows do **not** enter the bare-name contest at all. (This replaces the earlier hyphen idea, which was a lossy flatten: `weekly-audit`+`report` vs `weekly`+`audit-report`.)
- **`which`/`commands` visibility:** today these read the `.jsh` list (`SupplementalCommandsConfig.getJshCommands`, `which-command.ts`, `help-command.ts`). **Gotcha (verified):** registered names are added to `builtinCommandNames` (`wasm-shell-headless.ts:~789`) and `getFilteredJshCommands` (`:824`) _excludes_ anything in `builtinCommandNames`, so a workflow bare command would be filtered **out** of the jsh list. `getWorkflowCommands` must therefore read from a **separate workflow registry** (the discovery map), not the filtered jsh list, and label entries "workflow" (and "workflow (shadowed)" when a `.jsh`/built-in currently wins the bare name).
- **`args` coercion:** a single trailing argument is parsed as JSON when valid, else passed as a string; multiple positional args → a string array; no arg → `undefined`. **Note:** this is intentionally _more lenient_ than `workflow run --args`, which strictly `JSON.parse`s and errors on bad JSON (`workflow-command.ts:~76`). Both feed the same `args` global (`workflow-prelude.ts:~37`), so they are wire-compatible; the bare-command form just doesn't force authors to quote a JSON string for a simple scalar. `--wait` honored.
- **Discovery roots:** `/workspace/.workflows/` (saved, bare names) **and each skill package's `.workflows/` subdir — `/workspace/skills/*/.workflows/*.workflow.js`** (always `<skill>:<name>`), mirroring how skills already bring `.jsh`/compatibility scripts. Plus the existing catalog roots.

### `agent()` option completeness (one-line SP1-prelude rider)

`agent(prompt, opts)` in `shell/supplemental-commands/workflow-prelude.ts` currently forwards only `--model` (from `opts.model`) and `--schema-b64` (from `opts.schema`); `opts.thinking` is silently dropped, even though the `agent` command (`agent-command.ts`, `--thinking <level>`) and `AgentBridge` (`thinkingLevel`) already accept it. SP3 adds the pass-through (mirroring `--model`):

```js
if (opts.thinking) flags.push('--thinking', String(opts.thinking));
```

so the workflow API matches what the skill teaches — `agent(prompt, { model?, thinking?, schema?, phase?, label? })`. An invalid level is the `agent` command's own error (surfaced as a failed sub-agent → `null`), so no new validation is added in the prelude. Also update the prelude's `agent()` JSDoc (`workflow-prelude.ts:~45`), which currently documents only `phase`/`label` as no-ops and says nothing about `model`/`thinking`/`schema`.

### Components (files)

| Unit                          | File                                                                         | Responsibility                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| workflow skill                | `packages/vfs-root/workspace/skills/workflows/SKILL.md` (new)                | Teach the API + when/how to author & run a workflow (native skill; loaded by all scoops).                                                                                                                                                                                                                                                                                                                                                   |
| `workflow save`               | `shell/supplemental-commands/workflow-command.ts` (modify)                   | Persist a run's `source` to `/workspace/.workflows/<name>.workflow.js` (reject-at-save on name collision; `--force` to overwrite); trigger the command-name rebuild.                                                                                                                                                                                                                                                                        |
| discovery                     | `shell/workflow-discovery.ts` (new) + `shell/script-catalog.ts` (modify)     | Discover `*.workflow.js` under `/workspace/.workflows/` **and `/workspace/skills/*/.workflows/`**; feed the catalog (discovery/cache only).                                                                                                                                                                                                                                                                                                 |
| **registration + routing**    | `shell/wasm-shell-headless.ts` (modify)                                      | Generalize the `.jsh` sync to also register workflow names (skill workflows as `<skill>:<name>`, saved as bare `<name>`); single `execute` handler routes to the **workflow runner** (reusing `buildWorkflowCode`/`parseMetaBanner`/`makeSentinel`, not `executeJsCode`) and **resolves precedence at dispatch** (`built-in > .jsh > saved-workflow`). Extend the `:281` watcher predicate to `*.workflow.js`. No unregister (none exists). |
| `which`/`commands` visibility | `shell/supplemental-commands/{index,which-command,help-command}.ts` (modify) | Add `getWorkflowCommands` reading a **separate workflow registry** (not the `builtinCommandNames`-filtered jsh list); label "workflow" / "workflow (shadowed)".                                                                                                                                                                                                                                                                             |
| `agent()` thinking opt        | `shell/supplemental-commands/workflow-prelude.ts` (modify)                   | Forward `opts.thinking` → `--thinking <level>` (mirrors `opts.model`); completes the documented `agent()` option set.                                                                                                                                                                                                                                                                                                                       |

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
- **Save of a `--wait` run errors:** saving the id of a `--wait` (inline) run reports "no such run" (only backgrounded, manager-tracked runs are saveable).
- **Discovery (saved):** a `*.workflow.js` under `/workspace/.workflows/` registers as the bare command `<name>` (appears in `getWorkflowCommands`/`which`).
- **Discovery (skill-bundled, always namespaced):** a `*.workflow.js` under `/workspace/skills/<skill>/.workflows/` registers as `<skill>:<name>` — even when no collision exists (verify a no-collision skill workflow is reachable as `<skill>:<name>`, not bare `<name>`, and that just-bash dispatches the `:`-named command).
- **Precedence + protection:** a saved workflow named after a built-in never overrides it (the built-in still resolves); given both a `foo.jsh` and a saved `foo` workflow, bare `foo` resolves (at dispatch) to the `.jsh` (precedence `built-in > .jsh > saved`), the workflow is still runnable via `workflow run /workspace/.workflows/foo.workflow.js`, and `which foo`/`commands` show both bindings (the workflow as "shadowed").
- **Dispatch-time fallback (delete the `.jsh`):** with both `foo.jsh` and saved `foo` present (bare `foo` → `.jsh`), delete `foo.jsh` → the next `foo` invocation falls back to the saved workflow with **no** re-registration step (proves the late-binding handler, not a table rebuild).
- **Late arrival is order-independent:** register a saved `foo` workflow (bare `foo`), then add a `foo.jsh` → the next `foo` invocation runs the `.jsh` (same result as if the `.jsh` had been present first); the workflow is demoted to its `workflow run <path>` form, not renamed.
- **Run saved:** invoking the discovered command runs the script through the run manager; a trailing JSON arg arrives as `args`; non-JSON arg arrives as a string.
- **`agent()` thinking:** extend the prelude test — `agent('x', { thinking: 'high' })` spawns with `--thinking high` in argv (alongside the existing `--model`/`--schema-b64` assertions); `agent('x', {})` includes no `--thinking`.

## 6. Documentation

- `docs/shell-reference.md` — `workflow save`, and that `*.workflow.js` files become commands (saved → bare `<name>` from `/workspace/.workflows/`; skill-bundled → `<skill>:<name>` from skill `.workflows/` dirs), including the bare-name precedence (`built-in > .jsh > saved-workflow`) and the `workflow run <path>` fallback for a shadowed workflow.
- `packages/vfs-root/shared/CLAUDE.md` — point the cone at the workflows skill.
- `docs/architecture.md` — note `*.workflow.js` discovery alongside `.jsh`/`.bsh`.
- The `workflows` `SKILL.md` documents the full `agent()` option set: `agent(prompt, { model?, thinking?, schema?, phase?, label? })` — including the newly-wired `thinking` level.

## 7. Non-goals (SP3)

Keyword/`ultracode` triggers; `.claude/workflows/` layout; plugins/marketplaces/sharing; typed arg schemas; cross-repo workflow distribution.

## 8. Open questions (resolve during planning)

Resolved by the codex/design review (now in §3): registration owner is `WasmShellHeadless` (not
`ScriptCatalog`, which is discovery-only) routing to the workflow runner; `args` coercion is JSON-or-string /
multi→array / none→undefined (intentionally **more lenient** than the strict `workflow run --args`, which
errors on bad JSON — see §3); non-blocking default with `--wait`; `save`→re-sync; `which`/`commands`
plumbing; "native workflow skill" (loaded by all scoops, not literally cone-only).

Resolved by Karl, settled on the Claude Code model (verified against CC's `/en/plugins` + `/en/skills` docs — CC namespaces the shareable surface upfront and resolves the rest by fixed precedence, with **no** rename-on-clash). Now in §2/§3/§5:

1. **Naming — namespace-by-source, no rename-on-clash.** Skill-bundled workflows are **always**
   `<skill>:<name>` (CC's `plugin:skill` model — collision-free because `:` is outside the
   skill/workflow name charset; **empirically verified** just-bash dispatches `:`-named commands). Saved
   workflows take the bare `<name>`, with collisions prevented at save time (reject-at-save). Built-ins
   are protected. The earlier synthetic-suffix idea (`<name>-workflow` / `-2`) and the interim hyphen
   `<skill>-<name>` were both dropped (the suffix created an arrival-order hazard; the hyphen was a lossy
   flatten).
2. **Bare-name precedence + late arrivals.** The one remaining contest (bare `<name>` wanted by a
   built-in, a `.jsh`, and/or a saved workflow) is decided by fixed precedence
   `built-in > .jsh > saved-workflow`, **resolved at dispatch time** by a register-once late-binding
   handler (the existing `.jsh` idiom — there is **no** unregister in just-bash, so the table is never
   "rebuilt"). This makes a `.jsh` that appears (or is deleted) after the save behave identically to
   "always there"/"never there" — no order dependence. A shadowed saved workflow loses only its bare
   shortcut and stays runnable via `workflow run <path>`; `which`/`commands` surface the shadow (never
   silent). built-in>.jsh is a **pre-existing** invariant (`wasm-shell-headless.ts:722`); SP3 adds only
   the lowest tier.
3. **Also discover skill-bundled workflows.** Scan `/workspace/skills/*/.workflows/*.workflow.js`
   in addition to `/workspace/.workflows/` — skills can ship turnkey workflow commands, mirroring how
   skills already bring `.jsh`.

**Design-review pass (this round):** an independent reviewer read the spec against the actual webapp
source and flagged two blockers — (1) the original "rebuild the command table from scratch" was
unbuildable (just-bash has no `unregisterCommand`), and (2) the hyphen `<skill>-<name>` was not
collision-free. Both are now resolved above against verified facts (dispatch-time late-binding;
`:` separator, just-bash-dispatch confirmed). All claimed extension points (`wasm-shell-headless`
registration, `workflow-prelude`/`agent-command` `--thinking`, `getRun().source`, native-skill loading,
`which`/`commands` plumbing) were verified to exist.

No open questions remain; ready to plan.
