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
| `packages/webcomponents/`     | `@slicc/webcomponents` — the webapp's UI shell (Storybook + `@vitest/browser`)                                                          |
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

## Ice Cream Vocabulary

- **Cone**: the main agent. Full filesystem access, all tools.
- **Scoops**: isolated sub-agents with sandboxed filesystems (`/scoops/{name}/` + `/shared/`). Tools: `scoop_scoop`, `feed_scoop`, `drop_scoop`.
- **Licks**: external events such as webhooks, cron tasks, or workflow completions.
- **Floats**: runtime environments — CLI, extension, Electron, cloud (hosted-leader), and Cherry (embedded follower garnish — `?cherry=1` in a host page's iframe).

Use ice cream terms in code review comments and docs when they match the domain (e.g., "feed_scoop" not "delegate_to_scoop").

## Git Conventions

- Keep commits focused and package-local when possible.
- **Linear history**: the merge queue and CI `linear-history` job reject branches with merge commits. Rebase onto the base (`git rebase origin/main`) instead of merging it in (`git config pull.rebase true` helps). Husky enforces this locally via `.husky/pre-merge-commit` and `.husky/pre-push` (reusing `packages/dev-tools/tools/check-linear-history.sh`).
- Do not hand-edit generated output in `dist/`.
- Auth uses `git config github.token <PAT>` or GitHub OAuth login; see `docs/secrets.md`.

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

## Architecture

Browser-based AI coding agent running as Chrome extension (side panel), standalone CLI server, or Electron float. For a complete reference — float topology diagram, layer stack, subsystem file maps, build targets, and tray/sync architecture — see [`docs/architecture.md`](docs/architecture.md).

### Deployment Floats

Three primary floats: standalone CLI (Express + Chrome), Chrome extension (thin bridge, no bundled engine), and Electron. Plus hosted-leader (cloud via e2b sandbox) and Cherry (embedded follower iframe). See [`docs/architecture.md`](docs/architecture.md) for the full per-float description and the [float topology diagram](docs/architecture-diagram.png).

Each package `CLAUDE.md` is the authoritative source for its subsystem internals. Shell command reference: [`docs/shell-reference.md`](docs/shell-reference.md). Build targets and `tsc --noEmit` invocations: [`docs/verification.md`](docs/verification.md).

## Key Conventions

- **Tests**: `packages/*/tests/` mirrors the `src/` structure. Vitest, globals: true, environment: node. Use `fake-indexeddb/auto` for VFS tests.
- **Dual-mode compatibility**: Features MUST work in both CLI and extension. The thin extension runs no dynamic code itself — UI, sprinkles/dips, JS realms, WASM all run in the hosted leader tab / kernel worker; extension assets load via `chrome.runtime.getURL()`.
- **Extension detection**: `isExtensionRealm()` from `core/runtime-env.ts` (lint-gated).
- **Model ID aliases**: Use pi-ai aliases (e.g., `claude-opus-4-6`) not dated snapshot IDs.
- **Developer vs agent CLAUDE.md**: Developer-facing `CLAUDE.md` lives at the repo root and in each package. The single agent-facing runtime `CLAUDE.md` lives at `packages/vfs-root/shared/CLAUDE.md` and is bundled into the VFS as `/shared/CLAUDE.md`. See [`docs/CLAUDE.md`](docs/CLAUDE.md) for the tier table.

## Change Requirements

Every change must satisfy **tests**, **docs**, and **verification**.

### Tests

- Add or update tests for behavior changes.
- TypeScript tests live in `packages/*/tests/`, mirrored by subsystem.
- See `docs/testing.md` for patterns and command selection.
- **Coverage thresholds are enforced in CI.** Floors live in `coverage-thresholds.json` and are raised automatically by the nightly ratchet (`packages/dev-tools/tools/coverage-ratchet.mjs`). Never hand-lower these values. TypeScript: `npm run test:coverage:<package>`; Swift: `packages/dev-tools/tools/swift-coverage-check.sh`.

### Documentation

| Tier                   | File                                   | Update when...                                                                       |
| ---------------------- | -------------------------------------- | ------------------------------------------------------------------------------------ |
| Public                 | `README.md`                            | User-facing behavior changes                                                         |
| Development            | `CLAUDE.md` files                      | Developer conventions, architecture, builds                                          |
| Agent reference        | `docs/`                                | Detailed tools, commands, and patterns                                               |
| Agent skills           | `vfs-root/workspace/skills/*/SKILL.md` | Shell command changes (agent system prompt)                                          |
| Developer agent skills | `.agents/skills/*/SKILL.md`            | A repo procedure (verification, feature wiring, test patterns, ops runbooks) changes |

### Verification

Run the full pre-push/PR pass — `lint` (always first; the most common CI failure), `typecheck`, `test`, `test:coverage`, both `build`s, plus the touched-file complexity gate — before committing. Commands, lint internals, and the CI-only gates: [`docs/verification.md`](docs/verification.md). CI runs these gates in `.github/workflows/ci.yml`.

## Developer Agent Skills (.agents/skills/)

Developer-facing skills for agents maintaining this repo. Each is a `SKILL.md`
loaded into the system prompt by skill-aware harnesses (Claude Code, pi).
For harnesses that only read AGENTS.md (Codex, Copilot), this router is the
discovery channel — read the referenced skill when the moment matches.

- Deploying or debugging the Cloudflare tray hub worker → use `deploying-tray-worker`
- Recording a UI demo for a PR → use `demo-recording`
- Handing work off to SLICC → use `slicc-handoff`
- Smoke-testing a build in a controlled browser → use `cdp-smoke-test`

## Automated PR Review Checklist

Automated reviewers (Claude action, Codex via `AGENTS.md`, Copilot via `.github/copilot-instructions.md`) and humans check PRs against these blind spots. Full catalog: [`docs/review-patterns.md`](docs/review-patterns.md).

1. **Error-path coverage** — timeouts/retries/`.catch` on external calls.
2. **UI state preservation** — capture+restore UI state around DOM rebuilds.
3. **Cross-runtime parity** — peer runtimes updated or explicitly excluded.
4. **CDP edge cases** — foreground before screenshots; validate target/port.
5. **Native/macOS permissions** — entitlements + TCC check + graceful denial.
6. **Model metadata / provider pipeline** — verify metadata forwarding, version predicates, thinking levels, costs; see `docs/pitfalls.md`.
7. **Test coverage** — mirrored `tests/`; bug fixes ship regression tests; stay above floor.
8. **Follower wiring parity** — leader broadcasts need matching follower handler + UI action; check all boot paths.
9. **Origin/bridge routing** — `fetch('/api/...')` must work in thin-bridge mode; normalize trailing slashes.
10. **Agent skill freshness** — shell command changes → update matching `vfs-root/workspace/skills/*/SKILL.md`.

When you change a category, update `docs/review-patterns.md` (source of truth) and the ≤4,000-char `.github/copilot-instructions.md` so all reviewers stay in sync.
