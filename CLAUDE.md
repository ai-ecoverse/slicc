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

**Orchestrator** (`src/scoops/orchestrator.ts`): Creates/destroys scoops, routes messages, and manages the VFS. Cone delegation via `feed_scoop` is intentionally self-contained.

**VirtualFS** (`src/fs/`): POSIX-like async FS on LightningFS/IndexedDB. `RestrictedFS` enforces scoop ACLs and `FsError` carries POSIX codes.

**Shell** (`src/shell/`): WasmShell over just-bash. Prefer shell commands over bespoke tools. Important built-ins include `playwright-cli`, `open`, `serve`, `git`, `webhook`, `crontask`, `mount`, `oauth-token`, `convert`, `sqlite3`, and `rsync`. Any `*.jsh` file on the VFS becomes a command; `*.bsh` files auto-run on matching browser navigations. Extension mode routes dynamic JS through `sandbox.html` and loads Pyodide/ImageMagick from bundled assets.

**Skills** (`src/scoops/skills.ts`, `src/skills/`): Skills in `/workspace/skills/` are prompt-injected from `SKILL.md`; the install engine also supports manifests, dependency/conflict checks, uninstall, and dropped `.skill` bundles. Default skills come from `src/defaults/workspace/skills/`.

**Tray / worker** (`wrangler.jsonc`, `src/worker/`): Cloudflare Worker + Durable Object tray hub handles `POST /tray`, controller attach, leader-only WebSocket control, webhook forwarding via `POST /webhook/:token/:webhookId`, and deployed smoke tests.

### CDP (src/cdp/)
`CDPTransport` abstracts CLI WebSocket transport and extension `chrome.debugger` transport. `BrowserAPI` sits on top for Playwright-style tab automation and normalizes screenshot DPR.

When a tray is connected, `BrowserAPI` can expose remote tabs via federated targets (`TrayTargetProvider`, `listAllTargets()`). Remote targets use `runtimeId:localTargetId`, and `attachToPage()` swaps to `RemoteCDPTransport`, which tunnels CDP over the tray WebRTC data channel between leader/follower runtimes.

Teleport is built into the shell/browser path: `playwright teleport --start=<regex> --return=<regex>` (or equivalent flags on `open`, `tab-new`, `goto`) hands auth to a follower and restores cookies + storage back into the leader. Keep this flow accurate when changing tray/browser code.

### Tools (src/tools/)
Legacy `ToolDefinition` objects are adapted to pi-compatible tools by `tool-adapter.ts`. Active scoop/cone tools are `read_file`, `write_file`, `edit_file`, `bash`, `javascript`, and NanoClaw messaging tools. Active agents should do browser automation and search via shell commands (`playwright-cli`, `rg`, `grep`, `find`) rather than expanding the dedicated tool surface.

### Core Agent (src/core/)
Built on `@mariozechner/pi-agent-core` + `@mariozechner/pi-ai`. Important files are `tool-adapter.ts`, `tool-registry.ts`, `context-compaction.ts`, and `session.ts`. Sessions persist in IndexedDB (`agent-sessions`) per scoop JID so agents can resume after restarts.

### Context Compaction
Compaction kicks in near the 200K context window (~183K usable after reserve), preserves recent turns, avoids splitting assistant/tool pairs, and falls back if summary generation fails. Image inputs are validated/resized before the LLM; overflow/image errors trigger one recovery retry in `scoop-context.ts`. The deep-import/Vite alias wiring for pi compaction/overflow helpers is intentional.

### UI / Runtimes
Vanilla TS UI. Standalone mode uses a resizable split layout; extension mode uses a compact tabbed layout; Electron reuses the CLI server in `--serve-only` and injects the overlay shell from `src/ui/electron-overlay.ts`. `main.ts` boots the Orchestrator directly in CLI/Electron and delegates to `mainExtension()` in extension mode.

### Extension (src/extension/)
Manifest V3 extension uses a three-layer design: side panel UI, service worker relay/CDP proxy, and offscreen document running the agent engine so work survives panel close. `offscreen-cdp-proxy.ts` / `panel-cdp-proxy.ts` bridge browser automation through the service worker. `browser-coding-agent` IndexedDB is the display-message source of truth; `agent-sessions` stores LLM history; `slicc-groups` stores orchestrator state.

### Preview Service Worker (src/ui/preview-sw.ts)
Serves `/preview/*` from the VFS so generated apps can open in real tabs. Keep it as a self-contained esbuild IIFE; rollup code-splitting breaks service-worker imports.

### CLI Server (src/cli/index.ts)
Express server launches Chrome with remote debugging, serves the app, proxies CDP at `/cdp`, exposes `/api/fetch-proxy` and `/auth/callback`, and is reused by Electron. QA profiles live under `.qa/chrome/*`.

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
