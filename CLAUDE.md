# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build and Development Commands

```bash
npm run dev:full        # Full dev mode: Vite HMR + Chrome + CDP proxy (port 3000)
npm run dev             # Vite dev server only (no Chrome/CDP)
npm run build           # Production build (UI via Vite + CLI via TSC)
npm run build:ui        # Vite build only into dist/ui/
npm run build:cli       # TSC build only into dist/cli/
npm run typecheck       # Typecheck both tsconfig targets
npm run start           # Run production CLI (requires build first)

npm run test            # Vitest run (all tests)
npm run test:watch      # Vitest watch mode
npx vitest run src/fs/virtual-fs.test.ts  # Run a single test file
```

Ports: 3000 (UI server), 9222 (Chrome CDP), 24679 (Vite HMR WebSocket)

## Architecture

Browser-based AI coding agent: a self-contained development environment where Claude writes code, runs shell commands, and automates browser tabs entirely within Chrome, without touching the host filesystem.

### Two Build Targets

- **Browser bundle** (tsconfig.json): Everything in src/ except src/cli/. Bundled by Vite, module resolution: bundler. Runs in Chrome.
- **CLI server** (tsconfig.cli.json): Only src/cli/. Compiled by TSC to dist/cli/, module resolution: NodeNext. Runs in Node.

### Layer Stack (bottom-up)

Virtual Filesystem (src/fs/) -> Shell (src/shell/) -> CDP (src/cdp/) -> Tools (src/tools/) -> Core Agent (src/core/) -> UI (src/ui/) -> CLI Server (src/cli/)

### Virtual Filesystem (src/fs/)
POSIX-like async filesystem backed by OPFS (preferred) or IndexedDB (fallback). VirtualFS is the facade; StorageBackend is the interface both backends implement. FsError carries POSIX error codes (ENOENT, EISDIR, etc.). All paths are absolute, forward-slash, normalized.

### Shell (src/shell/)
WasmShell wraps just-bash (WASM Bash interpreter) and connects it to VirtualFS via VfsAdapter (implements just-bash's IFileSystem). The shell maintains env/cwd state across calls. Terminal UI via xterm.js with dynamic imports (so tests run in Node without xterm).

### CDP (src/cdp/)
CDPClient: low-level WebSocket protocol (send/on/off/once with pending-command tracking). BrowserAPI: high-level Playwright-style API built on CDPClient (listPages, navigate, screenshot, evaluate, click, type, waitForSelector, getAccessibilityTree). Connects through the CLI's WebSocket proxy at ws://localhost:3000/cdp.

### Tools (src/tools/)
All tools use the legacy ToolDefinition interface (name, description, inputSchema, execute). Six tools: bash, read_file, write_file, edit_file, grep, find, browser (with sub-actions). Factory functions take their dependency (VirtualFS, WasmShell, or BrowserAPI).

### Core Agent (src/core/)
Ported from pi-mono (@mariozechner/pi-ai). Key types: AgentMessage (union of User/Assistant/ToolResult), AgentTool (pi-compatible execute signature), AgentEvent (fine-grained streaming events).

- Agent class: state management, event listeners, session persistence, sendMessage/prompt/steer/followUp API
- agent-loop.ts: outer loop (follow-up messages) wrapping inner loop (tool calls + steering interruptions)
- stream.ts: bridges Anthropic SDK streaming to AssistantMessageEventStream with retry on 529 (overloaded). Runs browser-side with dangerouslyAllowBrowser
- event-stream.ts: generic async-iterable push-pull queue with result promise
- tool-adapter.ts: wraps legacy ToolDefinition into AgentTool

### UI (src/ui/)
Vanilla TypeScript, no framework. Layout creates a resizable three-panel split: chat (left), terminal (top-right), browser preview (bottom-right). main.ts bootstraps everything and contains the event adapter that maps core AgentEvent to UI AgentEvent.

Two separate IndexedDB session stores: UI-level (browser-coding-agent DB in session-store.ts) and core agent-level (agent-sessions DB in core/session.ts).

### CLI Server (src/cli/index.ts)
Express server that launches Chrome with remote debugging, serves the UI (Vite middleware in dev, static files in prod), and runs a WebSocket proxy at /cdp. Single shared Chrome WebSocket connection with client message buffering. Console forwarder pipes in-page console output to CLI stdout.

### Data Flow
```
User -> ChatPanel -> Agent.sendMessage() -> agentLoop() -> Anthropic API (streaming)
  -> AssistantMessageEvent stream -> Agent state -> event adapter -> ChatPanel DOM
  -> Tool calls -> VirtualFS / WasmShell / BrowserAPI -> results -> back to agent loop
```

## Key Conventions

- **Two type systems**: Legacy ToolDefinition/ToolResult (in src/tools/) and pi-compatible AgentTool/AgentToolResult (in src/core/). The adapter in tool-adapter.ts bridges them.
- **Tests are colocated**: foo.test.ts next to foo.ts. Vitest with globals: true, environment: node.
- **Logging**: createLogger('namespace') from src/core/logger.ts. Level-filtered, DEBUG in dev, ERROR in prod. Uses __DEV__ global (set by Vite define).
- **Node shims**: src/shims/empty.ts stubs out node:zlib and node:module for the browser bundle (just-bash references them).
- **Anthropic SDK**: API key stored in localStorage. Singleton client cached in stream.ts, recreated when key changes.
