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

Scoops do heavy lifting; the cone orchestrates and synthesizes.

## When to delegate

**Default to delegation** for parallel independent work.

Delegate: multiple sources, time-consuming self-contained tasks, clear briefs.
Do yourself: single quick lookup, real-time adaptation, overhead > benefit.

## Brief for authority, not execution

Don't pre-research, pre-decide, then hand a typist plan. Give question + constraints + access.

| Bad                                                                | Good                                                                       |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| Cone reads 5 files, picks approach, tells scoop "implement X in Y" | "User wants Z; code under `/workspace/src/`. Pick approach and implement." |
| Cone summarizes docs, asks scoop to write comparison               | "Compare A, B, C at <urls>. Decide and write comparison."                  |
| Cone isolates bug, asks scoop to fix line 42                       | "Command fails with `<output>`. Find and fix." (or one-shot `agent`)       |

Cone's job: routing fan-out slices, synthesizing outputs. Wrong call → drop and re-spawn with better brief, don't correct in place.

## Scoop lifecycle

Drop when done. **NEVER drop a scoop that owns a sprinkle.**

Drop: task complete, stuck/misbehaving. Never: open sprinkle, recurring task, work in progress.

## Three primitives

| Primitive                    | Conversation | Sprinkle | Cleanup      | Use                             |
| ---------------------------- | ------------ | -------- | ------------ | ------------------------------- |
| `scoop_scoop` + `feed_scoop` | Multi-turn   | Yes      | `drop_scoop` | Long-lived, sprinkle owners     |
| `scoop_wait` / `scoop_mute`  | Multi-turn   | Yes      | No           | Parallel fan-out + synthesis    |
| `agent` (shell)              | One-shot     | No       | Auto         | Cheap, composable, no follow-up |

### `agent` — one-shot ephemeral sub-agents

Spawns sub-scoop, blocks, prints final message on stdout. Works from bash, `feed_scoop`, `.jsh`, dips, sprinkles.

```
agent <cwd> <allowed-commands> <prompt> [--model <id>] [--workspace-mode <mode>] [--read-only <paths>] [--background-after <s>]
```

- `<cwd>` — sole writable prefix (+ `/shared/`, scoop scratch, `/tmp/`). Relative paths vs caller cwd.
- `<allowed-commands>` — comma list; `*` unrestricted.
- `<prompt>` — verbatim; no caller history.
- `--model` — defaults parent model. Exact id, shorthand (`haiku`, `sonnet`), or `provider:model`. Bare id resolves selected provider first, then others; ambiguity errors. Hard error if unresolvable. Cross-provider needs `/etc/models` allow (see below).
- `--workspace-mode` — `shared-readonly` (default): parent workspace visible, cwd+`/shared/`+scratch writable, mounts readable. `private`: isolated — no parent workspace, no implicit `/shared/`, mounts not auto-visible. `snapshot`/`shared-live` unimplemented (exit 1).
- `--read-only` — pure-replace read list. Default: owning cone's workspace + `/workspace/skills/` + caller cwd. Literal `/workspace/` is primary cone's. Private default: `[]`.
- `--background-after <s>` — detach slow `bash` commands (default 600). `0` = immediate detach. Detached exit → `Background Command` lick.

**No handoff.** Ephemeral scoops don't notify cone. Result on stdout only.

```bash
for url in site-a site-b site-c; do
  agent "$TMPDIR" "curl,jq" "Fetch https://$url/api, return title." >> "$TMPDIR/titles.txt" &
done
wait

agent /workspace/src "rg,sed,node" "Rename getCwd to getCurrentWorkingDirectory across *.ts"
agent . '*' 'Summarize the README in one sentence.' --model claude-haiku-4-5
```

Dip/sprinkle patterns: `/workspace/skills/dips/SKILL.md`, `/workspace/skills/sprinkles/SKILL.md`.

## Sandbox shaping

`scoop_scoop` params: `workspaceMode`, `visiblePaths`, `writablePaths`, `allowedCommands`, `canCreateChildren`.

`canCreateChildren: true` grants nested `scoop_scoop`/`feed_scoop`/`drop_scoop`. Default false (leaf). Cannot pass on without grant.

