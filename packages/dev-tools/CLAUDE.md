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
- **Doc size check** (`npm run lint:docs`): `packages/dev-tools/tools/check-doc-sizes.mjs` — enforces root `CLAUDE.md` ≤ 30000 chars and `packages/vfs-root/shared/CLAUDE.md` ≤ 3000 bytes; non-zero exit on violation.
- **Skill lint** (`npm run lint:skills`): `packages/dev-tools/tools/lint-skills.mjs` — runs tessl skill import + lint over all 12 `SKILL.md` skills via the `@tessl/cli` npm path (ephemeral `tile.json`, never committed). Warns and skips (exit 0) when tessl is unresolvable; pass `--strict` (CI) to fail instead.

## What Lives Here Conceptually

- scripts that support local development rather than runtime behavior
- config files that shape builds or verification flows
- QA setup flows for isolated profiles and tray testing
- one-off utilities used by release, validation, or inspection workflows

## Usage Notes

- Prefer root npm scripts when a helper already has one.
- Keep dev-only configs and utilities out of runtime packages unless they are required at runtime.
- When adding new tooling, document both the file location and the intended entry command.
