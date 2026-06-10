# CLAUDE.md

This root file is the repo navigation hub. Keep package-specific architecture and implementation detail in the nearest package `CLAUDE.md`, and keep fast-changing how-to material in `docs/`.

## Module Map

### Packages

| Path                          | Purpose                                                                                                                                              |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/webapp/`            | Browser app core: UI, VFS, shell, CDP, tools, providers, skills, scoops                                                                              |
| `packages/cherry/`            | Host-side embed SDK (`mountSlicc`) lending a third-party page to a leader as a target                                                                |
| `packages/chrome-extension/`  | Manifest V3 extension entry points, HTML shells, and message bridges                                                                                 |
| `packages/cloudflare-worker/` | Tray hub worker for session coordination, signaling, TURN credentials, and the `sliccy.ai/cloud` cone dashboard                                      |
| `packages/node-server/`       | Node.js CLI/Electron server: Chrome launch, CDP proxy, dev serving, hosted-leader mode                                                               |
| `packages/cloud-core/`        | `@slicc/cloud-core` — shared sandbox-lifecycle library consumed by both `node-server --cloud …` and the worker                                       |
| `packages/shared-ts/`         | `@slicc/shared-ts` — platform-agnostic primitives (secret masking, secrets pipeline) shared across all TS packages                                   |
| `packages/webcomponents/`     | `@slicc/webcomponents` — standalone web-component library extracted from the UI prototype (Storybook + `@vitest/browser`), not yet wired into webapp |
| `packages/vfs-root/`          | Default VFS content copied into the app on init/reset                                                                                                |
| `packages/swift-launcher/`    | Native macOS SwiftUI launcher app (`Sliccstart`)                                                                                                     |
| `packages/swift-server/`      | Native macOS Hummingbird server (`slicc-server`)                                                                                                     |
| `packages/ios-app/`           | Native iOS SwiftUI follower app (`SliccFollower`) — joins a leader over WebRTC (SPM project, not an npm workspace)                                   |
| `packages/dev-tools/`         | Repo-level tooling: build helpers, QA setup, providers build filter, e2b template for hosted cones                                                   |
| `packages/assets/`            | Shared static files (logos, fonts, favicon) used by multiple packages (folder, not an npm workspace)                                                 |

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

### Philosophy

1. **The Claw Pattern**: SLICC is a persistent orchestration layer over LLM agents, centered in the browser.
2. **Agents Love the CLI**: Prefer shell commands and composable command surfaces over bespoke tools.
3. **The Browser is the OS**: Keep state client-side and use server code only for work browsers cannot do themselves.

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

**Requires Node >= 22** (LTS). Ports: 5710 (UI), 9222 (Chrome CDP), 9223 (Electron CDP). Vite HMR shares the UI server via `/__vite_hmr`.

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
- **Licks**: External events triggering scoops (webhooks, cron tasks, workflow completions). Code: `LickManager`, `LickEvent`, `WorkflowRunManager` (`__slicc_workflows`). Shell: `webhook`, `crontask`, `workflow status/list/stop`.
- **Floats**: Runtime environments — CLI (`packages/node-server/src/`), Extension (`packages/chrome-extension/src/`), Electron (`packages/node-server/src/electron-main.ts`), Sliccstart (`packages/swift-launcher/` — native macOS launcher), **hosted-leader (cloud)** (`@slicc/cloud-core` owns the substrate / start / resume / pause / kill operations; `packages/node-server/src/cloud/` is the CLI adapter that spawns an e2b sandbox running `node-server --hosted`; see `packages/dev-tools/e2b-template/`), **Cherry (embedded follower garnish)** (`packages/cherry/` host SDK `mountSlicc` embeds the webapp with `?cherry=1` in a third-party page's iframe and lends that page to a remote leader as a capability-limited synthetic-CDP target).

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

`npm run typecheck` runs five `tsc --noEmit` invocations:

- **Browser bundle** (`tsconfig.json`): `packages/webapp/`. The Vite-built extension (`packages/chrome-extension/vite.config.ts`) reuses this config; its extra entries are bundle-time only, not a separate typecheck target.
- **CLI/Electron** (`tsconfig.cli.json`): `packages/node-server/src/`. Compiled by TSC to `dist/node-server/`.
- **Tray-hub worker** (`tsconfig.worker.json`): `packages/cloudflare-worker/src/`.
- **Kernel-worker safety guard** (`tsconfig.webapp-worker.json`): typechecks the DedicatedWorker-side webapp code against a no-DOM lib set so accidental `window` references fail at typecheck time.
- **Cloud-core library** (`packages/cloud-core/tsconfig.json`): `@slicc/cloud-core` is built ahead of `webapp` / `node-server` / `cloudflare-worker` (which all import it) via `postinstall` and the root `build` chain.

`@slicc/shared-ts` uses the same postinstall pre-build pattern as `@slicc/cloud-core` (it must be built before `node-server` and `webapp` can typecheck), but its own `tsc --noEmit` is invoked by its workspace `npm run typecheck` script rather than the root pipeline.

### Key Subsystems

**Orchestrator** (`packages/webapp/src/scoops/orchestrator.ts`): Creates/destroys scoops, routes messages, manages VFS. Cone delegates via `feed_scoop` — scoops get complete self-contained prompts (no access to cone's conversation). Exposes `observeScoop(jid, handler)` for per-scoop event taps (observers are dropped defensively on both `unregisterScoop` and `destroyScoopTab`). `agent-bridge.ts` publishes `globalThis.__slicc_agent` — the shell-facing surface used by the `agent` supplemental command to spawn ephemeral one-shot sub-scoops with `notifyOnComplete: false` (no cone turn on completion). Extension float proxies the bridge from the side panel to the offscreen agent engine via `chrome.runtime` messages.

**VirtualFS** (`packages/webapp/src/fs/`): POSIX-like async FS backed by OPFS (`backend: 'opfs'`; in-memory in Node tests). `RestrictedFS` wraps it with path ACLs for scoops. `FsError` carries POSIX error codes. The legacy LightningFS-IDB era is fully removed — nothing reads `slicc-fs` anymore (`slicc-fs-cleanup` deletes the leftover database).

**Mount backends** (`packages/webapp/src/fs/mount/`): `LocalMountBackend` (FS Access), `S3MountBackend`, `DaMountBackend` are **signing-naive** in the browser bundle — they construct logical requests and call an injected `SignedFetch*` transport. The transport routes to `/api/s3-sign-and-forward` / `/api/da-sign-and-forward` (CLI; node-server resolves credentials, signs SigV4, forwards) or to `chrome.runtime.sendMessage` (extension; service worker reads `s3.<profile>.*` from `chrome.storage.local`, signs, forwards via `host_permissions: <all_urls>`). The agent never holds S3 credentials in either deployment. The IMS bearer token for DA flows transiently in the envelope; v2 will move that OAuth flow server-side too.

**Shell** (`packages/webapp/src/shell/`): AlmostBashShell wraps just-bash (a pure-TypeScript Bash interpreter, not WASM — hence the name; only specific commands like `python3`/`sqlite3`/`convert`/`ffmpeg`/`biome`/`esbuild` and the JS sandbox use WASM). Just-bash builtins plus ~50 supplemental commands registered in `shell/supplemental-commands/index.ts` and `shell/almost-bash-shell-headless.ts` (notable: `git`, `node -e`, `python3 -c`, `playwright-cli`, `open`, `serve`, `sqlite3`, `tsc`, `test`, `biome`, `esbuild`, `ffmpeg`, `convert`, `pdftk`, `upskill`, `discover`, `webhook`, `crontask`, `fswatch`, `workflow`, `mount`, `usb`, `serial`, `hid`, `esptool`, `oauth-token`, `oauth-domain`, `secret`, `agent`, `mcp`, `host`, `ps`, `kill`, plus macOS-style helpers `say`/`hear`/`afplay`/`pbcopy`/`pbpaste`/`screencapture`). See [`docs/shell-reference.md`](docs/shell-reference.md) for the authoritative per-command list. `agent` spawns a one-shot sub-scoop via AgentBridge — shell surface for scoop delegation from any float. `workflow run` (SP1) executes Claude Code dynamic workflows natively — plain-JS orchestration scripts that fan out to parallel subagents via `agent(prompt, {schema?})` while keeping intermediate results in script variables instead of the model's context; built over `executeJsCode` → `runInRealm({ kind: 'js' })` with a prelude supplying the orchestration API + determinism guards; dual-mode (standalone/extension) by construction. `mcp` (`add`/`list`/`delete`/`invoke`/`refresh`) auto-writes a `.jsh` alias shim at `/workspace/.mcp/aliases/<name>.jsh`, registers `mcp:<name>` OAuth providers, and materializes MCP Apps as sprinkles under `/workspace/.mcp/sprinkles/<name>/`; lazy re-registration from `/workspace/.mcp/servers.json`. **USB / Serial / HID gesture bridge**: `usb`/`serial`/`hid` expose WebUSB / Web Serial / WebHID via opaque page-side handles (`usb1`, `serial1`, `hid1`), and `esptool` flashes ESP32/ESP8266 over the `serial` handle namespace. The kernel worker has no `window`, so device ops forward to the page realm over panel-RPC. The `<cmd> request` device picker needs a real user gesture — `RemoteTerminalView` runs it on the Enter keystroke and forwards a rewritten command carrying `--__resolved` (parallel to `mount`'s local-picker gesture path); in the extension it routes through a popup window. Chromium-only; unavailable in the cloud / hosted-leader float. Any `*.jsh` file on VFS is auto-discovered as a command. Extension CSP workaround: dynamic code routes through `sandbox.html`. **Two shell contexts in extension mode**: side panel has its own AlmostBashShell (mounted in terminal tab), offscreen document has the agent's AlmostBashShell (runs bash tool calls). Commands that affect the UI must handle both — use `window.__slicc_*` hooks for direct calls (panel) and `chrome.runtime.sendMessage` relay for offscreen→panel communication.

**CDP** (`packages/webapp/src/cdp/`): `CDPTransport` interface with WebSocket (CLI) and `chrome.debugger` (extension) implementations. `BrowserAPI` provides Playwright-style API (listPages, navigate, screenshot, evaluate, click, etc.). Screenshots normalize DPR to 1.

**Tools** (`packages/webapp/src/tools/`): Active tool surface: `read_file`, `write_file`, `edit_file`, `bash`, plus NanoClaw tools (`send_message`, cone-only: `list_scoops`, `scoop_scoop`, `feed_scoop`, `drop_scoop`, `update_global_memory`). Browser automation goes through shell commands via `bash`.

**Core Agent** (`packages/webapp/src/core/`): Uses pi-agent-core for agent loop, pi-ai for LLM streaming. `tool-adapter.ts` bridges legacy ToolDefinition to pi-compatible AgentTool. `SessionStore` persists conversations to IndexedDB.

**Context Compaction** (`packages/webapp/src/core/context-compaction.ts`): LLM-summarized compaction at `model.contextWindow - reserveTokens` — the resolved model's real window, forwarded by `scoop-context.ts` (e.g. ~983K for a 1M-window Adobe Sonnet/Opus 4.x); falls back to a 200K default only when the model reports no window. Images auto-resized before LLM (5MB base64 limit). Overflow recovery replaces oversized messages (>40K chars) with placeholders.

**UI** (`packages/webapp/src/ui/`): Vanilla TypeScript, no framework. Unified split-pane layout for both floats — `Layout(root, isExtension)` toggles density (scoops rail, switcher, avatar). Extension mode: side panel UI with Chat panel and Terminal/Files/Memory rail items pinned. Standalone: resizable split layout with all panels visible. Detached popout (`?detached=1`) uses `isExtension=false` for full standalone UX. `main.ts` delegates to `mainExtension()` (OffscreenClient) or bootstraps Orchestrator directly. Tab bar is fully dynamic — `TabZone.addTab()`/`removeTab()` adds/removes tabs at runtime (used by sprinkle panels).

**Extension** (`packages/chrome-extension/src/`): Service worker relays messages + proxies chrome.debugger. Offscreen document runs agent engine (survives side panel close). Chat persistence: `browser-coding-agent` IndexedDB is single source of truth. **Key architecture detail**: the extension has two separate execution contexts with independent shell instances — the side panel (UI, terminal shell, Layout) and the offscreen document (agent engine, bash tool shell, Orchestrator). They share IndexedDB but NOT window globals. Communication is via `chrome.runtime` messages routed through the service worker. See `docs/architecture.md` "Extension Three-Layer Architecture".

**Preview SW** (`packages/webapp/src/ui/preview-sw.ts`): Intercepts `/preview/*` requests, serves VFS content. Built as IIFE via esbuild (not rollup — avoids code-splitting issues in SWs).

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

## Key Conventions

- **Two type systems**: Legacy ToolDefinition (`packages/webapp/src/tools/`) and pi-compatible AgentTool (`packages/webapp/src/core/`). Bridged by `tool-adapter.ts`.
- **Tests**: `packages/*/tests/` mirrors the `src/` structure. Vitest, globals: true, environment: node. Use `fake-indexeddb/auto` for VFS tests.
- **Logging**: `createLogger('namespace')` from `packages/webapp/src/core/logger.ts`. DEBUG in dev, ERROR in prod.
- **Extension detection**: `typeof chrome !== 'undefined' && !!chrome?.runtime?.id`
- **Dual-mode compatibility**: Features MUST work in both CLI and extension. Extension CSP blocks eval/CDN — use `sandbox.html` for dynamic code, `sprinkle-sandbox.html` for sprinkles/dips, `chrome.runtime.getURL()` for bundled assets.
- **Extension `window.open()` returns `null`**: Fire-and-forget; don't treat null as failure.
- **Model ID aliases**: Use pi-ai aliases (e.g., `claude-opus-4-6`) not dated snapshot IDs.
- **Provider composition**: Auto-discovered from pi-ai. External providers: drop `.ts` in `packages/webapp/providers/`. OAuth via `createOAuthLauncher()` in `packages/webapp/src/providers/oauth-service.ts`. Registration runs in both `main.ts` and `offscreen.ts`. Providers can override model capabilities via `modelOverrides` (static) or `getModelIds()` metadata (dynamic). Three-layer merge: pi-ai → modelOverrides → getModelIds. OpenAI-compatible models route through `streamOpenAICompletions` when `api: 'openai'` is set in metadata.
- **Developer vs agent CLAUDE.md**: Developer-facing `CLAUDE.md` lives at the repo root and in each package. The single agent-facing runtime `CLAUDE.md` lives at `packages/vfs-root/shared/CLAUDE.md` and is bundled into the VFS as `/shared/CLAUDE.md`. See [`docs/CLAUDE.md`](docs/CLAUDE.md) for the tier table.
- **Default VFS content**: `packages/vfs-root/` bundled into VFS via `import.meta.glob`.
- **Preview URLs**: Use `toPreviewUrl(vfsPath)` from `packages/webapp/src/shell/supplemental-commands/shared.ts`.

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
    toward measured coverage (whole-point steps, <1% headroom) and opens a
    PR when anything changed. Never hand-lower these values.
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

| Tier            | File              | Update when...                                               |
| --------------- | ----------------- | ------------------------------------------------------------ |
| Public          | `README.md`       | User-facing behavior changes                                 |
| Development     | `CLAUDE.md` files | Developer conventions, package architecture, build workflows |
| Agent reference | `docs/`           | Detailed tools, commands, and patterns                       |

### Verification

These are the repo's CI gates and the default full verification pass before commit:

```bash
npm run lint                           # Format + lint FIRST — CI fails on unformatted code
npm run typecheck
npm run test
npm run test:coverage                  # Enforces minimum coverage thresholds
npm run build
npm run build -w @slicc/chrome-extension
```

**Always run `npm run lint` before committing.** It runs `biome check --write .` over JS/TS/JSON/CSS and `prettier --write .` over the remaining doc / config-text formats (Markdown, YAML, HTML), then `lint:docs` (CLAUDE.md size limits) and `lint:skills` (tessl `SKILL.md` lint). CI runs the check-only/strict equivalents (`npm run lint:ci`) as a hard gate and will reject any unformatted code. This is the most common CI failure — don't skip it.

CI runs these gates in `.github/workflows/ci.yml`.

## Automated PR Review Checklist

Automated reviewers — the Claude action (`.github/workflows/claude-pr-review.yml`), Codex (via `AGENTS.md` → this file), and Copilot (`.github/copilot-instructions.md`) — plus human reviewers check changed code against these recurring blind spots. Full catalog with trigger patterns, verified historical precedents, the five-runtime parity matrix, and the severity rubric: [`docs/review-patterns.md`](docs/review-patterns.md).

1. **Error-path coverage** — external calls (`fetch`, `Sandbox.create`/`connect`) need timeouts/retries/`.catch`; bound every async operation (precedent: PR #779).
2. **UI state preservation** — capture and restore live UI state around `innerHTML`/`replaceChildren` and reflow/navigation rebuilds (PR #566/#567).
3. **Cross-runtime parity** — a change to one of `webapp`/`chrome-extension`/`node-server`/`swift-server`/`ios-app` usually needs the peers updated or an explicit "N/A" note (PR #565; see the parity matrix).
4. **CDP edge cases** — foreground the page (`bringToFront`) before screenshots; validate the CDP target/port before trusting it (PR #361, #673).
5. **Native/macOS permissions** — keychain/TCC/screen-recording need the right entitlements and graceful denial handling.
6. **Test coverage** — source changes ship with mirrored `tests/`; bug fixes ship a regression test; keep coverage at/above the package floor.

When you change a category, update `docs/review-patterns.md` (source of truth) and the ≤4,000-char `.github/copilot-instructions.md` so all reviewers stay in sync.
