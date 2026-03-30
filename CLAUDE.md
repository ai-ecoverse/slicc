# CLAUDE.md

This root file is the repo navigation hub. Keep package-specific architecture and implementation detail in the nearest package `CLAUDE.md`, and keep fast-changing how-to material in `docs/`.

## Module Map

### Packages

| Path                          | Purpose                                                                              |
| ----------------------------- | ------------------------------------------------------------------------------------ |
| `packages/webapp/`            | Browser app core: UI, VFS, shell, CDP, tools, providers, skills, scoops              |
| `packages/chrome-extension/`  | Manifest V3 extension entry points, HTML shells, and message bridges                 |
| `packages/cloudflare-worker/` | Tray hub worker for session coordination, signaling, and TURN credentials            |
| `packages/node-server/`       | Node.js CLI/Electron server: Chrome launch, CDP proxy, dev serving                   |
| `packages/vfs-root/`          | Default VFS content copied into the app on init/reset                                |
| `packages/swift-launcher/`    | Native macOS SwiftUI launcher app (`Sliccstart`)                                     |
| `packages/swift-server/`      | Native macOS Hummingbird server (`slicc-server`)                                     |
| `packages/dev-tools/`         | Repo-level tooling guidance for build helpers, QA setup, configs, and test utilities |
| `packages/assets/`            | Shared static files (logos, fonts, favicon) used by multiple packages                |

### Other Top-Level Directories

| Path                | Purpose                                                                                   |
| ------------------- | ----------------------------------------------------------------------------------------- |
| `docs/`             | Long-form developer and agent reference docs, including screenshots and other docs assets |
| `packages/*/tests/` | Per-package TypeScript/Vitest tests mirrored by subsystem                                 |
| `dist/`             | Generated build output; do not hand-edit                                                  |

## Top-Level Commands

```bash
npm install                              # Install dependencies (first time)
npm run build                            # Production build (all workspaces)
npm run build -w @slicc/webapp           # UI-only build (faster for UI changes)
npm run build -w @slicc/chrome-extension # Chrome extension build into dist/extension/
npm run test                             # Vitest run
npm run typecheck                        # Browser + Node typecheck
npm run dev                              # Dev mode with Vite HMR + Chrome + CDP
```

For runtime-specific commands, use the nearest guide:

- [`packages/webapp/CLAUDE.md`](packages/webapp/CLAUDE.md)
- [`packages/chrome-extension/CLAUDE.md`](packages/chrome-extension/CLAUDE.md)
- [`packages/cloudflare-worker/CLAUDE.md`](packages/cloudflare-worker/CLAUDE.md)
- [`packages/node-server/CLAUDE.md`](packages/node-server/CLAUDE.md)
- [`packages/vfs-root/CLAUDE.md`](packages/vfs-root/CLAUDE.md)
- [`packages/swift-launcher/CLAUDE.md`](packages/swift-launcher/CLAUDE.md)
- [`packages/swift-server/CLAUDE.md`](packages/swift-server/CLAUDE.md)
- [`packages/dev-tools/CLAUDE.md`](packages/dev-tools/CLAUDE.md)
- [`docs/CLAUDE.md`](docs/CLAUDE.md)

## Cross-Cutting Principles

### Philosophy

1. **The Claw Pattern**: SLICC is a persistent orchestration layer over LLM agents, centered in the browser.
2. **Agents Love the CLI**: Prefer shell commands and composable command surfaces over bespoke tools.
3. **The Browser is the OS**: Keep state client-side and use server code only for work browsers cannot do themselves.

### Ice Cream Vocabulary

- **Cone**: the main agent.
- **Scoops**: isolated sub-agents with sandboxed filesystems.
- **Licks**: external events such as webhooks or cron tasks.
- **Floats**: runtime environments such as CLI, extension, Electron, and cloud.

Use the ice cream terms in code review comments and docs when they match the domain.

## Git Conventions

