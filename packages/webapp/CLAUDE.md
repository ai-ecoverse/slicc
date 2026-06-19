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
- `host.ts` — `createKernelHost(config)` factory. Single boot sequence shared by every float that hosts the cone (standalone CLI, Electron, hosted-leader cloud sandbox, and the hosted leader tab the thin Chrome extension pins) and by tests: orchestrator + lick-manager + agent-bridge + tray subs + cone bootstrap + BshWatchdog + `/proc` mount. Returns `{ orchestrator, browser, bridge, lickManager, sharedFs, processManager, dispose }`. The host opens the `/licks-ws` bridge (`scoops/lick-ws-bridge.ts`) when a local bridge is reachable so the node-server's `/api/webhooks`, `/api/crontasks`, `/api/tray-status`, and inbound webhook/handoff routes reach the worker-side `LickManager`.
- `kernel-worker.ts` — DedicatedWorker entry. The kernel always runs in a worker now — the inline orchestrator path was removed and `?inline=1` no longer exists.
- `process-manager.ts` — `ProcessManager` tracks every long-running async unit: scoop turns, tool calls, shell execs, jsh/python scripts. Pids are uint32 from 1024+; `signal(pid, sig)` honors SIGINT/SIGTERM/SIGKILL/SIGSTOP/SIGCONT (SIGKILL escalates uncatchably).
- `proc-mount.ts` — read-only `procfs`-shaped view, mounted at `/proc` via `vfs.mountInternal` (scoop-invisible, not persisted). `cat /proc/<pid>/{status,cmdline,cwd,stat}` works from any panel terminal.
- `realm/` — generalized hard-killable runner for `node` / `.jsh` / `python`. `runInRealm({ kind: 'js' \| 'py', … })` spawns a per-task `DedicatedWorker` (every float runs JS this way today; Python is worker-based too); SIGKILL → `worker.terminate()`, exit 137. Kernel-side `realm-host` proxies `vfs` / `exec` / `fetch` RPC over the realm's port so realm code stays sandboxed.
- `terminal-session-{host,client}.ts` — terminal RPC over the kernel transport. Each panel-typed command spawns a `kind:'shell'` process; SIGINT routes to `pm.signal`.
- `remote-terminal-view.ts` — page-side xterm. Pre-intercepts `mount /<path>` so the keystroke gesture can drive `showDirectoryPicker` (the worker has no `window`).

Deep reference: `docs/kernel/process-model.md`.

### Orchestrator

- Path: `packages/webapp/src/scoops/`
- `orchestrator.ts` creates and destroys scoops, routes messages, and manages shared runtime state. Exposes `observeScoop(jid, handler)` for per-scoop event taps used by the agent bridge; observers are dropped defensively by both `unregisterScoop` and `destroyScoopTab`. `unregisterScoop` fires the optional `onScoopUnregistered` callback with the pre-removal scoop snapshot for EVERY teardown path (panel drop, `drop_scoop` tool, ephemeral `agent` spawns, workflow subagents) — stateful consumers such as the kernel bridge use it to evict per-scoop chat buffers; before this hook, programmatic teardown leaked every destroyed scoop's full transcript (tool results included) until the float hit the V8 4GB OOM.
- `scoop-context.ts` owns per-scoop prompt execution and filesystem/tool isolation.
- `agent-bridge.ts` wraps the orchestrator into a stable `globalThis.__slicc_agent` surface used by the `agent` shell command. Registers ephemeral sub-scoops with `notifyOnComplete: false` so spawns from any float don't trigger cone turns. Sandbox defaults: `writablePaths = [cwd, /shared/, <scratch>/, /tmp/]`, `visiblePaths = [/workspace/, invokingCwd]` unioned and de-duped; `--read-only` is pure-replace and drops both defaults.
- `transcript-limits.ts` — size caps for the chat-TRANSCRIPT boundary only (bridge buffers, emitted agent events, `agent-message-to-chat.ts` rebuilds): 64 KB per tool result / per oversized input string field; buffered results additionally strip inline screenshot markers. The canonical agent history (`agent-sessions` DB, compaction input) must NEVER be routed through these helpers.
- `skills.ts`, tray files, and scheduler files extend orchestration rather than the UI directly.

### VirtualFS

- Path: `packages/webapp/src/fs/`
- `virtual-fs.ts` provides the POSIX-like filesystem backed by OPFS (in-memory in Node tests). The legacy LightningFS/IndexedDB backend and its boot-time migration are fully removed; `slicc-fs-cleanup` deletes the leftover `slicc-fs` database on request.
- `restricted-fs.ts` adds path ACLs for scoop sandboxes.
- `mount-commands.ts` is the dispatcher (parses `--source` / `--profile` / `--no-probe` etc.); `path-utils.ts` defines path normalization.
- `mount/` holds the backend abstraction: `MountBackend` interface (`backend.ts`), three implementations (`backend-local.ts` wrapping FS Access, `backend-s3.ts` for S3 + S3-compatible like R2, `backend-da.ts` for da.live), the shared `RemoteMountCache` (TTL + ETag, IDB-backed), `signed-fetch.ts` (browser-side transport seam), `fetch-with-budget.ts` (timeout + retry + abort threading), and `profile.ts` (cred resolution from `s3.<profile>.*` secrets, IMS for DA). The SigV4 v4 signer (`sigv4.ts`, pure Web Crypto, no AWS SDK) and the sign-and-forward orchestration (`sign-and-forward.ts`) live in `@slicc/shared-ts` and are consumed by the webapp mount barrel, the node-server handlers, and the extension service worker. Persistence + recovery: `mount-table-store.ts` keys by `targetPath` with a `BackendDescriptor` discriminated union; `mount-recovery.ts` reconstructs backends per-kind on session restore.

### Shell

