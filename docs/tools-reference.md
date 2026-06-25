# Tools Reference

Complete reference for the tool modules and active agent tool surface in SLICC. `packages/webapp/src/tools/` contains file, bash, browser, and search tool factories, but the current scoop/cone surface wired in `packages/webapp/src/scoops/scoop-context.ts` is: `read_file`, `write_file`, `edit_file`, `bash`, and scoop-management tools. Browser automation and search for active scoop agents now run through shell commands via `bash` (`playwright-cli` / `playwright` / `puppeteer`, plus shell-native `rg` / `grep` / `find`).

---

## Tool Architecture

### ToolDefinition Interface

Legacy tool interface (packages/webapp/src/tools/):

```typescript
interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: ToolInputSchema;
  execute(input: Record<string, unknown>): Promise<ToolResult>;
}

interface ToolInputSchema {
  type: 'object';
  properties?: Record<string, unknown>;
  required?: string[];
  [k: string]: unknown;
}

interface ToolResult {
  content: string;
  isError?: boolean;
}
```

### AgentTool Interface (pi-compatible)

Modern agent tool interface (packages/webapp/src/core/types.ts):

```typescript
interface AgentTool<TDetails = unknown> extends Tool {
  label: string;
  execute: (
    toolCallId: string,
    params: Record<string, any>,
    signal?: AbortSignal,
    onUpdate?: AgentToolUpdateCallback<TDetails>
  ) => Promise<AgentToolResult<TDetails>>;
}

interface AgentToolResult<T = unknown> {
  content: (TextContent | ImageContent)[];
  details: T;
}

interface TextContent {
  type: 'text';
  text: string;
}

interface ImageContent {
  type: 'image';
  data: string; // base64
  mimeType: string;
}
```

### Tool Adapter

The `tool-adapter.ts` converts `ToolDefinition` → `AgentTool`:

```typescript
// packages/webapp/src/core/tool-adapter.ts
export function adaptTools(tools: ToolDefinition[]): AgentTool[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
    label: tool.name,
    execute: async (toolCallId, params, signal, onUpdate) => {
      const result = await tool.execute(params);
      return {
        content: [{ type: 'text', text: result.content }],
        details: { isError: result.isError },
      };
    },
  }));
}
```

---

## Core Agent Tools

### bash

**File**: `packages/webapp/src/tools/bash-tool.ts`

Execute shell commands in a full Unix-like environment (`just-bash`; see `packages/webapp/package.json` for the pinned version).

| Property   | Value                                 |
| ---------- | ------------------------------------- |
| **Name**   | `bash`                                |
| **Input**  | `{ command: string }`                 |
| **Output** | `{ content: stdout+stderr, isError }` |

**Schema**:

```json
{
  "type": "object",
  "properties": {
    "command": { "type": "string", "description": "The bash command to execute" }
  },
  "required": ["command"]
}
```

**Features**:

- 78+ commands (grep, sed, awk, find, jq, tar, curl, git, node, python3, etc.)
- Pipes, redirects, control flow, command substitution
- Custom commands include `git`, `node -e`, `python3 -c`, `sqlite3`, `zip/unzip`, `webhook`, `crontask`, `convert`, `which`, and `playwright-cli` / `playwright` / `puppeteer`
- Networking: Full `curl` with HTTP methods, headers, auth, body
- Text processing: grep, rg, sed, awk, cut, tr, sort, uniq, wc, head, tail
- Browser automation for active agents runs through `playwright-cli` / `playwright` / `puppeteer`
- Active agents perform search through shell-native `grep` / `find` / `rg` via `bash`
- Data: jq (JSON), base64, md5sum, sha256sum

**Exit status handling**:

- Most non-zero shell exit codes are returned as `isError: true`
- Expected no-match `grep`/`egrep`/`fgrep`/`rg` exits (`1` with empty stderr) stay non-errors so agents can check absence without retrying

**Examples**:

```bash
# List files
ls -la /workspace

# Chain commands
echo "hello" | tr a-z A-Z

# Process JSON
curl https://api.example.com | jq '.data[] | .id'

# Run git
git log --oneline -5

# Execute Node
node -e "console.log(2 + 2)"

# Run Python
python3 -c "print([i**2 for i in range(5)])"
```

---

### read_file

**File**: `packages/webapp/src/tools/file-tools.ts`

Read file contents from the virtual filesystem (VirtualFS for cone, RestrictedFS for scoops).

| Property   | Value                                               |
| ---------- | --------------------------------------------------- |
| **Name**   | `read_file`                                         |
| **Input**  | `{ path: string, offset?: number, limit?: number }` |
| **Output** | `{ content: numbered lines }`                       |

