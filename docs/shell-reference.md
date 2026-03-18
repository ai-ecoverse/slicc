# Shell Reference

Complete reference for SLICC's shell capabilities, including supplemental commands, .jsh scripts, and binary handling.

---

## Overview

SLICC uses `just-bash` (WASM Bash interpreter v2.11.7) as its core shell runtime. This provides 78+ standard Unix commands plus 17+ custom supplemental commands and auto-discovered `.jsh` script commands.

**Entry point**: Via the `bash` agent tool. All shell features available to agents.

---

## Supplemental Commands

Custom commands implemented in TypeScript and registered in just-bash.

| Command | File | Description | Key Arguments |
|---------|------|-------------|-----------------|
| **commands** | `help-command.ts` | List all available commands (built-ins + .jsh) | None |
| **which** | `which-command.ts` | Resolve a command path | `<command>` — returns `/usr/bin/<name>` or VFS path |
| **uname** | `uname-command.ts` | Print the current browser user agent | None |
| **host** | `host-command.ts` | Print the current leader tray status plus `launch_url` and `join_url` (`launch_url` is `https://.../tray/<id>` when this runtime is leader) | None |
| **oauth-token** | `oauth-token-command.ts` | Get an OAuth access token for a provider | `<providerId>`, `--provider <id>`, `--list`, no args = selected provider; auto-triggers login if needed |
| **serve** | `serve-command.ts` | Open a VFS app directory in a browser tab | `[--entry <relative-path>] <directory>` — defaults to `index.html`; rejects absolute/traversal entry paths |
| **open** | `open-command.ts` | Open URL or VFS file in browser tab | `<url\|path>` — serves VFS files via preview SW; `--download` / `-d` forces download; `--view` / `-v` returns image inline for agent vision |
| **imgcat** | `imgcat-command.ts` | Display image inline in terminal | `<path>` — base64 + ansi escape codes |
| **zip** | `zip-command.ts` | Create ZIP archive | `<archive.zip> <file1> [file2...]` |
| **unzip** | `unzip-command.ts` | Extract ZIP archive | `<archive.zip> [-d output-dir]` |
| **sqlite3** | `sqlite-command.ts` | Execute SQLite queries | `-c "SELECT * FROM table" db.sqlite` |
| **node** | `node-command.ts` | Execute JavaScript code | `-e "console.log(1+1)"` with fs bridge |
| **python3 / python** | `python-command.ts` | Execute Python code | `-c "print([i**2 for i in range(5)])"` with Pyodide |
| **webhook** | `webhook-command.ts` | Manage webhooks for event-driven licks | `webhook create <endpoint>`, `webhook list`, `webhook delete <id>` |
| **crontask** | `crontask-command.ts` | Schedule cron jobs that dispatch licks | `crontask add <name> "0 9 * * *" scoop-name "instructions..."` |
| **pdftk / pdf** | `pdftk-command.ts` | PDF manipulation | `pdf burst input.pdf`, `pdf cat input.pdf output output.pdf` |
| **convert / magick** | `convert-command.ts` | Image conversion (ImageMagick style) | `convert -resize 800x600 input.jpg output.jpg` |
| **playwright-cli / playwright / puppeteer** | `playwright-command.ts` | Browser automation shell CLI | `snapshot`, `click <ref>`, `cookie-set`, `tab-list` |
| **screencapture** | `screencapture-command.ts` | Capture user's screen via browser screen sharing API | `<output.png>`, `-c` (clipboard), `-v` / `--view` (agent vision) |
| **upskill** | `upskill-command.ts` | Install skills from GitHub/ClawHub | `upskill owner/repo`, `upskill clawhub:name`, `upskill search "query"` |
| **sprinkle** | `sprinkle-command.ts` | Manage `.shtml` sprinkle panels and inline chat UI | `sprinkle list`, `sprinkle open <name>`, `sprinkle chat '<html>'` |
| **git** | (isomorphic-git) | Full git support | `git clone`, `git commit`, `git push`, etc. |

**Example usage**:

```bash
# List all available commands
commands

# Resolve a command path
which node
# Output: /usr/bin/node

# Print the current browser user agent
uname

# Show the current leader tray status, launch URL, and join URL
host

# In a leader runtime, launch_url is the tray URL itself
# In non-leader/error runtimes with a saved session, it stays the local app launch URL
# join_url exposes the tray join capability directly when a session exists

# Open a URL in a browser tab
open https://example.com

# Serve a VFS app directory (defaults to index.html)
serve /workspace/app

# Serve the same app with a custom entry file
serve --entry pages/home.html /workspace/app

# Open a VFS file in a browser tab (served via preview service worker)
open /workspace/app/index.html

# Force download instead of opening in tab
open --download /workspace/report.pdf

# View an image (agent can see it in the response)
open --view /workspace/screenshot.png

# Execute JavaScript
node -e "console.log('Hello from Node')"

# Execute Python
python3 -c "print(sum(range(10)))"

# Create ZIP archive
zip archive.zip file1.txt file2.txt

# Query SQLite
sqlite3 -c "SELECT COUNT(*) FROM users" database.db

# Browse with playwright-cli
playwright-cli open https://example.com
playwright-cli snapshot

# Capture user's screen (prompts user to select screen/window/tab)
screencapture desktop.png
screencapture --view screen.png   # Capture and return for agent vision
screencapture -c                   # Capture to clipboard

# Display image
imgcat screenshot.png

# Schedule a cron job
crontask add "daily-backup" "0 2 * * *" backup-scoop "Backup all files"
```

---

## playwright-cli

Browser automation is also exposed as shell commands: `playwright-cli`, `playwright`, and `puppeteer`.

- **Shared state across aliases**: all three names operate on the same current tab, snapshot cache, cookies/storage context, and `/.playwright/session.md` history.
- **Default targeting**: `open` / `tab-new` open in the background by default, but if there is no current browser target yet, the first opened tab becomes current so `snapshot` works immediately.
- **Fresh refs required**: `click`, `fill`, `goto`, `go-back`, `go-forward`, `reload`, and similar state-changing commands invalidate prior snapshot refs. After history navigation or reload, run `snapshot` again before using refs.
- **Cookie convenience forms**: `cookie-set <name> <value>` and `cookie-delete <name>` use the current page URL when `--domain` and `--path` are omitted.
- **Unexpected dialogs**: attached pages auto-dismiss unexpected JavaScript dialogs so a stray `alert()` or similar modal does not stall automation indefinitely.

### Common flow

```bash
playwright-cli open https://example.com
playwright-cli snapshot
playwright-cli click e5
playwright-cli snapshot
playwright-cli cookie-set theme dark
```

### Session files

- `/.playwright/session.md` — chronological command log
- `/.playwright/snapshots/` — saved accessibility snapshots for state-changing commands that auto-snapshot
- `/.playwright/screenshots/` — saved screenshots

Use the skill doc at `src/defaults/workspace/skills/playwright-cli/SKILL.md` for the full command list and operating guidance.

---

## .jsh Script Commands

JavaScript shell scripts auto-discovered anywhere on the VirtualFS. Executable like any shell command.

**Discovery**: `jsh-discovery.ts` scans VFS with priority roots:

```
Priority: /workspace/skills/
Then: / (full filesystem scan)

Rule: First basename wins (no conflicts)
```

**Execution**: Via `jsh-executor.ts` (dual-mode):
- CLI: `AsyncFunction` constructor with Node-like globals
- Extension: Sandbox iframe (CSP-compliant), VFS via postMessage

### Globals API

#### process

```typescript
process.argv: string[]        // ['node', 'script.jsh', ...args]
process.env: object           // Environment variables
process.cwd(): string         // Current working directory
process.exit(code?: number)   // Exit with code (0 default)
process.stdout.write(s)       // Write to stdout
process.stderr.write(s)       // Write to stderr
```

#### console

```typescript
console.log(...args)          // stdout (space-separated)
console.info(...args)         // stdout
console.warn(...args)         // stderr
console.error(...args)        // stderr
```

#### fs (VirtualFS bridge)

All paths are resolved relative to `process.cwd()`.

```typescript
fs.readFile(path): Promise<string>
fs.readFileBinary(path): Promise<Uint8Array>
fs.writeFile(path, content: string): Promise<void>
fs.writeFileBinary(path, bytes: Uint8Array): Promise<void>
fs.readDir(path): Promise<string[]>
fs.exists(path): Promise<boolean>
fs.stat(path): Promise<{ isDirectory, isFile, size }>
fs.mkdir(path): Promise<void>
fs.rm(path): Promise<void> // Recursive delete
fs.fetchToFile(url, path): Promise<number> // Download and save, returns byte count
```

#### exec (shell command bridge)

Run any shell command through just-bash and get the result. Works in both CLI and extension mode.

