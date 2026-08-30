# CLAUDE.md

Developer-tooling surface for `packages/dev-tools/`. Scripts live in `packages/dev-tools/tools/` unless a package subdirectory is named. Long-form notes: [`docs/dev-tools-details.md`](../../docs/dev-tools-details.md).

## Key Tooling Areas

- **playwright-cli gap sync**: `playwright-cli-sync.mjs` — diffs Slicc's playwright-cli against `@playwright/cli`. Ref: [`docs/playwright-cli-sync.md`](../../docs/playwright-cli-sync.md).
- **Dev-only VFS skills** (`packages/dev-tools/vfs-dev-skills/`): `__DEV__`-gated `import.meta.glob` in `packages/webapp/src/scoops/skills.ts`, remapped to `/workspace/skills/`. Contains `playwright-cli-e2e`.
- **Build configs**: `packages/webapp/vite.config.ts`, `packages/chrome-extension/vite.config.ts`, `biome.json`.
- **QA setup**: `packages/node-server/src/qa-setup.ts` plus root `npm run qa:*` scripts. Visual/integration helper: `packages/webapp/tests/test-dips.mjs`.
- **RUM error triage**: `packages/dev-tools/rum-error-triage/triage-rum-errors.mjs`, nightly `.github/workflows/rum-error-triage.yml`.
- **Scheduled agentic workflows** (selector `.mjs` + `claude-code-action`): `boy-scout-debt/`, `pr-fix-dispatcher/`, `claude-md-compactor/`, `flaky-ci-hunter/`, `backlog-dispatcher/`. [details](../../docs/dev-tools-details.md#scheduled-agentic-workflows).
- **Review responder** (event-driven): `packages/dev-tools/review-responder/` + `.github/workflows/review-responder.yml`. [details](../../docs/dev-tools-details.md#review-responder).
- **Bedrock model scout** (weekly canary, no Claude): `packages/dev-tools/model-scout/` + `.github/workflows/model-scout.yml`. [details](../../docs/dev-tools-details.md#model-scout).
- **AI comment detection**: `packages/dev-tools/ai-comment-detection/` + `.github/workflows/ai-comment-detection.yml` (`ai-generated`/`human-in-the-loop`). [details](../../docs/dev-tools-details.md#ai-comment-detection).
- **Doc gates** (`npm run lint:docs`, `.husky/pre-commit`): `check-doc-sizes.mjs` and `check-doc-refs.mjs` (+ `-lib.mjs`). [details](../../docs/dev-tools-details.md#doc-dead-reference-gate).
- **Hugging Face caching mirror** (`hf-cache-mirror.mjs`): local `huggingface.co` mirror; e2e CI caches `.cache/hf-mirror` and sets `HF_ENDPOINT` so `hf download` (Kokoro) hits disk on warm runs.
- **Linear-history check**: `bash packages/dev-tools/tools/check-linear-history.sh [base-ref] [head-ref]`. `linear-history` CI job.
- **Skill lint** (`npm run lint:skills`): `lint-skills.mjs` — `tessl skill lint`. Warns locally; fails under `--strict`/CI.
- **Developer-skill sync** (`npm run lint:skill-router`): `check-skill-router-sync.sh` — root router, `.agents/skills/`, `.claude/skills/` aliases.
- **Patch reconcile** (`npm run lint:patches`): `packages/dev-tools/patch-reconcile/check-patches.mjs` + `reconcile-context.mjs`. `patches/README.md`.
- **SPM ↔ xcodegen pin reconcile** (`npm run lint:swift-pins`): `packages/dev-tools/swift-pin-reconcile/`. Dual-pinned GitHub packages (Package.swift + project.yml) must overlap; `renovate-swift-pin-reconcile.yml` raises the stale side on `swift-pin` PRs.
- **iOS UI-test exclusion registry** (`npm run lint:ios-ui-tests`): `ios-ui-test-exclusions.mjs` + `packages/ios-app/ui-test-exclusions.json`. [details](../../docs/dev-tools-details.md#ios-ui-test-exclusion-registry).
- **SwiftPM lockfile drift gate**: `check-swift-resolved-drift.mjs` — AFTER a resolve step (`ios-app` CI). [details](../../docs/dev-tools-details.md#swiftpm-lockfile-drift).
- **innerHTML guard** (`npm run lint:no-innerhtml`): `check-no-innerhtml.mjs` bans `.innerHTML =`, `.outerHTML =`, `insertAdjacentHTML()` in `@slicc/webcomponents` (stories/tests exempt).
- **Providers boundary** (`npm run lint:no-ui-in-providers`): `check-no-ui-imports-in-providers.mjs` bans `from '…ui/…'` in `providers/built-in/`.
- **Layer back-edge ratchet** (`npm run lint:layer-back-edges`): `check-layer-back-edges.mjs`; baseline `layer-back-edge-baseline.json` (`--update`). [details](../../docs/dev-tools-details.md#layer-back-edge-ratchet).
- **`Record<string, unknown>` ratchet** (`npm run lint:record-string-unknown`): `check-record-string-unknown.mjs` via `biome.record-gate.json`; baseline `record-string-unknown-baseline.json` (`--update`). [details](../../docs/dev-tools-details.md#record-string-unknown-ratchet).
- **Hosted-origin literal guard**: `check-hosted-origin-literal.mjs` — TS must import `SLICC_HOSTED_ORIGIN` from `@slicc/shared-ts`.
- **Chrome runtime.id guard**: `check-no-raw-chrome-runtime-id.mjs` — `isChromeExtensionRealm()` from `@slicc/shared-ts` (tests exempt).
- **AGENTS.md symlink guard**: `check-agents-symlinks.mjs` — every `packages/*/CLAUDE.md` needs an `AGENTS.md` sibling symlink.
- **iOS PR screenshots**: `ios-screenshots.mjs` reads `packages/ios-app/screenshot-screens.json`, emits Storybook `manifest.json`. `.github/workflows/ios-screenshots.yml`.
- **Storybook PR screenshots**: `storybook-affected-screenshots.mjs` — light/dark affected-story shots; pair with `npm run build-storybook -w @slicc/webcomponents`. `.github/workflows/storybook-screenshots.yml`; R2 upload `storybook-screenshots-upload.mjs`. [details](../../docs/dev-tools-details.md#storybook-screenshots-upload).
- **Dead code (production files)** (`npm run deadcode:production-files`): `knip --production --include files`; `knip.json`. [details](../../docs/dev-tools-details.md#knip-production-suffix-discipline).
- **Swift unused-dependency gate** (`npm run lint:swift-deps`): `check-swift-unused-deps.mjs` (+ `-lib.mjs`). Waiver: `// unused-dep-ok: <reason>`. [details](../../docs/dev-tools-details.md#swift-unused-dependency-gate).
- **Debt boy-scout gate**: `node packages/dev-tools/tools/check-touched-exemptions.mjs [base-ref]` (+ `size-exemption-lib.mjs`) — `biome.json` debt overrides plus `layer-back-edge-baseline.json` and `record-string-unknown-baseline.json`. [verifying-before-push](../../.agents/skills/verifying-before-push/SKILL.md).
- **First-load size gate** (`npm run size -w @slicc/webapp`): `check-first-load-size.mjs` — eager page/worker closures vs merge-base; `--baseline=<ref>` (default `origin/main`), `--baseline=none`, `--json`. [details](../../docs/dev-tools-details.md#first-load-size-gate).
- **Coverage gate + ratchet**: `coverage-gate.mjs` + `coverage-ratchet.mjs` (`coverage-thresholds.json`). Swift: `swift-coverage-check.sh` + `swift-coverage-runner-retry.sh`; `SLICC_IOS_SIM_UDID` overrides. [details](../../docs/dev-tools-details.md#swift-coverage-retry).
- **Optional-binary guard**: `run-if-installed.mjs <binary> [args...]` — runs iff on `PATH`, else warns and exits 0.
- **Cross-impl vectors**: `gen-mask-vectors.mjs` (TS/Swift mask parity) and `gen-theme-vectors.mjs` (`npx tsx`; regenerate after `theme-engine.ts` changes; asserted by `packages/webapp/tests/ui/theme-vectors.test.ts` + `ThemeEngineTests.swift`).
- **Preflight deps check**: `preflight-deps.mjs` — `pretypecheck`/`pretest`.
- **Release gating**: `release-plan.mjs` (Linux preflight) + `release-native.mjs` — macOS/iOS packaging, `slicc` Go CLI (`packages/slicc-cli/sign-and-package.sh`), Chrome Web Store/worker publish, `@ai-ecoverse/biome-jsh` (`--gate=biome-jsh-version`/`--gate=biome-jsh`).
- **CDP debug**: `slicc-debug.mjs` (`targets`, `logs`, `vfs ls/cat`, `eval`, `shell`; `--url`/`--url-pattern`/`--file`). `node packages/dev-tools/tools/slicc-debug.mjs --help`.
- **Screencast**: `slicc-screencast.mjs` (+ `-lib.mjs`, `-video.mjs`) — `Page.startScreencast` frames + `manifest.json`; `--video` via ffmpeg. Skill: `demo-recording`.
- **e2b template**: `packages/dev-tools/e2b-template/`. See `packages/cloud-core/CLAUDE.md`.

### Fresh Dev Harnesses

Five isolated harnesses on distinct ports; reaping is opt-in (`SLICC_FRESH_REAP=1`) and port-scoped.

| Harness        | Script                        | Bridge                 | CDP     | Notes                                       |
| -------------- | ----------------------------- | ---------------------- | ------- | ------------------------------------------- |
| Standalone     | `dev-standalone-fresh.sh`     | `:$PORT` (use `:5715`) | auto    | Fails on occupied bridge; self-builds UI    |
| Swift          | `dev-swift-fresh.sh`          | `:5720`                | `:9224` | Native; auto-signs with stable dev cert     |
| Extension      | `dev-extension-fresh.sh`      | (SW)                   | `:9333` | MV3 extension IS the bridge; LaunchServices |
| Electron-Node  | `dev-electron-node-fresh.sh`  | `:5730`                | `:9225` | External Electron app (default: Slack)      |
| Electron-Swift | `dev-electron-swift-fresh.sh` | `:5740`                | `:9226` | Swift backend, external Electron app        |

Isolated lane: `PORT=5715 WRANGLER_PORT=8787 npm run dev:standalone:fresh`. Never production `:5710` or Chrome CDP `:9222`. Also `npm run dev:swift:fresh`, `dev:extension:fresh`, `dev:electron:node:fresh`, `dev:electron:swift:fresh` (`PORT=`/`ELECTRON_APP=`). Lifecycle: [`docs/development.md`](../../docs/development.md); [details](../../docs/dev-tools-details.md#fresh-dev-harnesses).

- **Labeled Chrome clone**: `clone-labeled-chrome.sh` — APFS COW-clone with distinct `CFBundleName`/`CFBundleIdentifier` (⌘-Tab per harness); ad-hoc re-signed, top-level only. No-op on non-darwin.
- **Dev cert**: `bash packages/dev-tools/tools/setup-dev-cert.sh` — one-time self-signed `SLICC Dev Code Signing`. `dev-swift-fresh.sh` picks it up.

New tooling: document location + entry command.
