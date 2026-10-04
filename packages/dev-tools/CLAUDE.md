# CLAUDE.md

Developer tooling. Per-gate rationale + edge cases: [`docs/dev-tools-details.md`](../../docs/dev-tools-details.md).

## Key Tooling Areas

Bare script names → `tools/`; bare dir names → `packages/dev-tools/`.

- **playwright-cli gap sync**: `tools/playwright-cli-sync.mjs` — diffs Slicc vs `@playwright/cli`. [ref](../../docs/playwright-cli-sync.md).
- **Dev-only VFS skills** (`vfs-dev-skills/`): `__DEV__`-gated `import.meta.glob` in `packages/webapp/src/scoops/skills.ts` → `/workspace/skills/`.
- **Build configs**: `packages/webapp/vite.config.ts`, `packages/chrome-extension/vite.config.ts`, `biome.json`.
- **QA setup**: `packages/node-server/src/qa-setup.ts` + `npm run qa:*`; visual `packages/webapp/tests/test-dips.mjs`.
- **RUM error triage** (nightly): `rum-error-triage/triage-rum-errors.mjs`.
- **Scheduled agentic workflows** (selector `.mjs` + `claude-code-action`): `boy-scout-debt/`, `pr-fix-dispatcher/`, `claude-md-compactor/`, `flaky-ci-hunter/`, `backlog-dispatcher/`; event-driven `review-responder/` on `automation/*`. [details](../../docs/dev-tools-details.md#scheduled-agentic-workflows), [responder](../../docs/dev-tools-details.md#review-responder).
- **Regression cluster hunter** (release-triggered): `regression-cluster-hunter/` + `.yml`. [details](../../docs/dev-tools-details.md#regression-cluster-hunter).
- **Bedrock model scout** (weekly canary, no Claude): `model-scout/` + `.yml`. [details](../../docs/dev-tools-details.md#model-scout).
- **e2b template**: `e2b-template/` — hosted-leader cloud float sandbox (`packages/cloud-core/CLAUDE.md`).
- **AI comment detection**: `ai-comment-detection/` + `.yml` — labels `ai-generated`/`human-in-the-loop`. [details](../../docs/dev-tools-details.md#ai-comment-detection).
- **no-comment mirror**: `no-comment/` + `no-comment-mirror.yml`; `lint:no-comments` no-ops on `main`, hard gate there. [details](../../docs/dev-tools-details.md#no-comment-mirror).
- **HF caching mirror** (`tools/hf-cache-mirror.mjs`): zero-dep local `huggingface.co` mirror; e2e CI caches `.cache/hf-mirror` + sets `HF_ENDPOINT` for warm Kokoro weights.

### Lint / CI gates

Each bold gate is an `npm run` script unless a raw command is shown.

- **lint:docs**: `tools/check-doc-sizes.mjs` + `check-doc-refs.mjs` (+ `-lib` each). [details](../../docs/dev-tools-details.md#doc-dead-reference-gate).
- **Linear history**: `bash tools/check-linear-history.sh [base] [head]` (`linear-history` job).
- **lint:autofix-drift**: `tools/check-autofix-drift.sh` — `biome check --write` must be a no-op (catches autofixes `check` misses).
- **lint:skills**: `tools/lint-skills.mjs` — `tessl skill lint`; fails under `--strict`/CI.
- **lint:patches**: `patch-reconcile/check-patches.mjs` + `reconcile-context.mjs`.
- **lint:skill-router**: `tools/check-skill-router-sync.sh` — syncs root router, `.agents/skills/`, `.claude/skills/`.
- **Pin reconcile** (dual pins must overlap; `renovate-*.yml` bumps the stale): **lint:swift-pins** `swift-pin-reconcile/` (Package.swift + project.yml); **Agent-skill install** `skill-pin-reconcile/` (npm pins + an `ipk add` line in a vfs-root skill).
- **lint:ios-ui-tests**: `tools/ios-ui-test-exclusions.mjs` + `packages/ios-app/ui-test-exclusions.json`. [details](../../docs/dev-tools-details.md#ios-ui-test-exclusion-registry).
- **lint:ios-test-isolation**: `tools/check-ios-test-isolation.mjs` (+ `-lib.mjs`); pairs with `tools/ios-sim-prepare.sh`. [details](../../docs/dev-tools-details.md#ios-test-isolation-gate).
- **SwiftPM lockfile drift** (`ios-app` CI): `tools/check-swift-resolved-drift.mjs`. [details](../../docs/dev-tools-details.md#swiftpm-lockfile-drift-gate).
- **Source-shape guards** (`tools/` scripts): `check-no-innerhtml.mjs`, `check-no-ui-imports-in-providers.mjs`, `check-hosted-origin-literal.mjs`, `check-no-raw-chrome-runtime-id.mjs`, `check-agents-symlinks.mjs`. [details](../../docs/dev-tools-details.md#source-guards).
- **lint:swift-deps** / **lint:swift-forbidden-imports**: `check-swift-unused-deps.mjs` (waiver `// unused-dep-ok`) and `check-swift-forbidden-imports.mjs` (each + `-lib.mjs`). [deps](../../docs/dev-tools-details.md#swift-unused-dependency-gate) · [imports](../../docs/dev-tools-details.md#swift-forbidden-import-gate).
- **lint:dead-flags**: `tools/check-dead-flags.mjs`; waiver `// unused-flag-ok`. [lifecycle](../../docs/feature-flags.md) · [details](../../docs/dev-tools-details.md#dead-feature-flag-gate).
- **deadcode:production-files**: `knip --production --include files`; `knip.json`. [details](../../docs/dev-tools-details.md#knip-production-suffix-discipline).
- **Debt boy-scout gate**: `node tools/check-touched-exemptions.mjs [base-ref]` (+ `size-exemption-lib.mjs`) — `biome.json` overrides + baseline ratchets. [verify](../../.agents/skills/verifying-before-push/SKILL.md).
- **Coverage gate + ratchet**: `tools/coverage-gate.mjs` + `coverage-ratchet.mjs` (`coverage-thresholds.json`); Swift `swift-coverage-check.sh` (+ `-runner-retry.sh`). [details](../../docs/dev-tools-details.md#swift-coverage-retry).
- **First-load size** (in `npm run size -w @slicc/webapp`): `tools/check-first-load-size.mjs` (+ `-lib.mjs`, `first-load-baseline.mjs`); ceilings `packages/webapp/first-load-budget.json`. [details](../../docs/dev-tools-details.md#first-load-size-gate).

**Baseline ratchets** (each `tools/check-*.mjs` + `*-baseline.json`; `--update`):

- **Layer back-edges** (`lint:layer-back-edges`): `check-layer-back-edges.mjs`. Per-package stacks (webapp, node-server, chrome-extension, cloudflare-worker) + zero-tolerance on relative imports escaping `webapp/src`. [details](../../docs/dev-tools-details.md#layer-back-edge-ratchet).
- **Float probes** (`lint:no-float-probes`): `check-no-float-probes.mjs` (`--allow-growth`) — bans `FLOAT_PROBE_NAMES` + raw `__slicc_connect_mode` under `scoops/`, `tools/`, `kernel/`. [details](../../docs/dev-tools-details.md#float-probe-ratchet).
- **`Record<string, unknown>`** (`lint:record-string-unknown`): `check-record-string-unknown.mjs` + `.biome-plugins/no-record-string-unknown.grit`, `biome.record-gate.json`. [details](../../docs/dev-tools-details.md#record-string-unknown-ratchet).

### Other tools

- **Cross-impl vectors**: `tools/gen-mask-vectors.mjs` (mask parity), `gen-theme-vectors.mjs` (`npx tsx`; regen after `theme-engine.ts`, asserted by `theme-vectors.test.ts`/`ThemeEngineTests.swift`).
- **iOS screenshots**: `tools/ios-screenshots.mjs` (+ `-lib.mjs`) reads `screenshot-screens.json`; `appearance` (`light`/`dark`) pins the sim, else dark.
- **Storybook screenshots**: `tools/storybook-affected-screenshots.mjs` (+ `storybook-affected-stories-lib.mjs`); pair with `build-storybook -w @slicc/webcomponents`. `storybook-screenshots-upload.mjs` → R2. [details](../../docs/webcomponents-details.md#storybook-pr-screenshots).
- **Agent merch grid**: `tools/agent-merch.mjs` (+ `agent-merch-lib.mjs`) — `<slicc-agent-avatar>` grid → 300-dpi PNGs in `dist/merch/` (Playwright; build `@slicc/webcomponents` first; `--help`). [details](../../docs/dev-tools-details.md#agent-merch-grid).
- **CI phase timings**: `tools/ci-job-timing.mjs` (+ `-lib.mjs`) — step timestamps → Markdown summary + JSON artifact; both Cloudflare staging workflows.
- **Preflight deps check**: `tools/preflight-deps.mjs` (via `pretypecheck`/`pretest`).
- **Release gating** ([details](../../docs/dev-tools-details.md#release-gating)): `tools/release-plan.mjs` (Linux preflight), `release-native.mjs`, `merge-queue-busy.mjs` (+ `merge-queue-lib.mjs`), `release-publish.mjs` (wraps `npx semantic-release`), `npm-publish-retry.mjs` (retry publish for sliccy + biome-jsh), `release-alert.mjs` (red-release tracking issue).
- **Extension raw-fetch check** (`npm run test:raw-fetch -w @slicc/chrome-extension`): `tools/extension-raw-fetch-check.ts` drives raw fetch end to end in the built extension, then a wasm program through the realm proxy from a leader page (`extension-realm-proxy-case.ts`/`-page.ts`; HTTPS via `SLICC_WASM_CURL_TLS`).
- **Optional-binary guard**: `tools/run-if-installed.mjs <binary> [args…]` — runs iff on `PATH` else exits 0; `lint-staged` Swift/Go globs.

### CDP tooling

- **Bridge stress harness** (`cdp-stress/`): drives the real client stack against headless Chrome via a stand-in `/cdp` proxy mirroring node/swift-server policies. `npx tsx run-all.ts` → `dist/cdp-stress/`; opt-in gate `cdp-stress.gate.test.ts` (`SLICC_TEST_CDP_STRESS=1`). [README](cdp-stress/README.md).
- **Debug CLI**: `tools/slicc-debug.mjs` — `targets`/`logs`/`vfs ls/cat`/`eval`/`shell`; `--url`/`--url-pattern`/`--file`; `--help`.
- **Screencast**: `tools/slicc-screencast.mjs` (+ `-lib.mjs`, `-video.mjs`) — `Page.startScreencast` frames + `manifest.json`; `--video` via ffmpeg. Skill `demo-recording`.

### Fresh Dev Harnesses

Five harnesses (`tools/dev-{standalone,swift,extension,electron-node,electron-swift}-fresh.sh`) on distinct ports; reaping opt-in (`SLICC_FRESH_REAP=1`), port-scoped — never touch prod bridge `:5710` or CDP `:9222`. Run via `npm run dev:{standalone,swift,extension}:fresh` or `dev:electron:{node,swift}:fresh`. Ports, overrides, Darwin helpers: [dev](../../docs/development.md) · [details](../../docs/dev-tools-details.md#fresh-dev-harnesses).

## Usage Notes

Prefer root npm scripts when a helper has one; keep dev-only configs out of runtime packages. When adding tooling, document its location and entry command here.
