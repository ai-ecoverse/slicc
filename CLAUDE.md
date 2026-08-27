# CLAUDE.md

Repo navigation hub. Keep package details in the nearest package `CLAUDE.md` and fast-changing how-to in `docs/`.

## Module Map

Purposes per package: [`docs/root-details.md`](docs/root-details.md). Per-package internals: each `packages/<name>/CLAUDE.md`.

- **Web / TS**: `packages/webapp/`, `packages/webcomponents/`, `packages/chrome-extension/`, `packages/cherry/`, `packages/spoon/`
- **Node / cloud**: `packages/node-server/`, `packages/cloudflare-worker/`, `packages/cloud-core/`, `packages/shared-ts/`, `packages/vfs-root/`, `packages/dev-tools/`, `packages/assets/`
- **Native (Swift / iOS / Go)**: `packages/swift-launcher/`, `packages/swift-server/`, `packages/swift-optel/`, `packages/swift-traysession/`, `packages/swift-trayfollower/`, `packages/swift-traykit/`, `packages/swift-widgetkit/`, `packages/ios-app/`, `packages/slicc-cli/`, `packages/go-optel/`

Other top-level: `docs/` (long-form docs + screenshots), `packages/*/tests/` (Vitest suites), `dist/` (generated; do not hand-edit).

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

Runtime-specific guides:
[webapp](packages/webapp/CLAUDE.md) · [cherry](packages/cherry/CLAUDE.md) · [chrome-extension](packages/chrome-extension/CLAUDE.md) · [cloudflare-worker](packages/cloudflare-worker/CLAUDE.md) · [node-server](packages/node-server/CLAUDE.md) · [cloud-core](packages/cloud-core/CLAUDE.md) · [shared-ts](packages/shared-ts/CLAUDE.md) · [webcomponents](packages/webcomponents/CLAUDE.md) · [spoon](packages/spoon/CLAUDE.md) · [vfs-root](packages/vfs-root/CLAUDE.md) · [go-optel](packages/go-optel/CLAUDE.md) · [swift-launcher](packages/swift-launcher/CLAUDE.md) · [swift-optel](packages/swift-optel/CLAUDE.md) · [swift-server](packages/swift-server/CLAUDE.md) · [swift-traysession](packages/swift-traysession/CLAUDE.md) · [swift-trayfollower](packages/swift-trayfollower/CLAUDE.md) · [swift-traykit](packages/swift-traykit/CLAUDE.md) · [swift-widgetkit](packages/swift-widgetkit/CLAUDE.md) · [ios-app](packages/ios-app/CLAUDE.md) · [slicc-cli](packages/slicc-cli/CLAUDE.md) · [dev-tools](packages/dev-tools/CLAUDE.md) · [docs](docs/CLAUDE.md)

## External Handoffs

`handoff to slicc` / `move this to slicc` opens `https://www.sliccy.ai/handoff?handoff=<text>` (or `?upskill=<url>`) with a `handoff:`/`upskill:` verb-prefixed instruction. Worker returns an RFC 8288 `Link` header SLICC observes on navigation for approval. Prefer `.agents/skills/slicc-handoff/scripts/slicc-handoff`.

## Ice Cream Vocabulary