| Param               | Default                                                                                | Pure replace? |
| ------------------- | -------------------------------------------------------------------------------------- | ------------- |
| `workspaceMode`     | `shared-readonly`                                                                      | Yes           |
| `visiblePaths`      | shared-readonly: `["/workspace/"]`; private: `[]`                                      | Yes           |
| `writablePaths`     | shared-readonly: `["/scoops/<folder>/", "/shared/"]`; private: `["/scoops/<folder>/"]` | Yes           |
| `allowedCommands`   | unrestricted                                                                           | Yes           |
| `canCreateChildren` | `false`                                                                                | Yes           |

`writablePaths` are always readable. True blind sandbox: `visiblePaths: []` AND `writablePaths: []`. Mounts readable in `shared-readonly` regardless of `visiblePaths`; `private` needs explicit mount paths. `allowedCommands` gates pipelines/recursively. List every absolute root tools write to, or writes escalate for approval. `playwright-cli` in scoops writes to scoop `$TMPDIR/.playwright/` — no extra `writablePaths`.

### Choosing

1. **Read?** → `visiblePaths` (default `/workspace/` fine for project work).
2. **Write?** → `writablePaths` (tighten for research-only scoops).
3. **Commands?** → tighten only when known set helps (`["curl","jq"]`, `["rg","sed","node"]`).

### Don't

- Don't widen `writablePaths` "just in case" — surprise write access is costly to recover from.
- Don't narrow `allowedCommands` without knowing which commands the scoop needs.
- Don't forget `writablePaths` are readable — `visiblePaths: []` alone isn't blind.

### Patterns

```
scoop_scoop({ name: "fix-bug", prompt: "..." })  # default

scoop_scoop({ name: "scratch-only", workspaceMode: "private", prompt: "..." })

scoop_scoop({ name: "auth-research", visiblePaths: ["/workspace/", "/shared/"],
  writablePaths: ["/scoops/auth-research/"], prompt: "Map auth flow → /scoops/auth-research/notes.md" })

scoop_scoop({ name: "giro-winners",
  writablePaths: ["/scoops/giro-winners/", "/shared/sprinkles/giro-winners/"], prompt: "..." })

scoop_scoop({ name: "scraper", visiblePaths: [], writablePaths: ["/scoops/scraper/"],
  allowedCommands: ["curl", "jq", "rg"], prompt: "Fetch <urls> → CSV at /scoops/scraper/out.csv" })

scoop_scoop({ name: "da-editor", writablePaths: ["/mnt/da/", "/scoops/da-editor/"],
  prompt: "Edit /mnt/da/index.html …" })
```

### `background_after`

`scoop_scoop({ background_after: <s> })` — detach slow commands (default 600). Per-call override: `bash({ command, background_after, timeout })`. Detached jobs have real pids (`ps`, `kill`).

### Filesystem work limits

Upstream limits: 100k traversal entries, 256 levels, 32 MiB input, 64 MiB live buffers. Split large trees. Not OPFS quota; doesn't cover custom `tar`/`unzip`/JS/Python/Git/browser. Independent of `timeout`/`background_after`.

## Parallel orchestration

Default: each scoop completion → `scoop-notify` → cone turn. N parallel scoops = N wasted turns.

- **`scoop_mute({ scoop_names })`** — stash completions to `/shared/scoop-notifications/*.md`; no cone turn.
- **`scoop_unmute({ scoop_names })`** — resume + return stashed summaries inline.
- **`scoop_wait({ scoop_names, timeout_ms? })`** — non-blocking wait; `scoop-wait` lick when all done or timeout. Implicit mute during wait. `timeout_ms: 0` = next tick. Omit = indefinite. Pre-existing mute survives.

