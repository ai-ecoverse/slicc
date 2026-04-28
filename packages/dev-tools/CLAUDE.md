# CLAUDE.md

This file covers the repo's developer-tooling surface.

## Scope

`packages/dev-tools/` is the home for build helpers, QA setup guidance, and developer verification utilities. Some of that tooling still lives at the repo root while the modularization settles; treat the locations below as the active surface.

## Key Tooling Areas

- **Prompt/build helpers**: `packages/dev-tools/tools/slicc-prompt.mjs`
- **Build configs**: `packages/webapp/vite.config.ts`, `packages/chrome-extension/vite.config.ts`, `eslint.config.js`
- **QA setup**: `packages/node-server/src/qa-setup.ts` plus the root `npm run qa:*` scripts
- **Visual/integration helpers**: `tests/test-dips.mjs` and related targeted test utilities

## What Lives Here Conceptually

- scripts that support local development rather than runtime behavior
- config files that shape builds or verification flows
- QA setup flows for isolated profiles and tray testing
- one-off utilities used by release, validation, or inspection workflows

## Usage Notes

- Prefer root npm scripts when a helper already has one.
- Keep dev-only configs and utilities out of runtime packages unless they are required at runtime.
- When adding new tooling, document both the file location and the intended entry command.
