# Development Guide

Build, run, test, and debug SLICC locally.

## Build and Development Commands

| Command | What It Does | When to Use |
|---------|-------------|-----------|
| `npm run dev:full` | Full dev mode: Vite HMR + Chrome + CDP proxy (port 3000) | Interactive development; live reload; test browser features |
| `npm run dev:electron -- /Applications/Slack.app` | Launch the main CLI in Electron attach mode against an Electron app | Electron overlay/runtime work |
| `npm run dev` | Vite dev server only (no Chrome/CDP) | Quick UI iteration without launching browser |
| `npm run build` | Production build: Vite UI + TSC CLI/Electron Node target | Pre-deployment validation; final bundle check |
| `npm run build:ui` | Vite build only into `dist/ui/` | Build UI assets separately |
| `npm run build:cli` | TSC build only into `dist/cli/` | Build CLI server + Electron attach helpers separately |
| `npm run build:extension` | Chrome extension bundle into `dist/extension/` | Build extension; load in `chrome://extensions` |
| `npm run start` | Run production CLI (requires build first) | Run built production bundle |
| `npm run start:electron -- /Applications/Slack.app` | Run the built Electron attach mode | Smoke-test production Electron output |
| `npm run typecheck` | Typecheck browser + Node targets | Verify no type errors before committing |
| `npm run test` | Vitest run (all tests) | Run full test suite; CI validation |
| `npm run test:watch` | Vitest watch mode | Iterate on test changes; TDD workflow |
| `npx vitest run src/fs/virtual-fs.test.ts` | Run single test file | Debug a specific module |
| `npx wrangler dev` | Run the Cloudflare Worker tray hub locally (if Wrangler is installed/authenticated) | Exercise `src/worker/` against a real Worker runtime |
| `npx wrangler deploy --env staging` | Deploy the staging Cloudflare Worker tray hub using `wrangler.jsonc` | Publish the staging tray hub (`slicc-tray-hub-staging`) used by GitHub Actions |
| `npx wrangler deploy` | Deploy the production Cloudflare Worker tray hub using `wrangler.jsonc` | Publish the production tray hub |
| `WORKER_BASE_URL=https://... npx vitest run src/worker/deployed.test.ts` | Run the deployed tray-hub smoke test | Verify the live Worker contract (`POST /tray`, controller attach, leader WebSocket, webhook responses) |

## Ports (CLI Mode Only)

| Port | Service | Mode |
|------|---------|------|
| 3000 | UI server | CLI + Electron embedded app |
| 9222 | Chrome CDP | CLI only |
| 9223 | Electron CDP | Electron float only |
| 24679 | Vite HMR WebSocket | CLI/Electron dev mode |

## Environment Variables

- `PORT` — Express server port (default: 3000)
- `CHROME_PATH` — Path to Chrome executable (auto-detected if omitted)

## Development Cycle

1. **Edit** — Change source code in `src/`
2. **Typecheck** — Run `npm run typecheck` (browser + Node targets)
3. **Test** — Run `npm run test` (or `npm run test:watch` for rapid iteration)
4. **Build** — Run all four build gates: `npm run typecheck`, `npm run test`, `npm run build`, `npm run build:extension`
5. **Verify manually** — Test in the relevant runtimes; include Electron mode when touching float/runtime code (see checklist below)

## Verification Checklist (Before Committing)

All four build gates MUST pass:

- [ ] `npm run typecheck` — Browser + Node targets
- [ ] `npm run test` — Vitest (all tests)
- [ ] `npm run build` — Production build (UI via Vite + CLI/Electron Node target via TSC)
- [ ] `npm run build:extension` — Extension build (Vite with extension config)

Manual verification in the relevant runtimes:

- [ ] Feature works in CLI mode (`npm run dev:full`)
  - Launch Chrome automatically
  - Navigate to http://localhost:3000
  - Interact with UI; check functionality
- [ ] Feature works in extension mode (load `dist/extension/` unpacked in `chrome://extensions`)
  - Load `dist/extension/` as unpacked extension
  - Open side panel
  - Interact with UI; check functionality
