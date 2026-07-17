# CLAUDE.md

This file covers the repo's developer-tooling surface.

## Scope

`packages/dev-tools/` is the home for build helpers, QA setup guidance, and developer verification utilities. Some of that tooling still lives at the repo root while the modularization settles; treat the locations below as the active surface.

## Key Tooling Areas

- **playwright-cli gap sync**: `packages/dev-tools/tools/playwright-cli-sync.mjs` — diffs Slicc's playwright-cli against the official `@playwright/cli` schema. Run after upgrading `@playwright/cli` or after adding/removing a handler. Full reference: [`docs/playwright-cli-sync.md`](../../docs/playwright-cli-sync.md).
- **Dev-only VFS skills** (`packages/dev-tools/vfs-dev-skills/`): skills available in dev mode (`npm run dev`) but stripped from production builds. Loaded via a `__DEV__`-gated `import.meta.glob` in `packages/webapp/src/scoops/skills.ts` and remapped to `/workspace/skills/` in the VFS. Currently contains `playwright-cli-e2e` — an automated + manual E2E regression suite for the playwright-cli command. Run it in a Slicc dev instance: `pcli-e2e`.
- **Prompt/build helpers**: `packages/dev-tools/tools/slicc-prompt.mjs`
- **Build configs**: `packages/webapp/vite.config.ts`, `packages/chrome-extension/vite.config.ts`, `biome.json`
- **QA setup**: `packages/node-server/src/qa-setup.ts` plus the root `npm run qa:*` scripts
- **Visual/integration helpers**: `packages/webapp/tests/test-dips.mjs` and related targeted test utilities
- **RUM error triage**: `packages/dev-tools/rum-error-triage/` — run `node packages/dev-tools/rum-error-triage/triage-rum-errors.mjs` to query RUM for new SLICC errors and write triage candidates. Pure logic in `lib.mjs` (vitest `dev-tools` project). Driven nightly by `.github/workflows/rum-error-triage.yml`. See its `README.md`.
- **AI comment detection**: `packages/dev-tools/ai-comment-detection/` — classifies contributions on a PR/issue thread and applies `ai-generated` or `human-in-the-loop` labels. Cost-ordered cascade (account check → markdown density → similarity → Pangram API). `human-in-the-loop` is sticky. Pure logic in `lib.mjs` (vitest `dev-tools` project). Driven by `.github/workflows/ai-comment-detection.yml`. See its `README.md`.
- **Doc size check** (`npm run lint:docs`): `packages/dev-tools/tools/check-doc-sizes.mjs` — enforces size budgets for all machine-read instruction files (root `CLAUDE.md`, agent `CLAUDE.md`, Copilot instruction files, and every `packages/*/CLAUDE.md`). Non-zero exit on violation. Also runs in `.husky/pre-commit`.
- **Doc dead-reference gate** (`npm run lint:docs`): `packages/dev-tools/tools/check-doc-refs.mjs` (+ pure lib `check-doc-refs-lib.mjs`) — fails on backtick-enclosed repo paths in `CLAUDE.md` or `docs/*.md` files that don't exist on disk. Skips globs, templates, illustrative paths, VFS runtime paths, and a built-in allowlist. TypeScript ESM `.js`→`.ts` resolution is handled. Chained after `check-doc-sizes.mjs` in `lint:docs`.
- **Linear-history check**: `packages/dev-tools/tools/check-linear-history.sh` — fails if a PR branch contains merge commits. Run `bash packages/dev-tools/tools/check-linear-history.sh [base-ref] [head-ref]`. Driven by the `linear-history` CI job.
- **Skill lint** (`npm run lint:skills`): `packages/dev-tools/tools/lint-skills.mjs` — runs `tessl skill lint` over all `SKILL.md` skills via `@tessl/cli`. Warns and skips locally; fails under `--strict` / CI.
- **Patch reconcile** (`npm run lint:patches`): `packages/dev-tools/patch-reconcile/` — guards version-pinned `patch-package` patches (`patches/`). `check-patches.mjs` fails on undocumented, out-of-sync, or orphaned patches. `reconcile-context.mjs` emits metadata for the Renovate patch-reconcile workflow. Pure logic in `lib.mjs` (vitest `dev-tools` project). See `patches/README.md`.
- **innerHTML guard** (`npm run lint:no-innerhtml`): `packages/dev-tools/tools/check-no-innerhtml.mjs` — fails on `.innerHTML =` / `.outerHTML =` / `insertAdjacentHTML()` in shipped `@slicc/webcomponents` source. Stories and tests are exempt. Chained into `npm run lint` and `lint:ci`.
- **Providers boundary guard** (`npm run lint:no-ui-in-providers`): `packages/dev-tools/tools/check-no-ui-imports-in-providers.mjs` — fails on `from '…ui/…'` imports in `providers/built-in/`. Comments and tests are exempt. Chained into `npm run lint` and `lint:ci`.
- **Hosted-origin literal guard**: `packages/dev-tools/tools/check-hosted-origin-literal.mjs` — ensures all TS source files import `SLICC_HOSTED_ORIGIN` from `@slicc/shared-ts` instead of inlining the literal. Comment-only refs and tests are exempt.
- **Chrome runtime.id guard**: `packages/dev-tools/tools/check-no-raw-chrome-runtime-id.mjs` — ensures all extension-environment detection goes through `core/runtime-env.ts` helpers. Tests are exempt.
- **AGENTS.md symlink guard**: `packages/dev-tools/tools/check-agents-symlinks.mjs` — ensures every `packages/*/CLAUDE.md` has a sibling `AGENTS.md` symlink pointing to it.
- **Storybook PR screenshots**: `packages/dev-tools/tools/storybook-affected-screenshots.mjs` (+ pure lib `storybook-affected-stories-lib.mjs`) — captures light/dark screenshots of webcomponents stories affected by a PR diff. Writes a `manifest.json` for the CI workflow. Local run: `npm run build-storybook -w @slicc/webcomponents && node packages/dev-tools/tools/storybook-affected-screenshots.mjs --changed-files=<path> --storybook-static=… --out=<dir>`. Driven by `.github/workflows/storybook-screenshots.yml`. See `packages/webcomponents/CLAUDE.md` for the end-to-end flow.
- **Dead code detection — production-mode files** (`npm run deadcode:production-files`): `knip --production --include files`. Surfaces test-only dead files the default knip gate misses. **Production-suffix discipline**: every workspace `entry`/`project` glob in the production graph MUST be `!`-suffixed; `knip --production` keeps only suffixed patterns. Test-only fixtures are excluded via negated `project` patterns in `knip.json` (not `ignoreFiles`). See [`docs/verification.md`](../../docs/verification.md) § "Knip fixture exclusion" for why `ignoreFiles` is wrong and the correct approach.
- **Function-size + cognitive-complexity debt gate**: `packages/dev-tools/tools/check-touched-exemptions.mjs` (+ pure lib `size-exemption-lib.mjs`) — boy-scout gate enforcing both complexity debt blocks in `biome.json`. Exits non-zero if any PR-changed file is on either debt list, and blocks growing either list. Auto-skips on non-PR events. Run: `node packages/dev-tools/tools/check-touched-exemptions.mjs [base-ref]`. See [`docs/verification.md`](../../docs/verification.md) for details.
- **Coverage gate + ratchet**: `packages/dev-tools/tools/coverage-gate.mjs` reads per-package floors from `coverage-thresholds.json` and runs vitest with those thresholds. `coverage-ratchet.mjs` raises floors nightly toward measured coverage. See `coverage-thresholds.json` and [`docs/verification.md`](../../docs/verification.md).
- **Cross-impl mask vectors**: `packages/dev-tools/tools/gen-mask-vectors.mjs` — regenerate pinned mask vectors for TS/Swift parity tests after intentional masking changes.
- **Preflight deps check**: `packages/dev-tools/tools/preflight-deps.mjs` — fast `npm ci` staleness check wired via `pretypecheck` and `pretest` scripts.
- **Release gating**: `packages/dev-tools/tools/release-native.mjs` — gates native macOS/iOS packaging and Chrome Web Store/worker publish steps on whether relevant source changed since the last tag.

