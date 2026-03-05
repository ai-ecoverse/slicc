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

- **Chrome extension** (Manifest V3): Side panel UI with tabbed layout (Chat/Terminal/Files). Uses `chrome.debugger` API for browser automation. Built via `npm run build:extension` → `dist/extension/`. Load as unpacked extension in `chrome://extensions`.
- **Standalone CLI**: Express server launches Chrome, proxies CDP over WebSocket. Resizable 3-panel split layout. Built via `npm run build` → `dist/ui/` + `dist/cli/`.

### Three Build Targets

- **Browser bundle** (tsconfig.json): Everything in src/ except src/cli/. Bundled by Vite, module resolution: bundler. Runs in Chrome.
- **CLI server** (tsconfig.cli.json): Only src/cli/. Compiled by TSC to dist/cli/, module resolution: NodeNext. Runs in Node.
- **Extension bundle** (vite.config.extension.ts): Same browser bundle with extension-specific entry points (service-worker.js, sandbox.html, manifest.json). Output: dist/extension/.

### Layer Stack (bottom-up)

Virtual Filesystem (src/fs/) -> Shell (src/shell/) -> CDP (src/cdp/) -> Tools (src/tools/) -> Core Agent (src/core/) -> UI (src/ui/) -> CLI Server (src/cli/) | Extension (src/extension/)

### Virtual Filesystem (src/fs/)
POSIX-like async filesystem backed by OPFS (preferred) or IndexedDB (fallback). VirtualFS is the facade; StorageBackend is the interface both backends implement. FsError carries POSIX error codes (ENOENT, EISDIR, etc.). All paths are absolute, forward-slash, normalized.

