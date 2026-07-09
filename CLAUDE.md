# CLAUDE.md

This root file is the repo navigation hub. Keep package-specific architecture and implementation detail in the nearest package `CLAUDE.md`, and keep fast-changing how-to material in `docs/`.

## Module Map

### Packages

| Path                          | Purpose                                                                                                                                 |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/webapp/`            | Browser app core: UI, VFS, shell, CDP, tools, providers, skills, scoops                                                                 |
| `packages/cherry/`            | Host-side embed SDK (`mountSlicc`) lending a third-party page to a leader as a target                                                   |
| `packages/chrome-extension/`  | Manifest V3 extension entry points, HTML shells, and message bridges                                                                    |
| `packages/cloudflare-worker/` | Tray hub worker for session coordination, signaling, TURN credentials, and the `sliccy.ai/cloud` cone dashboard                         |
| `packages/node-server/`       | Node.js CLI/Electron server: Chrome launch, CDP proxy, dev serving, hosted-leader mode                                                  |
| `packages/cloud-core/`        | `@slicc/cloud-core` — shared sandbox-lifecycle library consumed by both `node-server --cloud …` and the worker                          |
| `packages/shared-ts/`         | `@slicc/shared-ts` — platform-agnostic primitives (secret masking, secrets pipeline) shared across all TS packages                      |
| `packages/webcomponents/`     | `@slicc/webcomponents` — the webapp's UI shell (Storybook + `@vitest/browser`); legacy Layout/ChatPanel UI removed in PR #961           |
| `packages/spoon/`             | `@ai-ecoverse/spoon` — injection web component (`<slicc-launcher>` overlay + IIFE bootstrap) consumed by webapp, extension, node, swift |
| `packages/vfs-root/`          | Default VFS content copied into the app on init/reset                                                                                   |
| `packages/swift-launcher/`    | Native macOS SwiftUI launcher app (`Sliccstart`)                                                                                        |
| `packages/swift-server/`      | Native macOS Hummingbird server (`slicc-server`)                                                                                        |
| `packages/ios-app/`           | Native iOS SwiftUI follower app (`SliccFollower`) — joins a leader over WebRTC (SPM project, not an npm workspace)                      |
| `packages/dev-tools/`         | Repo-level tooling: build helpers, QA setup, providers build filter, e2b template for hosted cones                                      |
| `packages/assets/`            | Shared static files (logos, fonts, favicon) used by multiple packages (folder, not an npm workspace)                                    |

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
npm run dev                              # Thin /cdp bridge + Chrome (UI from hosted origin)
```

For runtime-specific commands, use the nearest guide:

- [`packages/webapp/CLAUDE.md`](packages/webapp/CLAUDE.md)
- [`packages/cherry/CLAUDE.md`](packages/cherry/CLAUDE.md)
- [`packages/chrome-extension/CLAUDE.md`](packages/chrome-extension/CLAUDE.md)
- [`packages/cloudflare-worker/CLAUDE.md`](packages/cloudflare-worker/CLAUDE.md)
- [`packages/node-server/CLAUDE.md`](packages/node-server/CLAUDE.md)
- [`packages/cloud-core/CLAUDE.md`](packages/cloud-core/CLAUDE.md)
- [`packages/shared-ts/CLAUDE.md`](packages/shared-ts/CLAUDE.md)
- [`packages/webcomponents/CLAUDE.md`](packages/webcomponents/CLAUDE.md)
- [`packages/vfs-root/CLAUDE.md`](packages/vfs-root/CLAUDE.md)
- [`packages/swift-launcher/CLAUDE.md`](packages/swift-launcher/CLAUDE.md)
- [`packages/swift-server/CLAUDE.md`](packages/swift-server/CLAUDE.md)
- [`packages/ios-app/CLAUDE.md`](packages/ios-app/CLAUDE.md)
- [`packages/dev-tools/CLAUDE.md`](packages/dev-tools/CLAUDE.md)
- [`docs/CLAUDE.md`](docs/CLAUDE.md)

