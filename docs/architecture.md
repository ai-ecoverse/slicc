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
| Tools | `src/tools/` | Tool factories; active scoop surface is file + bash + javascript | `bash-tool.ts` | `bash-tool.test.ts` |
| Core Agent | `src/core/` | pi-mono agent loop + streaming | `index.ts` | `agent.test.ts` |
| Scoops Orchestrator | `src/scoops/` | Multi-agent system (cone + scoops) | `orchestrator.ts` | N/A |
| UI | `src/ui/` | Chat, Terminal, Files, Memory panels | `main.ts` | `types.test.ts` |
| CLI / Electron Node Runtime | `packages/node-server/src/` | Express server, Chrome launcher, Electron float entrypoint | `index.ts` | `electron-runtime.test.ts` |
| Extension | `src/extension/` | Chrome Manifest V3 entry point | `service-worker.ts` | N/A |
| Cloud Tray Hub | `packages/cloudflare-worker/src/` | Cloudflare Worker + Durable Object control-plane skeleton + deployed smoke test | `index.ts` | `packages/cloudflare-worker/tests/index.test.ts`, `packages/cloudflare-worker/tests/deployed.test.ts` |
| Providers | `src/providers/` | Provider types, OAuth service, auto-discovery, build-time filtering | `types.ts`, `oauth-service.ts`, `index.ts` | `index.test.ts`, `oauth-service.test.ts` |
| Sprinkles | `src/ui/sprinkle-*.ts` | Composable `.shtml` panels: discovery, rendering, bridge API, picker UI | `sprinkle-manager.ts` | `sprinkle-manager.test.ts` |
| Defaults | `packages/vfs-root/` | Bundled VFS content: agent instructions, skills, sprinkles | N/A | N/A |
| Types | `src/types/` | Type declarations for external submodules | `pi-coding-agent-compaction.d.ts` | N/A |

## Source File Tree

### src/cdp/ — Chrome DevTools Protocol

| File | Purpose |
|---|---|
| `browser-api.ts` | High-level Playwright-inspired API (listPages, navigate, screenshot, evaluate, click, type, waitForSelector, getAccessibilityTree); used by the `playwright-cli` shell command path and related browser automation commands |
| `cdp-client.ts` | WebSocket-based CDP client (CLI mode, connects to `ws://localhost:5710/cdp`) |
| `debugger-client.ts` | Chrome debugger API client (extension mode, uses `chrome.debugger`); adds agent-created tabs to "slicc" tab group |
| `har-recorder.ts` | HAR 1.2 recorder for network traffic; saves snapshots to VFS on navigation |
| `transport.ts` | CDPTransport interface (abstracts CDP/debugger implementations) |
| `normalize-accessibility-text.ts` | Accessibility tree text normalization utilities |
| `index.ts` | Re-exports + auto-selects transport based on extension detection |
| `types.ts` | TargetInfo, PageInfo, EvaluateOptions, AccessibilityNode, etc. |
| `offscreen-cdp-proxy.ts` | CDPTransport over chrome.runtime messages (offscreen → service worker → chrome.debugger) |
| `panel-cdp-proxy.ts` | CDPTransport for side panel terminal (panel → offscreen → service worker → chrome.debugger) |

### packages/node-server/src/ — CLI + Electron Runtimes

