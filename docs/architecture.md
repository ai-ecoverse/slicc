# Architecture

## Layer Stack Table

| Layer | Directory | Responsibility | Key File | Test File |
|---|---|---|---|---|
| Shims | `src/shims/` | Node.js polyfills for browser bundle | `empty.ts`, `buffer-polyfill.ts` | N/A |
| Virtual Filesystem | `src/fs/` | POSIX-like FS (LightningFS/IndexedDB) | `virtual-fs.ts` | `virtual-fs.test.ts` |
| Shell | `src/shell/` | just-bash WASM + xterm terminal | `wasm-shell.ts` | `wasm-shell.test.ts` |
| Git | `src/git/` | isomorphic-git wrapper | `git-commands.ts` | N/A |
| Skills | `src/skills/` | Skill package manager | `apply.ts` | N/A |
| CDP | `src/cdp/` | Chrome DevTools Protocol | `browser-api.ts` | `browser-api.test.ts` |
| Tools | `src/tools/` | Agent tools (bash, file, browser, javascript, search) | `bash-tool.ts` | `bash-tool.test.ts` |
| Core Agent | `src/core/` | pi-mono agent loop + streaming | `index.ts` | `agent.test.ts` |
| Scoops Orchestrator | `src/scoops/` | Multi-agent system (cone + scoops) | `orchestrator.ts` | N/A |
| UI | `src/ui/` | Chat, Terminal, Files, Memory panels | `main.ts` | `types.test.ts` |
| CLI Server | `src/cli/` | Express server + Chrome launcher | `index.ts` | N/A |
| Extension | `src/extension/` | Chrome Manifest V3 entry point | `service-worker.ts` | N/A |
| Providers | `src/providers/` | Custom API provider integrations | `bedrock-camp.ts` | N/A |

## Source File Tree

### src/cdp/ — Chrome DevTools Protocol

| File | Purpose |
|---|---|
| `browser-api.ts` | High-level Playwright-inspired API (listPages, navigate, screenshot, evaluate, click, type, waitForSelector, getAccessibilityTree) |
| `cdp-client.ts` | WebSocket-based CDP client (CLI mode, connects to `ws://localhost:3000/cdp`) |
| `debugger-client.ts` | Chrome debugger API client (extension mode, uses `chrome.debugger`) |
| `har-recorder.ts` | HAR 1.2 recorder for network traffic; saves snapshots to VFS on navigation |
| `transport.ts` | CDPTransport interface (abstracts CDP/debugger implementations) |
| `index.ts` | Re-exports + auto-selects transport based on extension detection |
| `types.ts` | TargetInfo, PageInfo, EvaluateOptions, AccessibilityNode, etc. |

### src/cli/ — Standalone CLI Server

| File | Purpose |
|---|---|
| `index.ts` | Express server (port 3000): launches Chrome with CDP, serves UI, proxies WebSocket to CDP, provides `/api/fetch-proxy` for CORS |

### src/core/ — Agent Core

| File | Purpose |
|---|---|
| `index.ts` | Re-exports from pi-mono (Agent, AgentTool, AgentEvent, streaming, model utilities) |
| `types.ts` | Legacy ToolDefinition, ToolResult, AgentConfig, SessionData |
| `tool-adapter.ts` | Wraps legacy ToolDefinition as pi-compatible AgentTool |
| `tool-registry.ts` | Registry of active tools with lookup by name |
| `context-compaction.ts` | Truncates oversized results + drops old messages to stay under 200K token limit |
| `logger.ts` | createLogger factory with level filtering (DEBUG dev, ERROR prod) |
| `session.ts` | IndexedDB session storage (`agent-sessions` DB) |
| `mime-types.ts` | MIME type mappings (html, css, js, json, image, etc.) |

### src/extension/ — Chrome Extension

| File | Purpose |
|---|---|
| `service-worker.ts` | Manifest V3 service worker; opens side panel on action click |
| `chrome.d.ts` | Minimal typed declarations for chrome.debugger, chrome.tabs, chrome.sidePanel, etc. |

### src/fs/ — Virtual Filesystem

| File | Purpose |
|---|---|
| `virtual-fs.ts` | POSIX-like FS facade wrapping LightningFS (IndexedDB); all paths absolute/normalized |
| `restricted-fs.ts` | RestrictedFS wrapper with path ACL (enforces scoop sandboxes: `/scoops/{name}/` + `/shared/`) |
| `types.ts` | FsError (POSIX codes), DirEntry, Stats, read/write/mkdir options |
| `path-utils.ts` | normalizePath, splitPath, relativePath utilities |
| `mount-commands.ts` | `mount` command for File System Access API |
| `index.ts` | Re-exports |

