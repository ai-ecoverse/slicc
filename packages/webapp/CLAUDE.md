# CLAUDE.md

This file covers the browser application in `packages/webapp/`. Keep extension-only behavior in `packages/chrome-extension/CLAUDE.md` and runtime/server details in the float-specific package guides.

## Scope

`packages/webapp/src/` contains the browser app core: VFS, shell, git, CDP, tools, providers, skills, scoops, and the UI.

## Architecture

### Layer Stack

```text
Virtual Filesystem (fs/) → RestrictedFS → Shell (shell/) + Git (git/)
  → CDP (cdp/) → Tools (tools/) → Core Agent (core/)
    → Scoops Orchestrator (scoops/) → UI (ui/)
      → consumed by node-server and chrome-extension floats
```

### Data Flow

```text
User → ChatPanel → Orchestrator → ScoopContext.prompt() → pi-agent-core → LLM API
  → tool calls → RestrictedFS / WasmShell / BrowserAPI
  → results → agent loop → UI updates / scoop routing
```

## Key Subsystems

### Orchestrator

- Path: `packages/webapp/src/scoops/`
- `orchestrator.ts` creates and destroys scoops, routes messages, and manages shared runtime state. Exposes `observeScoop(jid, handler)` for per-scoop event taps used by the agent bridge; observers are dropped defensively by both `unregisterScoop` and `destroyScoopTab`.
- `scoop-context.ts` owns per-scoop prompt execution and filesystem/tool isolation.
- `agent-bridge.ts` wraps the orchestrator into a stable `globalThis.__slicc_agent` surface used by the `agent` shell command. Registers ephemeral sub-scoops with `notifyOnComplete: false` so spawns from any float don't trigger cone turns. Sandbox defaults: `writablePaths = [cwd, /shared/, <scratch>/, /tmp/]`, `visiblePaths = [/workspace/, invokingCwd]` unioned and de-duped; `--read-only` is pure-replace and drops both defaults.
- `skills.ts`, tray files, and scheduler files extend orchestration rather than the UI directly.

### VirtualFS

- Path: `packages/webapp/src/fs/`
- `virtual-fs.ts` provides the POSIX-like filesystem backed by LightningFS/IndexedDB.
- `restricted-fs.ts` adds path ACLs for scoop sandboxes.
- `mount-commands.ts` and `path-utils.ts` define path normalization and mount behavior.

### Shell

- Path: `packages/webapp/src/shell/`
- `wasm-shell.ts` hosts the just-bash runtime.
- `script-catalog.ts` is the shared `.jsh`/`.bsh` discovery service; it caches behind `FsWatcher` invalidation and bypasses cache for mounted trees where external changes are invisible to the watcher.
- `supplemental-commands/` contains built-in commands, including `supplemental-commands/agent-command.ts` which forwards `ctx.cwd` as `invokingCwd` and validates `<cwd>` writability via `ctx.fs.canWrite` to prevent nested-scoop sandbox escape.
- `jsh-discovery.ts` and `bsh-discovery.ts` provide the raw scans used by the shared catalog.
- `vfs-adapter.ts` bridges shell calls into the virtual filesystem and forwards `canWrite` (duck-typed so both `VirtualFS` and `RestrictedFS` back it without branching).

### CDP

- Path: `packages/webapp/src/cdp/`
- `transport.ts` defines the CDP transport interface.
- `browser-api.ts` provides the Playwright-style browser API.
- CLI and extension runtimes supply different transport implementations.

### Tools

- Path: `packages/webapp/src/tools/`
- Active surface is file tools, `bash`, and scoop/nanoclaw helpers.
- Browser automation is intentionally routed through shell commands rather than a separate tool family.

### Core Agent

- Path: `packages/webapp/src/core/`
- Built on `pi-agent-core` and `pi-ai`.
- `tool-adapter.ts` bridges legacy tool definitions into the pi-compatible tool layer.
- `session.ts` and UI session storage keep the browser runtime restorable.

### Context Compaction

- Path: `packages/webapp/src/core/context-compaction.ts`
- Handles large-context summarization, image resizing, and overflow recovery.