| File | Purpose |
|---|---|
| `index.ts` | Main CLI entrypoint: launches Chrome by default, or in `--electron` mode launches/relaunches a target Electron app, serves UI, proxies WebSocket CDP traffic, and provides `/api/fetch-proxy` for CORS |
| `runtime-flags.ts` | Shared CLI/runtime flag parsing for `--dev`, `--serve-only`, `--cdp-port`, `--electron`, `--electron-app`, `--profile`, `--lead`, `--join`, `--log-level`, `--log-dir`, and `--kill` |
| `chrome-launch.ts` | Chrome/Chrome-for-Testing discovery, QA profile resolution, launch-arg construction, and `.qa/chrome/*` scaffold seeding |
| `qa-setup.ts` | CLI helper for `npm run qa:setup`; validates Chrome + `dist/extension` and scaffolds the dedicated QA Chrome profiles |
| `electron-main.ts` | Electron process entry point: spawns CLI server in `--serve-only` mode, creates BrowserWindow, injects overlay, strips host-page CSP |
| `electron-runtime.ts` | Pure Electron helpers for target app path resolution, overlay URLs/bootstrap scripts, dist paths, and injectable-target filtering |
| `electron-controller.ts` | Electron app lifecycle management: detect running app processes, enforce `--kill`, launch with remote debugging, and inject/reinject the overlay across navigations |

### src/core/ — Agent Core

| File | Purpose |
|---|---|
| `index.ts` | Re-exports from pi-mono (Agent, AgentTool, AgentEvent, streaming, model utilities) |
| `types.ts` | Legacy ToolDefinition, ToolResult, AgentConfig, SessionData |
| `tool-adapter.ts` | Wraps legacy ToolDefinition as pi-compatible AgentTool |
| `tool-registry.ts` | Registry of active tools with lookup by name |
| `context-compaction.ts` | LLM-summarized context compaction (pi-mono aligned) with naive-drop fallback |
| `image-processor.ts` | Image validation and preprocessing; checks base64 size (5MB), dimensions (8000px max, 1568px optimal), and format before agent processing. Parses PNG/GIF/JPEG headers for dimensions without full decode. Resizes via ImageMagick WASM |
| `logger.ts` | createLogger factory with level filtering (DEBUG dev, ERROR prod) |
| `session.ts` | IndexedDB session storage (`agent-sessions` DB) |
| `mime-types.ts` | MIME type mappings (html, css, js, json, image, etc.) |

### src/extension/ — Chrome Extension