- [ ] Electron-specific changes work in Electron mode (`npm run dev:electron -- /Applications/Slack.app`)
  - The CLI launches or relaunches the target Electron app with remote debugging enabled
  - If the app is already running, the CLI exits clearly unless `--kill` is also supplied
  - The overlay launcher appears in the target app and survives page navigation via reinjection
- [ ] No console errors in DevTools (F12 in CLI mode)
- [ ] No TypeScript errors in browser console (watch CLI stdout)

## Cloudflare Worker Deploy Pipeline

The tray hub now assumes **`POST /tray` is the only canonical tray-creation endpoint**. `POST /session` and `POST /trays` are intentionally rejected with `410` so callers move to the single public route.

### GitHub repo settings to create

This pipeline no longer relies on separate GitHub `staging` / `production` environments.

Add these at the **repository** level instead:

- **Secret:** `CLOUDFLARE_API_TOKEN`
  - should have permission to deploy Workers and manage Durable Objects for the target account
- **Variable:** `CLOUDFLARE_ACCOUNT_ID`
  - the Cloudflare account ID used by Wrangler in CI

Nothing else is required for CI configuration:

- production deploys use the default Worker name from `wrangler.jsonc`: `slicc-tray-hub`
- staging deploys use the hardcoded staging Worker name in `wrangler.jsonc`: `slicc-tray-hub-staging`
- the post-deploy smoke test reads the deployed URL from `cloudflare/wrangler-action` output, so GitHub does **not** need a `WORKER_BASE_URL` variable

### Workflow behavior

- `.github/workflows/worker.yml`
  - runs staging deploy + smoke test on pull requests to `main` that touch the Worker/Wrangler config
  - skips forked PRs because GitHub does not expose deployment secrets there
  - runs production deploy + smoke test on pushes to `main` that touch the Worker/Wrangler config
  - supports manual dispatch with `target=staging|production`
  - uses `cloudflare/wrangler-action@v3` and passes its `deployment-url` output into `src/worker/deployed.test.ts`

### Local validation commands

Use these before relying on CI:

- `npx wrangler deploy --dry-run --env staging`
- `npx wrangler deploy --dry-run`
- `WORKER_BASE_URL=<deployed-worker-url> npx vitest run src/worker/deployed.test.ts`

## Extension Testing Steps

1. **Build extension bundle**
   ```bash
   npm run build:extension
   ```

2. **Load in Chrome**
   - Open `chrome://extensions`
   - Enable "Developer mode" (top right)
   - Click "Load unpacked"
   - Select the repo's `dist/extension/` directory

3. **Open side panel**
   - Click extension icon in Chrome toolbar
   - Side panel appears on the right
   - Chat/Terminal/Files/Memory tabs visible

4. **Test feature**
   - Interact with side panel
   - Check terminal output
   - Verify file browser works
   - Take screenshots if needed

5. **Iterate**
   - Make code changes in `src/`
   - Run `npm run build:extension` again
   - Refresh extension in `chrome://extensions` (circular arrow icon)
   - Side panel auto-reloads

## Debugging Browser Features

### Setup

Start dev server with Chrome and CDP:
```bash
npm run dev:full
```

This launches:
- Express server on port 3000
- Chrome with remote debugging on port 9222
- Vite HMR WebSocket on port 24679

### Electron float debugging

Start Electron attach mode against an Electron app:
```bash
npm run dev:electron -- /Applications/Slack.app

# If the app is already running:
# npm run dev:electron -- --kill /Applications/Slack.app
```

This launches:
- The main CLI entrypoint in `--electron` mode
- The target Electron app with remote debugging on port 9223
- The same local UI server on port 3000 plus persistent overlay injection from `electron-overlay-entry.js`

### Viewing console output

Browser console output is forwarded to CLI stdout via CDP console forwarder. Check the terminal:
```
[browser] log: some message from page
[browser] error: exception thrown
```

### Adding temporary debug logging

Insert `console.log()` in browser code:

```typescript
// src/ui/chat-panel.ts
console.log('User message:', text);
```