**Schema**:

```json
{
  "type": "object",
  "properties": {
    "path": { "type": "string", "description": "Absolute path to file" },
    "offset": { "type": "number", "description": "Start line (1-based), optional" },
    "limit": { "type": "number", "description": "Max lines to read, optional" }
  },
  "required": ["path"]
}
```

**Output format**: 6-digit line numbers + content, newline-separated.

---

### write_file

**File**: `packages/webapp/src/tools/file-tools.ts`

Write or create a file in the virtual filesystem. Creates parent directories automatically.

| Property   | Value                               |
| ---------- | ----------------------------------- |
| **Name**   | `write_file`                        |
| **Input**  | `{ path: string, content: string }` |
| **Output** | `{ content: "File written" }`       |

**Schema**:

```json
{
  "type": "object",
  "properties": {
    "path": { "type": "string", "description": "Absolute file path" },
    "content": { "type": "string", "description": "File content" }
  },
  "required": ["path", "content"]
}
```

---

### edit_file

**File**: `packages/webapp/src/tools/file-tools.ts`

Apply a string replacement edit to an existing file.

| Property   | Value                                                      |
| ---------- | ---------------------------------------------------------- |
| **Name**   | `edit_file`                                                |
| **Input**  | `{ path: string, old_string: string, new_string: string }` |
| **Output** | `{ content: "Edit applied" \| error message }`             |

**Schema**:

```json
{
  "type": "object",
  "properties": {
    "path": { "type": "string", "description": "Absolute file path" },
    "old_string": { "type": "string", "description": "Text to replace" },
    "new_string": { "type": "string", "description": "Replacement text" }
  },
  "required": ["path", "old_string", "new_string"]
}
```

**Behavior**:

- Fails if `old_string` not found (case-sensitive)
- Fails if `old_string` matches multiple times (ambiguous)
- Use larger context to make match unique

---

### grep (module factory, not active in ScoopContext)

**File**: `packages/webapp/src/tools/search-tools.ts`

Search file contents recursively in VirtualFS using a JavaScript regular expression. This factory remains in `packages/webapp/src/tools/search-tools.ts` for module-level use and tests, but active scoop/cone agents search through `bash` instead.

| Property   | Value                                                  |
| ---------- | ------------------------------------------------------ |
| **Name**   | `grep`                                                 |
| **Input**  | `{ pattern: string, path?: string, include?: string }` |
| **Output** | `{ content: matches or "No matches found." }`          |

**Schema**:

```json
{
  "type": "object",
  "properties": {
    "pattern": { "type": "string", "description": "Regular expression pattern to search for." },
    "path": { "type": "string", "description": "Directory to search in. Default: /" },
    "include": { "type": "string", "description": "Optional glob filter such as *.ts." }
  },
  "required": ["pattern"]
}
```

**Behavior**:

- Recursively walks VirtualFS from `path` (default `/`)
- Returns matches as `path:line: content`
- Optional `include` limits files by glob pattern
- Skips unreadable/binary files
- Truncates after 200 matches

---

### find (module factory, not active in ScoopContext)

**File**: `packages/webapp/src/tools/search-tools.ts`

List files and directories recursively in VirtualFS using simple glob matching. This factory remains in `packages/webapp/src/tools/search-tools.ts` for module-level use and tests, but active scoop/cone agents search through `bash` instead.

| Property   | Value                                              |
| ---------- | -------------------------------------------------- |
| **Name**   | `find`                                             |
| **Input**  | `{ pattern?: string, path?: string }`              |
| **Output** | `{ content: matching paths or "No files found." }` |

**Schema**:

```json
{
  "type": "object",
  "properties": {
    "pattern": { "type": "string", "description": "Glob pattern to match. Default: *" },
    "path": { "type": "string", "description": "Directory to search in. Default: /" }
  }
}
```

**Behavior**:

- Recursively walks VirtualFS from `path` (default `/`)
- Uses simple glob matching with `*`, `**`, and `?`
- Default `pattern` is `*`
- Truncates after 500 results

---

### Search via `bash` (shell alternatives)

Active agents should use the shell's `grep`, `find`, and `rg` commands through `bash` for search. Use these when you need shell composition, pipes, or ripgrep-specific behavior.

| Command                    | Purpose                                       | Example                                       |
| -------------------------- | --------------------------------------------- | --------------------------------------------- |
| `find`                     | Find files/directories by name, type, or path | `find /workspace -name "*.js" -type f`        |
| `grep` / `egrep` / `fgrep` | Search line-oriented text output              | `grep -R "TODO" /workspace/src`               |
| `rg`                       | Fast recursive text search                    | `rg "function main" /workspace/src --type ts` |