| File | Purpose |
|---|---|
| `service-worker.ts` | Manifest V3 service worker; message relay between panel and offscreen + CDP proxy via chrome.debugger + tab grouping |
| `offscreen.ts` | Agent engine bootstrap in offscreen document (Orchestrator, VFS, Shell, tools) |
| `offscreen-bridge.ts` | Orchestrator ↔ chrome.runtime message bridge; persists chat to `browser-coding-agent` IndexedDB |
| `lick-manager-proxy.ts` | BroadcastChannel proxy enabling side panel terminal to manage cron tasks via LickManager running in offscreen |
| `messages.ts` | Typed message envelopes: PanelToOffscreen, OffscreenToPanel, CdpProxy |
| `tab-group.ts` | Shared tab grouping helper; adds agent-created tabs to a persistent "slicc" Chrome tab group (used by service worker + debugger client) |
| `chrome.d.ts` | Typed declarations for chrome.debugger, chrome.tabs, chrome.tabGroups, chrome.sidePanel, chrome.offscreen, etc. |
| `sprinkle-proxy.ts` | Lightweight proxy relaying sprinkle operations from offscreen document to side panel UI via chrome.runtime messaging |

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
| `types.ts` | `ProviderConfig` interface (id, name, isOAuth, onOAuthLogin, onOAuthLogout, getModelIds, modelOverrides), `ModelMetadata` interface (api, context_window, max_tokens, reasoning, input — snake_case wire format), `OAuthLauncher` type |
| `index.ts` | Provider auto-discovery: pi-ai providers filtered by `packages/dev-tools/providers.build.json`, built-in extensions via glob, external `/packages/webapp/providers/*.ts` always included |
| `oauth-service.ts` | Generic `OAuthLauncher` factory: CLI mode (popup → `/auth/callback` → postMessage) and extension mode (service worker → `chrome.identity.launchWebAuthFlow`) |
| `built-in/bedrock-camp.ts` | AWS Bedrock CAMP provider — custom stream function via `register()` (only built-in that needs a file; pure-config providers use pi-ai auto-discovery) |
| `built-in/azure-ai-foundry.ts` | Azure AI Foundry provider configuration (Claude on Azure) |

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
| `open-command.ts` | `open <path\|url>` — serve VFS files via preview SW or open URLs in browser tab; `--download` / `-d` forces download; `--view` / `-v` returns image inline for agent vision |
| `pdftk-command.ts` | `pdftk` — PDF manipulation (concat, split, rotate, burst, etc.) |
| `python-command.ts` | `python3/python -c` — execute Python via Pyodide (~13MB bundled, loaded from `chrome.runtime.getURL('pyodide/')`) |
| `shared.ts` | Shared utilities: `toPreviewUrl()` (dual-mode preview SW URL), `isLikelyUrl()`, `basename()`, `dirname()`, NodeExitError, nodeRuntimeState, formatConsoleArg |
| `sqlite-command.ts` | `sqlite3` — SQLite database operations (in-memory or VFS-backed) |
| `unzip-command.ts` | `unzip` — extract archives |
| `upskill-command.ts` | `upskill` — install skills from GitHub/ClawHub |
| `uname-command.ts` | `uname` — print the current browser user agent |
| `webhook-command.ts` | `webhook` — manage webhooks for event-driven automation |
| `which-command.ts` | `which` — resolve command to path (built-ins: `/usr/bin/<name>`, `.jsh` scripts: actual VFS path) |
| `zip-command.ts` | `zip` — create archives |
| `serve-command.ts` | `serve` — open a VFS app directory in a browser tab via preview service worker with optional `--entry` override |
| `oauth-token-command.ts` | `oauth-token` — retrieve OAuth access tokens for configured providers with auto-login |
| `playwright-command.ts` | `playwright-cli` / `playwright` / `puppeteer` — browser automation shell commands (navigate, snapshot, click, screenshot, cookies, HAR recording) |
| `sprinkle-command.ts` | `sprinkle` — list, open, close, and refresh `.shtml` sprinkle panels from the agent |
| `debug-command.ts` | `debug` — toggle Terminal/Memory tabs in extension mode (extension-only, uses dual-context hook+relay pattern) |
| `magick-wasm.ts` | Shared ImageMagick WASM initialization module for dual-mode (CLI/browser CDN vs extension bundled) image processing |

### src/skills/ — Skill Package Manager

| File | Purpose |
|---|---|
| `apply.ts` | applySkill: installs an install-managed native skill from `/workspace/skills/`, validates manifest, executes post-install steps |
| `discover.ts` | discoverSkills: scans native `/workspace/skills/` plus accessible `.agents/skills/*/SKILL.md` and `.claude/skills/*/SKILL.md` roots in the reachable VFS; getSkillInfo/readSkillInstructions expose the winning discovered skill |
| `install-from-drop.ts` | installSkillFromDrop: validates and unpacks dropped `.skill` ZIP archives into `/workspace/skills/{name}` as native install-managed skills |
| `uninstall.ts` | uninstallSkill: removes skill from state, rolls back installed files |
| `state.ts` | initSkillsSystem: init `.slicc/state.json`; readState/writeState: persistent skill state |
| `manifest.ts` | parseManifest: YAML parser for `manifest.yaml` (name, version, dependencies, conflicts, files) |
| `constants.ts` | SKILL_DIR, STATE_FILE, SKILL_MANIFEST constants |
| `types.ts` | Skill, SkillManifest, AppliedSkill, SkillState interfaces |
| `index.ts` | Re-exports |

Native `/workspace/skills` entries are the only install-managed skills. Compatibility-discovered `.agents`/`.claude` skills are readable/discoverable inputs only and are not auto-installed into or mutated in place.

### src/scoops/ — Multi-Agent Orchestration