```typescript
exec(command: string): Promise<{ stdout: string; stderr: string; exitCode: number }>

// Example: get an OAuth token
const r = await exec('oauth-token adobe');
const token = r.stdout.trim();

// Example: list files
const ls = await exec('ls -la /workspace');
console.log(ls.stdout);
```

#### require / module / exports

```typescript
require(id)               // ❌ Not supported (throws error)
module.exports: {}        // Available for ES module pattern
exports: module.exports   // Alias
```

### Example .jsh Script

```javascript
// /workspace/skills/my-tool/process-csv.jsh
const args = process.argv.slice(2);

if (args.length < 1) {
  console.error('Usage: process-csv <input.csv>');
  process.exit(1);
}

const inputFile = args[0];
const outputFile = args[1] || inputFile.replace(/\.csv$/, '.json');

(async () => {
  try {
    const csv = await fs.readFile(inputFile);
    const lines = csv.split('\n').filter(l => l.trim());
    const header = lines[0].split(',').map(s => s.trim());

    const rows = lines.slice(1).map(line => {
      const values = line.split(',').map(s => s.trim());
      return Object.fromEntries(header.map((h, i) => [h, values[i]]));
    });

    const json = JSON.stringify(rows, null, 2);
    await fs.writeFile(outputFile, json);

    console.log(`Converted: ${inputFile} → ${outputFile}`);
    console.log(`Records: ${rows.length}`);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
})();
```

**Usage**:

```bash
# Call by basename (from any directory)
process-csv input.csv output.json
```

### Error Handling

```javascript
try {
  const data = await fs.readFile('/nonexistent.json');
} catch (err) {
  // err.message: "ENOENT: /nonexistent.json not found"
  console.error(err.message);
  process.exit(1);
}
```

---

## Argument Parsing

Shell arguments support quotes, escapes, and whitespace.

**Parser**: `parse-shell-args.ts`

### Rules

| Pattern | Result |
|---------|--------|
| `word` | Single word token |
| `"hello world"` | Single token: `hello world` |
| `'hello world'` | Single token: `hello world` |
| `hello\ world` | Single token: `hello world` |
| `a "b c" d` | Three tokens: `a`, `b c`, `d` |
| `"a\"b"` | Single token: `a"b` (escaped quote) |

### Examples

```bash
# Multiple words in quotes
node -e "console.log('Hello, World')"
# Parsed as: ['node', '-e', "console.log('Hello, World')"]

# Path with spaces
open "/path/to/my file.html"
# Parsed as: ['open', '/path/to/my file.html']

# Escaped characters
echo "Line 1\nLine 2"
# Parsed as: ['echo', 'Line 1\nLine 2']
```

---

## Command Discovery

### Priority Roots

Scan order (first wins):

1. `/workspace/skills/` — Skill scripts, highest priority
2. `/` — Full filesystem walk

### Basename Rule

When multiple `.jsh` files have the same basename:

```
/workspace/skills/my-skill/build.jsh     ← Chosen
/tools/scripts/build.jsh                 ← Ignored (same basename)
```

First occurrence by priority root wins.

### Dynamic Registration

The `commands` command lists all available commands:

```bash
$ commands
Available commands:
  Built-in: ls, cat, grep, find, ... (78+ commands)
  Custom: convert, sqlite3, webhook, crontask, ...
  Scripts: process-csv, backup-db, deploy-site, ...
```

The agent can dynamically discover new scripts via `commands`, then invoke them by name.

---

## Binary Handling

SLICC's shell supports binary data (images, PDFs, archives) via careful encoding.

**Binary cache**: `binary-cache.ts`

### Flow

1. **VFS read**: `fs.readFileBinary(path)` returns `Uint8Array`
2. **just-bash limitations**: Bash strings are Unicode; binary data must be encoded
3. **Latin-1 encoding**: Binary bytes preserved via `String.fromCharCode(byte)` mapping
4. **VFS write**: `fs.writeFile(path, encodedString)` is detected as binary (stored in cache) and decoded back to `Uint8Array`

### API

```typescript
// Read binary
const bytes: Uint8Array = await fs.readFileBinary('/image.png');

// Write binary
const newBytes = new Uint8Array([0xFF, 0xD8, ...]);
await fs.writeFile('/output.jpg', newBytes);
```

### Tools Supporting Binary

- **playwright-cli**: `screenshot --filename=<path>` saves PNGs directly to the VFS
- **javascript** tool: `fs.readFileBinary()`, `fs.writeFileBinary()` preserve byte fidelity
- **node** / **.jsh**: `fs.readFileBinary()`, `fs.writeFileBinary()` available
- **bash**: Limited binary support (command output truncated at 100KB)

