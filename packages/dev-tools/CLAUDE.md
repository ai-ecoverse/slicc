# CLAUDE.md

Developer tooling in `packages/dev-tools/`. Long-form notes: [`docs/dev-tools-details.md`](../../docs/dev-tools-details.md).

## Key Tooling Areas

Bare script names below live under `tools/` unless a fuller path is given.

- **playwright-cli gap sync**: `tools/playwright-cli-sync.mjs` — diffs Slicc's playwright-cli vs `@playwright/cli`. Ref: [`docs/playwright-cli-sync.md`](../../docs/playwright-cli-sync.md).
- **Dev-only VFS skills** (`packages/dev-tools/vfs-dev-skills/`): `__DEV__`-gated `import.meta.glob` in `packages/webapp/src/scoops/skills.ts`, remapped to `/workspace/skills/`.
- **Build configs**: `webapp/vite.config.ts`, `chrome-extension/vite.config.ts`, `biome.json`.
- **QA setup**: `packages/node-server/src/qa-setup.ts` + root `npm run qa:*`; visual helper `webapp/tests/test-dips.mjs`.
- **RUM error triage**: `packages/dev-tools/rum-error-triage/triage-rum-errors.mjs`, nightly via workflow `rum-error-triage.yml`.
- **Scheduled agentic workflows** (selector `.mjs` + `claude-code-action`): `boy-scout-debt/`, `pr-fix-dispatcher/`, `claude-md-compactor/`, `flaky-ci-hunter/`, `backlog-dispatcher/`; event-driven sibling **review responder** (`review-responder/`) answers `automation/*` PR feedback. Deep refs: [workflows](../../docs/dev-tools-details.md#scheduled-agentic-workflows), [responder](../../docs/dev-tools-details.md#review-responder).
- **Bedrock model scout** (weekly canary, no Claude): `packages/dev-tools/model-scout/` + workflow `model-scout.yml` — probes reachable `*_BEDROCK_MODEL` IDs, files an issue on a dead one. [details](../../docs/dev-tools-details.md#model-scout).
- **e2b template**: `packages/dev-tools/e2b-template/` — hosted-leader cloud float's e2b sandbox. See `cloud-core/CLAUDE.md`.
- **AI comment detection**: `packages/dev-tools/ai-comment-detection/` + workflow `ai-comment-detection.yml` — labels `ai-generated`/`human-in-the-loop`. [details](../../docs/dev-tools-details.md#ai-comment-detection).
- **Doc gates** (`npm run lint:docs`, `.husky/pre-commit`): `tools/check-doc-sizes.mjs` + `check-doc-refs.mjs` (each + `-lib`). [details](../../docs/dev-tools-details.md#doc-dead-reference-gate).
- **Hugging Face caching mirror** (`tools/hf-cache-mirror.mjs`): zero-dep local `huggingface.co` mirror; e2e CI caches `.cache/hf-mirror` and sets `HF_ENDPOINT` for warm-run Kokoro weights.
- **Linear-history check**: `bash packages/dev-tools/tools/check-linear-history.sh [base-ref] [head-ref]`. `linear-history` CI job.
- **Autofix-drift gate** (`npm run lint:autofix-drift`): `tools/check-autofix-drift.sh` — `biome check --write` must be a no-op; catches safe fixes of warn/info rules that `biome check` (lint:ci) accepts. CI `lint` job + pre-push gate.
- **Skill lint** (`npm run lint:skills`): `tools/lint-skills.mjs` — `tessl skill lint` via `@tessl/cli`; warns locally, fails under `--strict`/CI.
- **Patch reconcile** (`npm run lint:patches`): `packages/dev-tools/patch-reconcile/check-patches.mjs` + `reconcile-context.mjs`. See `patches/README.md`.
- **Developer-skill sync** (`npm run lint:skill-router`): `tools/check-skill-router-sync.sh` — keeps root router, `.agents/skills/`, `.claude/skills/` in sync.
- **SPM ↔ xcodegen pin reconcile** (`npm run lint:swift-pins`): `packages/dev-tools/swift-pin-reconcile/`. Dual-pinned GitHub packages (Package.swift + project.yml) must overlap; `renovate-swift-pin-reconcile.yml` raises the stale side on `swift-pin` PRs. See its README.
- **iOS UI-test exclusion registry** (`npm run lint:ios-ui-tests`): `tools/ios-ui-test-exclusions.mjs` + `packages/ios-app/ui-test-exclusions.json`. [details](../../docs/dev-tools-details.md#ios-ui-test-exclusion-registry).
- **SwiftPM lockfile drift gate** (`ios-app` CI): `tools/check-swift-resolved-drift.mjs` — catches floated transitive pins `lint:swift-pins` misses. [details](../../docs/dev-tools-details.md#swiftpm-lockfile-drift-gate).
- **Source-shape guards** (`tools/`): `check-no-innerhtml.mjs` (`lint:no-innerhtml`), `check-no-ui-imports-in-providers.mjs` (`lint:no-ui-in-providers`), `check-hosted-origin-literal.mjs`, `check-no-raw-chrome-runtime-id.mjs`, `check-agents-symlinks.mjs`. [details](../../docs/dev-tools-details.md#source-guards).
- **Layer back-edge ratchet** (`npm run lint:layer-back-edges`): `tools/check-layer-back-edges.mjs`; baseline `layer-back-edge-baseline.json` (`--update`). [details](../../docs/dev-tools-details.md#layer-back-edge-ratchet).
- **`Record<string, unknown>` ratchet** (`npm run lint:record-string-unknown`): `tools/check-record-string-unknown.mjs` + `.biome-plugins/no-record-string-unknown.grit` (`biome.record-gate.json`); baseline `record-string-unknown-baseline.json` (`--update`). [details](../../docs/dev-tools-details.md#record-string-unknown-ratchet).
- **Swift unused-dependency gate** (`npm run lint:swift-deps`): `tools/check-swift-unused-deps.mjs` (+ `-lib.mjs`) — SPM parity with knip (TS) / `make tidy-check` (Go). Waiver `// unused-dep-ok: <reason>`. [details](../../docs/dev-tools-details.md#swift-unused-dependency-gate).
- **iOS PR screenshots**: `tools/ios-screenshots.mjs` (+ `-lib.mjs`) reads `packages/ios-app/screenshot-screens.json`, emits Storybook `manifest.json`. Workflow `ios-screenshots.yml`.
- **Storybook PR screenshots**: `tools/storybook-affected-screenshots.mjs` (+ `storybook-affected-stories-lib.mjs`) — light/dark shots of affected stories; pair with `build-storybook -w @slicc/webcomponents`; workflow `storybook-screenshots.yml`; R2 upload `storybook-screenshots-upload.mjs` (+ `-lib`). [details](../../docs/dev-tools-details.md#storybook-screenshots-upload).
- **Dead code (production files)** (`npm run deadcode:production-files`): `knip --production --include files`; `knip.json`. [details](../../docs/dev-tools-details.md#knip-production-suffix-discipline).
- **Debt boy-scout gate**: `node packages/dev-tools/tools/check-touched-exemptions.mjs [base-ref]` (+ `size-exemption-lib.mjs`) — enforces `biome.json` debt overrides + the two `*-baseline.json`. See [verifying](../../.agents/skills/verifying-before-push/SKILL.md).
- **Coverage gate + ratchet** (`tools/`): `coverage-gate.mjs` + `coverage-ratchet.mjs` (`coverage-thresholds.json`); Swift `swift-coverage-check.sh` + `-runner-retry.sh` (`SLICC_IOS_SIM_UDID` override). [details](../../docs/dev-tools-details.md#swift-coverage-retry).
- **First-load size gate** (part of `npm run size -w @slicc/webapp`): `tools/check-first-load-size.mjs` (+ `first-load-size-lib.mjs`, `first-load-baseline.mjs`) — relative cold-boot payload guard vs `origin/main` (`--baseline=<ref>|none`, `--json`); ceilings in `packages/webapp/first-load-budget.json`. [details](../../docs/dev-tools-details.md#first-load-size-gate).
- **Cross-impl vectors**: `tools/gen-mask-vectors.mjs` (TS/Swift mask parity), `gen-theme-vectors.mjs` (`npx tsx`; regen after `theme-engine.ts` edits, asserted by `theme-vectors.test.ts` + `ThemeEngineTests.swift`).
- **Preflight deps check**: `tools/preflight-deps.mjs` — wired via `pretypecheck`/`pretest`.
- **Release gating**: `tools/release-plan.mjs` (Linux preflight) + `release-native.mjs` — gates macOS/iOS packaging, `slicc` Go CLI (`packages/slicc-cli/sign-and-package.sh`), Chrome Web Store/worker publish, `@ai-ecoverse/biome-jsh` (`--gate=biome-jsh-version|biome-jsh`).
- **Optional-binary guard**: `tools/run-if-installed.mjs <binary> [args...]` — runs iff on `PATH`, else warns and exits 0; used by `lint-staged` Swift/Go globs.

### SLICC CDP Debug + Screencast

- `tools/slicc-debug.mjs` — CDP diagnostic CLI (`targets`, `logs`, `vfs ls/cat`, `eval`, `shell`; `--url`/`--url-pattern`/`--file`; `--help`).
- `tools/slicc-screencast.mjs` (+ `-lib.mjs`, `-video.mjs`) — `Page.startScreencast` frames + `manifest.json`; `--video` via ffmpeg. Skill `demo-recording`.

### Fresh Dev Harnesses

Five isolated harnesses on distinct ports; reaping opt-in (`SLICC_FRESH_REAP=1`), port-scoped.

| Harness (script under `tools/`)              | Bridge             | CDP     | Notes                                    |
| -------------------------------------------- | ------------------ | ------- | ---------------------------------------- |
| Standalone `dev-standalone-fresh.sh`         | `:$PORT` (`:5715`) | auto    | fails on occupied bridge; self-builds UI |
| Swift `dev-swift-fresh.sh`                   | `:5720`            | `:9224` | native; auto-signs with dev cert         |
| Extension `dev-extension-fresh.sh`           | (SW)               | `:9333` | MV3 extension IS the bridge              |
| Electron-Node `dev-electron-node-fresh.sh`   | `:5730`            | `:9225` | external Electron app (Slack)            |
| Electron-Swift `dev-electron-swift-fresh.sh` | `:5740`            | `:9226` | Swift backend + external Electron        |

Isolated lane: `PORT=5715 WRANGLER_PORT=8787 npm run dev:standalone:fresh` (also `dev:swift:fresh`, `dev:extension:fresh`, `dev:electron:{node,swift}:fresh`; `PORT=…`/`ELECTRON_APP=…`). Never touch production bridge `:5710` or CDP `:9222`. [development.md](../../docs/development.md), [details](../../docs/dev-tools-details.md#fresh-dev-harnesses).

### Supporting Utilities

- **Labeled Chrome clone**: `clone-labeled-chrome.sh` — APFS COW-clone with distinct `CFBundleName`/`CFBundleIdentifier` for per-harness ⌘-Tab entries; ad-hoc re-signed. Darwin-only.
- **Stable dev code-signing identity**: `bash tools/setup-dev-cert.sh` — one-time; creates self-signed `SLICC Dev Code Signing`, picked up by `dev-swift-fresh.sh`.

## Usage Notes

- Prefer root npm scripts when a helper already has one.
- Keep dev-only configs/utilities out of runtime packages unless needed at runtime.
- When adding tooling, document its file location and entry command.