| File | Purpose |
|---|---|
| `orchestrator.ts` | Manages scoop contexts, routes messages, handles responses, owns shared VirtualFS |
| `scoop-context.ts` | Per-scoop agent instance (RestrictedFS, WasmShell, Agent, skills, scoop-management tools); wires file tools + `bash` + `grep`/`find` + `javascript`, with browser automation via `playwright-cli` shell commands. Overflow recovery preserves ToolCall blocks in assistant messages to maintain API-required tool_use ↔ toolResult pairing |
| `scoop-management-tools.ts` | Scoop tools: `send_message`; cone-only tools: `list_scoops`, `scoop_scoop`, `feed_scoop`, `drop_scoop`, `update_global_memory` |
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
| `javascript-tool.ts` | `javascript` tool: execute JS in the browser context (fs.readDir, fs.readFile, fs.readFileBinary access) |
| `search-tools.ts` | `grep` and `find` tool factories for recursive VirtualFS search (not part of the active ScoopContext surface) |
| `index.ts` | Tool factory functions (createBashTool, createFileTools, createSearchTools, createJavaScriptTool) |

### src/ui/ — User Interface

| File | Purpose |
|---|---|
| `main.ts` | Entry point: `main()` for CLI/Electron embedded app, `mainExtension()` for extension (uses OffscreenClient). Handles layout, API key, orchestrator, skill drag/drop |
| `offscreen-client.ts` | Extension-only: side panel's interface to offscreen engine. Provides AgentHandle + Orchestrator-compatible facade via chrome.runtime messages |
| `layout.ts` | Split-pane (CLI) or tabbed (extension) layout; auto-selects based on extension detection |
| `tabbed-ui.ts` | Shared Chat/Terminal/Files/Memory tab definitions + normalization helpers reused by the extension layout and injected overlay shell |
| `overlay-shell-state.ts` | Pure state transitions for the injected Electron overlay shell (open/close + active tab) |
| `electron-overlay.ts` | Browser-side custom elements for the injected Electron overlay shell: launcher button, sidebar, persistent iframe host, and parent→iframe tab sync |
| `electron-overlay-entry.ts` | Standalone injected bundle entry that exposes `window.__SLICC_ELECTRON_OVERLAY__.inject()` / `remove()` for Electron reinjection |
| `chat-panel.ts` | Message list + input with streaming support; voice input (Web Speech API); connects to AgentHandle |
| `terminal-panel.ts` | xterm.js terminal UI; exposes WasmShell output |
| `file-browser-panel.ts` | File tree browser; download files/ZIP folders; navigate filesystem |
| `memory-panel.ts` | Global memory editor (IndexedDB-backed; shared across all scoops) |
| `scoops-panel.ts` | Scoop list (CLI mode left sidebar); create/delete/view scoops |
| `scoop-switcher.ts` | Dropdown menu for scoop selection (extension mode) |
| `message-renderer.ts` | Renders user messages, assistant messages, tool calls, tool results as HTML |
| `voice-input.ts` | Voice mode toggle; auto-sends on 2.5s silence; falls back to popup in extension mode |
| `skill-drop.ts` | Pure helpers for detecting supported dropped `.skill` files |
| `preview-sw.ts` | Service Worker that intercepts `/preview/*` and serves VFS content (enables in-browser app previews) |
| `session-store.ts` | IndexedDB session storage (`browser-coding-agent` DB): conversation history per session |
| `provider-settings.ts` | API provider + model selection; stores settings in localStorage |
| `api-key-dialog.ts` | Dialog for entering API keys |
| `theme.ts` | Theme toggle (System/Light/Dark) |
| `types.ts` | AgentHandle, AgentEvent, ChatMessage, ToolCall, UIMessage interfaces |
| `panel-registry.ts` | Registry of all panels (built-in + SHTML sprinkles) with zone placement and lookup/management methods |
| `panel-types.ts` | Shared type definitions: ZoneId, PanelDescriptor, PanelRegistryEntry for the panel system |
| `runtime-mode.ts` | Runtime mode detection (standalone/extension/electron-overlay) and Electron overlay messaging utilities |
| `tab-zone.ts` | Generic reusable tab bar + content area manager for a single zone |
| `sprinkle-manager.ts` | Registry of available and open `.shtml` sprinkle panels with placement and lifecycle management |
| `sprinkle-discovery.ts` | Scans VirtualFS for `.shtml` sprinkle files and builds a map of names to metadata (path, title) |
| `sprinkle-renderer.ts` | Loads `.shtml` content from VFS and renders into DOM. CLI: direct DOM injection (fragments) or srcdoc iframe (full docs). Extension: ALL content routes through `sprinkle-sandbox.html` (CSP-exempt) |
| `inline-sprinkle.ts` | Hydrates ` ```shtml ` code blocks in chat into sandboxed iframes. CLI: direct srcdoc. Extension: routes through `sprinkle-sandbox.html` |
| `sprinkle-bridge.ts` | API available to `.shtml` sprinkle scripts for communicating with the agent via lick events and state persistence |
| `sprinkle-picker.ts` | Popup menu listing closed panels and unopened sprinkles for opening in a zone |
| `index.ts` | Re-exports |

### src/shims/ — Node.js Polyfills

| File | Purpose |
|---|---|
| `empty.ts` | Stubs out node:zlib and node:module (just-bash references these) |
| `buffer-polyfill.ts` | Polyfills Buffer for browser (isomorphic-git requirement) |
| `http.ts`, `http2.ts`, `https.ts`, `stream.ts` | Node module stubs (imported by dependencies, no-op in browser) |

### src/types/ — Type Declarations

| File | Purpose |
|---|---|
| `pi-coding-agent-compaction.d.ts` | Type declarations for pi-coding-agent compaction submodule (estimateTokens, shouldCompact, generateSummary) |

### packages/vfs-root/ — Bundled VFS Content

Default files bundled into the VFS at startup via `import.meta.glob`:

| Path | VFS Target | Purpose |
|---|---|---|
| `shared/CLAUDE.md` | `/shared/CLAUDE.md` | Agent system-level instructions (loaded into sliccy's context) |
| `workspace/skills/` | `/workspace/skills/` | Default skill packages (playwright-cli, sprinkles, etc.) |
| `shared/sprinkles/` | `/shared/sprinkles/` | Default sprinkle panels (welcome) |

### src/ — Root

| File | Purpose |
|---|---|
| `globals.d.ts` | TypeScript globals (\_\_DEV\_\_, etc.) |

## Build Targets Table

| Target | tsconfig | Input | Output | Module Resolution |
|---|---|---|---|---|
| Browser bundle | `packages/webapp/vite.config.ts` + `tsconfig.json` | `packages/webapp/` | `dist/ui/` (via Vite) | bundler |
| CLI + Electron Node target | `tsconfig.cli.json` | `packages/node-server/src/` | `dist/node-server/` (via TSC) | NodeNext |
| Extension | `vite.config.extension.ts` | Browser bundle + extension entries | `dist/extension/` | bundler |

### Special Build Artifacts

- **preview-sw.ts**: Built as standalone IIFE via esbuild (not rollup) from `packages/webapp/vite.config.ts` during the production webapp build.
- **electron-overlay-entry.ts**: Built as standalone IIFE alongside `dist/ui/electron-overlay-entry.js` from `packages/webapp/vite.config.ts` for Electron reinjection.
- **Extension assets**: Pyodide (~13MB), ImageMagick WASM, `sandbox.html`, `voice-popup.html`, `offscreen.html` copied to `dist/extension/` by `vite.config.extension.ts`. The `offscreen.html` entry point runs the agent orchestrator in an unrestricted context separate from the side panel.
- **Node shims**: `src/shims/` provide no-op implementations for Node modules (just-bash references them).

## Extension Three-Layer Architecture

The Chrome extension uses a three-layer design to keep the agent engine alive across side panel close/reopen cycles:

```
┌──────────────────────────────────────────────────────────────┐
│ Side Panel (UI)                                               │
│  offscreen-client.ts — Chat, Terminal, Files, Memory          │
│  Sends: PanelToOffscreenMessage (user input, commands)        │
│  Receives: OffscreenToPanelMessage (agent events, state)      │
└─────────────────────────┬────────────────────────────────────┘
                          │ chrome.runtime messages