---

## Proxied Fetch

Network requests are proxied to handle CORS and cross-origin restrictions.

### CLI Mode

Express server provides `/api/fetch-proxy`:

```bash
curl -X POST /api/fetch-proxy \
  -H "X-Target-URL: https://api.example.com/data" \
  -H "Content-Type: application/json" \
  -d '{"key": "value"}'
```

All `fetch()` and `curl` calls route through proxy.

### Extension Mode

Host permissions configured in `manifest.json`:

```json
"host_permissions": [
  "https://*/*",
  "http://*/*"
]
```

Cross-origin fetch from extension pages allowed directly. Sandbox iframe proxies through parent page via postMessage.

### Behavior

| Runtime | Fetch Type | Route |
|---------|-----------|-------|
| CLI Node | Any | `/api/fetch-proxy` |
| CLI browser page | Anthropic API | Direct (whitelist) |
| CLI browser page | Other cross-origin | `/api/fetch-proxy` |
| Extension | Anthropic API | Direct (whitelist) |
| Extension | Other | Direct (host_permissions) |
| Extension sandbox | Any | postMessage to parent |

---

## Common Patterns

### Chain Commands

```bash
cat input.txt | grep "pattern" | sort | uniq
```

### Conditional Execution

```bash
mkdir -p output && cp file.txt output/ || echo "Failed"
```

### Variable Expansion

```bash
MYVAR="hello"
echo $MYVAR
```

### Function Definition

```bash
greet() {
  echo "Hello, $1"
}
greet "World"
```

### Here Document

```bash
cat > file.txt << EOF
Line 1
Line 2
EOF
```

### Command Substitution

```bash
DATE=$(date)
echo "Today is $DATE"
```

---

## Performance

- **Command startup**: <100ms (just-bash WASM initialization)
- **Script execution**: O(script complexity), typically <500ms
- **File I/O**: IndexedDB operations, <100ms per file
- **Binary operations**: LightningFS encoding/decoding, <50ms for typical images

For large-scale processing (1000+ files), batch operations and JavaScript tool are faster than shell loops.

---

## Limitations

- **Binary output in bash**: Commands producing binary output are limited to 100KB (just-bash constraint)
- **require() not supported**: .jsh scripts cannot import modules
- **Symlinks**: Not supported by LightningFS
- **Large files**: Reading >100MB files in bash is slow; use JavaScript tool instead
- **Network timeout**: curl/fetch timeout at 30 seconds (default)

---

## Dual-Mode Notes

### CLI Mode
- Full bash capabilities
- Shell state persisted across commands
- `node -e` uses `AsyncFunction` constructor
- Fetch requests routed through Express `/api/fetch-proxy`

### Extension Mode
- Full bash capabilities (same as CLI)
- Shell state persisted across commands
- `node -e` and `.jsh` scripts run in sandbox iframe (CSP-compliant)
- Fetch requests via `host_permissions` (no proxy needed)

Both modes share the same VirtualFS and command interface.

---

## Useful Commands

```bash
# Find files
find /workspace -name "*.js" -type f

# Search text
rg "TODO" /src --type js

# Process JSON
curl https://api.example.com/data | jq '.items[] | select(.status == "active")'

# Batch rename
for file in *.txt; do mv "$file" "${file%.txt}.md"; done

# ZIP archive
zip -r backup.zip /workspace -x "*.node_modules/*" "*.git/*"

# Git workflow
git status
git add .
git commit -m "Feature: add new tool"
git push origin main

# Python data processing
python3 -c "
import json
data = json.load(open('data.json'))
result = [x for x in data if x['count'] > 10]
print(json.dumps(result, indent=2))
"

# Node scripting
node -e "
const fs = require('fs');
const files = fs.readdirSync('.');
console.log(files);
"

# Schedule a task
crontask add "cleanup" "0 3 * * 0" cleaner-scoop "Remove old files from /tmp"
```

---

## References

- **just-bash**: https://github.com/jotaen/just-bash
- **Supplemental commands**: `src/shell/supplemental-commands/`
- **JSH executor**: `src/shell/jsh-executor.ts`
- **Binary cache**: `src/shell/binary-cache.ts`
- **Argument parser**: `src/shell/parse-shell-args.ts`
- **Discovery**: `src/shell/jsh-discovery.ts`
