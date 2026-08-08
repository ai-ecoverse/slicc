# CLAUDE.md

This is the repo navigation hub. Keep package details in the nearest package `CLAUDE.md` and fast-changing how-to material in `docs/`.

## Module Map

### Packages

| Path                           | Purpose                                                                                                             |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `packages/webapp/`             | Browser app core: UI, VFS, shell, CDP, tools, providers, skills, scoops                                             |
| `packages/cherry/`             | Host-side embed SDK (`mountSlicc`) lending a third-party page to a leader as a target                               |
| `packages/chrome-extension/`   | Manifest V3 extension entry points, HTML shells, and message bridges                                                |
| `packages/cloudflare-worker/`  | Tray hub worker: session coordination, signaling, TURN credentials, `sliccy.ai/cloud` dashboard                     |
| `packages/node-server/`        | Node.js CLI/Electron server: Chrome launch, CDP proxy, dev serving, hosted-leader mode                              |
| `packages/cloud-core/`         | `@slicc/cloud-core` — sandbox-lifecycle library shared by `node-server --cloud` and the worker                      |
| `packages/shared-ts/`          | `@slicc/shared-ts` — platform-agnostic primitives (secret masking, secrets pipeline)                                |
| `packages/webcomponents/`      | `@slicc/webcomponents` — the webapp's UI shell (Storybook + `@vitest/browser`)                                      |
| `packages/spoon/`              | `@ai-ecoverse/spoon` — injection overlay web component + IIFE bootstrap, used across all floats                     |
| `packages/vfs-root/`           | Default VFS content copied into the app on init/reset                                                               |
| `packages/go-optel/`           | Dependency-free Go RUM client used by `slicc-cli`                                                                   |
| `packages/swift-launcher/`     | Native macOS SwiftUI launcher app (`Sliccstart`)                                                                    |
| `packages/swift-optel/`        | Pure-Swift RUM library shared by the iOS and macOS apps                                                             |
| `packages/swift-server/`       | Native macOS Hummingbird server (`slicc-server`)                                                                    |
| `packages/swift-traysession/`  | Foundation-only iCloud tray-session sync shared by the launcher and iOS app                                         |
| `packages/swift-trayfollower/` | `SliccTrayFollower` — shared headless tray-follower transport (WebRTC + tray-sync) used by ios-app and swift-server |
| `packages/ios-app/`            | Native iOS SwiftUI follower app (`SliccFollower`) — joins a leader over WebRTC (SPM, not npm)                       |
| `packages/slicc-cli/`          | `slicc` — headless Go (pion) follower CLI: `prompt`/`exec`/`follow`; cross-compiled binaries (Go module, not npm)   |
| `packages/dev-tools/`          | Repo-level tooling: build helpers, QA setup, providers build filter, e2b template                                   |
| `packages/assets/`             | Shared static files (logos, fonts, favicon) used by multiple packages (folder, not an npm workspace)                |

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
- [`packages/spoon/CLAUDE.md`](packages/spoon/CLAUDE.md)
- [`packages/vfs-root/CLAUDE.md`](packages/vfs-root/CLAUDE.md)
- [`packages/go-optel/CLAUDE.md`](packages/go-optel/CLAUDE.md)
- [`packages/swift-launcher/CLAUDE.md`](packages/swift-launcher/CLAUDE.md)
- [`packages/swift-optel/CLAUDE.md`](packages/swift-optel/CLAUDE.md)
- [`packages/swift-server/CLAUDE.md`](packages/swift-server/CLAUDE.md)
- [`packages/swift-traysession/CLAUDE.md`](packages/swift-traysession/CLAUDE.md)
- [`packages/swift-trayfollower/CLAUDE.md`](packages/swift-trayfollower/CLAUDE.md)
- [`packages/ios-app/CLAUDE.md`](packages/ios-app/CLAUDE.md)
- [`packages/slicc-cli/CLAUDE.md`](packages/slicc-cli/CLAUDE.md)
- [`packages/dev-tools/CLAUDE.md`](packages/dev-tools/CLAUDE.md)
- [`docs/CLAUDE.md`](docs/CLAUDE.md)

## External Handoffs

`handoff to slicc` or `move this to slicc` means opening `https://www.sliccy.ai/handoff?handoff=<text>` (or `?upskill=<url>`) with a verb-prefixed `handoff:` or `upskill:` instruction. The worker returns an RFC 8288 `Link` header that SLICC observes on navigation and presents for approval. Prefer `.agents/skills/slicc-handoff/scripts/slicc-handoff`.

## Ice Cream Vocabulary