**Behavior notes**:

- Use these through `bash`; this is the active search path for scoop/cone agents
- `grep` and `rg` return exit code `1` when no matches are found; the `bash` tool preserves that output without surfacing it as an agent error when stderr is empty

**Examples**:

```bash
# Find TypeScript files
find /workspace -name "*.ts" -type f

# Search for TODOs
grep -R "TODO" /workspace/src

# Recursive code search with ripgrep
rg "createBashTool" /workspace/src --type ts
```

---

## Scoop Management Tools (Multi-Scoop)

These tools are MCP-style tools for messaging and scoop management.

**File**: `packages/webapp/src/scoops/scoop-management-tools.ts`

### send_message

Scoop-only (not registered for the cone — it has no parent to message; its assistant output already reaches the UI directly).

| Property   | Value                               |
| ---------- | ----------------------------------- |
| **Name**   | `send_message`                      |
| **Input**  | `{ text: string, sender?: string }` |
| **Output** | `{ content: "Message sent" }`       |

**Use case**: Progress updates, interim messages.

---

### list_scoops

Cone-only. List all registered scoops.

| Property   | Value                                            |
| ---------- | ------------------------------------------------ |
| **Name**   | `list_scoops`                                    |
| **Input**  | None                                             |
| **Output** | `{ content: "Scoop list\n- name1\n- name2..." }` |

---

### scoop_scoop

Cone-only. Create a new scoop.

| Property   | Value                                            |
| ---------- | ------------------------------------------------ |
| **Name**   | `scoop_scoop`                                    |
| **Input**  | `{ name: string }` — display name (e.g., "Andy") |
| **Output** | `{ content: "Scoop created" }`                   |

**Behavior**:

- Folder is auto-derived from name (lowercase, slugified)
- Scoop is registered but not activated
- Use `feed_scoop` to give it a task

---

### feed_scoop

Cone-only. Delegate a task to a scoop.

| Property   | Value                                       |
| ---------- | ------------------------------------------- |
| **Name**   | `feed_scoop`                                |
| **Input**  | `{ scoop_name: string, prompt: string }`    |
| **Output** | `{ content: "Task sent to scoop-name..." }` |

**Requirements**:

- `prompt` must be complete and self-contained
- Scoop has NO access to cone's conversation history
- Include all context: file paths, URLs, instructions, expected output format

---

### drop_scoop

Cone-only. Remove a scoop.

| Property   | Value                          |
| ---------- | ------------------------------ |
| **Name**   | `drop_scoop`                   |
| **Input**  | `{ scoop_name: string }`       |
| **Output** | `{ content: "Scoop removed" }` |

---

### update_global_memory

Cone-only. Update the shared global memory file (`/shared/CLAUDE.md`).

| Property   | Value                           |
| ---------- | ------------------------------- |
| **Name**   | `update_global_memory`          |
| **Input**  | `{ content: string }`           |
| **Output** | `{ content: "Memory updated" }` |

---

### sudo_request

Scoop-only. Ask the cone for an explicit sudo escalation before running a sensitive
action. The call blocks until the cone resolves via `lick_confirm` / `lick_dismiss` (or
the registry times out fail-closed).

| Property   | Value                                                                                        |
| ---------- | -------------------------------------------------------------------------------------------- |
| **Name**   | `sudo_request`                                                                               |
| **Input**  | `{ kind: 'command'\|'read'\|'write'\|'secret', detail: string, suggested_pattern?: string }` |
| **Output** | `{ content: "Cone decision: allow\|always\|deny..." }`                                       |

See [`docs/approvals.md`](./approvals.md) for the threat model. Hidden from the
chat UI via `hidden-tools.ts` — the user-visible event is the `[sudo-request]`
channel message the orchestrator delivers to the cone.

---

### lick_confirm

Cone-only. Confirm (approve) a pending actionable lick by its `lick_id`. The
orchestrator dispatches by `lick_id` to the right resolver. Actionable kinds:

- **sudo** — a scoop escalation raised via `sudo_request`. With `always=true`,
  the orchestrator additionally appends a `NOPASSWD <directive> <pattern>` rule
  to the requesting scoop's `/scoops/<folder>/etc/sudoers` so the same action
  won't prompt again.
- **navigate·upskill** — confirm runs `upskill <url> [--branch ..] [--path ..]`
  to install the skill (`upskill`'s on-disk "already exists" check still guards
  duplicate installs).
