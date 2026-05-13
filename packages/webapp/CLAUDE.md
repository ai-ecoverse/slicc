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

### Kernel Host

- Path: `packages/webapp/src/kernel/`
- `host.ts` — `createKernelHost(config)` factory. Single boot sequence shared by the offscreen document (extension), the standalone DedicatedWorker, and tests: orchestrator + lick-manager + agent-bridge + tray subs + cone bootstrap + BshWatchdog + `/proc` mount. Returns `{ orchestrator, browser, bridge, lickManager, sharedFs, processManager, dispose }`.
- `kernel-worker.ts` — DedicatedWorker entry. The standalone path defaults to this since the inline orchestrator path was removed; `?inline=1` no longer exists.
- `process-manager.ts` — `ProcessManager` tracks every long-running async unit: scoop turns, tool calls, shell execs, jsh/python scripts. Pids are uint32 from 1024+; `signal(pid, sig)` honors SIGINT/SIGTERM/SIGKILL/SIGSTOP/SIGCONT (SIGKILL escalates uncatchably).
- `proc-mount.ts` — read-only `procfs`-shaped view, mounted at `/proc` via `vfs.mountInternal` (scoop-invisible, not persisted). `cat /proc/<pid>/{status,cmdline,cwd,stat}` works from any panel terminal.
- `realm/` — generalized hard-killable runner for `node` / `.jsh` / `python`. `runInRealm({ kind: 'js' \| 'py', … })` spawns a per-task `DedicatedWorker` (standalone JS + both-mode Python) or sandbox iframe (extension JS); SIGKILL → `worker.terminate()` / `iframe.remove()`, exit 137. Kernel-side `realm-host` proxies `vfs` / `exec` / `fetch` RPC over the realm's port so realm code stays sandboxed.
- `terminal-session-{host,client}.ts` — terminal RPC over the kernel transport. Each panel-typed command spawns a `kind:'shell'` process; SIGINT routes to `pm.signal`.
- `remote-terminal-view.ts` — page-side xterm. Pre-intercepts `mount /<path>` so the keystroke gesture can drive `showDirectoryPicker` (the worker has no `window`).

Deep reference: `docs/kernel/process-model.md`.

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
- `mount-commands.ts` is the dispatcher (parses `--source` / `--profile` / `--no-probe` etc.); `path-utils.ts` defines path normalization.
- `mount/` holds the backend abstraction: `MountBackend` interface (`backend.ts`), three implementations (`backend-local.ts` wrapping FS Access, `backend-s3.ts` for S3 + S3-compatible like R2, `backend-da.ts` for da.live), the shared `RemoteMountCache` (TTL + ETag, IDB-backed), `signing-s3.ts` (pure SigV4 v4 via Web Crypto, no AWS SDK), `fetch-with-budget.ts` (timeout + retry + abort threading), and `profile.ts` (cred resolution from `s3.<profile>.*` secrets, IMS for DA). Persistence + recovery: `mount-table-store.ts` keys by `targetPath` with a `BackendDescriptor` discriminated union; `mount-recovery.ts` reconstructs backends per-kind on session restore.

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
- **Design-time chat fixture**: load the app with `?ui-fixture=1` (also accepts `?ui-fixture` or `?ui-fixture=true`) to swap the chat view for a synthetic session covering every message variant — user/assistant bubbles, markdown + code blocks, all four tool-call states, the six lick channels, delegation, queued messages, and a streaming tail. Messages live in `chat-fixture.ts` (pure `createChatFixture()`) and persist to a dedicated `session-ui-fixture` id so real scoop storage is untouched; clicking any real scoop cleanly exits fixture mode. Vite HMR picks up CSS changes live against the fixture. When adding new message UI variants, extend `createChatFixture()` and the matching assertion in `tests/ui/chat-fixture.test.ts` so the harness stays comprehensive.

### Skills

- Path: `packages/webapp/src/skills/`
- Discovers install-managed native skills from `/workspace/skills/`.
- Also discovers compatible read-only skill roots under `.agents/skills/*/SKILL.md` and `.claude/skills/*/SKILL.md`.

### Sprinkle Rendering

- Main files: `packages/webapp/src/ui/sprinkle-renderer.ts`, `sprinkle-manager.ts`, `sprinkle-discovery.ts`
- `.shtml` files are discovered from the VFS and rendered as persistent panels.
- CLI mode renders fragments directly or full docs in `srcdoc` iframes.
- Extension mode routes rendering through `sprinkle-sandbox.html`; see the extension guide for CSP specifics.

### Dips

- Main file: `packages/webapp/src/ui/dip.ts`
- Hydrates assistant `shtml` code blocks into sandboxed iframes after streaming completes.
- Uses a minimal lick bridge and auto-height reporting.

## Key Conventions