- **Cone**: the main agent. Full filesystem access, all tools.
- **Scoops**: isolated sub-agents with sandboxed filesystems (`/scoops/{name}/` + `/shared/`). Tools: `scoop_scoop`, `feed_scoop`, `drop_scoop`.
- **Licks**: external events such as webhooks, cron tasks, or workflow completions.
- **Floats**: runtime environments — CLI, extension, Electron, cloud (hosted-leader), and Cherry (embedded follower garnish — `?cherry=1` in a host page's iframe).

Use ice cream terms in code review comments and docs when they match the domain (e.g., "feed_scoop" not "delegate_to_scoop").

## Git Conventions

- Keep commits focused and package-local when possible.
- **Linear history**: CI rejects merge commits. Rebase onto `origin/main`; Husky enforces this via `packages/dev-tools/tools/check-linear-history.sh`.
- Do not hand-edit generated output in `dist/`.
- Auth uses `git config github.token <PAT>` or GitHub OAuth login; see `docs/secrets.md`.

**Requires Node >= 22** (LTS). Ports: 5710 (bridge + /api), 9222 (Chrome CDP), 9223 (Electron CDP). node-server serves no UI in any mode — the webapp loads from the hosted origin and dials back to the local `/cdp` bridge.

### Parallel Instances

Run parallel standalone instances by overriding the UI port; profiles and CDP ports stay isolated:

```bash
PORT=5720 npm run dev   # Second instance on port 5720
PORT=5730 npm run dev   # Third instance on port 5730
```

## Principles

1. **Claw pattern** — SLICC is a persistent browser orchestration layer over [Pi](https://github.com/earendil-works/pi-mono).
2. **Virtual CLIs first** — Prefer composable shell commands over dedicated tools.
3. **Browser-first** — Keep state client-side and the server a stateless relay; the extension has zero server.
4. **Skills over hardcoded features** — Add capabilities as SKILL.md files when possible.

## Architecture

SLICC runs as a standalone CLI (Express + Chrome), Chrome extension, Electron float, cloud hosted leader, or Cherry follower. See [`docs/architecture.md`](docs/architecture.md) and its [float topology diagram](docs/architecture-diagram.png).

Each package `CLAUDE.md` is the authoritative source for its subsystem internals. Shell command reference: [`docs/shell-reference.md`](docs/shell-reference.md). Verification commands and CI gates: [`.agents/skills/verifying-before-push/SKILL.md`](.agents/skills/verifying-before-push/SKILL.md).

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
- See `.agents/skills/writing-slicc-tests/SKILL.md` for test patterns and command selection.
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

Run the full pre-push/PR pass — `lint` (always first; the most common CI failure), `typecheck`, `test`, `test:coverage`, both `build`s, plus the touched-file debt gate — before committing. Commands, lint internals, and the CI-only gates: [`.agents/skills/verifying-before-push/SKILL.md`](.agents/skills/verifying-before-push/SKILL.md). CI runs these gates in `.github/workflows/ci.yml`.

## Developer Agent Skills (.agents/skills/)

Skill-aware harnesses load these developer procedures directly; this list routes AGENTS.md-only harnesses to them.

- Adding or changing a SLICC feature surface → use `adding-slicc-features`
- Deploying or debugging the Cloudflare tray hub worker → use `deploying-tray-worker`
- Recording a UI demo for a PR → use `demo-recording`
- Handing work off to SLICC → use `slicc-handoff`
- Smoke-testing a build in a controlled browser → use `cdp-smoke-test`
- Writing or updating SLICC tests → use `writing-slicc-tests`
- Committing, pushing, opening or updating a PR, or diagnosing verification CI failures → use `verifying-before-push`

## Automated PR Review Checklist

Automated reviewers (Claude action, Codex via `AGENTS.md`, Copilot via `.github/copilot-instructions.md`) and humans check PRs against these blind spots. Full catalog: [`docs/review-patterns.md`](docs/review-patterns.md).

1. **Error-path coverage** — timeouts/retries/`.catch` on external calls.
2. **UI state preservation** — capture+restore UI state around DOM rebuilds.
3. **Cross-runtime parity** — peer runtimes updated or explicitly excluded.
4. **CDP edge cases** — foreground before screenshots; validate target/port.
5. **Native/macOS permissions** — entitlements + TCC check + graceful denial.
6. **Model metadata / provider pipeline** — metadata forwarding, version predicates, thinking levels, costs; see `docs/pitfalls.md`.
7. **Test coverage** — mirrored `tests/`; bug fixes ship regression tests.
8. **Follower wiring parity** — leader broadcasts need matching follower handler + UI action; check all boot paths.
9. **Origin/bridge routing** — `fetch('/api/...')` must work in thin-bridge mode; normalize trailing slashes.
10. **Agent skill freshness** — shell command changes → update matching `vfs-root/workspace/skills/*/SKILL.md`.
11. **Transcript export** — fail-closed redaction; approval gate; unknown errors → `transfer-corrupt`; SHA-256.
12. **Layer import direction** — no new `ui/` imports below ui; move helpers down.

When you change a category, update `docs/review-patterns.md` (source of truth) and the ≤4,000-char `.github/copilot-instructions.md` so all reviewers stay in sync.