- **Cone**: main agent. Full filesystem access, all tools.
- **Scoops**: isolated sub-agents; sandboxed filesystems (`/scoops/{name}/` + `/shared/`). Tools: `scoop_scoop`, `feed_scoop`, `drop_scoop`.
- **Licks**: external events — webhooks, cron, workflow completions.
- **Floats**: runtime envs — CLI, extension, Electron, cloud (hosted-leader), Cherry (embedded follower garnish; `?cherry=1` in a host page's iframe).
- **Biscotto** (pl. **biscotti**): a revocable guest seat on a cone. Holder gets a private `*.sliccy.now` URL showing the live transcript; its messages are untrusted by default and pass a message/tool gate. Restricted at the wire by `scoops/tray-leader/biscotto-gate.ts`.

Use ice cream terms in review comments and docs when they match the domain (e.g., `feed_scoop` not `delegate_to_scoop`).

## Git Conventions

- Keep commits focused and package-local when possible.
- **Linear history**: CI rejects merge commits. Rebase onto `origin/main`; Husky enforces via `packages/dev-tools/tools/check-linear-history.sh`.
- Do not hand-edit generated output in `dist/`.
- Auth: `git config github.token <PAT>` or GitHub OAuth login; see [`docs/secrets.md`](docs/secrets.md).

**Requires Node >= 22** (LTS). Ports: 5710 (bridge + /api), 9222 (Chrome CDP), 9223 (Electron CDP). node-server serves no UI — the webapp loads from the hosted origin and dials back to the local `/cdp` bridge.

### Parallel Instances

Override the UI port to run parallel standalone instances; profiles and CDP ports stay isolated:

```bash
PORT=5720 npm run dev   # Second instance on port 5720
PORT=5730 npm run dev   # Third instance on port 5730
```

## Principles

1. **Claw pattern** — persistent browser orchestration layer over [Pi](https://github.com/earendil-works/pi-mono).
2. **Virtual CLIs first** — composable shell commands over dedicated tools.
3. **Browser-first** — state client-side; the server is a stateless relay; the extension has zero server.
4. **Skills over hardcoded features** — add capabilities as SKILL.md files when possible.

## Architecture

SLICC runs as standalone CLI (Express + Chrome), Chrome extension, Electron float, cloud hosted leader, or Cherry follower. See [`docs/architecture.md`](docs/architecture.md) + [float topology](docs/architecture-diagram.png). Each package `CLAUDE.md` is authoritative for its subsystem. Shell: [`docs/shell-reference.md`](docs/shell-reference.md). Verification/CI gates: [`.agents/skills/verifying-before-push/SKILL.md`](.agents/skills/verifying-before-push/SKILL.md).

## Key Conventions

- **Tests**: `packages/*/tests/` mirrors `src/`. Vitest, `globals: true`, `environment: node`. `fake-indexeddb/auto` for VFS tests.
- **Dual-mode compatibility**: features MUST work in CLI and extension. The thin extension runs no dynamic code — UI, sprinkles/dips, JS realms, WASM all run in the hosted leader tab / kernel worker; extension assets load via `chrome.runtime.getURL()`.
- **Extension detection**: `isChromeExtensionRealm()` from `@slicc/shared-ts` (lint-gated).
- **Model ID aliases**: use pi-ai aliases (e.g., `claude-opus-4-6`), not dated snapshot IDs.
- **Developer vs agent CLAUDE.md**: developer-facing `CLAUDE.md` lives at repo root and each package. Agent-facing runtime `CLAUDE.md` is `packages/vfs-root/shared/CLAUDE.md` (bundled as `/shared/CLAUDE.md`). Tier table: [`docs/CLAUDE.md`](docs/CLAUDE.md).

## Change Requirements

Every change must satisfy **tests**, **docs**, and **verification**.

### Tests

- Add/update tests for behavior changes; TS tests in `packages/*/tests/`, mirrored by subsystem. Patterns: `.agents/skills/writing-slicc-tests/SKILL.md`.
- **Coverage thresholds enforced in CI.** Floors in `coverage-thresholds.json`; raised by the nightly ratchet (`packages/dev-tools/tools/coverage-ratchet.mjs`). Never hand-lower them. TS: `npm run test:coverage:<package>`; Swift: `packages/dev-tools/tools/swift-coverage-check.sh`.

### Documentation

Doc tier map (full table: [`docs/CLAUDE.md`](docs/CLAUDE.md)):

- `README.md` — user-facing behavior changes
- `CLAUDE.md` files — developer conventions, architecture, builds
- `docs/` — detailed tools, commands, patterns
- `vfs-root/workspace/skills/*/SKILL.md` — agent skills (shell command changes)
- `.agents/skills/*/SKILL.md` — developer agent skills (verification, wiring, tests, runbooks)

### Verification

Run the full pre-push/PR pass — `lint` (first; top CI failure), `typecheck`, `test`, `test:coverage`, both `build`s, plus the touched-file debt gate — before committing. Commands and CI-only gates: [`.agents/skills/verifying-before-push/SKILL.md`](.agents/skills/verifying-before-push/SKILL.md); CI in `.github/workflows/ci.yml`.

## Developer Agent Skills (.agents/skills/)

Skill-aware harnesses load these directly; this list routes AGENTS.md-only harnesses to them.

- Add/change a SLICC feature surface → use `adding-slicc-features`
- Deploy/debug the Cloudflare tray hub worker → use `deploying-tray-worker`
- Record a UI demo for a PR → use `demo-recording`
- Hand work off to SLICC → use `slicc-handoff`
- Smoke-test a build in a controlled browser → use `cdp-smoke-test`
- Write/update SLICC tests → use `writing-slicc-tests`
- Commit, push, open/update a PR, diagnose verification CI failures → use `verifying-before-push`

## Automated PR Review Checklist

Reviewers (Claude action, Codex `AGENTS.md`, Copilot `.github/copilot-instructions.md`) and humans check PRs against these blind spots. Descriptions: [`docs/root-details.md`](docs/root-details.md); full catalog: [`docs/review-patterns.md`](docs/review-patterns.md).

1. Error-path coverage
2. UI state preservation
3. Cross-runtime parity
4. CDP edge cases
5. Native/macOS permissions
6. Model metadata / provider pipeline
7. Test coverage
8. Follower wiring parity
9. Origin/bridge routing
10. Layer import direction
11. Untyped string-keyed bags (`Record<string, unknown>`)
12. Agent skill freshness
13. Transcript export
14. `--help` that does the thing

When you change a category, update `docs/review-patterns.md` (source of truth) and the ≤4,000-char `.github/copilot-instructions.md` so all reviewers stay in sync.