- **session-reload·mount-recovery** — confirm re-runs the `mount` commands
  reconstructed from the lick's recovery entries.
- **upgrade** — confirm triggers "Update workspace files" (the upgrade skill's
  three-way merge of bundled vfs-root content, scoped to the stored `from`→`to`
  tags). "Review changelog" stays a separate agent step.

| Property   | Value                                                     |
| ---------- | --------------------------------------------------------- |
| **Name**   | `lick_confirm`                                            |
| **Input**  | `{ lick_id: string, always?: boolean, pattern?: string }` |
| **Output** | `{ content: "Approved (once\|always)..." }`               |

`always` / `pattern` apply only to **sudo** licks. `pattern` defaults to the
request's `suggestedPattern`, then to the exact `detail`. `kind: 'secret'`
cannot be persisted — there is no sudoers `Secret` directive — so `always=true`
for a secret request approves once and reports "approved but not persisted".
**navigate·handoff** licks are NOT agent-confirmable: they stay human-gated
(the approval dip is the authority), so a `lick_confirm` on a handoff id reports
unknown / already-resolved.

---

### lick_dismiss

Cone-only. Dismiss (refuse) a pending actionable lick by its `lick_id`. Per
kind: a **sudo** request receives a `deny` decision and the sensitive action
does NOT run; **navigate·upskill** drops the install; **session-reload·mount-recovery**
leaves the mounts unmounted; **upgrade** clears the notice (no files touched);
and **session-reload (plain)** is dismiss-only — it just acknowledges the
already-completed reload (there is no `lick_confirm` for it). In every case the
card flips to its muted dismissed state.

| Property   | Value                                               |
| ---------- | --------------------------------------------------- |
| **Name**   | `lick_dismiss`                                      |
| **Input**  | `{ lick_id: string }`                               |
| **Output** | `{ content: "Denied — the scoop will not run..." }` |

Like `sudo_request` / `list_sudo_requests`, `lick_confirm` / `lick_dismiss`
are hidden from the chat UI via `hidden-tools.ts` — no tool-call row appears.
The user-visible signal of the cone's decision is the originating
`<slicc-lick-card>` flipping in place to its result state: a green check
(confirmed) or a red cross (dismissed, rendered muted), persisted on the
message so it survives reload. That card flip is the only visible signal. See
[`docs/approvals.md`](./approvals.md) "Card result UX".

---

### list_sudo_requests

Cone-only. List all pending cone-mediated sudo requests (lick `id`, requesting scoop,
kind, detail). Use to find a `lick_id` for `lick_confirm` / `lick_dismiss`.

| Property   | Value                                          |
| ---------- | ---------------------------------------------- |
| **Name**   | `list_sudo_requests`                           |
| **Input**  | None                                           |
| **Output** | `{ content: "Pending sudo requests:\n- ..." }` |

Hidden from the chat UI via `hidden-tools.ts`.

---

## Tool Availability by Scope

| Tool                     | Cone | Scoop          | Notes                                                                 |
| ------------------------ | ---- | -------------- | --------------------------------------------------------------------- |
| bash                     | ✓    | ✓              | Includes `playwright-cli` / `playwright` / `puppeteer` shell commands |
| read_file                | ✓    | ✓ (restricted) | Active in `ScoopContext`                                              |
| write_file               | ✓    | ✓ (restricted) | Active in `ScoopContext`                                              |
| edit_file                | ✓    | ✓ (restricted) | Active in `ScoopContext`                                              |
| **send_message**         | ✗    | ✓              | Scoop-only management tool (scoop→cone progress/result channel)       |
| **list_scoops**          | ✓    | ✗              | Cone-only scoop-management tool                                       |
| **scoop_scoop**          | ✓    | ✗              | Cone-only scoop-management tool                                       |
| **feed_scoop**           | ✓    | ✗              | Cone-only scoop-management tool                                       |
| **drop_scoop**           | ✓    | ✗              | Cone-only scoop-management tool                                       |
| **update_global_memory** | ✓    | ✗              | Cone-only scoop-management tool                                       |
| **sudo_request**         | ✗    | ✓              | Scoop-only — escalate to the cone for an approval decision            |
| **lick_confirm**         | ✓    | ✗              | Cone-only — confirm a pending actionable lick (allow-once or always)  |
| **lick_dismiss**         | ✓    | ✗              | Cone-only — dismiss a pending actionable lick                         |
| **list_sudo_requests**   | ✓    | ✗              | Cone-only — snapshot outstanding sudo requests                        |

---

## Context Compaction

LLM-summarized context compaction (`packages/webapp/src/core/context-compaction.ts`), aligned with pi-mono's strategy.

