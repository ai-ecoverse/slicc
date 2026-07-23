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
  → tool calls → RestrictedFS / AlmostBashShell / BrowserAPI
  → results → agent loop → UI updates / scoop routing
```

## Key Subsystems

### Kernel Host

- Path: `packages/webapp/src/kernel/`
- `host.ts` — `createKernelHost(config)` factory. Single boot sequence for all floats:
  orchestrator + lick-manager + agent-bridge + tray subs + cone bootstrap + BshWatchdog +
  `/proc` mount. In `node-rest` topology the host also opens the `/licks-ws` bridge;
  extension-delegate leaders route licks through the tray worker instead. Float
  discriminator: `resolveFloatTopology()` in `core/float-topology.ts`.
- `kernel-worker.ts` — DedicatedWorker entry. Standalone path defaults here; `?inline=1` is
  removed.
- `process-manager.ts` — `ProcessManager` tracks every long-running async unit (scoop turns,
  tool calls, shell execs, jsh/py scripts). Pids are uint32 from 1024+; `signal(pid, sig)`
  honors SIGINT/SIGTERM/SIGKILL/SIGSTOP/SIGCONT.
- `proc-mount.ts` — read-only procfs-shaped view at `/proc` (scoop-invisible, not persisted).
  `cat /proc/<pid>/{status,cmdline,cwd,stat}` works from any panel terminal.
- `realm/` — hard-killable runner. `runInRealm({ kind: 'js' | 'py', … })` spawns a
  per-task `DedicatedWorker`; SIGKILL → `worker.terminate()`, exit 137. **JS realms always
  run in the kernel worker via `createJsWorkerRealm()` → `js-realm-shared.ts`, in every
  float.** Kernel-side `realm-host` proxies `vfs` / `exec` / `fetch` RPC. The extension
  iframe realm path (`createIframeRealm`) is fully removed.
- `realm/sync-fs-*.ts` + `ui/sync-fs-sw-handler.ts` — synchronous `readFileSync`/
  `writeFileSync` for realm scripts via bounded snapshot + SW BroadcastChannel XHR fallback;
  capability-token-scoped to the calling realm's `RestrictedFS`.
  See `docs/kernel/process-model.md` for method surface and cold-start behavior.

Deep reference: `docs/kernel/process-model.md`.

### Orchestrator

- Path: `packages/webapp/src/scoops/`
- `orchestrator.ts` creates/destroys scoops, routes messages, manages shared runtime state.
  `observeScoop(jid, handler)` exposes per-scoop event taps; observers dropped by both
  `unregisterScoop` and `destroyScoopTab`. `unregisterScoop` fires `onScoopUnregistered`
  with the pre-removal snapshot for every teardown path — stateful consumers (e.g. the kernel
  bridge) use it to evict per-scoop chat buffers.
- `scoop-context.ts` owns per-scoop prompt execution and filesystem/tool isolation.
- `agent-bridge.ts` — `globalThis.__slicc_agent` surface for the `agent` shell command.
  Sandbox defaults: `writablePaths = [cwd, /shared/, <scratch>/, /tmp/]`,
  `visiblePaths = [/workspace/, invokingCwd]`; `--read-only` is pure-replace.
- `transcript-limits.ts` — 64 KB caps for the chat-TRANSCRIPT boundary (bridge buffers,
  emitted agent events). The canonical agent history (`agent-sessions` DB, compaction input)
  must **never** route through these helpers.

### VirtualFS

- Path: `packages/webapp/src/fs/`
- `virtual-fs.ts` — POSIX-like FS backed by OPFS (in-memory in Node tests). Legacy
  LightningFS/IDB backend and boot-time migration are fully removed.
- `restricted-fs.ts` — path ACLs for scoop sandboxes.
- `mount-commands.ts` — parses `--source` / `--profile` / `--no-probe` etc.;
  `path-utils.ts` defines normalization.
- `mount/` — `MountBackend` interface plus three implementations: `backend-local.ts` (FS
  Access), `backend-s3.ts` (S3/R2/MinIO), `backend-da.ts` (da.live). Shared
  `RemoteMountCache` (TTL + ETag, IDB-backed). Signing is browser-naive: backends hand
  logical requests to an injected transport routed per deployment (CLI → `/api/s3-sign-and-forward`,
  extension → SW). `mount-table-store.ts` / `mount-recovery.ts` persist and restore backends.

See `docs/mounts.md`.

### Shell

- Path: `packages/webapp/src/shell/`
- `almost-bash-shell.ts` — just-bash runtime host.
- `script-catalog.ts` — shared `.jsh`/`.bsh` discovery for the shell and `which`; its
  `FsWatcher` cache is bypassed for mounted trees where external changes are invisible.
- `supplemental-commands/` — built-ins (see `docs/shell-reference.md`).
  `typescript` v7 (native) runs checks/builds; `typescript-js` (JS v6) powers browser
  `tsc`/`test`/`esm-transpile` because v7 has no browser/WASM API.
- `jsh-discovery.ts` / `bsh-discovery.ts` — raw VFS scans backing the shared catalog.
- `vfs-adapter.ts` — bridges shell calls into VFS; forwards `canWrite` (duck-typed for
  both `VirtualFS` and `RestrictedFS`).

### Speech

- Path: `packages/webapp/src/speech/`; entry: `supplemental-commands/hear-command.ts`.
  **Page realm only** (mic, AudioContext); kernel worker bridges via `hear-*` panel-RPC ops.
- Two engines: Web Speech API (immediate) hot-swapped to on-device Whisper
  (`onnx-community/whisper-tiny`) once ready. Kokoro TTS (`Kokoro-82M-v1.0-ONNX`) chains
  automatically off the whisper load. Kokoro selects on English + on-device readiness; Web
  Speech is the fallback.
- **Extension `uiOnly` side panel**: Chrome denies `getUserMedia` (mic prompt keys on the
  extension origin, not grantable from the cross-origin iframe). `wc-follower.ts` skips `ptt`
  and drops "Take a photo" from the add-menu. Voice and camera live in the leader tab /
  detached popout instead.

### MCP Servers

- Path: `packages/webapp/src/shell/mcp/`; command: `supplemental-commands/mcp-command.ts`.
- Subcommands: `mcp add <url> [name]`, `mcp list`, `mcp delete <name>`, `mcp invoke <name>
[tool]`, `mcp refresh <name>`, `mcp auth <name>` (re-authenticate; `--silent` /
  `--interactive` to force).
- `mcp add` auto-writes an alias shim at `/workspace/.mcp/aliases/<name>.jsh`; MCP Apps
  materialize as sprinkles under `/workspace/.mcp/sprinkles/<name>/`. Registration is lazy
  from `/workspace/.mcp/servers.json`.

### CDP

- Path: `packages/webapp/src/cdp/`
- `transport.ts` — CDP transport interface; `browser-api.ts` — Playwright-style browser API.
- `synthetic-cdp-transport.ts` — shared base synthesizing the session lifecycle (`Target.getTargets/attachToTarget`,
  `Page/Runtime/DOM.enable`, `Page.frameNavigated` + `Page.loadEventFired` after navigate) so
  `BrowserAPI.navigate()` doesn't hang. Subclasses provide the backhaul.
- `cherry-host-transport.ts` — extends `SyntheticCdpTransport` for the embedded follower
  iframe (`?cherry=1`). `resolveParentOrigin()` prefers `location.ancestorOrigins[0]`
  (unforgeable); `document.referrer` alone breaks when Referer is stripped or in HTTP-in-HTTPS
  dev embeds.
- `preview-bridge-cdp-transport.ts` — extends `SyntheticCdpTransport` for driveable preview
  tabs (`serve --bridge`). Sends `bridge.cdp.request` over the tray controller WebSocket;
  `bridge.close` on `Target.closeTarget`.
- `cherry-host-protocol.ts` — canonical cherry envelope contract and three-factor
  `acceptEnvelope` gate (origin allowlist + `MessageEvent.source` identity + per-mount
  `channelId` nonce). `packages/cherry/src/protocol.ts` is a structural mirror; keep in sync.
- `cdp/panel-rpc-tray-provider.ts` + `cdp/panel-rpc-cdp-transport.ts` — enable the
  worker-side `BrowserAPI` to drive federated tray/cherry/preview targets via the panel-RPC
  BroadcastChannel.

### Tools

- Path: `packages/webapp/src/tools/`
- Active surface: file tools, `bash`, and scoop/nanoclaw helpers. Browser automation routes
  through shell commands, not a separate tool family.

### Sudo (agent action approvals)

- Paths: `shell/sudo/sudoers.ts` (parser/matcher), `fs/sudo-fs.ts` (FS gate),
  `shell/sudo/command-guard.ts` (command gate), `sudo/` (brokers + manager).
- `SudoManager` (`sudo/sudo-manager.ts`) — per-float policy store. Constructed in
  `Orchestrator.init()` once the shared VFS + `FsWatcher` exist; seeds and live-reloads
  `/etc/sudoers` and `/etc/sudoers.d/*` so edits and "Always" grants take effect without
  restart.
- Wiring: `scoop-context.ts` wraps the agent's FS once with `createSudoFs`; that single
  handle backs both file tools and shell. Panel terminal is intentionally NOT gated.
- Brokers are float-specific (`createSudoBroker`): extension-delegate relays via the hosted
  leader tab page; standalone/Electron POSTs `/api/sudo-approve`.
- Self-protection: writes to `/etc/sudoers` + `/etc/sudoers.d/*` always require approval,
  hardcoded in `matchPath` regardless of policy.

Deep reference: `docs/approvals.md`.

### Tray Sync (multi-browser leader/follower)

- Path: `packages/webapp/src/scoops/tray-*`, `ui/page-leader-tray.ts`,
  `ui/page-follower-tray.ts`.
- `tray-sync-protocol.ts` re-exports the canonical wire format (union + payload types live in
  `@slicc/shared-ts`). The iOS follower (`packages/ios-app/`) is a **separate Swift
  implementation** — it does NOT consume `tray-follower-sync.ts`; match its behavior when
  adding follower-side rendering.
- `tray-leader-sync.ts` broadcasts agent events, snapshots, scoops, sprinkle content, and
  federated CDP/FS. `tray-follower-sync.ts` (`FollowerSyncManager`) implements `AgentHandle`
  — installing it as the WC chat controller's agent forwards user input to the leader.
- **Lick forwarding**: `LickManager.setForwarder(fn | null)` installs a hook; `dispatch()`
  is the private chokepoint. When set AND the lick type is in `FORWARDABLE_TO_LEADER`
  (currently `navigate`), the lick forwards to the leader instead of firing locally.
- **Cherry events**: `cherry.host_event` (host page → follower → leader → `'cherry'`
  `LickEvent`) and `cherry.slicc_event` (leader → follower → `slicc.event` postMessage to
  host); `cherry-emit` supplemental command sends the leader → host direction.

See `docs/architecture.md` "Multi-Browser Sync (Tray) Architecture".

### Core Agent

- Path: `packages/webapp/src/core/`
- Built on `pi-agent-core` and `pi-ai`.
- `tool-adapter.ts` bridges legacy tool definitions into the pi-compatible tool layer.
- `session.ts` and UI session storage keep the browser runtime restorable.

### Context Compaction

- Path: `packages/webapp/src/core/context-compaction.ts`
- **GC threshold is model-sized**: `scoop-context.ts` forwards `model.contextWindow` into
  `createCompactContext`; fires at `contextWindow - reserveTokens`, not a hardcoded value.
  A `0`/missing window falls back to 200K default.
- **Memory extraction** (cone only): when `onMemoryUpdates` is wired, compaction makes a
  second LLM call sharing the same system prompt (prompt-cache hit) and appends bullets to
  `/workspace/CLAUDE.md` via `orchestrator.appendConeMemory`. Best-effort; never blocks
  compaction.
- `appendConeMemory` is size-bounded by `cone-memory-budget.ts` (log2-scaled per-session
  budget). When an append exceeds budget × 1.25, an LLM restructure runs over only the
  `## Auto-extracted` tail; the user-authored header is preserved verbatim.

### Frozen Sessions ("New session" flow)

- Path: `ui/session-freezer.ts`, `ui/new-session.ts`.
- Three explicit actions from the avatar popover: **Save & start new** (enrichment + memory
  extraction), **New chat — skip memory** (quick archive), **Erase & start new** (no
  archive). All reset VFS `/tmp` (preserving active mount roots) and clear the cone chat;
  scoops survive. Page reload, app restart, and scoop creation do NOT clear `/tmp`.
- Archive format: `/sessions/<timestamp>-<slug>.md` (YAML frontmatter +
  `slicc:session-data` HTML-comment block + human-readable body). Index at
  `/sessions/index.json` (prepended).
- `OffscreenClient.clearAllMessages()` is cone-only; awaits `clear-chat-ack` before
  resolving to avoid racing the panel reload.

### UI

- Path: `packages/webapp/src/ui/`; WC shell in `ui/wc/`.
- `main.ts` boots the WC shell for every float: standalone/electron/hosted-leader/cherry →
  `wc/wc-live.ts` (kernel worker + tray sync + panel RPC); extension side panel + detached
  popout → `wc/wc-extension.ts` (`OffscreenClient` over `chrome.runtime`).
  `resolveUiRuntimeMode()` inspects `window.location.href` + extension flag.
- `ui/wc/` map: `wc-live.ts`, `wc-shell.ts`, `wc-chat-controller.ts`, `wc-message-view.ts`,
  `wc-tray.ts`, `wc-sprinkles.ts`, `wc-nav.ts`, `wc-workbench.ts`, `wc-freezer.ts`,
  `wc-memory.ts`, `wc-extension.ts`.
- **URL state**: `ctx` (active context, pushed — back/forward walks contexts), `at` (scroll
  position, debounced replace), `ws` (open workspace surface). No global URL state manager;
  the host only routes.
- **Cherry `?cherry=1`** (`main-cherry.ts`): builds `CherryHostTransport` against
  `window.parent`, reads `joinUrl` from the handshake, wraps `BrowserAPI`. Origin detection:
  see `cherry-host-transport.ts` note in the CDP section.
- **Cherry `?cherry=1&ui-only=1`** (extension side panel): suppresses CDP target
  advertisement, skips `ptt`, drops "Take a photo" (mic denied in cross-origin side panel).
  Login/onboarding hand-off to the leader tab is gated to `isExtensionSidePanel` only.
- **Cloud cone config** (`ui/hosted-config-apply.ts`): `applyHostedAccounts` reconciles
  accounts from `/api/hosted-bootstrap`; only removes providers tracked in
  `localStorage['slicc_cloud_managed']`, never user-added accounts. `?connect=1` is a
  login-only surface (`ui/connect-surface.ts`) with no kernel.

### Skills

- Path: `packages/webapp/src/skills/`
- Precedence: native `/workspace/skills/` → `.agents/skills/*/SKILL.md` → `.claude/skills/*/SKILL.md` → marketplace (`.claude-plugin/marketplace.json`).
- **Never monkeypatch a method on a get/set-asymmetric Proxy.** The sudo-fs Proxy advertises
  `MONKEYPATCH_UNSAFE_FS` (a `Symbol.for` marker); `getCompatibilitySkillCandidates` skips
  hooks and cache for it (always re-discovers). Reassigning a gated method creates an
  `override↔wrapper` async recursion that OOMs the kernel worker.

### Sprinkle Rendering

- Main files: `ui/sprinkle-renderer.ts`, `sprinkle-manager.ts`, `sprinkle-discovery.ts`.
- `.shtml` panels discovered from VFS. CLI: fragments/full docs in `srcdoc` iframes.
  Extension: renders in the hosted `?cherry=1` follower (sliccy.ai origin) — no extension
  sandbox.

### Dips

- Main file: `ui/dip.ts`. Hydrates assistant `shtml` code blocks into sandboxed iframes
  after streaming completes. Minimal lick bridge; auto-height via ResizeObserver.

### Stale-asset recovery (post-deploy)

- Four triggers → one shared, `instanceId`-scoped, fail-closed, 60 s reload
  (`ui/boot/setup-preload-error-reload.ts` + `core/stale-asset-channel.ts`): page
  `vite:preloadError`; page `Worker` error (`spawn.ts`); worker `boot()` try/catch; worker
  scoop-context classifier. Worker triggers broadcast over `BroadcastChannel` stamped with
  `instanceId`; only the owning page reloads.
- A dropped cone turn is auto-resubmitted once after recovery: the broadcast stamps
  `replayTurn` (cone only), the page sets `sessionStorage slicc:stale-asset-replay`, and
  `wc-chat-controller.loadMessages` replays the last unanswered user turn once via
  `#handleErrorRetry`.

## Key Conventions

- **Two type systems**: legacy tool definitions in `tools/`, pi-compatible tools in `core/`;
  bridge through `tool-adapter.ts`.
- **Logging**: `createLogger('namespace')` from `packages/webapp/src/core/logger.ts`.
- **Extension detection**: `typeof chrome !== 'undefined' && !!chrome?.runtime?.id`.
- **Dual-mode compatibility**: features must work in both standalone/CLI and extension. The
  thin extension runs no dynamic code itself — all JS execution (realms, WASM, sprinkles/dips)
  runs in the hosted leader tab / kernel worker.
- **Model IDs**: use pi-ai aliases such as `claude-opus-4-6`, not dated snapshot names.
- **Provider composition**: providers auto-discovered from pi-ai plus
  `packages/webapp/src/providers/built-in/`; external configs in `packages/webapp/providers/`;
  build-time filtering in `packages/dev-tools/providers.build.json`. Three-layer merge:
  pi-ai → `modelOverrides` (static) → `getModelIds()` (dynamic).
- **Adobe `X-Session-Id` invariant**: every LLM call to the Adobe proxy must attach the
  `X-Session-Id` header (`scoop-context.ts` wires it for both the agent `streamFn` and
  compaction `headers`). New LLM call sites — `streamSimple`/`completeSimple` callers or
  pi-coding-agent helpers — must attach it explicitly. `providers/adobe.ts`'s
  `ensureSessionIdHeader` is a defense-in-depth net (daily-rotated sentinel UUID + warning),
  not the fix location. See `docs/pitfalls.md`.
- **Claude Bedrock capability shims** (temperature rejected by Opus ≥ 4.7; adaptive thinking
  for Opus/Sonnet ≥ 4.6): fix at the provider layer via `src/providers/claude-model-version.ts`
  (`parseClaudeVersion` + predicate helpers). Never fix at the call site — the shared
  predicates handle future model versions automatically. See `docs/pitfalls.md`.

## VFS API Patterns

- Prefer absolute VFS paths: `/workspace/...` and `/shared/...`.
- `VirtualFS.create({ dbName, wipe })` is the entry point for isolated testable instances.
- Mounted directories bridge directly to `FileSystemDirectoryHandle`; do not copy large trees
  into IndexedDB unless you mean to.
- Use `fs.walk()` and `path-utils.ts` helpers instead of ad hoc path splitting.
- `RestrictedFS` is the correct boundary when code should not see the whole VFS.

## Shell Command Authoring

### `.jsh` commands

- `.jsh` files are JavaScript shell scripts discovered anywhere on the VFS; command name is
  the basename without `.jsh`.
- `script-catalog.ts` shares discovery across `AlmostBashShell`, `which`, and other lookup
  paths.
- Scripts run in an async wrapper: prefer top-level `await`. Stdin (`process.stdin`) is fully
  buffered (no streaming); `read()` drains it with Node-like EOF semantics. `process.stdin.isTTY`
  is always `false`. Do not expose `stdin` as a top-level identifier (collides with user
  declarations).

### `.bsh` browser scripts

- `.bsh` files are JavaScript browser-navigation helpers that run in the **target browser page
  context** via CDP `Runtime.evaluate`. Access `document`, `window`, page globals — NOT
  `process`/`fs`/`exec()`.
- Filename controls hostname matching: `-.okta.com.bsh` → `*.okta.com`;
  `login.okta.com.bsh` → exact host match. Optional `// @match` directives in the first
  10 lines narrow further. `BshWatchdog` uses `ScriptCatalog` for matching.

## Secret-Aware Fetch Proxy

`createProxiedFetch()` (`packages/webapp/src/shell/proxied-fetch.ts`) routes agent-initiated
HTTP through the fetch proxy. Extension mode uses a Port-based path
(`chrome.runtime.connect({ name: 'fetch-proxy.fetch' })`). Shell-env population:
`secret-env.ts` filters secret names to POSIX-valid identifiers
(`/^[A-Za-z_][A-Za-z0-9_]*$/`) so dot-namespaced internal secrets stay out of `$ENV`.

See `docs/secrets.md` for OAuth bootstrap, silent renewal, and per-provider extra domains.

## Related Guides

- `packages/chrome-extension/CLAUDE.md` — extension runtime constraints
- `packages/node-server/CLAUDE.md` — CLI/Electron float
- `packages/shared-ts/CLAUDE.md` — secret masking primitives
- `docs/architecture.md` — repo-wide file maps and deeper subsystem inventories
- `docs/shell-reference.md` — command-by-command shell behavior
- `docs/mounts.md` — mount setup, architecture, and error patterns
- `docs/secrets.md` — secrets storage, masking, and domain-scoped injection
- `docs/kernel/process-model.md` — kernel process model, signals, `/proc`, sync-fs bridge