### src/git/ — Git Integration

| File | Purpose |
|---|---|
| `git-commands.ts` | CLI-like interface for isomorphic-git (init, clone, add, commit, status, log, branch, checkout, diff, remote, fetch, pull, push, config, rev-parse) |
| `git-http.ts` | CORS proxy integration for git HTTP operations (CLI mode: `/api/fetch-proxy`, extension mode: direct fetch) |
| `diff.ts` | Unified diff + stat formatting utilities |
| `index.ts` | GitCommands factory |

### src/providers/ — API Providers

| File | Purpose |
|---|---|
| `bedrock-camp.ts` | AWS Bedrock provider integration (registers with pi-ai) |

### src/shell/ — Shell & Terminal

| File | Purpose |
|---|---|
| `wasm-shell.ts` | WasmShell class; just-bash interpreter + xterm.js terminal + command registration (VfsAdapter bridges to VirtualFS) |
| `index.ts` | Re-exports |
| `vfs-adapter.ts` | Implements just-bash IFileSystem interface, bridges just-bash ↔ VirtualFS |
| `binary-cache.ts` | Caches binary responses (Uint8Array) to preserve byte fidelity through VFS writes |
| `jsh-discovery.ts` | Scans VFS for `*.jsh` files; returns `Map<name, path>` with priority roots (`/workspace/skills/`) scanned first |
| `jsh-executor.ts` | Executes `.jsh` files with Node-like globals (process, console, fs bridge); dual-mode (AsyncFunction CLI, sandbox iframe extension) |
| `parse-shell-args.ts` | Shell-like argument parser (double/single quotes, backslash escapes) |
| `supplemental-commands.ts` | Re-exports all supplemental command factories |

### src/shell/supplemental-commands/ — Custom Shell Commands

| File | Purpose |
|---|---|
| `index.ts` | Factory for all supplemental commands |
| `help-command.ts` | `commands` — list all available commands |
| `convert-command.ts` | `convert` — ImageMagick-style image processing (resize, rotate, crop, quality) via magick-wasm |
| `crontask-command.ts` | `crontask` — schedule cron jobs (dispatches licks to scoops); backed by node-cron |
| `imgcat-command.ts` | `imgcat` — display images inline in terminal |
| `node-command.ts` | `node -e` — execute JavaScript (CLI: AsyncFunction, extension: sandbox iframe) |
| `open-command.ts` | `open <url>` — open URL in new browser tab or download file |
| `pdftk-command.ts` | `pdftk` — PDF manipulation (concat, split, rotate, burst, etc.) |
| `python-command.ts` | `python3/python -c` — execute Python via Pyodide (~13MB bundled, loaded from `chrome.runtime.getURL('pyodide/')`) |
| `shared.ts` | NodeExitError, nodeRuntimeState, formatConsoleArg utilities |
| `sqlite-command.ts` | `sqlite3` — SQLite database operations (in-memory or VFS-backed) |
| `unzip-command.ts` | `unzip` — extract archives |
| `upskill-command.ts` | `upskill` — install skills from GitHub/ClawHub |
| `webhook-command.ts` | `webhook` — manage webhooks for event-driven automation |
| `which-command.ts` | `which` — resolve command to path (built-ins: `/usr/bin/<name>`, `.jsh` scripts: actual VFS path) |
| `zip-command.ts` | `zip` — create archives |

### src/skills/ — Skill Package Manager

| File | Purpose |
|---|---|
| `apply.ts` | applySkill: installs a skill from `/workspace/skills/`, validates manifest, executes post-install steps |
| `discover.ts` | discoverSkills: scans VFS for `SKILL.md` files; getSkillInfo: fetch skill metadata; readSkillInstructions: load skill instructions |
| `uninstall.ts` | uninstallSkill: removes skill from state, rolls back installed files |
| `state.ts` | initSkillsSystem: init `.slicc/state.json`; readState/writeState: persistent skill state |
| `manifest.ts` | parseManifest: YAML parser for `manifest.yaml` (name, version, dependencies, conflicts, files) |
| `constants.ts` | SKILL_DIR, STATE_FILE, SKILL_MANIFEST constants |
| `types.ts` | Skill, SkillManifest, AppliedSkill, SkillState interfaces |
| `index.ts` | Re-exports |

### src/scoops/ — Multi-Agent Orchestration

