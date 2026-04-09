---
name: Scoop Management
description: Detailed scoop lifecycle, delegation rules, browser tab handling
---

# Scoop Management

## Delegation: When to Use Scoops

**Before starting any non-trivial task, ask: can this be parallelized?**

Delegate when:

- Multiple independent sources (e.g. scraping 3 websites = 3 scoops)
- Time-consuming work that doesn't need direct oversight
- Work expressible as a clear, self-contained brief

Do it yourself when:

- Single quick lookup (one page, one API call)
- Real-time adaptation needed (navigating broken URLs)
- Overhead of spawning exceeds benefit

**Default should be delegation.** Parallel scoops almost always finish faster. Synthesizing results is the cone's job.

## Scoop Lifecycle

**Drop scoops when done** — but **NEVER drop a scoop that owns a sprinkle**.

Drop when:

- Task completed and results synthesized
- Stuck or misbehaving (drop and re-spawn with better brief)

NEVER drop when:

- It owns an open sprinkle (scoop must stay alive for sprinkle's lifetime)
- Running recurring/long-running task (watching feeds, handling webhooks)
- Work still in progress (dropping loses all context)

## Browser Tab Handling

**Every playwright command requires `--tab=<targetId>`.** No implicit "current tab".

Workflow:

1. `playwright-cli tab-list` — lists tabs with targetIds. Active tab marked `(active)`.
2. `playwright-cli tab-new <url>` — opens tab, returns targetId. Capture it!
3. Use `--tab=<targetId>` on all subsequent commands.

**All agents share tabs.** `tab-list` shows every tab from every agent. Track your own by ID.

Rules:

- **NEVER close tabs you didn't create.** Unrecognized tabs belong to user or other agents.
- **Close research/scraping tabs** immediately after extracting data.
- **Never leave more than ~5 of your own tabs open.**
- Handle "tab not found" gracefully — another agent may have closed it.
- **Scoops must close their own tabs.** Include this in every scoop brief involving browser use.
- The preview/serve tab for a delivered app can stay open.

Remote targets (tray mode): `playwright-cli tab-list` shows remote tabs with composite targetIds (`runtimeId:localId`). Use `--tab=<compositeId>` to target. Use `--runtime=<id>` with `open`/`tab-new` to open on a specific remote runtime.

## Model Selection for Scoops

Use `models --json` to discover available models before creating scoops. The `scoop_scoop` tool accepts a `model` parameter.

Intelligence, speed, and cost are independent dimensions. Use `models --json` to compare them and pick the best tradeoff for each task:

- **Cost-sensitive tasks** (file renames, formatting, grep-and-replace): prefer low-cost models
- **Complex tasks** (architecture design, multi-file refactors, debugging subtle issues): prefer high-intelligence models
- **Latency-sensitive tasks** (interactive workflows, quick lookups): prefer high-speed models
- **Default**: if unsure, use the same model as the cone (omit the model parameter)

Example:

```
scoop_scoop({ name: "fix-typos", model: "claude-haiku-4-5-20251001", prompt: "Fix all typos in /workspace/docs/" })
scoop_scoop({ name: "architect", model: "claude-opus-4-6", prompt: "Design the new plugin system..." })
```