┌─────────────────────────▼────────────────────────────────────┐
│ Service Worker Relay (service-worker.ts)                      │
│  Routes Panel ↔ Offscreen messages                            │
│  Proxies CDP: CdpProxyMessage ↔ chrome.debugger               │
└─────────────────────────┬────────────────────────────────────┘
                          │ chrome.runtime messages
┌─────────────────────────▼────────────────────────────────────┐
│ Offscreen Document (offscreen.ts, offscreen-bridge.ts)        │
│  Agent Engine — Orchestrator, VFS, Shell, Tools               │
│  Persists chat to: browser-coding-agent IndexedDB             │
│  Dispatches CDP via service worker proxy                      │
└──────────────────────────────────────────────────────────────┘
```

**Message Flow:**
- **PanelToOffscreenMessage**: User input flows from panel → service worker → offscreen
- **OffscreenToPanelMessage**: Agent responses flow from offscreen → service worker → panel
- **CdpProxyMessage**: Browser automation (screenshot, click, evaluate) flows from offscreen → service worker → chrome.debugger

**IndexedDB Persistence:**
- `browser-coding-agent` DB: Chat display messages (single source of truth, written by offscreen bridge, read by side panel on reconnect)
- `agent-sessions` DB: Agent LLM conversation history (restored by ScoopContext on restart)
- `slicc-groups` DB: Orchestrator routing data (scoops, tasks, webhooks, crontasks)

**CDP Proxy:** Offscreen documents can't call `chrome.debugger` directly. Instead, offscreen sends `CdpProxyMessage` through the service worker, which translates to `chrome.debugger` commands and routes results back.

**Dual Shell Context:** Both the side panel and offscreen document run their own WasmShell instance. The panel shell powers the Terminal tab; the offscreen shell executes agent bash tool calls. They share VFS via IndexedDB but NOT window globals or DOM. Shell commands that affect the panel UI (e.g., `debug on`) must use the dual-context pattern: try `window.__slicc_*` hook first (panel), fall back to `chrome.runtime.sendMessage` relay (offscreen → panel). See `docs/pitfalls.md` "Extension Dual-Shell Context".

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
      → Tool calls [bash, file, grep/find, javascript, NanoClaw, etc.]
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
    → SessionStore.save({ id, messages, config, createdAt, updatedAt }) [fire-and-forget]
      → Persists SessionData to agent-sessions DB

Scoop removal / app clear
  → Orchestrator calls SessionStore.delete(jid) or SessionStore.clearAll()
    → Clears persisted session data
```