Output appears in CLI terminal:
```
[browser] log: User message: hello
```

Remove before committing.

### Checking HTTP requests

The Express server logs all requests to CLI stdout with method, URL, status, and duration:
```
GET  /cdp  200  12ms
POST /api/fetch-proxy  200  45ms
```

## Logging

Import logger from core:
```typescript
import { createLogger } from '../core/logger.js';
const log = createLogger('my-module');
log.info('starting operation');
log.debug('detailed info');
log.error('error message');
```

### Log levels

- **Development**: `__DEV__` is true → default level INFO
- **Production**: `__DEV__` is false → default level ERROR
- **Override**: Use `setLogLevel(LogLevel.DEBUG)` for verbose output

## Test Running Reference

| Command | Purpose |
|---------|---------|
| `npm run test` | Run all tests once |
| `npm run test:watch` | Watch mode; re-run on file change |
| `npx vitest run src/fs/virtual-fs.test.ts` | Run single file |
| `npx vitest run src/fs/` | Run all tests in directory |
| `npx vitest run --reporter=verbose` | Verbose test output |

## Multi-Mode Compatibility Checklist

New features MUST work in the relevant runtimes:

- **CLI mode** (`npm run dev:full`)
  - Runs in browser launched by Node/Express
  - Can use direct fetch without CORS
  - Can use `AsyncFunction` constructor
  - Can load WASM from `/` (web server root)

- **Extension mode** (`npm run build:extension`)
  - Runs in Chrome side panel
  - CSP blocks dynamic eval and CDN fetches
  - Must use sandbox iframe for dynamic code (`sandbox.html`)
  - Must use `chrome.runtime.getURL()` for bundled assets
  - Must detect runtime via `typeof chrome !== 'undefined' && !!chrome?.runtime?.id`

- **Electron float** (`npm run dev:electron -- /Applications/Slack.app`)
  - Reuses the main CLI entrypoint instead of a separate Electron-only launcher
  - Injects `electron-overlay-entry.js` into Electron page targets over CDP
  - Uses Electron CDP (`9223` by default) instead of launching Chrome
  - Requires `--kill` to stop and relaunch an already running target app with remote debugging enabled

### Dual-mode pattern

```typescript
const isExtension = typeof chrome !== 'undefined' && !!chrome?.runtime?.id;

if (isExtension) {
  // Extension-specific: use chrome.runtime.getURL(), sandbox iframe, etc.
} else {
  // CLI mode: direct fetch, AsyncFunction, etc.
}
```

## Working with Tests

New pure-logic code MUST have colocated tests. Test file location: `foo.test.ts` next to `foo.ts`.

Test setup uses `fake-indexeddb/auto` for VirtualFS:
```typescript
import 'fake-indexeddb/auto';
import { VirtualFS } from './virtual-fs.js';

let dbCounter = 0;
const vfs = await VirtualFS.create({
  dbName: `test-module-${dbCounter++}`,
  wipe: true,
});
```

Acceptable to skip tests:
- DOM-dependent code (UI panels, xterm.js)
- `chrome.debugger` API code (DebuggerClient)
- These should be manually verified in both modes

## File Structure Reference

```
src/
  fs/              Virtual filesystem + RestrictedFS
  shell/           WASM Bash + xterm.js terminal
  cdp/             Chrome DevTools Protocol client
  tools/           Agent tools (bash, file, browser, js)
  core/            Agent loop, logging, types
  git/             Git commands via isomorphic-git
  scoops/          Cone/scoop orchestrator
  ui/              Chat, terminal, file browser UI
  cli/             Express server + Chrome launcher
  extension/       Chrome Manifest V3 extension files
  worker/          Cloudflare Worker + Durable Object tray hub
  shims/           Node module shims for browser bundle
  defaults/        Bundled default skills and workspace
  skills/          Skill installation engine

docs/
  development.md   This file
  testing.md       Test patterns and conventions
  architecture.md  Detailed architecture breakdown

dist/
  ui/              Production browser bundle (Vite output)
  cli/             Production CLI server + Electron entrypoint (TSC output)
  extension/       Production extension bundle
```
