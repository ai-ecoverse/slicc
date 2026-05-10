---
name: delegation
description: |
  Use this when deciding whether to do work yourself or delegate to a scoop, when
  fanning out parallel scoops, or when picking models for sub-agents. Covers
  scoop lifecycle (when to drop), parallel orchestration (`scoop_mute`,
  `scoop_unmute`, `scoop_wait`), one-shot ephemeral sub-agents via the `agent`
  shell command, and model selection. Read this BEFORE running `scoop_scoop` for
  non-trivial work.
allowed-tools: bash
---

# Delegation

Scoops do the heavy lifting; the cone orchestrates and synthesizes. This skill is about choosing how to delegate, not about administering scoops.

## When to delegate

**Default to delegation.** Parallel scoops almost always finish faster, and the cone's job is synthesis.

Delegate when:

- Multiple independent sources (scraping 3 sites = 3 scoops).
- Time-consuming work that doesn't need direct oversight.
- Work expressible as a clear, self-contained brief.

Do it yourself when:

- Single quick lookup (one page, one API call).
- Real-time adaptation needed (navigating broken URLs).
- Overhead of spawning exceeds benefit.

## Scoop lifecycle

Drop scoops when done — but **NEVER drop a scoop that owns a sprinkle**.

Drop when:

- Task completed and results synthesized.
- Stuck or misbehaving (drop and re-spawn with a better brief).

Never drop when:

- It owns an open sprinkle (must stay alive for the sprinkle's lifetime).
- Running a recurring/long-running task (feed watcher, webhook handler).
- Work is still in progress (dropping loses all context).

## Three delegation primitives

| Primitive                    | Conversation             | Sprinkle ownership | Auto-cleanup      | When to use                                                 |
| ---------------------------- | ------------------------ | ------------------ | ----------------- | ----------------------------------------------------------- |
| `scoop_scoop` + `feed_scoop` | Persistent (multi-turn)  | Yes                | No (`drop_scoop`) | Long-lived work; sprinkle owners; conversational follow-ups |
| `scoop_wait` / `scoop_mute`  | Persistent (multi-turn)  | Yes                | No                | Parallel fan-out where you want one synthesis turn          |
| `agent` (shell command)      | One-shot (single prompt) | No                 | Yes (on exit)     | Cheap, predictable, composable; no cone follow-up needed    |

### `agent` — one-shot ephemeral sub-agents

`agent` is a shell command that spawns a one-shot sub-scoop, feeds it a prompt, blocks until the agent loop completes, and prints the final message on stdout. Runs from any bash context (terminal, `feed_scoop` prompt, `.jsh` script, dip lick handler, sprinkle button handler).

```
agent <cwd> <allowed-commands> <prompt> [--model <id>] [--read-only <paths>]
```

- `<cwd>` — sole writable prefix (plus `/shared/`, the scoop's scratch folder, and `/tmp/`). Relative paths resolve against the caller's cwd.
- `<allowed-commands>` — comma-separated allow-list; `*` for unrestricted.
- `<prompt>` — forwarded verbatim. The spawned scoop has no access to the caller's history; pack context into the prompt.
- `--model` — defaults to the parent scoop's model (or the cone's, when invoked from the terminal).
- `--read-only` — pure-replace list of read-only paths. Default: `/workspace/` plus the invoking shell's cwd.

**Critical property: no handoff.** Ephemeral scoops do NOT notify the cone on completion. Running `agent` from a non-cone shell does not trigger an unsolicited cone turn. The caller gets the result on stdout, nothing else. This makes `agent` the right choice for cheap, predictable interactions inside dips and sprinkles where you don't want the cone or owning scoop woken up.

```bash
# Parallel, collected to one file. No cone turns spawned.
for url in site-a site-b site-c; do
  agent /tmp "curl,jq" "Fetch https://$url/api, return the top-level title field." >> /tmp/titles.txt &
done
wait

# Focused refactor with a restricted allow-list.
agent /workspace/src "rg,sed,node" "Rename getCwd to getCurrentWorkingDirectory across *.ts"

# Cheap one-shot from a faster model.
agent . '*' 'Summarize the README in one sentence.' --model claude-haiku-4-5
```

For dip and sprinkle interaction patterns built on `agent`, see `/workspace/skills/dips/SKILL.md` and `/workspace/skills/sprinkles/SKILL.md`.

## Parallel orchestration: `scoop_mute` / `scoop_unmute` / `scoop_wait`

By default, every non-ephemeral scoop completion fires a `scoop-notify` event that wakes the cone for a fresh turn. Fanning out N scoops in parallel produces N extra cone turns whose only job is to acknowledge "scoop X finished" — expensive in tokens, disruptive to orchestration.

These three cone-only tools collapse the fan-out into a single follow-up turn:

- **`scoop_mute({ scoop_names })`** — suspends `scoop-notify` for the listed scoops. Completions arriving while muted are stashed (full response persisted to `/shared/scoop-notifications/*.md`); they do NOT trigger a cone turn.
- **`scoop_unmute({ scoop_names })`** — resumes notifications AND returns every stashed completion inline as the tool's result. The cone reads the summaries in the current turn instead of one extra turn per scoop.
- **`scoop_wait({ scoop_names, timeout_ms? })`** — schedules a NON-BLOCKING wait. Returns immediately so the cone can keep working; when every listed scoop completes (or the timeout fires) the orchestrator delivers a single `scoop-wait` channel lick with all captured summaries. Target scoops are implicitly muted for the wait's duration so individual `scoop-notify` events don't pre-empt the eventual lick. `timeout_ms: 0` fires on the next tick with whatever is already done. Omit `timeout_ms` to wait indefinitely. Pre-existing `scoop_mute` state survives the wait.

### When to use which

- **Fan-out + synthesis** (your next useful step depends on all scoops) → `scoop_wait`.
- **Background work you'll check later** → `scoop_mute` now, `scoop_unmute` when you want the summaries.
- **Single delegation, no parallelism** → don't mute. Default `scoop-notify` is fine.

### Examples

```
# Fan-out + synthesize:
feed_scoop({ scoop_name: "writer-a", prompt: "Draft intro" })
feed_scoop({ scoop_name: "writer-b", prompt: "Draft outro" })
scoop_wait({ scoop_names: ["writer-a", "writer-b"], timeout_ms: 600000 })
# Returns immediately. Cone keeps working. When both finish (or 10 min), a single
# `scoop-wait` lick wakes the cone with both summaries; the next turn synthesizes.

# Background, poll non-blockingly:
scoop_mute({ scoop_names: ["scraper"] })
feed_scoop({ scoop_name: "scraper", prompt: "Collect URLs from the sitemap" })
# ... do other work ...
scoop_unmute({ scoop_names: ["scraper"] })
# Tool result has the stashed summary or "No stashed completions".
```

### Notes

- Full response is always persisted to `/shared/scoop-notifications/<timestamp>-<folder>-<id>.md` (bounded to the 200 most recent). The summary string in the tool result is truncated at 20 000 characters; read the VFS path when you need the full output.
- Unknown scoop names are reported in the result but do not abort the call.
- Dropping or re-registering a muted scoop is safe: `unregisterScoop` releases waiters (resolving as `timedOut: true`) and clears mute/pending state.

## Model selection for scoops

**Always run `models` to verify available models before specifying one.** Model availability depends on the configured provider and API key. Specifying a non-existent model fails immediately with an unrecoverable error.

Use `models --json` to compare. Intelligence, speed, and cost are independent dimensions:

- **Cost-sensitive** (renames, formatting, grep-and-replace) → low-cost models.
- **Complex** (architecture, multi-file refactors, subtle debugging) → high-intelligence.
- **Latency-sensitive** (interactive workflows, quick lookups) → high-speed.
- **Default** → omit the parameter; inherits the cone's model.

```bash
# 1. Verify available models.
models

# 2. Create scoops with verified IDs.
scoop_scoop({ name: "fix-typos", model: "claude-haiku-4-5", prompt: "Fix all typos in /workspace/docs/" })
scoop_scoop({ name: "architect", model: "claude-opus-4-6", prompt: "Design the new plugin system..." })
```

**Error handling**: scoops retry up to 3 times with exponential backoff for transient errors (rate limits, server errors). Non-retryable errors (invalid model, auth failures) fail immediately and notify the cone, bypassing any `scoop_mute` settings.

## Browser tabs

Browser-tab handling rules (track your IDs, never close tabs you didn't open, handle "tab not found" gracefully) live in `/workspace/skills/playwright-cli/SKILL.md` under "Multi-Agent Tab Behavior". Read that skill before delegating browser work.