### UI

- Path: `packages/webapp/src/ui/`
- Vanilla TypeScript; no framework.
- `main.ts` boots standalone mode or delegates to the extension offscreen client.
- `layout.ts`, `tabbed-ui.ts`, and `tab-zone.ts` manage the main container model.
- `preview-sw.ts` serves `/preview/*` content from VFS and is built as a standalone IIFE.

### Skills

- Path: `packages/webapp/src/skills/`
- Discovers install-managed native skills from `/workspace/skills/`.
- Also discovers compatible read-only skill roots under `.agents/skills/*/SKILL.md` and `.claude/skills/*/SKILL.md`.

### Sprinkle Rendering

- Main files: `packages/webapp/src/ui/sprinkle-renderer.ts`, `sprinkle-manager.ts`, `sprinkle-discovery.ts`
- `.shtml` files are discovered from the VFS and rendered as persistent panels.
- CLI mode renders fragments directly or full docs in `srcdoc` iframes.
- Extension mode routes rendering through `sprinkle-sandbox.html`; see the extension guide for CSP specifics.

### Inline Sprinkles

- Main file: `packages/webapp/src/ui/inline-sprinkle.ts`
- Hydrates assistant `shtml` code blocks into sandboxed iframes after streaming completes.
- Uses a minimal lick bridge and auto-height reporting.

## Key Conventions

- **Two type systems**: legacy tool definitions in `tools/` and pi-compatible tools in `core/`; bridge them through `tool-adapter.ts`.
- **Logging**: use `createLogger('namespace')` from `packages/webapp/src/core/logger.ts`.
- **Extension detection**: `typeof chrome !== 'undefined' && !!chrome?.runtime?.id`.
- **Dual-mode compatibility**: browser features must work in both standalone/CLI and extension runtimes.
- **Model IDs**: use pi-ai aliases such as `claude-opus-4-6`, not dated snapshot names.
- **Provider composition**: providers are auto-discovered from pi-ai plus `packages/webapp/src/providers/built-in/`; external provider configs live in `packages/webapp/providers/`, and build-time filtering lives in `packages/dev-tools/providers.build.json`.

## VFS API Patterns

- Prefer absolute VFS paths such as `/workspace/...` and `/shared/...`.
- `VirtualFS.create({ dbName, wipe })` is the entry point for isolated testable instances.
- Mounted directories bridge directly to `FileSystemDirectoryHandle`; do not copy large trees into IndexedDB unless you mean to.
- Use `fs.walk()` and the helper utilities in `path-utils.ts` instead of ad hoc path splitting.
- `RestrictedFS` is the correct boundary when code should not see the whole VFS.

## Shell Command Authoring

### `.jsh` commands

- `.jsh` files are JavaScript shell scripts discovered anywhere on the VFS.
- Command name is the basename without `.jsh`.
- `packages/webapp/src/shell/script-catalog.ts` shares discovery across `WasmShell`, `which`, and other lookup paths. Raw scanning still comes from `jsh-discovery.ts`, which scans `/workspace/skills` first, then the wider VFS.
- Scripts run in an async wrapper: prefer top-level `await` and always `await fs.*` operations.

### `.bsh` browser scripts

- `.bsh` files are JavaScript browser-navigation helpers that run in the **target browser page context** via CDP `Runtime.evaluate`.
- Scripts have access to `document`, `window`, and all page globals — NOT `process`/`fs`/`exec()`.
- Discovery roots are `/workspace` and `/shared`.
- Filename controls hostname matching:
  - `-.okta.com.bsh` → `*.okta.com`
  - `login.okta.com.bsh` → exact host match
- Optional `// @match` directives in the first 10 lines narrow matching further.
- `BshWatchdog` uses `ScriptCatalog` for matching and reads script content from VFS before evaluating it in the target page via CDP.

## Related Guides

- `packages/chrome-extension/CLAUDE.md` for extension runtime constraints
- `packages/node-server/CLAUDE.md` for the CLI/Electron float
- `docs/architecture.md` for repo-wide file maps and deeper subsystem inventories
- `docs/shell-reference.md` for command-by-command shell behavior