**How it works**: When context approaches the token limit, an LLM call generates a structured summary of older messages, which replaces them as a single user message. This preserves the conversation prefix (Anthropic cache-friendly) and keeps recent messages intact.

**Constants** (from pi-coding-agent's `DEFAULT_COMPACTION_SETTINGS`):

```typescript
reserveTokens = 16384; // Headroom below context limit
keepRecentTokens = 20000; // Recent messages to preserve
```

`contextWindow` is **not** a fixed constant — `scoops/scoop-context.ts` forwards the
resolved `model.contextWindow` into `createCompactContext`, so the threshold scales
to the active model (e.g. ~983K for a 1M-window Adobe Sonnet/Opus 4.x, ~183K for a
200K model). It falls back to a `200000` default only when the model reports no
window (or a non-positive one — passing `0` would make the threshold negative and
compact every turn). Sizing GC off the real window avoids compacting — and running
the cone's memory-extraction call — at a fraction of a large model's capacity.

**Algorithm**:

1. **Threshold check**: Triggers when estimated tokens exceed `contextWindow - reserveTokens`
2. **Cut point**: Walks backward from newest, keeping ~`keepRecentTokens` of recent messages. Never splits assistant+toolResult pairs.
3. **LLM summarization**: Calls `generateSummary()` to produce a structured summary (Goal, Progress, Key Decisions, Next Steps, Critical Context)
4. **Fallback**: If LLM call fails or no API key, falls back to naive message dropping with a compaction marker

**No truncation**: Tool results pass through at full fidelity. Image tags (`<img:...>`) are parsed into `ImageContent` blocks by `tool-adapter.ts`, but neither text nor image content is truncated. Full-size data is preserved until compaction summarizes older messages.

**Overflow recovery**: If the context still exceeds the API limit after compaction (e.g., due to token estimation inaccuracy, system prompt size, or multiple large recent results), `ScoopContext` catches the "prompt too long" error via `isContextOverflow()` from pi-ai, replaces oversized messages (>40K chars) with placeholders, and re-prompts the agent with an explanation. Limited to 1 retry to prevent infinite loops.

---

## Tool Error Handling

All tools return `{ content: string, isError?: boolean }`.

Standard error patterns:

```typescript
// File not found
{ content: "ENOENT: /path/to/file not found", isError: true }

// Permission denied
{ content: "EACCES: Permission denied", isError: true }

// Command failed
{ content: "Error: command failed with exit code 127", isError: true }
```

The agent can inspect `isError` to determine if a tool call succeeded or needs retry logic.

---

## Performance Notes

- **bash**: Each command is synchronous in just-bash; avoid blocking operations
- **BrowserAPI-backed automation**: Screenshots and evaluations are fast (<100ms on local tabs). Network delays dominate remote sites whether invoked via `playwright-cli`, `playwright`, or `puppeteer`
- **read_file**: LineNumber formatting is O(file size); reading huge files (>1MB) may be slow
- **context-compaction**: Runs before every LLM call; threshold check is O(message count). When compaction triggers, an LLM call adds latency but only happens when approaching context limits.

---

## Dual-Mode Notes (CLI vs Extension)

### CLI Mode

- VirtualFS backed by OPFS via ZenFS `WebAccessFS` (in-memory in Node tests)
- Tools run in Node.js
- Browser operations via Chrome DevTools Protocol (WebSocket)
- `node -e` uses `AsyncFunction` constructor
- Fetch requests routed through `/api/fetch-proxy` (Express server) with secret unmask/scrub

### Extension Mode

- VirtualFS backed by OPFS via ZenFS `WebAccessFS`, opened from the hosted leader tab (`https://www.sliccy.ai`)
- Tools run in the hosted leader tab's page and kernel-worker realms
- Browser operations route through the SW's `bridge.cdp` Port → `chrome.debugger`
- `node -e` and `.jsh` scripts run in sandbox iframe (CSP-exempt)
- Fetch requests routed through `fetch-proxy.fetch` SW Port handler with secret unmask/scrub

Both modes share the same unified VirtualFS and tool interfaces.

---

## References

- **ToolDefinition**: `packages/webapp/src/core/types.ts` (lines 273–278)
- **AgentTool**: `packages/webapp/src/core/types.ts` (lines 120–128)
- **Tool adapter**: `packages/webapp/src/core/tool-adapter.ts`
- **Context compaction**: `packages/webapp/src/core/context-compaction.ts`
- **All tools**: `packages/webapp/src/tools/*.ts`, `packages/webapp/src/scoops/scoop-management-tools.ts`