**Session Storage:**
- Database: `agent-sessions` (IndexedDB)
- Key: scoop JID (e.g., `cone`, `analysis-scoop`)
- Value: `SessionData` (`AgentMessage[]` + config + timestamps)
- Lifecycle: Loaded on scoop init, saved on agent_end (error-tolerant), deleted on scoop removal
- Design: Messages are model-agnostic and work with any LLM. `createCompactContext()` provides LLM-summarized compaction at prompt time, so large sessions don't cause token bloat.

## IndexedDB Databases

| Database | Version | Stores | Purpose |
|---|---|---|---|
| `slicc-fs` | 1 | (VirtualFS data) | POSIX filesystem backing store (LightningFS) |
| `browser-coding-agent` | 1 | sessions, settings | UI-level session history + localStorage mirror |
| `slicc-groups` | 3 | scoops, messages, sessions, tasks, state, webhooks, crontasks | Orchestrator data (scoops, messages, tasks) |
| `agent-sessions` | 1 | sessions | Core agent session history: persisted `SessionData` (`AgentMessage[]` + config + timestamps) per scoop, keyed by JID; loaded on scoop init, saved on agent_end |
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
| Change browser automation shell behavior | `src/shell/supplemental-commands/playwright-command.ts` and `src/shell/supplemental-commands/serve-command.ts` |
| Change grep/find tool behavior | `src/tools/search-tools.ts` |
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
| Add scoop-management tools (messaging, scoop management) | `src/scoops/scoop-management-tools.ts` |
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
| Add an API endpoint | `packages/node-server/src/index.ts` |
| Change Chrome launch options | `packages/node-server/src/index.ts` |
| Change WebSocket proxy behavior | `packages/node-server/src/index.ts` |
| Change request logging | `packages/node-server/src/index.ts` |

