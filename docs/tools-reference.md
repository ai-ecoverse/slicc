# Tools Reference

Complete reference for the tool modules and active agent tool surface in SLICC. `src/tools/` contains file, bash, browser, search, and javascript tool factories, but the current scoop/cone surface wired in `src/scoops/scoop-context.ts` is: `read_file`, `write_file`, `edit_file`, `bash`, `javascript`, and NanoClaw tools. Browser automation and search for active scoop agents now run through shell commands via `bash` (`playwright-cli` / `playwright` / `puppeteer`, plus shell-native `rg` / `grep` / `find`).

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

### grep (module factory, not active in ScoopContext)

**File**: `src/tools/search-tools.ts`

Search file contents recursively in VirtualFS using a JavaScript regular expression. This factory remains in `src/tools/search-tools.ts` for module-level use and tests, but active scoop/cone agents search through `bash` instead.

| Property | Value |
|----------|-------|
| **Name** | `grep` |
| **Input** | `{ pattern: string, path?: string, include?: string }` |
| **Output** | `{ content: matches or "No matches found." }` |

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

**File**: `src/tools/search-tools.ts`

List files and directories recursively in VirtualFS using simple glob matching. This factory remains in `src/tools/search-tools.ts` for module-level use and tests, but active scoop/cone agents search through `bash` instead.

| Property | Value |
|----------|-------|
| **Name** | `find` |
| **Input** | `{ pattern?: string, path?: string }` |
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

### Search via `bash` (shell alternatives)

Active agents should use the shell's `grep`, `find`, and `rg` commands through `bash` for search. Use these when you need shell composition, pipes, or ripgrep-specific behavior.

| Command | Purpose | Example |
|---------|---------|---------|
| `find` | Find files/directories by name, type, or path | `find /workspace -name "*.js" -type f` |
| `grep` / `egrep` / `fgrep` | Search line-oriented text output | `grep -R "TODO" /workspace/src` |
| `rg` | Fast recursive text search | `rg "function main" /workspace/src --type ts` |

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

| Tool | Cone | Scoop | Notes |
|------|------|-------|-------|
| bash | ✓ | ✓ | Includes `playwright-cli` / `playwright` / `puppeteer` shell commands |
| read_file | ✓ | ✓ (restricted) | Active in `ScoopContext` |
| write_file | ✓ | ✓ (restricted) | Active in `ScoopContext` |
| edit_file | ✓ | ✓ (restricted) | Active in `ScoopContext` |
| javascript | ✓ | ✓ | Active in `ScoopContext` |
| **send_message** | ✓ | ✓ | NanoClaw tool |
| **list_scoops** | ✓ | ✗ | Cone-only NanoClaw tool |
| **scoop_scoop** | ✓ | ✗ | Cone-only NanoClaw tool |
| **feed_scoop** | ✓ | ✗ | Cone-only NanoClaw tool |
| **drop_scoop** | ✓ | ✗ | Cone-only NanoClaw tool |
| **update_global_memory** | ✓ | ✗ | Cone-only NanoClaw tool |

---

## Context Compaction

LLM-summarized context compaction (`src/core/context-compaction.ts`), aligned with pi-mono's strategy.

**How it works**: When context approaches the token limit, an LLM call generates a structured summary of older messages, which replaces them as a single user message. This preserves the conversation prefix (Anthropic cache-friendly) and keeps recent messages intact.

**Constants** (from pi-coding-agent's `DEFAULT_COMPACTION_SETTINGS`):

```typescript
contextWindow = 200000;       // Claude's context window
reserveTokens = 16384;        // Headroom below context limit
keepRecentTokens = 20000;     // Recent messages to preserve
MAX_SINGLE_RESULT_CHARS = 50000;  // Safety cap per tool result (tool-adapter.ts)
```

**Algorithm**:

1. **Threshold check**: Triggers when estimated tokens exceed `contextWindow - reserveTokens` (~183K tokens)
2. **Cut point**: Walks backward from newest, keeping ~`keepRecentTokens` of recent messages. Never splits assistant+toolResult pairs.
3. **LLM summarization**: Calls `generateSummary()` to produce a structured summary (Goal, Progress, Key Decisions, Next Steps, Critical Context)
4. **Fallback**: If LLM call fails or no API key, falls back to naive message dropping with a compaction marker

**Safety cap**: Image tags (`<img:...>`) are parsed into `ImageContent` blocks first, then only text blocks >50K chars are truncated (`MAX_SINGLE_RESULT_CHARS` in `tool-adapter.ts`). Image data passes through untouched — it's handled natively by the LLM API, not as text tokens. Smaller text results stay full-size until compaction summarizes them.

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
- **javascript**: Sandbox message passing adds ~10ms overhead per call
- **read_file**: LineNumber formatting is O(file size); reading huge files (>1MB) may be slow
- **context-compaction**: Runs before every LLM call; threshold check is O(message count). When compaction triggers, an LLM call adds latency but only happens when approaching context limits.

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
