# CLAUDE.md

Browser app guide for `packages/webapp/`. Keep extension-only behavior in `packages/chrome-extension/CLAUDE.md` and runtime/server details in float-specific guides.

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
- `realm/` — hard-killable runner. `runInRealm()` spawns a per-task `DedicatedWorker`;
  SIGKILL terminates it with exit 137. JS always runs in the kernel worker through
  `createJsWorkerRealm()` → `js-realm-shared.ts`; `realm-host` proxies `vfs` / `exec` /
  `fetch`. Pure-JS helpers and Node shims live in `realm/helpers/`, behind the
  `js-realm-helpers.ts` compatibility barrel. No extension iframe realm remains.
- `realm/sync-{xhr,fs-*,exec-*}.ts` + `ui/sync-fs-sw-handler.ts` — synchronous
  `readFileSync`/`writeFileSync` and `child_process.execSync`/`execFileSync`/`spawnSync`
  for realm scripts, over one blocking sync-XHR transport (`synchronify`) and one
  capability token scoped to the calling realm's `ctx.fs` / `ctx.exec`.

Deep reference (method surface, coherence, cold-start): `docs/kernel/process-model.md`.

### Orchestrator

- Path: `packages/webapp/src/scoops/`
- `orchestrator.ts` owns scoop lifecycle, routing, shared state, observer teardown, and
  pre-removal `onScoopUnregistered` snapshots.
- `scoop-message-router.ts`: licks use `SCOOP_QUEUE_DEBOUNCE_MS` (1 s), bounded by
  `SCOOP_QUEUE_MAX_COALESCE_MS` (3 s). Pure-lick batches defer while `ScoopContext.isBusy`
  without queue or watermark loss; `SCOOP_DEFERRAL_STARVATION_MS` reports backpressure once
  after 5 minutes on a dedicated non-error channel. User `web` bypasses the window, stays
  immediate/awaited, and prevents deferral. The 2 s safety poll skips active windows.
- `scoop-context.ts` owns per-scoop prompt execution and filesystem/tool isolation.
- `agent-bridge.ts` exposes `globalThis.__slicc_agent`. Defaults: writable
  `[cwd, /shared/, <scratch>/, /tmp/]`, visible `[/workspace/, invokingCwd]`; `--read-only`
  replaces them.
- `transcript-limits.ts` caps bridge/event transcripts at 64 KB, never canonical
  `agent-sessions` history or compaction input.

### VirtualFS

- Path: `packages/webapp/src/fs/`
- `virtual-fs.ts` — POSIX-like FS backed by OPFS (in-memory in Node tests); the legacy
  LightningFS/IDB backend is gone.
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
  `FsWatcher` cache is bypassed for mounted trees, where external changes are invisible.
- `supplemental-commands/` — built-ins (see `docs/shell-reference.md`).
  `typescript` v7 (native) runs checks/builds; `typescript-js` (JS v6) powers browser
  `tsc`/`test`/`esm-transpile` because v7 has no browser/WASM API.
- `builtin-shadow-map.ts` is authoritative for `ipx`/`npx` npm-name → built-in redirects.
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
- **Extension `uiOnly` side panel**: Chrome denies `getUserMedia` (the mic prompt keys on the
  extension origin, ungrantable from a cross-origin iframe), so `wc-follower.ts` skips `ptt`
  and drops "Take a photo". Voice/camera live in the leader tab or detached popout.

### MCP Servers

- Path: `src/shell/mcp/`; command: `supplemental-commands/mcp-command.ts`.
- Registration is lazy from `/workspace/.mcp/servers.json`. Subcommands, the alias shim,
  MCP-Apps-as-sprinkles: `docs/shell-reference.md`.

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
- `SudoManager` (`sudo/sudo-manager.ts`) — per-float policy store, constructed in
  `Orchestrator.init()` once the shared VFS + `FsWatcher` exist; seeds and live-reloads
  `/etc/sudoers` + `/etc/sudoers.d/*`, so edits and "Always" grants apply without restart.
- Wiring: `scoop-context.ts` wraps the agent's FS once with `createSudoFs`; that single
  handle backs both file tools and shell. Panel terminal is intentionally NOT gated.
- Brokers are float-specific (`createSudoBroker`): extension-delegate relays via the hosted
  leader tab; standalone/Electron POSTs `/api/sudo-approve`.
- Self-protection: writes to `/etc/sudoers` + `/etc/sudoers.d/*` always require approval,
  hardcoded in `matchPath` regardless of policy.
- "Agent can't self-approve" does NOT cover page-realm code (which can reassign
  `globalThis.confirm`): `sudo/panel-responder.ts` captures the natives at module init;
  approval chrome mounts via `ui/wc/trusted-layer.ts`, never `document.body`.

