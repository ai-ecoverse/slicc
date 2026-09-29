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

Plain-JS orchestration: parallel sub-agents, results in script variables. Author → `workflow run` → `workflow save` as a command.

**Use for:** independent sweeps, parallel migrations, multi-source research, multi-angle planning. **Not for** single tasks — use a scoop or `agent`.

## API

- `agent(prompt, opts?)` → text or JSON (`opts.schema`). `opts`: `{ model?, thinking?, schema?, phase?, label? }`. `model`: bare id (`claude-opus-4-8`), never `provider:model`. `thinking`: `off|minimal|low|medium|high|xhigh`.
- `parallel(thunks)` — concurrent `() => Promise` (capped).
- `pipeline(items, ...stages)` — map through stages.
- `phase(title)` / `log(message)` — progress.
- `args` — JSON from invocation.

## Authoring

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
workflow run my.workflow.js            # non-blocking → run id
workflow run my.workflow.js --wait     # block inline (not saveable)
workflow status <runId>                # one-shot check — do NOT poll
workflow list
```

**Default is non-blocking and lick-driven.** Launch, then stop — never `sleep` or poll `workflow status`. Completion delivers a result lick with path + preview. `setTimeout`/`sleep` inside workflows is banned.

Save the script immediately (source exists at run start):

```bash
workflow run my.workflow.js
workflow save <runId> weekly-audit
```

`--wait` only when you need inline output in this turn.

## Saving

```bash
workflow save <runId> weekly-audit     # → /workspace/.workflows/weekly-audit.workflow.js
weekly-audit
weekly-audit '{"packages":["cherry"]}'
```

Skills ship under `skills/<skill>/.workflows/` as `<skill>:<name>`. Precedence: `built-in > .jsh > saved-workflow`. `workflow save` rejects colliding names.
