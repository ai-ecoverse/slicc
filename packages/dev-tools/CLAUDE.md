# CLAUDE.md

This file covers the repo's developer-tooling surface.

## Scope

`packages/dev-tools/` is the home for build helpers, QA setup guidance, and developer verification utilities. Some of that tooling still lives at the repo root while the modularization settles; treat the locations below as the active surface.

## Key Tooling Areas

- **Prompt/build helpers**: `packages/dev-tools/tools/slicc-prompt.mjs`
- **Build configs**: `packages/webapp/vite.config.ts`, `packages/chrome-extension/vite.config.ts`, `biome.json`
- **QA setup**: `packages/node-server/src/qa-setup.ts` plus the root `npm run qa:*` scripts
- **Visual/integration helpers**: `tests/test-dips.mjs` and related targeted test utilities
- **RUM error triage** (error-to-insight pipeline): `packages/dev-tools/rum-error-triage/` — run `node packages/dev-tools/rum-error-triage/triage-rum-errors.mjs` to query RUM for new SLICC errors and write triage candidates; pure logic in `lib.mjs` (tested via the `dev-tools` vitest project). Driven nightly by `.github/workflows/rum-error-triage.yml`. See its `README.md`.
- **Doc size check** (`npm run lint:docs`): `packages/dev-tools/tools/check-doc-sizes.mjs` — enforces size budgets for the repo's machine-read instruction files: root `CLAUDE.md` ≤ 30000 chars, `packages/vfs-root/shared/CLAUDE.md` ≤ 3000 bytes, and every GitHub Copilot instruction file (`.github/copilot-instructions.md` plus each `.github/instructions/*.instructions.md`, discovered dynamically) ≤ 4000 chars (Copilot's truncation limit). Non-zero exit on violation. Also runs in the `.husky/pre-commit` hook (once, when a budgeted file is staged, after `lint-staged`).
- **Linear-history check**: `packages/dev-tools/tools/check-linear-history.sh` — fails if a PR branch contains merge commits in `base..head` (i.e. `main` was merged in instead of rebased). Run `bash packages/dev-tools/tools/check-linear-history.sh [base-ref] [head-ref]` (defaults base to `origin/${GITHUB_BASE_REF:-main}`, falling back to `${GITHUB_BASE_REF:-main}` when that remote-tracking ref isn't present locally; head to `HEAD`). Driven by the `linear-history` job in `.github/workflows/ci.yml`, which catches merge-queue linear-history rejections at PR time instead of after a green run.
- **Skill lint** (`npm run lint:skills`): `packages/dev-tools/tools/lint-skills.mjs` — runs tessl skill import + lint over all 12 `SKILL.md` skills via the `@tessl/cli` npm path (ephemeral plugin metadata in a temp copy, never committed). Warns and skips (exit 0) when tessl is unresolvable; pass `--strict` (CI) to fail instead.
- **Function-size debt boy-scout gate**: `packages/dev-tools/tools/check-touched-size-exemptions.mjs` (+ pure lib `size-exemption-lib.mjs`, vitest project `dev-tools`). Reads the debt list from `biome.json` (the `overrides` block whose ONLY rule is `complexity.noExcessiveLinesPerFunction: "off"`) and exits non-zero if any file changed in the PR is still on it. CI step `Function-size debt list boy-scout gate` runs it via `node packages/dev-tools/tools/check-touched-size-exemptions.mjs` (`fetch-depth: 0` on the lint checkout so merge-base resolves against `$GITHUB_BASE_REF`); auto-skips on `merge_group` / `push` events. Local run: `node packages/dev-tools/tools/check-touched-size-exemptions.mjs [base-ref]` (defaults to `origin/main`), or override the input with `CHANGED_FILES=path1,path2 …`.

## What Lives Here Conceptually

- scripts that support local development rather than runtime behavior
- config files that shape builds or verification flows
- QA setup flows for isolated profiles and tray testing
- one-off utilities used by release, validation, or inspection workflows

## Usage Notes

- Prefer root npm scripts when a helper already has one.
- Keep dev-only configs and utilities out of runtime packages unless they are required at runtime.
- When adding new tooling, document both the file location and the intended entry command.
