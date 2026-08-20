# webapp subsystem details

Overflow from `packages/webapp/CLAUDE.md`. Each section is the deep reference for a subsystem enumerated there.

## Kernel Host

- Path: `packages/webapp/src/kernel/`
- `host.ts` — `createKernelHost(config)` factory: single boot sequence for every float (orchestrator, lick-manager, agent-bridge, tray subs, cone bootstrap, BshWatchdog, `/proc` mount). `node-rest` opens the `/licks-ws` bridge; extension-delegate leaders route licks through the tray worker. Float discriminator: `resolveFloatTopology()` in `shell/float-topology.ts` (`core/float-topology.ts` is a compatibility re-export). `kernel-worker.ts` is the DedicatedWorker entry.
- `process-manager.ts` tracks every long-running async unit; pids uint32 from 1024+; `signal(pid, sig)` honors SIGINT/SIGTERM/SIGKILL/SIGSTOP/SIGCONT. `proc-mount.ts` serves read-only `/proc` (`cat /proc/<pid>/{status,cmdline,cwd,stat}`).
- `realm/` hard-killable runner. `runInRealm()` spawns per-task `DedicatedWorker`; SIGKILL → exit 137. JS runs in kernel worker via `createJsWorkerRealm()`; `realm-host` proxies `vfs`/`exec`/`fetch`. Node shims in `realm/helpers/` (barrel: `js-realm-helpers.ts`). Sync-XHR bridge (`readFileSync`/`writeFileSync`, `child_process.execSync`/`execFileSync`/`spawnSync`) via `realm/sync-{xhr,fs-*,exec-*}.ts` + `ui/sync-fs-sw-handler.ts` with per-realm capability tokens.
- Deep reference: `docs/kernel/process-model.md`.

## Orchestrator

- Path: `packages/webapp/src/scoops/`
- `orchestrator.ts` owns scoop lifecycle, routing, shared state, and pre-removal `onScoopUnregistered` snapshots. `scoop-context.ts` owns per-scoop prompt execution and FS/tool isolation. `agent-bridge.ts` exposes `globalThis.__slicc_agent` (defaults: writable `[cwd, /shared/, <scratch>/, /tmp/]`, visible `[/workspace/, invokingCwd]`; `--read-only` replaces).
- `scoop-message-router.ts`: licks use `SCOOP_QUEUE_DEBOUNCE_MS` (1 s) bounded by `SCOOP_QUEUE_MAX_COALESCE_MS` (3 s); pure-lick batches defer while `ScoopContext.isBusy` without queue/watermark loss; `SCOOP_DEFERRAL_STARVATION_MS` reports backpressure once after 5 min. User `web` bypasses the window (immediate/awaited, prevents deferral).
- `transcript-limits.ts` caps bridge/event transcripts at 64 KB — never canonical `agent-sessions` history or compaction input.

## VirtualFS

- Path: `packages/webapp/src/fs/`. `virtual-fs.ts` POSIX-like FS backed by OPFS (in-memory in Node tests). `restricted-fs.ts` path ACLs. `mount-commands.ts` parses `--source`/`--profile`/`--no-probe`; `path-utils.ts` normalization.
- `mount/` — `MountBackend` + `backend-local.ts` / `backend-s3.ts` / `backend-da.ts` and shared `RemoteMountCache` (TTL+ETag, IDB). Browser-naive signing: CLI → `/api/s3-sign-and-forward`, extension → SW. `mount-table-store.ts` / `mount-recovery.ts` persist and restore. See `docs/mounts.md`.

## Shell

- Path: `packages/webapp/src/shell/`. `almost-bash-shell.ts` is the just-bash runtime; `supplemental-commands/` built-ins live under `docs/shell-reference.md`. `script-catalog.ts` is the shared `.jsh`/`.bsh` discovery for the shell and `which`, cached per `$PATH` root set; the `FsWatcher` cache is bypassed only for root sets a mount overlaps (external changes there are invisible). `vfs-adapter.ts` bridges shell → VFS and forwards `canWrite` (duck-typed for `VirtualFS`/`RestrictedFS`).
- `typescript` v7 (native) runs checks/builds; `typescript-js` (JS v6) powers browser `tsc`/`test`/`esm-transpile` because v7 has no browser/WASM API. `builtin-shadow-map.ts` is authoritative for `ipx`/`npx` → built-in redirects. Raw scans: `jsh-discovery.ts` / `bsh-discovery.ts`.

## Speech