### SLICC CDP Debug Toolkit

`packages/dev-tools/tools/slicc-debug.mjs` — CDP diagnostic CLI for the standalone dev harness. Subcommands: `targets`, `logs`, `vfs ls/cat`, `eval`, `shell`, `chat`. Page-target selection via `--url`/`--url-pattern`. Payload input via `--file`. Run: `node packages/dev-tools/tools/slicc-debug.mjs --help`. See the script's header comment for the full option reference.

### SLICC CDP Screencast Recorder

`packages/dev-tools/tools/slicc-screencast.mjs` (+ `slicc-screencast-lib.mjs`, `slicc-screencast-video.mjs`) — records `Page.startScreencast` frames of the running SLICC leader tab. Writes timestamped frames + `manifest.json`; optional `--video` assembly via ffmpeg. Agent-facing usage: the `demo-recording` skill. Run: `node packages/dev-tools/tools/slicc-screencast.mjs --help`. See the script's header comment for the full option reference.

### Fresh Dev Harnesses

Five harness scripts bring up isolated dev environments on distinct ports so they can run concurrently. Each harness reaps stale processes **strictly port-scoped** (never blanket-kills by name) and uses a labeled Chrome bundle clone (`clone-labeled-chrome.sh`) for distinct ⌘-Tab entries.