- Keep commits focused and package-local when possible.
- Do not hand-edit generated output in `dist/`.
- Webapp git behavior is implemented with `isomorphic-git` over LightningFS.
- Auth uses `git config github.token <PAT>`.
- Network behavior differs by runtime: CLI routes git/fetch traffic through `/api/fetch-proxy`; the extension uses direct fetch.

**Requires Node >= 22** (LTS). Ports: 5710 (UI), 9222 (Chrome CDP), 9223 (Electron CDP), 24679 (Vite HMR)

### Parallel Instances

Multiple standalone SLICC instances can run simultaneously. All ports auto-resolve to avoid conflicts — just override the UI port:

```bash
PORT=5720 npm run dev   # Second instance on port 5720
PORT=5730 npm run dev   # Third instance on port 5730
```

Each instance gets an isolated Chrome profile (keyed by port), separate CDP port (auto-detected), and separate HMR port. No shared state between instances.

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
- **Floats**: Runtime environments — CLI (`packages/node-server/src/`), Extension (`packages/chrome-extension/src/`), Electron (`packages/node-server/src/electron-main.ts`), Sliccstart (`packages/swift-launcher/` — native macOS launcher), Cloud (planned).

Use ice cream terms over technical jargon (e.g., "feed_scoop" not "delegate_to_scoop").

## Architecture

Browser-based AI coding agent running as Chrome extension (side panel), standalone CLI server, or Electron float.

### Three Deployment Modes

- **Chrome extension** (Manifest V3): Three-layer — side panel (UI), service worker (relay + CDP proxy), offscreen document (agent engine). Agent survives side panel close.
- **Standalone CLI**: Express server launches Chrome, proxies CDP. Split layout with scoops + chat + terminal + files/memory.
- **Electron float**: Reuses CLI server in `--serve-only` mode, injects overlay shell.

### Layer Stack

```
Virtual Filesystem (packages/webapp/src/fs/) → RestrictedFS → Shell (packages/webapp/src/shell/) + Git (packages/webapp/src/git/)
  → CDP (packages/webapp/src/cdp/) → Tools (packages/webapp/src/tools/) → Core Agent (packages/webapp/src/core/)
    → Scoops Orchestrator (packages/webapp/src/scoops/) → UI (packages/webapp/src/ui/)
      → CLI/Electron (packages/node-server/src/) | Extension (packages/chrome-extension/src/)
```

### Build Targets

- **Browser bundle** (tsconfig.json): Everything except `packages/node-server/src/`. Bundled by Vite.
- **CLI/Electron** (tsconfig.cli.json): Only `packages/node-server/src/`. Compiled by TSC to dist/node-server/.
- **Extension** (packages/chrome-extension/vite.config.ts): Browser bundle + extension entry points + bundled Pyodide.

### Key Subsystems