> Scoop names resolve via `list_scoops`. Cross-cone scoops need `cross_cone: true` or error (#2360). Leading cone sees `[INHERITED]`/`[FOREIGN: <cone>]`. Cross-cone `feed_scoop` notifies owning cone — use `scoop_wait({ cross_cone: true })` for results.

- Fan-out + synthesis → `scoop_wait`.
- Background, check later → `scoop_mute` then `scoop_unmute`.
- Single delegation → default notify is fine.

### Examples

```
feed_scoop({ scoop_name: "writer-a", prompt: "Draft intro" })
feed_scoop({ scoop_name: "writer-b", prompt: "Draft outro" })
scoop_wait({ scoop_names: ["writer-a", "writer-b"], timeout_ms: 600000 })
# Non-blocking. Cone keeps working. When both finish (or 10 min), one
# scoop-wait lick wakes cone with both summaries.

scoop_mute({ scoop_names: ["scraper"] })
feed_scoop({ scoop_name: "scraper", prompt: "Collect URLs from sitemap" })
# ... other work ...
scoop_unmute({ scoop_names: ["scraper"] })
# Tool result has stashed summary or "No stashed completions".
```

### Liveness

Quiet fan-out ≠ done. Check `list_sudo_requests` for pending approvals. Complete only when all scoops report via `scoop-wait` or `scoop_unmute`. On deny, pass `reason` to `lick_dismiss`.

Full responses: `/shared/scoop-notifications/<timestamp>-<folder>-<id>.md` (200 most recent). Summary truncated at 20k chars; read VFS path for full output. Unknown scoop names reported but don't abort. Dropping/re-registering muted scoop is safe — waiters resolve `timedOut: true`, mute cleared.

## Cost

`cost` — spend for cone + live scoops. Table labels each row's source. `--json` → `{"budget": <window|null>, "scoops": [...]}` — read `.scoops`. Model column (JSON `model`) is the model that unit runs now (provider-qualified pin), not whichever took most turns. JSON `models` lists each distinct model once.

On rolling-allowance providers, `cost` leads with percent USED and reset time — that number, not dollar total, says whether long runs will finish.

`cost --all` adds dropped scoops from current runtime + frozen sessions in `/sessions/index.json`. Legacy frozen sessions retained with unknown cost, not zero.

## Model selection

**Always run `models` first.** `model` accepts exact id, shorthand (`haiku`, `sonnet`, `claude-haiku-4-5`), or `provider:model` form. Bare id resolves against selected provider first, then others; multiple matches → error listing qualified ids. Unresolvable id rejected — never silently falls back. Cross-provider needs `/etc/models` allow.

Intelligence, speed, cost are independent:

- Cost-sensitive (renames, formatting) → low-cost models.
- Complex (architecture, multi-file refactors) → high-intelligence.
- Latency-sensitive (interactive) → high-speed.
- Default → omit; inherits cone's model.

```bash
models
scoop_scoop({ name: "fix-typos", model: "claude-haiku-4-5", prompt: "Fix typos in /workspace/docs/" })
scoop_scoop({ name: "architect", model: "claude-opus-4-6", prompt: "Design the plugin system…" })
```

Scoops retry up to 3× with exponential backoff for transient errors (rate limits, 5xx). Non-retryable (invalid model, auth) fail immediately, bypassing `scoop_mute`.

## Browser tabs

All scoops share one browser. `playwright-cli` locks **per tab**: different tabs parallel, same tab serializes. One hung navigation stalls only its tab.

- **One tab per browser-driving scoop.** No fan-out cap for correctness.
- Two scoops on same tab queue — hand shared-tab work to one scoop.
- `note: browser bridge contended — …` on stderr = back-off guidance (stagger or own tab). Command already ran; don't re-run. Bridge-wide wait = global ops (`tab-select`, `--foreground`, attach).
- CPU/VFS/network scoops fan out freely.

Track your tab IDs. Never close tabs you didn't open. Handle "tab not found" gracefully. Scoop logs/snapshots go to scoop `$TMPDIR/.playwright/`.

## Model access policy

`/etc/models` — keyed by selected provider:

```ini
[adobe]
openrouter:*
-adobe:claude-opus-5
```

- Selected provider's own models allowed by default — never list them.
- Other provider's models denied until an entry allows. Spend boundary for separate accounts.
- `models` and picker hide only what `-` denies; visible ≠ spawnable. Rejection names exact line to add.

Do not edit `/etc/models` to unblock — write requires human approval (`Write /etc/models` in `/etc/sudoers`). Ask user, quoting the line.