| Harness        | Script                        | Bridge  | CDP     | Chrome Label  | Notes                                                                          |
| -------------- | ----------------------------- | ------- | ------- | ------------- | ------------------------------------------------------------------------------ |
| Standalone     | `dev-standalone-fresh.sh`     | `:5710` | `:9222` | `SLICC-Node`  | Primary node-server harness; self-builds leader UI                             |
| Swift          | `dev-swift-fresh.sh`          | `:5720` | `:9224` | `SLICC-Swift` | Native `swift-server` bridge; auto-signs with stable dev cert                  |
| Extension      | `dev-extension-fresh.sh`      | (SW)    | `:9333` | `SLICC-Ext`   | MV3 extension IS the bridge; self-builds leader UI; uses LaunchServices launch |
| Electron-Node  | `dev-electron-node-fresh.sh`  | `:5730` | `:9225` | —             | Attaches to external Electron app (default: Slack)                             |
| Electron-Swift | `dev-electron-swift-fresh.sh` | `:5740` | `:9226` | —             | Swift backend attaching to external Electron app                               |

Run via `npm run dev:standalone:fresh`, `npm run dev:swift:fresh`, `npm run dev:extension:fresh`, `npm run dev:electron:node:fresh`, `npm run dev:electron:swift:fresh`. Override bridge port with `PORT=…`, target app with positional arg or `ELECTRON_APP=…`. All pair with `slicc-debug.mjs` for verification. For detailed lifecycle, port resolution, reaping, LaunchServices, and wrangler reuse behavior, see [`docs/development.md`](../../docs/development.md) § "Fresh Dev Harness Details".

### Supporting Utilities

- **Labeled Chrome bundle clone**: `clone-labeled-chrome.sh` — APFS COW-clones a Chrome for Testing `.app` under a distinct `CFBundleName`/`CFBundleIdentifier` so concurrent harnesses get separate ⌘-Tab entries. Re-signs ad-hoc (top-level only). No-op on non-darwin.
- **Stable dev code-signing identity**: `setup-dev-cert.sh` — one-time setup creating a persistent self-signed `SLICC Dev Code Signing` identity so swift-server's Keychain DR stops changing on every build. Run once: `bash packages/dev-tools/tools/setup-dev-cert.sh`. `dev-swift-fresh.sh` signs with it automatically when present.

## e2b Template

The hosted-leader cloud float runs inside an e2b sandbox. The template definition lives in `packages/dev-tools/e2b-template/` — see `packages/cloud-core/CLAUDE.md` for the substrate lifecycle.

## What Lives Here Conceptually

- Scripts that support local development rather than runtime behavior
- Config files that shape builds or verification flows
- QA setup flows for isolated profiles and tray testing
- One-off utilities used by release, validation, or inspection workflows

## Usage Notes

- Prefer root npm scripts when a helper already has one.
- Keep dev-only configs and utilities out of runtime packages unless they are required at runtime.
- When adding new tooling, document both the file location and the intended entry command.
