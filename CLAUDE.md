# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build and Development Commands

```bash
# Standalone CLI mode
npm run dev:full        # Full dev mode: Vite HMR + Chrome + CDP proxy (port 3000)
npm run dev:electron -- /Applications/Slack.app  # Main CLI in Electron attach mode
npm run dev             # Vite dev server only (no Chrome/CDP)
npm run qa:setup        # Build dist/extension and scaffold dedicated leader/follower/extension Chrome QA profiles
npm run qa:leader       # Launch CLI dev mode with the isolated leader Chrome profile, auto-connected to staging tray hub
npm run qa:follower     # Launch CLI dev mode with the isolated follower Chrome profile
npm run qa:extension    # Rebuild/load the unpacked extension in the isolated extension Chrome profile
npm run build           # Production build (UI via Vite + CLI/Electron Node target via TSC)
npm run build:ui        # Vite build only into dist/ui/
npm run build:cli       # TSC build only into dist/cli/ (CLI server + Electron entrypoint)
npm run start           # Run production CLI (requires build first)
npm run start:electron -- /Applications/Slack.app  # Run built Electron attach mode

# Chrome extension
npm run build:extension # Build extension into dist/extension/ (load in chrome://extensions)

# Shared
npm run typecheck       # Typecheck browser + Node targets
npm run test            # Vitest run (all tests)
npx wrangler dev        # Run the Cloudflare Worker tray hub locally (requires Wrangler)
npx wrangler deploy --env staging  # Deploy the staging tray hub (slicc-tray-hub-staging) from wrangler.jsonc
npx wrangler deploy     # Deploy the Cloudflare Worker tray hub from wrangler.jsonc
WORKER_BASE_URL=https://... npx vitest run src/worker/deployed.test.ts  # Smoke-test a deployed tray hub
npm run test:watch      # Vitest watch mode
npx vitest run src/fs/virtual-fs.test.ts  # Run a single test file
```

**Requires Node >= 22** (LTS). LightningFS uses `navigator` which is only available as a global from Node 21+. Tests will fail on Node 20 or earlier.

Ports: 3000 (UI server for CLI + Electron), 9222 (Chrome CDP), 9223 (Electron CDP), 24679 (Vite HMR WebSocket)

## Philosophy

Three foundational ideas:

1. **The Claw Pattern (Steinberger-Karpathy)**: SLICC is a "claw" — a persistent orchestration layer on top of LLM agents. Claws add scheduling, messaging, event handling, and skills ecosystems on top of basic agent capabilities. The term was [coined by Andrej Karpathy](https://x.com/karpathy/status/2024987174077432126). [OpenClaw](https://github.com/openclaw/openclaw) (by Peter Steinberger) is the original implementation. SLICC is a claw that runs in the browser. The agent engine is [Pi](https://github.com/badlogic/pi-mono) by Mario Zechner (pi-agent-core, pi-ai).

2. **Agents Love the CLI (Zechner)**: Pi has 4 tools: read, write, edit, bash. SLICC keeps that shell-first core and exposes browser automation through shell commands like `playwright-cli`, `serve`, and `open`. When adding new capabilities, default to shell commands, not dedicated tools. MCP server definitions burn context tokens; CLI tools compose naturally. Zechner's principle: ["Bash is all you need."](https://mariozechner.at/posts/2025-11-02-what-if-you-dont-need-mcp/)

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

- **Floats**: Runtime environments. Four are tracked:
  - CLI float: Node.js/Express + Chrome. Code: `src/cli/`.
  - Extension float: Chrome extension side panel, zero server. Code: `src/extension/`.
  - Electron float: Electron BrowserWindow + injected overlay shell + serve-only CLI reuse. Code: `src/cli/electron-main.ts` + `src/ui/electron-overlay.ts`.
  - Cloud float (planned): Cloudflare Containers or E2B sandboxes.

When renaming or refactoring, prefer ice cream terms over technical jargon (e.g., "feed_scoop" not "delegate_to_scoop", "lick" not "event").

## Architecture

Browser-based AI coding agent: a self-contained development environment where Claude writes code, runs shell commands, and automates browser tabs entirely within Chrome, without touching the host filesystem. Runs as a **Chrome extension** (side panel), as a **standalone CLI** server, or as an **Electron float** with an injected overlay.

### Three Deployment Modes

- **Chrome extension** (Manifest V3): Three-layer architecture — **side panel** (pure UI), **service worker** (message relay + CDP proxy), **offscreen document** (agent engine). Agent work survives side panel close/reopen. Built via `npm run build:extension` -> `dist/extension/`. Load as unpacked extension in `chrome://extensions`. Pyodide bundled for Python support (~13MB).
- **Standalone CLI**: Express server launches Chrome, proxies CDP over WebSocket. Resizable split layout with scoops panel + chat + terminal + files/memory. Built via `npm run build` -> `dist/ui/` + `dist/cli/`.
- **Electron float**: `src/cli/electron-main.ts` launches Electron, reuses the CLI server in `--serve-only` mode, enables CDP on the Electron window, strips host-page CSP in a dedicated partition, and injects the shared overlay shell via `dist/ui/electron-overlay-entry.js`.

### Extension Architecture (Three-Layer)

```
┌─────────────────────────┐
│   Side Panel (UI only)  │  Connects/disconnects freely
│   - Chat, Terminal,     │  Catches up on reopen via
│     Files, Memory tabs  │  state snapshot from offscreen
│   - OffscreenClient     │
└───────────┬─────────────┘
            │ chrome.runtime messages
┌───────────┴─────────────┐
│   Service Worker        │  Stateless relay + chrome.* proxy
│   - Creates offscreen   │  - chrome.debugger proxy for CDP
│   - Relays messages     │  - chrome.tabs queries
│   - Forwards CDP events │
└───────────┬─────────────┘
            │ chrome.runtime messages
┌───────────┴─────────────┐
│   Offscreen Document    │  Long-lived agent engine
│   - Orchestrator        │  Survives side panel close
│   - ScoopContext(s)     │  All state in IndexedDB
│   - VirtualFS + Shell   │
│   - Tools (bash, files, │
│     browser via proxy)  │
│   - OffscreenBridge     │
└─────────────────────────┘
```

Key files:
- `src/extension/messages.ts` — Shared message types (Panel ↔ SW ↔ Offscreen)
- `src/extension/service-worker.ts` — Message relay + CDP proxy
- `src/extension/offscreen.ts` — Agent engine bootstrap
- `src/extension/offscreen-bridge.ts` — Orchestrator ↔ message bridge
- `src/cdp/offscreen-cdp-proxy.ts` — CDPTransport via chrome.runtime messages (offscreen → service worker)
- `src/cdp/panel-cdp-proxy.ts` — CDPTransport for side panel terminal (panel → offscreen → service worker)
- `src/ui/offscreen-client.ts` — Side panel's interface to offscreen engine
- `offscreen.html` — Offscreen document entry point

**Chat Persistence (Single Source of Truth)**: The `browser-coding-agent` IndexedDB is the single source of truth for chat display messages. The offscreen bridge writes to it after every user message, response done, tool end, and incoming message via `SessionStore.saveMessages()`. The side panel reads from it via `switchToContext()` on reconnect — no buffer reconciliation needed. This is separate from `agent-sessions` DB (agent LLM history restored by `ScoopContext`) and `slicc-groups` DB (orchestrator routing messages).

**Extension Entry Point**: In `src/ui/main.ts`, when extension mode is detected, `main()` delegates to `mainExtension()` which creates an `OffscreenClient` instead of a direct `Orchestrator`. The `OffscreenClient` provides an `AgentHandle` for the chat panel and an Orchestrator-compatible facade for scoops/memory/scoop-switcher panels.

### Three Build Targets

- **Browser bundle** (tsconfig.json): Everything in src/ except src/cli/. Bundled by Vite, module resolution: bundler. Runs in Chrome.
- **CLI/Electron Node target** (tsconfig.cli.json): Only src/cli/. Compiled by TSC to dist/cli/, module resolution: NodeNext. Runs in Node/Electron.
- **Extension bundle** (vite.config.extension.ts): Same browser bundle with extension-specific entry points (service-worker.js, offscreen.html, sandbox.html, manifest.json) plus bundled Pyodide. Output: dist/extension/.

Cloud tray hub scaffold:
- **Cloudflare Worker / Durable Object** (`wrangler.jsonc` + `src/worker/`): separate Wrangler-managed runtime for `POST /tray`, controller attach, leader-only WebSocket control, deployed smoke tests, and webhook forwarding via `POST /webhook/:token/:webhookId` (reads the POST body, forwards a `webhook.event` control message to the leader over the existing WebSocket, returns 202 Accepted).

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
          -> CLI Server / Electron (src/cli/) | Extension (src/extension/)
```

Cloud tray hub runtime lives alongside the main app in `src/worker/` and is deployed separately via Wrangler.

### The Cone and Scoops (src/scoops/)

SLICC uses an ice cream theme for its multi-agent system. The **cone** is the main assistant (sliccy) that holds everything together. **Scoops** are isolated agent contexts stacked on top, each with their own tools, shell, and restricted filesystem.

- **Orchestrator** (`orchestrator.ts`): Creates/destroys scoop contexts, routes messages, manages the single shared VirtualFS, handles scoop completion notifications back to the cone. Creates a `SessionStore` instance and passes it to each `ScoopContext`; deletes sessions on scoop removal and clears all on reset. `clearAllMessages()` also wipes live agent in-memory conversation history via `ScoopContext.clearMessages()`.
- **ScoopContext** (`scoop-context.ts`): Per-scoop agent instance with RestrictedFS, WasmShell, skills, and NanoClaw-style tools (send_message).
- **Scheduler** (`scheduler.ts`): Polls persisted scoop tasks on an interval, supports cron/interval/once schedules, and invokes callbacks when tasks become due.
- **Heartbeat** (`heartbeat.ts`): Tracks scoop health/activity, processing state, error counts, and idle/dead transitions for monitoring.
- **Delegation**: The cone feeds work to scoops via the `feed_scoop` tool, providing complete self-contained prompts (scoops have no access to the cone's conversation). When a scoop finishes, the orchestrator automatically routes its response back to the cone's message queue.
- **Unified Filesystem**: One VirtualFS (`slicc-fs` IndexedDB). Cone gets unrestricted access. Each scoop gets a `RestrictedFS` limited to `/scoops/{name}/` + `/shared/`. Parent directory traversal is allowed for `stat`/`exists` (so `cd` works), but reads/writes outside the sandbox are blocked.
- **DB** (`db.ts`): IndexedDB schema v3 with `scoops`, `messages`, `sessions`, `tasks`, `state`, `webhooks`, and `crontasks` stores. Migrates the old `groups` store to `scoops` and adds webhook/crontask persistence in v3.
- **Tray sync protocol** (`tray-sync-protocol.ts`): Typed message protocol for leader↔follower communication over WebRTC data channels. Leader→follower messages: `snapshot`, `agent_event`, `user_message_echo`, `status`, `error`, `targets.registry`, `cdp.request`, `cdp.response`, `tab.open`, `tab.opened`, `tab.open.error`. Follower→leader messages: `user_message`, `abort`, `request_snapshot`, `targets.advertise`, `cdp.request`, `cdp.response`, `tab.open`, `tab.opened`, `tab.open.error`. Types `RemoteTargetInfo` and `TrayTargetEntry` define the target advertisement contract.
- **TrayTargetRegistry** (`tray-target-registry.ts`): Pure-logic merged registry maintained by the leader. Each runtime advertises its local browser targets; the registry merges them into a unified `TrayTargetEntry[]` with composite `targetId` format `"{runtimeId}:{localTargetId}"`. The leader broadcasts the merged registry to all followers via `targets.registry`.
- **Federated browser targets**: Runtimes in a tray advertise their local browser targets (via `targets.advertise`). The leader merges all targets into a global registry and broadcasts it (via `targets.registry`). Any runtime can then operate on remote targets — CDP commands are routed over the data channel (`cdp.request` → execute on owner → `cdp.response`). Remote tab opening uses `tab.open` → `tab.opened` / `tab.open.error` with the same leader-mediated routing pattern. The leader handles forwarding between followers. Leader sync (`tray-leader-sync.ts`) owns the `TrayTargetRegistry`, routes CDP between runtimes, and provides `openRemoteTab()`. Follower sync (`tray-follower-sync.ts`) provides `advertiseTargets()`, `getTargets()`, `createRemoteTransport()`, and `openRemoteTab()`. BrowserAPI exposes `createRemotePage(runtimeId, url)` via the `TrayTargetProvider`. The `playwright-cli open --runtime=<id>` flag triggers remote tab creation. The UI wires a 5-second periodic target refresh in `src/ui/main.ts`.

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
- `open <path|url>` — Preview/serve VFS files or open URLs in a new browser tab. `--download` / `-d` forces file download. `--view` / `-v` returns image inline for agent vision (produces `<img:>` tag converted to `ImageContent` by tool adapter)
- `host` — Report the current leader tray status and canonical launch URL
- `zip/unzip` — Archive compression
- `webhook` — Manage webhooks for event-driven automation (URLs point to the tray worker when a tray is active, otherwise to the CLI server)
- `crontask` — Schedule cron jobs that dispatch licks to scoops
- `pdftk` / `pdf` — Inspect, extract, rotate, and merge PDFs
- `mount` — Mount a local directory into the virtual filesystem via the File System Access API
- `convert` / `magick` — ImageMagick-style image conversion (resize, rotate, crop, quality) via `@imagemagick/magick-wasm`
- `playwright-cli` / `playwright` / `puppeteer` — Browser automation shell commands backed by `BrowserAPI`; aliases share the same tab/session state, snapshots, and session history. When connected to a tray, `tab-list` includes remote targets annotated with `[remote:runtimeId]`. Use `open --runtime=<id>` or `tab-new --runtime=<id>` to open a tab on a remote tray runtime.
- `which <command>` — Resolve a command to its path (`/usr/bin/<name>` for built-ins, actual VFS path for `.jsh` files)
- `uname` — Print the current browser user agent
- `oauth-token` — Get an OAuth access token for a provider (auto-triggers login if needed)
- `commands` — Show all available commands (type `commands` in terminal)

Any `*.jsh` file anywhere on the VFS is auto-discovered as a shell command (basename without `.jsh` extension). Skills can ship `.jsh` files alongside `SKILL.md` to provide executable commands. Files in `/workspace/skills/` get priority when names conflict.

**Extension CSP workaround**: `node -e` in extension mode routes through the sandbox iframe (CSP blocks `AsyncFunction` constructor on extension pages). Python uses bundled Pyodide loaded from `chrome.runtime.getURL('pyodide/')`. ImageMagick WASM is fetched as bytes from `chrome.runtime.getURL('magick.wasm')` since `initializeImageMagick` rejects `chrome-extension://` URLs.

**JSH Scripts** (`src/shell/jsh-discovery.ts`, `src/shell/jsh-executor.ts`, `src/shell/parse-shell-args.ts`): `.jsh` files are JavaScript shell scripts that are auto-discovered as commands anywhere on the VFS.
- `jsh-discovery.ts` — Scans VFS for `*.jsh` files with priority roots (`/workspace/skills/`), returns `Map<name, path>`. First occurrence of a basename wins.
- `jsh-executor.ts` — Executes `.jsh` files with Node-like globals: `process` (argv, env, cwd, exit, stdout.write, stderr.write), `console` (log, info, warn, error), `fs` bridge (readFile, writeFile, readDir, mkdir, rm, stat, exists, fetchToFile), `exec(command)` (run shell commands via just-bash, returns `{stdout, stderr, exitCode}`). Dual-mode: `AsyncFunction` in CLI, sandbox iframe in extension (CSP-compliant). Returns `JshResult` with stdout, stderr, exitCode.
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

BrowserAPI: high-level Playwright-style API built on either transport (listPages, navigate, screenshot, evaluate, click, type, waitForSelector, getAccessibilityTree). Auto-selects transport based on extension detection. It underpins the `playwright-cli` / `playwright` / `puppeteer` shell-command path and the preview-serving commands built on top of browser tabs. TargetInfo and PageInfo types include `active` field (boolean, extension mode only) to identify the user's currently focused tab, enabling intelligent tool auto-dispatch. Screenshots normalize `devicePixelRatio` to 1 before capture (via `Emulation.setDeviceMetricsOverride`) and restore native metrics after, preventing 2x-oversized images on HiDPI displays. When DPR is already 1 (e.g. after an explicit `resize` command), normalization is skipped and the existing override is preserved. `captureBeyondViewport` is always enabled.

**Federated Targets** (`TrayTargetProvider`, `listAllTargets()`): When connected to a tray, `BrowserAPI` can include remote targets (browser tabs owned by other SLICC instances). `setTrayTargetProvider(provider)` injects a `TrayTargetProvider` that supplies remote `TrayTargetEntry` objects. `listAllTargets()` returns local pages + remote tray targets; remote targets use `"{runtimeId}:{localTargetId}"` as their `targetId`. `attachToPage()` detects remote targets and swaps the underlying CDP transport to a `RemoteCDPTransport` for the duration of the session.

**RemoteCDPTransport** (`remote-cdp-transport.ts`): A `CDPTransport` implementation that routes CDP commands over the tray WebRTC data channel to the remote runtime that owns the target browser tab. Uses a `RemoteCDPSender` interface (implemented by both `LeaderSyncManager` and `FollowerSyncManager`) to send `cdp.request` messages and receive `cdp.response` / CDP events back. Includes per-request timeout handling and clean disconnect semantics.

**HarRecorder** (`har-recorder.ts`): Records network traffic from browser tabs as HAR 1.2 files. Supports user-provided JS filter functions (`(entry) => false | true | object`). Filter application is deferred to snapshot save time (batch, not per-entry) to support extension mode — in extensions, filter code is sent to the sandbox iframe (CSP-exempt) via `postMessage`; in CLI mode, compiled directly. Snapshots saved to `/recordings/{id}/` on navigation and recording stop. Graceful fallback: filter errors return unfiltered entries.

### Tools (src/tools/)
All tools use the legacy ToolDefinition interface (name, description, inputSchema, execute). `src/tools/` currently contains factories for file, bash, search, and javascript tools. The active scoop/cone tool surface wired in `src/scoops/scoop-context.ts` is: `read_file`, `write_file`, `edit_file`, `bash`, `javascript`, plus NanoClaw tools. Browser automation and search for active agents go through shell commands via the `bash` tool (`playwright-cli` / `playwright` / `puppeteer`, plus shell-native `rg` / `grep` / `find`).

**NanoClaw tools** (src/scoops/nanoclaw-tools.ts): Per-scoop tools for messaging — `send_message`. Cone-only tools: `list_scoops`, `scoop_scoop` (create), `feed_scoop` (delegate), `drop_scoop` (remove), `update_global_memory`. Task scheduling moved to the `crontask` shell command.

**Browser automation shell path**: Active agents use `playwright-cli` / `playwright` / `puppeteer` for tab management, snapshots, screenshots, cookies/storage, dialogs, and HAR recording. The standalone `serve <dir>` command opens a VFS app directory in a preview tab (default entry `index.html`, optional `--entry` override), while `open` still handles single files, URLs, downloads, and inline image viewing.

**Search tools** (`src/tools/search-tools.ts`): `createSearchTools()` still provides the dedicated `grep` and `find` tool factories for module-level use and tests, but they are no longer part of the active scoop/cone tool surface. Active agents should use shell-native `rg` / `grep` / `find` through `bash`.

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
Vanilla TypeScript, no framework. Two base layout modes selected by `isExtension` detection:
- **Extension mode**: Compact single-row header (slicc + scoop dropdown + model dropdown + icon buttons). Tabbed interface (Chat/Terminal/Files/Memory). Scoop switcher as dropdown menu.
- **Standalone mode**: Resizable split layout — scoops panel (left) + chat + terminal (top-right) + files/memory tabs (bottom-right).

The Electron float reuses `src/ui/electron-overlay.ts` as an injected overlay shell built from custom elements with shadow DOM. It reuses the shared Chat/Terminal/Files/Memory tab definitions from `src/ui/tabbed-ui.ts`, while `src/ui/overlay-shell-state.ts` holds the pure open/close + active-tab state transitions used by tests. The actual Electron runtime wiring lives in `src/cli/electron-main.ts`.

main.ts has two entry paths: in extension mode, `main()` delegates to `mainExtension()` which creates an `OffscreenClient` (no local Orchestrator); in CLI/Electron mode, it bootstraps the Orchestrator directly. A third runtime flag (`electron-overlay`) hides the top tab bar, mounts the compact tabbed layout inside the injected iframe, and listens for parent `postMessage` tab changes from the Electron overlay shell. Both non-extension runtimes still use `BrowserAPI` and the local `/cdp` proxy.

File browser supports clicking files to download and a ZIP button on folders (uses fflate) to download entire directories.

Two separate IndexedDB session stores: UI-level (browser-coding-agent DB in session-store.ts) and core agent-level (agent-sessions DB in core/session.ts). Orchestrator data (scoops, messages, tasks, state) stored in slicc-groups DB (name retained for backward compatibility).

**Voice Input** (`voice-input.ts`): Hands-free voice mode using the Web Speech API (`webkitSpeechRecognition`). Two runtime paths:
- **Standalone (CLI)**: Direct `getUserMedia` + `webkitSpeechRecognition` in the browser page.
- **Extension**: Side panels can't trigger mic permission prompts. First use opens a popup window (`voice-popup.html`) for the one-time permission grant. Once granted, subsequent uses work directly in the side panel (permission cached per `chrome-extension://` origin). Falls back to popup if direct access fails.

Voice mode is a toggle (mic button or `Ctrl+Shift+V` / `Cmd+Shift+V`): click once to enable, click again to disable. While enabled, the user speaks → 2.5s silence → message auto-sends → input locks during agent response → voice auto-restarts when the turn ends. Mic button stays clickable during streaming so voice mode can be toggled off. Consecutive no-speech restarts use exponential backoff (300ms → 5s cap) to prevent rapid mic toggling. Settings (`voice-auto-send`, `voice-lang`) stored in localStorage.

Extension assets: `voice-popup.html` + `voice-popup.js` (project root, copied to `dist/extension/` by `vite.config.extension.ts`).

### Extension (src/extension/)
Chrome Manifest V3 extension with three-layer architecture for background agent execution:

- **Service worker** (`service-worker.ts`): Creates offscreen document on install/startup, relays messages between side panel and offscreen, proxies `chrome.debugger` CDP commands (offscreen docs can't use `chrome.debugger` directly), forwards CDP events back to offscreen.
- **Offscreen document** (`offscreen.ts`, `offscreen-bridge.ts`): Long-lived extension page that runs the agent engine (Orchestrator, VFS, Shell, tools). Survives side panel close. `OffscreenBridge` translates between Orchestrator callbacks and chrome.runtime messages.
- **Message types** (`messages.ts`): Typed envelopes (`PanelEnvelope`, `OffscreenEnvelope`, `ServiceWorkerEnvelope`) with `source` + `payload` for routing.
- **CDP proxy** (`src/cdp/offscreen-cdp-proxy.ts`): `CDPTransport` implementation that routes commands through chrome.runtime messages to the service worker's `chrome.debugger`. Used by the offscreen agent engine.
- **Panel CDP proxy** (`src/cdp/panel-cdp-proxy.ts`): `CDPTransport` for the side panel terminal. Routes commands through the offscreen bridge (which forwards to its own CDP transport). Receives CDP events directly from the service worker broadcast. This gives the side panel terminal a working `BrowserAPI` for `playwright-cli` and browser automation commands.
- `chrome.d.ts` provides typed declarations for Chrome APIs (debugger, tabs, sidePanel, runtime, offscreen, windows, messaging).
- `sandbox.html` (project root) provides isolated execution for JavaScript tool and `node -e` — exempt from extension CSP. Both the side panel and offscreen document can host sandbox iframes.
- Pyodide (~13MB) bundled at `dist/extension/pyodide/` for Python support (loaded from `'self'` origin).

**Extension Persistence Model**: The `browser-coding-agent` IndexedDB is the single source of truth for chat display messages. The offscreen bridge writes to it after every user message, response completion, tool call end, and incoming message event. The side panel reads from it via `switchToContext()` — no message buffer reconciliation needed. This separates concerns: the `agent-sessions` DB stores agent LLM history (for multi-turn context), while `slicc-groups` DB stores orchestrator routing data (scoops, tasks, webhooks, crontasks).

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
Express server that launches Chrome with remote debugging, serves the UI (Vite middleware in dev, static files in prod), and runs a WebSocket proxy at /cdp. Provides `/api/fetch-proxy` endpoint for cross-origin fetch (replaces CORS proxy), and `/auth/callback` for OAuth redirect handling (reads query params + URL fragment, postMessages back to the opener popup). Single shared Chrome WebSocket connection with client message buffering. Console forwarder pipes in-page console output to CLI stdout. In Electron mode, this same server is reused in `--serve-only` mode instead of launching Chrome. QA/manual-verification flows use `src/cli/chrome-launch.ts` plus `--profile=<leader|follower|extension>` to select dedicated `.qa/chrome/*` user-data directories and auto-load `dist/extension` for the extension profile.

### Context Compaction (src/core/context-compaction.ts)
LLM-summarized context compaction aligned with pi-mono's strategy. When context approaches the limit, an LLM call generates a structured summary of older messages, replacing them with a single user message. This preserves the conversation prefix (cache-friendly) and keeps recent messages intact.

- **Threshold**: `contextWindow - reserveTokens` (200K - 16384 = ~183K tokens), using `shouldCompact()` and `estimateTokens()` from pi-coding-agent
- **Cut point**: Walks backward from newest to keep ~`keepRecentTokens` (20000 tokens) of recent messages. Never splits assistant+toolResult pairs.
- **Summarization**: `generateSummary()` from pi-coding-agent makes an LLM call producing a structured summary (Goal, Progress, Key Decisions, Next Steps, Critical Context).
- **Fallback**: If the LLM call fails or no API key is available, falls back to naive message dropping with a compaction marker.
- **No truncation**: Tool results pass through at full fidelity — no safety cap or truncation. Image tags are parsed into `ImageContent` blocks by `tool-adapter.ts`. If oversized content causes a context overflow, the overflow recovery mechanism handles it.
- **Image preprocessing**: Images in tool results are automatically validated and resized before reaching the LLM (`src/core/image-processor.ts`). Images over 5MB or 1568px long edge are compressed via ImageMagick WASM (`src/shell/supplemental-commands/magick-wasm.ts`). Unsupported formats or corrupt images are replaced with text placeholders. If the API still rejects an image, `recoverFromImageError()` in `scoop-context.ts` strips it from context and re-prompts (same pattern as overflow recovery).
- **Overflow recovery** (`scoop-context.ts`): When the API returns a "prompt too long" error, `ScoopContext` catches it via `isContextOverflow()` from pi-ai, removes the error message, replaces oversized messages (>40K chars) with placeholders, and re-prompts the agent with an explanation. Limited to 1 retry to prevent infinite loops. Uses deep import from `@mariozechner/pi-ai/dist/utils/overflow.js` (Vite alias in both configs).
- **Factory**: `createCompactContext(config)` returns a `transformContext` function wired into each `ScoopContext`.
- **Import**: Deep import from `@mariozechner/pi-coding-agent/dist/core/compaction/compaction.js` (browser-safe submodule). Vite alias in `vite.config.ts` and `vite.config.extension.ts`. Types in `src/types/pi-coding-agent-compaction.d.ts`.

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
- **Tests are colocated**: foo.test.ts next to foo.ts. Vitest with globals: true, environment: node. New pure-logic code (utilities, adapters, data transformations) should always have tests. DOM-dependent code (UI panels, layout) and chrome.* API code (DebuggerClient) are acceptable to skip in Node tests but should be manually verified. Use `fake-indexeddb/auto` for tests that need VFS. Current count: 1238 tests across 68 files.
- **Logging**: createLogger('namespace') from src/core/logger.ts. Level-filtered, DEBUG in dev, ERROR in prod. Uses __DEV__ global (set by Vite define).
- **Node shims**: Browser-bundle shims live in `src/shims/`. `empty.ts` stubs `node:zlib` and `node:module`; additional shim/polyfill files include `buffer-polyfill.ts`, `http.ts`, `https.ts`, `http2.ts`, and `stream.ts`.
- **Build-time provider composition**: Most providers are auto-discovered from pi-ai's `getProviders()` — no config files needed. `providers.build.json` controls which pi-ai providers appear in the UI (`include: ["*"]` = all, `exclude: ["*"]` = none). `src/providers/built-in/*.ts` is only for providers needing custom `register()` functions (e.g., bedrock-camp). `/providers/*.ts` (project root, gitignored) holds external providers — always included, never filtered. Discovery and registration happens in `src/providers/index.ts`, imported as a side-effect in both `main.ts` and `offscreen.ts`. To add an external provider, drop a `.ts` file into the root `providers/` directory exporting `config: ProviderConfig` and optionally `register(): void`. OAuth providers set `isOAuth: true` and define `onOAuthLogin`/`onOAuthLogout` callbacks; the generic `OAuthLauncher` from `src/providers/oauth-service.ts` handles the transport (popup or chrome.identity).
- **Multi-provider auth**: Provider settings in `src/ui/provider-settings.ts`. Supports Anthropic (direct), Azure AI Foundry (Claude on Azure), Azure OpenAI (GPT), AWS Bedrock, and many more via pi-ai. Provider/API key/baseUrl stored in localStorage. Model resolved via `resolveCurrentModel()` with baseUrl override. Accounts can be pre-configured via `providers.json` at the project root (bundled at build time via `import.meta.glob`, gitignored, and denied from Claude Code's `Read` tool via `.claude/settings.json`). OAuth providers store `accessToken`/`refreshToken`/`userName` in the `Account` interface; `getApiKeyForProvider()` returns `accessToken` when present.
- **Generic OAuth service** (`src/providers/oauth-service.ts`): Provides `createOAuthLauncher()` — the transport layer for any OAuth provider. Two runtime implementations: CLI mode opens a popup → `/auth/callback` → `postMessage` with redirect URL back to opener; extension mode routes through the service worker → `chrome.identity.launchWebAuthFlow`. Providers define `onOAuthLogin(launcher, onSuccess)` and optionally `onOAuthLogout()` callbacks on their `ProviderConfig` (in `src/providers/types.ts`). The UI calls these callbacks directly — no CustomEvent coupling. The `OAuthLauncher` type signature: `(authorizeUrl: string) => Promise<string | null>` (returns the redirect URL or null on cancel/timeout).
- **Extension detection**: `typeof chrome !== 'undefined' && !!chrome?.runtime?.id` — used throughout to select CDP transport, layout mode, fetch strategy, JS tool sandbox mechanism, and Pyodide loading path.
- **Dual-mode compatibility**: New features MUST work in both standalone CLI mode and Chrome extension mode. Extension CSP blocks dynamic eval and CDN fetches. Pattern: use sandbox iframe (`sandbox.html`) for dynamic code execution, `chrome.runtime.getURL()` + fetch for bundled WASM/assets, and three-branch detection (Node/Extension/Browser) for resource loading. Bundle extension assets in `vite.config.extension.ts` `closeBundle` hook. Always test in both modes.
- **Extension `window.open()` returns `null`**: In extension contexts (offscreen document, side panel), `window.open()` returns `null` even when the tab opens successfully. Never treat a `null` return as a failure — fire-and-forget the call. This applies to all code paths that open tabs from extension pages.
- **Two CLAUDE.md files**: The project root `CLAUDE.md` is for Claude Code (developer guidance). The file at `src/defaults/shared/CLAUDE.md` is the agent's system-level instructions — it gets bundled into the VFS at `/shared/CLAUDE.md` and is loaded into sliccy's context. When changing agent behavior or documenting agent-facing capabilities (like shell commands the agent uses), update `src/defaults/shared/CLAUDE.md`. When changing developer conventions or architecture docs, update the project root `CLAUDE.md`.
- **Default VFS content**: `src/defaults/` contains files bundled into the VFS at startup via `import.meta.glob`. Structure: `src/defaults/shared/CLAUDE.md` → `/shared/CLAUDE.md`, `src/defaults/workspace/skills/` → `/workspace/skills/`. When adding default skills or agent config, add files here.
- **Preview URL helper**: `toPreviewUrl(vfsPath)` in `src/shell/supplemental-commands/shared.ts` constructs the correct preview service worker URL for both CLI (`http://localhost:3000/preview/...`) and extension (`chrome-extension://.../preview/...`) modes. Use this instead of inlining the dual-mode URL logic.
- **Custom API providers require dual registration**: Provider auto-discovery runs via `src/providers/index.ts`, imported in **both** `src/ui/main.ts` (CLI entry point) and `src/extension/offscreen.ts` (extension agent engine). The extension agent runs in the offscreen document — `main.ts` only runs in the side panel UI. External providers in `/providers/*.ts` are automatically included.

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
npm run typecheck          # Browser + Node targets
npm run test               # Vitest (all tests)
npm run build              # Production build (UI via Vite + CLI/Electron Node target via TSC)
npm run build:extension    # Extension build (Vite with extension config)
```
Do not skip any. A typecheck pass does not guarantee the builds succeed (Vite bundling can fail independently). See `docs/development.md` for the full checklist.

**CI**: These same four gates run automatically on every PR to `main` via GitHub Actions (`.github/workflows/ci.yml`).

**Worker deploy CI**: the tray hub uses `.github/workflows/worker.yml` for both staging and production. It does not require separate GitHub environments: use the repo-level `CLOUDFLARE_API_TOKEN` secret plus `CLOUDFLARE_ACCOUNT_ID` variable, and let `cloudflare/wrangler-action` provide the deployed URL for `src/worker/deployed.test.ts`.

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
