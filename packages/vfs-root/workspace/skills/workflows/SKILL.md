---
name: workflows
description: |
  Use this when a task is a fan-out/aggregate job worth orchestrating in code rather
  than doing turn-by-turn: codebase-wide sweeps, large migrations, multi-source research
  you cross-check, or multi-angle planning. Covers authoring a workflow (the meta block +
  the agent/parallel/pipeline/phase/log API), running it (non-blocking by default), and
  saving a good run as a reusable command. NOT for one-off single-agent tasks — use a
  plain scoop or `agent` for those.
allowed-tools: bash, read_file, write_file
---

# Workflows

A workflow is a plain-JS orchestration script that fans out to parallel sub-agents and
keeps intermediate results in script variables (not your context). You author it, run it
with `workflow run`, and — once it's good — `workflow save` it as a reusable command.

## When to reach for a workflow

- A sweep over many files/items where each unit is independent (lint, classify, summarize).
- A migration applied across a codebase in parallel, then aggregated.
- Research that fans out to several sources and cross-checks them.
- Multi-angle planning (draft N approaches in parallel, then synthesize).

If it's a single self-contained task, just use a plain scoop or the `agent` command — a
workflow is overhead you don't need.

## The API (available inside a workflow script)

- `agent(prompt, opts?)` → the sub-agent's text (or parsed JSON when `opts.schema` is set),
  or `null` on failure. `opts`: `{ model?, thinking?, schema?, phase?, label? }`.
  - `thinking`: `off | minimal | low | medium | high | xhigh` (per-agent reasoning effort).
  - `schema`: a JSON Schema; the result is constrained to it and JSON-parsed for you.
  - `phase` / `label`: display-only grouping (no execution effect yet).
- `parallel(thunks)` → runs an array of `() => Promise` concurrently (bounded by the cap).
- `pipeline(items, ...stages)` → maps items through stages.
- `phase(title)` / `log(message)` → progress markers.
- `args` → the value passed when the workflow is invoked (`<name> '<json>'`).

## Authoring

A workflow MUST export a `meta` block with a `name` (description optional):

```js
export const meta = { name: 'weekly-audit', description: 'Audit each package in parallel' };

const pkgs = args?.packages ?? ['webapp', 'node-server'];
phase('audit');
const findings = await parallel(
  pkgs.map((p) => () => agent(`Audit packages/${p} for TODOs. One line each.`, { thinking: 'low' }))
);
return findings.filter(Boolean);
```

## Running

```bash
workflow run my.workflow.js            # non-blocking (default) — returns a run id immediately
workflow run my.workflow.js --wait     # block and print the full result inline
workflow status <runId>                # one-shot progress check (NOT for polling loops)
workflow list                          # all runs
```

**Non-blocking is the default, and it is lick-driven — do NOT sleep or poll to wait for it.**
`workflow run` returns a run id and your turn ends. When the run finishes, its result is delivered
back to you automatically as a **new turn** (a completion _lick_) carrying the result path plus a
preview — you will be re-invoked then. So the pattern is: **launch it, then stop.** Never `sleep`,
and never loop on `workflow status` waiting for completion — the lick is how you get the result, and
manually waiting just wastes a turn (and `setTimeout`/`sleep` inside the workflow itself is banned by
the determinism guard anyway).

You do **not** need to wait for a run to finish before saving it: `workflow save` persists the
script _source_, which exists the moment the run starts. So the idiomatic flow is **launch
non-blocking → `workflow save <runId> <name>` right away → end your turn**; the result lick arrives
on its own.

Use `--wait` ONLY when you genuinely need the full result inline in the current turn (it blocks until
the run finishes). Note `--wait` runs are **not** saveable (they have no tracked run id) — run
non-blocking when you intend to save.

## Saving as a reusable command

```bash
workflow save <runId> weekly-audit     # → /workspace/.workflows/weekly-audit.workflow.js
weekly-audit                           # now a bare command
weekly-audit '{"packages":["cherry"]}' # JSON arg arrives as `args`
```

Saved workflows live in `/workspace/.workflows/` and become bare commands (`weekly-audit`).
Skills can also ship workflows under `skills/<skill>/.workflows/`, which register as
`<skill>:<name>`. If a bare name collides, the precedence is `built-in > .jsh > saved-workflow`
(a built-in or `.jsh` keeps the bare name; the workflow is still runnable via
`workflow run /workspace/.workflows/<name>.workflow.js`). `workflow save` rejects a name
that's already a command, so pick another.
