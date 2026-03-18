# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build and Development Commands

```bash
npm run dev:full        # Full dev mode: Vite HMR + Chrome + CDP proxy (port 3000)
npm run dev:full -- --prompt "mount /tmp"  # Auto-submit prompt (clears history/fs first)
npm run dev:electron -- /Applications/Slack.app  # Electron attach mode
npm run dev             # Vite dev server only (no Chrome/CDP)
npm run build           # Production build (UI via Vite + CLI/Electron via TSC)
npm run build:extension # Build extension into dist/extension/
npm run typecheck       # Typecheck browser + Node targets
npm run test            # Vitest run (all tests)
npx vitest run src/fs/virtual-fs.test.ts  # Single test file
```

### Automated Testing with `--prompt`

The `--prompt` flag auto-submits a prompt when the UI loads, clearing chat history and filesystem first. Useful for testing agent flows without manual interaction:

```bash
npm run dev:full -- --prompt "mount /tmp"     # Test mount approval UI
npm run dev:full -- --prompt "ls /workspace"  # Test any agent command
```

Console logs from the browser are forwarded to the CLI terminal for debugging.

**Requires Node >= 22** (LTS). Ports: 3000 (UI), 9222 (Chrome CDP), 9223 (Electron CDP), 24679 (Vite HMR)

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

**Shell** (`src/shell/`): WasmShell wraps just-bash 2.11.7 (WASM). 78+ commands including `git`, `node -e`, `python3 -c`, `playwright-cli`, `open`, `serve`, `sqlite3`, `convert`, `pdftk`, `skill`, `upskill`, `webhook`, `crontask`, `mount`, `oauth-token`. Any `*.jsh` file on VFS is auto-discovered as a command. Extension CSP workaround: dynamic code routes through `sandbox.html`.

**CDP** (`src/cdp/`): `CDPTransport` interface with WebSocket (CLI) and `chrome.debugger` (extension) implementations. `BrowserAPI` provides Playwright-style API (listPages, navigate, screenshot, evaluate, click, etc.). Screenshots normalize DPR to 1.

**Tools** (`src/tools/`): Active tool surface: `read_file`, `write_file`, `edit_file`, `bash`, `javascript`, plus NanoClaw tools (`send_message`, cone-only: `list_scoops`, `scoop_scoop`, `feed_scoop`, `drop_scoop`, `update_global_memory`). Browser automation goes through shell commands via `bash`.

**Core Agent** (`src/core/`): Uses pi-agent-core for agent loop, pi-ai for LLM streaming. `tool-adapter.ts` bridges legacy ToolDefinition to pi-compatible AgentTool. `SessionStore` persists conversations to IndexedDB.

**Context Compaction** (`src/core/context-compaction.ts`): LLM-summarized compaction at ~183K tokens. Images auto-resized before LLM (5MB base64 limit). Overflow recovery replaces oversized messages (>40K chars) with placeholders.

**UI** (`src/ui/`): Vanilla TypeScript, no framework. Extension mode: compact tabbed interface. Standalone: resizable split layout. `main.ts` delegates to `mainExtension()` (OffscreenClient) or bootstraps Orchestrator directly.

**Extension** (`src/extension/`): Service worker relays messages + proxies chrome.debugger. Offscreen document runs agent engine (survives side panel close). Chat persistence: `browser-coding-agent` IndexedDB is single source of truth.

**Preview SW** (`src/ui/preview-sw.ts`): Intercepts `/preview/*` requests, serves VFS content. Built as IIFE via esbuild (not rollup — avoids code-splitting issues in SWs).

**Sprinkle Rendering** (`src/ui/sprinkle-renderer.ts`): Renders `.shtml` files as interactive UI panels in sandbox iframes. See the sprinkles skill (`src/defaults/workspace/skills/sprinkles/`) for rendering modes, bridge API, and style guide.

**Skills** (`src/skills/`, `src/scoops/skills.ts`): SKILL.md files in `/workspace/skills/` auto-load into system prompt. Installation engine supports manifest-based packages with dependency/conflict checking.

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

## Git Integration (src/git/)
isomorphic-git with LightningFS. Auth: `git config github.token <PAT>`. CORS: CLI routes through `/api/fetch-proxy`, extension uses direct fetch.
