# CLAUDE.md

Developer-tooling surface for `packages/dev-tools/`. Long-form notes: [`docs/dev-tools-details.md`](../../docs/dev-tools-details.md).

## Key Tooling Areas

- **playwright-cli gap sync**: `packages/dev-tools/tools/playwright-cli-sync.mjs` — diffs Slicc's playwright-cli against `@playwright/cli`. Ref: [`docs/playwright-cli-sync.md`](../../docs/playwright-cli-sync.md).
- **Dev-only VFS skills** (`packages/dev-tools/vfs-dev-skills/`): `__DEV__`-gated `import.meta.glob` in `packages/webapp/src/scoops/skills.ts`, remapped to `/workspace/skills/`. Contains `playwright-cli-e2e`.
- **Build configs**: `packages/webapp/vite.config.ts`, `packages/chrome-extension/vite.config.ts`, `biome.json`.
- **QA setup**: `packages/node-server/src/qa-setup.ts` plus root `npm run qa:*` scripts. Visual/integration helper: `packages/webapp/tests/test-dips.mjs`.
- **RUM error triage**: `packages/dev-tools/rum-error-triage/triage-rum-errors.mjs`, nightly via `.github/workflows/rum-error-triage.yml`.
- **AI comment detection**: `packages/dev-tools/ai-comment-detection/` — labels `ai-generated`/`human-in-the-loop` via `.github/workflows/ai-comment-detection.yml`. Deep ref: [dev-tools-details.md#ai-comment-detection](../../docs/dev-tools-details.md#ai-comment-detection).
- **Doc gates** (`npm run lint:docs`, `.husky/pre-commit`): `packages/dev-tools/tools/check-doc-sizes.mjs` (+ `check-doc-sizes-lib.mjs`) and `check-doc-refs.mjs` (+ `check-doc-refs-lib.mjs`). Deep ref: [dev-tools-details.md#doc-dead-reference-gate](../../docs/dev-tools-details.md#doc-dead-reference-gate).
- **Linear-history check**: `bash packages/dev-tools/tools/check-linear-history.sh [base-ref] [head-ref]`. `linear-history` CI job.
- **Skill lint** (`npm run lint:skills`): `packages/dev-tools/tools/lint-skills.mjs` — `tessl skill lint` via `@tessl/cli`. Warns locally; fails under `--strict`/CI.
- **Developer-skill sync** (`npm run lint:skill-router`): `packages/dev-tools/tools/check-skill-router-sync.sh` — keeps root router, `.agents/skills/`, `.claude/skills/` aliases in sync.
- **Patch reconcile** (`npm run lint:patches`): `packages/dev-tools/patch-reconcile/check-patches.mjs` + `reconcile-context.mjs`. See `patches/README.md`.
- **innerHTML guard** (`npm run lint:no-innerhtml`): `packages/dev-tools/tools/check-no-innerhtml.mjs` bans `.innerHTML =`, `.outerHTML =`, `insertAdjacentHTML()` in `@slicc/webcomponents` (stories/tests exempt).
- **Providers boundary** (`npm run lint:no-ui-in-providers`): `packages/dev-tools/tools/check-no-ui-imports-in-providers.mjs` bans `from '…ui/…'` in `providers/built-in/`.
- **Layer back-edge ratchet** (`npm run lint:layer-back-edges`): `packages/dev-tools/tools/check-layer-back-edges.mjs`; baseline `layer-back-edge-baseline.json` (`--update`). Deep ref: [dev-tools-details.md#layer-back-edge-ratchet](../../docs/dev-tools-details.md#layer-back-edge-ratchet).
- **`Record<string, unknown>` ratchet** (`npm run lint:record-string-unknown`): `packages/dev-tools/tools/check-record-string-unknown.mjs`; detection is the GritQL plugin `.biome-plugins/no-record-string-unknown.grit` run through `biome.record-gate.json` (it cannot live in the root config). Baseline `record-string-unknown-baseline.json` (`--update`); tests out of scope; `// biome-ignore lint/plugin: <reason>` is the escape hatch. Deep ref: [dev-tools-details.md#record-string-unknown-ratchet](../../docs/dev-tools-details.md#record-string-unknown-ratchet).
- **Hosted-origin literal guard**: `packages/dev-tools/tools/check-hosted-origin-literal.mjs` — TS must import `SLICC_HOSTED_ORIGIN` from `@slicc/shared-ts`.
- **Chrome runtime.id guard**: `packages/dev-tools/tools/check-no-raw-chrome-runtime-id.mjs` — go through `core/runtime-env.ts` (tests exempt).
- **AGENTS.md symlink guard**: `packages/dev-tools/tools/check-agents-symlinks.mjs` — every `packages/*/CLAUDE.md` needs an `AGENTS.md` sibling symlink.
- **iOS PR screenshots**: `packages/dev-tools/tools/ios-screenshots.mjs` (+ `ios-screenshots-lib.mjs`) reads `packages/ios-app/screenshot-screens.json`, emits Storybook `manifest.json`. Driven by `.github/workflows/ios-screenshots.yml`.
- **Storybook PR screenshots**: `packages/dev-tools/tools/storybook-affected-screenshots.mjs` (+ `storybook-affected-stories-lib.mjs`) — light/dark shots of affected webcomponents stories; pair with `npm run build-storybook -w @slicc/webcomponents`. Driven by `.github/workflows/storybook-screenshots.yml`. Upload: `storybook-screenshots-upload.mjs` (+ `-lib.mjs`) to R2 `slicc-pr-screenshots`, content-hash dedup, `--concurrency`. Deep ref: [dev-tools-details.md#storybook-screenshots-upload](../../docs/dev-tools-details.md#storybook-screenshots-upload).
- **Dead code (production files)** (`npm run deadcode:production-files`): `knip --production --include files`; config `knip.json`. Deep ref: [dev-tools-details.md#knip-production-suffix-discipline](../../docs/dev-tools-details.md#knip-production-suffix-discipline).
- **Debt boy-scout gate**: `node packages/dev-tools/tools/check-touched-exemptions.mjs [base-ref]` (+ `size-exemption-lib.mjs`) — enforces `biome.json` debt overrides plus `layer-back-edge-baseline.json` and `record-string-unknown-baseline.json`; skips non-PR events. See [verifying-before-push skill](../../.agents/skills/verifying-before-push/SKILL.md).
- **Coverage gate + ratchet**: `packages/dev-tools/tools/coverage-gate.mjs` + `coverage-ratchet.mjs` (`coverage-thresholds.json`). Swift: `swift-coverage-check.sh` + `swift-coverage-runner-retry.sh`; `SLICC_IOS_SIM_UDID` overrides. Deep ref: [dev-tools-details.md#swift-coverage-retry](../../docs/dev-tools-details.md#swift-coverage-retry).
- **Optional-binary guard**: `packages/dev-tools/tools/run-if-installed.mjs <binary> [args...]` — runs iff on `PATH`, else warns and exits 0. Used by the root `lint-staged` Swift/Go globs.
- **Cross-impl vectors**: `packages/dev-tools/tools/gen-mask-vectors.mjs` (TS/Swift mask parity) and `gen-theme-vectors.mjs` (via `npx tsx`; regenerate after `theme-engine.ts` changes, asserted by `packages/webapp/tests/ui/theme-vectors.test.ts` + `ThemeEngineTests.swift`).
- **Preflight deps check**: `packages/dev-tools/tools/preflight-deps.mjs` — wired via `pretypecheck`/`pretest`.
- **Release gating**: `packages/dev-tools/tools/release-plan.mjs` (Linux preflight) + `release-native.mjs` — gates macOS/iOS packaging, `slicc` Go CLI (`packages/slicc-cli/sign-and-package.sh`), Chrome Web Store/worker publish, `@ai-ecoverse/biome-jsh` (`--gate=biome-jsh-version`/`--gate=biome-jsh`).

### SLICC CDP Debug + Screencast

- `packages/dev-tools/tools/slicc-debug.mjs` — CDP diagnostic CLI (`targets`, `logs`, `vfs ls/cat`, `eval`, `shell`; `--url`/`--url-pattern`/`--file`). `node packages/dev-tools/tools/slicc-debug.mjs --help`.
- `packages/dev-tools/tools/slicc-screencast.mjs` (+ `-lib.mjs`, `-video.mjs`) — `Page.startScreencast` frames + `manifest.json`; `--video` via ffmpeg. Skill: `demo-recording`.

### Fresh Dev Harnesses

Five isolated harnesses on distinct ports. Standalone fails on an occupied bridge unless `SLICC_FRESH_REAP=1` reaps a stale harness; reaping production bridge `:5710` is refused, Chrome CDP is never reaped, and cleanup is port-scoped.

| Harness        | Script                        | Bridge                 | CDP     | Notes                                       |
| -------------- | ----------------------------- | ---------------------- | ------- | ------------------------------------------- |
| Standalone     | `dev-standalone-fresh.sh`     | `:$PORT` (use `:5715`) | auto    | Fails on occupied bridge; self-builds UI    |
| Swift          | `dev-swift-fresh.sh`          | `:5720`                | `:9224` | Native; auto-signs with stable dev cert     |
| Extension      | `dev-extension-fresh.sh`      | (SW)                   | `:9333` | MV3 extension IS the bridge; LaunchServices |
| Electron-Node  | `dev-electron-node-fresh.sh`  | `:5730`                | `:9225` | External Electron app (default: Slack)      |
| Electron-Swift | `dev-electron-swift-fresh.sh` | `:5740`                | `:9226` | Swift backend, external Electron app        |

Isolated lane: `PORT=5715 WRANGLER_PORT=8787 npm run dev:standalone:fresh`; never touch production bridge `:5710` or Chrome CDP `:9222`. Also `npm run dev:swift:fresh`, `dev:extension:fresh`, `dev:electron:node:fresh`, `dev:electron:swift:fresh`, with `PORT=…`/`ELECTRON_APP=…` overrides. Lifecycle + reaping: [`docs/development.md`](../../docs/development.md); [dev-tools-details.md#fresh-dev-harnesses](../../docs/dev-tools-details.md#fresh-dev-harnesses).

### Supporting Utilities

- **Labeled Chrome clone**: `clone-labeled-chrome.sh` — APFS COW-clone with distinct `CFBundleName`/`CFBundleIdentifier` (distinct ⌘-Tab entries per harness); ad-hoc re-signed, top-level only. No-op on non-darwin.
- **Stable dev code-signing identity**: `bash packages/dev-tools/tools/setup-dev-cert.sh` — one-time; creates persistent self-signed `SLICC Dev Code Signing`. `dev-swift-fresh.sh` picks it up automatically.

## e2b Template

Hosted-leader cloud float runs in an e2b sandbox; template in `packages/dev-tools/e2b-template/`. See `packages/cloud-core/CLAUDE.md`.

## Usage Notes

- Prefer root npm scripts when a helper already has one.
- Keep dev-only configs and utilities out of runtime packages unless required at runtime.
- When adding new tooling, document both file location and entry command.