- **Two type systems**: legacy tool definitions in `tools/` and pi-compatible tools in `core/`; bridge them through `tool-adapter.ts`.
- **Logging**: use `createLogger('namespace')` from `packages/webapp/src/core/logger.ts`.
- **Extension detection**: `typeof chrome !== 'undefined' && !!chrome?.runtime?.id`.
- **Dual-mode compatibility**: browser features must work in both standalone/CLI and extension runtimes.
- **Model IDs**: use pi-ai aliases such as `claude-opus-4-6`, not dated snapshot names.
- **Provider composition**: providers are auto-discovered from pi-ai plus `packages/webapp/src/providers/built-in/`; external provider configs live in `packages/webapp/providers/`, and build-time filtering lives in `packages/dev-tools/providers.build.json`.
- **Adobe `X-Session-Id` invariant**: every LLM call to the Adobe proxy must attach the `X-Session-Id` header (`scoops/scoop-context.ts` wires it for both the agent `streamFn` and compaction `headers`). New LLM call sites — direct `streamSimple` / `completeSimple` callers, or pi-coding-agent helpers like `generateSummary` — must attach it explicitly or the proxy session-id grouping breaks. See `docs/pitfalls.md` for the full contract, tripwire, and verification SQL.

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
- Stdin from upstream pipelines is fully buffered (no streaming) and exposed two ways: a top-level `stdin` string parameter and `process.stdin.read()` / `process.stdin[Symbol.asyncIterator]()`. `process.stdin.isTTY` is always `false`. Empty when no input is piped. `node`'s read-from-stdin branch (when stdin is the script source) hands the inner script an empty stdin so it can't read its own source.

### `.bsh` browser scripts

- `.bsh` files are JavaScript browser-navigation helpers that run in the **target browser page context** via CDP `Runtime.evaluate`.
- Scripts have access to `document`, `window`, and all page globals — NOT `process`/`fs`/`exec()`.
- Discovery roots are `/workspace` and `/shared`.
- Filename controls hostname matching:
  - `-.okta.com.bsh` → `*.okta.com`
  - `login.okta.com.bsh` → exact host match
- Optional `// @match` directives in the first 10 lines narrow matching further.
- `BshWatchdog` uses `ScriptCatalog` for matching and reads script content from VFS before evaluating it in the target page via CDP.

## Secret-Aware Fetch Proxy

The webapp consumes `@slicc/shared-ts` for secret masking primitives. `createProxiedFetch()` in `packages/webapp/src/shell/proxied-fetch.ts` routes agent-initiated HTTP through the fetch proxy. In extension mode, the extension branch is Port-based (`chrome.runtime.connect({ name: 'fetch-proxy.fetch' })`) instead of direct fetch, providing full secret-injection coverage equivalent to CLI mode.

### OAuth flow + page-side bootstrap

- `packages/webapp/src/ui/oauth-bootstrap.ts` is awaited in `main()` before the kernel-worker scoops start. For each non-expired account it re-pushes the masked replica; for each expiring/expired one it invokes the provider's optional `onSilentRenew` hook (page context has `window`, so the IMS popup/iframe flow works there). Bounded by a 10s soft timeout to avoid deadlocking the UI on a hung IMS popup. The worker reads the freshly-renewed token from its `localStorage` shim once it boots.
- `provider.onSilentRenew` is the new hook on `ProviderConfig` — providers that support silent renewal implement it (Adobe does via `silentRenewToken`). The worker-side `silentRenewToken` short-circuits with `if (typeof window === 'undefined') return null;` so a stale-token stream attempt from the worker surfaces a clean "session expired" error instead of `window is not defined`.

### Per-provider extra allowed domains

Provider `oauthTokenDomains` is an immutable safe default; users can layer additional allowed domains per-provider:

- Storage: `localStorage["slicc_oauth_extra_domains"]` → `{[providerId]: [domain, ...]}`
- Helpers: `getExtraOAuthDomains(id)` / `setExtraOAuthDomains(id, domains)` / `getAllExtraOAuthDomains()` in `provider-settings.ts`
- Surfaces: panel terminal `oauth-domain` command, extension options page "OAuth domains" tab
- Merge: `saveOAuthAccount` concatenates defaults + extras, dedupes case-insensitively (defaults-first order), then pushes the merged list to the fetch-proxy / SW.

### Shell-env masked secret population

`scoop-context.ts` (agent shell) and `main.ts` (panel terminal `RemoteTerminalView`) both call `fetchSecretEnvVars()` from `packages/webapp/src/core/secret-env.ts` and pass the result as `env`. The function filters secret names to POSIX-valid identifiers (`/^[A-Za-z_][A-Za-z0-9_]*$/`) so dot-namespaced internal secrets (`s3.<profile>.*`, `oauth.<id>.token`) stay out of `$ENV` / `printenv`.

## Related Guides

- `packages/chrome-extension/CLAUDE.md` for extension runtime constraints
- `packages/node-server/CLAUDE.md` for the CLI/Electron float
- `packages/shared-ts/CLAUDE.md` for secret masking primitives
- `docs/architecture.md` for repo-wide file maps and deeper subsystem inventories
- `docs/shell-reference.md` for command-by-command shell behavior