- Path: `packages/webapp/src/speech/`; entry `supplemental-commands/hear-command.ts`. **Page realm only** (mic, AudioContext); kernel worker bridges via `hear-*` panel-RPC.
- Web Speech API (immediate) hot-swapped to on-device Whisper (`onnx-community/whisper-tiny`); Kokoro TTS (`Kokoro-82M-v1.0-ONNX`) chains off the whisper load. Kokoro selects on English + on-device readiness; Web Speech is fallback.
- Asset staging (`ensure-speech-assets.ts` via `kernel/speech-assets-bridge.ts`) is **single-flight**: the worker responder coalesces concurrent page requests (`hear --warmup`, `say --warmup`, the composer warmup) onto one run and fans progress/result out to every caller — never run two stagers over the same tree. `hf download` skips a present file only at the **listed byte length** (a torn write is re-fetched), and the ort install is gated on the required jsep + plain threaded builds only — optional `asyncify`/`jspi` variants missing must not trigger a `dist/` rewrite under a loading engine.
- ort-web threads (`transformers-env.ts` `resolveOrtNumThreads`, #2042): set explicitly, never auto-detected. Isolated leader (Document-Isolation-Policy) → `min(4, hardwareConcurrency)`; any non-isolated float → `1`. `localStorage.slicc_ort_num_threads` overrides (clamped to `[1, min(4, cores)]`, isolated only) for A/B timing — it **persists** until removed and logs a `console.warn` whenever it is in effect; `whisper transcribe` / `kokoro synthesize` log lines carry `elapsedMs` + `numThreads`.
- **Extension `uiOnly` side panel**: Chrome denies `getUserMedia` (mic prompt keys on extension origin, ungrantable from cross-origin iframe), so `wc-follower.ts` skips `ptt` and drops "Take a photo". Voice/camera live in the leader tab or detached popout.

## MCP Servers

- Path: `src/shell/mcp/`; command `supplemental-commands/mcp-command.ts`. Lazy registration from `/workspace/.mcp/servers.json`. Subcommands, alias shim, MCP-Apps-as-sprinkles: `docs/shell-reference.md`.

## CDP

- Path: `packages/webapp/src/cdp/`. `transport.ts` CDP transport interface; `browser-api.ts` Playwright-style API. `synthetic-cdp-transport.ts` shared base synthesizes the session lifecycle (`Target.getTargets/attachToTarget`, `Page/Runtime/DOM.enable`, `Page.frameNavigated` + `Page.loadEventFired` after navigate) so `BrowserAPI.navigate()` doesn't hang.
- `preview-bridge-cdp-transport.ts` extends it for driveable preview tabs (`serve --bridge`) over the tray controller WebSocket (`bridge.cdp.request`, `bridge.close` on `Target.closeTarget`). `cdp/panel-rpc-tray-provider.ts` + `cdp/panel-rpc-cdp-transport.ts` let worker-side `BrowserAPI` drive federated tray/cherry/preview targets via the panel-RPC BroadcastChannel.
- `cherry-host-transport.ts` extends `SyntheticCdpTransport` for the embedded follower iframe (`?cherry=1`). **`resolveParentOrigin()` prefers `location.ancestorOrigins[0]` (unforgeable); `document.referrer` alone breaks when Referer is stripped or in HTTP-in-HTTPS dev embeds.**
- `cherry-host-protocol.ts` canonical cherry envelope + three-factor `acceptEnvelope` gate (origin allowlist + `MessageEvent.source` identity + per-mount `channelId` nonce). `packages/cherry/src/protocol.ts` is a structural mirror; keep in sync.

## Sudo (agent action approvals)

- Paths: `base/sudoers.ts` (parser/matcher), `fs/sudo-fs.ts` (FS gate), `shell/sudo/command-guard.ts` (command gate), `sudo/` (brokers + manager).
- `SudoManager` (`sudo/sudo-manager.ts`) per-float policy store; seeds and live-reloads `/etc/sudoers` + `/etc/sudoers.d/*` (edits and "Always" grants apply without restart). `scoop-context.ts` wraps the agent's FS once with `createSudoFs`; single handle backs both file tools and shell. Panel terminal is intentionally NOT gated. Brokers float-specific (`createSudoBroker`): extension-delegate relays via hosted leader tab; standalone/Electron POSTs `/api/sudo-approve`.
- **Self-protection**: writes to `/etc/sudoers` + `/etc/sudoers.d/*` always require approval, hardcoded in `matchPath` regardless of policy.
- **"Agent can't self-approve" does NOT cover page-realm code** (which can reassign `globalThis.confirm`): `sudo/panel-responder.ts` captures natives at module init; approval chrome mounts via `ui/wc/trusted-layer.ts`, never `document.body`.
- Deep reference: `docs/approvals.md`.

## Tray

Modules in `scoops/`: `tray-leader-sync.ts` (façade + lifecycle), `context.ts`, `follower-registry.ts`, `follower-dispatch.ts`, `broadcast.ts`, `cdp-router.ts`, `fs-router.ts`, `tab-router.ts`, `remote-exec.ts`, `transcript-export.ts` (streaming), `preview-bridge.ts`, `cherry-router.ts`, `teleport-pool.ts`. Follower model/thinking pills share `ui/wc/wc-follower-model-surface.ts`; `wc-follower.ts` mount and `wc-tray.ts`'s `slicc:tray-join` role switch both consume it. Cherry gated by `CherryFeatureSet.modelPicker`. See `docs/architecture.md` "Multi-Browser Sync (Tray) Architecture".

## Feature Flags

- Add IDs to `FeatureFlagId`/`FEATURE_FLAGS` in `core/feature-flags.ts` and both `wrangler.jsonc` `FEATURE_FLAGS` lists. User-toggleable flags live in the standalone **Experimental features…** avatar dialog (`listFlags()`), not Account settings.
- Parse with `isFeatureEnabled`/`coerceFeatureFlagValue` (trimmed, case-insensitive `on`/`true`/`1`). With `overridableFloats`, precedence is local → remote → bundled. `experimental-settings` is worker-controlled (`userToggleable: false`).
- `setupFeatureFlagsForPage` loads the isolated cache synchronously, then non-blocking `/api/flags?float=<float>` refresh; later config needs reload.

## Context Compaction

- Path: `packages/webapp/src/core/context-compaction.ts`. `scoop-context.ts` passes `model.contextWindow`; compaction fires at window minus reserve (200K fallback when absent/zero). Cone memory appends to `/workspace/CLAUDE.md`; agentic budget covers the whole file, legacy restructuring only `## Auto-extracted`. `agentic-memory` on → compaction builds no memory (#2003); the curator owns it.

## Frozen Sessions ("New session" flow)

- Path: `ui/session-freezer.ts`, `ui/new-session.ts`. **Save**, **Skip memory**, and **Erase** clear cone chat and non-mount `/tmp`, not scoops. Archives in `/sessions/<timestamp>-<slug>.md` + `index.json`. Idle boot recovers pending markers serially (≤3 times) through the **bounded** legacy enrichment call — never the unbounded curator (`timeoutSeconds` cannot stop it). Agentic Save: quick snapshot then clear; title (`skipMemory`) + curator in background. Cone-only `OffscreenClient.clearAllMessages()` awaits `clear-chat-ack` before panel reload.

## UI

- Path: `packages/webapp/src/ui/`; WC shell in `ui/wc/`. `main.ts` boots the WC shell for every float: standalone/electron/hosted-leader/cherry → `wc/wc-live.ts` (kernel worker + tray sync + panel RPC); extension side panel + detached popout → `wc/wc-extension.ts` (`OffscreenClient`). Float discriminator: `resolveUiRuntimeMode()`. `ui/wc/` map: `wc-live`, `wc-shell`, `wc-chat-controller`, `wc-message-view`, `wc-tray`, `wc-sprinkles`, `wc-nav`, `wc-workbench`, `wc-freezer`, `wc-memory`, `wc-extension`; panels in `panelize-shell`, `builtin-panels`, `panel-visibility`, `layout-store`, `agent-panels`, `add-panel-menu`.
- **Layouts** (`docs/layouts.md`): all chrome is a `SliccPanel` in `<slicc-layout>` except the fixed avatar strip (trusted layer). Behind the `panel-layouts` flag. `panelize-shell.ts` RE-PARENTS what `mountWcShell` built, so `WcShellRefs` stays valid. Documents save to `/workspace/layouts/` (free) or `/etc/slicc/layouts/` (gated). `setPanelVisible` must add an unplaced panel but never duplicate a placed one; `sanitizeLayoutName` guards the path a name becomes.
- **URL state**: `ctx` (active context, pushed), `at` (scroll pos, debounced replace), `ws` (open workspace surface). No global manager; the host only routes.
- **Cherry `?cherry=1`** (`main-cherry.ts`): builds `CherryHostTransport` against `window.parent`, reads `joinUrl` from handshake, wraps `BrowserAPI`. Origin detection: see CDP section.
- **Cherry `?cherry=1&ui-only=1`** (extension side panel): suppresses CDP target advertisement, skips `ptt`, drops "Take a photo" (mic denied in cross-origin side panel). Login/onboarding hand-off to the leader tab is gated to `isExtensionSidePanel` only.
- **Cloud cone config** (`ui/hosted-config-apply.ts`): `applyHostedAccounts` reconciles accounts from `/api/hosted-bootstrap`, removing only providers tracked in `localStorage['slicc_cloud_managed']` — never user-added ones. `?connect=1` is a login-only surface (`ui/connect-surface.ts`) with no kernel.

## Skills

- Path: `packages/webapp/src/skills/`. Precedence: native `/workspace/skills/` → `.agents/skills/*/SKILL.md` → `.claude/skills/*/SKILL.md` → marketplace (`.claude-plugin/marketplace.json`) → agent plugins (`plugin` command, `shell/plugins/`).
- **Never monkeypatch a method on a get/set-asymmetric Proxy.** The sudo-fs Proxy advertises `MONKEYPATCH_UNSAFE_FS` (a `Symbol.for` marker); `getCompatibilitySkillCandidates` skips hooks and cache for it (always re-discovers). Reassigning a gated method creates an `override↔wrapper` async recursion that OOMs the kernel worker.

## Sprinkles & Dips

- Sprinkles: `ui/sprinkle-renderer.ts`, `sprinkle-manager.ts`, `sprinkle-discovery.ts`. `.shtml` panels discovered from VFS. CLI: fragments/full docs in `srcdoc` iframes. Extension renders in the hosted `?cherry=1` follower — no extension sandbox.
- Dips: `ui/dip.ts` hydrates assistant `shtml` code blocks into sandboxed iframes after streaming completes. Minimal lick bridge; auto-height via ResizeObserver.

## Stale-asset recovery (post-deploy)

- `setup-preload-error-reload.ts` + `stale-asset-channel.ts` funnel preload, page Worker, worker boot, and scoop-classifier failures into an `instanceId`-scoped 60 s reload; only the owning page reacts. A cone `replayTurn` marker replays one unanswered turn after recovery.

## Shell command authoring

### `.jsh` commands

- `.jsh` files are JavaScript shell scripts discovered from the shell's `$PATH` roots (default: `/workspace/skills`, `/workspace/.mcp/aliases`, `/workspace/bin`, `/shared/bin`; extend via `export PATH` or `~/.profile`); command name is the basename without `.jsh`. `script-catalog.ts` shares discovery across `AlmostBashShell`, `which`, and other lookup paths. Scripts run in an async wrapper: prefer top-level `await`.
- Stdin (`process.stdin`) is fully buffered read-ahead (no streaming; latin1 strings, not `Buffer`s; `'error'` never fires) and one-shot: `read()`, events (`on('data')`→`'end'`→`'close'`, single chunk), and the async iterator share one `consumed` flag, so whichever drains first wins and the others see EOF. `read()` returns `null` (Node parity) when nothing was piped. On the events surface, `pause()` suppresses the deferred emission until `resume()` (the buffer stays drainable) and `process.exit(N)` from a handler exits with code `N`. `process.stdin.isTTY` is always `false`. Do not expose `stdin` as a top-level identifier (collides with user declarations).
- The `fs` shims (sync + async) also serve the stdio fd/device idioms: `readFileSync(0)` / `readFile(0)` / `'/dev/stdin'` return the FULL buffered stdin (encoding-aware; does NOT consume `process.stdin`'s one-shot flag — the buffer is separable), `writeFileSync`/`appendFileSync`/`writeFile` to fd `1`/`2` (or `/dev/stdout`/`/dev/stderr`) land on stdout/stderr, and `existsSync`/`accessSync`/`statSync` report the three stream devices as present (`isFile()` true pragmatically, `isCharacterDevice()` true, size 0). Wrong-direction stream ops and unknown numeric fds throw `EBADF`. Intercepted in `realm-fs-bridge.ts` BEFORE path resolution — no VFS entries involved (`/dev/null` stays a VFS-layer concern).
- `require('readline')` / `require('readline/promises')` resolve to a per-realm shim (`helpers/node-readline.ts`) over the buffered stdin: `createInterface({ input[, output, terminal] })` (or positional `(input, output)`) drains the input once (this DOES consume `process.stdin`, matching Node's flowing mode) and offers `'line'`/`'close'` events (one-hop deferred like the stdin shim), `for await` iteration, and `question()` (callback or Promise; echoes the query to `output` or the realm stdout, answers with the next unconsumed line, `''` at EOF). A final unterminated line is still emitted and CRLF is stripped, per Node.

### `.bsh` browser scripts

- `.bsh` files are JavaScript browser-navigation helpers that run in the **target browser page context** via CDP `Runtime.evaluate`. Access `document`, `window`, page globals — NOT `process`/`fs`/`exec()`. Filename controls hostname matching: `-.okta.com.bsh` → `*.okta.com`; `login.okta.com.bsh` → exact host match. Optional `// @match` directives in the first 10 lines narrow further. `BshWatchdog` uses `ScriptCatalog` for matching.

## Secret-Aware Fetch Proxy

`createProxiedFetch()` (`packages/webapp/src/shell/proxied-fetch.ts`) routes agent-initiated HTTP through the fetch proxy. Extension mode uses a Port-based path (`chrome.runtime.connect({ name: 'fetch-proxy.fetch' })`). Shell-env population: `secret-env.ts` filters secret names to POSIX-valid identifiers (`/^[A-Za-z_][A-Za-z0-9_]*$/`) so dot-namespaced internal secrets stay out of `$ENV`. See `docs/secrets.md` for OAuth bootstrap, silent renewal, and per-provider extra domains.