**Orchestrator** (`packages/webapp/src/scoops/orchestrator.ts`): Creates/destroys scoops, routes messages, manages VFS. Cone delegates via `feed_scoop` — scoops get complete self-contained prompts (no access to cone's conversation).

**VirtualFS** (`packages/webapp/src/fs/`): POSIX-like async FS backed by LightningFS (IndexedDB). `RestrictedFS` wraps it with path ACLs for scoops. `FsError` carries POSIX error codes.

**Shell** (`packages/webapp/src/shell/`): WasmShell wraps just-bash 2.11.7 (WASM). 78+ commands including `git`, `node -e`, `python3 -c`, `playwright-cli`, `open`, `serve`, `sqlite3`, `convert`, `pdftk`, `skill`, `upskill`, `webhook`, `crontask`, `mount`, `oauth-token`, `debug`. Any `*.jsh` file on VFS is auto-discovered as a command. Extension CSP workaround: dynamic code routes through `sandbox.html`. **Two shell contexts in extension mode**: side panel has its own WasmShell (mounted in terminal tab), offscreen document has the agent's WasmShell (runs bash tool calls). Commands that affect the UI must handle both — use `window.__slicc_*` hooks for direct calls (panel) and `chrome.runtime.sendMessage` relay for offscreen→panel communication.

**CDP** (`packages/webapp/src/cdp/`): `CDPTransport` interface with WebSocket (CLI) and `chrome.debugger` (extension) implementations. `BrowserAPI` provides Playwright-style API (listPages, navigate, screenshot, evaluate, click, etc.). Screenshots normalize DPR to 1.

**Tools** (`packages/webapp/src/tools/`): Active tool surface: `read_file`, `write_file`, `edit_file`, `bash`, plus NanoClaw tools (`send_message`, cone-only: `list_scoops`, `scoop_scoop`, `feed_scoop`, `drop_scoop`, `update_global_memory`). Browser automation goes through shell commands via `bash`.

**Core Agent** (`packages/webapp/src/core/`): Uses pi-agent-core for agent loop, pi-ai for LLM streaming. `tool-adapter.ts` bridges legacy ToolDefinition to pi-compatible AgentTool. `SessionStore` persists conversations to IndexedDB.

**Context Compaction** (`packages/webapp/src/core/context-compaction.ts`): LLM-summarized compaction at ~183K tokens. Images auto-resized before LLM (5MB base64 limit). Overflow recovery replaces oversized messages (>40K chars) with placeholders.

**UI** (`packages/webapp/src/ui/`): Vanilla TypeScript, no framework. Extension mode: compact tabbed interface (Chat + Files visible by default; Terminal + Memory hidden — toggle with `debug on`). Standalone: resizable split layout with all panels visible. `main.ts` delegates to `mainExtension()` (OffscreenClient) or bootstraps Orchestrator directly. Tab bar is fully dynamic — `TabZone.addTab()`/`removeTab()` adds/removes tabs at runtime (used by sprinkle panels and the `debug` command).

**Extension** (`packages/chrome-extension/src/`): Service worker relays messages + proxies chrome.debugger. Offscreen document runs agent engine (survives side panel close). Chat persistence: `browser-coding-agent` IndexedDB is single source of truth. **Key architecture detail**: the extension has two separate execution contexts with independent shell instances — the side panel (UI, terminal shell, Layout) and the offscreen document (agent engine, bash tool shell, Orchestrator). They share IndexedDB but NOT window globals. Communication is via `chrome.runtime` messages routed through the service worker. See `docs/architecture.md` "Extension Three-Layer Architecture".

**Preview SW** (`packages/webapp/src/ui/preview-sw.ts`): Intercepts `/preview/*` requests, serves VFS content. Built as IIFE via esbuild (not rollup — avoids code-splitting issues in SWs).

**Sprinkle Rendering** (`packages/webapp/src/ui/sprinkle-renderer.ts`): Renders `.shtml` files as interactive UI panels. CLI mode: fragments injected into DOM directly, full documents rendered via srcdoc iframe. Extension mode: ALL content routes through `sprinkle-sandbox.html` (CSP-exempt manifest sandbox) — fragments rendered in sandbox body, full documents via nested srcdoc iframe inside sandbox. See the sprinkles skill (`packages/vfs-root/workspace/skills/sprinkles/`) for rendering modes, bridge API, and style guide.

**Inline Sprinkles** (`packages/webapp/src/ui/inline-sprinkle.ts`): Agent ` ```shtml ` code blocks in chat messages are hydrated into sandboxed iframes after streaming completes. Minimal bridge (lick-only, no state) via postMessage. Auto-height via ResizeObserver. CLI mode: direct srcdoc iframe. Extension mode: routes through `sprinkle-sandbox.html` (same CSP-exempt sandbox as panel sprinkles). Lick events route to the cone via `routeLickToScoop` (CLI) or `client.sendSprinkleLick` (extension). CSS: `.msg__inline-sprinkle` container, `.sprinkle-action-card` component.

**Skills** (`packages/webapp/src/skills/`, `packages/webapp/src/scoops/skills.ts`): native `/workspace/skills/` packages auto-load into the system prompt alongside accessible compatibility skills discovered from `.agents/skills/*/SKILL.md` and `.claude/skills/*/SKILL.md` anywhere in the reachable VFS. Only native `/workspace/skills/` entries are install-managed; compatibility roots stay read-only.

### Data Flow

```
User → ChatPanel → Orchestrator → ScoopContext.prompt() → pi-agent-core → LLM API
  → Tool calls → RestrictedFS / WasmShell / BrowserAPI → results → back to agent loop
  → Scoop completes → Orchestrator → Cone's message queue
```

### Tray / Teleport Addendum

- Tray hub code lives in `packages/cloudflare-worker/src/` with config in `wrangler.jsonc`; treat it as coordination infrastructure, not canonical session storage.
- When a tray is connected, remote browser targets are exposed through federated target routing; keep CDP local to the runtime that owns the page.
- Teleport is part of the browser/shell workflow: `playwright teleport --start=<regex> --return=<regex>` and equivalent flags on `open`, `tab-new`, and navigation commands.
- Any `*.bsh` file is a browser-navigation helper. Keep detailed behavior in docs rather than growing this root guide.

## Key Conventions

- **Two type systems**: Legacy ToolDefinition (`packages/webapp/src/tools/`) and pi-compatible AgentTool (`packages/webapp/src/core/`). Bridged by `tool-adapter.ts`.
- **Tests**: `packages/*/tests/` mirrors the `src/` structure. Vitest, globals: true, environment: node. Use `fake-indexeddb/auto` for VFS tests.
- **Logging**: `createLogger('namespace')` from `packages/webapp/src/core/logger.ts`. DEBUG in dev, ERROR in prod.
- **Extension detection**: `typeof chrome !== 'undefined' && !!chrome?.runtime?.id`
- **Dual-mode compatibility**: Features MUST work in both CLI and extension. Extension CSP blocks eval/CDN — use `sandbox.html` for dynamic code, `sprinkle-sandbox.html` for sprinkles/inline widgets, `chrome.runtime.getURL()` for bundled assets.
- **Extension `window.open()` returns `null`**: Fire-and-forget; don't treat null as failure.
- **Model ID aliases**: Use pi-ai aliases (e.g., `claude-opus-4-6`) not dated snapshot IDs.
- **Provider composition**: Auto-discovered from pi-ai. External providers: drop `.ts` in `packages/webapp/providers/`. OAuth via `createOAuthLauncher()` in `packages/webapp/src/providers/oauth-service.ts`. Registration runs in both `main.ts` and `offscreen.ts`. Providers can override model capabilities via `modelOverrides` (static) or `getModelIds()` metadata (dynamic). Three-layer merge: pi-ai → modelOverrides → getModelIds. OpenAI-compatible models route through `streamOpenAICompletions` when `api: 'openai'` is set in metadata.
- **Two CLAUDE.md files**: This one (project root) is for Claude Code. `packages/vfs-root/shared/CLAUDE.md` is for the agent (bundled to `/shared/CLAUDE.md`).
- **Default VFS content**: `packages/vfs-root/` bundled into VFS via `import.meta.glob`.
- **Preview URLs**: Use `toPreviewUrl(vfsPath)` from `packages/webapp/src/shell/supplemental-commands/shared.ts`.

## Change Requirements

Every change must satisfy **tests**, **docs**, and **verification**.

### Tests

- Add or update tests for behavior changes.
- TypeScript tests live in `packages/*/tests/`, mirrored by subsystem.
- See `docs/testing.md` for patterns and command selection.

### Documentation

| Tier            | File              | Update when...                                               |
| --------------- | ----------------- | ------------------------------------------------------------ |
| Public          | `README.md`       | User-facing behavior changes                                 |
| Development     | `CLAUDE.md` files | Developer conventions, package architecture, build workflows |
| Agent reference | `docs/`           | Detailed tools, commands, and patterns                       |

### Verification

These are the repo's CI gates and the default full verification pass before commit:

```bash
npx prettier --write <changed-files>   # Format FIRST — CI fails on unformatted code
npm run typecheck
npm run test
npm run build
npm run build -w @slicc/chrome-extension
```

**Always run Prettier before committing.** CI runs `npx prettier --check .` as a lint gate and will reject unformatted code. Run `npx prettier --write <files>` on every file you touch. This is the most common CI failure — don't skip it.

CI runs these gates in `.github/workflows/ci.yml`.