Deep reference: `docs/approvals.md`.

### Tray

Modules in `scoops/` — `tray-leader-sync.ts` (façade + lifecycle), `context.ts` (shared
deps), `follower-registry.ts` (registry + keepalive), `follower-dispatch.ts` (exhaustive
dispatch), `broadcast.ts` (snapshot + broadcast), `cdp-router.ts`, `fs-router.ts`,
`tab-router.ts`, `remote-exec.ts`, `transcript-export.ts` (streaming), `preview-bridge.ts`
(connections), `cherry-router.ts` (events), `teleport-pool.ts` (target selection).

Follower model/thinking pills share `ui/wc/wc-follower-model-surface.ts`; the dedicated
`wc-follower.ts` mount and `wc-tray.ts`'s `slicc:tray-join` role switch both consume it.
Cherry remains gated by `CherryFeatureSet.modelPicker`.
See docs/architecture.md "Multi-Browser Sync (Tray) Architecture".

### Core Agent

- Path: `packages/webapp/src/core/`
- Built on `pi-agent-core` and `pi-ai`.
- `tool-adapter.ts` bridges legacy tool definitions into the pi-compatible tool layer.
- `session.ts` and UI session storage keep the browser runtime restorable.

### Feature Flags

- Add IDs to `FeatureFlagId`/`FEATURE_FLAGS` in `core/feature-flags.ts` and both `wrangler.jsonc`
  `FEATURE_FLAGS` lists. User-toggleable flags live in the standalone **Experimental features…**
  avatar dialog (`listFlags()`), not Account settings.
- Parse booleans with `isFeatureEnabled`/`coerceFeatureFlagValue` (trimmed, case-insensitive
  `on`/`true`/`1`). When `overridableFloats` allows, precedence is local → remote → bundled defaults.
- `experimental-settings` is worker-controlled (`userToggleable: false`); it gates the avatar item
  and exported dialog, ignoring local overrides.
- `setupFeatureFlagsForPage` loads the float's isolated cache synchronously, then starts a
  non-blocking `/api/flags?float=<float>` refresh. Later config needs reload.

### Context Compaction

- Path: `packages/webapp/src/core/context-compaction.ts`
- `scoop-context.ts` passes `model.contextWindow`; compaction fires at window minus
  reserve (200K fallback when absent/zero).
