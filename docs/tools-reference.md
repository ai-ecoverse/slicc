# Tools Reference

Complete reference for all agent tools in SLICC. Tools are invoked by the agent during message processing.

---

## Tool Architecture

### ToolDefinition Interface

Legacy tool interface (src/tools/):

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

Modern agent tool interface (src/core/types.ts):

```typescript
interface AgentTool<TDetails = unknown> extends Tool {
  label: string;
  execute: (
    toolCallId: string,
    params: Record<string, any>,
    signal?: AbortSignal,
    onUpdate?: AgentToolUpdateCallback<TDetails>,
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
// src/core/tool-adapter.ts
export function adaptTools(tools: ToolDefinition[]): AgentTool[] {
  return tools.map(tool => ({
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

**File**: `src/tools/bash-tool.ts`

Execute shell commands in a full Unix-like environment (just-bash 2.11.7).

| Property | Value |
|----------|-------|
| **Name** | `bash` |
| **Input** | `{ command: string }` |
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
- Custom commands: `git`, `node -e`, `python3 -c`, `sqlite3`, `zip/unzip`, `webhook`, `crontask`, `convert`, `which`
- Networking: Full `curl` with HTTP methods, headers, auth, body
- Text processing: grep, rg, sed, awk, cut, tr, sort, uniq, wc, head, tail
- Search is shell-native: use `grep`, `find`, and `rg` through `bash` rather than separate agent tools
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

**File**: `src/tools/file-tools.ts`

Read file contents from the virtual filesystem (VirtualFS for cone, RestrictedFS for scoops).

| Property | Value |
|----------|-------|
| **Name** | `read_file` |
| **Input** | `{ path: string, offset?: number, limit?: number }` |
| **Output** | `{ content: numbered lines }` |

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

**File**: `src/tools/file-tools.ts`

Write or create a file in the virtual filesystem. Creates parent directories automatically.

| Property | Value |
|----------|-------|
| **Name** | `write_file` |
| **Input** | `{ path: string, content: string }` |
| **Output** | `{ content: "File written" }` |

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

**File**: `src/tools/file-tools.ts`

Apply a string replacement edit to an existing file.

| Property | Value |
|----------|-------|
| **Name** | `edit_file` |
| **Input** | `{ path: string, old_string: string, new_string: string }` |
| **Output** | `{ content: "Edit applied" \| error message }` |

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

### browser

**File**: `src/tools/browser-tool.ts`

Control browser tabs via Chrome DevTools Protocol.

| Property | Value |
|----------|-------|
| **Name** | `browser` |
| **Actions** | 13 sub-actions (see below) |

**Auto-dispatch**: If `targetId` is omitted, the user's currently focused tab is resolved automatically.

**App tab protection**: The SLICC app's own tab is hidden and cannot be navigated or modified.

#### Actions

| Action | Parameters | Returns |
|--------|-----------|---------|
| **list_tabs** | None | `{ tabs: { targetId, url, title, active }[] }` |
| **new_tab** | `url: string` | `{ targetId: string }` — creates and navigates tab |
| **new_recorded_tab** | `url: string`, `filter?: string` (JS function) | `{ recordingId: string }` — starts HAR recording |
| **stop_recording** | `recordingId: string` | `{ message: "Recording saved" }` — saves HAR snapshot |
| **navigate** | `url: string`, `targetId?: string` | Page loads, returns when ready |
| **snapshot** | `targetId?: string` | `{ snapshot: string }` — accessibility tree with element refs (e1, e2, ...) |
| **screenshot** | `targetId?: string`, `path?: string`, `fullPage?: boolean`, `selector?: string` | Base64 PNG or saved to `path` in VFS |
| **evaluate** | `expression: string`, `targetId?: string` | JavaScript result (JSON stringified) |
| **click** | `ref: string \| selector: string`, `targetId?: string` | Clicks element by ref (e.g., "e5") or CSS selector |
| **type** | `text: string`, `targetId?: string` | Types into focused input |
| **evaluate_persistent** | `expression: string` | Runs JS in persistent blank tab, preserves variables |
| **serve** | `directory: string`, `entry?: string` | `{ targetId: string }` — serves VFS directory as web app |
| **show_image** | `path: string` | Displays image from VFS inline in chat |

**Recording filter** (JavaScript string):

The `filter` parameter for `new_recorded_tab` is a JavaScript function string:

```javascript
(entry) => false | true | object
```

- `false` → exclude entry
- `true` → include entry (default)
- `object` → transform entry (e.g., remove response body: `{ ...entry, response: { ...entry.response, content: { ...entry.response.content, text: '' } } }`)

Filter is applied at snapshot save time (batch), not per-entry. In extension mode, filter code is sent to the sandbox iframe via postMessage.

Recordings saved to `/recordings/{id}/` with HAR 1.2 format. Response bodies are captured by default (can be large); use filter to exclude.

---

### javascript

**File**: `src/tools/javascript-tool.ts`

Execute JavaScript code in an isolated sandbox with VFS access.

| Property | Value |
|----------|-------|
| **Name** | `javascript` |
| **Input** | `{ code: string }` |
| **Output** | `{ content: stdout+stderr }` |

**Sandbox**:
- CLI mode: Uses `AsyncFunction` constructor
- Extension mode: Runs in hidden iframe (CSP-exempt), VFS ops via postMessage

**VFS API**:

```typescript
const fs = {
  readFile(path: string): Promise<string>,
  readFileBinary(path: string): Promise<Uint8Array>,
  writeFile(path: string, content: string): Promise<void>,
  writeFileBinary(path: string, bytes: Uint8Array): Promise<void>,
  readDir(path: string): Promise<string[]>,
  exists(path: string): Promise<boolean>,
  stat(path: string): Promise<{ isDirectory, isFile, size }>,
  mkdir(path: string): Promise<void>,
  rm(path: string): Promise<void>,
  fetchToFile(url: string, path: string): Promise<number>,
};
```

**Globals**: `console` (log, info, warn, error), `fetch`.

**Example**:

```javascript
const data = await fs.readFile('/data.json');
const parsed = JSON.parse(data);
const result = parsed.items.filter(x => x.id > 10);
console.log(result);
```

---

### CLI search commands (via `bash`)

Search remains documented here because it is part of the CLI/shell surface area, but these are **not** separate agent tools. Agents use them by calling the `bash` tool with standard shell commands.

| Command | Purpose | Example |
|---------|---------|---------|
| `find` | Find files/directories by name, type, or path | `find /workspace -name "*.js" -type f` |
| `grep` / `egrep` / `fgrep` | Search line-oriented text output | `grep -R "TODO" /workspace/src` |
| `rg` | Fast recursive text search | `rg "function main" /workspace/src --type ts` |

**Behavior notes**:
- Use these through `bash`; there is no dedicated `find` or `search` agent tool
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

## NanoClaw Tools (Multi-Scoop)

NanoClaw tools are MCP-style tools for messaging and scoop management.

**File**: `src/scoops/nanoclaw-tools.ts`

### send_message

Universal (available to all scoops).

| Property | Value |
|----------|-------|
| **Name** | `send_message` |
| **Input** | `{ text: string, sender?: string }` |
| **Output** | `{ content: "Message sent" }` |

**Use case**: Progress updates, interim messages.

---

### list_scoops

Cone-only. List all registered scoops.

| Property | Value |
|----------|-------|
| **Name** | `list_scoops` |
| **Input** | None |
| **Output** | `{ content: "Scoop list\n- name1\n- name2..." }` |

---

### scoop_scoop

Cone-only. Create a new scoop.

| Property | Value |
|----------|-------|
| **Name** | `scoop_scoop` |
| **Input** | `{ name: string }` — display name (e.g., "Andy") |
| **Output** | `{ content: "Scoop created" }` |

**Behavior**:
- Folder is auto-derived from name (lowercase, slugified)
- Scoop is registered but not activated
- Use `feed_scoop` to give it a task

---

### feed_scoop

Cone-only. Delegate a task to a scoop.

| Property | Value |
|----------|-------|
| **Name** | `feed_scoop` |
| **Input** | `{ scoop_name: string, prompt: string }` |
| **Output** | `{ content: "Task sent to scoop-name..." }` |

**Requirements**:
- `prompt` must be complete and self-contained
- Scoop has NO access to cone's conversation history
- Include all context: file paths, URLs, instructions, expected output format

---

### drop_scoop

Cone-only. Remove a scoop.

| Property | Value |
|----------|-------|
| **Name** | `drop_scoop` |
| **Input** | `{ scoop_name: string }` |
| **Output** | `{ content: "Scoop removed" }` |

---

### update_global_memory

Cone-only. Update the shared global memory file (`/shared/CLAUDE.md`).

| Property | Value |
|----------|-------|
| **Name** | `update_global_memory` |
| **Input** | `{ content: string }` |
| **Output** | `{ content: "Memory updated" }` |

---

## Tool Availability by Scope

| Tool | Cone | Scoop |
|------|------|-------|
| bash | ✓ | ✓ |
| read_file | ✓ | ✓ (restricted) |
| write_file | ✓ | ✓ (restricted) |
| edit_file | ✓ | ✓ (restricted) |
| browser | ✓ | ✓ |
| javascript | ✓ | ✓ |
| **send_message** | ✓ | ✓ |
| **list_scoops** | ✓ | ✗ |
| **scoop_scoop** | ✓ | ✗ |
| **feed_scoop** | ✓ | ✗ |
| **drop_scoop** | ✓ | ✗ |
| **update_global_memory** | ✓ | ✗ |

---

## Context Compaction

To prevent context overflow (200K token limit), the agent applies automatic compaction before each LLM call.

**Thresholds** (`src/core/context-compaction.ts`):

```typescript
const MAX_RESULT_CHARS = 8000;        // ~2000 tokens per tool result
const MAX_CONTEXT_CHARS = 600000;     // ~150K tokens total
```

**Two-phase compaction**:

1. **Result truncation**: Tool results > 8000 chars are truncated with `\n... (truncated)` marker
2. **Message dropping**: If total context exceeds 600K chars, old messages are dropped

**Preservation**: First 2 messages (system context) and last 10 messages (recent context) are always kept.

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
- **browser**: Screenshots and evaluations are fast (<100ms on local tabs). Network delays dominate remote sites
- **javascript**: Sandbox message passing adds ~10ms overhead per call
- **read_file**: LineNumber formatting is O(file size); reading huge files (>1MB) may be slow
- **context-compaction**: Runs before every LLM call; O(message count), not a bottleneck

---

## Dual-Mode Notes (CLI vs Extension)

### CLI Mode
- VirtualFS backed by IndexedDB (LightningFS)
- Tools run in Node.js
- Browser operations via Chrome DevTools Protocol (WebSocket)
- `node -e` uses `AsyncFunction` constructor
- Fetch requests routed through `/api/fetch-proxy` (Express server)

### Extension Mode
- VirtualFS backed by IndexedDB (LightningFS)
- Tools run in browser (side panel)
- Browser operations via `chrome.debugger` API
- `node -e` and `.jsh` scripts run in sandbox iframe (CSP-exempt)
- Cross-origin fetch from sandbox proxied via postMessage

Both modes share the same unified VirtualFS and tool interfaces.

---

## References

- **ToolDefinition**: `src/core/types.ts` (lines 273–278)
- **AgentTool**: `src/core/types.ts` (lines 120–128)
- **Tool adapter**: `src/core/tool-adapter.ts`
- **Context compaction**: `src/core/context-compaction.ts`
- **All tools**: `src/tools/*.ts`, `src/scoops/nanoclaw-tools.ts`