| File | Purpose |
|---|---|
| `orchestrator.ts` | Manages scoop contexts, routes messages, handles responses, owns shared VirtualFS |
| `scoop-context.ts` | Per-scoop agent instance (RestrictedFS, WasmShell, Agent, skills, NanoClaw tools) |
| `nanoclaw-tools.ts` | Scoop tools: `send_message`; cone-only tools: `list_scoops`, `scoop_scoop`, `feed_scoop`, `drop_scoop`, `update_global_memory` |
| `db.ts` | IndexedDB (`slicc-groups` DB v3): scoops, messages, sessions, tasks, state, webhooks, crontasks stores |
| `lick-manager.ts` | Browser-side lick management (webhooks + crontasks); all state in IndexedDB |
| `scheduler.ts` | TaskScheduler for internal task scheduling (used by orchestrator) |
| `heartbeat.ts` | Heartbeat monitoring (detects when scoop contexts are idle) |
| `skills.ts` | loadSkills, formatSkillsForPrompt: load SKILL.md files into agent system prompt; createDefaultSkills: bundled defaults |
| `types.ts` | RegisteredScoop, ChannelMessage, ScoopTabState, ScheduledTask, WebhookEntry, CronTaskEntry |
| `index.ts` | Re-exports |

### src/tools/ — Agent Tools

| File | Purpose |
|---|---|
| `bash-tool.ts` | `bash` tool: execute shell commands via WasmShell |
| `file-tools.ts` | `read_file`, `write_file`, `edit_file` tools for VirtualFS operations |
| `browser-tool.ts` | `browser` tool with sub-actions: list_tabs, navigate, screenshot, evaluate, click, type, serve, show_image, record_network |
| `javascript-tool.ts` | `javascript` tool: execute JS in the browser context (fs.readDir, fs.readFile, fs.readFileBinary access) |
| `search-tools.ts` | `grep` and `find` tools: content search and file pattern matching |
| `index.ts` | Tool factory functions (createBashTool, createFileTools, createBrowserTool, etc.) |

### src/ui/ — User Interface

| File | Purpose |
|---|---|
| `main.ts` | Entry point: initializes layout, checks API key, bootstraps orchestrator, wires events |
| `layout.ts` | Split-pane (CLI) or tabbed (extension) layout; auto-selects based on extension detection |
| `chat-panel.ts` | Message list + input with streaming support; connects to AgentHandle |
| `terminal-panel.ts` | xterm.js terminal UI; exposes WasmShell output |
| `file-browser-panel.ts` | File tree browser; download files/ZIP folders; navigate filesystem |
| `memory-panel.ts` | Global memory editor (IndexedDB-backed; shared across all scoops) |
| `scoops-panel.ts` | Scoop list (CLI mode left sidebar); create/delete/view scoops |
| `scoop-switcher.ts` | Dropdown menu for scoop selection (extension mode) |
| `message-renderer.ts` | Renders user messages, assistant messages, tool calls, tool results as HTML |
| `chat-panel.ts` | Message list + input; voice input support (Web Speech API) |
| `voice-input.ts` | Voice mode toggle; auto-sends on 2.5s silence; falls back to popup in extension mode |
| `preview-sw.ts` | Service Worker that intercepts `/preview/*` and serves VFS content (enables in-browser app previews) |
| `session-store.ts` | IndexedDB session storage (`browser-coding-agent` DB): conversation history per session |
| `provider-settings.ts` | API provider + model selection; stores settings in localStorage |
| `api-key-dialog.ts` | Dialog for entering API keys |
| `theme.ts` | Theme toggle (System/Light/Dark) |
| `types.ts` | AgentHandle, AgentEvent, ChatMessage, ToolCall, UIMessage interfaces |
| `index.ts` | Re-exports |

### src/shims/ — Node.js Polyfills

| File | Purpose |
|---|---|
| `empty.ts` | Stubs out node:zlib and node:module (just-bash references these) |
| `buffer-polyfill.ts` | Polyfills Buffer for browser (isomorphic-git requirement) |
| `http.ts`, `http2.ts`, `https.ts`, `stream.ts` | Node module stubs (imported by dependencies, no-op in browser) |

### src/ — Root

| File | Purpose |
|---|---|
| `globals.d.ts` | TypeScript globals (\_\_DEV\_\_, etc.) |

## Build Targets Table

| Target | tsconfig | Input | Output | Module Resolution |
|---|---|---|---|---|
| Browser bundle | `tsconfig.json` | `src/` except `src/cli/` | `dist/ui/` (via Vite) | bundler |
| CLI server | `tsconfig.cli.json` | `src/cli/` | `dist/cli/` (via TSC) | NodeNext |
| Extension | `vite.config.extension.ts` | Browser bundle + extension entries | `dist/extension/` | bundler |

