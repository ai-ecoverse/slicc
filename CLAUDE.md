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

Ports (CLI mode only): 3000 (UI server), 9222 (Chrome CDP), 24679 (Vite HMR WebSocket)

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

- **Orchestrator** (`orchestrator.ts`): Creates/destroys scoop contexts, routes messages, manages the single shared VirtualFS, handles scoop completion notifications back to the cone.
- **ScoopContext** (`scoop-context.ts`): Per-scoop agent instance with RestrictedFS, WasmShell, skills, and NanoClaw-style tools (send_message, schedule_task, delegate_to_scoop).
- **Delegation**: The cone delegates work to scoops via the `delegate_to_scoop` tool, providing complete self-contained prompts (scoops have no access to the cone's conversation). When a scoop finishes, the orchestrator automatically routes its response back to the cone's message queue.
- **Unified Filesystem**: One VirtualFS (`slicc-fs` IndexedDB). Cone gets unrestricted access. Each scoop gets a `RestrictedFS` limited to `/scoops/{name}/` + `/shared/`. Parent directory traversal is allowed for `stat`/`exists` (so `cd` works), but reads/writes outside the sandbox are blocked.
- **DB** (`db.ts`): IndexedDB schema v2 with `scoops`, `messages`, `sessions`, `tasks`, `state` stores. Migration from v1 groups schema.

### Virtual Filesystem (src/fs/)
POSIX-like async filesystem backed by LightningFS (IndexedDB). VirtualFS is the facade. FsError carries POSIX error codes (ENOENT, EISDIR, EACCES, etc.). All paths are absolute, forward-slash, normalized.

**RestrictedFS** (`restricted-fs.ts`): Wraps VirtualFS with path-based access control for scoops.
- Read operations (stat, exists, readDir): return ENOENT/empty for outside paths. Parent directories of allowed paths are traversable (needed for `cd`).
- Write operations (writeFile, mkdir, rm, rename): throw EACCES for outside paths.
- `readDir` on parent dirs filters to only entries leading toward allowed paths.
- `getLightningFS()` delegated for isomorphic-git compatibility.

### Shell (src/shell/)
WasmShell wraps just-bash 2.11.7 (WASM Bash interpreter) and connects it to VirtualFS via VfsAdapter (implements just-bash's IFileSystem). The shell maintains env/cwd state across calls. Terminal UI via xterm.js with dynamic imports (so tests run in Node without xterm). Supports 78+ commands, escape sequences (arrow keys, Home/End/Delete), multi-line editing with continuation buffer, and proxied fetch for curl/networking (via `/api/fetch-proxy` in CLI mode, direct fetch with `host_permissions` in extension mode). Binary response handling: `readResponseBody()` detects content-type and uses latin1 encoding for binary types to preserve byte fidelity through just-bash's string-typed FetchResult. A binary cache (`binary-cache.ts`) stores raw Uint8Array for VfsAdapter to bypass string encoding on write.

**Extension CSP workaround**: `node -e` in extension mode routes through the sandbox iframe (CSP blocks `AsyncFunction` constructor on extension pages). Python uses bundled Pyodide loaded from `chrome.runtime.getURL('pyodide/')`.

### CDP (src/cdp/)
CDPTransport interface (`transport.ts`) abstracts the underlying protocol. Two implementations:
- **CDPClient**: WebSocket-based, used in CLI mode. Connects through ws://localhost:3000/cdp proxy.
- **DebuggerClient** (`debugger-client.ts`): Uses `chrome.debugger` API in extension mode. Intercepts `Target.*` commands and maps them to `chrome.tabs`/`chrome.debugger`. Manages tab attach/detach lifecycle with session-to-tab mapping.

BrowserAPI: high-level Playwright-style API built on either transport (listPages, navigate, screenshot, evaluate, click, type, waitForSelector, getAccessibilityTree). Auto-selects transport based on extension detection. TargetInfo and PageInfo types include `active` field (boolean, extension mode only) to identify the user's currently focused tab, enabling intelligent tool auto-dispatch.

### Tools (src/tools/)
All tools use the legacy ToolDefinition interface (name, description, inputSchema, execute). Active agent tools: bash, read_file, write_file, edit_file, browser (with sub-actions), javascript. Factory functions take their dependency (VirtualFS, WasmShell, or BrowserAPI).

**NanoClaw tools** (src/scoops/nanoclaw-tools.ts): Per-scoop tools for messaging and scheduling — `send_message`, `schedule_task`, `list_tasks`, `pause_task`, `resume_task`, `cancel_task`. Cone-only tools: `list_scoops`, `register_scoop`, `delegate_to_scoop`, `update_global_memory`.

**Browser tool enhancements:**
- `screenshot` action now supports `path` (save PNG to VFS), `fullPage` (capture entire scrollable page), and `selector` (capture just one element)
- `show_image` action displays image files from VFS inline in the chat with automatic base64 encoding
- `serve` action serves a VFS directory as a web app in a new browser tab via the preview Service Worker. Takes `directory` (VFS path) and optional `entry` (default `index.html`). Returns the new tab's targetId for subsequent snapshot/screenshot/evaluate calls.
- Auto-resolves to the user's active/focused tab when targetId is omitted (CDP types TargetInfo/PageInfo now include `active` field)
- VFS access via `path` parameter to save results without bloating conversation history
- App tab detection excludes `/preview/` URLs to prevent preview tabs from being misidentified as the SLICC app tab in extension mode

**JavaScript tool**: `fs.readDir(path)` returns `string[]` (filenames). `fs.readFileBinary(path)` returns `Uint8Array` directly.

### Core Agent (src/core/)
Uses @mariozechner/pi-agent-core for the agent loop and @mariozechner/pi-ai for unified LLM streaming. Key types re-exported from pi packages: AgentMessage, AgentTool, AgentEvent, Model, StreamFn.

- Agent class (from pi-agent-core): state management, `subscribe()` for events, `prompt()` for messages, `abort()` to stop
- tool-adapter.ts: wraps legacy ToolDefinition into AgentTool (pi-compatible execute signature)
- context-compaction.ts: `compactContext()` truncates oversized tool results and drops old messages to stay within token limits. Applied to every scoop via `transformContext`.
- types.ts: self-contained type definitions (ToolDefinition, ToolResult, AgentConfig, SessionData)

### UI (src/ui/)
Vanilla TypeScript, no framework. Two layout modes selected by `isExtension` detection:
- **Extension mode**: Compact single-row header (slicc + scoop dropdown + model dropdown + icon buttons). Tabbed interface (Chat/Terminal/Files/Memory). Scoop switcher as dropdown menu.
- **Standalone mode**: Resizable split layout — scoops panel (left) + chat + terminal (top-right) + files/memory tabs (bottom-right).

main.ts bootstraps the orchestrator (always cone+orchestrator, no direct agent mode) and wires events. Per-scoop message buffers capture tool calls even when viewing a different scoop. Input locks immediately when the cone starts processing (including auto-activation from scoop notifications). Assistant label is "sliccy" for the cone, `{name}-scoop` for scoops.

File browser supports clicking files to download and a ZIP button on folders (uses fflate) to download entire directories.

Two separate IndexedDB session stores: UI-level (browser-coding-agent DB in session-store.ts) and core agent-level (agent-sessions DB in core/session.ts). Orchestrator data (scoops, messages, tasks, state) stored in slicc-groups DB (name retained for backward compatibility).

### Extension (src/extension/)
Chrome Manifest V3 extension files. Service worker opens the side panel on action click. `chrome.d.ts` provides minimal typed declarations for the Chrome APIs used (debugger, tabs, sidePanel, runtime). `sandbox.html` (project root) provides an isolated execution environment for the JavaScript tool and `node -e` — exempt from extension CSP, allows Function constructor. Cross-origin fetch from sandbox is proxied through the parent page via postMessage. Pyodide (~13MB) bundled at `dist/extension/pyodide/` for Python support (loaded from `'self'` origin).

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
  Cone -> delegate_to_scoop tool -> Orchestrator.delegateToScoop()
    -> ScoopContext.prompt() (with full context from cone) -> ... -> completion notification -> Cone
```

## Key Conventions

- **Two type systems**: Legacy ToolDefinition/ToolResult (in src/tools/) and pi-compatible AgentTool/AgentToolResult (in src/core/). The adapter in tool-adapter.ts bridges them.
- **Tests are colocated**: foo.test.ts next to foo.ts. Vitest with globals: true, environment: node. New pure-logic code (utilities, adapters, data transformations) should always have tests. DOM-dependent code (UI panels, layout) and chrome.* API code (DebuggerClient) are acceptable to skip in Node tests but should be manually verified. Use `fake-indexeddb/auto` for tests that need VFS. Current count: 391 tests across 28 files.
- **Logging**: createLogger('namespace') from src/core/logger.ts. Level-filtered, DEBUG in dev, ERROR in prod. Uses __DEV__ global (set by Vite define).
- **Node shims**: src/shims/empty.ts stubs out node:zlib and node:module for the browser bundle (just-bash references them).
- **Multi-provider auth**: Provider settings in `src/ui/provider-settings.ts`. Supports Anthropic (direct), Azure AI Foundry (Claude on Azure), Azure OpenAI (GPT), AWS Bedrock, and many more via pi-ai. Provider/API key/baseUrl stored in localStorage. Model resolved via `resolveCurrentModel()` with baseUrl override.
- **Extension detection**: `typeof chrome !== 'undefined' && !!chrome?.runtime?.id` — used throughout to select CDP transport, layout mode, fetch strategy, JS tool sandbox mechanism, and Pyodide loading path.

## Git Integration (src/git/)
Git support via isomorphic-git with LightningFS as the backing store. GitCommands class provides CLI-like interface for git operations (init, clone, add, commit, status, log, branch, checkout, diff, remote, fetch, pull, push, config, rev-parse). Registered as a custom command in just-bash so it works in compound commands and via the bash tool.

- **Authentication**: Set `git config github.token <PAT>` to authenticate with GitHub (avoids rate limits on public repos, required for private repos)
- **CORS handling**: In CLI mode, git HTTP requests route through `/api/fetch-proxy`. In extension mode, uses direct fetch with host_permissions.
- **Unified filesystem**: VirtualFS wraps LightningFS, exposing `getLightningFS()` for isomorphic-git compatibility. Shell, git, file browser, and tools all share the same filesystem.

## Debugging Browser Features

When developing or debugging browser-based features (terminal, file browser, agent behavior), use the `agent-browser` skill to automate Chrome and observe behavior directly:

1. **Start the dev server**: `npm run dev:full` (launches Chrome with CDP on port 9222)
2. **Use agent-browser skill**: Invoke the skill to navigate, interact with UI elements, take screenshots, and inspect state
3. **Check CLI logs**: The Express server logs all requests. Console output from the browser is forwarded to CLI stdout via the CDP console forwarder.
4. **Add temporary debug logging**: Use `console.log()` in browser code — output appears in CLI terminal. Remove before committing.

This approach keeps the human out of the debug loop by letting the agent directly observe browser behavior, check network requests in CLI logs, and iterate without manual intervention.
