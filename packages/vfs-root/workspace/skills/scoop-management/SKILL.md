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

## Ephemeral Agents via `agent` Shell Command

The `agent` supplemental shell command spawns a one-shot sub-scoop, feeds it a prompt, blocks until the agent loop completes, and prints the final message on stdout. Unlike `scoop_scoop`, it is a **shell command** — available from any bash context (terminal panel, `feed_scoop` prompt, inside a `.jsh` script, or nested from another `agent` call).

### When to use `agent` vs `scoop_scoop`

Prefer `agent` when the task is:

- **One-shot and composable** — you want the result inlined into a pipeline (`agent . '*' 'count the TODOs' | wc -l`).
- **Narrow scope with a fixed command allow-list** — e.g. a scraping agent restricted to `curl,grep,jq`.
- **Self-contained** — the caller does NOT need a conversational loop with the sub-agent; one prompt, one answer, done.
- **Cheap cleanup** — the scoop is auto-dropped when the command exits; no `drop_scoop` follow-up required.

Prefer `scoop_scoop` when you need:

- **Persistent conversation** (`feed_scoop` follow-ups, cone keeps orchestrating).
- **Sprinkle ownership** — sprinkles require their owning scoop to stay alive.
- **Parallel fan-out with later synthesis** — several scoops running concurrently that you'll drain separately.

### Invocation

```
agent <cwd> <allowed-commands> <prompt> [--model <id>] [--read-only <paths>]
```

- `<cwd>` is the spawned scoop's sole writable prefix (plus `/shared/`, its own scratch folder, and `/tmp/`). Relative paths are resolved against the caller's cwd.
- `<allowed-commands>` is a comma-separated shell command allow-list; use `*` for unrestricted.
- `<prompt>` is forwarded verbatim to the scoop.
- `--model` overrides the model id (default: inherits the parent scoop's model, or the cone's model when invoked from the terminal).
- `--read-only` is a pure-replace list of read-only visiblePaths. Default when absent: `/workspace/` + the invoking shell's cwd (so the agent can read where it was launched from).

### Sandbox defaults

- Writable: `<cwd>`, `/shared/`, the scoop's scratch folder, and `/tmp/` (always-on ambient scratch — not toggleable).
- Visible read-only: `/workspace/` plus the invoking shell's cwd (dropped entirely when `--read-only` is passed).
- Sandbox escape is closed: when invoked from a scoop shell, `<cwd>` must be writable by the calling scoop — you cannot pass `/scoops` to gain a write prefix over sibling sandboxes.

### Examples

```bash
# Extract titles from three pages in parallel, collect to one file.
for url in site-a site-b site-c; do
  agent /tmp "curl,jq" "Fetch https://$url/api, return the top-level title field." >> /tmp/titles.txt &
done
wait

# Delegate a focused refactor with a restricted allow-list.
agent /workspace/src "rg,sed,node" "Rename getCwd to getCurrentWorkingDirectory across *.ts"

# One-shot summary from a specific model.
agent . '*' 'Summarize the README in one sentence.' --model claude-haiku-4-5
```

### Cost and behavior notes

- Ephemeral agent scoops do NOT notify the cone on completion — the caller gets the result on stdout, nothing else. Running `agent` from a non-cone shell does not trigger an unsolicited cone turn.
- The spawned scoop gets its own conversation; it cannot see the caller's history. Pack context into the prompt.
- `agent` exits with the sub-scoop's exit code; stderr carries bridge errors (validation, model resolution, spawn failures).

## Parallel Orchestration: `scoop_mute` / `scoop_unmute` / `scoop_wait`

By default, every non-ephemeral scoop completion fires a `scoop-notify` event that wakes the cone for a fresh turn. When you fan out N scoops in parallel, that's N extra cone turns whose only job is to acknowledge "scoop X finished" — expensive in tokens and disruptive to the orchestration you actually want to run.

These three cone-only tools let you collapse that fan-out into a single follow-up turn:

- **`scoop_mute({ scoop_names })`** — suspends `scoop-notify` delivery for the listed scoops. A completion that arrives while muted is stashed (full response persisted to `/shared/scoop-notifications/*.md`); it does NOT trigger a cone turn.
- **`scoop_unmute({ scoop_names })`** — resumes notifications AND returns every stashed completion inline as this tool's result. The cone reads the summaries in the current turn instead of taking one extra turn per scoop.
- **`scoop_wait({ scoop_names, timeout_ms? })`** — schedules a NON-BLOCKING wait. The tool returns immediately so the cone can keep working; when every listed scoop has completed (or the timeout fires) the orchestrator delivers a single `scoop-wait` channel lick containing all captured summaries. Target scoops are implicitly muted for the duration so individual `scoop-notify` events don't pre-empt the eventual `scoop-wait` lick. Completions that arrived before the call are folded into the same lick. `timeout_ms: 0` means "fire the lick on the next tick with whatever is already done". Omit `timeout_ms` to wait indefinitely. After the wait resolves, only scoops muted by this call are unmuted — pre-existing `scoop_mute` state survives.

### When to use which

- **Fire-and-forget background work you'll check later** → `scoop_mute` now, do other work, `scoop_unmute` when you want the summaries.
- **Fan-out with synthesis** (you delegate to several scoops and your next useful step depends on all of them) → `scoop_wait`. One tool call schedules the wait without blocking the cone; a single `scoop-wait` lick wakes the cone once they all finish (or the timeout fires) with every summary in one payload.
- **Single delegation, no parallelism** → don't mute. The default `scoop-notify` path is fine.

### Examples

```
# Fan-out + synthesize:
feed_scoop({ scoop_name: "writer-a", prompt: "Draft intro" })
feed_scoop({ scoop_name: "writer-b", prompt: "Draft outro" })
scoop_wait({ scoop_names: ["writer-a", "writer-b"], timeout_ms: 600000 })
# -> Returns immediately. Cone can keep working, ask the user follow-ups,
#    or end its turn. When both scoops finish (or 10 min elapses) a
#    single `scoop-wait` lick is delivered with both summaries; the
#    cone's next turn synthesizes them.

# Start background work, poll non-blockingly:
scoop_mute({ scoop_names: ["scraper"] })
feed_scoop({ scoop_name: "scraper", prompt: "Collect URLs from the sitemap" })
# ... do other work ...
scoop_unmute({ scoop_names: ["scraper"] })
# -> tool result either has the stashed summary or reports "No stashed completions".
```

### Notes

- The full response is always persisted to `/shared/scoop-notifications/<timestamp>-<folder>-<id>.md` (bounded to the 200 most recent artifacts). The summary string in the tool result is truncated at 20 000 characters; read the VFS path when the cone needs the full output.
- Unknown scoop names in any of the three tools are reported in the result but do not abort the call.
- Dropping or re-registering a muted scoop is safe: `unregisterScoop` releases any outstanding waiters (they resolve as `timedOut: true`) and clears mute/pending state.

## Model Selection for Scoops

**IMPORTANT: Always run `models` to verify available models before specifying a model for a scoop.** Model availability depends on the configured provider and API key. Specifying a non-existent model will cause the scoop to fail immediately with an unrecoverable error.

Use `models --json` to discover available models before creating scoops. The `scoop_scoop` tool accepts a `model` parameter.

Intelligence, speed, and cost are independent dimensions. Use `models --json` to compare them and pick the best tradeoff for each task:

- **Cost-sensitive tasks** (file renames, formatting, grep-and-replace): prefer low-cost models
- **Complex tasks** (architecture design, multi-file refactors, debugging subtle issues): prefer high-intelligence models
- **Latency-sensitive tasks** (interactive workflows, quick lookups): prefer high-speed models
- **Default**: if unsure, use the same model as the cone (omit the model parameter)

Example:

```bash
# First, check available models
models

# Then create scoops with verified model IDs
scoop_scoop({ name: "fix-typos", model: "claude-haiku-4-5", prompt: "Fix all typos in /workspace/docs/" })
scoop_scoop({ name: "architect", model: "claude-opus-4-6", prompt: "Design the new plugin system..." })
```

**Error handling**: If a scoop fails due to an invalid model or API error, it will retry up to 3 times with exponential backoff for transient errors (rate limits, server errors). Non-retryable errors (invalid model, auth failures) fail immediately and notify the cone, bypassing any `scoop_mute` settings.