### Special Build Artifacts

- **preview-sw.ts**: Built as standalone IIFE via esbuild (not rollup). Dev: Vite plugin bundles on-the-fly. Prod: `closeBundle` hook writes bundle.
- **Extension assets**: Pyodide (~13MB), ImageMagick WASM, `sandbox.html`, `voice-popup.html` copied to `dist/extension/` by `vite.config.extension.ts`.
- **Node shims**: `src/shims/` provide no-op implementations for Node modules (just-bash references them).

## Data Flow Diagrams

### User Message Flow

```
User input in chat → ChatPanel.sendMessage()
  → Orchestrator.handleMessage()
    → routeToScoop() [determines cone or specific scoop]
    → processScoopQueue()
      → ScoopContext.prompt()
        → pi-agent-core loop
          → LLM API call (streaming)
            → AgentEvent stream
              → Orchestrator callbacks
                → per-scoop message buffer
                  → emitToUI() [if scoop is selected]
                    → ChatPanel DOM update (streaming)
      → Tool calls [bash, file, browser, javascript, etc.]
        → RestrictedFS / WasmShell / BrowserAPI
          → results
          → back to agent loop
    → Scoop completes
      → Orchestrator notification
        → Cone's message queue
        → Cone processes completion
```

### Scoop Delegation

```
Cone executes feed_scoop tool
  → Orchestrator.delegateToScoop()
    → ScoopContext.prompt() [receives full context from cone]
      → pi-agent-core loop
        → Tool calls
        → Scoop processes independently
    → Scoop completes
      → Orchestrator notification
        → Cone's message queue
        → Cone receives result
```

### Lick (Event) Flow

```
External webhook POST / scheduled cron task fires
  → LickManager receives event in IndexedDB
    → dispatch() routes to target scoop
      → ScoopContext processes lick
        → Agent reacts to event
        → No human in the loop
```

### Agent Session Persistence

Agent conversation history is persisted per scoop, enabling agents to resume where they left off across page reloads or extension close-reopen cycles.

```
ScoopContext init (page load / scoop creation)
  → SessionStore.load(scoop.jid) [retrieves AgentMessage[] from agent-sessions DB]
    → Agent initialized with restored messages
      → agent loop resumes with full context

Agent responds (streaming)
  → agent_end event
    → SessionStore.save(scoop.jid, allMessages) [fire-and-forget]
      → Persists updated AgentMessage[] to agent-sessions DB

Scoop removal / app clear
  → Orchestrator calls SessionStore.delete(jid) or SessionStore.clearAll()
    → Clears persisted session data
```

**Session Storage:**
- Database: `agent-sessions` (IndexedDB)
- Key: scoop JID (e.g., `cone`, `analysis-scoop`)
- Value: `AgentMessage[]` (agent loop message history)
- Lifecycle: Loaded on scoop init, saved on agent_end (error-tolerant), deleted on scoop removal
- Design: Messages are model-agnostic and work with any LLM. `compactContext` trims at prompt time (existing mechanism), so large sessions don't cause token bloat.

## IndexedDB Databases

| Database | Version | Stores | Purpose |
|---|---|---|---|
| `slicc-fs` | 1 | (VirtualFS data) | POSIX filesystem backing store (LightningFS) |
| `browser-coding-agent` | 1 | sessions, settings | UI-level session history + localStorage mirror |
| `slicc-groups` | 3 | scoops, messages, sessions, tasks, state, webhooks, crontasks | Orchestrator data (scoops, messages, tasks) |
| `agent-sessions` | 1 | sessions | Core agent session history: persisted `AgentMessage[]` per scoop, keyed by JID; loaded on scoop init, saved on agent_end |
| `slicc-fs-global` | 1 | config | Git global config storage |

## File-Finding Guide

### Virtual Filesystem Changes

| I need to... | Modify |
|---|---|
| Add a POSIX filesystem method | `src/fs/virtual-fs.ts` |
| Change path normalization logic | `src/fs/path-utils.ts` |
| Restrict file access by path (scoops) | `src/fs/restricted-fs.ts` |
| Change file types/interfaces | `src/fs/types.ts` |

### Shell & Terminal Changes

| I need to... | Modify |
|---|---|
| Add a bash command | `src/shell/supplemental-commands/<name>-command.ts` + register in `index.ts` |
| Change terminal behavior (xterm) | `src/shell/wasm-shell.ts` |
| Change binary handling | `src/shell/binary-cache.ts` |
| Support new `.jsh` script globals | `src/shell/jsh-executor.ts` |
| Change shell argument parsing | `src/shell/parse-shell-args.ts` |

