# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build and Development Commands

```bash
npm run dev:full        # Full dev mode: Vite HMR + Chrome + CDP proxy (port 5710)
npm run dev:full -- --prompt "mount /tmp"  # Auto-submit prompt (clears history/fs first)
npm run dev:electron -- /Applications/Slack.app  # Electron attach mode
npm run dev             # Vite dev server only (no Chrome/CDP)
npm run qa:setup        # Build dist/extension and scaffold dedicated leader/follower/extension Chrome QA profiles
npm run qa:leader       # Launch CLI dev mode with the isolated leader Chrome profile, auto-connected to staging tray hub
npm run qa:follower     # Launch CLI dev mode with the isolated follower Chrome profile
npm run qa:extension    # Rebuild/load the unpacked extension in the isolated extension Chrome profile
npm run build           # Production build (UI via Vite + CLI/Electron via TSC)
npm run build:extension # Build extension into dist/extension/
npm run typecheck       # Typecheck browser + Node targets
npm run test            # Vitest run (all tests)
npx vitest run src/fs/virtual-fs.test.ts  # Single test file
npx wrangler dev        # Run the Cloudflare Worker tray hub locally (requires Wrangler)
npx wrangler deploy --env staging  # Deploy the staging tray hub
npx wrangler deploy     # Deploy the Cloudflare Worker tray hub
WORKER_BASE_URL=https://... npx vitest run src/worker/deployed.test.ts  # Smoke-test a deployed tray hub
```

### Automated Testing with `--prompt`

The `--prompt` flag auto-submits a prompt when the UI loads, clearing chat history and filesystem first. Useful for testing agent flows without manual interaction:

```bash
npm run dev:full -- --prompt "mount /tmp"     # Test mount approval UI
npm run dev:full -- --prompt "ls /workspace"  # Test any agent command
```

Console logs from the browser are forwarded to the CLI terminal for debugging.

**Requires Node >= 22** (LTS). Ports: 5710 (UI), 9222 (Chrome CDP), 9223 (Electron CDP), 24679 (Vite HMR)

## Philosophy