### Extension Manifest

| I need to... | Modify |
|---|---|
| Change extension behavior | `src/extension/service-worker.ts` |
| Add Chrome API types | `src/extension/chrome.d.ts` |
| Build extension | `vite.config.extension.ts` |

### Skills & Package Management

| I need to... | Modify |
|---|---|
| Change skill installation logic | `src/skills/apply.ts`, `src/skills/install-from-drop.ts` |
| Change skill discovery | `src/skills/discover.ts` |
| Change skill uninstall logic | `src/skills/uninstall.ts` |
| Change skill state persistence | `src/skills/state.ts` |
| Change manifest parsing | `src/skills/manifest.ts` |

### Sprinkles System

| I need to... | Modify |
|---|---|
| Add/change sprinkle discovery | `src/ui/sprinkle-discovery.ts` |
| Change sprinkle rendering or CSP handling | `src/ui/sprinkle-renderer.ts`, `src/ui/inline-sprinkle.ts`, `sprinkle-sandbox.html` |
| Change the sprinkle↔agent bridge API | `src/ui/sprinkle-bridge.ts` |
| Change sprinkle lifecycle/placement | `src/ui/sprinkle-manager.ts` |
| Add sprinkle picker UI features | `src/ui/sprinkle-picker.ts` |
| Change extension sprinkle message proxy | `src/extension/sprinkle-proxy.ts` |
| Change `sprinkle` shell command | `src/shell/supplemental-commands/sprinkle-command.ts` |
| Add a default sprinkle | `packages/vfs-root/shared/sprinkles/` |

### Providers

| I need to... | Modify |
|---|---|
| Add an API-key provider (built-in, with custom stream) | `src/providers/built-in/<provider>.ts` (exports `config: ProviderConfig` + `register()`; pure-config providers need no file — pi-ai auto-discovers them) |
| Add an external/custom provider | `packages/webapp/providers/<provider>.ts` (gitignored in the webapp package, auto-discovered) |
| Add an OAuth provider | Same as above, but set `isOAuth: true` + `onOAuthLogin`/`onOAuthLogout` on the config |
| Change the OAuth transport (popup, chrome.identity) | `src/providers/oauth-service.ts` |
| Override model capabilities (context window, max tokens) | `modelOverrides` on `ProviderConfig` (static) or return metadata fields from `getModelIds()` (dynamic). Three-layer merge: pi-ai → modelOverrides → getModelIds |
| Add OpenAI-compatible model support | Return `api: 'openai'` in `getModelIds()` metadata — stream routing switches to `streamOpenAICompletions` automatically |
| Change provider types (ProviderConfig, OAuthLauncher, ModelMetadata) | `src/providers/types.ts` |
| Change OAuth callback page (CLI mode) | `packages/node-server/src/index.ts` (`/auth/callback` route) |
| Change provider settings UI / model resolution | `src/ui/provider-settings.ts` |