- Path: `packages/webapp/src/shell/`
- `almost-bash-shell.ts` hosts the just-bash runtime.
- `script-catalog.ts` is the shared `.jsh`/`.bsh` discovery service; it caches behind `FsWatcher` invalidation and bypasses cache for mounted trees where external changes are invisible to the watcher.
- `supplemental-commands/` contains built-in commands, including `supplemental-commands/agent-command.ts` which forwards `ctx.cwd` as `invokingCwd` and validates `<cwd>` writability via `ctx.fs.canWrite` to prevent nested-scoop sandbox escape.
- `supplemental-commands/tsc-command.ts` is the `tsc` single-file TypeScript transpiler. It is a THIN built-in surface over the `getTypeScript()` ipk loader in `supplemental-commands/shared.ts` — inert until the user runs `ipk add typescript`, at which point the loader reads `typescript/lib/typescript.js` from VFS `node_modules` via the shared resolver and evaluates the CJS source in a `new Function('module', 'exports', source)` wrapper. There is no bundled binary, no CDN fallback; a missing package surfaces the canonical `ipk add typescript` guidance error. Node runtime (vitest, the realm host's transpile fallback) still resolves the locally-installed `typescript` npm dependency via a `/* @vite-ignore */` dynamic import so the heavy module never enters the browser bundle. Supports `tsc [files...]`, `--noEmit`, `--outDir`, stdin → stdout, and walks up from `ctx.cwd` to merge `tsconfig.json`'s `compilerOptions` over the `ES2022`/`ESNext` defaults; cross-file program-level type checking is not wired up.
- `supplemental-commands/test-command.ts` is the `test` runner. Discovers `*.test.{js,ts}` files via a small in-VFS glob walker (default `**/*.test.{js,ts}` rooted at `ctx.cwd`, skipping `node_modules` and dot-dirs), TS-transpiles `.ts` and `.js` sources to CJS through the shared ipk-backed `getTypeScript()` loader (same install-required path as `tsc` — `ipk add typescript` first), then runs each file in its own realm via `executeJsCode` so isolation and SIGKILL come for free. The runner is [`tst`](https://github.com/dy/tst) (0 deps, ESM, ~13 KB): the bundled `tst.js` + `assert.js` are imported via `?raw`, transpiled to CJS once per process, and stitched into each per-file runner as IIFEs that expose `__tst` / `__tst_assert_exports` as locals — user `import test from 'tst'` calls are rewired through an in-realm `__tstReq` shim so the realm's `require()` pre-fetch never round-trips to esm.sh. Reporters: `tap` (default) → tst `tap`, `--reporter=spec` → tst `pretty`. Fork mode is intentionally disabled (the worker_threads / fs / path dynamic imports inside `runForked` are stubbed at harness build time).
- `supplemental-commands/esbuild-wasm.ts` is the shared `esbuild-wasm` loader used by the realm `esm-transpile` hook. The heavy `esbuild.wasm` binary is read from an ipk-installed `esbuild-wasm` in the VFS `node_modules` via the `IpkResolutionContext` plumbing; there is no CDN fallback. Node / vitest skips `initialize` since `esbuild-wasm`'s Node entry rejects `wasmURL`/`wasmModule`/`worker` and lazily spawns its own `node bin/esbuild` child. `supplemental-commands/esbuild-command.ts` and `supplemental-commands/biome-command.ts` are THIN built-in surfaces over this loader (and over the biome wasm API) — they are inert until the user runs `ipk add esbuild-wasm` / `ipk add @biomejs/wasm-web @biomejs/js-api`, and an uninstalled invocation exits with a guidance error pointing at the exact `ipk add` line (zero network, no CDN). The biome command drives the WASM workspace via the kernel realm (`executeJsCode` + a baked helper that `require()`s both biome packages from VFS `node_modules`), so the rest of the bundle never references `@biomejs/wasm-web`. The legacy `ipx esbuild` / `ipx biome` aliases remain equivalent for users who prefer the explicit invocation.
  - **Build-asset strip**: wasm-bindgen's `new URL('biome_wasm_bg.wasm', import.meta.url)` fallback makes Vite statically emit a 33 MB binary into `dist/ui/` (and `dist/extension/`) whenever anything transitively re-pulls `@biomejs/wasm-web`. The webapp graph no longer reaches it, but `packages/webapp/vite-plugins/strip-biome-wasm-asset.ts` (wired into both `vite.config.ts` files) stays as a defensive net: any reappearing asset is deleted in `closeBundle` and any surviving reference is rewritten to an empty string so the dead-code fallback hits no network. Rolldown-vite (vite >=8) does not invoke JS `transform` / `load` / `generateBundle` hooks for these dependency modules, so the strip must run in `closeBundle` against the written output. CI's `cloudflare-worker` job runs `wrangler deploy --dry-run` as a hard gate so a regression here fails the PR, not just the release.
- `supplemental-commands/workflow-{command,prelude,script}.ts` implement the `workflow run` command — runs Claude Code dynamic workflows natively (non-blocking by default, `--wait` for SP1 blocking behavior). A workflow is a plain-JS orchestration script that fans out to parallel subagents via `agent(prompt, {schema?, thinking?})` while keeping intermediate results in script variables. Built over `executeJsCode` → `runInRealm({ kind: 'js' })` with a prelude supplying orchestration API (`agent` / `parallel` / `pipeline` / `phase` / `log` / `budget` / `args` / `workflow`) + determinism guards (shadowed `Date` / `Math` / `crypto` / `performance` / timers) + global suppression. `agent()` shells out to the existing `agent` command via captured `exec.spawn`; `--schema-b64` injects a `StructuredOutput` tool enforced via `afterToolCall` capture + ≤2 nudges. Per-run scratch cwd at `/shared/workflow-runs/<runId>/scratch/`. Background runs managed by `scoops/workflow-run-manager.ts` (`WorkflowRunManager` on `__slicc_workflows`); cone-initiated runs deliver completion as a `'workflow'` lick. `workflow save` persists a run's source to `/workspace/.workflows/`; `*.workflow.js` auto-discovers as commands via `workflow-discovery.ts` + `ScriptCatalog.getWorkflowCommands` (dispatch-time precedence `built-in > .jsh > saved-workflow`). See `docs/shell-reference.md` workflow section for API and usage.
- `supplemental-commands/{usb,serial,hid}-command.ts` are the WebUSB / Web Serial / WebHID shells; `supplemental-commands/esptool-command.ts` flashes ESP32 / ESP8266 over a `serial` handle. Each keeps opaque handles (`usb1`, `serial1`, `hid1`, …) in a page-side registry and forwards every op over panel-RPC to its `*-backends.ts` (device objects never cross the worker boundary). `*-picker.ts` launchers and `remote-terminal-view.ts`'s `--__resolved` gesture rewrite drive the device picker (mirrors `mount`). See `docs/shell-reference.md` for the per-command behavior and the shared gesture-bridge section.
- `jsh-discovery.ts` and `bsh-discovery.ts` provide the raw scans used by the shared catalog.
- `vfs-adapter.ts` bridges shell calls into the virtual filesystem and forwards `canWrite` (duck-typed so both `VirtualFS` and `RestrictedFS` back it without branching).

### Speech (push-to-talk + `hear`)

- Path: `packages/webapp/src/speech/`; command in `supplemental-commands/hear-command.ts`. Page realm only (mic, recognizer, `AudioContext`); the kernel worker bridges over the `hear-*` panel-RPC ops (`hear-capture` / `hear-transcribe` / `hear-status` / `hear-warmup`) with generous per-call timeouts.
- `composer-speech.ts` — `getComposerSpeech()` realm singleton implementing the `ComposerSpeech` contract from `@slicc/webcomponents/composer/speech` (deep subpath import, NEVER the barrel — the barrel registers custom elements at import time and breaks DOM-less realms). Injected into `<slicc-composer>` by `wc-live.ts`'s `attachWcClient` (both live and extension mounts), which also sets the `ptt` attribute. Two engines behind the one interface: the library's built-in Web Speech implementation immediately, hot-swapped to on-device whisper once ready; per-session capture failures degrade back to builtin.
- `whisper-engine.ts` — lazy `onnx-community/whisper-tiny` loader mirroring `ffmpeg-wasm.ts`: dynamic `import('@huggingface/transformers')`, model files streamed from the HF CDN on first use and cached via transformers.js' Cache Storage; WebGPU (fp32) with automatic WASM (q8) retry; ort-web runtime assets pinned to the version-matched jsdelivr URL (`ORT_WEB_VERSION` must track the transformers dependency). `warmup` fires on the first granted push-to-talk hold — never at boot.
- `download-progress.ts` — pure multi-file progress + ETA aggregation (unit-tested math behind the "better speech recognition downloading · ready in ~ETA" status line).
- `whisper-session.ts` — MediaRecorder capture → 16 kHz mono resample (`audio.ts`) → rolling re-transcription partials (whisper has no incremental decode) → final transcript on release.
- `hear.ts` — one-shot capture for the command: builtin recognizer owns endpointing (whisper has no VAD); when the enhanced engine is ready the mic is recorded in parallel and whisper supplies the final text, builtin text as fallback.
- `kokoro-engine.ts` — lazy Kokoro-82M TTS (`onnx-community/Kokoro-82M-v1.0-ONNX` via `kokoro-js`); its download CHAINS automatically off the whisper load (`whisper-engine.ts`). kokoro-js pins transformers ^3.x — the Vite configs `dedupe` it onto the workspace 4.x (npm overrides don't reach workspace deps) so one transformers + one ort version ships.
- `speak.ts` — shared synthesis surface: `speak()` picks kokoro (ready + English, or an explicit kokoro voice id) with Web Speech fallback; `speechTextFromMarkdown` reduces replies to speakable prose. Consumed by the `say` command's local path AND the `speak-text` / `list-voices` panel-RPC handlers, so the worker float picks the kokoro upgrade up with no protocol change.
- `voice-reply.ts` — the spoken-reply loop: a turn submitted by push-to-talk (`detail.source === 'dictation'` on the input card's submit event) marks a one-shot flag; the chat controller's `onTurnComplete` consumes it and reads the assistant reply aloud. Typed turns stay silent.

### MCP Servers

- Path: `packages/webapp/src/shell/mcp/`; command in `supplemental-commands/mcp-command.ts`.
- Subcommands: `mcp add <url> <name>`, `mcp list`, `mcp delete <name>`, `mcp invoke <name> [tool] [--flag value]`, `mcp refresh <name>`, `mcp auth <name>` (re-authenticate via silent refresh-token renewal with an interactive popup fallback; `--silent` / `--interactive` to force one path).
- Each registered server is exposed as an `mcp:<name>` OAuth provider (visible in `oauth-token --list`) when the server requires auth.
- `mcp add` auto-writes an alias shim at `/workspace/.mcp/aliases/<name>.jsh` so `<name>` resolves as a top-level command and forwards to `mcp invoke <name>`.
- MCP Apps declared by the server via `apps/list` are materialized as sprinkles under `/workspace/.mcp/sprinkles/<name>/`.
- Registration is lazy: the first subcommand call re-registers all servers from `/workspace/.mcp/servers.json` so providers survive a page reload.

### CDP

- Path: `packages/webapp/src/cdp/`
- `transport.ts` defines the CDP transport interface.
- `browser-api.ts` provides the Playwright-style browser API.
- CLI and extension runtimes supply different transport implementations.
- `cherry-host-transport.ts` is the **third** `CDPTransport` (alongside the WebSocket CLI client and the `chrome.debugger` extension client). It runs inside the embedded follower iframe (`?cherry=1`), speaks the cherry postMessage envelope protocol to the `@ai-ecoverse/cherry` host SDK in `window.parent`, and synthesizes the session lifecycle `BrowserAPI` depends on — `Target.getTargets`/`attachToTarget`, `Page`/`Runtime`/`DOM.enable`, `Page.getFrameTree`, plus `Page.frameNavigated` + `Page.loadEventFired` emitted after a `Page.navigate` resolves so `BrowserAPI.navigate()` doesn't hang. Synthetic ids are `cherry-target` / `cherry-session` / `cherry-frame` / `cherry-loader`. It exposes the `joinUrl` the host supplied in the handshake; the follower embeds against that already-provisioned leader (cone creation from the SDK is out of scope — future work).
- `cherry-host-protocol.ts` is the **canonical** cherry envelope contract and the three-factor `acceptEnvelope` gate (origin allowlist + `MessageEvent.source` identity + per-mount `channelId` nonce). `packages/cherry/src/protocol.ts` is a structural mirror that must be kept in sync.
- **Standalone remote-CDP driving:** the worker-side `BrowserAPI` gets a panel-RPC bridging `TrayTargetProvider` (`cdp/panel-rpc-tray-provider.ts`) so the cone can _drive_ federated tray/cherry targets, not just list them. `PanelRpcCdpTransport` (`cdp/panel-rpc-cdp-transport.ts`) tunnels CDP over the panel-RPC BroadcastChannel to page-side `remote-cdp-*` handlers (`ui/remote-cdp-page-bridge.ts`), which own the real `RemoteCDPTransport`. Events return via the `remote-cdp-event` push. Extension mode is unaffected (in-realm). See issue #848.

### Tools

- Path: `packages/webapp/src/tools/`
- Active surface is file tools, `bash`, and scoop/nanoclaw helpers.
- Browser automation is intentionally routed through shell commands rather than a separate tool family.

### Sudo (agent action approvals)

- Paths: parser/matcher `shell/sudo/sudoers.ts`, FS gate `fs/sudo-fs.ts`, command gate `shell/sudo/command-guard.ts`, brokers + manager `sudo/`.
- `SudoManager` (`sudo/sudo-manager.ts`) is the per-float policy store: the `Orchestrator` constructs one in `init()` once the shared VFS + `FsWatcher` exist, seeds the default `/etc/sudoers` template (bundled from `packages/vfs-root/etc/sudoers`), loads + merges `/etc/sudoers` and `/etc/sudoers.d/*` into a live `SudoersPolicy`, and re-reads it on any change so edits and "Always" grants take effect with no restart.
- Wiring happens in `scoops/scoop-context.ts`: the agent's FS handle is wrapped once with `createSudoFs` and that single gated handle backs BOTH the file tools and the shell, so reads/writes funnel through one `matchPath` check; the shell also gets `SudoManager.getShellConfig()` for command-level gating. The panel terminal is intentionally NOT gated — the human typing there is the approver.
- Brokers are float-specific (`createSudoBroker`): the kernel worker relays approval requests to its page realm (the standalone window, the hosted leader tab the extension pins, or the Electron/hosted-leader page) where the prompt UI lives; standalone CLI / Electron / swift-server / hosted-leader additionally POST `/api/sudo-approve` for OS-native dialog backends. The agent can request approval but can never fabricate the decision.
- Self-protection is hardcoded in `matchPath`: writes to `/etc/sudoers` + `/etc/sudoers.d/*` always require approval regardless of policy. "Always" command grants are appended to `/etc/sudoers.d/granted` via the manager's raw-FS sink (so the grant write itself does not re-prompt).
- Deep reference: `docs/approvals.md` (sudo policy section).

### Tray Sync (multi-browser leader/follower)

- Path: `packages/webapp/src/scoops/tray-*`, plus page wiring in `packages/webapp/src/ui/page-leader-tray.ts` and `packages/webapp/src/ui/page-follower-tray.ts`.
- `tray-sync-protocol.ts` is the **canonical wire format**. The iOS follower (`packages/ios-app/SliccFollower/Models/SyncProtocol.swift`) mirrors a **subset** — federated `fs.*` and follower-originated CDP/tab.open are TS-only. iOS DOES respond to leader-initiated `cdp.request` / `tab.open` (and sends back `cdp.response` / `cdp.event` / `tab.opened`). See `docs/architecture.md` "Multi-Browser Sync (Tray) Architecture" for the matrix, and `packages/ios-app/CLAUDE.md` for the 5-step protocol-update checklist.
- `tray-leader-sync.ts` (`LeaderSyncManager`) — broadcasts agent events, snapshots, scoops list, sprinkle list/content/updates, federated CDP, federated FS; handles inbound requests from followers (snapshot, sprinkle.fetch, sprinkle.lick, scoops.select, CDP/FS routing). `onForwardedLick` callback validates the forwarded lick type against `FORWARDABLE_TO_LEADER`, scrubs any follower-sent origin fields, and stamps `originFollowerId` (bootstrap ID) + `originLabel` (via `labelForFollower(floatType, runtime)`).
- `tray-follower-sync.ts` (`FollowerSyncManager`) — TS follower used by every page-side follower: the standalone browser follower (`page-follower-tray.ts`), the extension's per-page `<slicc-launcher>` follower iframe, and Cherry-host followers. Implements `AgentHandle` so a follower's chat thread forwards user input to the leader instead of a local orchestrator. `forwardLick(event)` sends the generic `lick` follower→leader message (dropped if the channel is closed).
- **Lick forwarding**: `LickManager.setForwarder(fn | null)` installs a forwarder hook; `dispatch()` is the private chokepoint all emit sites route through. When a forwarder is set AND the lick type is in `FORWARDABLE_TO_LEADER` (currently just `navigate`), the lick is forwarded instead of handled locally. `LickEvent` gained optional `originFollowerId` / `originLabel`, set only by the leader. Every float requires a worker↔page bridge (`set-follower-forwarding` / `forward-lick` / `inject-forwarded-lick` messages in `chrome-extension/src/messages.ts`) because the kernel WORKER owns the lick manager while the PAGE owns the sync managers.
- The iOS native follower (`packages/ios-app/SliccFollower/`) is a **separate implementation** of the same protocol — it does NOT consume `tray-follower-sync.ts`. Match its behavior when adding follower-side rendering (e.g., sprinkle handling lives in `AppState.handleDataChannelMessage` + `AppState.fetchSprinkleContent` on the Swift side).
- Sprinkle sync: both the TS browser follower (`SprinkleFollowerController` + `FollowerSyncManager.fetchSprinkleContent`) and the iOS follower (`AppState.fetchSprinkleContent` + `SprinkleWebView`) implement the same chunk-reassemble + waiter-dedup + lick-forward flow. Leader-side wiring lives in `page-leader-tray.ts` (`getSprinkles`, `readSprinkleContent`, `onSprinkleLick`, periodic `broadcastSprinklesList`). The leader pushes `sprinkle.update` payloads when `SprinkleManager.sendToSprinkle(name, data)` runs.
- Leaving a tray: `scoops/tray-leave.ts` exposes `leaveTray()` with a discriminated `LeaveTrayWire` union (standalone-worker / standalone-page transports) — exactly one transport is selected per call. `ui/tray-leave-runtime.ts` houses `performTrayLeave(opts, deps)`, the page-side executor used by both the `slicc:tray-leave` window listener in `main.ts` AND the panel-RPC `tray-leave` op. Result is a discriminated `TrayLeaveResult` (`noop` | `left` | `switched`) so the shell formatter narrows exhaustively. Storage write order is load-bearing: on a leader-restart the storage update happens AFTER `startLeader` resolves — a failed startup rolls back to fully-dormant storage rather than persisting a stale leader-on-failed-worker config. UI surface is the "Stop multi-browser sync" / "Disconnect from leader" button in the avatar popover; shell surface is `host leave [--leader <url>]`.
- Cherry events: `tray-leader-sync.ts:routeCherryHostEvent` receives an inbound `cherry.host_event` (a named event a cherry host page emitted on a follower), resolves the owning follower's runtime id, and hands it to the `onCherryHostEvent(cherryRuntimeId, name, detail)` callback. The callback reaches the worker-resident `LickManager` via the page→worker bridge (`main.ts` → `OffscreenClient.sendCherryHostEvent` → a `lick-cherry-host-event` `PanelToOffscreenMessage` → `OffscreenBridge.handlePanelMessage` → `Orchestrator.handleCherryHostEvent`); the leader runs on the page but `lickManager` lives in the kernel worker. `Orchestrator.handleCherryHostEvent` emits the `'cherry'` `LickEvent` (stamped with a worker-side timestamp); when no callback is wired the event is dropped. The follower send-side is wired symmetrically: the host SDK's `SliccHandle.emitHostEvent(name, detail?)` posts a `host.event` envelope to `CherryHostTransport`, whose `onHostEvent` callback (set in `main.ts`'s cherry follower branch) calls `FollowerSyncManager.sendCherryHostEvent`, which sends the `cherry.host_event` tray message stamped with the follower's own `selfRuntimeId` (informational only — the leader routes by connection identity, not by `targetId`). `'cherry'` is a member of `LickEvent['type']` (`scoops/lick-manager.ts`) and of `EXTERNAL_LICK_CHANNELS` (`scoops/lick-formatting.ts`), so it renders live as a chat chip. `formatLickEventForCone` labels it **Cherry Event** and renders `[Cherry Event: <name>] from <origin> (runtime <runtimeId>)` plus the body as a JSON block (fields `cherryName` / `cherryOrigin` / `cherryRuntimeId`). The reverse direction — pushing a `slicc.event` _to_ a cherry host page through a follower runtime — is the `cherry-emit` supplemental command (`shell/supplemental-commands/cherry-emit-command.ts`): `cherry-emit <name> [--detail <json>] [--runtime <id>]`; `--runtime` is required when more than one runtime is connected. The kernel-worker command bridges the emit to the page over the panel-RPC `cherry-emit` op, where `createStandalonePanelRpcHandlers` (`main.ts`) calls the page-side `LeaderSyncManager.emitCherrySliccEvent`, which sends a `cherry.slicc_event` tray message to the owning follower; the follower's `FollowerSyncManager` (`onCherrySliccEvent`) forwards it to `CherryHostTransport.emitSliccEventToHost`, which posts a `slicc.event` to `window.parent` where the host SDK's `hooks.onSliccEvent(name, detail)` observes it. The delivery result is propagated back to the command: `emitSliccEvent` resolves `{ delivered, reason? }`, and `cherry-emit` exits non-zero with the `reason` on stderr on any non-delivery — no page bridge, no active leader, the named follower runtime not connected, or a panel-RPC transport fault — rather than silently reporting success.
- Re-enabling after Stop: `ui/tray-join-url.ts:computeTrayMenuModel` returns `kind: 'leader-offer'` when both leader and follower are `inactive`. The avatar popover renders an "Enable multi-browser sync" button that calls `leaveTray({ workerBaseUrl })` after resolving the worker URL via `resolveTrayWorkerBaseUrl` (so `VITE_WORKER_BASE_URL` and any surviving stored value still win over the dev/prod default — matching `main.ts` boot resolution). The existing `kind: 'switched'` branch in `performTrayLeave` covers `inactive → leader` without a separate helper.

### Core Agent

- Path: `packages/webapp/src/core/`
- Built on `pi-agent-core` and `pi-ai`.
- `tool-adapter.ts` bridges legacy tool definitions into the pi-compatible tool layer.
- `session.ts` and UI session storage keep the browser runtime restorable.

### Context Compaction

- Path: `packages/webapp/src/core/context-compaction.ts`
- Handles large-context summarization, image resizing, and overflow recovery.
- **GC threshold is model-sized**: `scoop-context.ts` forwards the resolved `model.contextWindow` into `createCompactContext` so compaction fires at `contextWindow - reserveTokens`, not a hardcoded value. The Adobe proxy reports up to 1M tokens for Sonnet/Opus 4.x (`/v1/config` and `/v1/models` both carry `context_window`; `getModelIds` propagates it via the pure `src/providers/adobe-model-metadata.ts` helper → `applyModelMetadata`). A `0`/missing window falls back to `createCompactContext`'s 200K default (passing `0` would make the threshold negative and compact every turn). Before this wiring, every cone compaction — and its memory-extraction call — fired at ~183K regardless of model, i.e. ~18% of a 1M-window model's capacity.
- When `onMemoryUpdates` is wired on `CompactionConfig` (cone only — see `scoop-context.ts` wiring), compaction makes a second LLM call that shares the same system prompt to extract durable memories. The system prompt embeds the serialized conversation so Anthropic prompt caching hits on the prefix and the memory call is near-free. Memory bullets land in `/workspace/CLAUDE.md` via `orchestrator.appendConeMemory` (the cone-private memory file); the `update_global_memory` tool remains the explicit-edit surface for `/shared/CLAUDE.md`. Memory extraction is best-effort and never blocks compaction.
- `appendConeMemory` is size-bounded by `scoops/cone-memory-budget.ts`: `budget = MEMORY_BASE_CHARS + MEMORY_PER_LOG_CHARS * log2(sessions + 2)` (currently 4000 + 2000 per log2). When a fresh append pushes the file past `budget * MEMORY_OVERSHOOT_RATIO` (1.25), the sink runs an LLM restructure over the `## Auto-extracted` tail only — the user-authored header above the first `## Auto-extracted` heading is preserved verbatim. Concurrent appends are serialized through `coneMemoryChain` on the orchestrator. Restructure failure is logged and the appended file is left in place (next append re-attempts).
- `runOneOffCompactionCall` is the reusable primitive — same shared-system-prompt shape, single call. Used by the "New session" freezer to generate a title and extract memories over the live cone session.

### Frozen Sessions ("New session" flow)

- Path: `packages/webapp/src/ui/session-freezer.ts`, `packages/webapp/src/ui/new-session.ts`
- The avatar-popover "New session" entry and thread-header refresh button both run the freezer over the cone session, then clear only the cone (scoops survive). The freezer writes `/sessions/<timestamp>-<slug>.md` (YAML frontmatter + an HTML-commented `slicc:session-data` block carrying the structured `ChatMessage[]` + a human-readable markdown body) and prepends an entry to `/sessions/index.json`.
- The freezer's memory-extraction step appends bullets to `/workspace/CLAUDE.md` via the VFS-only `appendConeMemoryViaVfs` helper (symmetric path to `orchestrator.appendConeMemory`, same target file). Both the synchronous freeze and the boot-time `pending-enrichment` re-run use this path; `/shared/CLAUDE.md` is no longer touched by the freezer.
- `scoops-panel.ts` renders the index as a frozen-sessions section below the live scoops list in every float that hosts the cone (standalone, hosted-leader, the pinned hosted leader tab the thin extension opens). Clicking an entry reads the archive, parses it via `parseFrozenArchive`, and hands the messages to the chat surface for a read-only render — same affordance as clicking a live scoop.
- Clearing semantics: `OffscreenClient.clearAllMessages()` is cone-only. It awaits the bridge's `clear-chat-ack` before resolving so the page can `location.reload()` without racing in-flight kernel-worker writes.

### UI

- Path: `packages/webapp/src/ui/` — the `@slicc/webcomponents` shell (`ui/wc/`). The legacy Layout/ChatPanel UI was deleted in PR #961; full history is in git.
- `main.ts` boots the WC shell for every float: standalone / electron-overlay / hosted-leader / cherry / the pinned hosted-leader tab the thin extension opens → `wc/wc-live.ts` (kernel worker + tray sync + panel RPC); the residual `wc/wc-extension.ts` (`OffscreenClient` over `chrome.runtime`) is still wired for legacy extension-detached entry points but the extension itself no longer ships a bundled UI. `?connect=1` keeps the slim provider-login surface; `?ui-fixture` renders the design-time fixture with no kernel.
- `ui/wc/` module map: `wc-live.ts` (prepare/attach boot, dips, workbench, freezer rail), `wc-shell.ts` (frame composition + refs), `wc-chat-controller.ts` (AgentHandle ⇄ thread state machine; swap-able agent for tray follower mode), `wc-message-view.ts` (ChatMessage → components, reusing `message-renderer.ts`), `wc-tray.ts` (leader/follower orchestration over the reused tray primitives), `wc-sprinkles.ts` (SprinkleManagerCallbacks over workbench tabs/surfaces/dock), `wc-nav.ts` (model picker, settings dialog, tray menu), `wc-workbench.ts`, `wc-freezer.ts`, `wc-memory.ts`, `wc-voice.ts`, `wc-extension.ts`.
- **URL state**: live floats sync UI state with the page URL at the component level (`urlState` mount option → the library's `url-state` attribute; `internal/url-state.ts` in `@slicc/webcomponents`). The thread owns `ctx` (active context, pushed — back/forward walks contexts) and `at` (scroll position, debounced replace); the shell owns `ws` (open workspace surface). The host only routes: `ensureSelection` honors a `pendingUrlContext` boot deep link (`scoop:<name>` select, `freezer:<file>` thaw on kernel-ready), popstate context changes arrive as the thread's `slicc-url-context` event, and `setActivateSurface` re-fires a pre-attach `ws` restore. There is deliberately no global URL state manager.
- Surviving non-WC modules are runtime substrate, not shell: `provider-settings.ts` (accounts/models + the settings dialog), the sprinkle renderer/manager/bridge stack, `dip.ts`, `session-freezer.ts`/`new-session.ts`, `page-leader-tray.ts`/`page-follower-tray.ts`, `offscreen-client.ts`, `panel-rpc-handlers.ts`, `remote-cdp-page-bridge.ts`, `preview-vfs-responder.ts`. Scoped legacy stylesheets load lazily via `legacy-styles.ts` (dialogs, dips, sprinkle chrome) — never load broader legacy CSS alongside the WC shell (prototype class-name collisions).
- `runtime-mode.ts` defines `UiRuntimeMode` (`'standalone' | 'extension' | 'electron-overlay' | 'extension-detached' | 'hosted-leader' | 'connect' | 'cherry'`) — `resolveUiRuntimeMode()` inspects `window.location.href` and the extension flag to pick the boot path in `main.ts`. The `?cherry=1` query selects `'cherry'`: `main.ts` then runs `main-cherry.ts:setupCherryFollower()`, which builds a `CherryHostTransport` against `window.parent`, completes the host handshake, reads the `joinUrl` the host supplied directly in `handshake.welcome`, and wraps a `BrowserAPI` around the transport. Embedding requires the host to pass a ready `joinToken`; provisioning/creating a cone from the SDK is out of scope (future work).
- **Cloud cone config (hosted-leader + connect):** the hosted-leader boot fetches `/api/hosted-bootstrap` (`{ model, accounts }`) and applies it via `ui/hosted-config-apply.ts` — `applyHostedAccounts` reconciles `slicc_accounts` to the bundle (oauth→`saveOAuthAccount`, apikey→`addAccount`, and **managed-only** removal: it only deletes providers tracked in `localStorage['slicc_cloud_managed']`, never a user's in-cone-added account). **Before** applying accounts, the boot calls `prewarmHostedModels` (same module), which invokes each OAuth provider's `ProviderConfig.refreshModels(accessToken)` so the model list is fetched + persisted to `localStorage` _before_ the account write triggers the kernel-worker's model resolution. Without this the cone resolves against a cold default list: a model id pi-ai's registry doesn't know (e.g. `claude-opus-4-8` — present via Adobe but absent from `models.generated.js`) would resolve with a 200K default window, and previously degraded to a **native** Anthropic model entirely (`resolveCurrentModel`'s old last-resort), sending the IMS token to api.anthropic.com → `401 invalid x-api-key`. `resolveModelById`/`resolveCurrentModel` now route unknown OAuth ids through the provider (`buildProviderRoutedModel`) regardless, so the 401 can't recur even on a cold cache. The `?connect=1` mode (`mode === 'connect'`) is a slim **login-only** boot that mounts just the provider-login + accounts UI plus a Done button (`ui/connect-surface.ts`, reusing `showProviderSettings` — no kernel/orchestrator); the `/cloud` dashboard opens it same-origin so harvested accounts land in shared `localStorage`. Model selection lives in the dashboard, not the popup: connect-surface persists `getAllAvailableModels()` to `localStorage['slicc_cloud_model_catalog']` and the dashboard derives its model dropdown from that (filtered to connected providers via `modelsForConnected` in `cloud/cone-config-client.js`, with a small built-in fallback map). Connect mode sets `globalThis.__slicc_connect_mode`, which suppresses the `/api/secrets/oauth-update` replica POST in `saveOAuthAccount` (no node-server on `www.sliccy.ai`). The `ConeConfig`/`Account` types come from `@slicc/cloud-core/cone-config` (the browser-safe subpath — never import the cloud-core root, which pulls in `e2b`).
- `preview-sw.ts` serves `/preview/*` content from VFS and is built as a standalone IIFE.
- **Design-time chat fixture**: load the app with `?ui-fixture` (any value) to render the WC shell over a synthetic session covering every message variant — user/assistant bubbles, markdown + code blocks, all four tool-call states, the six lick channels, delegation, queued messages, and a streaming tail. Messages live in `chat-fixture.ts` (pure `createChatFixture()`) and persist to a dedicated `session-ui-fixture` id so real scoop storage is untouched; clicking any real scoop cleanly exits fixture mode. Vite HMR picks up CSS changes live against the fixture. When adding new message UI variants, extend `createChatFixture()` and the matching assertion in `tests/ui/chat-fixture.test.ts` so the harness stays comprehensive.

### Skills

- Path: `packages/webapp/src/skills/`
- Discovers install-managed native skills from `/workspace/skills/`.
- Also discovers compatible read-only skill roots under `.agents/skills/*/SKILL.md` and `.claude/skills/*/SKILL.md`, and marketplace skills from any `.claude-plugin/marketplace.json` manifest found in the VFS (skills at `<plugin-source>/skills/<name>/SKILL.md`). Precedence: native → agents → claude → marketplace.
- **Never monkeypatch an fs method in place on a get/set-asymmetric Proxy.** `catalog.ts`'s compatibility-skill cache is invalidated by wrapping `writeFile`/`mkdir`/`rm`/… in place. The agent shell hands discovery the **sudo-fs `Proxy`** (`fs/sudo-fs.ts`), whose `get` returns a gating override while `set` writes through to the wrapped target — so reassigning a gated method clobbers the target's real method and leaves the override delegating to the new wrapper, whose captured `original` is that same override: an unbounded `override↔wrapper` async recursion that OOMs the kernel worker on the next gated write (stardust `upskill` → `playwright-cli` writing `/.playwright/session.md`). The sudo Proxy therefore advertises `MONKEYPATCH_UNSAFE_FS` (a `Symbol.for` registry marker) and `getCompatibilitySkillCandidates` skips both the hooks **and** the cache for it (always re-discovers). Boot-time `loadSkills` uses the unwrapped fs, so it is unaffected — which is why the crash only reproduced on first-time, in-shell skill installs.

### Sprinkle Rendering

- Main files: `packages/webapp/src/ui/sprinkle-renderer.ts`, `sprinkle-manager.ts`, `sprinkle-discovery.ts`
- `.shtml` files are discovered from the VFS and rendered as persistent panels.
- Standalone / hosted-leader mode renders fragments directly or full docs in `srcdoc` iframes (the hosted leader tab pinned by the thin Chrome extension goes through this path too).
- The extension's per-page `<slicc-launcher>` follower iframe and any sandboxed-CSP path route rendering through `sprinkle-sandbox.html` served from the extension origin; see the extension guide for CSP specifics.

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
- **Adobe `X-Session-Id` invariant**: every LLM call to the Adobe proxy must attach the `X-Session-Id` header (`scoops/scoop-context.ts` wires it for both the agent `streamFn` and compaction `headers`). New LLM call sites — direct `streamSimple` / `completeSimple` callers, or pi-coding-agent helpers like `generateSummary` — must attach it explicitly or the proxy session-id grouping breaks. `providers/adobe.ts`'s `ensureSessionIdHeader` is a defense-in-depth net that injects a daily-rotated sentinel UUID and warns when a caller didn't attach one — fix the call site rather than relying on the fallback. See `docs/pitfalls.md` for the full contract, tripwire, and verification SQL.
- **Claude Bedrock capability shims** (pinned pi-ai 0.75.3 predates opus-4-8 → Bedrock 400 → Adobe proxy 502 relayed on `/api/fetch-proxy`): fix at the provider layer, never the call site. Both shims delegate to a shared version-threshold parser `src/providers/claude-model-version.ts` (`parseClaudeVersion` + `claudeSupportsAdaptiveThinking` / `claudeRejectsTemperature` / `claudeSupportsNativeXhighEffort` / `claudeSupportsMaxEffort`) so future Opus / Sonnet releases (4.9, 5.x) are handled automatically — no per-model edit. (1) **temperature** — Opus ≥ 4.7 rejects it; `src/providers/temperature-support.ts` (`modelSupportsTemperature` / `withSupportedTemperature`) delegates to `claudeRejectsTemperature`, consulted by `providers/adobe.ts` + `providers/built-in/bedrock-camp.ts` (only thinking-disabled helpers like `ui/quick-llm.ts` hit it — pi-ai drops temperature when thinking is on). (2) **adaptive thinking** — Opus / Sonnet ≥ 4.6 needs `thinking:{type:"adaptive"}` + `output_config.effort`; pi-ai already emits that for opus-4-6/4-7 + sonnet-4-6 but misses opus-4-8 and would similarly miss opus-4-9 / sonnet-4-7. `src/providers/adaptive-thinking.ts` (`withAdaptiveThinkingShim`) wires an `onPayload` rewrite in `providers/adobe.ts` that fires only when the legacy enabled+budget shape is present, so it's a no-op when thinking is off or for models pi-ai already emits the adaptive shape for. Effort mapping for `reasoning:'xhigh'` also uses the shared predicates (`native xhigh` on Opus ≥ 4.8, else fallback to `max` on Opus ≥ 4.6, else `high`). See `docs/pitfalls.md`.

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
- `packages/webapp/src/shell/script-catalog.ts` shares discovery across `AlmostBashShell`, `which`, and other lookup paths. Raw scanning still comes from `jsh-discovery.ts`, which scans `/workspace/skills` first, then the wider VFS.
- Scripts run in an async wrapper: prefer top-level `await` and always `await fs.*` operations.
- Stdin from upstream pipelines is fully buffered (no streaming) and exposed via `process.stdin`. `read()` drains the buffer with Node-like EOF semantics (returns the buffered string the first time, `null` thereafter) and shares that consumed state with `for await (const chunk of process.stdin)`. `String(process.stdin)` is a non-consuming view. `process.stdin.isTTY` is always `false`. `node`'s read-from-stdin branch (when stdin is the script source) hands the inner script an empty stdin so it can't read its own source. Stdin is intentionally NOT exposed as a top-level identifier so user scripts can keep declaring `const stdin = …` without colliding.

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
- Extension silent renewal runs `launchWebAuthFlow` non-interactively (`interactive:false` + `abortOnLoadForNonInteractive:false` + `timeoutMsForNonInteractive`) and throttles repeat failures via a 5-minute cooldown; see `docs/oauth-intercept.md` "Silent token renewal".

### Per-provider extra allowed domains

Provider `oauthTokenDomains` is an immutable safe default; users can layer additional allowed domains per-provider:

- Storage: `localStorage["slicc_oauth_extra_domains"]` → `{[providerId]: [domain, ...]}`
- Helpers: `getExtraOAuthDomains(id)` / `setExtraOAuthDomains(id, domains)` / `getAllExtraOAuthDomains()` (sync, page-only) and `setExtraOAuthDomainsAsync(id, domains)` (worker-safe — routes through `panel-rpc` when no DOM, then mirrors the post-write store into the worker shim so same-session reads stay consistent) in `provider-settings.ts`
- Surfaces: panel terminal `oauth-domain` command (worker float — uses the async setter), extension options page "OAuth domains" tab (page float — uses the sync helpers directly)
- Merge: `saveOAuthAccount` concatenates defaults + extras, dedupes case-insensitively (defaults-first order), then pushes the merged list to the fetch-proxy / SW.
- Worker-side write path: the kernel-worker shim's `localStorage.setItem` is page→worker only (no echo-back). Writes from the worker MUST go via `setExtraOAuthDomainsAsync` / the `oauth-extras-set` panel-rpc op, otherwise they're swallowed by the shim Map and lost on reload — see issue #701.

### Shell-env masked secret population

`scoop-context.ts` (agent shell) and `main.ts` (panel terminal `RemoteTerminalView`) both call `fetchSecretEnvVars()` from `packages/webapp/src/core/secret-env.ts` and pass the result as `env`. The function filters secret names to POSIX-valid identifiers (`/^[A-Za-z_][A-Za-z0-9_]*$/`) so dot-namespaced internal secrets (`s3.<profile>.*`, `oauth.<id>.token`) stay out of `$ENV` / `printenv`.

## Related Guides

- `packages/chrome-extension/CLAUDE.md` for extension runtime constraints
- `packages/node-server/CLAUDE.md` for the CLI/Electron float
- `packages/shared-ts/CLAUDE.md` for secret masking primitives
- `docs/architecture.md` for repo-wide file maps and deeper subsystem inventories
- `docs/shell-reference.md` for command-by-command shell behavior