## External Handoffs

In this repo, phrases like `handoff to slicc` or `move this to slicc` mean:

- compose a verb-prefixed instruction: `handoff:<free text>` or `upskill:<github url>`
- open `https://www.sliccy.ai/handoff?handoff=<text>` (or `?upskill=<url>`) in the local browser
- the cloudflare-worker serves that URL with an RFC 8288 `Link` header carrying the SLICC handoff or upskill rel
- SLICC observes the `Link` header on main-frame navigations via a `navigate` lick and shows an approval prompt to the user

Prefer the helper in `.agents/skills/slicc-handoff/scripts/slicc-handoff` when it exists.

## Cross-Cutting Principles

### Ice Cream Vocabulary

- **Cone**: the main agent.
- **Scoops**: isolated sub-agents with sandboxed filesystems.
- **Licks**: external events such as webhooks or cron tasks.
- **Floats**: runtime environments such as CLI, extension, Electron, cloud, and Cherry (an embedded follower garnish — the webapp running `?cherry=1` inside a third-party host page's iframe).

Use the ice cream terms in code review comments and docs when they match the domain.

## Git Conventions

- Keep commits focused and package-local when possible.
- **Linear history**: the merge queue and CI `linear-history` job reject branches with merge commits. Rebase onto the base (`git rebase origin/main`) instead of merging it in (`git config pull.rebase true` helps). Husky enforces this locally via `.husky/pre-merge-commit` and `.husky/pre-push` (reusing `packages/dev-tools/tools/check-linear-history.sh`).
- Do not hand-edit generated output in `dist/`.
- Webapp git behavior is implemented with `isomorphic-git` over the OPFS-backed VirtualFS.
- Auth uses `git config github.token <PAT>`.
- Both modes now route agent-initiated HTTP through `createProxiedFetch()`. CLI uses `/api/fetch-proxy` over Express; extension uses `chrome.runtime.connect({ name: 'fetch-proxy.fetch' })` over a SW Port with response streaming. Webapp git uses `isomorphic-git` over the OPFS-backed VirtualFS; auth uses `git config github.token <PAT>` or GitHub OAuth login (auto-writes masked token to `/workspace/.git/github-token`).

**Requires Node >= 22** (LTS). Ports: 5710 (bridge + /api), 9222 (Chrome CDP), 9223 (Electron CDP). node-server serves no UI in any mode — the webapp loads from the hosted origin and dials back to the local `/cdp` bridge.

### Parallel Instances

Multiple standalone SLICC instances can run simultaneously. All ports auto-resolve to avoid conflicts — just override the UI port:

```bash
PORT=5720 npm run dev   # Second instance on port 5720
PORT=5730 npm run dev   # Third instance on port 5730
```

Each instance gets an isolated Chrome profile (keyed by port) and separate CDP port (auto-detected). HMR shares the UI server. No shared state between instances.

## Philosophy

1. **The Claw Pattern**: SLICC is a persistent orchestration layer ("claw") on top of LLM agents, running in the browser. Agent engine is [Pi](https://github.com/earendil-works/pi-mono) (pi-agent-core, pi-ai).
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
- **Licks**: External events triggering scoops (webhooks, cron tasks, workflow completions). Code: `LickManager`, `LickEvent`, `WorkflowRunManager` (`__slicc_workflows`). Shell: `webhook`, `crontask`, `workflow status/list/stop`. Lick legs (webhook, crontask, `/licks-ws` bridge) are a `node-rest`-only concern; extension-delegate leaders use the tray worker for event routing. Float discriminator: `resolveFloatTopology()` in `packages/webapp/src/core/float-topology.ts`.
- **Floats**: Runtime environments — CLI (`packages/node-server/src/`), Extension (`packages/chrome-extension/src/`), Electron (`packages/node-server/src/electron-main.ts`), Sliccstart (`packages/swift-launcher/` — native macOS launcher), **hosted-leader (cloud)** (`@slicc/cloud-core` owns the substrate / start / resume / pause / kill operations; `packages/node-server/src/cloud/` is the CLI adapter that spawns an e2b sandbox running `node-server --hosted`; see `packages/dev-tools/e2b-template/`), **Cherry (embedded follower garnish)** (`packages/cherry/` host SDK `mountSlicc` embeds the webapp with `?cherry=1` in a third-party page's iframe and lends that page to a remote leader as a capability-limited synthetic-CDP target).

Use ice cream terms over technical jargon (e.g., "feed_scoop" not "delegate_to_scoop").

## Architecture

Browser-based AI coding agent running as Chrome extension (side panel), standalone CLI server, or Electron float. For a visual overview of the float topology, see [`docs/architecture-diagram.png`](docs/architecture-diagram.png) (embedded at the top of [`docs/architecture.md`](docs/architecture.md)).

### Three Deployment Modes

- **Chrome extension** (Manifest V3): Thin-bridge — service worker pins a single hosted leader tab (`?slicc=leader&ext=<id>`), which boots the kernel worker + orchestrator. CDP and fetch proxy through the SW bridge. An on-demand `chrome.sidePanel` cockpit (`sidepanel.html`) iframes the hosted `?cherry=1&ui-only=1` follower for inline use. No bundled agent engine or offscreen document (the hosted tab is the UI).
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

`npm run typecheck` runs nine `tsc --noEmit` invocations:

- **Browser bundle** (`tsconfig.json`): `packages/webapp/` + extension `tests/`. The Vite-built extension reuses this config; its extra entries are bundle-time only. Webapp `tests/` pending `#1337`.
- **CLI/Electron** (`tsconfig.cli.json`): `packages/node-server/src/`, compiled to `dist/node-server/`; `packages/node-server/tsconfig.json` adds `tests/`.
- **Tray-hub worker** (`tsconfig.worker.json`): `packages/cloudflare-worker/` src+tests.
- **Kernel-worker safety guard** (`tsconfig.webapp-worker.json`): checks DedicatedWorker-side webapp code with a no-DOM lib set so accidental `window` references fail.
- **Cloud-core library** (`packages/cloud-core/tsconfig.json`): `@slicc/cloud-core` is built ahead of its importers (webapp, node-server, cloudflare-worker) via `postinstall` and the root `build` chain.
- **Cherry / spoon / webcomponents** (`packages/cherry/tsconfig.json`, `packages/spoon/tsconfig.json`, `packages/webcomponents/tsconfig.json`): the host-embed SDK, injection web component, and UI-shell library; each checks src+tests; cherry emits via `tsconfig.build.json`.

`@slicc/shared-ts` uses the same postinstall pre-build pattern as `@slicc/cloud-core` (it must be built before `node-server` and `webapp` can typecheck), but its own `tsc --noEmit` is invoked by its workspace `npm run typecheck` script rather than the root pipeline.

### Key Subsystems

**Orchestrator** (`packages/webapp/src/scoops/orchestrator.ts`): Creates/destroys scoops, routes messages, manages VFS. Cone delegates via `feed_scoop` — scoops get complete self-contained prompts (no access to cone's conversation). Exposes `observeScoop(jid, handler)` for per-scoop event taps (observers are dropped defensively on both `unregisterScoop` and `destroyScoopTab`). `agent-bridge.ts` publishes `globalThis.__slicc_agent` — the shell-facing surface used by the `agent` supplemental command to spawn ephemeral one-shot sub-scoops with `notifyOnComplete: false` (no cone turn on completion).

**VirtualFS** (`packages/webapp/src/fs/`): POSIX-like async FS backed by OPFS (`backend: 'opfs'`; in-memory in Node tests). `RestrictedFS` wraps it with path ACLs for scoops. `FsError` carries POSIX error codes. The legacy LightningFS-IDB era is fully removed — nothing reads `slicc-fs` anymore (`slicc-fs-cleanup` deletes the leftover database).

**Mount backends** (`packages/webapp/src/fs/mount/`): `LocalMountBackend` (FS Access), `S3MountBackend`, `DaMountBackend` are **signing-naive** in the browser bundle — they construct logical requests and call an injected `SignedFetch*` transport. The transport routes to `/api/s3-sign-and-forward` / `/api/da-sign-and-forward` (CLI; node-server resolves credentials, signs SigV4, forwards) or to `chrome.runtime.sendMessage` (extension; service worker reads `s3.<profile>.*` from `chrome.storage.local`, signs, forwards via `host_permissions: <all_urls>`). The agent never holds S3 credentials in either deployment. The IMS bearer token for DA flows transiently in the envelope; v2 will move that OAuth flow server-side too.

**Shell** (`packages/webapp/src/shell/`): AlmostBashShell wraps just-bash (a pure-TypeScript Bash interpreter, not WASM — hence the name; only specific commands like `python3`/`sqlite3`/`convert`/`ffmpeg` and the JS sandbox use WASM). Just-bash builtins plus ~50 supplemental commands registered in `shell/supplemental-commands/index.ts` and `shell/almost-bash-shell-headless.ts` (notable: `git`, `node -e`, `python3 -c`, `playwright-cli`, `open`, `serve`, `sqlite3`, `tsc`, `test`, `ffmpeg`, `convert`, `pdftk`, `xxd`, `upskill`, `discover`, `hf`, `webhook`, `crontask`, `fswatch`, `workflow`, `mount`, `usb`, `serial`, `hid`, `esptool`, `oauth-token`, `oauth-domain`, `secret`, `agent`, `mcp`, `host`, `ps`, `kill`, plus macOS-style helpers `say`/`hear`/`afplay`/`pbcopy`/`pbpaste`/`screencapture`). See [`docs/shell-reference.md`](docs/shell-reference.md) for the authoritative per-command list. `agent` spawns a one-shot sub-scoop via AgentBridge — shell surface for scoop delegation from any float. `workflow run` (SP1) executes Claude Code dynamic workflows natively — plain-JS orchestration scripts that fan out to parallel subagents via `agent(prompt, {schema?})` while keeping intermediate results in script variables instead of the model's context; built over `executeJsCode` → `runInRealm({ kind: 'js' })` with a prelude supplying the orchestration API + determinism guards; dual-mode (standalone/extension) by construction. `mcp` (`add`/`list`/`delete`/`invoke`/`refresh`) auto-writes a `.jsh` alias shim at `/workspace/.mcp/aliases/<name>.jsh`, registers `mcp:<name>` OAuth providers, and materializes MCP Apps as sprinkles under `/workspace/.mcp/sprinkles/<name>/`; lazy re-registration from `/workspace/.mcp/servers.json`. **USB / Serial / HID gesture bridge**: `usb`/`serial`/`hid` expose WebUSB / Web Serial / WebHID via opaque page-side handles (`usb1`, `serial1`, `hid1`), and `esptool` flashes ESP32/ESP8266 over the `serial` handle namespace. The kernel worker has no `window`, so device ops forward to the page realm over panel-RPC. The `<cmd> request` device picker needs a real user gesture — `RemoteTerminalView` runs it on the Enter keystroke and forwards a rewritten command carrying `--__resolved` (parallel to `mount`'s local-picker gesture path); in the extension it routes through a popup window. Chromium-only; unavailable in the cloud / hosted-leader float. Any `*.jsh` file on VFS is auto-discovered as a command. Extension CSP workaround: dynamic code routes through `sandbox.html`.

**CDP** (`packages/webapp/src/cdp/`): `CDPTransport` interface with WebSocket (CLI) and `chrome.debugger` (extension) implementations. `BrowserAPI` provides Playwright-style API (listPages, navigate, screenshot, evaluate, click, etc.). Screenshots normalize DPR to 1.

**Tools** (`packages/webapp/src/tools/`): Active tool surface: `read_file`, `write_file`, `edit_file`, `bash`, plus NanoClaw tools (`send_message`, cone-only: `list_scoops`, `scoop_scoop`, `feed_scoop`, `drop_scoop`, `update_global_memory`). Browser automation goes through shell commands via `bash`.

**Core Agent** (`packages/webapp/src/core/`): Uses pi-agent-core for agent loop, pi-ai for LLM streaming. `tool-adapter.ts` bridges legacy ToolDefinition to pi-compatible AgentTool. `SessionStore` persists conversations to IndexedDB.

**Context Compaction** (`packages/webapp/src/core/context-compaction.ts`): LLM-summarized compaction at `model.contextWindow - reserveTokens` — the resolved model's real window, forwarded by `scoop-context.ts` (e.g. ~983K for a 1M-window Adobe Sonnet/Opus 4.x); falls back to a 200K default only when the model reports no window. Images auto-resized before LLM (5MB base64 limit). Overflow recovery replaces oversized messages (>40K chars) with placeholders.

**UI** (`packages/webapp/src/ui/`): The Lit-based `@slicc/webcomponents` shell (`ui/wc/`) — the legacy Vanilla-TS `Layout`/`ChatPanel` UI was removed in the WC migration (PR #961). `main.ts` boots it per float (`mountWcUiLive` / `mountWcUiFollower` / `mountWcUiExtension` / `mountConnectSurface` / `mountWcUiPreview`). See [`packages/webapp/CLAUDE.md`](packages/webapp/CLAUDE.md) "UI" for the shell module map and [`packages/chrome-extension/CLAUDE.md`](packages/chrome-extension/CLAUDE.md) "Thin Bridge Architecture" for the extension (which ships only a thin wrapper UI; the shell itself is hosted and iframed).

**Extension** (`packages/chrome-extension/src/`): Service worker pins a single hosted leader tab (`?slicc=leader&ext=<id>`), relays CDP traffic + fetch-proxy over `chrome.runtime.connect` bridges, and opens an on-demand `chrome.sidePanel` cockpit (`sidepanel.html`) that iframes the hosted `?cherry=1&ui-only=1` follower. The agent kernel runs in the leader tab's worker. Chat persistence: `browser-coding-agent` IndexedDB. See `docs/architecture.md` "Extension Thin-Bridge Architecture".

**Preview SW** (`packages/webapp/src/ui/preview-sw.ts`): Legacy local `/preview/*` for `open <vfs-path>`. `serve` uses worker-relayed preview. `serve --bridge` makes it driveable as synthetic-CDP target.

**Sprinkle Rendering** (`packages/webapp/src/ui/sprinkle-renderer.ts`): Renders `.shtml` files as interactive UI panels. CLI mode: fragments injected into DOM directly, full documents rendered via srcdoc iframe. Extension mode: ALL content routes through `sprinkle-sandbox.html` (CSP-exempt manifest sandbox) — fragments rendered in sandbox body, full documents via nested srcdoc iframe inside sandbox. See the sprinkles skill (`packages/vfs-root/workspace/skills/sprinkles/`) for rendering modes, bridge API, and style guide.

**Dips** (`packages/webapp/src/ui/dip.ts`): Agent ` ```shtml ` code blocks in chat messages are hydrated into sandboxed iframes after streaming completes. Minimal bridge (lick-only, no state) via postMessage. Auto-height via ResizeObserver. CLI mode: direct srcdoc iframe. Extension mode: routes through `sprinkle-sandbox.html` (same CSP-exempt sandbox as panel sprinkles). Lick events route to the cone via `routeLickToScoop` (CLI) or `client.sendSprinkleLick` (extension). CSS: `.msg__dip` container, `.sprinkle-action-card` component.

**Skills** (`packages/webapp/src/skills/`, `packages/webapp/src/scoops/skills.ts`): native `/workspace/skills/` packages auto-load into the system prompt alongside accessible compatibility skills discovered from `.agents/skills/*/SKILL.md` and `.claude/skills/*/SKILL.md` anywhere in the reachable VFS, and marketplace skills discovered from any `.claude-plugin/marketplace.json` manifest (skills at `<plugin-source>/skills/<name>/SKILL.md`). Only native `/workspace/skills/` entries are install-managed; compatibility and marketplace roots stay read-only. Precedence: native → agents → claude → marketplace.

### Data Flow

```
User → ChatPanel → Orchestrator → ScoopContext.prompt() → pi-agent-core → LLM API
  → Tool calls → RestrictedFS / AlmostBashShell / BrowserAPI → results → back to agent loop
  → Scoop completes → Orchestrator → Cone's message queue
```

### Tray / Teleport Addendum

- Tray hub code lives in `packages/cloudflare-worker/src/` with config in `wrangler.jsonc`; treat it as coordination infrastructure, not canonical session storage.
- When a tray is connected, remote browser targets are exposed through federated target routing; keep CDP local to the runtime that owns the page.
- Teleport is part of the browser/shell workflow: `playwright teleport --start=<regex> --return=<regex>` and equivalent flags on `open`, `tab-new`, and navigation commands.
- Any `*.bsh` file is a browser-navigation helper. Keep detailed behavior in docs rather than growing this root guide.
- **Lick forwarding**: A tray follower forwards `navigate` licks (which is how SLICC handoffs arrive) to the leader's agent instead of handling them locally. The leader stamps the follower's origin onto the forwarded lick; the leader is the origin authority.
- **Preview bridge**: `serve --bridge <dir>` makes a preview driveable as a synthetic-CDP target. Visitor tabs auto-connect over the tray WS; leader drives via playwright. Opt-in only; cross-subdomain cookie risk accepted.

## Key Conventions

- **Two type systems**: Legacy ToolDefinition (`packages/webapp/src/tools/`) and pi-compatible AgentTool (`packages/webapp/src/core/`). Bridged by `tool-adapter.ts`.
- **Tests**: `packages/*/tests/` mirrors the `src/` structure. Vitest, globals: true, environment: node. Use `fake-indexeddb/auto` for VFS tests.
- **Logging**: `createLogger('namespace')` from `packages/webapp/src/core/logger.ts`. DEBUG in dev, ERROR in prod.
- **Extension detection**: `isExtensionRealm()` from `core/runtime-env.ts` (lint-gated)
- **Dual-mode compatibility**: Features MUST work in both CLI and extension. Extension CSP blocks eval/CDN — use `sandbox.html` for dynamic code, `sprinkle-sandbox.html` for sprinkles/dips, `chrome.runtime.getURL()` for bundled assets.
- **Extension `window.open()` returns `null`**: Fire-and-forget; don't treat null as failure.
- **Model ID aliases**: Use pi-ai aliases (e.g., `claude-opus-4-6`) not dated snapshot IDs.
- **Provider composition**: Auto-discovered from pi-ai. External providers: drop `.ts` in `packages/webapp/providers/`. OAuth via `createOAuthLauncher()` in `packages/webapp/src/providers/oauth-service.ts`. Registration runs in both `main.ts` and `offscreen.ts`. Providers can override model capabilities via `modelOverrides` (static) or `getModelIds()` metadata (dynamic). Three-layer merge: pi-ai → modelOverrides → getModelIds. OpenAI-compatible models route through `streamOpenAICompletions` when `api: 'openai'` is set in metadata.
- **Developer vs agent CLAUDE.md**: Developer-facing `CLAUDE.md` lives at the repo root and in each package. The single agent-facing runtime `CLAUDE.md` lives at `packages/vfs-root/shared/CLAUDE.md` and is bundled into the VFS as `/shared/CLAUDE.md`. See [`docs/CLAUDE.md`](docs/CLAUDE.md) for the tier table.
- **Default VFS content**: `packages/vfs-root/` bundled into VFS via `import.meta.glob`.
- **Preview URLs**: `toPreviewUrl(vfsPath)` → legacy local SW URL (`open <vfs-path>`). `mintPreviewViaWorker` (`preview-mint-client.ts`) → unified worker-hosted URL. `isPreviewUrl(url)` in `shared.ts` matches both (app-tab exclude).

## Change Requirements

Every change must satisfy **tests**, **docs**, and **verification**.

### Tests

- Add or update tests for behavior changes.
- TypeScript tests live in `packages/*/tests/`, mirrored by subsystem.
- See `docs/testing.md` for patterns and command selection.
- **Coverage thresholds are enforced in CI** for every package. New code
  must keep coverage at or above the current floor — CI fails if any of
  the tracked metrics drops below the threshold for that package.
  - **Single source of truth**: `coverage-thresholds.json` at the repo root
    holds every per-package floor. It is maintained automatically by the
    nightly coverage ratchet
    (`packages/dev-tools/tools/coverage-ratchet.mjs` →
    `.github/workflows/coverage-ratchet.yml`), which only ever raises floors
    toward measured coverage (whole-point steps, ~0.5-1.5pp headroom via a
    half-point safety margin) and opens a PR when anything changed. Never
    hand-lower these values.
  - **TypeScript packages**: `vitest --coverage` (v8 provider) via
    `npm run test:coverage:<package>`, which runs `coverage-gate.mjs` to read
    the package's floors from `coverage-thresholds.json`. CI runs the same
    script as the package's only test step.
  - **Swift packages**: `swift test --enable-code-coverage` plus
    `xcrun llvm-cov report` via
    `packages/dev-tools/tools/swift-coverage-check.sh`, which reads its
    lines/functions/regions floors from `coverage-thresholds.json` when not
    passed explicitly. Tests/.build paths are excluded; the TOTAL row is
    checked against the floors (the swift-launcher floor stays low because
    most of the bundle is SwiftUI views that resist unit tests).

### Documentation

| Tier            | File                                   | Update when...                              |
| --------------- | -------------------------------------- | ------------------------------------------- |
| Public          | `README.md`                            | User-facing behavior changes                |
| Development     | `CLAUDE.md` files                      | Developer conventions, architecture, builds |
| Agent reference | `docs/`                                | Detailed tools, commands, and patterns      |
| Agent skills    | `vfs-root/workspace/skills/*/SKILL.md` | Shell command changes (agent system prompt) |

### Verification

Run the full pre-push/PR pass — `lint` (always first; the most common CI failure), `typecheck`, `test`, `test:coverage`, both `build`s, plus the touched-file complexity gate — before committing. Commands, lint internals, and the CI-only gates: [`docs/verification.md`](docs/verification.md). CI runs these gates in `.github/workflows/ci.yml`.

## Automated PR Review Checklist

Automated reviewers (Claude action, Codex via `AGENTS.md`, Copilot via `.github/copilot-instructions.md`) and humans check PRs against these blind spots. Full catalog: [`docs/review-patterns.md`](docs/review-patterns.md).

1. **Error-path coverage** — timeouts/retries/`.catch` on external calls (PR #779).
2. **UI state preservation** — capture+restore UI state around DOM rebuilds (PR #566/#567).
3. **Cross-runtime parity** — peer runtimes updated or explicitly excluded (PR #565).
4. **CDP edge cases** — foreground before screenshots; validate target/port (PR #361, #673).
5. **Native/macOS permissions** — entitlements + TCC check + graceful denial.
6. **Model metadata / provider pipeline** — verify metadata forwarding, version predicates, thinking levels, costs (PR #1399; see `docs/pitfalls.md`).
7. **Test coverage** — mirrored `tests/`; bug fixes ship regression tests; stay above floor.
8. **Follower wiring parity** — leader broadcasts need matching follower handler + UI action; check all boot paths (PRs #1286, #1283, #1261).
9. **Origin/bridge routing** — `fetch('/api/...')` must work in thin-bridge mode; normalize trailing slashes (PRs #1227–#1243, #1283).
10. **Agent skill freshness** — shell command changes → update matching `vfs-root/workspace/skills/*/SKILL.md`.

When you change a category, update `docs/review-patterns.md` (source of truth) and the ≤4,000-char `.github/copilot-instructions.md` so all reviewers stay in sync.