1. **The Claw Pattern**: SLICC is a persistent orchestration layer ("claw") on top of LLM agents, running in the browser. Agent engine is [Pi](https://github.com/badlogic/pi-mono) (pi-agent-core, pi-ai).
2. **Agents Love the CLI**: Shell-first core — new capabilities should be shell commands, not dedicated tools. MCP burns context tokens; CLI tools compose naturally.
3. **The Browser is the OS**: All logic/state runs client-side. Server is a stateless relay. Prefer browser-native APIs (IndexedDB, Service Workers, WASM, fetch).

## Principles

1. **Virtual CLIs over dedicated tools** — Shell commands first. Only create dedicated tools if bash can't do it.
2. **Browser-first** — State in IndexedDB. Server only does what browsers physically cannot.
3. **Minimal server** — Extension float has zero server. That's the target.
4. **Skills over hardcoded features** — New agent capabilities should be SKILL.md files, not code changes.

## Concepts (Ice Cream Vocabulary)

- **Cone**: Main agent ("sliccy"). Full filesystem access, all tools. Code: `orchestrator.ts`, `RegisteredScoop` with `isCone: true`.
- **Scoops**: Isolated sub-agents with sandboxed filesystem (`/scoops/{name}/` + `/shared/`), own shell/conversation. Tools: `scoop_scoop`, `feed_scoop`, `drop_scoop`. Code: `scoop-context.ts`, `restricted-fs.ts`.
- **Licks**: External events triggering scoops (webhooks, cron tasks). Code: `LickManager`, `LickEvent`. Shell: `webhook`, `crontask`.
- **Floats**: Runtime environments — CLI (`src/cli/`), Extension (`src/extension/`), Electron (`src/cli/electron-main.ts`), Cloud (planned).

Use ice cream terms over technical jargon (e.g., "feed_scoop" not "delegate_to_scoop").

## Architecture

Browser-based AI coding agent running as Chrome extension (side panel), standalone CLI server, or Electron float.

### Three Deployment Modes

- **Chrome extension** (Manifest V3): Three-layer — side panel (UI), service worker (relay + CDP proxy), offscreen document (agent engine). Agent survives side panel close.
- **Standalone CLI**: Express server launches Chrome, proxies CDP. Split layout with scoops + chat + terminal + files/memory.
- **Electron float**: Reuses CLI server in `--serve-only` mode, injects overlay shell.

### Layer Stack

```
Virtual Filesystem (src/fs/) → RestrictedFS → Shell (src/shell/) + Git (src/git/)
  → CDP (src/cdp/) → Tools (src/tools/) → Core Agent (src/core/)
    → Scoops Orchestrator (src/scoops/) → UI (src/ui/)
      → CLI/Electron (src/cli/) | Extension (src/extension/)
```

### Build Targets

- **Browser bundle** (tsconfig.json): Everything except src/cli/. Bundled by Vite.
- **CLI/Electron** (tsconfig.cli.json): Only src/cli/. Compiled by TSC to dist/cli/.
- **Extension** (vite.config.extension.ts): Browser bundle + extension entry points + bundled Pyodide.

### Key Subsystems

**Orchestrator** (`src/scoops/orchestrator.ts`): Creates/destroys scoops, routes messages, manages VFS. Cone delegates via `feed_scoop` — scoops get complete self-contained prompts (no access to cone's conversation).

**VirtualFS** (`src/fs/`): POSIX-like async FS backed by LightningFS (IndexedDB). `RestrictedFS` wraps it with path ACLs for scoops. `FsError` carries POSIX error codes.

**Shell** (`src/shell/`): WasmShell wraps just-bash 2.11.7 (WASM). 78+ commands including `git`, `node -e`, `python3 -c`, `playwright-cli`, `open`, `serve`, `sqlite3`, `convert`, `pdftk`, `skill`, `upskill`, `webhook`, `crontask`, `mount`, `oauth-token`. Any `*.jsh` or `*.bsh` file on VFS is auto-discovered as a command. Extension CSP workaround: dynamic code routes through `sandbox.html`.

Cloud tray hub scaffold:
- **Cloudflare Worker / Durable Object** (`wrangler.jsonc` + `src/worker/`): separate Wrangler-managed runtime for `POST /tray`, controller attach, leader-only WebSocket control, deployed smoke tests, and webhook forwarding via `POST /webhook/:token/:webhookId`.

**CDP** (`src/cdp/`): `CDPTransport` interface with WebSocket (CLI) and `chrome.debugger` (extension) implementations. `BrowserAPI` provides Playwright-style API (listPages, navigate, screenshot, evaluate, click, etc.). Screenshots normalize DPR to 1.

**Tools** (`src/tools/`): Active tool surface: `read_file`, `write_file`, `edit_file`, `bash`, `javascript`, plus NanoClaw tools (`send_message`, cone-only: `list_scoops`, `scoop_scoop`, `feed_scoop`, `drop_scoop`, `update_global_memory`). Browser automation goes through shell commands via `bash`.

**Core Agent** (`src/core/`): Uses pi-agent-core for agent loop, pi-ai for LLM streaming. `tool-adapter.ts` bridges legacy ToolDefinition to pi-compatible AgentTool. `SessionStore` persists conversations to IndexedDB.

**Context Compaction** (`src/core/context-compaction.ts`): LLM-summarized compaction at ~183K tokens. Images auto-resized before LLM (5MB base64 limit). Overflow recovery replaces oversized messages (>40K chars) with placeholders.

**UI** (`src/ui/`): Vanilla TypeScript, no framework. Extension mode: compact tabbed interface. Standalone: resizable split layout. `main.ts` delegates to `mainExtension()` (OffscreenClient) or bootstraps Orchestrator directly.

**Extension** (`src/extension/`): Service worker relays messages + proxies chrome.debugger. Offscreen document runs agent engine (survives side panel close). Chat persistence: `browser-coding-agent` IndexedDB is single source of truth.

**Preview SW** (`src/ui/preview-sw.ts`): Intercepts `/preview/*` requests, serves VFS content. Built as IIFE via esbuild (not rollup — avoids code-splitting issues in SWs).

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
- `rsync` — Sync files between local VFS and a remote tray runtime. Push: `rsync /local runtime-id:/remote`. Pull: `rsync runtime-id:/remote /local`. Flags: `--dry-run`, `--delete`, `--verbose`.
- `teleport` — Teleport browser cookies from a remote tray runtime to the local browser. Auto-selects best follower (prefers standalone floats) or target a specific runtime. Usage: `teleport` (auto), `teleport <runtime-id>` (specific), `teleport --list` (list runtimes), `teleport --url <url>` (open URL on follower for interactive auth). When `--url` is provided, the follower opens a browser tab for the human to complete login; cookies are captured after auth completion (hostname redirect) or a 2-minute timeout. Flags: `--no-reload` to skip page reload after applying cookies.
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

**BSH Scripts** (`src/shell/bsh-discovery.ts`, `src/shell/bsh-watchdog.ts`): `.bsh` (Browser Shell) files are JavaScript files that auto-execute when the browser navigates to a matching hostname. They use the same jsh-executor engine as `.jsh` files (same globals: `process`, `console`, `fs`, `exec()`).
- **Filename convention**: The filename encodes the hostname pattern. `-.okta.com.bsh` → matches `*.okta.com` (dash-dot prefix = wildcard). `login.okta.com.bsh` → matches `login.okta.com` exactly.
- **`// @match` directive**: Optional URL pattern restriction in the first 10 lines. Example: `// @match *://login.okta.com/app/*`. If present, the URL must match at least one pattern in addition to the hostname.
- **Auto-discovery**: `bsh-discovery.ts` scans `/workspace/` and `/shared/` on the VFS for `*.bsh` files.
- **BshWatchdog** (`bsh-watchdog.ts`): Monitors `Page.frameNavigated` CDP events on attached browser tabs. When a main-frame navigation occurs, it matches the URL against discovered `.bsh` entries and executes matching scripts. Periodically re-discovers `.bsh` files (default: 30s). Prevents re-entrant execution for the same script+URL combo.

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

**Sprinkle Rendering** (`src/ui/sprinkle-renderer.ts`): Renders `.shtml` files as interactive UI panels in sandbox iframes. See the sprinkles skill (`src/defaults/workspace/skills/sprinkles/`) for rendering modes, bridge API, and style guide.

### Data Flow

```
User → ChatPanel → Orchestrator → ScoopContext.prompt() → pi-agent-core → LLM API
  → Tool calls → RestrictedFS / WasmShell / BrowserAPI → results → back to agent loop
  → Scoop completes → Orchestrator → Cone's message queue
```

## Key Conventions

- **Two type systems**: Legacy ToolDefinition (src/tools/) and pi-compatible AgentTool (src/core/). Bridged by `tool-adapter.ts`.
- **Colocated tests**: `foo.test.ts` next to `foo.ts`. Vitest, globals: true, environment: node. Use `fake-indexeddb/auto` for VFS tests.
- **Logging**: `createLogger('namespace')` from `src/core/logger.ts`. DEBUG in dev, ERROR in prod.
- **Extension detection**: `typeof chrome !== 'undefined' && !!chrome?.runtime?.id`
- **Dual-mode compatibility**: Features MUST work in both CLI and extension. Extension CSP blocks eval/CDN — use `sandbox.html` for dynamic code, `chrome.runtime.getURL()` for bundled assets.
- **Extension `window.open()` returns `null`**: Fire-and-forget; don't treat null as failure.
- **Model ID aliases**: Use pi-ai aliases (e.g., `claude-opus-4-6`) not dated snapshot IDs.
- **Provider composition**: Auto-discovered from pi-ai. External providers: drop `.ts` in root `providers/`. OAuth via `createOAuthLauncher()` in `src/providers/oauth-service.ts`. Registration runs in both `main.ts` and `offscreen.ts`.
- **Two CLAUDE.md files**: This one (project root) is for Claude Code. `src/defaults/shared/CLAUDE.md` is for the agent (bundled to `/shared/CLAUDE.md`).
- **Default VFS content**: `src/defaults/` bundled into VFS via `import.meta.glob`.
- **Preview URLs**: Use `toPreviewUrl(vfsPath)` from `src/shell/supplemental-commands/shared.ts`.

## Change Requirements

Every change MUST satisfy three gates: **tests**, **docs**, and **verification**.

### Tests
New pure-logic code MUST have colocated tests (`foo.test.ts`). See `docs/testing.md`.

### Documentation

| Tier | File | Update when... |
|------|------|----------------|
| **Public** | `README.md` | User-facing changes |
| **Development** | `CLAUDE.md` | Developer conventions, architecture, build changes |
| **Agent reference** | `docs/` | Agent-facing tools, commands, patterns |

### Verification
All four must pass before committing:
```bash
npm run typecheck
npm run test
npm run build
npm run build:extension
```
**CI**: Same four gates run on every PR via `.github/workflows/ci.yml`.

**Worker deploy CI**: the tray hub uses `.github/workflows/worker.yml` for both staging and production. It does not require separate GitHub environments: use the repo-level `CLOUDFLARE_API_TOKEN` secret plus `CLOUDFLARE_ACCOUNT_ID` variable, and let `cloudflare/wrangler-action` provide the deployed URL for `src/worker/deployed.test.ts`.

## Git Integration (src/git/)
isomorphic-git with LightningFS. Auth: `git config github.token <PAT>`. CORS: CLI routes through `/api/fetch-proxy`, extension uses direct fetch.