- Cone memory appends to `/workspace/CLAUDE.md`; the agentic budget covers the whole file,
  legacy restructuring only `## Auto-extracted`. `agentic-memory` on → compaction builds
  no memory (#2003); the curator owns it.

### Frozen Sessions ("New session" flow)

- Path: `ui/session-freezer.ts`, `ui/new-session.ts`.
- **Save**, **Skip memory**, and **Erase** clear cone chat and non-mount `/tmp`, not scoops.
- Archives use `/sessions/<timestamp>-<slug>.md` plus `index.json`. Idle boot recovers both
  pending markers serially, up to three times, through the bounded legacy enrichment call —
  never the unbounded curator, which `timeoutSeconds` cannot stop.
- Agentic Save: quick snapshot then clear; title (`skipMemory`) + curator in background.
- Cone-only `OffscreenClient.clearAllMessages()` awaits `clear-chat-ack` before panel reload.

### UI

- Path: `packages/webapp/src/ui/`; WC shell in `ui/wc/`.
- `main.ts` boots the WC shell for every float: standalone/electron/hosted-leader/cherry →
  `wc/wc-live.ts` (kernel worker + tray sync + panel RPC); extension side panel + detached
  popout → `wc/wc-extension.ts` (`OffscreenClient`). Float discriminator:
  `resolveUiRuntimeMode()`.
- `ui/wc/` map: `wc-live`, `wc-shell`, `wc-chat-controller`, `wc-message-view`, `wc-tray`,
  `wc-sprinkles`, `wc-nav`, `wc-workbench`, `wc-freezer`, `wc-memory`, `wc-extension`; panels in
  `panelize-shell`, `builtin-panels`, `panel-visibility`, `layout-store`, `agent-panels`, `add-panel-menu`.
- **Layouts** (`docs/layouts.md`): all chrome is a `SliccPanel` in `<slicc-layout>` except the fixed avatar strip (trusted layer). Behind the `panel-layouts` flag. `panelize-shell.ts` RE-PARENTS what `mountWcShell` built, so `WcShellRefs` stays valid. Documents save to `/workspace/layouts/` (free) or `/etc/slicc/layouts/` (gated). `setPanelVisible` must add an unplaced panel but never duplicate a placed one; `sanitizeLayoutName` guards the path a name becomes.
- **URL state**: `ctx` (active context, pushed), `at` (scroll pos, debounced replace),
  `ws` (open workspace surface). No global manager; the host only routes.
- **Cherry `?cherry=1`** (`main-cherry.ts`): builds `CherryHostTransport` against
  `window.parent`, reads `joinUrl` from the handshake, wraps `BrowserAPI`. Origin detection:
  see `cherry-host-transport.ts` note in the CDP section.
- **Cherry `?cherry=1&ui-only=1`** (extension side panel): suppresses CDP target
  advertisement, skips `ptt`, drops "Take a photo" (mic denied in cross-origin side panel).
  Login/onboarding hand-off to the leader tab is gated to `isExtensionSidePanel` only.
- **Cloud cone config** (`ui/hosted-config-apply.ts`): `applyHostedAccounts` reconciles
  accounts from `/api/hosted-bootstrap`, removing only providers tracked in
  `localStorage['slicc_cloud_managed']` — never user-added ones. `?connect=1` is a login-only
  surface (`ui/connect-surface.ts`) with no kernel.

### Skills

- Path: `packages/webapp/src/skills/`
- Precedence: native `/workspace/skills/` → `.agents/skills/*/SKILL.md` → `.claude/skills/*/SKILL.md` → marketplace (`.claude-plugin/marketplace.json`) → agent plugins (`plugin` command, `shell/plugins/`).
- **Never monkeypatch a method on a get/set-asymmetric Proxy.** The sudo-fs Proxy advertises
  `MONKEYPATCH_UNSAFE_FS` (a `Symbol.for` marker); `getCompatibilitySkillCandidates` skips
  hooks and cache for it (always re-discovers). Reassigning a gated method creates an
  `override↔wrapper` async recursion that OOMs the kernel worker.

### Sprinkle Rendering

- Main files: `ui/sprinkle-renderer.ts`, `sprinkle-manager.ts`, `sprinkle-discovery.ts`.
- `.shtml` panels discovered from VFS. CLI: fragments/full docs in `srcdoc` iframes.
  Extension: renders in the hosted `?cherry=1` follower — no extension sandbox.

### Dips

- Main file: `ui/dip.ts`. Hydrates assistant `shtml` code blocks into sandboxed iframes
  after streaming completes. Minimal lick bridge; auto-height via ResizeObserver.

### Stale-asset recovery (post-deploy)

- `setup-preload-error-reload.ts` + `stale-asset-channel.ts` funnel preload, page Worker,
  worker boot, and scoop-classifier failures into an `instanceId`-scoped 60 s reload; only
  the owning page reacts. A cone `replayTurn` marker replays one unanswered turn after recovery.

## Key Conventions

- **Two type systems**: legacy `tools/` + pi-compatible `core/`; bridge via `tool-adapter.ts`.
- **Logging**: `createLogger('namespace')` (`core/logger.ts`).
- **Extension detection**: `typeof chrome !== 'undefined' && !!chrome?.runtime?.id`.
- **Dual-mode compatibility**: features must work in both standalone/CLI and extension. The
  thin extension runs no dynamic code itself — all JS execution (realms, WASM, sprinkles/dips)
  runs in the hosted leader tab / kernel worker.
- **Model IDs**: use pi-ai aliases such as `claude-opus-4-6`, not dated snapshot names.
- **Provider composition**: pi-ai auto-discovered + `src/providers/built-in/` + `providers/`;
  three-layer merge: pi-ai → `modelOverrides` → `getModelIds()`. Build filtering:
  `packages/dev-tools/providers.build.json`.
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
  buffered read-ahead (no streaming; latin1 strings, not `Buffer`s; `'error'` never fires) and
  one-shot: `read()`, events (`on('data')`→`'end'`→`'close'`, single chunk), and the async
  iterator share one `consumed` flag, so whichever drains first wins and the others see EOF.
  On the events surface, `pause()` suppresses the deferred emission until `resume()` (the buffer
  stays drainable) and `process.exit(N)` from a handler exits with code `N`.
  `process.stdin.isTTY` is always `false`. Do not expose `stdin` as a top-level identifier
  (collides with user declarations).

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
- `docs/architecture.md` — repo-wide file maps and deeper subsystem inventories
- `docs/shell-reference.md` — command-by-command shell behavior
- `docs/mounts.md` — mount setup, architecture, and error patterns
- `docs/secrets.md` — secrets storage, masking, and domain-scoped injection
- `docs/kernel/process-model.md` — kernel process model, signals, `/proc`, sync-fs bridge
- `docs/transcript-export.md` — ZIP format, privacy guarantees, approval, Cherry SDK
