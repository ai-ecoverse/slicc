# Environment

Environment variables, external dependencies, and setup notes.

**What belongs here:** Required env vars, external API keys/services, dependency quirks, platform-specific notes.
**What does NOT belong here:** Service ports/commands (use `.factory/services.yaml`).

---

## Node Version

- **Requires Node >= 22** (LTS). Enforced via `engines` in root `package.json`.
- Verify via `node --version` before running tests.

## Manual Testing

Manual smoke tests of the `agent` command (e.g. `agent . "*" "say hi"`) require a working LLM provider.
Workers set up provider credentials through the running dev app itself (stored in browser IndexedDB via the provider settings UI). There are no repo-level env vars to set.

When a worker needs to manually drive the app:

1. Start the dev server: service `dev` (`PORT=5710 npx tsx packages/node-server/src/index.ts --dev`).
2. Connect through the stable CDP proxy at `ws://localhost:5710/cdp`, or discover the actual Chrome CDP port from the dev-server log before attaching. Port 9222 is only the nominal default and may auto-allocate if it is already occupied.
3. Use the `agent-browser` skill to navigate/interact (go to `http://localhost:5710`).
4. Configure an LLM provider in the UI (the app persists credentials locally).
5. Drive the agent via the UI's chat box, then drop to terminal to exercise `agent`.

Credentials never leave the local machine; no repo-level secrets are required.

## Dependency Quirks

- `fake-indexeddb/auto` must be imported at the top of any Vitest file that instantiates `VirtualFS`.
- `just-bash@2.14.2` is the shell layer; supplemental commands follow its `Command` interface.
- pi-agent-core / pi-ai are the agent loop and streaming LLM layer — they drive the scoop's `Agent` instance.

## Dev Server Gotchas

- **Vite HMR does NOT reliably pick up edits to bootstrap files** (`packages/webapp/src/ui/main.ts`, `packages/chrome-extension/src/offscreen.ts`). Even a browser reload may serve a stale module. After editing these files, **restart the dev server** (`lsof -ti :5710 | xargs kill`, then start again) before manually verifying in the browser. Component-level HMR works normally.
- Raw shell probes against `http://localhost:5710/` can false-negative in dev mode: the SPA HTML fallback only serves when the request `Accept` header includes `text/html`. For shell liveness checks, use `curl -sf -H 'Accept: text/html' http://localhost:5710` or `curl -sf http://localhost:5710/api/runtime-config`.
- When auto-discovering the Chrome CDP port from the dev-server log, also verify the `[agent-bridge] agent bridge published on globalThis.__slicc_agent` line appears during bootstrap — this is the easiest smoke signal that the bridge hook was published before the UI finished loading.

## Build Targets

- Browser bundle (tsconfig.json): everything except `packages/node-server/src/`.
- CLI/Electron (tsconfig.cli.json): only `packages/node-server/src/`.
- Extension (packages/chrome-extension/vite.config.ts).

All three must typecheck and build cleanly after every feature.

## Typecheck Coverage

- `npm run typecheck` runs `tsc --noEmit -p tsconfig.cli.json && tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.worker.json`.
- Those `tsconfig` entry points do **not** include `packages/webapp/tests/**/*.test.ts` or other Vitest-only files, so compile-time assertions that live only in test files are **not** validated by the TypeScript gate.
- If a feature needs CI-backed type-surface coverage, put the assertion in a `tsc`-included source file/shim or add a dedicated typecheck target for that surface instead of relying on a `.test.ts` file alone.

## Lint / Style — Important

This repo's **CI gate for style is `npx prettier --check .`**, not `eslint`.
See the root `CLAUDE.md` "Verification" section: the CI steps are prettier-check, typecheck, test, build, build-extension.

`npx eslint .` has a large pre-existing baseline on `main` (66 errors / 1100+ warnings, mostly `no-undef` for `process`/`console` in Node scripts and `no-explicit-any` warnings). Fixing it is out of scope for this mission.

Workers and validators must treat `prettier --check` as the lint gate. `.factory/services.yaml`'s `lint` command is explicitly wired to `prettier --check` for this reason.

- Prettier does **not** honor the nested package `.gitignore` files in `packages/swift-launcher/` and `packages/swift-server/`. If local ignored Swift build artifacts exist under `packages/swift-launcher/.build/` or `packages/swift-server/.build/`, `npx prettier --check .` can fail on those generated files. Clean those ignored `.build/` directories before re-running the lint gate.
