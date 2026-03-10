# Development Guide

Build, run, test, and debug SLICC locally.

## Build and Development Commands

| Command | What It Does | When to Use |
|---------|-------------|-----------|
| `npm run dev:full` | Full dev mode: Vite HMR + Chrome + CDP proxy (port 3000) | Interactive development; live reload; test browser features |
| `npm run dev` | Vite dev server only (no Chrome/CDP) | Quick UI iteration without launching browser |
| `npm run build` | Production build: Vite UI + TSC CLI | Pre-deployment validation; final bundle check |
| `npm run build:ui` | Vite build only into `dist/ui/` | Build UI assets separately |
| `npm run build:cli` | TSC build only into `dist/cli/` | Build CLI server separately |
| `npm run build:extension` | Chrome extension bundle into `dist/extension/` | Build extension; load in `chrome://extensions` |
| `npm run start` | Run production CLI (requires build first) | Run built production bundle |
| `npm run typecheck` | Typecheck both tsconfig targets | Verify no type errors before committing |
| `npm run test` | Vitest run (all 856 tests) | Run full test suite; CI validation |
| `npm run test:watch` | Vitest watch mode | Iterate on test changes; TDD workflow |
| `npx vitest run src/fs/virtual-fs.test.ts` | Run single test file | Debug a specific module |

## Ports (CLI Mode Only)

| Port | Service | Mode |
|------|---------|------|
| 3000 | UI server | CLI only |
| 9222 | Chrome CDP | CLI only |
| 24679 | Vite HMR WebSocket | CLI only (dev mode) |

## Environment Variables

- `PORT` — Express server port (default: 3000)
- `CHROME_PATH` — Path to Chrome executable (auto-detected if omitted)

## Development Cycle

1. **Edit** — Change source code in `src/`
2. **Typecheck** — Run `npm run typecheck` (both tsconfigs: browser + Node)
3. **Test** — Run `npm run test` (or `npm run test:watch` for rapid iteration)
4. **Build** — Run all four build gates: `npm run typecheck`, `npm run test`, `npm run build`, `npm run build:extension`
5. **Verify manually** — Test in both CLI mode and extension mode (see checklist below)

## Verification Checklist (Before Committing)

All four build gates MUST pass:

- [ ] `npm run typecheck` — Both tsconfig targets (browser + CLI)
- [ ] `npm run test` — Vitest (all tests)
- [ ] `npm run build` — Production build (UI via Vite + CLI via TSC)
- [ ] `npm run build:extension` — Extension build (Vite with extension config)

Manual verification in both modes:

- [ ] Feature works in CLI mode (`npm run dev:full`)
  - Launch Chrome automatically
  - Navigate to http://localhost:3000
  - Interact with UI; check functionality
- [ ] Feature works in extension mode (load `dist/extension/` unpacked in `chrome://extensions`)
  - Load `dist/extension/` as unpacked extension
  - Open side panel
  - Interact with UI; check functionality
- [ ] No console errors in DevTools (F12 in CLI mode)
- [ ] No TypeScript errors in browser console (watch CLI stdout)

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

New features MUST work in both modes:

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
  shims/           Node module shims for browser bundle
  defaults/        Bundled default skills and workspace
  skills/          Skill installation engine

docs/
  development.md   This file
  testing.md       Test patterns and conventions
  architecture.md  Detailed architecture breakdown

dist/
  ui/              Production browser bundle (Vite output)
  cli/             Production CLI server (TSC output)
  extension/       Production extension bundle
```
