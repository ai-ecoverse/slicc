# CLAUDE.md

Developer tooling in `packages/dev-tools/`. Per-gate rationale and edge cases: [`docs/dev-tools-details.md`](../../docs/dev-tools-details.md) (anchors linked below).

## Key Tooling Areas

Bare script names live under `tools/`, bare dir names under `packages/dev-tools/`, unless a fuller path is given.

- **playwright-cli gap sync**: `tools/playwright-cli-sync.mjs` — diffs Slicc's vs `@playwright/cli`. [ref](../../docs/playwright-cli-sync.md).
- **Dev-only VFS skills** (`vfs-dev-skills/`): `__DEV__`-gated `import.meta.glob` in `packages/webapp/src/scoops/skills.ts`, remapped to `/workspace/skills/`.
- **Build configs**: `packages/webapp/vite.config.ts`, `packages/chrome-extension/vite.config.ts`, `biome.json`.
- **QA setup**: `packages/node-server/src/qa-setup.ts` + `npm run qa:*`; visual `packages/webapp/tests/test-dips.mjs`.
- **RUM error triage**: `rum-error-triage/triage-rum-errors.mjs`, nightly.
- **Scheduled agentic workflows** (selector `.mjs` + `claude-code-action`): `boy-scout-debt/`, `pr-fix-dispatcher/`, `claude-md-compactor/`, `flaky-ci-hunter/`, `backlog-dispatcher/`; event-driven **review responder** (`review-responder/`) handles `automation/*` feedback. [details](../../docs/dev-tools-details.md#scheduled-agentic-workflows), [responder](../../docs/dev-tools-details.md#review-responder).
- **Regression cluster hunter** (release-triggered, `regression-cluster-hunter/` + `.yml`): sweeps for surviving siblings of a shipped fix. [details](../../docs/dev-tools-details.md#regression-cluster-hunter).
- **Bedrock model scout** (weekly canary, no Claude): `model-scout/` + `.yml` — probes `*_BEDROCK_MODEL` IDs, files an issue on a dead one. [details](../../docs/dev-tools-details.md#model-scout).
- **e2b template**: `e2b-template/` — hosted-leader cloud float sandbox. See `packages/cloud-core/CLAUDE.md`.
- **AI comment detection**: `ai-comment-detection/` + `.yml` — labels `ai-generated`/`human-in-the-loop`. [details](../../docs/dev-tools-details.md#ai-comment-detection).
- **Doc gates** (`npm run lint:docs`): `tools/check-doc-sizes.mjs` + `check-doc-refs.mjs` (+ `-lib` each). [details](../../docs/dev-tools-details.md#doc-dead-reference-gate).
- **Hugging Face caching mirror** (`tools/hf-cache-mirror.mjs`): zero-dep local `huggingface.co` mirror; e2e CI caches `.cache/hf-mirror` + sets `HF_ENDPOINT` for warm Kokoro weights.
- **Linear-history check**: `bash tools/check-linear-history.sh [base] [head]` (`linear-history` job).
- **Autofix-drift gate** (`npm run lint:autofix-drift`): `tools/check-autofix-drift.sh` — `biome check --write` must be a no-op (catches warn/info autofixes `biome check` misses).
- **Skill lint** (`npm run lint:skills`): `tools/lint-skills.mjs` — `tessl skill lint`; fails under `--strict`/CI.
- **Patch reconcile** (`npm run lint:patches`): `patch-reconcile/check-patches.mjs` + `reconcile-context.mjs`.
- **Developer-skill sync** (`npm run lint:skill-router`): `tools/check-skill-router-sync.sh` — keeps root router, `.agents/skills/`, `.claude/skills/` in sync.
- **SPM ↔ xcodegen pin reconcile** (`npm run lint:swift-pins`): `swift-pin-reconcile/` — dual GitHub pins (Package.swift + project.yml) must overlap; `renovate-swift-pin-reconcile.yml` bumps the stale side.
- **Agent-skill install pin reconcile**: `skill-pin-reconcile/` — dual npm pins with an `ipk add` line in a vfs-root skill (today: v86); `renovate-skill-pin-reconcile.yml` bumps the stale line; backstop is the live canary.
- **iOS UI-test exclusion registry** (`npm run lint:ios-ui-tests`): `tools/ios-ui-test-exclusions.mjs` + `packages/ios-app/ui-test-exclusions.json`. [details](../../docs/dev-tools-details.md#ios-ui-test-exclusion-registry).
- **SwiftPM lockfile drift gate** (`ios-app` CI): `tools/check-swift-resolved-drift.mjs` — catches floated transitive pins. [details](../../docs/dev-tools-details.md#swiftpm-lockfile-drift-gate).
- **Source-shape guards** (`tools/`, each own lint script): `check-no-innerhtml.mjs`, `check-no-ui-imports-in-providers.mjs`, `check-hosted-origin-literal.mjs`, `check-no-raw-chrome-runtime-id.mjs`, `check-agents-symlinks.mjs`. [details](../../docs/dev-tools-details.md#source-guards).
- **Baseline ratchets** (each `tools/check-*.mjs` + a `*-baseline.json`, `--update`):
  - **Layer back-edges** (`npm run lint:layer-back-edges`): `check-layer-back-edges.mjs`, `layer-back-edge-baseline.json`. Zero-tolerance: no relative import may escape `packages/webapp/src` into a sibling package. [details](../../docs/dev-tools-details.md#layer-back-edge-ratchet).
  - **Float probes** (`npm run lint:no-float-probes`): `check-no-float-probes.mjs`, `float-probe-baseline.json` (`--allow-growth`) — bans the ten `FLOAT_PROBE_NAMES` + raw `__slicc_connect_mode` under `scoops/`/`tools/`/`kernel/`. [details](../../docs/dev-tools-details.md#float-probe-ratchet).
  - **`Record<string, unknown>`** (`npm run lint:record-string-unknown`): `check-record-string-unknown.mjs` + `.biome-plugins/no-record-string-unknown.grit` (`biome.record-gate.json`), baseline. [details](../../docs/dev-tools-details.md#record-string-unknown-ratchet).
- **Swift unused-dependency gate** (`npm run lint:swift-deps`): `tools/check-swift-unused-deps.mjs` (+ `-lib.mjs`) — SPM parity with knip / `make tidy-check`; waiver `// unused-dep-ok`. [details](../../docs/dev-tools-details.md#swift-unused-dependency-gate).
- **iOS PR screenshots**: `tools/ios-screenshots.mjs` (+ `-lib.mjs`) reads `packages/ios-app/screenshot-screens.json`, emits Storybook `manifest.json`.
- **Storybook PR screenshots**: `tools/storybook-affected-screenshots.mjs` (+ `storybook-affected-stories-lib.mjs`); pair with `build-storybook -w @slicc/webcomponents`; R2 `storybook-screenshots-upload.mjs`. [details](../../docs/dev-tools-details.md#storybook-screenshots-upload).
- **Dead code (prod files)** (`npm run deadcode:production-files`): `knip --production --include files`; `knip.json`. [details](../../docs/dev-tools-details.md#knip-production-suffix-discipline).
- **Debt boy-scout gate**: `node tools/check-touched-exemptions.mjs [base-ref]` (+ `size-exemption-lib.mjs`) — enforces `biome.json` overrides + the three baseline ratchets. [verify](../../.agents/skills/verifying-before-push/SKILL.md).
- **Coverage gate + ratchet** (`tools/`): `coverage-gate.mjs` + `coverage-ratchet.mjs` (`coverage-thresholds.json`); Swift `swift-coverage-check.sh` + `-runner-retry.sh`. [retry](../../docs/dev-tools-details.md#swift-coverage-retry).
- **First-load size gate** (part of `npm run size -w @slicc/webapp`): `tools/check-first-load-size.mjs` (+ `first-load-size-lib.mjs`, `first-load-baseline.mjs`) — cold-boot payload guard vs `origin/main`; ceilings `packages/webapp/first-load-budget.json`. [details](../../docs/dev-tools-details.md#first-load-size-gate).
- **Cross-impl vectors**: `tools/gen-mask-vectors.mjs` (mask parity), `gen-theme-vectors.mjs` (`npx tsx`; regen after `theme-engine.ts`, asserted by `theme-vectors.test.ts`/`ThemeEngineTests.swift`).
- **Preflight deps check**: `tools/preflight-deps.mjs` — via `pretypecheck`/`pretest`.
- **Release gating**: `tools/release-plan.mjs` (Linux preflight) + `release-native.mjs` — gate macOS/iOS packaging, the `slicc` Go CLI (`packages/slicc-cli/sign-and-package.sh`), Chrome Web Store / worker publish, `@ai-ecoverse/biome-jsh`.
- **Optional-binary guard**: `tools/run-if-installed.mjs <binary> [args…]` — runs iff on `PATH`, else warns + exits 0; used by `lint-staged` Swift/Go globs.

### SLICC CDP Debug + Screencast

- `tools/slicc-debug.mjs` — CDP diagnostic CLI (`targets`, `logs`, `vfs ls/cat`, `eval`, `shell`; `--url`/`--url-pattern`/`--file`; `--help`).
- `tools/slicc-screencast.mjs` (+ `-lib.mjs`, `-video.mjs`) — `Page.startScreencast` frames + `manifest.json`; `--video` via ffmpeg. Skill `demo-recording`.

### Fresh Dev Harnesses

Five isolated harnesses on distinct ports; reaping opt-in (`SLICC_FRESH_REAP=1`), port-scoped. [dev](../../docs/development.md), [details](../../docs/dev-tools-details.md#fresh-dev-harnesses).

| Harness (script under `tools/`)              | Bridge             | CDP     | Notes                         |
| -------------------------------------------- | ------------------ | ------- | ----------------------------- |
| Standalone `dev-standalone-fresh.sh`         | `:$PORT` (`:5715`) | auto    | fails on occupied bridge      |
| Swift `dev-swift-fresh.sh`                   | `:5720`            | `:9224` | native; auto-signs with cert  |
| Extension `dev-extension-fresh.sh`           | (SW)               | `:9333` | MV3 extension IS the bridge   |
| Electron-Node `dev-electron-node-fresh.sh`   | `:5730`            | `:9225` | external Electron app (Slack) |
| Electron-Swift `dev-electron-swift-fresh.sh` | `:5740`            | `:9226` | Swift backend + Electron      |

Run via `npm run dev:standalone:fresh` (also `dev:swift:fresh`, `dev:extension:fresh`, `dev:electron:{node,swift}:fresh`); override with `PORT=…`/`WRANGLER_PORT=…`/`ELECTRON_APP=…`. Never touch prod bridge `:5710` or CDP `:9222`.

Darwin support: `clone-labeled-chrome.sh` (APFS COW-clone with distinct `CFBundleName`/`CFBundleIdentifier` for per-harness ⌘-Tab entries); `bash tools/setup-dev-cert.sh` (one-time self-signed `SLICC Dev Code Signing`, used by `dev-swift-fresh.sh`).

## Usage Notes

- Prefer root npm scripts when a helper already has one.
- Keep dev-only configs/utilities out of runtime packages unless needed at runtime.
- When adding tooling, document its location and entry command here.
