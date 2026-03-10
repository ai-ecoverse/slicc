# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build and Development Commands

```bash
# Standalone CLI mode
npm run dev:full        # Full dev mode: Vite HMR + Chrome + CDP proxy (port 3000)
npm run dev             # Vite dev server only (no Chrome/CDP)
npm run build           # Production build (UI via Vite + CLI via TSC)
npm run build:ui        # Vite build only into dist/ui/
npm run build:cli       # TSC build only into dist/cli/
npm run start           # Run production CLI (requires build first)

# Chrome extension
npm run build:extension # Build extension into dist/extension/ (load in chrome://extensions)

# Shared
npm run typecheck       # Typecheck both tsconfig targets
npm run test            # Vitest run (all tests)
npm run test:watch      # Vitest watch mode
npx vitest run src/fs/virtual-fs.test.ts  # Run a single test file
```

**Requires Node >= 22** (LTS). LightningFS uses `navigator` which is only available as a global from Node 21+. Tests will fail on Node 20 or earlier.

Ports (CLI mode only): 3000 (UI server), 9222 (Chrome CDP), 24679 (Vite HMR WebSocket)

## Philosophy

Three foundational ideas:

1. **The Claw Pattern (Steinberger-Karpathy)**: SLICC is a "claw" — a persistent orchestration layer on top of LLM agents. Claws add scheduling, messaging, event handling, and skills ecosystems on top of basic agent capabilities. The term was [coined by Andrej Karpathy](https://x.com/karpathy/status/2024987174077432126). [OpenClaw](https://github.com/openclaw/openclaw) (by Peter Steinberger) is the original implementation. SLICC is a claw that runs in the browser. The agent engine is [Pi](https://github.com/badlogic/pi-mono) by Mario Zechner (pi-agent-core, pi-ai).

2. **Agents Love the CLI (Zechner)**: Pi has 4 tools: read, write, edit, bash. SLICC adds 1: browser. All other capabilities are shell commands (git, node, python, webhook, crontask, skill, upskill). When adding new capabilities, default to shell commands, not dedicated tools. MCP server definitions burn context tokens; CLI tools compose naturally. Zechner's principle: ["Bash is all you need."](https://mariozechner.at/posts/2025-11-02-what-if-you-dont-need-mcp/)

3. **The Browser is the OS (Andreessen)**: All logic and state runs client-side. The server is a stateless relay for port listening, CDP launch, and CORS. When implementing new features, prefer browser-native APIs (IndexedDB, Service Workers, WASM, fetch). If the extension float (zero server) can't run it, question whether it belongs in the server.

## Principles

When making architectural decisions, apply these in order:

1. **Virtual CLIs over dedicated tools** — New capabilities should be shell commands first. Only create a dedicated tool if the capability cannot work through bash (like browser automation requiring screenshot binary data).

2. **Browser-first implementation** — State in IndexedDB. Logic in the client. The server only does what browsers physically cannot. Every line of server code is a line that doesn't work in the extension float.

3. **Minimal server** — The extension float has zero server. That's the target for all floats. If you're adding server code, justify why the browser can't do it.

4. **Skills over hardcoded features** — New agent capabilities should be SKILL.md files, not code changes. The core stays minimal. Skills are natural language instructions following the [Agent Skills standard](https://agentskills.io).

## Concepts (Ice Cream Vocabulary)

The codebase uses ice cream terminology consistently. When working on this code, use these terms:

- **Cone**: The main agent ("sliccy"). Human's point of interaction. Full filesystem access, all tools. Orchestrates scoops. Code: `orchestrator.ts`, type `RegisteredScoop` with `isCone: true`.

- **Scoops**: Isolated sub-agents. Each gets sandboxed filesystem (`/scoops/{name}/` + `/shared/`), own shell, own conversation. Created via `scoop_scoop`, fed instructions via `feed_scoop`, removed via `drop_scoop`. Code: `scoop-context.ts`, `restricted-fs.ts`.

- **Licks**: External events that trigger scoops. Types: webhooks, cron tasks, browser events (planned). Unified under `LickManager` and `LickEvent`. Shell commands: `webhook`, `crontask`. A lick arrives, the scoop reacts — no human in the loop.

- **Floats**: Runtime environments. Three exist:
  - CLI float: Node.js/Express + Chrome. Code: `src/cli/`.
  - Extension float: Chrome extension side panel, zero server. Code: `src/extension/`.
  - Cloud float (planned): Cloudflare Containers or E2B sandboxes.

When renaming or refactoring, prefer ice cream terms over technical jargon (e.g., "feed_scoop" not "delegate_to_scoop", "lick" not "event").

## Architecture

Browser-based AI coding agent: a self-contained development environment where Claude writes code, runs shell commands, and automates browser tabs entirely within Chrome, without touching the host filesystem. Runs as a **Chrome extension** (side panel) or as a **standalone CLI** server.

### Two Deployment Modes

- **Chrome extension** (Manifest V3): Side panel UI with tabbed layout (Chat/Terminal/Files/Memory). Uses `chrome.debugger` API for browser automation. Built via `npm run build:extension` -> `dist/extension/`. Load as unpacked extension in `chrome://extensions`. Pyodide bundled for Python support (~13MB).
- **Standalone CLI**: Express server launches Chrome, proxies CDP over WebSocket. Resizable split layout with scoops panel + chat + terminal + files/memory. Built via `npm run build` -> `dist/ui/` + `dist/cli/`.

### Three Build Targets

- **Browser bundle** (tsconfig.json): Everything in src/ except src/cli/. Bundled by Vite, module resolution: bundler. Runs in Chrome.
- **CLI server** (tsconfig.cli.json): Only src/cli/. Compiled by TSC to dist/cli/, module resolution: NodeNext. Runs in Node.
- **Extension bundle** (vite.config.extension.ts): Same browser bundle with extension-specific entry points (service-worker.js, sandbox.html, manifest.json) plus bundled Pyodide. Output: dist/extension/.

### Layer Stack (bottom-up)

```
Virtual Filesystem (src/fs/)
  -> RestrictedFS (path ACL for scoops)
    -> Shell (src/shell/)
    -> Git (src/git/)
  -> CDP (src/cdp/)
  -> Tools (src/tools/)
    -> Core Agent (src/core/)
      -> Scoops Orchestrator (src/scoops/)
        -> UI (src/ui/)
          -> CLI Server (src/cli/) | Extension (src/extension/)
```

### The Cone and Scoops (src/scoops/)

SLICC uses an ice cream theme for its multi-agent system. The **cone** is the main assistant (sliccy) that holds everything together. **Scoops** are isolated agent contexts stacked on top, each with their own tools, shell, and restricted filesystem.

- **Orchestrator** (`orchestrator.ts`): Creates/destroys scoop contexts, routes messages, manages the single shared VirtualFS, handles scoop completion notifications back to the cone. Creates a `SessionStore` instance and passes it to each `ScoopContext`; deletes sessions on scoop removal and clears all on reset.
- **ScoopContext** (`scoop-context.ts`): Per-scoop agent instance with RestrictedFS, WasmShell, skills, and NanoClaw-style tools (send_message).
- **Scheduler** (`scheduler.ts`): Polls persisted scoop tasks on an interval, supports cron/interval/once schedules, and invokes callbacks when tasks become due.
- **Heartbeat** (`heartbeat.ts`): Tracks scoop health/activity, processing state, error counts, and idle/dead transitions for monitoring.
- **Delegation**: The cone feeds work to scoops via the `feed_scoop` tool, providing complete self-contained prompts (scoops have no access to the cone's conversation). When a scoop finishes, the orchestrator automatically routes its response back to the cone's message queue.
- **Unified Filesystem**: One VirtualFS (`slicc-fs` IndexedDB). Cone gets unrestricted access. Each scoop gets a `RestrictedFS` limited to `/scoops/{name}/` + `/shared/`. Parent directory traversal is allowed for `stat`/`exists` (so `cd` works), but reads/writes outside the sandbox are blocked.
- **DB** (`db.ts`): IndexedDB schema v3 with `scoops`, `messages`, `sessions`, `tasks`, `state`, `webhooks`, and `crontasks` stores. Migrates the old `groups` store to `scoops` and adds webhook/crontask persistence in v3.

### Virtual Filesystem (src/fs/)
POSIX-like async filesystem backed by LightningFS (IndexedDB). VirtualFS is the facade. FsError carries POSIX error codes (ENOENT, EISDIR, EACCES, etc.). All paths are absolute, forward-slash, normalized.

**RestrictedFS** (`restricted-fs.ts`): Wraps VirtualFS with path-based access control for scoops.
- Read operations (stat, exists, readDir): return ENOENT/empty for outside paths. Parent directories of allowed paths are traversable (needed for `cd`).
- Write operations (writeFile, mkdir, rm, rename): throw EACCES for outside paths.
- `readDir` on parent dirs filters to only entries leading toward allowed paths.
- `getLightningFS()` delegated for isomorphic-git compatibility.

### Shell (src/shell/)
WasmShell wraps just-bash 2.11.7 (WASM Bash interpreter) and connects it to VirtualFS via VfsAdapter (implements just-bash's IFileSystem). The shell maintains env/cwd state across calls. Terminal UI via xterm.js with dynamic imports (so tests run in Node without xterm). Supports 78+ commands, escape sequences (arrow keys, Home/End/Delete), multi-line editing with continuation buffer, and proxied fetch for curl/networking (via `/api/fetch-proxy` in CLI mode, direct fetch with `host_permissions` in extension mode). Binary response handling: `readResponseBody()` detects content-type and uses latin1 encoding for binary types to preserve byte fidelity through just-bash's string-typed FetchResult. A binary cache (`binary-cache.ts`) stores raw Uint8Array for VfsAdapter to bypass string encoding on write.

**Custom shell commands** (`src/shell/supplemental-commands/`): Additional commands beyond bash builtins:
- `skill list` — List installed skills with version and status
- `skill install <name>` — Install a skill from `/workspace/skills/`
- `skill uninstall <name>` — Remove an installed skill
- `upskill <source>` — Install skills from GitHub repos or ClawHub registry
  - `upskill owner/repo` — Install from GitHub repository
  - `upskill owner/repo --skill name` — Install specific skill from repo
  - `upskill clawhub:skill-name` — Install from ClawHub by name
  - `upskill search "query"` — Search ClawHub for skills
- `git` — Full git support via isomorphic-git
- `imgcat` — Preview image and video files in the preview tab
- `sqlite3` / `sqllite` — SQLite database operations
- `node -e "code"` — Execute JavaScript
- `python3 -c "code"` / `python -c "code"` — Execute Python via Pyodide
- `open <url>` — Open URL in browser tab
- `zip/unzip` — Archive compression
- `webhook` — Manage webhooks for event-driven automation
- `crontask` — Schedule cron jobs that dispatch licks to scoops
- `pdftk` / `pdf` — Inspect, extract, rotate, and merge PDFs
- `mount` — Mount a local directory into the virtual filesystem via the File System Access API
- `convert` / `magick` — ImageMagick-style image conversion (resize, rotate, crop, quality) via `@imagemagick/magick-wasm`
- `which <command>` — Resolve a command to its path (`/usr/bin/<name>` for built-ins, actual VFS path for `.jsh` files)
- `commands` — Show all available commands (type `commands` in terminal)

Any `*.jsh` file anywhere on the VFS is auto-discovered as a shell command (basename without `.jsh` extension). Skills can ship `.jsh` files alongside `SKILL.md` to provide executable commands. Files in `/workspace/skills/` get priority when names conflict.

**Extension CSP workaround**: `node -e` in extension mode routes through the sandbox iframe (CSP blocks `AsyncFunction` constructor on extension pages). Python uses bundled Pyodide loaded from `chrome.runtime.getURL('pyodide/')`. ImageMagick WASM is fetched as bytes from `chrome.runtime.getURL('magick.wasm')` since `initializeImageMagick` rejects `chrome-extension://` URLs.

**JSH Scripts** (`src/shell/jsh-discovery.ts`, `src/shell/jsh-executor.ts`, `src/shell/parse-shell-args.ts`): `.jsh` files are JavaScript shell scripts that are auto-discovered as commands anywhere on the VFS.
- `jsh-discovery.ts` — Scans VFS for `*.jsh` files with priority roots (`/workspace/skills/`), returns `Map<name, path>`. First occurrence of a basename wins.
- `jsh-executor.ts` — Executes `.jsh` files with Node-like globals: `process` (argv, env, cwd, exit, stdout.write, stderr.write), `console` (log, info, warn, error), `fs` bridge (readFile, writeFile, readDir, mkdir, rm, stat, exists, fetchToFile). Dual-mode: `AsyncFunction` in CLI, sandbox iframe in extension (CSP-compliant). Returns `JshResult` with stdout, stderr, exitCode.
- `parse-shell-args.ts` — Shell-like argument parser handling double quotes, single quotes, and backslash escapes.
- `which-command.ts` — Implements `which` to resolve built-in commands (`/usr/bin/<name>`) and `.jsh` scripts (actual VFS path).

### Skills System (src/skills/, src/scoops/skills.ts)
Two complementary skill systems:

1. **Prompt injection** (`src/scoops/skills.ts`): Skills in `/workspace/skills/` with `SKILL.md` files are automatically loaded into the agent's system prompt. Headers are shown by default; full content loaded on demand via `read_file`.

2. **Installation engine** (`src/skills/`): Full package manager for installing/uninstalling skill packages:
   - Manifest-based installation (`manifest.yaml` with name, version, dependencies, conflicts)
   - State tracking in `.slicc/state.json`
   - Security validations (path traversal protection, manifest name matching)
   - Dependency and conflict checking
   - Drag-and-drop import path via `install-from-drop.ts` (unpacks `.skill` archives into `/workspace/skills/{name}` only; does not auto-apply skill side effects)

**Default skills** are bundled from `src/defaults/workspace/skills/` using Vite's `import.meta.glob`.

### CDP (src/cdp/)
CDPTransport interface (`transport.ts`) abstracts the underlying protocol. Two implementations:
- **CDPClient**: WebSocket-based, used in CLI mode. Connects through ws://localhost:3000/cdp proxy.
- **DebuggerClient** (`debugger-client.ts`): Uses `chrome.debugger` API in extension mode. Intercepts `Target.*` commands and maps them to `chrome.tabs`/`chrome.debugger`. Manages tab attach/detach lifecycle with session-to-tab mapping.

BrowserAPI: high-level Playwright-style API built on either transport (listPages, navigate, screenshot, evaluate, click, type, waitForSelector, getAccessibilityTree). Auto-selects transport based on extension detection. TargetInfo and PageInfo types include `active` field (boolean, extension mode only) to identify the user's currently focused tab, enabling intelligent tool auto-dispatch.

**HarRecorder** (`har-recorder.ts`): Records network traffic from browser tabs as HAR 1.2 files. Supports user-provided JS filter functions (`(entry) => false | true | object`). Filter application is deferred to snapshot save time (batch, not per-entry) to support extension mode — in extensions, filter code is sent to the sandbox iframe (CSP-exempt) via `postMessage`; in CLI mode, compiled directly. Snapshots saved to `/recordings/{id}/` on navigation and recording stop. Graceful fallback: filter errors return unfiltered entries.

### Tools (src/tools/)
All tools use the legacy ToolDefinition interface (name, description, inputSchema, execute). Active agent tools: bash, read_file, write_file, edit_file, browser (with sub-actions), javascript. Factory functions take their dependency (VirtualFS, WasmShell, or BrowserAPI).

**NanoClaw tools** (src/scoops/nanoclaw-tools.ts): Per-scoop tools for messaging — `send_message`. Cone-only tools: `list_scoops`, `scoop_scoop` (create), `feed_scoop` (delegate), `drop_scoop` (remove), `update_global_memory`. Task scheduling moved to the `crontask` shell command.

**Browser tool enhancements:**
- `new_tab` opens a new tab, navigates it to the requested URL, and returns its `targetId`
- `new_recorded_tab` opens a new tab with HAR recording enabled, accepts an optional JS `filter`, and saves recordings under `/recordings/<recordingId>/`
- `stop_recording` stops an active HAR capture and saves the final recording snapshot to VFS
- `snapshot` captures a Playwright-style accessibility snapshot with per-element refs like `e1`; snapshots are cached per tab and required before `screenshot`
- `screenshot` action now supports `path` (save PNG to VFS), `fullPage` (capture entire scrollable page), and `selector` (capture just one element)
- `click` accepts either a CSS `selector` or a snapshot `ref`, and invalidates the cached snapshot after interaction
- `type` types into the focused element on the selected or active tab
- `show_image` action displays image files from VFS inline in the chat with automatic base64 encoding
- `evaluate_persistent` runs JS in a dedicated blank runtime tab so variables persist across calls without needing a `targetId`
- `serve` action serves a VFS directory as a web app in a new browser tab via the preview Service Worker. Takes `directory` (VFS path) and optional `entry` (default `index.html`). Creates a new tab and includes the targetId in the response text for subsequent snapshot/screenshot/evaluate calls. Validates `entry` against path traversal (`..`, absolute paths).
- Auto-resolves to the user's active/focused tab when targetId is omitted (CDP types TargetInfo/PageInfo now include `active` field)
- VFS access via `path` parameter to save results without bloating conversation history
- App tab detection excludes `/preview/` URLs to prevent preview tabs from being misidentified as the SLICC app tab in extension mode

**JavaScript tool**: `fs.readDir(path)` returns `string[]` (filenames). `fs.readFileBinary(path)` returns `Uint8Array` directly.

### Core Agent (src/core/)
Uses @mariozechner/pi-agent-core for the agent loop and @mariozechner/pi-ai for unified LLM streaming. Key types re-exported from pi packages: AgentMessage, AgentTool, AgentEvent, Model, StreamFn.

- Agent class (from pi-agent-core): state management, `subscribe()` for events, `prompt()` for messages, `abort()` to stop
- tool-adapter.ts: wraps legacy ToolDefinition into AgentTool (pi-compatible execute signature)
- tool-registry.ts: registers `ToolDefinition` objects, rejects duplicate names, and dispatches tool execution by name with error-to-`ToolResult` conversion
- context-compaction.ts: `compactContext()` truncates oversized tool results and drops old messages to stay within token limits. Applied to every scoop via `transformContext`.
- types.ts: self-contained type definitions (ToolDefinition, ToolResult, AgentConfig, SessionData)
- **Session persistence** (`session.ts`): `SessionStore` persists `AgentMessage[]` to IndexedDB (`agent-sessions` DB) keyed by scoop JID. `ScoopContext` restores messages on init and saves on `agent_end`, enabling agents to resume conversations across restarts. Errors are caught and logged without breaking agent flow; `compactContext` handles large restored sessions at prompt time.

### UI (src/ui/)
Vanilla TypeScript, no framework. Two layout modes selected by `isExtension` detection:
- **Extension mode**: Compact single-row header (slicc + scoop dropdown + model dropdown + icon buttons). Tabbed interface (Chat/Terminal/Files/Memory). Scoop switcher as dropdown menu.
- **Standalone mode**: Resizable split layout — scoops panel (left) + chat + terminal (top-right) + files/memory tabs (bottom-right).

main.ts bootstraps the orchestrator (always cone+orchestrator, no direct agent mode), wires events, and registers global `.skill` drag/drop handlers with overlay + toast feedback. Per-scoop message buffers capture tool calls even when viewing a different scoop. Input locks immediately when the cone starts processing (including auto-activation from scoop notifications). Assistant label is "sliccy" for the cone, `{name}-scoop` for scoops.

File browser supports clicking files to download and a ZIP button on folders (uses fflate) to download entire directories.

Two separate IndexedDB session stores: UI-level (browser-coding-agent DB in session-store.ts) and core agent-level (agent-sessions DB in core/session.ts). Orchestrator data (scoops, messages, tasks, state) stored in slicc-groups DB (name retained for backward compatibility).

**Voice Input** (`voice-input.ts`): Hands-free voice mode using the Web Speech API (`webkitSpeechRecognition`). Two runtime paths:
- **Standalone (CLI)**: Direct `getUserMedia` + `webkitSpeechRecognition` in the browser page.
- **Extension**: Side panels can't trigger mic permission prompts. First use opens a popup window (`voice-popup.html`) for the one-time permission grant. Once granted, subsequent uses work directly in the side panel (permission cached per `chrome-extension://` origin). Falls back to popup if direct access fails.

Voice mode is a toggle (mic button or `Ctrl+Shift+V` / `Cmd+Shift+V`): click once to enable, click again to disable. While enabled, the user speaks → 2.5s silence → message auto-sends → input locks during agent response → voice auto-restarts when the turn ends. Mic button stays clickable during streaming so voice mode can be toggled off. Consecutive no-speech restarts use exponential backoff (300ms → 5s cap) to prevent rapid mic toggling. Settings (`voice-auto-send`, `voice-lang`) stored in localStorage.

Extension assets: `voice-popup.html` + `voice-popup.js` (project root, copied to `dist/extension/` by `vite.config.extension.ts`).

### Extension (src/extension/)
Chrome Manifest V3 extension files. Service worker opens the side panel on action click. `chrome.d.ts` provides minimal typed declarations for the Chrome APIs used (debugger, tabs, sidePanel, runtime, windows, messaging). `sandbox.html` (project root) provides an isolated execution environment for the JavaScript tool and `node -e` — exempt from extension CSP, allows Function constructor. Cross-origin fetch from sandbox is proxied through the parent page via postMessage. Pyodide (~13MB) bundled at `dist/extension/pyodide/` for Python support (loaded from `'self'` origin).

### Preview Service Worker (src/ui/preview-sw.ts)
A Service Worker that intercepts `/preview/*` fetch requests and serves content from VFS (IndexedDB via LightningFS). Enables the agent to create HTML/CSS/JS apps in the virtual filesystem and preview them in real browser tabs.

- Registered at app startup in `main.ts` with scope `/preview/`
- Strips `/preview` prefix to get the VFS path, reads the file, responds with correct MIME type
- Handles directory requests by appending `/index.html`
- Returns 404 for missing files
- Uses `skipWaiting()` + `clients.claim()` for immediate activation
- **Build strategy**: Built as a self-contained IIFE via esbuild (not rollup). Rollup would code-split LightningFS into a shared chunk that SWs can't import. In dev mode, a Vite plugin (`preview-sw-builder`) bundles and serves it on the fly at `/preview-sw.js`. In production, a `closeBundle` hook writes the bundle to the output directory.
- MIME type mapping via inline `getMimeType()` (same logic as `src/core/mime-types.ts` but inlined since the SW is a separate bundle)

### CLI Server (src/cli/index.ts)
Express server that launches Chrome with remote debugging, serves the UI (Vite middleware in dev, static files in prod), and runs a WebSocket proxy at /cdp. Provides `/api/fetch-proxy` endpoint for cross-origin fetch (replaces CORS proxy). Single shared Chrome WebSocket connection with client message buffering. Console forwarder pipes in-page console output to CLI stdout.

### Context Compaction (src/core/context-compaction.ts)
To prevent context overflow (200K token limit), the agent applies two-phase message compaction before each API call:
1. **Result truncation**: Tool results larger than 8000 chars (~2K tokens) are truncated with a marker
2. **Message dropping**: If total context exceeds ~150K tokens, old messages (except first 2 and last 10) are dropped and replaced with a compaction marker message

This preserves recent context and the initial exchange while preventing runaway token usage. Applied to every scoop context via `transformContext: compactContext`.

### Data Flow
```
User -> ChatPanel -> AgentHandle.sendMessage()
  -> Orchestrator.handleMessage() -> routeToScoop() -> processScoopQueue()
    -> ScoopContext.prompt() -> pi-agent-core loop -> LLM API (streaming)
      -> AgentEvent stream -> Orchestrator callbacks -> per-scoop message buffer
        -> emitToUI (if selected) -> ChatPanel DOM
      -> Tool calls -> RestrictedFS / WasmShell / BrowserAPI -> results -> back to agent loop
    -> Scoop completes -> Orchestrator notification -> Cone's message queue -> Cone reacts

Delegation:
  Cone -> feed_scoop tool -> Orchestrator.delegateToScoop()
    -> ScoopContext.prompt() (with full context from cone) -> ... -> completion notification -> Cone
```

## Key Conventions

- **Two type systems**: Legacy ToolDefinition/ToolResult (in src/tools/) and pi-compatible AgentTool/AgentToolResult (in src/core/). The adapter in tool-adapter.ts bridges them.
- **Tests are colocated**: foo.test.ts next to foo.ts. Vitest with globals: true, environment: node. New pure-logic code (utilities, adapters, data transformations) should always have tests. DOM-dependent code (UI panels, layout) and chrome.* API code (DebuggerClient) are acceptable to skip in Node tests but should be manually verified. Use `fake-indexeddb/auto` for tests that need VFS. Current count: 769 tests across 42 files.
- **Logging**: createLogger('namespace') from src/core/logger.ts. Level-filtered, DEBUG in dev, ERROR in prod. Uses __DEV__ global (set by Vite define).
- **Node shims**: Browser-bundle shims live in `src/shims/`. `empty.ts` stubs `node:zlib` and `node:module`; additional shim/polyfill files include `buffer-polyfill.ts`, `http.ts`, `https.ts`, `http2.ts`, and `stream.ts`.
- **Multi-provider auth**: Provider settings in `src/ui/provider-settings.ts`. Supports Anthropic (direct), Azure AI Foundry (Claude on Azure), Azure OpenAI (GPT), AWS Bedrock, and many more via pi-ai. Provider/API key/baseUrl stored in localStorage. Model resolved via `resolveCurrentModel()` with baseUrl override.
- **Extension detection**: `typeof chrome !== 'undefined' && !!chrome?.runtime?.id` — used throughout to select CDP transport, layout mode, fetch strategy, JS tool sandbox mechanism, and Pyodide loading path.
- **Dual-mode compatibility**: New features MUST work in both standalone CLI mode and Chrome extension mode. Extension CSP blocks dynamic eval and CDN fetches. Pattern: use sandbox iframe (`sandbox.html`) for dynamic code execution, `chrome.runtime.getURL()` + fetch for bundled WASM/assets, and three-branch detection (Node/Extension/Browser) for resource loading. Bundle extension assets in `vite.config.extension.ts` `closeBundle` hook. Always test in both modes.

## Change Requirements

Every change MUST satisfy three gates: **tests**, **docs**, and **verification**. All three are part of the implementation — not follow-up work. Do not consider a change complete until all three gates are satisfied.

### Tests
New pure-logic code (utilities, adapters, data transformations, path handling) MUST have colocated tests (`foo.test.ts` next to `foo.ts`). See `docs/testing.md` for patterns.

### Documentation
Changes must be reflected in the appropriate documentation tier:

| Tier | File | Update when... |
|------|------|----------------|
| **Public** | `README.md` | Change is user-facing: new features, new commands, new capabilities visible to end users |
| **Development** | `CLAUDE.md` | Change affects how developers work: new conventions, architecture decisions, build changes, new key files |
| **Agent reference** | `docs/` | Change adds or modifies anything an AI coding agent needs to look up: tools, shell commands, test patterns, file locations, pitfalls, how-to guides |

Not every change hits all three tiers. A bug fix with no API change may only need tests. A new shell command needs all three. Use judgment, but when in doubt, update the docs.

### Verification
Before committing, **all four** of these must pass:
```bash
npm run typecheck          # Both tsconfig targets
npm run test               # Vitest (all tests)
npm run build              # Production build (UI via Vite + CLI via TSC)
npm run build:extension    # Extension build (Vite with extension config)
```
Do not skip any. A typecheck pass does not guarantee the builds succeed (Vite bundling can fail independently). See `docs/development.md` for the full checklist.

**CI**: These same four gates run automatically on every PR to `main` via GitHub Actions (`.github/workflows/ci.yml`).

## Git Integration (src/git/)
Git support via isomorphic-git with LightningFS as the backing store. GitCommands class provides CLI-like interface for git operations (init, clone, add, commit, status, log, branch, checkout, diff, remote, fetch, pull, push, config, rev-parse). Registered as a custom command in just-bash so it works in compound commands and via the bash tool.

- **Authentication**: Set `git config github.token <PAT>` to authenticate with GitHub (avoids rate limits on public repos, required for private repos)
- **HTTP transport**: `git-http.ts` provides the custom isomorphic-git HTTP client used by GitCommands.
- **CORS handling**: In CLI mode, `git-http.ts` routes requests through `/api/fetch-proxy`. In extension mode, it uses direct fetch with host_permissions.
- **Unified filesystem**: VirtualFS wraps LightningFS, exposing `getLightningFS()` for isomorphic-git compatibility. Shell, git, file browser, and tools all share the same filesystem.

## Debugging Browser Features

When developing or debugging browser-based features (terminal, file browser, agent behavior), use the `agent-browser` skill to automate Chrome and observe behavior directly:

1. **Start the dev server**: `npm run dev:full` (launches Chrome with CDP on port 9222)
2. **Use agent-browser skill**: Invoke the skill to navigate, interact with UI elements, take screenshots, and inspect state
3. **Check CLI logs**: The Express server logs all requests. Console output from the browser is forwarded to CLI stdout via the CDP console forwarder.
4. **Add temporary debug logging**: Use `console.log()` in browser code — output appears in CLI terminal. Remove before committing.

This approach keeps the human out of the debug loop by letting the agent directly observe browser behavior, check network requests in CLI logs, and iterate without manual intervention.