### Shell (src/shell/)
WasmShell wraps just-bash 2.11.7 (WASM Bash interpreter) and connects it to VirtualFS via VfsAdapter (implements just-bash's IFileSystem). The shell maintains env/cwd state across calls. Terminal UI via xterm.js with dynamic imports (so tests run in Node without xterm). Supports 78+ commands, escape sequences (arrow keys, Home/End/Delete), multi-line editing with continuation buffer, and proxied fetch for curl/networking (via `/api/fetch-proxy` in CLI mode, direct fetch with `host_permissions` in extension mode). Binary response handling: `readResponseBody()` detects content-type and uses latin1 encoding for binary types to preserve byte fidelity through just-bash's string-typed FetchResult. A binary cache (`binary-cache.ts`) stores raw Uint8Array for VfsAdapter to bypass string encoding on write.

### CDP (src/cdp/)
CDPTransport interface (`transport.ts`) abstracts the underlying protocol. Two implementations:
- **CDPClient**: WebSocket-based, used in CLI mode. Connects through ws://localhost:3000/cdp proxy.
- **DebuggerClient** (`debugger-client.ts`): Uses `chrome.debugger` API in extension mode. Intercepts `Target.*` commands and maps them to `chrome.tabs`/`chrome.debugger`. Manages tab attach/detach lifecycle with session-to-tab mapping.

BrowserAPI: high-level Playwright-style API built on either transport (listPages, navigate, screenshot, evaluate, click, type, waitForSelector, getAccessibilityTree). Auto-selects transport based on extension detection. TargetInfo and PageInfo types include `active` field (boolean, extension mode only) to identify the user's currently focused tab, enabling intelligent tool auto-dispatch.

### Tools (src/tools/)
All tools use the legacy ToolDefinition interface (name, description, inputSchema, execute). Active agent tools: bash, read_file, write_file, edit_file, browser (with sub-actions). Factory functions take their dependency (VirtualFS, WasmShell, or BrowserAPI). JavaScript execution and code search should be done through `bash` (for example `node -e`, `grep`, `find`, `rg`) rather than standalone agent tools.

**Browser tool enhancements:**
- `screenshot` action now supports `path` (save PNG to VFS), `fullPage` (capture entire scrollable page), and `selector` (capture just one element)
- `show_image` action displays image files from VFS inline in the chat with automatic base64 encoding
- Auto-resolves to the user's active/focused tab when targetId is omitted (CDP types TargetInfo/PageInfo now include `active` field)
- VFS access via `path` parameter to save results without bloating conversation history

**JavaScript tool enhancement:**
- `fs.readFileBinary(path)` now returns `Uint8Array` directly instead of encoded string, enabling efficient binary file operations (e.g., canvas image processing)

### Core Agent (src/core/)
Uses @mariozechner/pi-agent-core for the agent loop and @mariozechner/pi-ai for unified LLM streaming. Key types re-exported from pi packages: AgentMessage, AgentTool, AgentEvent, Model, StreamFn.

- Agent class (from pi-agent-core): state management, `subscribe()` for events, `prompt()` for messages, `abort()` to stop
- tool-adapter.ts: wraps legacy ToolDefinition into AgentTool (pi-compatible execute signature)
- types.ts: self-contained type definitions (ToolDefinition, ToolResult, AgentConfig, SessionData)

### UI (src/ui/)
Vanilla TypeScript, no framework. Two layout modes selected by `isExtension` detection:
- **Extension mode**: Tabbed interface (Chat/Terminal/Files tabs) with context-sensitive header buttons per tab. Full-height single panel.
- **Standalone mode**: Resizable three-panel split: chat (left), terminal (top-right), file browser (bottom-right).

main.ts bootstraps everything and contains the event adapter that maps core AgentEvent to UI AgentEvent. Message IDs use session-unique prefixes to prevent collision after side panel close/reopen. Assistant label is "sliccy".

File browser supports clicking files to download and a ZIP button on folders (uses fflate) to download entire directories.

Two separate IndexedDB session stores: UI-level (browser-coding-agent DB in session-store.ts) and core agent-level (agent-sessions DB in core/session.ts).

### Extension (src/extension/)
Chrome Manifest V3 extension files. Service worker opens the side panel on action click. `chrome.d.ts` provides minimal typed declarations for the Chrome APIs used (debugger, tabs, sidePanel, runtime). `sandbox.html` (project root) provides an isolated execution environment for the JavaScript tool — exempt from extension CSP, allows Function constructor. Cross-origin fetch from sandbox is proxied through the parent page via postMessage.

### CLI Server (src/cli/index.ts)
Express server that launches Chrome with remote debugging, serves the UI (Vite middleware in dev, static files in prod), and runs a WebSocket proxy at /cdp. Provides `/api/fetch-proxy` endpoint for cross-origin fetch (replaces CORS proxy). Single shared Chrome WebSocket connection with client message buffering. Console forwarder pipes in-page console output to CLI stdout.

### Context Compaction (src/ui/main.ts)
To prevent context overflow (200K token limit), the agent applies two-phase message compaction before each API call:
1. **Result truncation**: Tool results larger than 8000 chars (~2K tokens) are truncated with a marker
2. **Message dropping**: If total context exceeds ~150K tokens, old messages (except first 2 and last 10) are dropped and replaced with a compaction marker message

This preserves recent context and the initial exchange while preventing runaway token usage.

### Data Flow
```
User -> ChatPanel -> Agent.prompt() -> pi-agent-core loop -> Anthropic API (streaming)
  -> AssistantMessageEvent stream -> Agent state -> event adapter -> ChatPanel DOM
  -> Tool calls -> VirtualFS / WasmShell / BrowserAPI -> results -> back to agent loop
```

## Key Conventions

- **Two type systems**: Legacy ToolDefinition/ToolResult (in src/tools/) and pi-compatible AgentTool/AgentToolResult (in src/core/). The adapter in tool-adapter.ts bridges them.
- **Tests are colocated**: foo.test.ts next to foo.ts. Vitest with globals: true, environment: node. New pure-logic code (utilities, adapters, data transformations) should always have tests. DOM-dependent code (UI panels, layout) and chrome.* API code (DebuggerClient) are acceptable to skip in Node tests but should be manually verified. Use `fake-indexeddb/auto` for tests that need VFS. Current count: 242 tests across 19 files.
- **Logging**: createLogger('namespace') from src/core/logger.ts. Level-filtered, DEBUG in dev, ERROR in prod. Uses __DEV__ global (set by Vite define).
- **Node shims**: src/shims/empty.ts stubs out node:zlib and node:module for the browser bundle (just-bash references them).
- **Multi-provider auth**: API key stored in localStorage. Provider selector supports Anthropic (direct), Azure AI Foundry, and AWS Bedrock. Provider/resource/region stored in localStorage. Model resolved via `getModel()` from pi-ai with baseUrl override for Azure/Bedrock.
- **Extension detection**: `typeof chrome !== 'undefined' && !!chrome?.runtime?.id` — used throughout to select CDP transport, layout mode, fetch strategy, and JS tool sandbox mechanism.

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