### Git Integration

| I need to... | Modify |
|---|---|
| Add a git command | `src/git/git-commands.ts` |
| Change CORS proxy handling | `src/git/git-http.ts` |
| Add diff formatting | `src/git/diff.ts` |

### Browser Automation (CDP)

| I need to... | Modify |
|---|---|
| Add a browser action (screenshot, click, etc.) | `src/cdp/browser-api.ts` |
| Change CDP transport (CLI vs extension) | `src/cdp/transport.ts`, `cdp-client.ts`, `debugger-client.ts` |
| Add HAR recording features | `src/cdp/har-recorder.ts` |
| Change target/page types | `src/cdp/types.ts` |

### Agent Tools

| I need to... | Modify |
|---|---|
| Add a new agent tool | `src/tools/<name>-tool.ts` + register in `index.ts` |
| Change bash tool behavior | `src/tools/bash-tool.ts` |
| Change file tool behavior | `src/tools/file-tools.ts` |
| Change browser tool actions | `src/tools/browser-tool.ts` |
| Change tool input/output format | `src/core/types.ts` (ToolDefinition, ToolResult) |
| Adapt tools to pi-agent-core | `src/core/tool-adapter.ts` |

### Core Agent & Streaming

| I need to... | Modify |
|---|---|
| Change token limit / context compaction strategy | `src/core/context-compaction.ts` |
| Change logging format/level | `src/core/logger.ts` |
| Change agent conversation history persistence | `src/core/session.ts` (SessionStore: load/save/delete/clearAll per-scoop `AgentMessage[]` in `agent-sessions` DB) + `src/scoops/scoop-context.ts` (restore on init, save on agent_end) + `src/scoops/orchestrator.ts` (create/pass/cleanup SessionStore) |
| Change MIME type detection | `src/core/mime-types.ts` |
| Register new tools | `src/core/tool-registry.ts` |

### Multi-Agent System

| I need to... | Modify |
|---|---|
| Manage scoops (create/delete/list) | `src/scoops/orchestrator.ts` |
| Persist/restore scoop conversation history | `src/scoops/orchestrator.ts` (creates SessionStore, passes to ScoopContext, cleans up on unregister/clear) |
| Change scoop isolation/filesystem | `src/scoops/scoop-context.ts` |
| Add NanoClaw tools (messaging, scoop management) | `src/scoops/nanoclaw-tools.ts` |
| Change scoop database schema | `src/scoops/db.ts` |
| Manage webhooks/crontasks | `src/scoops/lick-manager.ts` |
| Change skill loading | `src/scoops/skills.ts` |
| Change types (RegisteredScoop, etc.) | `src/scoops/types.ts` |

### UI & Layout

| I need to... | Modify |
|---|---|
| Add a new UI panel | `src/ui/<panel>-panel.ts` + integrate in `layout.ts` + `main.ts` |
| Change layout (split vs tabbed) | `src/ui/layout.ts` |
| Change message rendering (HTML format) | `src/ui/message-renderer.ts` |
| Add voice input features | `src/ui/voice-input.ts` |
| Change preview service worker | `src/ui/preview-sw.ts` |
| Change provider/model selection | `src/ui/provider-settings.ts` |
| Change theme handling | `src/ui/theme.ts` |
| Change session storage | `src/ui/session-store.ts` |

### CLI Server

| I need to... | Modify |
|---|---|
| Add an API endpoint | `src/cli/index.ts` |
| Change Chrome launch options | `src/cli/index.ts` |
| Change WebSocket proxy behavior | `src/cli/index.ts` |
| Change request logging | `src/cli/index.ts` |

### Extension Manifest

| I need to... | Modify |
|---|---|
| Change extension behavior | `src/extension/service-worker.ts` |
| Add Chrome API types | `src/extension/chrome.d.ts` |
| Build extension | `vite.config.extension.ts` |

### Skills & Package Management

| I need to... | Modify |
|---|---|
| Change skill installation logic | `src/skills/apply.ts` |
| Change skill discovery | `src/skills/discover.ts` |
| Change skill uninstall logic | `src/skills/uninstall.ts` |
| Change skill state persistence | `src/skills/state.ts` |
| Change manifest parsing | `src/skills/manifest.ts` |

### Providers

| I need to... | Modify |
|---|---|
| Add a new API provider (Bedrock, Azure, etc.) | `src/providers/<provider>-camp.ts` + import in `src/ui/main.ts` |
